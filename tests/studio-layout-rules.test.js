import assert from 'node:assert/strict';
import test from 'node:test';
import { INSET_TOLERANCE, KINDS, SPACING_SCALE, findSpacingProblems, insetSpread, isOnScale } from '../scripts/studio-layout-rules.mjs';

function record(overrides = {}) {
  return {
    selector: 'label.crucible-studio-setup-card',
    gaps: null,
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
    insets: { top: 16, right: 16, bottom: 16, left: 16 },
    visibleEdge: true,
    uniformPadding: true,
    childGap: 0,
    ...overrides,
  };
}

test('a card with the same inset on four sides and every value on the scale passes', () => {
  const { findings, allowed } = findSpacingProblems([record({ gaps: { row: 16, column: 16 }, childGap: 8 })]);
  assert.deepEqual(findings, []);
  assert.deepEqual(allowed, []);
});

test('the scale holds 0, 4, 8, 12, 16 and 24, plus a 2px hairline, and nothing between', () => {
  assert.deepEqual([...SPACING_SCALE], [0, 4, 8, 12, 16, 24]);
  for (const value of [0, 2, 4, 8, 12, 16, 24]) assert.equal(isOnScale(value), true, `${value}px`);
  for (const value of [1, 3, 5, 6, 10, 14, 18, 20, 25]) assert.equal(isOnScale(value), false, `${value}px`);
});

test('seeded mistake: the key row 25px from the bottom while the logo is 8px from the top fails, naming the selector and the numbers', () => {
  const card = record({ insets: { top: 8, right: 8, bottom: 25, left: 8 }, padding: { top: 8, right: 8, bottom: 8, left: 8 } });
  const { findings } = findSpacingProblems([card]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, KINDS.uneven);
  assert.match(findings[0].message, /label\.crucible-studio-setup-card/);
  assert.match(findings[0].message, /top 8, right 8, bottom 25, left 8/);
  assert.match(findings[0].message, /--studio-space-/);
});

test('insets within the tolerance pass and one pixel past it fails', () => {
  assert.equal(insetSpread({ top: 16, right: 16 + INSET_TOLERANCE, bottom: 16, left: 16 }), INSET_TOLERANCE);
  assert.deepEqual(findSpacingProblems([record({ insets: { top: 16, right: 16 + INSET_TOLERANCE, bottom: 16, left: 16 } })]).findings, []);
  assert.equal(findSpacingProblems([record({ insets: { top: 16, right: 16 + INSET_TOLERANCE + 1, bottom: 16, left: 16 } })]).findings.length, 1);
});

test('a box without a visible edge shows no inset, so it is not held to one', () => {
  const hidden = record({ visibleEdge: false, insets: { top: 0, right: 200, bottom: 0, left: 0 } });
  assert.deepEqual(findSpacingProblems([hidden]).findings, []);
});

test('a box with unequal padding keeps opposite sides level, not all four alike', () => {
  const chip = record({ uniformPadding: false, insets: { top: 9.5, right: 27, bottom: 9.5, left: 27 } });
  assert.deepEqual(findSpacingProblems([chip]).findings, []);
  const lopsided = record({ uniformPadding: false, insets: { top: 9.5, right: 40, bottom: 9.5, left: 12 } });
  assert.equal(findSpacingProblems([lopsided]).findings.length, 1);
});

test('a gap or padding off the scale fails with the nearest token', () => {
  const crowded = record({ gaps: { row: 6, column: 10 }, padding: { top: 16, right: 18, bottom: 16, left: 16 } });
  const messages = findSpacingProblems([crowded]).findings.map(finding => finding.message);
  assert.equal(messages.length, 3);
  assert.ok(messages.some(message => message.includes('row-gap is 6 px') && message.includes('--studio-space-4')));
  assert.ok(messages.some(message => message.includes('column-gap is 10 px') && message.includes('--studio-space-8')));
  assert.ok(messages.some(message => message.includes('padding-right is 18 px') && message.includes('--studio-space-16')));
});

test('the gap between groups must be at least the gap inside one', () => {
  const tight = record({ insets: null, gaps: { row: 8, column: 8 }, childGap: 12 });
  const { findings } = findSpacingProblems([tight]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, KINDS.groupGap);
  assert.deepEqual(findSpacingProblems([record({ insets: null, gaps: { row: 12, column: 12 }, childGap: 12 })]).findings, []);
});

test('a container with no gap is not held to the group-gap rule', () => {
  assert.deepEqual(findSpacingProblems([record({ insets: null, gaps: { row: 0, column: 0 }, childGap: 8 })]).findings, []);
});

test('an allowlist entry moves a finding to the allowed list with its reason, only for its own kind and selector', () => {
  const rail = record({ selector: 'div.crucible-studio-toolbar', insets: { top: 4, right: 4, bottom: 277, left: 4 } });
  const allowlist = [{ kind: KINDS.uneven, selector: 'crucible-studio-toolbar', reason: 'The rail is a full-height strip.' }];
  const { findings, allowed } = findSpacingProblems([rail], { allowlist });
  assert.deepEqual(findings, []);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].reason, 'The rail is a full-height strip.');
  const offScale = record({ selector: 'div.crucible-studio-toolbar', padding: { top: 5, right: 4, bottom: 4, left: 4 }, insets: null });
  assert.equal(findSpacingProblems([offScale], { allowlist }).findings.length, 1);
  const otherSelector = record({ selector: 'div.crucible-studio-panel', insets: { top: 4, right: 4, bottom: 277, left: 4 } });
  assert.equal(findSpacingProblems([otherSelector], { allowlist }).findings.length, 1);
});