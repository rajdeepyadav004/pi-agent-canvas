/**
 * SHARED-mode tests (no VSCODE_EXTENSION_ISOLATED guard — like the user's
 * real VS Code): the extension is a perfect guest. It never auto-opens
 * anything, never touches chrome (before OR after the user opens the
 * canvas), and the canvas is strictly opt-in.
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');
const { assertChromeUntouched } = require('./chromeSafety.js');

const mode = process.env.CANVAS_TEST_MODE || 'isolated';
const suite = mode === 'shared' ? describe : describe.skip;

const PANEL_TITLE = 'Agent Canvas';
const OPEN_COMMAND = 'piAgentCanvas.open';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findCanvasTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === PANEL_TITLE || String((tab.input || {}).viewType || '').includes('piAgentCanvas'));
}

suite('pi-agent-canvas (normal window — perfect guest)', function () {
  this.timeout(60_000);

  it('extension is loaded but does NOT auto-open the canvas', async () => {
    await sleep(3500); // give a badly-behaved extension every chance to misbehave
    assert.ok(vscode.extensions.getExtension('pi-labs.pi-agent-canvas'), 'extension should be loaded');
    assert.strictEqual(findCanvasTabs().length, 0, 'canvas must not open itself in a normal window');
  });

  it('chrome settings untouched before any user action', async () => {
    await assertChromeUntouched('normal window, before open');
  });

  it('chrome settings STILL untouched after the user opens the canvas', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(1200);
    assert.strictEqual(findCanvasTabs().length, 1, 'explicit open should work in a normal window');
    await assertChromeUntouched('normal window, after open');
  });

  it('canvas closes cleanly and chrome is still untouched', async () => {
    const tabs = findCanvasTabs();
    await vscode.window.tabGroups.close(tabs[0].group);
    await sleep(500);
    assert.strictEqual(findCanvasTabs().length, 0, 'canvas should close cleanly');
    await assertChromeUntouched('normal window, after close');
  });
});
