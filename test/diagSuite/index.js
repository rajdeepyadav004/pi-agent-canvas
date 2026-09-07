'use strict';
const path = require('node:path');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000, reporter: 'spec' });
  mocha.addFile(path.join(__dirname, 'diag.test.js'));
  await new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} failed`)) : resolve()));
  });
}
module.exports = { run };
