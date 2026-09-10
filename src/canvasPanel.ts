import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Owns the single canvas WebviewPanel (one instance, reused when the command
 * runs again). The webview markup lives in media/index.html; the host only
 * injects the CSP, the script URI, and a per-load nonce, then acts as the
 * message bridge. Everything the webview needs from the extension host will
 * be routed through `handleMessage` — for now it only answers a `ping`.
 */
export class CanvasPanel {
  public static currentPanel: CanvasPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** Endpoint of this window's pi-canvas-server. */
  private readonly wsUrl: string;
  private disposables: vscode.Disposable[] = [];

  public static async createOrShow(extensionUri: vscode.Uri, wsUrl?: string): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (CanvasPanel.currentPanel) {
      CanvasPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'piAgentCanvas.canvas', // identifier — used by the keybinding `when` clause
      'Agent Canvas',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Only the media/ folder is reachable from inside the webview.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    const instance = new CanvasPanel(panel, extensionUri, wsUrl);
    CanvasPanel.currentPanel = instance;
    await instance.setHtml();

    panel.onDidDispose(() => instance.dispose(), undefined, instance.disposables);
    panel.webview.onDidReceiveMessage(
      (msg) => void instance.handleMessage(msg),
      undefined,
      instance.disposables,
    );
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, wsUrl?: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.wsUrl = wsUrl ?? 'ws://127.0.0.1:47811';
  }

  private async setHtml(): Promise<void> {
    const htmlPath = join(this.extensionUri.fsPath, 'media', 'index.html');
    const html = readFileSync(htmlPath, 'utf8');
    this.panel.webview.html = this.inject(html);
  }

  private inject(html: string): string {
    const nonce = getNonce();
    const cspSource = this.panel.webview.cspSource;
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );

    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      `img-src ${cspSource} data:`,
      `font-src ${cspSource}`,
      // pi-canvas-server on localhost — webview WebSockets bypass the ext
      // host's fetch patching entirely (the whole point of the split).
      `connect-src ${this.wsUrl}`,
    ].join('; ');

    // replaceAll: the nonce appears on every script tag, and a missed one is
    // silently CSP-blocked (String.replace only swaps the first match).
    return html
      .replaceAll('__CSP__', csp)
      .replaceAll('__SCRIPT_URI__', scriptUri.toString())
      .replaceAll('__WS_URL__', this.wsUrl)
      .replaceAll('__NONCE__', nonce);
  }

  /**
   * Extension host ⇄ webview bridge. Messages come from media/index.js.
   * This switch grows as the real canvas features land.
   */
  private async handleMessage(msg: unknown): Promise<void> {
    const message = msg as { type?: string; [k: string]: unknown };
    switch (message.type) {
      case 'ping': {
        this.post({
          type: 'pong',
          payload: {
            received: message.payload ?? null,
            host: process.version,
            isolated: process.env.VSCODE_EXTENSION_ISOLATED === '1',
            chrome: readChromeSettings(),
          },
        });
        break;
      }
      default: {
        console.warn('[pi-agent-canvas] unhandled webview message', message);
      }
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  public dispose(): void {
    CanvasPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * Read back the chrome-affecting settings so the canvas can display ground
 * truth about the window it is running in (isolated vs shared profile).
 */
function readChromeSettings(): Record<string, unknown> {
  const keys = [
    'window.menuBarVisibility',
    'chat.titleBar.openInAgentsWindow.enabled',
    'chat.titleBar.signIn.enabled',
    'chat.agentsControl.enabled',
    'chat.agent.enabled',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = vscode.workspace.getConfiguration().get(key);
  }
  return out;
}
