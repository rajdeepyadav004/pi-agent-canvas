/**
 * PRE-LAUNCH profile tests — run in BOTH modes. The seed script must bake
 * `chat.disableAIFeatures: true` into the isolated dev profile's
 * settings.json so no chat UI ever renders, even for one frame.
 */
'use strict';
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const settingsPath = join(root, '.vscode', '.devdata', 'User', 'settings.json');

describe('pre-launch profile seeding', function () {
  this.timeout(15_000);

  it('seed script disables AI/chat in the profile before any window opens', () => {
    execFileSync('node', [join(root, 'scripts', 'seed-profile.mjs')], { cwd: root });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(
      settings['chat.disableAIFeatures'],
      true,
      'seed-profile.mjs must write chat.disableAIFeatures:true into the dev profile',
    );
  });

  it('seed script does not write any chrome-stripping (kiosk) keys', () => {
    execFileSync('node', [join(root, 'scripts', 'seed-profile.mjs')], { cwd: root });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const key of Object.keys(settings)) {
      assert.match(
        key,
        /^chat\.disableAIFeatures$/,
        `unexpected key '${key}' in the dev profile — chrome stripping must stay dead`,
      );
    }
  });
});
