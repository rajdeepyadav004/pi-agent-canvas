/**
 * pi-agent-canvas — canvas surface script.
 * The surface is intentionally blank; this file only keeps the
 * acquireVsCodeApi bridge alive for the host.
 */
'use strict';

try {
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ type: 'ready' });
} catch {
  /* running outside VS Code (e.g. plain browser) — fine */
}
