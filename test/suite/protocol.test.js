/**
 * PROTOCOL CONFORMANCE — the wire contract, enforced.
 *
 * The canvas has three parties that must agree on one vocabulary:
 *   - the session host  (scripts/pi-server.mjs — plain JS, ships as a script)
 *   - the webview       (src/webview/main.tsx — bundled by esbuild)
 *   - the diagnostics   (scripts/diagnose.mjs — spawns the host and reads it)
 *
 * src/shared/protocol.ts is the declared contract (pi's RPC vocabulary, see
 * pi's docs/rpc.md). Because the host cannot import TypeScript, the contract is
 * enforced here instead: this suite reads all four files as text and fails when
 * they drift. That is how `scripts/diagnose.mjs` was found still waiting for
 * the pre-rename `settled` event.
 *
 * These are static checks over the source tree, so they only run against a
 * checkout (which is where the source lives), never against a .vsix.
 */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const contract = read('src/shared/protocol.ts');
const server = read('scripts/pi-server.mjs');
const webview = read('src/webview/main.tsx');
const diagnose = read('scripts/diagnose.mjs');

/** Pull the string members out of a `const NAME = [ ... ] as const` array. */
function members(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(match, `src/shared/protocol.ts should declare ${name}`);
  // camelCase members (setStatus, setTitle) are extension-UI methods, not wire names.
  return new Set([...match[1].matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]));
}

const COMMANDS = members(contract, 'COMMANDS');
const EVENTS = members(contract, 'EVENTS');
const UI_DIALOGS = members(contract, 'EXTENSION_UI_DIALOG_METHODS');
// UI_METHODS is declared by spreading the two groups, so union them here.
const UI_METHODS = new Set([...UI_DIALOGS, ...members(contract, 'EXTENSION_UI_NOTICE_METHODS')]);

const sorted = (set) => [...set].sort().join(', ');

describe('pi-agent-canvas protocol conformance', function () {
  this.timeout(10_000);

  it('the contract itself is a plausible pi vocabulary', () => {
    // Spot-check the names a future `pi --mode rpc` adapter would have to map:
    // these are pi's own spellings, not ours.
    for (const name of ['prompt', 'abort', 'compact', 'set_model', 'set_thinking_level', 'extension_ui_response']) {
      assert.ok(COMMANDS.has(name), `COMMANDS should carry pi's "${name}"`);
    }
    for (const name of ['agent_settled', 'message_update', 'tool_execution_start', 'agent_end', 'extension_ui_request']) {
      assert.ok(EVENTS.has(name), `EVENTS should carry pi's "${name}"`);
    }
    assert.deepStrictEqual(
      [...UI_DIALOGS].sort(),
      ['confirm', 'editor', 'input', 'select'],
      'the blocking extension-UI methods are pi rpc.md’s four dialogs',
    );
  });

  it('the host implements exactly the commands the contract declares', () => {
    const implemented = new Set([...server.matchAll(/\n\s*case '([a-z_]+)':/g)].map((m) => m[1]));
    assert.ok(implemented.size > 5, 'expected a command switch in scripts/pi-server.mjs');
    for (const command of implemented) {
      assert.ok(COMMANDS.has(command), `pi-server.mjs handles "${command}", which the contract omits`);
    }
    for (const command of COMMANDS) {
      assert.ok(implemented.has(command), `the contract declares "${command}" but the host does not implement it`);
    }
    // No phantom commands in the other direction: the sets must be identical.
    assert.strictEqual(sorted(implemented), sorted(COMMANDS));
  });

  it('every event the host emits is in the contract', () => {
    const emitted = [...server.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(emitted.length > 3, 'expected the host to emit events');
    for (const name of emitted) {
      assert.ok(EVENTS.has(name), `pi-server.mjs emits "${name}", which the contract omits`);
    }
  });

  it('every event the webview handles is in the contract', () => {
    // Scope to the adapter's event switch so extension-UI `case`s (which switch
    // on `method`, not `type`) are not mistaken for wire events.
    const start = webview.indexOf('const listener = (event: PiEvent) => {');
    const end = webview.indexOf('piEventListeners.add(listener)');
    assert.ok(start > 0 && end > start, 'expected the adapter event listener in src/webview/main.tsx');
    const handled = new Set([...webview.slice(start, end).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
    assert.ok(handled.size > 3, 'expected the adapter to handle events');
    for (const name of handled) {
      assert.ok(EVENTS.has(name), `the webview handles "${name}", which the contract omits`);
    }
    assert.ok(handled.has('agent_settled'), 'the adapter must settle on pi’s own agent_settled event');
  });

  it('every command the webview sends is in the contract', () => {
    const sent = [...webview.matchAll(/sendToPi\(\{\s*type: '([a-z_]+)'/g)].map((m) => m[1]);
    const withSession = [...webview.matchAll(/sendToPi\(\{\s*\n\s*type: '([a-z_]+)'/g)].map((m) => m[1]);
    const all = [...sent, ...withSession];
    assert.ok(all.length >= 3, `expected the webview to send commands (found ${all.join(', ')})`);
    for (const name of all) {
      assert.ok(COMMANDS.has(name), `the webview sends "${name}", which the contract omits`);
    }
  });

  it('the host announces the same protocol version the contract declares', () => {
    const declared = contract.match(/export const PROTOCOL_VERSION = (\d+);/);
    const reported = server.match(/const PROTOCOL_VERSION = (\d+);/);
    assert.ok(declared && reported, 'both files should declare PROTOCOL_VERSION');
    assert.strictEqual(reported[1], declared[1], 'host and contract must agree on the protocol version');
    assert.match(server, /protocol: PROTOCOL_VERSION/, 'server_ready must carry the version');
    assert.match(webview, /event\.protocol !== PROTOCOL_VERSION/, 'the webview should check the version');
  });

  it('the extension UI sub-protocol matches pi’s RPC mode', () => {
    // The blocking dialogs must be implemented as dialogs (a dialog that
    // resolves immediately is a silent no-op), and the fire-and-forget methods
    // must not be waited on.
    for (const method of UI_DIALOGS) {
      assert.match(server, new RegExp(`${method}:`), `the host's UI context should implement ${method}()`);
    }
    assert.match(server, /bindExtensions\(\{\s*uiContext/, 'extensions need the UI context bound');
    assert.match(server, /mode: 'rpc'/, 'extensions should see ctx.mode === "rpc"');
    // Binding must NOT be awaited: a `session_start` handler that opens a dialog
    // would otherwise block `session_opened`, the client would still be on its
    // connecting screen with no dialog rendered, and the extension and the UI
    // would wait on each other forever. (Observed: it deadlocked the e2e run.)
    assert.doesNotMatch(server, /await session[\s.]*\s*\.bindExtensions/, 'binding extensions must not block session_opened');
    for (const method of ['notify', 'setStatus', 'setTitle', 'setWidget', 'set_editor_text']) {
      assert.ok(UI_METHODS.has(method), `EXTENSION_UI_METHODS should list ${method}`);
    }
    // Fire-and-forget methods must be emitted, never awaited.
    assert.doesNotMatch(server, /await emitUi\(/, 'emitUi is fire-and-forget');
    assert.match(server, /extension_ui_response/, 'the host must accept dialog answers');
  });

  it('nothing waits on a stale event name', () => {
    // The regression this suite exists for: a rename (`settled` → pi's
    // `agent_settled`) leaving a consumer waiting forever.
    for (const [name, source] of [
      ['src/webview/main.tsx', webview],
      ['scripts/pi-server.mjs', server],
      ['scripts/diagnose.mjs', diagnose],
    ]) {
      const stale = [...source.matchAll(/(?<!agent_)('|")settled\1/g)];
      assert.strictEqual(stale.length, 0, `${name} still refers to the pre-rename "settled" event`);
    }
    assert.match(diagnose, /agent_settled/, 'diagnose.mjs must recognise the turn ending');
  });

  it('the diagnostics script still speaks the contract', () => {
    const sent = [...diagnose.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]);
    for (const name of sent) {
      assert.ok(
        COMMANDS.has(name) || EVENTS.has(name),
        `diagnose.mjs uses "${name}", which is neither a contract command nor an event`,
      );
    }
    assert.match(diagnose, /type: 'prompt'/, 'diagnose.mjs should send a prompt');
    assert.match(diagnose, /type: 'open_session'/, 'diagnose.mjs should open a session');
  });
});
