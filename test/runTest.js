/**
 * Automated smoke test runner.
 *
 * Boots a REAL VS Code instance (downloaded once into .vscode-test/) with this
 * extension loaded, runs test/suite/*.test.js inside the extension host, and
 * maps the exit code through so `npm test` fails loudly in CI.
 *
 * Mirrors the "ISOLATED window" launch config: no other extensions.
 */
'use strict';
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const projectRoot = path.join(__dirname, '..');

  // The tests exercise the isolated canvas path (auto-open, chrome
  // stripping) — the same mode the F5 "CANVAS" launch config uses.
  process.env.VSCODE_EXTENSION_ISOLATED = '1';  let exitCode = 0;
  try {
    exitCode = await runTests({
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath: path.join(projectRoot, 'test', 'suite', 'index.js'),
      launchArgs: [
        '--disable-extensions', // throwaway profile, nothing else loaded
        '--disable-gpu',
        '--no-sandbox', // required in many container/CI environments
      ],
    });
  } catch (err) {
    console.error('[runTest] failed to launch VS Code test host:', err);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
