/**
 * pi-agent-canvas — end-to-end test via Playwright's Electron support.
 *
 * Launches the dev VS Code with the extension, reaches into the canvas
 * webview (an iframe inside the renderer), types a prompt, presses Enter,
 * and asserts pi's reply streams in.
 *
 *   node scripts/e2e.mjs
 */
import { _electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const result = { launched: false, frameFound: false, sent: false, replySeen: false, error: null };

// The extension host's @vscode/proxy-agent patch is known to stall SSE
// streaming; our E2E profile disables it. Dev-profile-only, never shipped.
const profileDir = `${root}.vscode-test/user-data-e2e`;
mkdirSync(`${profileDir}/User`, { recursive: true });
writeFileSync(
  `${profileDir}/User/settings.json`,
  JSON.stringify({ 'http.proxySupport': 'off' }, null, 2),
);

try {
  const app = await _electron.launch({
    executablePath: `${root}.vscode-test/vscode-linux-x64-1.136.1/code`,
    args: [
      '--extensionDevelopmentPath=' + root,
      '--disable-extensions',
      '--new-window',
      '--user-data-dir=' + `${root}.vscode-test/user-data-e2e`,
      '--extensions-dir=' + `${root}.vscode-test/extensions-e2e`,
      '--disable-workspace-trust',
    ],
    env: { ...process.env, VSCODE_EXTENSION_ISOLATED: '1' },
  });
  result.launched = true;

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  window.on('console', (msg) => console.log('[console]', msg.type(), msg.text().slice(0, 300)));

  // Wait for the canvas webview content frame (VS Code nests it at fake.html).
  let frame = null;
  for (let i = 0; i < 60 && !frame; i++) {
    frame = window.frames().find((f) => /vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url())) ?? null;
    if (!frame) await window.waitForTimeout(1000);
  }
  if (!frame) throw new Error('canvas webview frame not found');
  result.frameFound = true;

  const input = frame.locator('textarea').first();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.click();
  await input.fill('Reply with exactly: E2E-BRIDGE-OK');
  await input.press('Enter');
  result.sent = true;

  // Wait for the assistant reply to stream in.
  let body = '';
  for (let i = 0; i < 200; i++) {
    await window.waitForTimeout(1000);
    body = await frame.locator('body').innerText();
    if (/E2E-BRIDGE-OK/.test(body)) break;
    if (i === 30 || i === 60 || i === 90) console.log('[t='+i+'s] body:', JSON.stringify(body.slice(0, 300)));
  }
  const replies = [...body.matchAll(/E2E-BRIDGE-OK/g)].length;
  if (replies >= 2) result.replySeen = true; // user message + assistant reply
  console.log('THREAD TEXT >>>\n' + body.slice(0, 2000));
} catch (err) {
  result.error = String(err);
}

console.log('RESULT ' + JSON.stringify(result, null, 2));
process.exit(result.replySeen ? 0 : 1);
