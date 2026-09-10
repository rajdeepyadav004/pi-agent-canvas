/**
 * pi-agent-canvas — build.
 *
 * Two bundles:
 *   dist/extension.js  — the extension host (CJS, `vscode` external)
 *   dist/webview.js    — the canvas UI (browser IIFE; React + assistant-ui +
 *                        diff viewer + markdown, with CSS imported as text and
 *                        injected into a <style> tag because the webview CSP
 *                        allows inline styles but not extra files)
 *
 * scripts/licenses.mjs reuses these options to generate the third-party
 * notices from the real module graph, so the attribution can't drift.
 *
 *   node esbuild.mjs          # one-shot build
 *   node esbuild.mjs --watch  # rebuild on change
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

export const extensionOptions = {
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

export const webviewOptions = {
  entryPoints: { webview: 'src/webview/main.tsx' },
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  // Vendored CSS (diff2html) is imported as a string and injected into a
  // <style> tag — the webview CSP allows inline styles, not extra files.
  loader: { '.css': 'text' },
  sourcemap: false,
  logLevel: 'info',
};

// Only build when run directly (licenses.mjs imports the options above).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && watch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('[esbuild] watching src/ → dist/');
} else if (isMain) {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  console.log('[esbuild] build complete → dist/');
}
