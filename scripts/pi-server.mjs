#!/usr/bin/env node
/**
 * pi-canvas-server — plain-Node bridge between the canvas webview and pi.
 *
 * Owns an in-process pi AgentSession (official SDK) and speaks JSON over a
 * localhost WebSocket. Lives OUTSIDE VS Code on purpose: the extension host
 * patches fetch/http for proxy support and SSE streaming through that patch
 * stalls; a plain node process (or one run manually in a terminal) does not.
 *
 * Protocol (JSON, both directions):
 *   in:  {"type":"prompt","message":"..."} | {"type":"abort"}
 *   out: SDK session events verbatim (agent_start, message_update, …) plus
 *        {"type":"server_ready"}, {"type":"history","messages":[…]},
 *        {"type":"settled","aborted":bool} and {"type":"server_error"}
 *
 * Sessions are persisted: the agent continues the most recent on-disk session
 * for the workspace, exactly like `pi --continue` does, so a canvas reload (or
 * a terminal `pi`) picks up the same conversation.
 *
 * Run: node scripts/pi-server.mjs
 *   env: PI_CANVAS_PORT, PI_CANVAS_CWD, PI_CANVAS_SESSION_DIR,
 *        PI_CANVAS_NEW_SESSION=1 (start fresh instead of continuing)
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PI_CANVAS_PORT ?? 47811);
// The project the agent works in — the VS Code workspace folder, passed by the
// extension. Falls back to the process cwd when started by hand.
const CWD = process.env.PI_CANVAS_CWD ?? process.cwd();

// Sessions live on disk by default (pi's own session directory, so the canvas
// and `pi --continue` share one conversation); PI_CANVAS_SESSION_DIR redirects
// them, and PI_CANVAS_NEW_SESSION=1 forces a fresh session.
const SESSION_DIR = process.env.PI_CANVAS_SESSION_DIR || undefined;
const sessionManager =
  process.env.PI_CANVAS_NEW_SESSION === '1'
    ? SessionManager.create(CWD, SESSION_DIR)
    : SessionManager.continueRecent(CWD, SESSION_DIR);

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  cwd: CWD,
  sessionManager,
  modelRuntime,
});

const clients = new Set();
const broadcast = (obj) => {
  const line = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(line);
};

session.subscribe((event) => {
  if (event.type === 'message_update') {
    const d = event.assistantMessageEvent?.type;
    if (d === 'text_delta') globalThis.__deltas = (globalThis.__deltas ?? 0) + 1;
  } else console.log('[pi-canvas-server] event', event.type);
  broadcast(event);
});

/** Messages of the live session, in LLM context order (compaction-aware). */
const buildHistory = () => {
  try {
    return sessionManager.buildSessionContext().messages;
  } catch (err) {
    console.error('[pi-canvas-server] failed to read session history:', err);
    return [];
  }
};

let chain = Promise.resolve();
// Set while a prompt is in flight so an abort can be attributed to it.
let activeRun = null;

const httpServer = createServer((_req, res) => {
  // Liveness endpoint — also proves outbound-independent startup.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, server: 'pi-canvas-server' }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[pi-canvas-server] client connected');
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'server_ready', sessionFile: sessionManager.getSessionFile?.() ?? null }));
  // Replay stored conversation so a reloaded webview renders the same thread.
  ws.send(JSON.stringify({ type: 'history', messages: buildHistory() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data) => {
    let cmd;
    try {
      cmd = JSON.parse(String(data));
    } catch {
      broadcast({ type: 'server_error', error: 'bad JSON' });
      return;
    }
    if (cmd.type === 'prompt') {
      const message = String(cmd.message ?? '').trim();
      if (!message) return;
      const run = { aborted: false };
      activeRun = run;
      // Serialized: one prompt at a time, in submission order.
      chain = chain
        .then(() => session.prompt(message))
        .then(
          () => {
            if (activeRun === run) activeRun = null;
            broadcast({ type: 'settled', aborted: run.aborted });
            console.log('[pi-canvas-server] settled (aborted:', run.aborted, ') deltas:', globalThis.__deltas ?? 0);
          },
          (err) => {
            if (activeRun === run) activeRun = null;
            // An abort is a normal outcome, not an error to surface.
            if (run.aborted || /abort/i.test(String(err))) {
              broadcast({ type: 'settled', aborted: true });
              console.log('[pi-canvas-server] settled (aborted)');
            } else {
              broadcast({ type: 'server_error', error: String(err) });
              console.error('[pi-canvas-server] prompt failed:', err);
            }
          }
        );
    } else if (cmd.type === 'abort') {
      if (activeRun) activeRun.aborted = true;
      void session.abort().catch((err) => console.error('[pi-canvas-server] abort failed:', err));
    }
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[pi-canvas-server] listening on ws://127.0.0.1:${PORT} (cwd: ${CWD})`);
  console.log(`[pi-canvas-server] session: ${sessionManager.getSessionFile?.() ?? '(in-memory)'}`);
});
