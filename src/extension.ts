import * as vscode from 'vscode';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CanvasPanel } from './canvasPanel';

/**
 * pi-agent-canvas — canvas window chrome.
 *
 * Chrome stripping happens on THREE redundant layers so the CANVAS window
 * (isolated profile) comes up stripped even if one layer fails:
 *
 *  1. PRE-SEED (deterministic, best): scripts/seed-profile.mjs writes these
 *     keys to <profile>/User/settings.json BEFORE the window launches
 *     (preLaunchTask in .vscode/launch.json). App-scope settings are read at
 *     startup, so the first paint is already clean.
 *
 *  2. RUNTIME FALLBACK (this file): on activation in the isolated window we
 *     re-assert the same keys with ConfigurationTarget.Global and then run
 *     the DETERMINISTIC close commands (workbench.action.closeSidebar /
 *     closePanel — safe no-ops when already closed).
 *
 *  3. DIAGNOSTIC: startup-diag.json records what the extension host actually
 *     reads, so we can verify settings are honored instead of guessing.
 *
 * The F5 debug launch passes --user-data-dir/--extensions-dir in the args
 * array (see .vscode/launch.json "CANVAS (isolated, default)"); the standalone
 * `npm run canvas` (scripts/run-canvas.mjs) uses the exact same profile.
 */

const ISOLATED = process.env.VSCODE_EXTENSION_ISOLATED === '1';

/** Keep in sync with scripts/seed-profile.mjs. */
const CHROME_DEFAULTS: Record<string, unknown> = {
  // Window frame
  'window.menuBarVisibility': 'hidden',
  'window.titleBarStyle': 'native', // OS title bar only — no custom title-bar row
  'window.commandCenter': false,
  // NOTE: workbench.activityBar.visible was REMOVED in modern VS Code (1.1xx)
  // — writing it throws. The activity bar is hidden once at activation via
  // the workbench.action.toggleActivityBarVisibility command (see below).
  'workbench.layoutControl.enabled': false, // title-bar layout/chat icon cluster
  'workbench.statusBar.visible': false,
  'workbench.activityBar.location': 'hidden', // valid enum value in 1.136
  'workbench.editor.showTabs': 'none',
  'workbench.startupEditor': 'none',
  // Core agent/chat chrome (verified against VS Code 1.136.1)
  'chat.titleBar.openInAgentsWindow.enabled': false,
  'chat.titleBar.signIn.enabled': false,
  'chat.agentsControl.enabled': 'hidden',
  'chat.agentSessions.showExternal': 'none',
  'chat.agent.enabled': false,
  // The side “Agent Sessions / Build with Agent” window:
  'chat.viewSessions.enabled': false, // kills the side-by-side sessions view
  'chat.editor.localAgent.enabled': false, // no local-agent chat editor
  'chat.tips.enabled': false,
  // Right-hand sidebar must not auto-open (chat etc. live there):
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.agentSessionProjection.enabled': false,
  'agents.voice.enabled': false,
  'agents.voice.showButton': false,
};

/** Values that restore a normal window (used by the exit-kiosk command). */
const CHROME_RESTORE: Record<string, unknown> = {
  'window.titleBarStyle': 'custom',
  'window.layoutControl.enabled': true,
  'window.menuBarVisibility': 'classic',
  'window.commandCenter': true,
  'workbench.statusBar.visible': true,
  'workbench.editor.showTabs': 'multiple',
  'chat.titleBar.openInAgentsWindow.enabled': true,
  'chat.titleBar.signIn.enabled': true,
  'chat.agentsControl.enabled': 'compact',
  'chat.agentSessions.showExternal': 'recent',
  'chat.agent.enabled': true,
  'chat.viewSessions.enabled': true,
  'chat.editor.localAgent.enabled': true,
  'chat.tips.enabled': true,
  'workbench.secondarySideBar.defaultVisibility': 'visibleInWorkspace',
  'agents.voice.enabled': false,
  'agents.voice.showButton': false,
};

/** Deterministic closes (safe no-ops when the target is already closed). */
const CLOSE_COMMANDS = [
  'workbench.action.closeSidebar',
  'workbench.action.closePanel',
  'workbench.action.closeAuxiliaryBar', // right-hand Chat pane
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand('piAgentCanvas.open', () => {
      CanvasPanel.createOrShow(context.extensionUri);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('piAgentCanvas.toggleMinimalChrome', () => {
      if (!ISOLATED) {
        void vscode.window.showWarningMessage(
          'pi-agent-canvas: chrome changes are restricted to the isolated canvas profile — your normal VS Code window is never modified.',
        );
        return;
      }
      return runRuntimeChromeToggles();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('piAgentCanvas.restoreChrome', () => restoreChrome()),
  );

  // Re-open the canvas if it was the last visible tab when VS Code restarts.
  // ISOLATED-only: never auto-open tabs in the user's real VS Code windows.
  // With '*' activation the workbench may not be ready to create webviews
  // yet, so retry a few times before giving up.
  if (ISOLATED && vscode.window.activeTextEditor === undefined) {
    void (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await vscode.commands.executeCommand('piAgentCanvas.open');
          if (CanvasPanel.currentPanel) return;
        } catch (err) {
          console.warn(`[pi-agent-canvas] auto-open attempt ${attempt + 1} failed:`, err);
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    })();
  }

  if (ISOLATED) {
    const cfg = vscode.workspace.getConfiguration('piAgentCanvas');
    if (cfg.get<boolean>('focusChromeOnActivate', true)) {
      void applyChromeKiosk(context);
    }
  }
}

async function applyChromeKiosk(context: vscode.ExtensionContext): Promise<void> {
  const read = () => readChromeValues();
  const before = read();
  let changedKeys: string[] = [];
  try {
    const config = vscode.workspace.getConfiguration();
    const retry: Array<[string, unknown]> = [];
    for (const [key, value] of Object.entries(CHROME_DEFAULTS)) {
      if (config.get(key) === value) continue;
      try {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
        changedKeys.push(key);
      } catch (err) {
        // Some keys are not registered yet during very early ('*') activation
        // (e.g. workbench.secondarySideBar.visible). Never abort the loop —
        // note the key and give it a second chance after startup settles.
        console.warn(`[pi-agent-canvas] deferred chrome key ${key}:`, String(err).slice(0, 120));
        retry.push([key, value]);
      }
    }
    if (retry.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (const [key, value] of retry) {
        try {
          if (config.get(key) !== value) {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
            changedKeys.push(`${key} (retry)`);
          }
        } catch (err) {
          console.warn(`[pi-agent-canvas] chrome key ${key} failed after retry:`, String(err).slice(0, 120));
        }
      }
    }
  } catch (err) {
    console.warn('[pi-agent-canvas] chrome config update failed:', err);
  }

  // Activity bar: enforce hidden every launch. Read the live context key
  // first so we never accidentally re-show an already hidden bar.
  let activityBarAction = 'already-hidden';
  try {
    const hidden = await vscode.commands.executeCommand(
      'getContextKeyValue',
      'activityBar.hidden',
    );
    if (!hidden) {
      await vscode.commands.executeCommand('workbench.action.toggleActivityBarVisibility');
      activityBarAction = 'toggled-hidden';
    }
  } catch (err) {
    activityBarAction = `failed: ${String(err).slice(0, 80)}`;
    console.warn('[pi-agent-canvas] activity bar hide failed:', err);
  }

  // Deterministic closes — no-ops when already closed, so safe every launch.
  const closes: string[] = [];
  for (const command of CLOSE_COMMANDS) {
    try {
      await vscode.commands.executeCommand(command);
      closes.push(command);
    } catch (err) {
      console.warn(`[pi-agent-canvas] close command failed: ${command}`, err);
    }
  }

  // Wait a moment, then write ground-truth diagnostics so we can verify the
  // settings are actually honored (read them back through the same API the
  // UI layer uses).
  setTimeout(() => {
    writeDiagnostics(context, { before, after: read(), changedKeys, closes, activityBarAction });
  }, 1500);
}

function readChromeValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(CHROME_DEFAULTS)) {
    out[key] = vscode.workspace.getConfiguration().get(key);
  }
  return out;
}

function writeDiagnostics(
  context: vscode.ExtensionContext,
  data: { before: Record<string, unknown>; after: Record<string, unknown>; changedKeys: string[]; closes: string[]; activityBarAction: string },
): void {
  try {
    const dir = join(context.extensionUri.fsPath, '.vscode', '.devdata');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'startup-diag.json'),
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          pid: process.pid,
          isolated: ISOLATED,
          effective: data.after,
          changedKeys: data.changedKeys,
          closeCommands: data.closes,
          activityBarAction: data.activityBarAction,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (err) {
    console.warn('[pi-agent-canvas] failed to write diagnostics:', err);
  }
}

async function restoreChrome(): Promise<void> {
  if (!ISOLATED) {
    void vscode.window.showWarningMessage(
      'pi-agent-canvas: chrome restore only applies to the isolated canvas profile (so your real VS Code is never touched).',
    );
    return;
  }
  const config = vscode.workspace.getConfiguration();
  for (const [key, value] of Object.entries(CHROME_RESTORE)) {
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    } catch (err) {
      console.warn(`[pi-agent-canvas] restore failed for ${key}`, err);
    }
  }
  for (const command of ['workbench.action.toggleSidebarVisibility', 'workbench.action.togglePanel']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      /* ignore */
    }
  }
  try {
    await vscode.commands.executeCommand('workbench.action.toggleActivityBarVisibility');
  } catch {
    /* ignore */
  }
  void vscode.window.showInformationMessage('pi-agent-canvas: chrome restored. Reload the window to see full VS Code UI.');
}

async function runRuntimeChromeToggles(): Promise<void> {
  const available = new Set(await vscode.commands.getCommands(true));
  for (const command of ['workbench.action.toggleMenuBar', 'workbench.action.toggleSidebarVisibility']) {
    if (!available.has(command)) continue;
    try {
      await vscode.commands.executeCommand(command);
    } catch (err) {
      console.warn(`[pi-agent-canvas] chrome toggle failed: ${command}`, err);
    }
  }
}

export function deactivate(): void {
  /* no-op for now */
}
