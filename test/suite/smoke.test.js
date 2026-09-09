/**
 * ISOLATED-mode tests (VSCODE_EXTENSION_ISOLATED=1, the F5 "CANVAS" launch /
 * `npm run canvas` throwaway profile): the canvas auto-opens for dev use —
 * and even here, no chrome setting is ever modified.
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');
const { assertChromeUntouched } = require('./chromeSafety.js');

const mode = process.env.CANVAS_TEST_MODE || 'isolated';
const suite = mode === 'isolated' ? describe : describe.skip;

const PANEL_TITLE = 'Agent Canvas';
const OPEN_COMMAND = 'piAgentCanvas.open';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findCanvasTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === PANEL_TITLE || String((tab.input || {}).viewType || '').includes('piAgentCanvas'));
}

suite('pi-agent-canvas (isolated dev window)', function () {
  this.timeout(60_000);

  it('canvas panel AUTO-OPENS on window start', async function () {
    await sleep(3500); // activation + retry loop + panel HTML build
    assert.strictEqual(findCanvasTabs().length, 1, 'canvas should open itself in the isolated dev window');
  });

  it('extension is loaded and NO chrome setting was touched', async () => {
    assert.ok(vscode.extensions.getExtension('pi-labs.pi-agent-canvas'), 'extension should be loaded');
    await assertChromeUntouched('isolated dev window', { 'chat.disableAIFeatures': true });
  });

  it('opens exactly one canvas panel tab (singleton)', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(300);
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(800);
    assert.strictEqual(findCanvasTabs().length, 1, 'canvas must stay a singleton');
  });

  it('can close and reopen the panel', async () => {
    const before = findCanvasTabs();
    assert.strictEqual(before.length, 1, 'canvas should be open before close');
    await vscode.window.tabGroups.close(before[0].group);
    await sleep(500);
    assert.strictEqual(findCanvasTabs().length, 0, 'canvas should be closed');
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(800);
    assert.strictEqual(findCanvasTabs().length, 1, 'canvas should reopen');
  });
});
