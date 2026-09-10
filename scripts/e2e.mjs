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
  const PROMPT = process.env.E2E_PROMPT ?? 'Reply with exactly: E2E-BRIDGE-OK';
  const EXPECT = process.env.E2E_EXPECT ?? 'E2E-BRIDGE-OK';
  await input.fill(PROMPT);
  await input.press('Enter');
  result.sent = true;

  // Wait for the assistant reply to stream in.
  let body = '';
  for (let i = 0; i < 200; i++) {
    await window.waitForTimeout(1000);
    body = await frame.locator('body').innerText();
    if (new RegExp(EXPECT).test(body)) break;
    if (i === 30 || i === 60 || i === 90) console.log('[t='+i+'s] body:', JSON.stringify(body.slice(0, 300)));
  }
  const settleMs = Number(process.env.E2E_SETTLE_MS ?? 0);
  if (settleMs) {
    await window.waitForTimeout(settleMs);
    body = await frame.locator('body').innerText();
  }
  if (process.env.E2E_CLICK_SPLIT) {
    const split = frame.locator('button', { hasText: 'split' }).first();
    await split.click({ timeout: 10_000 });
    await window.waitForTimeout(1200);
  }
  if (process.env.E2E_SCROLL) {
    await window.mouse.move(600, 500);
    await window.mouse.wheel(0, Number(process.env.E2E_SCROLL));
    await window.waitForTimeout(800);
  }
  if (process.env.E2E_SHOT) {
    await window.screenshot({ path: process.env.E2E_SHOT });
    console.log('screenshot saved', process.env.E2E_SHOT);
  }
  const replies = [...body.matchAll(new RegExp(EXPECT, 'g'))].length;
  if (replies >= 2) result.replySeen = true; // user message + assistant reply
  result.toolCardSeen = /\bbash\b/.test(body);
  result.thinkingSeen = /Thinking|Thought/.test(body);
  console.log('THREAD TEXT >>>\n' + body.slice(0, 2000));
  let html = '';
  try {
    html = await frame.locator('#root').innerHTML();
    console.log('ROOT HTML >>>\n' + html.slice(0, 3000));
  } catch (e) { console.log('html dump failed', String(e)); }
  result.diffSeen = /diff-line-num|diff-line-syntax-raw|diff-tailwindcss-wrapper/.test(html);
  result.diffDump = await frame.evaluate(() => {
    const root = document.querySelector('.diff-tailwindcss-wrapper');
    if (!root) return 'no wrapper';
    return {
      html: root.innerHTML.slice(0, 1200),
      rect: JSON.stringify(root.getBoundingClientRect()),
      childCount: root.querySelectorAll('*').length,
    };
  });
  result.diffSplitRendered = await frame.evaluate(() => {
    const root = document.querySelector('.diff-tailwindcss-wrapper');
    if (!root) return null;
    const tables = root.querySelectorAll('table');
    return { tables: tables.length, classes: root.className.slice(0, 80) };
  });
  result.horizontalOverflow = await frame.evaluate(() => {
    const vp = document.querySelector('#root > div > div');
    if (!vp) return null;
    if (vp.scrollWidth <= vp.clientWidth + 1) return false;
    const limit = vp.clientWidth;
    const offenders = [];
    for (const el of vp.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > vp.getBoundingClientRect().right + 2) {
        offenders.push(`${el.tagName}.${el.className || '-'} w=${Math.round(r.width)} right=${Math.round(r.right)} :: ${(el.textContent || '').slice(0, 60).replace(/\s+/g, ' ')}`);
      }
    }
    console.log('OVERFLOW vp=' + limit);
    console.log(offenders.slice(0, 8).join('\n'));
    return true;
  });
  result.splitToggleSeen = /unified/.test(html) && /split/.test(html);
} catch (err) {
  result.error = String(err);
}

console.log('RESULT ' + JSON.stringify(result, null, 2));
process.exit(result.replySeen ? 0 : 1);
