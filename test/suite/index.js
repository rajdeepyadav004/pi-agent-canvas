/**
 * Mocha bootstrap — executed inside the extension host.
 */
'use strict';
const path = require('node:path');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 30_000,
    reporter: 'spec',
  });

  const suiteDir = __dirname;
  mocha.addFile(path.join(suiteDir, 'smoke.test.js'));
  await new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}

module.exports = { run };
