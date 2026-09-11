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
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;

// A port unique to this run. Left-over detached servers from earlier runs
// otherwise stay bound and the next run silently talks to a stale agent.
const PORT = process.env.E2E_PORT ?? String(48120 + Math.floor(Math.random() * 700));
// Tear down this run's server on exit (only the pid bound to OUR port).
process.on('exit', () => {
  try {
    const out = execSync(`ss -ltnp 2>/dev/null | grep ':${PORT} ' || true`).toString();
    const pid = out.match(/pid=(\d+)/)?.[1];
    if (pid) process.kill(Number(pid), 'SIGTERM');
  } catch { /* best effort */ }
});
const result = { launched: false, frameFound: false, sent: false, replySeen: false, error: null };

// E2E_INSTALLED=1 drives the PACKAGED extension (a .vsix installed into a clean
// extensions dir) instead of the dev checkout — the only way to prove the
// artifact works without node_modules present.
const installed = process.env.E2E_INSTALLED === '1';
const profileDir = process.env.E2E_USER_DIR ?? `${root}.vscode-test/user-data-e2e`;
const extensionsDir = process.env.E2E_EXT_DIR ?? `${root}.vscode-test/extensions-e2e`;

// The extension host's @vscode/proxy-agent patch is known to stall SSE
// streaming; our E2E profile disables it. Dev-profile-only, never shipped.
mkdirSync(`${profileDir}/User`, { recursive: true });
writeFileSync(
  `${profileDir}/User/settings.json`,
  JSON.stringify({ 'http.proxySupport': 'off', 'notifications.doNotDisturbMode': true }, null, 2),
);

try {
  // Playwright drives a specific build: 1.137.0 dies on startup under Playwright
  // (chrome-sandbox), so prefer the build the harness is known to work with and
  // allow an explicit override.
  // VS Code caches the extension set in extensions.json. With an installed
  // .vsix that cache outlives the extracted directory, and the window then
  // refuses to load anything ("Extensions have been modified on disk") — which
  // looks exactly like a broken artifact.
  if (installed) {
    try { rmSync(`${extensionsDir}/extensions.json`, { force: true }); } catch { /* fine */ }
  }

  const codeBin =
    process.env.E2E_CODE_BIN ??
    (existsSync(`${root}.vscode-test/vscode-linux-x64-1.136.1/code`)
      ? `${root}.vscode-test/vscode-linux-x64-1.136.1/code`
      : `${root}.vscode-test/vscode-linux-x64-1.137.0/code`);
  const app = await _electron.launch({
    executablePath: codeBin,
    args: [
      ...(installed ? [] : ['--extensionDevelopmentPath=' + root, '--disable-extensions']),
      '--new-window',
      '--user-data-dir=' + profileDir,
      '--extensions-dir=' + extensionsDir,
      '--disable-workspace-trust',
    ],
    // Dedicated port so an already-running canvas window can't interfere (and
    // so the test can never attach to someone else's agent).
    env: {
      ...process.env,
      VSCODE_EXTENSION_ISOLATED: '1',
      PI_CANVAS_PORT: PORT,
    },
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

  // VS Code pops toasts ("Extensions are temporarily disabled") that sit on top
  // of the composer and swallow clicks; clear them before interacting.
  const dismissToasts = async () => {
    try {
      for (const c of await window.locator('.notifications-toasts .codicon-close').all()) {
        await c.click({ force: true }).catch(() => {});
      }
    } catch { /* window closing */ }
  };
  const toastSweeper = setInterval(() => void dismissToasts(), 1000);

  const input = frame.locator('textarea').first();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.click({ force: true });
  const PROMPT = process.env.E2E_PROMPT ?? 'Reply with exactly: E2E-BRIDGE-OK';
  const EXPECT = process.env.E2E_EXPECT ?? 'E2E-BRIDGE-OK';
  await input.fill(PROMPT);
  await input.press('Enter');
  result.sent = true;

  // In abort mode we never wait for the reply — the turn is interrupted on
  // purpose, so that wait loop would just burn its full timeout first.
  const abortMode = Boolean(process.env.E2E_ABORT);
  // Wait for the assistant reply to stream in.
  let body = '';
  for (let i = 0; i < 200 && !abortMode; i++) {  // eslint-disable-line
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
  // Abort control: the stop button only exists while a run is in flight, and
  // pressing it must end the turn without a server error.
  if (process.env.E2E_ABORT) {
    // Poll: the button must appear on its own while the turn is in flight.
    const stop = frame.locator('button.canvas-stop');
    for (let i = 0; i < 30; i++) {
      if ((await stop.count()) > 0) { result.stopButtonSeen = true; result.stopButtonAtMs = i * 500; break; }
      await window.waitForTimeout(500);
    }
    if (result.stopButtonSeen) {
      await dismissToasts();
      await stop.first().click({ force: true });
      await window.waitForTimeout(2500);
      // VS Code toasts sit exactly over the composer's bottom-right corner, so a
      // coordinate click can land on the toast instead. Fall back to a direct
      // element click (same handler, no mouse) and record which path worked.
      result.stopClickMode = 'mouse';
      if ((await frame.locator('button.canvas-stop').count()) > 0) {
        result.stopClickMode = 'element';
        await frame.evaluate(() => document.querySelector('button.canvas-stop')?.click());
      }
      for (let i = 0; i < 30; i++) {
        await window.waitForTimeout(500);
        if ((await frame.locator('button.canvas-stop').count()) === 0) break;
      }
      result.stopButtonGone = (await frame.locator('button.canvas-stop').count()) === 0;
      // The session must still accept work afterwards.
      const input2 = frame.locator('textarea').first();
      await dismissToasts();
      await input2.fill('Reply with exactly: E2E-AFTER-ABORT', { force: true });
      await input2.press('Enter');
      let after = '';
      for (let i = 0; i < 60; i++) {
        await window.waitForTimeout(1000);
        after = await frame.locator('body').innerText();
        if (/E2E-AFTER-ABORT/.test(after.replace('Reply with exactly: E2E-AFTER-ABORT', ''))) break;
      }
      result.afterAbortReplySeen = /E2E-AFTER-ABORT/.test(after.replace('Reply with exactly: E2E-AFTER-ABORT', ''));
    }
  }
  // Session persistence: reload the webview and the stored conversation is
  // replayed by the server, so the earlier prompt/reply are still on screen.
  if (process.env.E2E_RELOAD) {
    await window.keyboard.press('Control+Shift+P');
    await window.waitForTimeout(1200);
    await window.keyboard.type('reload webviews');
    await window.waitForTimeout(1200);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1200);
    // Frame handle goes stale on reload; find the new one.
    let frame2 = null;
    for (let i = 0; i < 40 && !frame2; i++) {
      await window.waitForTimeout(1000);
      frame2 = window.frames().find((f) => /vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url())) ?? null;
      if (frame2) {
        try { await frame2.locator('textarea').first().waitFor({ state: 'visible', timeout: 4000 }); }
        catch { frame2 = null; }
      }
    }
    result.reloadFrameFound = Boolean(frame2);
    if (frame2) {
      let reloaded = '';
      for (let i = 0; i < 20; i++) {
        await window.waitForTimeout(1000);
        reloaded = await frame2.locator('body').innerText();
        if (new RegExp(EXPECT).test(reloaded)) break;
      }
      result.reloadHistorySeen = new RegExp(EXPECT).test(reloaded);
      result.reloadedText = reloaded.slice(0, 400);
      if (process.env.E2E_RELOAD_SHOT) await window.screenshot({ path: process.env.E2E_RELOAD_SHOT });
    }
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
  // File tile → editor tab: clicking a file chip must open the file in the
  // editor area (reusing its tab), which is the point of the VS Code host.
  if (process.env.E2E_CLICK_FILE) {
    const name = process.env.E2E_CLICK_FILE;
    const chip = frame.locator('button.canvas-file', { hasText: name }).first();
    try {
      await chip.waitFor({ state: 'visible', timeout: 20_000 });
      result.fileChipSeen = true;
      await dismissToasts();
      await chip.click({ force: true });
      await window.waitForTimeout(3000);
      result.fileTabTitles = await window.locator('.tabs-container .tab').allInnerTexts();
      result.fileTabOpened = result.fileTabTitles.some((t) => t.includes(name));

      // The pane policy is "focus if visible, else preview in the active pane":
      // clicking the same file again must reuse its tab, never split or stack.
      const before = (await window.locator('.tabs-container .tab').count());
      const groupsBefore = await window.locator('.editor-group-container').count();
      await chip.click({ force: true });
      await window.waitForTimeout(2500);
      const after = (await window.locator('.tabs-container .tab').count());
      const groupsAfter = await window.locator('.editor-group-container').count();
      result.fileTabReused = after === before && groupsAfter === groupsBefore;
      result.filePaneCount = [groupsBefore, groupsAfter];
    } catch (err) {
      result.fileChipError = String(err).slice(0, 200);
    }
  }
  // The agent button + Sessions view: the activity-bar container, the tree it
  // opens, and the session tiles inside it.
  if (process.env.E2E_VIEW) {
    const container = window.locator('.activitybar .action-item', { hasText: '' }).filter({ has: window.locator('[aria-label*="Pi Agent"]') });
    result.activityButtonSeen = (await window.locator('.activitybar [aria-label*="Pi Agent"]').count()) > 0;
    if (result.activityButtonSeen) {
      await window.locator('.activitybar [aria-label*="Pi Agent"]').first().click({ force: true });
      await window.waitForTimeout(3500);
      result.sidebarRows = await window.locator('.pane-body .monaco-list-row').allInnerTexts().catch(() => []);
      result.sidebarTitleSeen = (await window.locator('.pane-header', { hasText: 'Sessions' }).count()) > 0;
      // The title-bar "new session" button is the second robot affordance.
      result.newSessionButtonSeen = (await window.locator('.pane-header a.action-label[aria-label*="New Session"]').count()) > 0;
      void container;
    }
  }
  // Failure visibility: when the agent cannot reply, the reason must be on
  // screen (this is the "sessions load but nothing replies" case).
  if (process.env.E2E_EXPECT_ERROR) {
    let seen = '';
    for (let i = 0; i < 90; i++) {
      await window.waitForTimeout(1000);
      seen = await frame.locator('body').innerText();
      if (new RegExp(process.env.E2E_EXPECT_ERROR, 'i').test(seen)) break;
    }
    result.errorBannerSeen = new RegExp(process.env.E2E_EXPECT_ERROR, 'i').test(seen);
    result.errorText = seen.slice(0, 500);
    if (process.env.E2E_SHOT) await window.screenshot({ path: process.env.E2E_SHOT });
  }
  // `!command` runs a shell command instead of a prompt.
  if (process.env.E2E_BASH) {
    const box = frame.locator('textarea').first();
    await box.fill(process.env.E2E_BASH);
    await box.press('Enter');
    const expect = process.env.E2E_BASH_EXPECT ?? 'exit 0';
    let seen = '';
    for (let i = 0; i < 60; i++) {
      await window.waitForTimeout(1000);
      seen = await frame.locator('body').innerText();
      if (new RegExp(expect).test(seen)) break;
    }
    result.bashRan = new RegExp(expect).test(seen);
    result.bashText = seen.slice(0, 600);
    result.bashCommandEchoed = seen.includes(process.env.E2E_BASH.replace(/^!+/, '').trim());
    if (process.env.E2E_SHOT) await window.screenshot({ path: process.env.E2E_SHOT });
  }
  // Extension UI sub-protocol: an extension that asks the user a question has
  // to reach the canvas and get an answer back. Without a UI context the turn
  // simply sits there, which is why this is asserted, not assumed. Requires an
  // extension in the agent dir that asks (see test/suite/protocol.test.js).
  if (process.env.E2E_EXPECT_UI_DIALOG) {
    const dialog = frame.locator('[role="dialog"]');
    for (let i = 0; i < 40; i++) {
      if ((await dialog.count()) > 0) break;
      await window.waitForTimeout(500);
    }
    result.uiDialogSeen = (await dialog.count()) > 0;
    if (result.uiDialogSeen) {
      result.uiDialogText = (await dialog.first().innerText()).slice(0, 200);
      await dialog.locator('button', { hasText: /^Confirm$/ }).first().click({ force: true });
      // The extension reports the answer it received back through ctx.ui.notify.
      for (let i = 0; i < 24; i++) {
        await window.waitForTimeout(500);
        if ((await frame.locator('text=/confirm => true/').count()) > 0) { result.uiNoticeSeen = true; break; }
      }
    }
  }
  // Assert on the finished transcript (used to prove replayed history, e.g. a
  // `!command` card from an earlier run).
  if (process.env.E2E_EXPECT_TEXT) {
    const text = await frame.locator('body').innerText();
    result.expectTextSeen = text.includes(process.env.E2E_EXPECT_TEXT);
    result.expectTextBody = text.slice(0, 500);
  }
  if (process.env.E2E_SHOT && !process.env.E2E_EXPECT_ERROR) {
    await window.screenshot({ path: process.env.E2E_SHOT });
    console.log('screenshot saved', process.env.E2E_SHOT);
  }
  const replies = [...body.matchAll(new RegExp(EXPECT, 'g'))].length;
  if (replies >= 2) result.replySeen = true; // user message + assistant reply
  result.toolCardSeen = /\bbash\b/.test(body);
  result.thinkingSeen = /Thinking|Thought/.test(body);
  console.log('THREAD TEXT >>>\n' + body.slice(0, 2000));
  let html = '';
  // A reload (E2E_RELOAD) detaches the original frame handle, so all of these
  // dumps are best-effort.
  let liveFrame = frame;
  try {
    liveFrame = window.frames().find((f) => /vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url())) ?? frame;
  } catch { /* keep original */ }
  try {
    html = await liveFrame.locator('#root').innerHTML();
    console.log('ROOT HTML >>>\n' + html.slice(0, 3000));
  } catch (e) { console.log('html dump failed', String(e)); }
  result.diffSeen = /diff-line-num|diff-line-syntax-raw|diff-tailwindcss-wrapper/.test(html);
  result.diffDump = await liveFrame.evaluate(() => {
    const root = document.querySelector('.diff-tailwindcss-wrapper');
    if (!root) return 'no wrapper';
    return {
      html: root.innerHTML.slice(0, 1200),
      rect: JSON.stringify(root.getBoundingClientRect()),
      childCount: root.querySelectorAll('*').length,
    };
  });
  result.diffSplitRendered = await liveFrame.evaluate(() => {
    const root = document.querySelector('.diff-tailwindcss-wrapper');
    if (!root) return null;
    const tables = root.querySelectorAll('table');
    return { tables: tables.length, classes: root.className.slice(0, 80) };
  });
  result.horizontalOverflow = await liveFrame.evaluate(() => {
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
  // Feature rendering: assert on the *rendered* UI, not the text. Markdown is
  // converted to HTML (.canvas-md), a diff renders through @git-diff-view, and
  // a bash card is a plain div — a text assertion alone would still pass if the
  // renderer regressed to raw output, so check for the elements themselves.
  // Separate several with `||`.
  if (process.env.E2E_EXPECT_SELECTOR) {
    const selectors = process.env.E2E_EXPECT_SELECTOR.split('||');
    result.selectorSeen = {};
    for (const selector of selectors) {
      result.selectorSeen[selector] = await liveFrame.locator(selector).count().catch(() => 0);
    }
    result.selectorsAllSeen = Object.values(result.selectorSeen).every((n) => n > 0);
  }
  result.markdownSeen = {
    table: await liveFrame.locator('.canvas-md table').count().catch(() => 0),
    heading: await liveFrame.locator('.canvas-md h1, .canvas-md h2, .canvas-md h3').count().catch(() => 0),
    codeBlock: await liveFrame.locator('.canvas-md pre code').count().catch(() => 0),
    inlineCode: await liveFrame.locator('.canvas-md :not(pre) > code').count().catch(() => 0),
    listItem: await liveFrame.locator('.canvas-md li').count().catch(() => 0),
    copyButton: await liveFrame.locator('.canvas-md button').count().catch(() => 0),
  };
  result.fileChipButtons = await liveFrame.locator('button.canvas-file').count().catch(() => 0);
  clearInterval(toastSweeper);
} catch (err) {
  result.error = String(err);
}

console.log('RESULT ' + JSON.stringify(result, null, 2));
process.exit(result.replySeen || result.reloadHistorySeen || result.afterAbortReplySeen ? 0 : 1);
