/**
 * SHARED-mode tests (no VSCODE_EXTENSION_ISOLATED guard — like a normal VS
 * Code window): the extension must be a perfect guest. It may load, but it
 * must NOT touch chrome, NOT auto-open anything, and its chrome commands
 * must refuse to run. The canvas itself stays opt-in via piAgentCanvas.open.
 *
 * Runs only when CANVAS_TEST_MODE is 'shared'.
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');

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

async function cfg(key) {
  return vscode.workspace.getConfiguration().get(key);
}

/** Every chrome key the extension manages in isolated mode, with the values
 *  a normal window must still have (undefined = untouched default). */
const CHROME_KEYS_UNTOUCHED = {
  'window.menuBarVisibility': 'classic', // VS Code default
  'workbench.statusBar.visible': true,
  'workbench.editor.showTabs': 'multiple',
  'window.titleBarStyle': 'custom', // VS Code default on Linux
  'workbench.activityBar.location': 'default',
  'chat.viewSessions.enabled': true, // VS Code default
  'workbench.secondarySideBar.defaultVisibility': 'visibleInWorkspace', // VS Code default
};

suite('pi-agent-canvas (extension OFF — normal window untouched)', function () {
  this.timeout(60_000);

  it('extension is loaded but leaves every chrome setting at its default', async () => {
    await sleep(3000); // give a badly-behaved extension every chance to misbehave
    assert.ok(vscode.extensions.getExtension('pi-labs.pi-agent-canvas'), 'extension should be loaded');

    for (const [key, expected] of Object.entries(CHROME_KEYS_UNTOUCHED)) {
      const actual = await cfg(key);
      assert.strictEqual(
        actual,
        expected,
        `normal window must keep default '${key}' (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
      );
    }
  });

  it('does NOT auto-open the canvas at startup', async () => {
    await sleep(2000);
    assert.strictEqual(findCanvasTabs().length, 0, 'canvas must not open itself in a normal window');
  });

  it('piAgentCanvas.toggleMinimalChrome refuses to run', async () => {
    await vscode.commands.executeCommand('piAgentCanvas.toggleMinimalChrome'); // may show a warning — must not throw
    await sleep(500);
    const menu = await cfg('window.menuBarVisibility');
    assert.notStrictEqual(menu, 'hidden', 'toggle command must not hide the menu bar in a normal window');
    const statusBar = await cfg('workbench.statusBar.visible');
    assert.strictEqual(statusBar, true, 'toggle command must not touch the status bar in a normal window');
  });

  it('piAgentCanvas.restoreChrome refuses to run', async () => {
    await vscode.commands.executeCommand('piAgentCanvas.restoreChrome');
    await sleep(500);
    const titleBar = await cfg('window.titleBarStyle');
    assert.strictEqual(titleBar, 'custom', 'restore must not rewrite titleBarStyle in a normal window');
    const sessions = await cfg('chat.viewSessions.enabled');
    assert.strictEqual(sessions, true, 'restore must not rewrite chat settings in a normal window');
  });

  it('canvas remains opt-in: piAgentCanvas.open works on request', async () => {
    await vscode.commands.executeCommand(OPEN_COMMAND);
    await sleep(1200);
    assert.strictEqual(findCanvasTabs().length, 1, 'explicit open should still work in a normal window');

    // And closing it again leaves the window as it was.
    const tabs = findCanvasTabs();
    await vscode.window.tabGroups.close(tabs[0].group);
    await sleep(500);
    assert.strictEqual(findCanvasTabs().length, 0, 'canvas should close cleanly');
  });
});
