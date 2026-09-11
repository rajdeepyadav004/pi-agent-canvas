#!/usr/bin/env node
/**
 * Diagnose "the canvas isn't replying" on a machine, without the canvas.
 *
 * It does exactly what the extension does — starts the agent server as a child
 * process and speaks the same JSON over the same WebSocket — then prints every
 * event with timestamps and a verdict. That separates the three things that can
 * fail independently:
 *
 *   1. the agent server / pi SDK / credentials / network  (this script says so)
 *   2. the bridge between the canvas webview and the server
 *   3. the UI
 *
 * Run it from the installed extension directory:
 *
 *   node scripts/diagnose.mjs
 *
 * Options (env): PI_CANVAS_CWD, PI_CANVAS_SESSION_DIR, PI_CANVAS_DIAG_PORT,
 * PI_CANVAS_DIAG_PROMPT, PI_CANVAS_DIAG_TIMEOUT (seconds).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// A free port per run: a leftover server from an earlier attempt would answer
// on a fixed port, and we would silently diagnose the wrong process.
const PORT = Number(process.env.PI_CANVAS_DIAG_PORT ?? (await freePort()));
const PROMPT = process.env.PI_CANVAS_DIAG_PROMPT ?? 'Reply with exactly: DIAGNOSE-OK';
const TIMEOUT_S = Number(process.env.PI_CANVAS_DIAG_TIMEOUT ?? 90);

/** Grab an unused localhost port, then let go of it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const say = (...args) => console.log(...args);
const t0 = Date.now();
const stamp = () => `+${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s`;

say('--- environment ---------------------------------------------------');
say(`node        ${process.version}  (${process.execPath})`);
say(`platform    ${process.platform} ${process.arch}`);
say(`cwd         ${process.env.PI_CANVAS_CWD ?? process.cwd()}`);
say(`PATH        ${process.env.PATH ?? '(unset)'}`);
for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
  if (process.env[key]) say(`${key.padEnd(11)} ${process.env[key]}`);
}
say(`pi config   ${process.env.HOME ?? '(no HOME)'}/.pi`);

// The client library ships in vendor/ (packaged) or node_modules/ (checkout).
const wsEntry = [
  join(root, 'vendor', 'node_modules', 'ws', 'wrapper.mjs'),
  join(root, 'node_modules', 'ws', 'wrapper.mjs'),
].find((candidate) => existsSync(candidate));
if (!wsEntry) {
  say('\nFATAL: cannot find ws — run this from the extension directory.');
  process.exit(2);
}
const { WebSocket } = await import(pathToFileURL(wsEntry).href);

say('\n--- starting the agent server (as the extension does) -------------');
const server = spawn('node', [join(here, 'pi-server.mjs')], {
  cwd: root,
  env: { ...process.env, PI_CANVAS_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
server.on('error', (err) => {
  say(`\nFATAL: could not start the server: ${err.message}`);
  say('On macOS this is usually a Dock-launched VS Code with no nvm/Homebrew PATH.');
  process.exit(3);
});
let serverExited;
server.on('exit', (code, signal) => {
  serverExited = `${code ?? signal}`;
  if (code !== 0 && code !== null) say(`\nserver exited early with code ${code}${signal ? ` (${signal})` : ''}`);
});

// The server needs a few seconds for the model runtime and session index.
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    ready = res.ok;
  } catch { /* not up yet */ }
}
if (serverExited && !ready) {
  say(`\nFATAL: the agent server exited immediately (${serverExited}) — see its output above.`);
  say('Nothing to diagnose until that starts, because every other symptom follows from it.');
  setTimeout(() => process.exit(3), 250);
}
if (!ready) {
  say('\nFATAL: the server never answered. Its own output is above.');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(4), 250);
}
say(`${stamp()} server is up`);

// Everything past here can end the run, so it lives in a function and returns
// instead of falling through to the "it works" verdict.
async function main() {
say('\n--- opening a session and prompting ------------------------------');
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events = [];
ws.on('message', (d) => {
  const event = JSON.parse(String(d));
  events.push(event);
  // Keep the transcript readable: deltas are counted, not printed.
  if (event.type === 'message_update') return;
  const detail = event.error ? `: ${event.error}` : '';
  say(`${stamp()} ${event.type}${detail}`);
});
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

ws.send(JSON.stringify({ type: 'open_session', mode: 'new' }));
const opened = await waitFor(events, (e) => e.type === 'session_opened', 30);
if (!opened) {
  say('\nFATAL: the server never opened a session.');
  return finish(5);
}
say(`${stamp()} session ${opened.sessionId}`);

ws.send(JSON.stringify({ type: 'prompt', sessionId: opened.sessionId, message: PROMPT }));
// `agent_settled` is pi's own end-of-turn event (scripts/pi-server.mjs).
const outcome = await waitFor(events, (e) => e.type === 'agent_settled' || e.type === 'server_error', TIMEOUT_S);
const text = events
  .filter((e) => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta')
  .map((e) => e.assistantMessageEvent.delta)
  .join('');
const tools = events.filter((e) => e.type === 'tool_execution_end').length;

say('\n--- verdict -------------------------------------------------------');
if (!outcome) {
  const last = events.filter((e) => e.type !== 'message_update').slice(-1)[0];
  say(`HUNG: no reply within ${TIMEOUT_S}s. Last event: ${last ? last.type : '(none — the prompt never started)'}`);
  say('A hang here is a network/provider problem, not a UI problem: the model');
  say('request never completed. Check the proxy lines above and whether this');
  say('machine can reach the provider.');
  return finish(7);
}
if (outcome.type === 'server_error') {
  say(`FAILED: ${outcome.error}`);
  say('This is the same error the canvas shows in its banner.');
  return finish(6);
}
say(`REPLIED in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${tools} tool call(s)`);
say(`text: ${JSON.stringify(text.slice(0, 200))}`);
say('\nThe agent works on this machine. If the canvas still shows nothing, the');
say('problem is the bridge or the UI — capture the "Pi Agent Canvas" output');
say('channel from VS Code and compare it with this transcript.');
return finish(0);
}
await main();

/** Wait for an event matching `predicate`, or return undefined on timeout. */
async function waitFor(events, predicate, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

/** Close everything and exit, allowing piped output to flush first. */
function finish(code) {
  return new Promise((resolve) => {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(code), 250);
    void resolve;
  });
}
