/**
 * ISOLATED-mode tests for the agent button: the contributed Sessions view and
 * the panel registry it drives.
 *
 * The invariant under test is the tile rule — a session has AT MOST ONE panel,
 * opening it again reveals that panel, and a new session gets its own.
 *
 * Panel count is restored to the single auto-opened canvas at the end so the
 * suite leaves the window as it found it (smoke.test.js asserts that baseline).
 */
'use strict';
const assert = require('node:assert');
const vscode = require('vscode');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const mode = process.env.CANVAS_TEST_MODE || 'isolated';
const suite = mode === 'isolated' ? describe : describe.skip;

const EXTENSION_ID = 'rajdeepyadav004.pi-agent-canvas';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canvasTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => String((tab.input || {}).viewType || '').includes('piAgentCanvas'));
}

/**
 * Wait until the set of canvas tabs stops changing, so assertions measure a
 * settled window rather than a startup transition.
 */
async function waitForStableTabs(timeoutMs = 20_000) {
  let last = -1;
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = canvasTabs().length;
    stable = count === last ? stable + 1 : 0;
    if (stable >= 3) return count;
    last = count;
    await sleep(500);
  }
  return last;
}

/**
 * Poll until a predicate passes. A throwing predicate means "not ready yet" —
 * the server takes a few seconds to boot, so an early ECONNREFUSED is expected
 * rather than fatal.
 */
async function waitFor(predicate, timeoutMs = 30_000, label = 'condition') {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`);
}

suite('pi-agent-canvas sessions view', function () {
  this.timeout(120_000);

  /** @type {import('../../src/extension').PiCanvasApi} */
  let api;
  let baseline = 0;

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be loaded');
    api = await extension.activate();
    assert.ok(api && typeof api.sessions === 'function', 'activation should export the canvas API');

    // The auto-opened canvas creates a session on the server; wait for it so the
    // list-dependent tests below have something real to work with.
    await waitFor(async () => (await api.sessions()).length > 0, 60_000, 'the auto-opened session to reach disk');
    baseline = canvasTabs().length;
  });

  after(async () => {
    for (const tab of canvasTabs()) await vscode.window.tabGroups.close(tab);
    await api.openCanvas();
  });

  it('contributes the agent button and the Sessions view it opens', async () => {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID).packageJSON;
    const containers = manifest.contributes.viewsContainers?.activitybar ?? [];
    const container = containers.find((c) => c.id === 'piAgentCanvas');
    assert.ok(container, 'an activity-bar container should be contributed');
    assert.strictEqual(container.icon, 'media/robot.svg', 'the agent button uses the robot face');
    assert.strictEqual(container.title, 'Pi Agent');

    const views = manifest.contributes.views?.piAgentCanvas ?? [];
    assert.strictEqual(views.length, 1, 'exactly one view is contributed');
    assert.strictEqual(views[0].id, 'piAgentCanvas.sessions');

    const commands = (manifest.contributes.commands ?? []).map((c) => c.command);
    for (const id of ['piAgentCanvas.open', 'piAgentCanvas.newSession', 'piAgentCanvas.openSession', 'piAgentCanvas.refreshSessions']) {
      assert.ok(commands.includes(id), `${id} should be contributed`);
      assert.ok((await vscode.commands.getCommands(true)).includes(id), `${id} should be registered`);
    }
  });

  it('lists stored sessions with the fields the view renders', async () => {
    const sessions = await api.sessions();
    assert.ok(Array.isArray(sessions), 'sessions() resolves to an array');
    assert.ok(sessions.length >= 1, 'at least the auto-opened session');
    for (const session of sessions) {
      for (const key of ['id', 'modified', 'messageCount', 'firstMessage', 'file', 'open']) {
        assert.ok(key in session, `session.${key} should be present`);
      }
      assert.ok(!Number.isNaN(Date.parse(session.modified)), 'modified should be a timestamp');
    }
  });

  it('opens a session as its own editor tab', async () => {
    const [session] = await api.sessions();
    await api.openSession(session.id);
    await waitFor(() => canvasTabs().length >= 1, 20_000, 'the session panel');
    // A session that was not open adds one tab; one that was open reveals.
    assert.ok(canvasTabs().length >= 1);
  });

  it('reveals rather than duplicating when the same session is opened twice', async () => {
    const [session] = await api.sessions();
    // Startup binding has to settle first: a panel that only learns its session
    // after the server boots can briefly be a duplicate of one that came later,
    // and it closes itself when it finds out (see CanvasPanel.bindSession).
    await waitForStableTabs();

    await api.openSession(session.id);
    await sleep(1000);
    const afterFirst = canvasTabs().length;
    await api.openSession(session.id);
    await sleep(1000);
    assert.strictEqual(
      canvasTabs().length,
      afterFirst,
      'opening an already-open session must reveal its tab, not add another',
    );
  });

  it('carries the agent server\'s output into the log (the "no reply" diagnostic)', async () => {
    // The server used to run with stdio 'ignore', so failures were invisible and
    // a user whose agent would not reply had nothing to look at. These lines can
    // only appear if its stdout/stderr actually reaches the log channel.
    await waitFor(
      () => api.recentLogs().some((line) => /pi SDK:/.test(line)) &&
            api.recentLogs().some((line) => /listening on ws:\/\//.test(line)),
      20_000,
      'the server startup lines to reach the log',
    );
    const logs = api.recentLogs();
    assert.ok(logs.some((l) => /pi SDK:/.test(l)), `no SDK line in log:\n${logs.join('\n')}`);
    assert.ok(logs.some((l) => /listening on ws:\/\//.test(l)), `no listen line in log:\n${logs.join('\n')}`);
  });

  it('refuses a session that no longer exists instead of hanging on it', async () => {
    const before = canvasTabs().length;
    await api.openSession('00000000-0000-0000-0000-000000000000');
    await sleep(1000);
    assert.strictEqual(
      canvasTabs().length,
      before,
      'a stale session row must not open a panel that can never load',
    );
  });

  it('honours a configured launch command and working directory', async function () {
    // The point of these settings: on a machine where the agent only behaves in
    // one repository, the launch is configurable. A wrapper proves both that it
    // ran and what environment it was given.
    const dir = join(tmpdir(), `pi-canvas-cwd-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, 'launched.txt');
    const wrapper = join(dir, 'wrapper.sh');
    writeFileSync(
      wrapper,
      `#!/bin/bash\nprintf '%s' "$PI_CANVAS_CWD" > "${marker}"\nexec node "$PI_CANVAS_SERVER"\n`,
      { mode: 0o755 },
    );

    const config = vscode.workspace.getConfiguration('piCanvas');
    try {
      await config.update('agentCwd', dir, vscode.ConfigurationTarget.Global);
      await config.update('agentCommand', `bash "${wrapper}"`, vscode.ConfigurationTarget.Global);

      await waitFor(() => existsSync(marker), 40_000, 'the configured launch command to run');
      assert.strictEqual(
        readFileSync(marker, 'utf8').trim(),
        dir,
        'the launched command must see the configured working directory',
      );
      // …and the server it exec'd must be the one answering, on the same port.
      await waitFor(async () => { await api.sessions(); return true; }, 40_000, 'the wrapped server to answer');
      assert.ok(api.recentLogs().some((l) => l.includes('agentCommand')), 'the log should say which command was used');
    } finally {
      await config.update('agentCommand', undefined, vscode.ConfigurationTarget.Global);
      await config.update('agentCwd', undefined, vscode.ConfigurationTarget.Global);
    }
    // Back on the built-in launch.
    await waitFor(async () => { await api.sessions(); return true; }, 40_000, 'the default server to answer again');
  });

  it('refuses swapped launch settings instead of failing obscurely', async function () {
    // Reported from a real machine: agentCwd was given the command and
    // agentCommand the directory. That produced 'spawn /bin/sh ENOENT' with the
    // cause buried in another log line, so it is detected and named now.
    const dir = join(tmpdir(), `pi-canvas-swap-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const config = vscode.workspace.getConfiguration('piCanvas');
    try {
      await config.update('agentCwd', 'source ./activate && exec node "$PI_CANVAS_SERVER"', vscode.ConfigurationTarget.Global);
      await config.update('agentCommand', dir, vscode.ConfigurationTarget.Global);

      await waitFor(
        () => api.recentLogs().some((l) => l.includes('looks like a shell command')),
        30_000,
        'the swapped settings to be called out',
      );
      const logs = api.recentLogs().join('\n');
      assert.ok(/looks like a shell command, not a directory/.test(logs), `expected a swap hint for agentCwd:\n${logs}`);
      assert.ok(/is a directory, not a command/.test(logs), `expected a swap hint for agentCommand:\n${logs}`);

      // …and the agent still comes up, on the built-in launch.
      await waitFor(async () => { await api.sessions(); return true; }, 40_000, 'the fallback launch to answer');
      assert.ok(
        api.recentLogs().some((l) => l.includes('built-in launch, because the configured one is unusable')),
        'the log should say it fell back',
      );
    } finally {
      await config.update('agentCommand', undefined, vscode.ConfigurationTarget.Global);
      await config.update('agentCwd', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('gives a new session its own panel', async () => {
    const before = canvasTabs().length;
    await vscode.commands.executeCommand('piAgentCanvas.newSession');
    await waitFor(() => canvasTabs().length > before, 20_000, 'a second canvas panel');
    assert.strictEqual(canvasTabs().length, before + 1, 'a new conversation is a new tile');
  });

  it('"open canvas" converges on one panel instead of piling up tabs', async () => {
    await vscode.commands.executeCommand('piAgentCanvas.open');
    await sleep(1000);
    const count = canvasTabs().length;
    await vscode.commands.executeCommand('piAgentCanvas.open');
    await sleep(1000);
    assert.strictEqual(canvasTabs().length, count, 'repeated "open canvas" must not add tabs');

    // Every bound panel names itself after its conversation (empty sessions
    // fall back to their short id), so duplicate labels would mean two tabs
    // claiming one session.
    const labels = canvasTabs().map((tab) => tab.label);
    assert.deepStrictEqual(
      labels.filter((label, i) => labels.indexOf(label) !== i),
      [],
      `tab labels must be unique (got ${labels.join(' | ')})`,
    );
    void baseline;
  });
});
