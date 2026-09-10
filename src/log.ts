import * as vscode from 'vscode';

/**
 * One log for everything the canvas cannot tell you in the UI: the agent
 * server's own stdout/stderr, webview crashes, spawn failures.
 *
 * This exists because "the agent isn't replying" used to be completely silent —
 * the server ran with stdio: 'ignore', so its errors (missing API key, a
 * network block, a broken vendored SDK) went nowhere. Anything that can fail
 * out of sight now lands here.
 */
let channel: vscode.OutputChannel | undefined;

/** Last N lines, so the host can offer "copy diagnostics" (and tests can assert). */
const recent: string[] = [];
const RECENT_LIMIT = 500;

export function initLog(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Pi Agent Canvas');
  return channel;
}

export function log(message: string): void {
  const line = `${new Date().toISOString()}  ${message}`;
  initLog().appendLine(line);
  recent.push(line);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

export function recentLogs(): string[] {
  return [...recent];
}

/** Stream a child process's stdout/stderr into the log, line by line. */
export function pipeToLog(stream: NodeJS.ReadableStream | null, label: string): void {
  if (!stream) return;
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) log(`${label} ${line}`);
  });
  stream.on('end', () => {
    if (buffered.trim()) log(`${label} ${buffered}`);
  });
  stream.on('error', (err: Error) => log(`${label} <stream error: ${err.message}>`));
}

export function showLog(): void {
  initLog().show(true);
}
