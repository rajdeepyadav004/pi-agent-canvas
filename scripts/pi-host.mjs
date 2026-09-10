#!/usr/bin/env node
/**
 * pi-agent-canvas — pi host shim.
 *
 * A plain Node process that owns an in-process pi AgentSession and speaks
 * JSONL on stdio: one line in = {"type":"prompt","message":...} (or "abort"),
 * SDK events streamed out one JSON object per line. Lives between the VS Code
 * extension host and pi so pi's networking never touches the Electron
 * extension-host process (whose patched fetch stalls SSE streams).
 *
 * Protocol: strict JSONL, LF-delimited (pi docs framing rules).
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { StringDecoder } from 'node:string_decoder';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const modelRuntime = await ModelRuntime.create();

// Connectivity probe: can THIS process reach the provider at all?
try {
  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/models', { signal: AbortSignal.timeout(15_000) });
  send({ type: 'shim_probe', status: res.status, ms: Date.now() - t0 });
} catch (err) {
  send({ type: 'shim_probe', error: String(err) });
}

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});
session.subscribe((event) => send(event));
send({ type: 'shim_ready' });

let chain = Promise.resolve();

const onLine = (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    send({ type: 'shim_error', error: 'bad JSONL' });
    return;
  }
  if (cmd.type === 'prompt') {
    chain = chain
      .then(() => session.prompt(String(cmd.message ?? '')))
      .then(() => send({ type: 'shim_settled' }))
      .catch((err) => send({ type: 'shim_error', error: String(err) }));
  } else if (cmd.type === 'abort') {
    void session.abort();
  }
};

const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (line) onLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
