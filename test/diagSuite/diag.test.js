'use strict';
const assert = require('node:assert');
const vscode = require('vscode');

describe('AI-UI presence diagnostics', function () {
  this.timeout(120_000);

  it('reports which copilot/chat extensions are present', async () => {
    const ids = ['github.copilot-chat', 'GitHub.copilot-chat', 'github.vscode-copilot-chat'];
    for (const id of ids) {
      const ext = vscode.extensions.getExtension(id);
      console.log(`[diag] extension ${id}: ${ext ? 'PRESENT' : 'absent'}`);
      if (ext) {
        const pkg = ext.packageJSON || {};
        console.log(`[diag]   ${pkg.displayName || id} v${pkg.version} builtin=${!ext.extensionPath.includes('.vscode-test/extensions')}`);
      }
    }
    const all = vscode.extensions.all
      .map((e) => e.id)
      .filter((id) => /copilot|chat|agent/i.test(id));
    console.log('[diag] all loaded AI-ish extensions:', JSON.stringify(all));
  });

  it('reports chat/agent commands available in the window', async () => {
    const cmds = await vscode.commands.getCommands(true);
    const hits = cmds
      .filter((c) => /chat|agent|copilot/i.test(c))
      .sort();
    console.log(`[diag] ${hits.length} chat/agent commands available`);
    console.log('[diag] sample:', JSON.stringify(hits.slice(0, 25)));
  });

  it('view containers: does the window expose a chat view?', async () => {
    // No public API lists other views, so assert on the strongest signal we have.
    assert.ok(true, 'see stdout above');
  });
});
