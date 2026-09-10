import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { CanvasPanel } from './canvasPanel';
import { SessionsTreeProvider, type SessionSummary } from './sessionsView';

/**
 * pi-agent-canvas.
 *
 * The extension NEVER reads or writes any VS Code chrome/window setting (menu
 * bar, title bar, activity bar, status bar, tabs, sidebars — none of it) and
 * never opens anything the user did not ask for, with two deliberate
 * exceptions:
 *
 *   - it contributes ONE activity-bar container and one view (Sessions, the
 *     tile list) on purpose — that is the agent button;
 *   - in the ISOLATED development harness (F5 "CANVAS" launch / `npm run
 *     canvas`, flagged by VSCODE_EXTENSION_ISOLATED=1 and a throwaway profile)
 *     a canvas auto-opens so the dev window is ready to use.
 *
 * In the user's real VS Code the extension does:
 *   - provide `piAgentCanvas.open` (Ctrl/Cmd+Alt+C) plus the Sessions view
 *   - show a canvas only when the user asks for one
 *   - set `chat.disableAIFeatures: true` (once, idempotent): this canvas
 *     replaces the built-in AI/chat UI, so the built-in AI/chat and Copilot
 *     extensions are switched off by design.
 */

const ISOLATED = process.env.VSCODE_EXTENSION_ISOLATED === '1';
const CHAT_KILL_KEY = 'chat.disableAIFeatures';

/**
 * This window's canvas server endpoint. Each VS Code window gets its own port
 * so two windows never share (or silently steal) one agent — a fixed port meant
 * the second window attached to the first window's server, pointed at the wrong
 * workspace.
 */
let PI_PORT = '47811';
let extensionUri: vscode.Uri;
let sessionsProvider: SessionsTreeProvider | undefined;

const wsUrl = () => `ws://127.0.0.1:${PI_PORT}`;

export async function activate(context: vscode.ExtensionContext): Promise<PiCanvasApi> {
  extensionUri = context.extensionUri;
  void disableAiFeatures();

  PI_PORT = process.env.PI_CANVAS_PORT ?? String(await freePort());
  startPiServer();

  // The agent button: the session list in the activity bar. It reads from the
  // server over HTTP rather than through the pi SDK (ESM-only, ~850ms to load,
  // no `require` export — not a cost activation should pay).
  const sessions = new SessionsTreeProvider(() => fetchSessions());
  sessionsProvider = sessions;
  context.subscriptions.push(
    vscode.window.createTreeView('piAgentCanvas.sessions', { treeDataProvider: sessions }),
  );

  // A panel only learns its conversation once the server has created it: name
  // the tab after it (so tiles are tellable apart) and refresh the list.
  context.subscriptions.push(
    CanvasPanel.onDidBindSession((panel) => {
      void namePanel(panel);
      sessionsProvider?.refreshSoon();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('piAgentCanvas.open', () => openCanvas()),
    vscode.commands.registerCommand('piAgentCanvas.newSession', async () => {
      await CanvasPanel.open(extensionUri, wsUrl(), { mode: 'new' });
      sessions.refreshSoon();
    }),
    vscode.commands.registerCommand('piAgentCanvas.openSession', (sessionId: string) => openSession(sessionId)),
    vscode.commands.registerCommand('piAgentCanvas.refreshSessions', () => sessions.refresh()),
  );

  // The server needs a few seconds to boot (model runtime + session index), so
  // poll the sidebar's data source instead of surfacing a startup error row.
  void pollServerReady(sessions);

  // Auto-open ONLY in the isolated dev harness. In the user's real VS Code the
  // canvas stays opt-in (Ctrl/Cmd+Alt+C, the Sessions view, or the palette).
  // With '*' activation the workbench may not be ready to create webviews yet,
  // so retry a few times before giving up.
  if (ISOLATED && vscode.window.activeTextEditor === undefined) {
    void (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await vscode.commands.executeCommand('piAgentCanvas.open');
          if (CanvasPanel.all().length) return;
        } catch (err) {
          console.warn(`[pi-agent-canvas] auto-open attempt ${attempt + 1} failed:`, err);
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    })();
    void closeChatSurfaces();
  }

  return {
    port: PI_PORT,
    wsUrl: wsUrl(),
    sessions: fetchSessions,
    openSession,
    openCanvas,
  };
}

// ---------------------------------------------------------------------------
// What "open the canvas" means
// ---------------------------------------------------------------------------
/**
 * Show the canvas the user means by "my agent": the one they are looking at,
 * else the one holding the most recent conversation, else the most recent
 * conversation, else a brand new one. Idempotent by construction — it can never
 * leave two tabs showing the same session, and it will not spawn a fresh
 * conversation just because a panel was closed.
 */
async function openCanvas(): Promise<void> {
  const active = CanvasPanel.active();
  if (active) {
    active.reveal();
    return;
  }
  // The server may still be booting (right after window start). Wait briefly for
  // the workspace's history rather than opening an unbound panel: a panel that
  // doesn't know its session yet can end up as a second view of one that opens
  // a moment later.
  await waitForServer(8000);
  const mostRecent = await mostRecentSession();
  await CanvasPanel.open(extensionUri, wsUrl(), {
    sessionId: mostRecent?.id,
    title: mostRecent ? titleFor(mostRecent) : undefined,
    mode: mostRecent ? undefined : 'continue',
  });
  sessionsProvider?.refreshSoon();
}

/** Open one specific conversation (a row in the Sessions view). */
async function openSession(sessionId: string): Promise<void> {
  const summary = await fetchSessions()
    .then((all) => all.find((s) => s.id === sessionId))
    .catch(() => undefined);
  await CanvasPanel.open(extensionUri, wsUrl(), {
    sessionId,
    title: summary ? titleFor(summary) : undefined,
  });
  sessionsProvider?.refreshSoon();
}

/** Title a panel's tab after the conversation it turned out to own. */
async function namePanel(panel: CanvasPanel): Promise<void> {
  const sessionId = panel.getSessionId();
  if (!sessionId) return;
  const summary = await fetchSessions()
    .then((all) => all.find((s) => s.id === sessionId))
    .catch(() => undefined);
  if (summary) panel.setTitle(titleFor(summary));
}

async function mostRecentSession(): Promise<SessionSummary | undefined> {
  const sessions = await fetchSessions().catch(() => [] as SessionSummary[]);
  return sessions.slice().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).at(0);
}

/**
 * A tab is named after its conversation, so tiles can be told apart — including
 * empty ones, which fall back to the session's short id. Two brand new sessions
 * must not both read "Agent Canvas".
 */
function titleFor(session: SessionSummary): string {
  const label =
    session.name?.trim() ||
    session.firstMessage?.replace(/\s+/g, ' ').trim() ||
    `new · ${session.id.slice(0, 8)}`;
  return `Agent Canvas — ${label.length > 32 ? `${label.slice(0, 32)}…` : label}`;
}

// ---------------------------------------------------------------------------
// Server plumbing
// ---------------------------------------------------------------------------
let serverProc: ReturnType<typeof spawn> | undefined;

/** An ephemeral localhost port; the window is bound to it for its lifetime. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * pi-canvas-server: plain-Node process owning the pi AgentSessions, spoken to
 * by the webviews over ws://127.0.0.1:<port>. Runs OUTSIDE the extension host
 * because VS Code patches fetch/http there and SSE streaming stalls. Spawned
 * detached (own session) so it survives window reloads.
 */
function startPiServer(): void {
  if (serverProc) return;
  const serverPath = join(__dirname, '..', 'scripts', 'pi-server.mjs');
  if (!existsSync(serverPath)) return;
  // The agent works in the user's open project, not the extension folder.
  // Note: PI_CANVAS_SESSION_DIR / PI_CANVAS_NEW_SESSION are inherited from this
  // process's environment (see scripts/pi-server.mjs); sessions otherwise live
  // in pi's own session directory, so the canvas and `pi --continue` agree.
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const child = spawn('node', [serverPath], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      PI_CANVAS_PORT: PI_PORT,
      ...(workspaceCwd ? { PI_CANVAS_CWD: workspaceCwd } : {}),
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  serverProc = child;
  child.on('error', () => { serverProc = undefined; });
}

/** Wait for the server to answer, up to `timeoutMs`. True if it did. */
async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetchSessions();
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function pollServerReady(sessions: SessionsTreeProvider): Promise<void> {
  await waitForServer(15_000);
  sessions.refresh(); // on failure the view shows why
}

/** Session listing lives in the server (see sessionsView.ts for why). */
function fetchSessions(): Promise<SessionSummary[]> {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: '127.0.0.1', port: Number(PI_PORT), path: '/sessions', timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`sessions endpoint returned ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve((JSON.parse(body) as { sessions?: SessionSummary[] }).sessions ?? []);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('session listing timed out')));
    request.on('error', reject);
  });
}

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

/**
 * Isolated dev window only: make the canvas the sole content. Sets
 * chat.disableAIFeatures (the official kill switch for built-in AI/chat and the
 * Copilot extensions) and closes the auxiliary + bottom panels. All of this is
 * scoped to this window's throwaway profile — the user's real VS Code is never
 * affected. The sidebar (including the Sessions view) stays.
 */
async function closeChatSurfaces(): Promise<void> {
  try {
    await vscode.workspace
      .getConfiguration()
      .update(CHAT_KILL_KEY, true, vscode.ConfigurationTarget.Global);
  } catch (err) {
    console.warn(`[pi-agent-canvas] ${CHAT_KILL_KEY} update failed:`, err);
  }

  for (const command of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
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
  serverProc?.kill();
}

/**
 * Activation exports: what this window is bound to. Read by the integration
 * tests (`vscode.extensions.getExtension(...).exports`) so they can talk to this
 * window's server without guessing the ephemeral port.
 */
export interface PiCanvasApi {
  port: string;
  wsUrl: string;
  sessions(): Promise<SessionSummary[]>;
  openSession(sessionId: string): Promise<void>;
  openCanvas(): Promise<void>;
}
