import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const homePage = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const landingScript = readFileSync(new URL('../src/landing.js', import.meta.url), 'utf8');
const landingStyles = readFileSync(new URL('../src/landing.css', import.meta.url), 'utf8');

test('the home hero keeps one concise headline, subhead, and install command and leaves the rename note in the footer', () => {
  const beatZeroMatch = homePage.match(/<div class="beat on" data-beat="0">([\s\S]*?)<div class="beat" data-beat="1">/);
  assert.ok(beatZeroMatch, 'beat 0 is present on the landing page');
  const beatZero = beatZeroMatch[1];

  assert.match(beatZero, /<h1>Cook crisp 3D with your AI<\/h1>/);
  assert.doesNotMatch(beatZero, /class="explain"/);
  assert.doesNotMatch(beatZero, /class="rename-note"/);
  assert.equal((beatZero.match(/<div class="command">/g) ?? []).length, 1);
  assert.match(homePage, /<footer[\s\S]*formerly 67js/);
});

test('the landing page syntax-highlights commands and code examples without border clutter', () => {
  assert.match(landingScript, /highlightElement/);
  assert.ok(landingStyles.includes('.landing .hljs-string'));
  assert.ok(landingStyles.includes('--syntax-string'));
});
