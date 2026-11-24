import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWLIST, launchBrowser, openStudio, runAudit, startDevServer, summarize } from '../scripts/studio-layout-audit.mjs';

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

test('the Export frame is the canvas, nothing moves when a result appears, blocked controls look disabled and the narrow picture is not covered (#3343)', { timeout: 240000 }, async context => {
  let server;
  let browser;
  try {
    server = await startDevServer();
    browser = await launchBrowser();
  } catch (error) {
    await browser?.close();
    server?.stop();
    context.skip(`Chrome or the dev server did not start: ${String(error.message).split('\n')[0]}`);
    return;
  }
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 480 }]) {
      const { context: pageContext, page } = await openStudio(browser, server.origin, 'dark', '', { viewport });
      await page.evaluate(() => {
        window.__studioPage.setInspectorCollapsed(false);
        window.__studioPage.setActiveTab('export');
      });
      await page.waitForTimeout(400);
      const before = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          buttons: ['image', 'model', 'pack'].map(kind => rect(`[data-export="${kind}"]`)),
          facts: [...document.querySelectorAll('.crucible-studio-export-facts')].map(element => element.getBoundingClientRect().height),
        };
      });
      await page.evaluate(async () => {
        for (const kind of ['image', 'model', 'pack']) {
          document.querySelector(`[data-export="${kind}"]`).click();
          await new Promise(resolveWait => setTimeout(resolveWait, 300));
        }
      });
      const after = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        const inspector = rect('.crucible-studio-inspector');
        return {
          buttons: ['image', 'model', 'pack'].map(kind => rect(`[data-export="${kind}"]`)),
          facts: [...document.querySelectorAll('.crucible-studio-export-facts')].map(element => element.getBoundingClientRect().height),
          canvas: rect('.crucible-studio canvas'),
          guide: rect('.crucible-studio-export-guide'),
          viewport: rect('.crucible-studio-viewport'),
          inspector,
          gridButton: (() => {
            const button = document.querySelector('[aria-label="Show or hide the grid"]');
            return button ? { disabled: button.getAttribute('aria-disabled'), background: getComputedStyle(button).backgroundColor } : null;
          })(),
        };
      });
      assert.deepEqual(after.buttons, before.buttons, `${viewport.width}: the buttons stay where they were when results appear`);
      assert.deepEqual(after.facts, before.facts, `${viewport.width}: the facts keep their rows`);
      assert.deepEqual(after.gridButton, { disabled: 'true', background: 'rgba(0, 0, 0, 0)' }, `${viewport.width}: the grid toggle looks disabled and not pressed`);
      assert.deepEqual(after.guide, after.canvas, `${viewport.width}: the frame encloses exactly the canvas pixels`);
      if (viewport.width < 820) {
        assert.ok(after.viewport.right <= after.inspector.left, `${viewport.width}: the panel sits beside the picture, not over it`);
      }
      await pageContext.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }
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
