import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Canvas panels — one conversation per editor panel, so sessions arrange like
 * files: several open at once, split, dragged, restored.
 *
 * Panels are registered by session id, which makes "open" idempotent: asking
 * for a session that already has a panel REVEALS it instead of opening a second
 * view onto the same conversation (the server would join them anyway, but two
 * panels holding one thread is a confusing UI).
 *
 * Each panel injects its session id into the webview, so a panel knows which
 * conversation it owns from the moment it connects.
 */
export interface OpenCanvasOptions {
  /** Session to open. Omitted = use `mode`. */
  sessionId?: string;
  /**
   * What to do without an explicit id: 'continue' picks up the most recent
   * conversation for this workspace, 'new' starts a fresh one. Defaults to
   * 'continue' — silently starting a new conversation is never the safe bet.
   */
  mode?: 'new' | 'continue';
  column?: vscode.ViewColumn;
  /** Pre-filled before the webview reports the session's real title. */
  title?: string;
}

const VIEW_TYPE = 'piAgentCanvas.canvas';
const DEFAULT_TITLE = 'Agent Canvas';

export class CanvasPanel {
  private static readonly panels = new Map<string, CanvasPanel>();
  private static pendingKey = 0;
  private static readonly bindEmitter = new vscode.EventEmitter<CanvasPanel>();

  /**
   * Fires when a panel learns which conversation it owns. A brand new session's
   * id only exists once the server has created it, so the host cannot name the
   * tab (or refresh the session list) until this happens.
   */
  public static readonly onDidBindSession = CanvasPanel.bindEmitter.event;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly wsUrl: string;
  private disposables: vscode.Disposable[] = [];
  /** Registry key: a session id, or `pending:<n>` until the webview reports one. */
  private key: string;
  private sessionId?: string;
  private readonly mode: 'new' | 'continue';

  /**
   * Open (or reveal) a canvas. The single entry point for every way a
   * conversation can be started: the keybinding, the sidebar, a session row.
   */
  public static async open(
    extensionUri: vscode.Uri,
    wsUrl: string,
    options: OpenCanvasOptions = {},
  ): Promise<CanvasPanel> {
    const column = options.column ?? vscode.ViewColumn.Active;

    if (options.sessionId) {
      const existing = CanvasPanel.panels.get(options.sessionId);
      if (existing) {
        existing.panel.reveal(column);
        return existing;
      }
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, options.title || DEFAULT_TITLE, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Only the media/ folder is reachable from inside the webview.
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist')],
    });

    const instance = new CanvasPanel(panel, extensionUri, wsUrl, options.sessionId, options.mode ?? 'continue');
    await instance.setHtml();

    panel.onDidDispose(() => instance.dispose(), undefined, instance.disposables);
    panel.webview.onDidReceiveMessage((msg) => void instance.handleMessage(msg), undefined, instance.disposables);
    return instance;
  }

  /** Every open canvas panel, for commands that need to reason over them. */
  public static all(): CanvasPanel[] {
    return [...new Set(CanvasPanel.panels.values())];
  }

  /** The panel the user is looking at, if any. */
  public static active(): CanvasPanel | undefined {
    return CanvasPanel.all().find((p) => p.panel.active);
  }

  public static isOpen(sessionId: string): boolean {
    return CanvasPanel.panels.has(sessionId);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    wsUrl: string,
    sessionId: string | undefined,
    mode: 'new' | 'continue',
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.wsUrl = wsUrl;
    this.mode = mode;
    this.key = sessionId ?? `pending:${++CanvasPanel.pendingKey}`;
    this.sessionId = sessionId;
    CanvasPanel.panels.set(this.key, this);
  }

  /**
   * Bind this panel to the session the server actually gave it (a new
   * conversation's id isn't known until the server creates it), then move it to
   * its real registry key so a later "open this session" reveals this panel.
   */
  public bindSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    // Two tabs must never end up owning one conversation: if another panel
    // already has this session, this one is a duplicate — close it and let the
    // canonical panel take over.
    const existing = CanvasPanel.panels.get(sessionId);
    if (existing && existing !== this) {
      existing.reveal();
      this.dispose();
      return;
    }
    if (CanvasPanel.panels.get(this.key) === this) CanvasPanel.panels.delete(this.key);
    this.sessionId = sessionId;
    this.key = sessionId;
    CanvasPanel.panels.set(sessionId, this);
    CanvasPanel.bindEmitter.fire(this);
  }

  public setTitle(title: string): void {
    if (title) this.panel.title = title;
  }

  /** Bring this canvas to the front (optionally in a specific group). */
  public reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column ?? vscode.ViewColumn.Active);
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
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

    // replaceAll: these placeholders appear on multiple lines, and a missed one
    // is silently wrong (a missed nonce is CSP-blocked).
    return html
      .replaceAll('__CSP__', csp)
      .replaceAll('__SCRIPT_URI__', scriptUri.toString())
      .replaceAll('__WS_URL__', JSON.stringify(this.wsUrl))
      .replaceAll('__SESSION_ID__', JSON.stringify(this.sessionId ?? ''))
      .replaceAll('__SESSION_MODE__', JSON.stringify(this.mode))
      .replaceAll('__NONCE__', nonce);
  }

  /**
   * Extension host ⇄ webview bridge. Messages come from media/index.js.
   * This switch grows as the real canvas features land.
   */
  private async handleMessage(msg: unknown): Promise<void> {
    const message = msg as { type?: string; [k: string]: unknown };
    switch (message.type) {
      case 'openFile': {
        await openInEditor(message.path, message.line);
        break;
      }
      case 'sessionOpened': {
        // First news of a new conversation's id: re-key so the sidebar's
        // "open session" now reveals this panel, and label the tab after it.
        if (typeof message.sessionId === 'string') this.bindSession(message.sessionId);
        break;
      }
      case 'ping': {
        this.post({
          type: 'pong',
          payload: {
            received: message.payload ?? null,
            host: process.version,
            isolated: process.env.VSCODE_EXTENSION_ISOLATED === '1',
            sessionId: this.sessionId ?? null,
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
    if (CanvasPanel.panels.get(this.key) === this) CanvasPanel.panels.delete(this.key);
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/**
 * Open a file the agent touched, in the editor area.
 *
 * The policy, deliberately: if the file is already visible in some group, focus
 * that group; otherwise open it in the ACTIVE group as a preview tab. Pane count
 * therefore never grows on its own — splitting stays a deliberate user action
 * (drag the tab), which is what keeps "lots of panes" from happening by
 * accident.
 */
async function openInEditor(filePath: unknown, line: unknown): Promise<void> {
  if (typeof filePath !== 'string' || !filePath) return;
  const uri = resolveUri(filePath);
  if (!uri) {
    void vscode.window.showWarningMessage(`pi-agent-canvas: cannot resolve ${filePath}`);
    return;
  }

  const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: false };

  // Already visible somewhere? Focus that group instead of opening a duplicate.
  const visible = vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()),
  );
  if (visible) options.viewColumn = visible.viewColumn;

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, options);
    if (typeof line === 'number' && line > 0) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`pi-agent-canvas: cannot open ${filePath} — ${String(err)}`);
  }
}

/** Absolute paths and URIs pass through; relative paths resolve to the workspace. */
function resolveUri(filePath: string): vscode.Uri | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return vscode.Uri.parse(filePath);
  if (isAbsolute(filePath)) return vscode.Uri.file(filePath);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, filePath) : undefined;
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
