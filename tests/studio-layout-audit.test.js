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

test('a card whose key row sits 25px from the bottom while its logo sits 8px from the top fails the audit (#3288)', { timeout: 240000 }, async context => {
  const seeded = '.crucible-studio-setup-card { padding: 8px 8px 25px; }';
  const screens = await auditSetup(context, seeded);
  if (!screens) return;
  const { findings } = summarize(screens);
  assert.ok(findings.some(finding => finding.kind === 'uneven-inset' && finding.selector.includes('crucible-studio-setup-card')), 'the unequal inset is reported');
  assert.ok(findings.some(finding => finding.kind === 'off-scale' && finding.message.includes('padding-bottom is 25 px')), 'the off-scale padding is reported');
});
test('the Export workspace, before and after its actions, passes the layout audit at 1280 and 720 pixels in both themes (#3343)', { timeout: 240000 }, async context => {
  let screens;
  try {
    screens = await runAudit({ only: 'export' });
  } catch (error) {
    context.skip(`Chrome or the dev server did not start: ${String(error.message).split('\n')[0]}`);
    return;
  }
  assert.deepEqual(screens.map(screen => screen.name).sort(), [
    'export results 1280 (dark)', 'export results 1280 (light)', 'export results 720 (dark)', 'export results 720 (light)',
    'export workspace 1280 (dark)', 'export workspace 1280 (light)', 'export workspace 720 (dark)', 'export workspace 720 (light)',
  ]);
  for (const screen of screens) {
    assert.ok(screen.records.some(record => String(record.selector).includes('crucible-studio-export-group')), `${screen.name} measured the export panel`);
  }
  assert.deepEqual(summarize(screens).findings.map(finding => finding.message), []);
});
