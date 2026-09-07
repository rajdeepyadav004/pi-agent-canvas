/**
 * Seed the ISOLATED canvas profile with chrome-stripping user settings.
 *
 * Writes/merges <project>/.vscode/.devdata/User/settings.json — the exact
 * user-data dir the "CANVAS (isolated, default)" launch config passes via
 * --user-data-dir. VS Code reads this file at window startup, so the chrome
 * is stripped from the very first paint — no extension activation needed.
 *
 * Keep in sync with CHROME_DEFAULTS in src/extension.ts (the extension
 * re-asserts these via ConfigurationTarget.Global as a runtime fallback).
 *
 *   node scripts/seed-profile.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CHROME_DEFAULTS = {
  // ── Window frame ──────────────────────────────────────────────
  'window.menuBarVisibility': 'hidden', // File/Edit/Selection/View/Go/Run/Terminal/Help
  'window.titleBarStyle': 'native', // OS title bar only — no custom title-bar row
  'window.commandCenter': false, // top-center command/search box
  'workbench.layoutControl.enabled': false, // title-bar layout/chat icon cluster
  'workbench.statusBar.visible': false, // bottom bar (notifications still appear as toasts)
  'workbench.secondarySideBar.visible': false, // right-hand panel (Chat etc.)
  'workbench.editor.showTabs': 'none', // tab strip above the editor
  'workbench.startupEditor': 'none', // no Welcome tab
  // ── VS Code 1.136 core agent/chat chrome (verified against 1.136.1) ──
  'chat.titleBar.openInAgentsWindow.enabled': false, // "Open in Agents" title-bar button
  'chat.titleBar.signIn.enabled': false, // "Copilot Sign In" title-bar button
  'chat.agentsControl.enabled': 'hidden', // agents control in the command center
  'chat.agentSessions.showExternal': 'none', // external/cloud agent session rows
  'chat.agent.enabled': false, // core agent chat mode (canvas replaces it)
  'chat.viewSessions.enabled': false, // the side “Agent Sessions / Build with Agent” window
  'chat.editor.localAgent.enabled': false, // no local-agent chat editor
  'chat.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden', // right bar stays closed
  'chat.agentSessionProjection.enabled': false,
  'agents.voice.enabled': false,
  'agents.voice.showButton': false,
};

const settingsPath = join(root, '.vscode', '.devdata', 'User', 'settings.json');

function main() {
  mkdirSync(dirname(settingsPath), { recursive: true });

  let merged = {};
  if (existsSync(settingsPath)) {
    try {
      merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      merged = {};
    }
  }
  Object.assign(merged, CHROME_DEFAULTS);
  // Prune keys we no longer manage (e.g. workbench.activityBar.visible was
  // removed from VS Code and writing it throws — the toggle command handles
  // the activity bar now). Unknown stale keys are otherwise ignored, but keep
  // the profile clean.
  for (const stale of ['workbench.activityBar.visible']) {
    delete merged[stale];
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`[seed-profile] wrote ${settingsPath}`);
  console.log(`[seed-profile] ${Object.keys(CHROME_DEFAULTS).length} chrome keys ensured`);
}

main();
