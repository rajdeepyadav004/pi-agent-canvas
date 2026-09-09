/**
 * CHROME-SAFETY tests — the core guarantee of this extension, checked in BOTH
 * modes: the extension must never modify any VS Code chrome/window setting.
 *
 * Asserted as "not our old kiosk value" rather than exact defaults, so the
 * suite stays valid as VS Code evolves its defaults.
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');

/** key -> value this extension's old kiosk mode used to write. A window is
 *  "touched" if any of these match. */
const KIOSK_VALUES = {
  'window.menuBarVisibility': 'hidden',
  'window.commandCenter': false,
  'window.titleBarStyle': 'native',
  'window.layoutControl.enabled': false,
  'workbench.statusBar.visible': false,
  'workbench.activityBar.location': 'hidden',
  'workbench.editor.showTabs': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.viewSessions.enabled': false,
  'chat.agent.enabled': false,
};

async function assertChromeUntouched(label) {
  for (const [key, kiosk] of Object.entries(KIOSK_VALUES)) {
    const actual = await vscode.workspace.getConfiguration().get(key);
    assert.notStrictEqual(
      actual,
      kiosk,
      `${label}: '${key}' must never be rewritten by the extension (found kiosk value ${JSON.stringify(kiosk)})`,
    );
  }
}

module.exports = { assertChromeUntouched, KIOSK_VALUES };
