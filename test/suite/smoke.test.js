/**
 * ISOLATED-mode tests (VSCODE_EXTENSION_ISOLATED=1, like the F5 "CANVAS"
 * launch): the extension strips chrome and auto-opens the canvas.
 *
 * Runs only when CANVAS_TEST_MODE is 'isolated' (or unset — the default).
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');

const mode = process.env.CANVAS_TEST_MODE || 'isolated';
const suite = mode === 'isolated' ? describe : describe.skip;

const PANEL_TITLE = 'Agent Canvas';
const OPEN_COMMAND = 'piAgentCanvas.open';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The canvas tab might be in any tab group. */
function findCanvasTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === PANEL_TITLE || String((tab.input || {}).viewType || '').includes('piAgentCanvas'));
}

async function cfg(key) {
  return vscode.workspace.getConfiguration().get(key);
}

suite('pi-agent-canvas (extension ON — isolated canvas mode)', function () {
  this.timeout(60_000);

  it('chrome stripping applied: menu, tabs, status bar, title bar, agent sessions', async () => {
    await sleep(4000); // applyChromeKiosk writes ~20 keys sequentially at activation
    assert.strictEqual(await cfg('window.menuBarVisibility'), 'hidden', 'menu bar must be hidden');
    assert.strictEqual(await cfg('window.commandCenter'), false, 'command center must be off');
    assert.strictEqual(await cfg('workbench.statusBar.visible'), false, 'status bar must be hidden');
    assert.strictEqual(await cfg('workbench.editor.showTabs'), 'none', 'editor tabs must be hidden');
    assert.strictEqual(await cfg('window.titleBarStyle'), 'native', 'custom title bar row must be gone');
    assert.strictEqual(await cfg('workbench.activityBar.location'), 'hidden', 'activity bar must be hidden');
    assert.strictEqual(await cfg('chat.viewSessions.enabled'), false, 'agent sessions side window must be off');
    assert.strictEqual(await cfg('workbench.secondarySideBar.defaultVisibility'), 'hidden', 'right sidebar must default to hidden');
  });

  it('canvas panel AUTO-OPENS on window start (startup activation works)', async function () {
    // No command invoked here: with activationEvents=[*] the extension must
    // activate itself and open the canvas in an empty window.
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
    assert.strictEqual(tabs.length, 1, `expected exactly 1 canvas tab, found ${tabs.length}`);
  });

  it('re-running the command reveals the same panel instead of stacking tabs', async () => {
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
