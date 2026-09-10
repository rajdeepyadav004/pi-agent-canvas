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
 *        {"type":"server_ready"} and {"type":"settled"} | {"type":"server_error"}
 *
 * Run: node scripts/pi-server.mjs   (env: PI_CANVAS_PORT, default 47811)
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PI_CANVAS_PORT ?? 47811);

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
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

let chain = Promise.resolve();

const httpServer = createServer((_req, res) => {
  // Liveness endpoint — also proves outbound-independent startup.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, server: 'pi-canvas-server' }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[pi-canvas-server] client connected');
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'server_ready' }));
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
      // Serialized: one prompt at a time, in submission order.
      chain = chain
        .then(() => session.prompt(message))
        .then(() => { broadcast({ type: 'settled' }); console.log('[pi-canvas-server] prompt settled, deltas:', globalThis.__deltas ?? 0); })
        .catch((err) => broadcast({ type: 'server_error', error: String(err) }));
    } else if (cmd.type === 'abort') {
      void session.abort();
    }
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[pi-canvas-server] listening on ws://127.0.0.1:${PORT}`);
});
