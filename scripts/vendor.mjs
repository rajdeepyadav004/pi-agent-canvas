#!/usr/bin/env node
/**
 * Build the `vendor/` tree that ships inside the .vsix.
 *
 * The extension host has no runtime npm dependencies at all — but
 * `scripts/pi-server.mjs` (a plain Node process it spawns) loads two things:
 *
 *   - pi's PREBUILT SDK bundle, not the full package: `dist/bundle` is ~7.7MB
 *     and self-contained apart from @earendil-works/chord, where the published
 *     package is ~157MB of provider SDKs (openai, google, anthropic, aws, …)
 *   - `ws`, for the localhost WebSocket the canvas talks over
 *
 * vsce refuses to package `node_modules` at all (and `--no-dependencies` skips
 * it), so these are copied into a plain `vendor/node_modules` tree. Keeping the
 * real node_modules shape matters: pi's bundle imports
 * `@earendil-works/chord/context` bare, and Node resolves that by walking up
 * from the importing chunk into vendor/node_modules.
 *
 *   node scripts/vendor.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = (...p) => join(root, 'node_modules', ...p);
const to = (...p) => join(root, 'vendor', 'node_modules', ...p);

/** [source, destination] pairs, relative to node_modules. */
const pieces = [
  [
    from('@earendil-works', 'pi-coding-agent', 'dist', 'bundle'),
    to('@earendil-works', 'pi-coding-agent', 'dist', 'bundle'),
  ],
  // Where pi's bundle actually lives inside a normal install; vendoring it in
  // the same shape keeps its bare imports resolving.
  [
    from('@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'chord'),
    to('@earendil-works', 'chord'),
  ],
  [from('ws'), to('ws')],
];

/** Recursive byte size (statSync on a directory only reports the inode). */
function dirSize(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => sum + dirSize(join(path, entry)), 0);
}

rmSync(join(root, 'vendor'), { recursive: true, force: true });

let total = 0;
for (const [source, destination] of pieces) {
  if (!existsSync(source)) {
    console.error(`[vendor] MISSING ${source} — run npm install first`);
    process.exit(1);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  total += dirSize(destination);
  console.log(`[vendor] ${source.replace(root + '/', '')} → ${destination.replace(root + '/', '')}`);
}

// pi ships no LICENSE file, only the field; carry the notice forward anyway.
const licence = [
  'pi-agent-canvas vendors the packages below for its agent server.',
  '',
  '@earendil-works/pi-coding-agent  MIT  (dist/bundle build only)',
  '@earendil-works/chord            MIT',
  'ws                               MIT',
  '',
  'See THIRD-PARTY-NOTICES.md and the upstream repositories for full texts.',
  '',
].join('\n');
mkdirSync(join(root, 'vendor'), { recursive: true });
writeFileSync(join(root, 'vendor', 'README.md'), licence);

console.log(`[vendor] done — ${(total / 1024 / 1024).toFixed(1)} MB in vendor/`);
