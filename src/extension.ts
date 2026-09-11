import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { get } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CanvasPanel } from './canvasPanel';
import { initLog, log, pipeToLog, recentLogs, showLog } from './log';
import { explainError } from './shared/explain';
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
/** Opt-in. Off means we write nothing at all. */
const AI_SETTING = 'piCanvas.disableBuiltInAi';
/** How the agent is launched, and where it runs. */
const AGENT_COMMAND_SETTING = 'piCanvas.agentCommand';
const AGENT_CWD_SETTING = 'piCanvas.agentCwd';
/** globalState marker: did WE turn chat.disableAIFeatures on? */
const AI_OWNED_KEY = 'piCanvas.ownsAiFeaturesSetting';

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
  context.subscriptions.push(initLog());
  void applyAiPreference(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(AI_SETTING)) void applyAiPreference(context);
      // Both settings describe how to LAUNCH the agent, so the running server is
      // stale the moment they change. Restart it on the same port: the canvases
      // reconnect themselves.
      if (event.affectsConfiguration(AGENT_COMMAND_SETTING) || event.affectsConfiguration(AGENT_CWD_SETTING)) {
        log('launch settings changed — restarting the agent server');
        restartPiServer();
        sessions.refreshSoon(1500);
      }
    }),
  );

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
    // The support path for "the agent isn't replying": run the same server the
    // canvas runs, in a terminal, and print a verdict. Works without the UI.
    vscode.commands.registerCommand('piAgentCanvas.diagnostics', () => {
      const directory = join(__dirname, '..');
      const script = join(directory, 'scripts', 'diagnose.mjs');
      log('running diagnostics in a terminal');
      const terminal = vscode.window.createTerminal({ name: 'Pi Agent Canvas Diagnostics', cwd: directory });
      terminal.show();
      terminal.sendText(`node "${script}"`);
    }),
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
    recentLogs,
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

/**
 * Open one specific conversation (a row in the Sessions view).
 *
 * A row can be stale — the session file may have been deleted or moved on
 * another machine — and opening a panel for it would park the canvas on
 * "Connecting to pi…" forever, because the server can never hand back that
 * session. Say so and refresh the list instead.
 */
async function openSession(sessionId: string): Promise<void> {
  const summary = await fetchSessions()
    .then((all) => all.find((s) => s.id === sessionId))
    .catch(() => undefined);
  if (!summary) {
    sessionsProvider?.refresh();
    void vscode.window.showWarningMessage(
      `Pi Agent Canvas: that conversation is no longer on disk (session ${sessionId.slice(0, 8)}). The list has been refreshed.`,
    );
    return;
  }
  await CanvasPanel.open(extensionUri, wsUrl(), { sessionId, title: titleFor(summary) });
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
function expandPath(value: string): string {
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? expanded : join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(), expanded);
}

/**
 * What a settings value actually looks like on disk.
 *
 * The two launch settings are easy to swap — `agentCwd` and `agentCommand` read
 * alike — and the failure that produced was `spawn /bin/sh ENOENT` with the real
 * cause (a cwd that does not exist) buried a line above. Classifying the values
 * lets us say "that looks like the other setting" instead.
 */
function classify(value: string): 'directory' | 'file' | 'command' | 'unknown' {
  const path = expandPath(value);
  if (existsSync(path)) {
    try {
      return statSync(path).isDirectory() ? 'directory' : 'file';
    } catch { /* fall through */ }
  }
  // Not something that exists: shell syntax means it is meant as a command.
  return /[;&|$'"`()]|\s/.test(value) ? 'command' : 'unknown';
}

interface Launch {
  /** undefined = the built-in launch. */
  command?: string;
  /** undefined = the extension folder. */
  cwd?: string;
  problems: string[];
}

/** Resolve both launch settings, refusing anything that cannot work. */
function resolveLaunch(): Launch {
  const config = vscode.workspace.getConfiguration();
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rawCwd = (config.get<string>(AGENT_CWD_SETTING) ?? '').trim();
  const rawCommand = (config.get<string>(AGENT_COMMAND_SETTING) ?? '').trim();
  const problems: string[] = [];

  let cwd = workspaceCwd;
  if (rawCwd) {
    const kind = classify(rawCwd);
    if (kind === 'directory') {
      cwd = expandPath(rawCwd);
    } else if (kind === 'command') {
      problems.push(`${AGENT_CWD_SETTING} looks like a shell command, not a directory: "${rawCwd}" — did you mean ${AGENT_COMMAND_SETTING}?`);
    } else {
      problems.push(`${AGENT_CWD_SETTING} is not an existing directory: "${rawCwd}"`);
    }
  }

  let command: string | undefined;
  if (rawCommand) {
    const kind = classify(rawCommand);
    if (kind === 'directory') {
      problems.push(`${AGENT_COMMAND_SETTING} is a directory, not a command: "${rawCommand}" — did you mean ${AGENT_CWD_SETTING}?`);
    } else {
      command = rawCommand;
    }
  }

  return { command, cwd, problems };
}

let restartTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Kill the running server so the next start uses current settings. Debounced:
 * changing two launch settings in a row must not start two servers onto the same
 * port.
 */
function restartPiServer(): void {
  const running = serverProc;
  serverProc = undefined;
  running?.kill();
  if (restartTimer) clearTimeout(restartTimer);
  // Give the port back before the replacement tries to bind it.
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    startPiServer();
  }, 600);
}

function startPiServer(): void {
  if (serverProc) return;
  const serverPath = join(__dirname, '..', 'scripts', 'pi-server.mjs');
  if (!existsSync(serverPath)) return;
  // The agent works in the user's project (or wherever they pointed it), not in
  // the extension folder. Note: PI_CANVAS_SESSION_DIR / PI_CANVAS_NEW_SESSION are
  // inherited from this process's environment (see scripts/pi-server.mjs);
  // sessions otherwise live in pi's own session directory, so the canvas and
  // `pi --continue` agree.
  const launch = resolveLaunch();
  const workspaceCwd = launch.cwd;
  for (const problem of launch.problems) log(`launch setting problem: ${problem}`);
  if (launch.problems.length) {
    void vscode.window
      .showWarningMessage(`Pi Agent Canvas: ${launch.problems.join(' ')}`, 'Show Log')
      .then((choice) => { if (choice === 'Show Log') showLog(); });
  }

  const env = {
    ...process.env,
    PI_CANVAS_PORT: PI_PORT,
    // Handed to a custom command so a wrapper can exec the bundled server
    // without having to know where the extension is installed.
    PI_CANVAS_SERVER: serverPath,
    PI_CANVAS_EXTENSION: join(__dirname, '..'),
    ...(workspaceCwd ? { PI_CANVAS_CWD: workspaceCwd } : {}),
  };

  const custom = launch.command;
  // Log the decision explicitly: when a launch fails, which command ran in which
  // directory is the first thing worth knowing.
  log(
    custom
      ? `starting agent server with ${AGENT_COMMAND_SETTING}: ${custom}`
      : `starting agent server: node ${serverPath}${launch.problems.length ? ' (built-in launch, because the configured one is unusable)' : ''}`,
  );
  log(`  port ${PI_PORT} · cwd ${workspaceCwd ?? '(none — the extension folder)'} · node ${process.version}`);
  log(`  PATH ${process.env.PATH ?? '(unset)'}`);
  // A child process inherits VS Code's proxy environment, so an unreachable
  // provider often shows up here and nowhere else.
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy']) {
    if (process.env[key]) log(`  ${key}=${process.env[key]}`);
  }

  const child = custom
    // Through the shell, from the agent's directory: that is what makes "a login
    // shell / a specific node / a wrapper that exports credentials" possible.
    ? spawn(custom, {
        // `workspaceCwd` is already validated by resolveLaunch; a missing
        // directory here would surface as 'spawn /bin/sh ENOENT'.
        cwd: workspaceCwd ?? join(__dirname, '..'),
        env,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn('node', [serverPath], {
        cwd: join(__dirname, '..'),
        env,
        detached: true,
        // Piped, not ignored: without this the server's errors are invisible and
        // "the agent isn't replying" has no explanation anywhere.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  child.unref();
  serverProc = child;
  pipeToLog(child.stdout, '[server]');
  pipeToLog(child.stderr, '[server]');

  // A failed spawn is otherwise silent: on macOS a Dock-launched VS Code often
  // has no nvm/Homebrew PATH, so `node` simply isn't there.
  child.on('error', (err) => {
    serverProc = undefined;
    log(`agent server could not start: ${err.message}`);
    void vscode.window
      .showErrorMessage(`Pi Agent Canvas: ${explainError(String(err.message))}`, 'Show Log')
      .then((choice) => { if (choice === 'Show Log') showLog(); });
  });
  child.on('exit', (code, signal) => {
    if (serverProc === child) serverProc = undefined;
    if (code !== 0 && code !== null) log(`agent server exited with code ${code}${signal ? ` (${signal})` : ''}`);
  });
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

/**
 * Honour `piCanvas.disableBuiltInAi` — the ONLY setting this extension ever
 * writes, and only when the user asks for it.
 *
 * Turning it off restores `chat.disableAIFeatures` only if we were the ones who
 * set it (tracked in globalState). Leaving someone's Copilot chat disabled after
 * they unticked our box would be a bug; flipping back a setting they had already
 * chosen themselves would be a different one.
 */
async function applyAiPreference(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const wanted = config.get<boolean>(AI_SETTING) === true;
  const current = config.get<boolean>(CHAT_KILL_KEY) === true;
  const ownedByUs = context.globalState.get<boolean>(AI_OWNED_KEY) === true;

  try {
    if (wanted && !current) {
      await config.update(CHAT_KILL_KEY, true, vscode.ConfigurationTarget.Global);
      await context.globalState.update(AI_OWNED_KEY, true);
    } else if (!wanted && current && ownedByUs) {
      await config.update(CHAT_KILL_KEY, false, vscode.ConfigurationTarget.Global);
      await context.globalState.update(AI_OWNED_KEY, false);
    }
  } catch (err) {
    console.warn(`[pi-agent-canvas] could not apply ${AI_SETTING}:`, err);
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
  /** Recent log lines, including the agent server's own stdout/stderr. */
  recentLogs(): string[];
}
