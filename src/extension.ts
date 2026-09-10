import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CanvasPanel } from './canvasPanel';

/**
 * pi-agent-canvas.
 *
 * The extension is a perfect guest: it NEVER reads or writes any VS Code
 * chrome/window settings (menu bar, title bar, activity bar, status bar,
 * tabs, sidebars — none of it), contributes no views or icons, and never
 * opens anything the user did not ask for — with one exception: in the
 * ISOLATED development harness (F5 "CANVAS" launch / `npm run canvas`,
 * flagged by VSCODE_EXTENSION_ISOLATED=1 and a throwaway profile) the canvas
 * auto-opens so the dev window is ready to use.
 *
 * In every other window — the user's real VS Code — the extension does:
 *   - provide the `piAgentCanvas.open` command (Ctrl/Cmd+Alt+C)
 *   - show the canvas when the user explicitly asks for it
 *   - set `chat.disableAIFeatures: true` (once, idempotent): the canvas is
 *     an agent-free surface, so the built-in AI/chat UI and Copilot
 *     extensions are switched off in the user's VS Code by design.
 */

const ISOLATED = process.env.VSCODE_EXTENSION_ISOLATED === '1';

/** Idempotently disable built-in AI/chat in whatever window we run in. */
async function disableAiFeatures(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration();
    if (config.get(CHAT_KILL_KEY) === true) return; // already off — no write
    await config.update(CHAT_KILL_KEY, true, vscode.ConfigurationTarget.Global);
  } catch (err) {
    console.warn(`[pi-agent-canvas] ${CHAT_KILL_KEY} update failed:`, err);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  void disableAiFeatures();
  startPiServer();

  context.subscriptions.push(
    vscode.commands.registerCommand('piAgentCanvas.open', () => {
      CanvasPanel.createOrShow(context.extensionUri);
    }),
  );

  // Auto-open ONLY in the isolated dev harness. In the user's real VS Code
  // the canvas stays opt-in (Ctrl/Cmd+Alt+C or the command palette).
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
    void closeChatSurfaces();
  }
}

/**
 * Isolated dev window only: make the canvas the sole content. Sets
 * chat.disableAIFeatures (the official kill switch for built-in AI/chat and
 * the Copilot extensions) and closes the auxiliary + bottom panels. All of
 * this is scoped to this window's throwaway profile — the user's real VS
 * Code is never affected. The sidebar (files/extensions) stays.
 */
const CHAT_KILL_KEY = 'chat.disableAIFeatures';

async function closeChatSurfaces(): Promise<void> {
  // The official master switch: hides built-in AI/chat UI and disables the
  // Copilot extensions. Scoped to this window's throwaway profile via the
  // Global target (the dev window runs with its own --user-data-dir).
  try {
    await vscode.workspace
      .getConfiguration()
      .update(CHAT_KILL_KEY, true, vscode.ConfigurationTarget.Global);
  } catch (err) {
    console.warn(`[pi-agent-canvas] ${CHAT_KILL_KEY} update failed:`, err);
  }

  for (const command of [
    'workbench.action.closeAuxiliaryBar',
    'workbench.action.closePanel',
  ]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await vscode.commands.executeCommand(command);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

/**
 * pi-canvas-server: plain-Node process owning the pi AgentSession, spoken to
 * by the webview over ws://127.0.0.1:47811. Runs OUTSIDE the extension host
 * because VS Code patches fetch/http there and SSE streaming stalls. Spawned
 * detached (own session) so it survives window reloads.
 */
let serverProc: ReturnType<typeof spawn> | undefined;

function startPiServer(): void {
  if (serverProc) return;
  const serverPath = join(__dirname, '..', 'scripts', 'pi-server.mjs');
  if (!existsSync(serverPath)) return;
  // The agent works in the user's open project, not the extension folder.
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const child = spawn('node', [serverPath], {
    cwd: join(__dirname, '..'),
    env: workspaceCwd ? { ...process.env, PI_CANVAS_CWD: workspaceCwd } : process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  serverProc = child;
  child.on('error', () => { serverProc = undefined; });
}

export function deactivate(): void {
  serverProc?.kill();
}
