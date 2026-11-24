// Headless Chrome with audio output on leaves handles in the Windows audio engine after every launch (#3198), so every launch in
// scripts/ turns audio output off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const FLAG = "'--disable-audio-output'";
const SWITCH_LIST = /\[(?:[^[\]]|\[[^[\]]*\])*\]/g;
const BASE_SWITCH = /'--(?:enable-webgl|ignore-gpu-blocklist)'/;

function launchingScripts() {
  return readdirSync(join(root, 'scripts'))
    .filter(name => /\.m?js$/.test(name))
    .map(name => ({ name, source: readFileSync(join(root, 'scripts', name), 'utf8') }))
    .filter(({ source }) => source.includes('chromium.launch('));
}

test('every chromium.launch in scripts/ passes --disable-audio-output', () => {
  const scripts = launchingScripts();
  assert.ok(scripts.length >= 40, `found ${scripts.length} launching scripts`);
  const missing = scripts.filter(({ source }) => !source.includes(FLAG)).map(({ name }) => name);
  assert.deepEqual(missing, []);
});

test('each Chrome switch list in a launching script, including each side of a ternary, has --disable-audio-output', () => {
  const missing = [];
  for (const { name, source } of launchingScripts()) {
    for (const list of source.match(SWITCH_LIST) ?? []) {
      if (BASE_SWITCH.test(list) && !list.includes(FLAG)) missing.push(`${name}: ${list}`);
    }
  }
  assert.deepEqual(missing, []);
});
