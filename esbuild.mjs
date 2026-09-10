/**
 * pi-agent-canvas — minimal build.
 * Bundles the extension host entry to dist/extension.js.
 * The webview UI (media/) is intentionally STATIC HTML/CSS/JS for now so the
 * layout can be rearranged live without a frontend toolchain. A bundler step
 * (esbuild + React/Svelte) gets added when the real UI lands.
 *
 *   node esbuild.mjs          # one-shot build
 *   node esbuild.mjs --watch  # rebuild on change
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const extensionOptions = {
  entryPoints: { extension: 'src/extension.ts' },
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', '@earendil-works/pi-coding-agent'],
  sourcemap: false,
  logLevel: 'info',
};

const webviewOptions = {
  entryPoints: { webview: 'src/webview/main.tsx' },
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('[esbuild] watching src/ → dist/');
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  console.log('[esbuild] build complete → dist/');
}
