'use strict';
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const extraArgs = process.argv.slice(2);

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const launchArgs = [
    '--disable-extensions',
    '--disable-gpu',
    '--no-sandbox',
    ...extraArgs,
  ];
  console.log('[runDiag] launchArgs:', JSON.stringify(launchArgs));
  try {
    const code = await runTests({
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath: path.join(projectRoot, 'test', 'diagSuite', 'index.js'),
      launchArgs,
    });
    process.exit(code);
  } catch (err) {
    console.error('[runDiag] failed:', err);
    process.exit(1);
  }
}

main();
