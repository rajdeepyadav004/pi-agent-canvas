import * as vscode from 'vscode';
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
 * In every other window — the user's real VS Code — the only things this
 * extension does are:
 *   - provide the `piAgentCanvas.open` command (Ctrl/Cmd+Alt+C)
 *   - show the canvas when the user explicitly asks for it
 */

const ISOLATED = process.env.VSCODE_EXTENSION_ISOLATED === '1';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

export function deactivate(): void {
  /* no-op */
}
