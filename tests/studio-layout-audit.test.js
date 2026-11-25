import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWLIST, runAudit, summarize, waitForSettledLayout } from '../scripts/studio-layout-audit.mjs';

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
      for (const kind of ['editing', 'error', 'long', 'long error']) expected.push(`rename ${kind} ${width} (${theme})`);
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

function pageShowing(signatures) {
  let frame = 0;
  return { frames: () => frame, evaluate: async () => signatures[Math.min(frame++, signatures.length - 1)] };
}

test('the audit measures the top bar only after its layout is the same on three frames in a row (#3443)', async () => {
  const lateCompactLayout = pageShowing(['wide', 'wide', 'compact', 'compact', 'compact']);
  await waitForSettledLayout(lateCompactLayout);
  assert.equal(lateCompactLayout.frames(), 5, 'a layout that changes on the third frame is not read before the fifth');
  const alreadySettled = pageShowing(['compact']);
  await waitForSettledLayout(alreadySettled);
  assert.equal(alreadySettled.frames(), 3, 'a steady layout needs three frames, not a fixed time');
});

test('a top bar that keeps changing makes the audit fail instead of measuring it (#3443)', async () => {
  let frame = 0;
  const neverSettles = { evaluate: async () => `frame ${frame++}` };
  await assert.rejects(() => waitForSettledLayout(neverSettles, { timeoutMs: 50 }), /still changing size/);
});
