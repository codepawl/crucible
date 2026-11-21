import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('the render skill tells agents to run the preview check before sending look previews', () => {
  const skill = readFileSync(new URL('../skills/render-crucible-media/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /node scripts\/check-preview\.mjs /);
  assert.ok(existsSync(new URL('../scripts/check-preview.mjs', import.meta.url)), 'the skill names a script that must exist');
});
