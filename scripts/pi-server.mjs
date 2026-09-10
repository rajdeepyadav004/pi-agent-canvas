#!/usr/bin/env node
/**
 * pi-canvas-server — plain-Node bridge between the canvas webview(s) and pi.
 *
 * Owns pi AgentSessions (official SDK) and speaks JSON over a localhost
 * WebSocket. Lives OUTSIDE VS Code on purpose: the extension host patches
 * fetch/http for proxy support and SSE streaming through that patch stalls; a
 * plain node process does not.
 *
 * It is a SESSION HOST: one process serves many conversations at once, one
 * live agent per session id, each with its own prompt queue. Every outbound
 * event is stamped with `sessionId` so a client can route (and a future
 * session switcher can watch) whichever sessions it cares about.
 *
 * Protocol (JSON, both directions; `sessionId` omitted = most recent session):
 *   in:  {"type":"open_session","sessionId"?,"mode"?:"new"|"continue"}
 *        {"type":"list_sessions"}
 *        {"type":"close_session","sessionId"}
 *        {"type":"prompt","sessionId"?,"message"}
 *        {"type":"abort","sessionId"?}
 *   out: open_session → {"type":"session_opened","sessionId","sessionFile","history"}
 *        list_sessions → {"type":"sessions","sessions":[…]}
 *        plus SDK session events verbatim, each with `sessionId`, and
 *        {"type":"settled","sessionId","aborted"} | {"type":"server_error"}
 *
 * A session id is the pi session id, so a canvas tab and `pi --continue` can
 * refer to the same conversation.
 *
 * Run: node scripts/pi-server.mjs
 *   env: PI_CANVAS_PORT, PI_CANVAS_CWD, PI_CANVAS_SESSION_DIR
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PI_CANVAS_PORT ?? 47811);
// The project the agent works in — the VS Code workspace folder, passed by the
// extension. Falls back to the process cwd when started by hand.
const CWD = process.env.PI_CANVAS_CWD ?? process.cwd();
// Sessions live on disk by default (pi's own session directory, so the canvas
// and `pi --continue` share one conversation); PI_CANVAS_SESSION_DIR redirects.
const SESSION_DIR = process.env.PI_CANVAS_SESSION_DIR || undefined;

const modelRuntime = await ModelRuntime.create();

const clients = new Set();
const broadcast = (obj) => {
  const line = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(line);
};
const reply = (ws, obj) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------
/** id -> { id, manager, session, activeRun, chain, unsubscribe } */
const sessions = new Map();
let lastOpened = null;

/** Messages of a session, in LLM context order (compaction-aware). */
const historyOf = (manager) => {
  try {
    return manager.buildSessionContext().messages;
  } catch (err) {
    console.error('[pi-canvas-server] failed to read session history:', err);
    return [];
  }
};

/**
 * Open (or join) a session. One live agent per session id: a second request for
 * the same conversation joins the running one — two agents appending to one
 * session file would be two writers on the same history.
 */
async function openSession({ sessionId, mode } = {}) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);

  let manager;
  if (sessionId) {
    const list = await SessionManager.list(CWD, SESSION_DIR);
    const info = list.find((s) => s.id === sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    manager = SessionManager.open(info.path, SESSION_DIR);
  } else if (mode === 'new') {
    manager = SessionManager.create(CWD, SESSION_DIR);
  } else {
    manager = SessionManager.continueRecent(CWD, SESSION_DIR);
  }

  const id = manager.getSessionId();
  const existing = sessions.get(id);
  if (existing) return existing;

  const { session } = await createAgentSession({ cwd: CWD, sessionManager: manager, modelRuntime });
  const entry = { id, manager, session, activeRun: null, chain: Promise.resolve(), unsubscribe: null };
  // Stamp every event so clients can route between concurrent sessions.
  entry.unsubscribe = session.subscribe((event) => broadcast({ ...event, sessionId: id }));
  sessions.set(id, entry);
  lastOpened = entry;
  console.log(`[pi-canvas-server] session opened ${id} — ${manager.getSessionFile?.() ?? '(in-memory)'}`);
  return entry;
}

/** Prompts are serialized per session, so different sessions run concurrently. */
function promptSession(entry, message) {
  const run = { aborted: false };
  entry.activeRun = run;
  entry.chain = entry.chain
    .then(() => entry.session.prompt(message))
    .then(
      () => {
        if (entry.activeRun === run) entry.activeRun = null;
        broadcast({ type: 'settled', sessionId: entry.id, aborted: run.aborted });
        console.log(`[pi-canvas-server] settled ${entry.id} (aborted: ${run.aborted})`);
      },
      (err) => {
        if (entry.activeRun === run) entry.activeRun = null;
        // An abort is a normal outcome, not an error to surface.
        if (run.aborted || /abort/i.test(String(err))) {
          broadcast({ type: 'settled', sessionId: entry.id, aborted: true });
          console.log(`[pi-canvas-server] settled ${entry.id} (aborted)`);
        } else {
          broadcast({ type: 'server_error', sessionId: entry.id, error: String(err) });
          console.error(`[pi-canvas-server] prompt failed (${entry.id}):`, err);
        }
      },
    );
}

const resolve = (sessionId) => (sessionId ? sessions.get(sessionId) : lastOpened);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const httpServer = createServer((_req, res) => {
  // Liveness endpoint — also proves outbound-independent startup.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, server: 'pi-canvas-server', sessions: [...sessions.keys()] }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[pi-canvas-server] client connected');
  clients.add(ws);
  reply(ws, { type: 'server_ready' });
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data) => void handle(ws, data));
});

async function handle(ws, data) {
  let cmd;
  try {
    cmd = JSON.parse(String(data));
  } catch {
    reply(ws, { type: 'server_error', error: 'bad JSON' });
    return;
  }

  switch (cmd.type) {
    case 'open_session': {
      try {
        const entry = await openSession({ sessionId: cmd.sessionId, mode: cmd.mode });
        reply(ws, {
          type: 'session_opened',
          sessionId: entry.id,
          sessionFile: entry.manager.getSessionFile?.() ?? null,
          history: historyOf(entry.manager),
        });
      } catch (err) {
        reply(ws, { type: 'server_error', error: String(err) });
      }
      return;
    }
    case 'list_sessions': {
      try {
        const list = await SessionManager.list(CWD, SESSION_DIR);
        reply(ws, {
          type: 'sessions',
          sessions: list.map((s) => ({
            id: s.id,
            name: s.name,
            modified: s.modified,
            messageCount: s.messageCount,
            firstMessage: s.firstMessage,
            file: s.path,
            open: sessions.has(s.id),
          })),
        });
      } catch (err) {
        reply(ws, { type: 'server_error', error: String(err) });
      }
      return;
    }
    case 'close_session': {
      const entry = sessions.get(cmd.sessionId);
      if (entry) {
        entry.unsubscribe?.();
        sessions.delete(entry.id);
        if (lastOpened === entry) lastOpened = null;
        console.log('[pi-canvas-server] session closed', entry.id);
      }
      return;
    }
    case 'prompt': {
      const message = String(cmd.message ?? '').trim();
      if (!message) return;
      const entry = resolve(cmd.sessionId);
      if (!entry) {
        reply(ws, { type: 'server_error', error: 'no session open — send open_session first' });
        return;
      }
      promptSession(entry, message);
      return;
    }
    case 'abort': {
      const entry = resolve(cmd.sessionId);
      if (!entry) return;
      if (entry.activeRun) entry.activeRun.aborted = true;
      void entry.session.abort().catch((err) => console.error('[pi-canvas-server] abort failed:', err));
      return;
    }
    default:
      reply(ws, { type: 'server_error', error: `unknown command: ${cmd.type}` });
  }
}

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[pi-canvas-server] listening on ws://127.0.0.1:${PORT} (cwd: ${CWD})`);
  console.log(`[pi-canvas-server] session dir: ${SESSION_DIR ?? '(pi default)'}`);
});
