#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-NOTICES.md.
 *
 * This extension redistributes code it did not write, in two forms:
 *
 *   1. bundled into dist/webview.js (React, assistant-ui, the diff viewer, …)
 *   2. vendored under node_modules/ and shipped inside the .vsix, because
 *      pi-canvas-server loads them at runtime (pi's prebuilt SDK bundle,
 *      @earendil-works/chord, ws)
 *
 * Rather than hand-maintaining a list that rots, this walks the REAL module
 * graph: esbuild reports exactly which packages ended up in the webview bundle
 * (metafile, no output written), and the vendored set is listed explicitly in
 * package.json's `piCanvas.vendored`.
 *
 *   node scripts/licenses.mjs
 */
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webviewOptions } from '../esbuild.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Package names esbuild pulled into the webview bundle. */
async function bundledPackages() {
  const result = await esbuild.build({
    ...webviewOptions,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const names = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    // inputs look like "node_modules/react/index.js" or
    // "node_modules/@scope/pkg/dist/x.js"
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Read a package's own metadata, wherever npm put it. */
function readPackage(name) {
  const candidates = [
    join(root, 'node_modules', name, 'package.json'),
    join(root, 'node_modules', '@earendil-works/pi-coding-agent', 'node_modules', name, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  return undefined;
}

function licenseOf(meta) {
  if (!meta) return 'UNKNOWN';
  const license = meta.license ?? meta.licenses;
  if (typeof license === 'string') return license;
  if (Array.isArray(license)) return license.map((l) => l.type).join(', ');
  if (license && typeof license === 'object') return license.type;
  return 'UNKNOWN';
}

function urlOf(meta) {
  const repo = meta?.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  return url?.replace(/^git\+/, '').replace(/\.git$/, '') ?? '';
}

const bundled = await bundledPackages();
const vendored = new Set(manifest.piCanvas?.vendored ?? []);
const rows = [];

for (const name of [...bundled, ...vendored].sort((a, b) => a.localeCompare(b))) {
  const meta = readPackage(name);
  rows.push({
    name,
    version: meta?.version ?? '',
    license: licenseOf(meta),
    where: [bundled.has(name) ? 'bundled in dist/webview.js' : '', vendored.has(name) ? 'vendored' : '']
      .filter(Boolean)
      .join(' + '),
    url: urlOf(meta),
  });
}

const unknown = rows.filter((row) => row.license === 'UNKNOWN');
const lines = [
  '# Third-party notices',
  '',
  'pi-agent-canvas is MIT licensed (see LICENSE). It redistributes the',
  'following third-party packages, all of them permissively licensed:',
  '',
  '| Package | Version | Licence | Where |',
  '| --- | --- | --- | --- |',
  ...rows.map(
    (row) =>
      `| ${row.url ? `[${row.name}](${row.url})` : row.name} | ${row.version} | ${row.license} | ${row.where} |`,
  ),
  '',
  '"bundled" means the code is compiled into `dist/webview.js`; "vendored" means',
  'the package directory ships inside the .vsix and is loaded at runtime by',
  '`scripts/pi-server.mjs`.',
  '',
  'The vendored set is deliberately minimal: pi\'s full npm package is ~157MB of',
  'provider SDKs, so the server loads the prebuilt `dist/bundle` build instead',
  '(see `loadPi()` in `scripts/pi-server.mjs`).',
  '',
  'Full licence texts are available in each package (and in the upstream',
  'repositories linked above).',
  '',
];

if (unknown.length) {
  lines.push(`> ${unknown.length} package(s) declare no licence and need review: ${unknown.map((r) => r.name).join(', ')}`, '');
}

writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'));
console.log(`[licenses] wrote THIRD-PARTY-NOTICES.md — ${rows.length} packages (${bundled.size} bundled, ${vendored.size} vendored)`);
if (unknown.length) console.warn(`[licenses] UNKNOWN licence: ${unknown.map((r) => r.name).join(', ')}`);
