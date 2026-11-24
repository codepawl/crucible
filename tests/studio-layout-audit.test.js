import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWLIST, runAudit, summarize } from '../scripts/studio-layout-audit.mjs';

// The audit measures the real DOM of the setup dialog in headless Chrome, as the CI runners have it. Without a browser the
// test skips, like the other Chrome tests.
async function auditSetup(context, extraCss) {
  try {
    return await runAudit({ only: 'setup', extraCss });
  } catch (error) {
    context.skip(`Chrome or the dev server did not start: ${String(error.message).split('\n')[0]}`);
    return null;
  }
}

test('the setup dialog passes the layout audit in both themes and its allowlist stays short (#3288)', { timeout: 240000 }, async context => {
  const screens = await auditSetup(context);
  if (!screens) return;
  assert.equal(screens.length, 10, 'five steps in two themes');
  const { findings } = summarize(screens);
  assert.deepEqual(findings.map(finding => finding.message), []);
  assert.ok(ALLOWLIST.length <= 5, 'a real finding is fixed in the CSS, not listed');
  for (const entry of ALLOWLIST) assert.ok(entry.reason.length > 20, `${entry.selector} says why`);
});

test('the top bar with the scene name editor open, with an error and with a 60 character name passes the layout audit and overlaps nothing at 1280, 921, 919 and 720 px in both themes (#3344)', { timeout: 420000 }, async context => {
  let screens;
  try {
    screens = await runAudit({ only: 'rename' });
  } catch (error) {
    context.skip(`Chrome or the dev server did not start: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const expected = [];
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 921, 919, 720]) {
      for (const kind of ['editing', 'error', 'long']) expected.push(`rename ${kind} ${width} (${theme})`);
    }
  }
  assert.deepEqual(screens.map(screen => screen.name).sort(), expected.sort());
  assert.deepEqual(summarize(screens).findings.map(finding => finding.message), []);
  const overlaps = screens.flatMap(screen => (screen.overlaps ?? []).map(problem => `${screen.name}: ${problem}`));
  assert.deepEqual(overlaps, [], 'the name and its reason overlap nothing in the top bar');
});

test('a card whose key row sits 25px from the bottom while its logo sits 8px from the top fails the audit (#3288)', { timeout: 240000 }, async context => {
  const seeded = '.crucible-studio-setup-card { padding: 8px 8px 25px; }';
  const screens = await auditSetup(context, seeded);
  if (!screens) return;
  const { findings } = summarize(screens);
  assert.ok(findings.some(finding => finding.kind === 'uneven-inset' && finding.selector.includes('crucible-studio-setup-card')), 'the unequal inset is reported');
  assert.ok(findings.some(finding => finding.kind === 'off-scale' && finding.message.includes('padding-bottom is 25 px')), 'the off-scale padding is reported');
});