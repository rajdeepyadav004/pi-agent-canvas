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
  }
}

export function deactivate(): void {
  /* no-op */
}
