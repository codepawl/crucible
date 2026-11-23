import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreviewPage, pageLoadTimeoutMessage, PAGE_LOAD_TIMEOUT_MS } from '../scripts/agent-page-load.mjs';

function fakePage({ gotoMs, failWith }) {
  const calls = [];
  return {
    calls,
    async goto(origin, options) {
      calls.push({ step: 'goto', origin, timeout: options?.timeout });
      if (failWith) throw new Error(failWith);
      await new Promise(resolve => setTimeout(resolve, gotoMs));
    },
    async waitForFunction(_predicate, _argument, options) {
      calls.push({ step: 'waitForFunction', timeout: options?.timeout });
    },
  };
}

test('the page load limit is longer than the 15 s default of other page calls and bounded', () => {
  assert.ok(PAGE_LOAD_TIMEOUT_MS > 15000);
  assert.ok(Number.isFinite(PAGE_LOAD_TIMEOUT_MS) && PAGE_LOAD_TIMEOUT_MS <= 120000);
});

test('both load steps get the longer limit instead of the page default', async () => {
  const page = fakePage({ gotoMs: 1 });
  await loadPreviewPage(page, 'http://127.0.0.1:1');
  assert.deepEqual(page.calls.map(call => call.timeout), [PAGE_LOAD_TIMEOUT_MS, PAGE_LOAD_TIMEOUT_MS]);
});

test('a load timeout says the page did not load, why, and what to do', async () => {
  const page = fakePage({ failWith: 'page.goto: Timeout 2000ms exceeded.' });
  await assert.rejects(loadPreviewPage(page, 'http://127.0.0.1:1', 2000), error => {
    assert.equal(error.message, pageLoadTimeoutMessage(2000));
    assert.match(error.message, /did not load in 2 s/);
    assert.match(error.message, /machine is busy/);
    assert.match(error.message, /Retry.*lower the number of parallel/);
    assert.equal(error.pageLoadTimeout, true);
    return true;
  });
});

test('an error that is not a timeout passes through unchanged', async () => {
  const page = fakePage({ failWith: 'net::ERR_CONNECTION_REFUSED' });
  await assert.rejects(loadPreviewPage(page, 'http://127.0.0.1:1'), /ERR_CONNECTION_REFUSED/);
});
