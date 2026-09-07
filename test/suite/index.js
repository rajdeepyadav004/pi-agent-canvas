/**
 * Mocha bootstrap — executed inside the extension host.
 *
 * Loads every *.test.js in this directory. Suites self-select via the
 * CANVAS_TEST_MODE env var ('isolated' | 'shared'), which runTest.js sets
 * from the command line so each behaviour gets its own VS Code run and its
 * own throwaway profile.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 30_000,
    reporter: 'spec',
  });

  const suiteDir = __dirname;
  for (const file of fs.readdirSync(suiteDir).filter((f) => f.endsWith('.test.js'))) {
    mocha.addFile(path.join(suiteDir, file));
  }

  await new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}

module.exports = { run };
