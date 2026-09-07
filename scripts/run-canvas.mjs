/**
 * Launch the CANVAS window as a STANDALONE VS Code window (not under the F5
 * debugger). Same isolated profile & chrome stripping as the debug config,
 * but independent of launch.json selection — run it anywhere:
 *
 *   node scripts/run-canvas.mjs
 *
 * Env overrides:
 *   CODE_BIN   — path to the VS Code binary (default: `code` on PATH)
 *   CODE_ARGS  — extra CLI args (space separated)
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const codeBin = process.env.CODE_BIN || 'code';
const dataDir = join(root, '.vscode', '.devdata');
const extDir = join(root, '.vscode', '.devext');
mkdirSync(dataDir, { recursive: true });
mkdirSync(extDir, { recursive: true });

const args = [
  '--extensionDevelopmentPath=' + root,
  '--disable-extensions',
  '--new-window', // never silently reuse a stale canvas window
  '--user-data-dir=' + dataDir,
  '--extensions-dir=' + extDir,
  ...(process.env.CODE_ARGS ? process.env.CODE_ARGS.split(' ') : []),
];

console.log(`[run-canvas] binary: ${codeBin}`);
console.log(`[run-canvas] profile: ${dataDir}`);
console.log(`[run-canvas] launching: ${codeBin} ${args.join(' ')}`);

const child = spawn(codeBin, args, {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, VSCODE_EXTENSION_ISOLATED: '1' },
});
child.unref();
console.log(`[run-canvas] started pid ${child.pid} — the canvas window is opening…`);
