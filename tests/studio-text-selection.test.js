import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { KINDS, SELECTABLE_SELECTOR, findSelectionProblems } from '../scripts/studio-layout-rules.mjs';
import { runAudit, runSelectionBehavior, summarize } from '../scripts/studio-layout-audit.mjs';

// In Studio nothing is selectable by click or drag, except text fields and a block that opts in with the class
// crucible-studio-selectable (#3328). The one rule that allows it is named in studio-styles.js; these tests keep it the only one.

const ALLOWED_RULE_SELECTORS = ['.crucible-studio input', '.crucible-studio textarea', '.crucible-studio-selectable'];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rulesThatSelect(source) {
  const rules = [];
  for (const match of stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = match[2].match(/user-select\s*:\s*([a-z-]+)/);
    if (declaration && declaration[1] !== 'none') rules.push({ selectors: match[1].split(',').map(selector => selector.trim()), value: declaration[1] });
  }
  return rules;
}

test('only the named list in studio-styles.js turns user-select on', () => {
  const rules = rulesThatSelect(readFileSync(new URL('../src/studio-styles.js', import.meta.url), 'utf8'));
  assert.equal(rules.length, 1, `one rule re-enables selection, found ${JSON.stringify(rules)}. Add the class crucible-studio-selectable to a block a person copies instead of a new rule.`);
  assert.deepEqual(rules[0].selectors, ALLOWED_RULE_SELECTORS);
  assert.equal(rules[0].value, 'text');
});

test('no other Studio source sets user-select to anything but none', () => {
  const sourceDirectory = new URL('../src/', import.meta.url);
  for (const name of readdirSync(sourceDirectory).filter(file => file.startsWith('studio') && file !== 'studio-styles.js')) {
    const source = readFileSync(new URL(name, sourceDirectory), 'utf8');
    assert.doesNotMatch(source, /user-select\s*:\s*(text|all|auto|contain)/, `${name} re-enables selection; use the class crucible-studio-selectable`);
  }
});

test('the audit list of selectable elements is the CSS list', () => {
  const cssSelectors = ALLOWED_RULE_SELECTORS.map(selector => selector.replace('.crucible-studio ', ''));
  for (const selector of cssSelectors) assert.ok(SELECTABLE_SELECTOR.includes(selector), `${selector} is in SELECTABLE_SELECTOR`);
});

function record(overrides = {}) {
  return { selector: 'span', path: 'div.crucible-studio-settings > span', ownText: 'Snap step', userSelect: 'none', selectable: false, ...overrides };
}

test('chrome with text that computes to text fails and says how to fix it', () => {
  const findings = findSelectionProblems([record({ userSelect: 'text' })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, KINDS.selectableChrome);
  assert.match(findings[0].message, /div\.crucible-studio-settings > span.*Snap step.*crucible-studio-selectable only if a person copies/s);
});

test('chrome that computes to none, text without own text and records without selection fields pass', () => {
  assert.deepEqual(findSelectionProblems([record(), record({ userSelect: 'text', ownText: '' }), { selector: 'div' }]), []);
});

test('an allowed element that computes to none fails, text and auto pass', () => {
  assert.equal(findSelectionProblems([record({ selectable: true, userSelect: 'none' })]).length, 1);
  assert.deepEqual(findSelectionProblems([record({ selectable: true, userSelect: 'text' }), record({ selectable: true, userSelect: 'auto' })]), []);
});

async function inChrome(context, run) {
  try {
    return await run();
  } catch (error) {
    context.skip(`Chrome or the dev server did not start: ${String(error.message).split('\n')[0]}`);
    return null;
  }
}

test('the dialogs and the page pass the selection audit, and a seeded selectable label is reported', { timeout: 240000 }, async context => {
  const clean = await inChrome(context, () => runAudit({ only: 'dialog' }));
  if (!clean) return;
  assert.equal(clean.length, 6, 'three dialogs in two themes');
  assert.deepEqual(summarize(clean).findings.map(finding => finding.message), []);
  const seeded = await runAudit({ only: 'dialog', extraCss: '.crucible-studio-setting span { user-select: text; }' });
  assert.ok(summarize(seeded).findings.some(finding => finding.kind === KINDS.selectableChrome), 'the seeded rule is reported');
});

test('the notices pass the selection audit, and only an error message in them is selectable', { timeout: 240000 }, async context => {
  const screens = await inChrome(context, () => runAudit({ only: 'notice' }));
  if (!screens) return;
  assert.equal(screens.length, 12, 'error toast, toast, numpad notice, paused notice, paused notice with Reload and draft notice, in two themes');
  assert.deepEqual(summarize(screens).findings.map(finding => finding.message), []);
  const selectableCount = name => screens.filter(screen => screen.name.startsWith(name)).map(screen => screen.records.filter(record => record.selectable).length);
  assert.deepEqual(selectableCount('error toast'), [1, 1], 'the error message is on the allowed list');
  assert.deepEqual(selectableCount('toast'), [0, 0], 'an ordinary toast is not');
  assert.deepEqual(selectableCount('numpad notice'), [0, 0]);
  assert.deepEqual(selectableCount('paused notice'), [0, 0, 0, 0]);
  assert.deepEqual(selectableCount('draft notice'), [0, 0]);
});

test('a drag, a double click and select all select nothing in the chrome, and text fields and opted-in blocks still select', { timeout: 240000 }, async context => {
  const checks = await inChrome(context, () => runSelectionBehavior());
  if (!checks) return;
  assert.deepEqual(checks.filter(check => !check.passed), []);
  assert.ok(checks.length >= 15);
});
