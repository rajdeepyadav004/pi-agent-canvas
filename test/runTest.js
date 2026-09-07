/**
 * Automated smoke test runner.
 *
 * Boots a REAL VS Code instance (downloaded once into .vscode-test/) with this
 * extension loaded, runs test/suite/*.test.js inside the extension host, and
 * maps the exit code through so `npm test` fails loudly in CI.
 *
 * Two modes, selected with CANVAS_TEST_MODE (default: isolated):
 *
 *   isolated — mirrors the F5 "CANVAS (isolated, default)" launch: the
 *              VSCODE_EXTENSION_ISOLATED=1 env guard is set, so the extension
 *              strips chrome and auto-opens the canvas.
 *
 *   shared   — mirrors a normal window: the guard is NOT set, so the
 *              extension must not touch chrome and must not auto-open.
 *
 * Each mode gets its own throwaway user-data-dir so chrome assertions in one
 * mode can never be contaminated by the other.
 */
'use strict';
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const mode = process.env.CANVAS_TEST_MODE === 'shared' ? 'shared' : 'isolated';

  // The extension reads this env var to decide whether it may touch chrome.
  // Set it ONLY in isolated mode — that is the whole point of the shared run.
  if (mode === 'isolated') {
    process.env.VSCODE_EXTENSION_ISOLATED = '1';
  } else {
    delete process.env.VSCODE_EXTENSION_ISOLATED;
  }

  let exitCode = 0;
  try {
    exitCode = await runTests({
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath: path.join(projectRoot, 'test', 'suite', 'index.js'),
      launchArgs: [
        '--disable-extensions', // throwaway profile, nothing else loaded
        '--disable-gpu',
        '--no-sandbox', // required in many container/CI environments
        `--user-data-dir=${path.join(projectRoot, '.vscode-test', `user-data-${mode}`)}`,
      ],
    });
  } catch (err) {
    console.error(`[runTest:${mode}] failed to launch VS Code test host:`, err);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
