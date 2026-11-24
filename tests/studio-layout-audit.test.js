import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWLIST, runAudit, summarize } from '../scripts/studio-layout-audit.mjs';

// The audit measures the real DOM of the setup dialog in headless Chrome, as the CI runners have it. Without a browser the
// test skips, like the other Chrome tests.
async function auditSetup(context, extraCss, only = 'setup', viewport) {
  try {
    return await runAudit({ only, extraCss, viewport });
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

test('a card whose key row sits 25px from the bottom while its logo sits 8px from the top fails the audit (#3288)', { timeout: 240000 }, async context => {
  const seeded = '.crucible-studio-setup-card { padding: 8px 8px 25px; }';
  const screens = await auditSetup(context, seeded);
  if (!screens) return;
  const { findings } = summarize(screens);
  assert.ok(findings.some(finding => finding.kind === 'uneven-inset' && finding.selector.includes('crucible-studio-setup-card')), 'the unequal inset is reported');
  assert.ok(findings.some(finding => finding.kind === 'off-scale' && finding.message.includes('padding-bottom is 25 px')), 'the off-scale padding is reported');
});
test('the New scene chooser, its unsaved-changes question and the File menu with recent scenes pass the layout audit at 1280 and 720 wide (#3327)', { timeout: 240000 }, async context => {
  for (const viewport of [undefined, { width: 720, height: 720 }]) {
    const screens = await auditSetup(context, '', 'newscene', viewport);
    if (!screens) return;
    assert.equal(screens.length, 6, 'three screens in two themes');
    const { findings } = summarize(screens);
    assert.deepEqual(findings.map(finding => finding.message), [], viewport ? '720 wide' : '1280 wide');
  }
});

test('a chooser card with 25px under its name fails the audit (#3327)', { timeout: 240000 }, async context => {
  const screens = await auditSetup(context, '.crucible-studio dialog button.crucible-studio-new-card { padding: 8px 8px 25px !important; }', 'newscene');
  if (!screens) return;
  const { findings } = summarize(screens);
  assert.ok(findings.some(finding => finding.kind === 'off-scale' && finding.message.includes('padding-bottom is 25 px')), 'the off-scale padding is reported');
});
test('a Save button taller than Cancel and Discard fails the audit (#3327)', { timeout: 240000 }, async context => {
  const screens = await auditSetup(context, '.crucible-studio dialog button.crucible-studio-setup-primary { height: 39px !important; }', 'newscene');
  if (!screens) return;
  const { findings } = summarize(screens);
  assert.ok(findings.some(finding => finding.kind === 'uneven-height' && finding.message.includes('39 px')), 'the uneven button height is reported');
});
