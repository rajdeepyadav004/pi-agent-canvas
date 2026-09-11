#!/usr/bin/env node
/**
 * pi-canvas-server — the canvas session host.
 *
 * It owns pi AgentSessions and speaks JSON over a localhost WebSocket to the
 * canvas webview(s). Plain Node on purpose: the VS Code extension host patches
 * fetch/http for proxy support and SSE through that patch stalls; a plain
 * process does not.
 *
 * ARCHITECTURE (aligned with pi's own RPC mode, docs/rpc.md, and with how
 * Zed's ACP and OpenAI's Codex app-server treat editor↔agent communication):
 *
 *  - One long-lived host process, many concurrent sessions. `sessionId` is a
 *    field on every command and every outbound event, so a client can route
 *    between conversations. (pi's RPC mode is one session per process; a
 *    connection that multiplexes sessions is the ACP shape, and it is what a
 *    multi-tile cockpit wants.)
 *  - Commands and events use pi's documented names and payloads, so a future
 *    `pi --mode rpc` / ACP adapter is a rename rather than a rewrite.
 *  - Commands may carry `id`; the reply is a `response` envelope
 *    {type:'response', id, command, success, data|error}. Events are
 *    notifications and never carry an id.
 *  - The host is a JSON-RPC *peer*, not a consumer: pi extensions ask the user
 *    things through the extension UI sub-protocol (extension_ui_request →
 *    extension_ui_response), exactly as in RPC mode.
 *
 * Wire summary (`sessionId` omitted = most recently opened session):
 *   in:  prompt | steer | follow_up | abort | abort_bash | bash
 *        open_session | new_session | switch_session | close_session | list_sessions
 *        get_state | get_session_stats | set_session_name | set_model | cycle_model
 *        set_thinking_level | extension_ui_response
 *   out: response | server_ready | session_opened | sessions | server_error
 *        agent_settled | bash_start | bash_end | extension_ui_request
 *        plus the pi SDK session events verbatim (message_update,
 *        tool_execution_*, bash_execution_update, queue_update, compaction_*,
 *        auto_retry_*, turn_*, agent_*, message_*), each stamped `sessionId`.
 *
 * A session id is the pi session id, so a canvas tab and `pi --continue` refer
 * to the same conversation.
 *
 * HTTP (used by the extension's sidebar, and handy from a shell):
 *   GET /           → liveness + currently open session ids
 *   GET /sessions   → every stored session for this workspace
 *
 * Run: node scripts/pi-server.mjs
 *   env: PI_CANVAS_PORT, PI_CANVAS_CWD, PI_CANVAS_SESSION_DIR, PI_CANVAS_AGENT_DIR
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


// This process is spawned detached and can outlive the extension host that
// piped its output. Writing to the now-closed pipe raises EPIPE, which would
// otherwise kill the agent mid-turn.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {});
}

/**
 * Mirrored from src/shared/protocol.ts, which is the contract; the host is
 * plain JavaScript because it ships as a script with no build step.
 * test/suite/protocol.test.js fails if the two drift apart.
 */
const PROTOCOL_VERSION = 1;

const PORT = Number(process.env.PI_CANVAS_PORT ?? 47811);
// The project the agent works in — the VS Code workspace folder, passed by the
// extension. Falls back to the process cwd when started by hand.
const CWD = process.env.PI_CANVAS_CWD ?? process.cwd();
// Sessions live on disk by default (pi's own session directory, so the canvas
// and `pi --continue` share one conversation); PI_CANVAS_SESSION_DIR redirects.
const SESSION_DIR = process.env.PI_CANVAS_SESSION_DIR || undefined;

const here = dirname(fileURLToPath(import.meta.url));
/** What the .vsix ships: plain files, because vsce refuses node_modules. */
const VENDOR = join(here, '..', 'vendor', 'node_modules');

/**
 * Import the first candidate that exists, else the bare specifier (dev install).
 * Packages are loaded by path rather than by name because the packaged
 * extension has no node_modules for Node to resolve through.
 */
async function importFirst(candidates, bare, label) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      console.log(`[pi-canvas-server] ${label}: ${candidate}`);
      return import(pathToFileURL(candidate).href);
    }
  }
  console.log(`[pi-canvas-server] ${label}: ${bare}`);
  return import(bare);
}

/**
 * The pi SDK comes from its PREBUILT BUNDLE, not the published entry point: the
 * full package is ~157MB of provider SDKs, while `dist/bundle` is the
 * embeddable build pi ships for exactly this (~8MB + @earendil-works/chord).
 * That is what makes a self-contained .vsix possible.
 */
const piBundle = (...base) => join(...base, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'index.js');
const pi = await importFirst(
  [
    process.env.PI_CANVAS_PI_ENTRY,
    piBundle(join(here, '..', 'node_modules')), // dev checkout: always current
    piBundle(VENDOR),                           // packaged .vsix
    piBundle(join(CWD, 'node_modules')),        // the workspace's own pi
    join(here, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
  ],
  '@earendil-works/pi-coding-agent',
  'pi SDK',
);
const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = pi;

// NOTE: ws's ESM entry is wrapper.mjs, NOT index.js. Loading the CommonJS
// index.js by path yields a namespace without named exports, and WebSocketServer
// comes back undefined ("not a constructor").
const wsModule = await importFirst(
  [
    process.env.PI_CANVAS_WS_ENTRY,
    join(here, '..', 'node_modules', 'ws', 'wrapper.mjs'),
    join(VENDOR, 'ws', 'wrapper.mjs'),
  ],
  'ws',
  'websocket',
);
const { WebSocketServer, WebSocket } = wsModule;
if (typeof WebSocketServer !== 'function') {
  throw new Error(`pi-canvas-server: could not load ws (got ${Object.keys(wsModule).join(', ') || 'no exports'})`);
}
/**
 * Canonical bootstrap.
 *
 * pi's own modes (InteractiveMode, runRpcMode, print mode) all build their
 * runtime through `createAgentSessionServices`, and the SDK documents what that
 * buys: a ModelRuntime built from `<agentDir>/auth.json` and
 * `<agentDir>/models.json`, a settings manager bound to cwd+agentDir, a
 * resource loader (AGENTS.md, skills, prompt templates, extensions) and the
 * registration of providers that extensions declare.
 *
 * Skipping it is not a shortcut, it is a silent behaviour change. An earlier
 * version of this server called `ModelRuntime.create()` with no options and
 * passed the result in, which overrode both paths: custom providers (proxies,
 * Ollama, vLLM) did not exist and stored credentials were invisible, so a
 * session fell back to a built-in default model with no key and the agent
 * answered nothing at all — indistinguishable from "the provider is down".
 */
let cachedServices = null;
function services() {
  if (!cachedServices) {
    cachedServices = createAgentSessionServices({
      cwd: CWD,
      // Defaults to pi's own agent directory; PI_CANVAS_AGENT_DIR is for tests
      // and for relocated agent directories.
      ...(process.env.PI_CANVAS_AGENT_DIR ? { agentDir: process.env.PI_CANVAS_AGENT_DIR } : {}),
    }).then((created) => {
      logServices(created);
      return created;
    });
  }
  return cachedServices;
}

/** Say up front what this process can see, before any prompt is sent. */
function logServices(created) {
  try {
    console.log(`[pi-canvas-server] cwd: ${created.cwd} · agent dir: ${created.agentDir}`);
    logModelRuntime(created.modelRuntime);
    // Diagnostics are how pi reports a broken provider config or a failed
    // extension load. Dropping them is how "nothing replies" stays unexplained.
    for (const diagnostic of created.diagnostics ?? []) {
      const line = `[pi-canvas-server] ${diagnostic.type}: ${diagnostic.message}`;
      if (diagnostic.type === 'error') console.error(line);
      else console.log(line);
    }
  } catch (err) {
    console.error('[pi-canvas-server] could not describe the runtime:', String(err));
  }
}

/**
 * Which providers and credentials are visible, and whether the model the
 * session will actually use has auth. This is the line that answers "why
 * doesn't it reply" without waiting for a failed turn.
 */
function logModelRuntime(runtime) {
  try {
    const providers = (runtime.getProviders?.() ?? [])
      .map((p) => p.id ?? p.providerId ?? p.name)
      .filter(Boolean);
    const registered = runtime.getRegisteredProviderIds?.() ?? [];
    console.log(`[pi-canvas-server] providers visible: ${providers.join(', ') || '(none)'}`);
    console.log(`[pi-canvas-server] providers configured here: ${registered.join(', ') || '(none)'}`);
    const runtimeError = runtime.getError?.();
    if (runtimeError) console.error(`[pi-canvas-server] model runtime error: ${runtimeError}`);
  } catch (err) {
    console.error('[pi-canvas-server] could not summarise the model runtime:', String(err));
  }
}

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
async function openSession({ sessionId, mode, sessionPath } = {}) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);

  let manager;
  if (sessionPath) {
    // pi's switch_session addresses a conversation by file.
    manager = SessionManager.open(sessionPath, SESSION_DIR);
  } else if (sessionId) {
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

  const { session } = await createAgentSessionFromServices({ services: await services(), sessionManager: manager });
  const entry = { id, manager, session, activeRun: null, chain: Promise.resolve(), unsubscribe: null, pendingUi: new Map() };
  // Publish the session before binding extensions: a `session_start` handler can
  // open a dialog straight away, and the answer must be able to find us.
  sessions.set(id, entry);
  lastOpened = entry;
  // Stamp every event so clients can route between concurrent sessions.
  entry.unsubscribe = session.subscribe((event) => {
    // pi's own settle event is the single source of truth for "the turn is
    // over"; we only add the abort flag, which the client needs to tell a stop
    // apart from a crash. promptSession() emits a synthetic settle only when pi
    // never got as far as emitting one (a prompt that failed to start).
    if (event.type === 'agent_settled' && entry.activeRun) entry.activeRun.settledByPi = true;
    broadcast(
      event.type === 'agent_settled'
        ? { ...event, aborted: Boolean(entry.activeRun?.aborted), sessionId: id }
        : { ...event, sessionId: id },
    );
  });
  // Extensions get a real UI context (mode "rpc"), so `ctx.ui.confirm()` and
  // friends reach the canvas instead of hanging with nothing to answer them.
  //
  // Deliberately NOT awaited: a `session_start` handler may open a dialog, and
  // awaiting it here would hold back `session_opened` — the client would still
  // be on its "connecting" screen, render no dialog, and the extension and the
  // UI would wait on each other forever.
  void session
    .bindExtensions({ uiContext: createExtensionUIContext(entry), mode: 'rpc' })
    .catch((err) => console.error('[pi-canvas-server] could not bind extension UI:', String(err)));
  logSessionModel(entry, session);
  console.log(`[pi-canvas-server] session opened ${id} — ${manager.getSessionFile?.() ?? '(in-memory)'}`);
  return entry;
}

/**
 * Run a shell command the user typed with `!` (or `!!` to keep it out of the
 * model's context). This is pi's own bash execution, not a tool call: the
 * session records it as a bashExecution message, so `!ls` shows up in the
 * transcript and the next prompt can see it.
 */
async function runBash(entry, { id, command, excludeFromContext }) {
  broadcast({ type: 'bash_start', sessionId: entry.id, id, command, excludeFromContext });
  console.log(`[pi-canvas-server] bash ${entry.id}: ${command}${excludeFromContext ? ' (no context)' : ''}`);
  try {
    // Output streams as the SDK's own bash_execution_update events, which the
    // session subscription above already forwards with this `id`.
    const result = await entry.session.executeBash(command, undefined, { excludeFromContext, id });
    broadcast({ type: 'bash_end', sessionId: entry.id, id, command, excludeFromContext, bashResult: result });
  } catch (err) {
    console.error('[pi-canvas-server] bash failed:', String(err));
    broadcast({ type: 'bash_end', sessionId: entry.id, id, command, excludeFromContext, error: String(err) });
  }
}

/**
 * The model this session will use, and whether a credential exists for it. This
 * is the line that answers "why doesn't it reply" before a prompt is even sent.
 */
function logSessionModel(entry, session) {
  try {
    const model = session.model;
    if (!model) {
      console.log(`[pi-canvas-server] session ${entry.id}: no model resolved`);
      return;
    }
    const provider = model.provider ?? model.providerId ?? '(unknown)';
    const modelId = model.id ?? model.modelId ?? '(unknown)';
    const runtime = session.modelRuntime;
    let auth = 'unknown';
    try {
      auth = [
        `configured=${runtime.hasConfiguredAuth?.(provider)}`,
        `oauth=${runtime.isUsingOAuth?.(provider)}`,
        `subscription=${runtime.isUsingSubscription?.(provider)}`,
      ].join(' ');
    } catch (err) {
      auth = `unavailable (${String(err)})`;
    }
    console.log(`[pi-canvas-server] session ${entry.id}: model ${provider}/${modelId} · auth ${auth}`);
  } catch (err) {
    console.error('[pi-canvas-server] could not describe the session model:', String(err));
  }
}

/**
 * Extension UI sub-protocol.
 *
 * Mirrors pi's RPC mode (docs/rpc.md § Extension UI Protocol) method for
 * method, because this is the documented contract between a pi extension and
 * whatever UI is hosting it. Dialog methods (select/confirm/input/editor) block
 * the extension until the canvas answers; the fire-and-forget ones
 * (notify/setStatus/setTitle/setWidget) are advisory.
 *
 * Methods that need a real terminal (custom(), setFooter(), themes) are no-ops
 * here for the same reason they are no-ops in RPC mode.
 */
function emitUi(entry, request) {
  broadcast({ type: 'extension_ui_request', sessionId: entry.id, id: randomUUID(), ...request });
}

function uiDialog(entry, opts, defaultValue, request, parse) {
  // An aborted signal must not leave a dialog waiting for a user who is gone.
  if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
  const id = randomUUID();
  return new Promise((resolve) => {
    let timeoutId;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener('abort', onAbort);
      entry.pendingUi.delete(id);
    };
    const onAbort = () => { cleanup(); resolve(defaultValue); };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts?.timeout) timeoutId = setTimeout(() => { cleanup(); resolve(defaultValue); }, opts.timeout);
    entry.pendingUi.set(id, { resolve: (response) => { cleanup(); resolve(parse(response)); } });
    broadcast({ type: 'extension_ui_request', sessionId: entry.id, id, ...request });
  });
}

const dlgValue = (response) => (response?.cancelled ? undefined : response?.value);
const dlgConfirmed = (response) => (response?.cancelled ? false : Boolean(response?.confirmed));

function createExtensionUIContext(entry) {
  return {
    select: (title, options, opts) =>
      uiDialog(entry, opts, undefined, { method: 'select', title, options, timeout: opts?.timeout }, dlgValue),
    confirm: (title, message, opts) =>
      uiDialog(entry, opts, false, { method: 'confirm', title, message, timeout: opts?.timeout }, dlgConfirmed),
    input: (title, placeholder, opts) =>
      uiDialog(entry, opts, undefined, { method: 'input', title, placeholder, timeout: opts?.timeout }, dlgValue),
    editor: (title, prefill) => uiDialog(entry, undefined, undefined, { method: 'editor', title, prefill }, dlgValue),
    notify: (message, type) => emitUi(entry, { method: 'notify', message, notifyType: type }),
    setStatus: (key, text) => emitUi(entry, { method: 'setStatus', statusKey: key, statusText: text }),
    setTitle: (title) => emitUi(entry, { method: 'setTitle', title }),
    setWidget: (key, content, options) => {
      if (content === undefined || Array.isArray(content)) {
        emitUi(entry, { method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
    },
    setEditorText: (text) => emitUi(entry, { method: 'set_editor_text', text }),
    pasteToEditor(text) { this.setEditorText(text); },
    // Terminal-only surface: same degradations as RPC mode.
    onTerminalInput: () => () => {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setFooter() {},
    setHeader() {},
    custom: async () => undefined,
    getEditorText: () => '',
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching is not supported in the canvas' }),
    getToolsExpanded: () => false,
    setToolsExpanded() {},
  };
}

/** Prompts are serialized per session, so different sessions run concurrently. */
function promptSession(entry, message, streamingBehavior) {
  const run = { aborted: false };
  entry.activeRun = run;
  const options = streamingBehavior ? { streamingBehavior } : undefined;
  entry.chain = entry.chain
    .then(() => entry.session.prompt(message, options))
    .then(
      () => {
        if (entry.activeRun === run) entry.activeRun = null;
        if (!run.settledByPi) broadcast({ type: 'agent_settled', sessionId: entry.id, aborted: run.aborted });
        console.log(`[pi-canvas-server] settled ${entry.id} (aborted: ${run.aborted})`);
      },
      (err) => {
        if (entry.activeRun === run) entry.activeRun = null;
        // An abort is a normal outcome, not an error to surface.
        if (run.aborted || /abort/i.test(String(err))) {
          if (!run.settledByPi) broadcast({ type: 'agent_settled', sessionId: entry.id, aborted: true });
          console.log(`[pi-canvas-server] settled ${entry.id} (aborted)`);
        } else {
          broadcast({ type: 'server_error', sessionId: entry.id, error: String(err) });
          console.error(`[pi-canvas-server] prompt failed (${entry.id}):`, err);
        }
      },
    );
}

const resolve = (sessionId) => (sessionId ? sessions.get(sessionId) : lastOpened);

/** Every stored session for this workspace, plus whether it is live right now. */
async function listSessions() {
  const list = await SessionManager.list(CWD, SESSION_DIR);
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    modified: s.modified,
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
    cwd: s.cwd,
    file: s.path,
    open: sessions.has(s.id),
  }));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const httpServer = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  // Liveness endpoint — also proves outbound-independent startup.
  if (path === '/') {
    sendJson(res, 200, { ok: true, server: 'pi-canvas-server', sessions: [...sessions.keys()] });
    return;
  }
  // The sidebar reads this: session listing is filesystem work the extension
  // host can't cheaply do itself (the SDK is ESM-only and ~850ms to load).
  if (path === '/sessions') {
    listSessions().then(
      (sessions) => sendJson(res, 200, { sessions }),
      (err) => sendJson(res, 500, { error: String(err) }),
    );
    return;
  }
  sendJson(res, 404, { error: `no such endpoint: ${path}` });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[pi-canvas-server] client connected');
  clients.add(ws);
  // The version lets a stale webview say "we disagree" instead of rendering an
  // agent that silently never answers.
  reply(ws, { type: 'server_ready', protocol: PROTOCOL_VERSION });
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data) => void handle(ws, data));
});

/**
 * A command that carried an `id` gets pi's `response` envelope back. Without an
 * id there is nobody to correlate to, so failures surface as the canvas-wide
 * `server_error` event the error banner already listens for.
 */
function respond(ws, cmd, command, data) {
  if (cmd?.id === undefined) return;
  const envelope = { type: 'response', id: cmd.id, command, success: true };
  if (data !== undefined) envelope.data = data;
  reply(ws, envelope);
}

function respondError(ws, cmd, command, error) {
  const message = String(error);
  if (cmd?.id === undefined) reply(ws, { type: 'server_error', error: message });
  else reply(ws, { type: 'response', id: cmd.id, command, success: false, error: message });
}

/** Describe a session the way `get_state` documents it. */
function stateOf(entry) {
  const model = entry.session.model;
  return {
    sessionId: entry.id,
    sessionFile: entry.manager.getSessionFile?.() ?? null,
    cwd: CWD,
    isStreaming: Boolean(entry.session.isStreaming),
    isIdle: Boolean(entry.session.isIdle),
    thinkingLevel: entry.session.thinkingLevel,
    model: model
      ? { provider: model.provider ?? model.providerId, id: model.id ?? model.modelId, name: model.name }
      : null,
  };
}

async function handle(ws, data) {
  let cmd;
  try {
    cmd = JSON.parse(String(data));
  } catch {
    reply(ws, { type: 'server_error', error: 'bad JSON' });
    return;
  }

  const openEntry = () => resolve(cmd.sessionId);
  /** Every session-scoped command needs a live session to act on. */
  const entryFor = (command) => {
    const entry = openEntry();
    if (!entry) respondError(ws, cmd, command, 'no session open — send open_session first');
    return entry;
  };

  try {
    switch (cmd.type) {
      // -- sessions ---------------------------------------------------------
      case 'open_session':
      // pi's names for the same two intents.
      case 'new_session':
      case 'switch_session': {
        const entry = await openSession({
          sessionId: cmd.sessionId,
          sessionPath: cmd.sessionPath,
          mode: cmd.type === 'new_session' ? 'new' : cmd.mode,
        });
        reply(ws, {
          type: 'session_opened',
          sessionId: entry.id,
          sessionFile: entry.manager.getSessionFile?.() ?? null,
          history: historyOf(entry.manager),
        });
        return;
      }
      case 'list_sessions': {
        const list = await listSessions();
        reply(ws, { type: 'sessions', sessions: list });
        respond(ws, cmd, 'list_sessions', { sessions: list });
        return;
      }
      case 'close_session': {
        const entry = sessions.get(cmd.sessionId);
        if (entry) {
          entry.unsubscribe?.();
          // A dialog nobody can answer any more must not hold an extension open.
          for (const pending of entry.pendingUi?.values?.() ?? []) pending.resolve({ cancelled: true });
          entry.pendingUi?.clear?.();
          sessions.delete(entry.id);
          if (lastOpened === entry) lastOpened = null;
          console.log('[pi-canvas-server] session closed', entry.id);
        }
        respond(ws, cmd, 'close_session', { closed: Boolean(entry) });
        return;
      }
      case 'get_state': {
        const entry = entryFor('get_state');
        if (entry) respond(ws, cmd, 'get_state', stateOf(entry));
        return;
      }
      case 'get_session_stats': {
        const entry = entryFor('get_session_stats');
        if (entry) respond(ws, cmd, 'get_session_stats', entry.session.getSessionStats());
        return;
      }
      case 'set_session_name': {
        const entry = entryFor('set_session_name');
        if (entry) {
          entry.session.setSessionName(String(cmd.name ?? ''));
          respond(ws, cmd, 'set_session_name', { name: cmd.name });
        }
        return;
      }

      // -- model / thinking -------------------------------------------------
      case 'set_model': {
        const entry = entryFor('set_model');
        if (entry) {
          const modelId = String(cmd.model ?? cmd.modelId ?? '');
          const model = cmd.provider
            ? entry.session.modelRuntime.getModel(String(cmd.provider), modelId)
            : (entry.session.modelRuntime.getModels().find((m) => (m.id ?? m.modelId) === modelId) ?? null);
          if (!model) {
            respondError(ws, cmd, 'set_model', `unknown model: ${cmd.provider ? `${cmd.provider}/` : ''}${modelId}`);
          } else {
            await entry.session.setModel(model);
            respond(ws, cmd, 'set_model', stateOf(entry).model);
          }
        }
        return;
      }
      case 'cycle_model': {
        const entry = entryFor('cycle_model');
        if (entry) {
          const result = await entry.session.cycleModel(cmd.direction === 'backward' ? 'backward' : 'forward');
          respond(ws, cmd, 'cycle_model', result ?? null);
        }
        return;
      }
      case 'set_thinking_level': {
        const entry = entryFor('set_thinking_level');
        if (entry) {
          entry.session.setThinkingLevel(String(cmd.level));
          respond(ws, cmd, 'set_thinking_level', { level: entry.session.thinkingLevel });
        }
        return;
      }
      case 'compact': {
        const entry = entryFor('compact');
        if (entry) respond(ws, cmd, 'compact', await entry.session.compact(cmd.instructions));
        return;
      }

      // -- turns ------------------------------------------------------------
      case 'prompt': {
        const entry = entryFor('prompt');
        if (!entry) return;
        const message = String(cmd.message ?? cmd.text ?? '').trim();
        if (!message) return;
        promptSession(entry, message, cmd.streamingBehavior);
        respond(ws, cmd, 'prompt', { sessionId: entry.id });
        return;
      }
      case 'steer':
      case 'follow_up': {
        const entry = entryFor(cmd.type);
        if (!entry) return;
        const message = String(cmd.message ?? cmd.text ?? '').trim();
        if (!message) return;
        // Steering interrupts the running turn; follow-up waits for it. Both
        // belong to the in-flight run, so they do not settle the session.
        await (cmd.type === 'steer' ? entry.session.steer(message) : entry.session.followUp(message));
        respond(ws, cmd, cmd.type, { queued: true });
        return;
      }
      case 'abort': {
        const entry = openEntry();
        if (!entry) return;
        // A `!command` is not an agent turn, so it is cancelled its own way.
        if (entry.session.isBashRunning) entry.session.abortBash();
        if (entry.activeRun) entry.activeRun.aborted = true;
        await entry.session.abort().catch((err) => console.error('[pi-canvas-server] abort failed:', err));
        respond(ws, cmd, 'abort', { aborted: true });
        return;
      }
      case 'abort_bash': {
        const entry = openEntry();
        entry?.session.abortBash();
        respond(ws, cmd, 'abort_bash', { aborted: Boolean(entry) });
        return;
      }

      // -- shell (`!command`) ----------------------------------------------
      case 'bash': {
        const entry = entryFor('bash');
        if (!entry) return;
        const command = String(cmd.command ?? '').trim();
        if (!command) return;
        void runBash(entry, {
          id: cmd.id ? String(cmd.id) : undefined,
          command,
          excludeFromContext: Boolean(cmd.excludeFromContext),
        });
        return;
      }

      // -- extension UI ------------------------------------------------------
      case 'extension_ui_response': {
        const id = String(cmd.id);
        for (const candidate of sessions.values()) {
          const pending = candidate.pendingUi.get(id);
          if (pending) {
            pending.resolve(cmd);
            return;
          }
        }
        return;
      }

      default:
        respondError(ws, cmd, String(cmd.type ?? 'unknown'), `unknown command: ${cmd.type}`);
    }
  } catch (err) {
    console.error(`[pi-canvas-server] ${cmd.type} failed:`, err);
    respondError(ws, cmd, String(cmd.type), err?.message ?? String(err));
  }
}

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[pi-canvas-server] node ${process.version} (${process.execPath})`);
  console.log(`[pi-canvas-server] listening on ws://127.0.0.1:${PORT} (cwd: ${CWD})`);
  console.log(`[pi-canvas-server] session dir: ${SESSION_DIR ?? '(pi default)'}`);
});
