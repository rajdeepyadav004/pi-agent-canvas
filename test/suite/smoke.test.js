/**
 * Smoke tests: the extension must activate on demand, open the canvas panel,
 * and behave as a singleton — without throwing. Runs inside the extension
 * host of a real VS Code instance.
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');

const PANEL_TITLE = 'Agent Canvas';
const OPEN_COMMAND = 'piAgentCanvas.open';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The canvas tab might be in any tab group. */
function findCanvasTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === PANEL_TITLE || String((tab.input || {}).viewType || '').includes('piAgentCanvas'));
}

describe('pi-agent-canvas', function () {
  this.timeout(60_000);

  it('canvas panel AUTO-OPENS on window start (startup activation works)', async function () {
    // No command invoked here: with activationEvents=[onStartupFinished] the
    // extension must activate itself and open the canvas in an empty window.
    await sleep(2500); // activation + panel HTML build
    assert.strictEqual(findCanvasTabs().length, 1, 'canvas should open itself at startup');
  });

  it('extension activates and the open command resolves', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND); // triggers activation on first call
    await sleep(800);
    assert.ok(vscode.extensions.getExtension('pi-labs.pi-agent-canvas'), 'extension should be loaded');
  });

  it('opens exactly one canvas panel tab', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(1200); // give the panel time to build + set HTML
    const tabs = findCanvasTabs();
    assert.strictEqual(tabs.length, 1, `expected 1 canvas tab, found ${tabs.length}`);
  });

  it('re-running the command reveals the same panel instead of stacking tabs', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(600);
    const tabs = findCanvasTabs();
    assert.strictEqual(tabs.length, 1, 'canvas must be a singleton');
  });

  it('can close and reopen the panel', async () => {
    const first = findCanvasTabs();
    assert.strictEqual(first.length, 1, 'precondition: one panel open');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await sleep(800);
    assert.strictEqual(findCanvasTabs().length, 0, 'panel should be closed');

    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(1200);
    assert.strictEqual(findCanvasTabs().length, 1, 'panel reopens after close');
  });
});
