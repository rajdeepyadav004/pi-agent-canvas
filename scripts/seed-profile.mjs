/**
 * Maintain the ISOLATED canvas dev profile (<project>/.vscode/.devdata).
 *
 * Since v0.1.0 the canvas no longer strips VS Code chrome anywhere — the
 * canvas is a normal tab in a normal window. This script now only makes sure
 * the throwaway profile exists and REMOVES any chrome-stripping keys left
 * over from earlier versions, so the canvas window keeps its menu bar,
 * command center, activity bar, sidebar, and status bar.
 *
 *   node scripts/seed-profile.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = join(root, '.vscode', '.devdata', 'User', 'settings.json');

/** Keys written by older versions of this project — always pruned. */
const LEGACY_CHROME_KEYS = [
  'window.menuBarVisibility',
  'window.commandCenter',
  'window.titleBarStyle',
  'window.layoutControl.enabled',
  'workbench.statusBar.visible',
  'workbench.activityBar.location',
  'workbench.activityBar.visible',
  'workbench.editor.showTabs',
  'workbench.startupEditor',
  'workbench.layoutControl.enabled',
  'workbench.secondarySideBar.visible',
  'workbench.secondarySideBar.defaultVisibility',
  'chat.titleBar.openInAgentsWindow.enabled',
  'chat.titleBar.signIn.enabled',
  'chat.agentsControl.enabled',
  'chat.agentSessions.showExternal',
  'chat.agent.enabled',
  'chat.viewSessions.enabled',
  'chat.editor.localAgent.enabled',
  'chat.tips.enabled',
  'chat.agentSessionProjection.enabled',
  'agents.voice.enabled',
  'agents.voice.showButton',
];

mkdirSync(dirname(settingsPath), { recursive: true });

const merged = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, 'utf8'))
  : {};

let removed = 0;
for (const key of LEGACY_CHROME_KEYS) {
  if (key in merged) {
    delete merged[key];
    removed++;
  }
}

writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log(
  `[seed-profile] profile ok — ${removed} legacy chrome key(s) pruned, ` +
  `${Object.keys(merged).length} user key(s) kept`,
);
