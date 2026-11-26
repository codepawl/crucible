import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_TEST_CONCURRENCY, testConcurrency, testConcurrencyArguments } from '../scripts/test-concurrency.mjs';

// The dev PC has 28 threads, where node --test would start 27 test processes at once (#3257).
const devMachine = { environment: {}, parallelism: 28 };

test('a local run is capped at the default of 3 instead of one process per thread', () => {
  assert.equal(DEFAULT_TEST_CONCURRENCY, 3);
  assert.equal(testConcurrency(devMachine), DEFAULT_TEST_CONCURRENCY);
  assert.deepEqual(testConcurrencyArguments([], devMachine), [`--test-concurrency=${DEFAULT_TEST_CONCURRENCY}`]);
});

test('a small machine keeps what node would pick, so CI runners do not run more files at once', () => {
  assert.equal(testConcurrency({ environment: {}, parallelism: 4 }), 3);
  assert.equal(testConcurrency({ environment: {}, parallelism: 1 }), 1);
});

test('CRUCIBLE_TEST_CONCURRENCY changes the cap but never goes past the node default', () => {
  assert.equal(testConcurrency({ environment: { CRUCIBLE_TEST_CONCURRENCY: '12' }, parallelism: 28 }), 12);
  assert.equal(testConcurrency({ environment: { CRUCIBLE_TEST_CONCURRENCY: '64' }, parallelism: 28 }), 27);
  assert.equal(testConcurrency({ environment: { CRUCIBLE_TEST_CONCURRENCY: '' }, parallelism: 28 }), DEFAULT_TEST_CONCURRENCY);
});

test('a bad CRUCIBLE_TEST_CONCURRENCY says what to pass instead', () => {
  for (const value of ['0', '-2', '2.5', 'many']) {
    assert.throws(() => testConcurrency({ environment: { CRUCIBLE_TEST_CONCURRENCY: value }, parallelism: 28 }), /whole number of 1 or more/);
  }
});

test('a caller that passes its own --test-concurrency keeps it', () => {
  assert.deepEqual(testConcurrencyArguments(['--test-concurrency=2', 'tests/a.test.js'], devMachine), []);
});

test('npm test and npm run test:coverage go through the capped runner', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  for (const name of ['test', 'test:coverage']) {
    assert.match(scripts[name], /^node scripts\/node-test\.mjs /, `${name} must start with node scripts/node-test.mjs`);
  }
  const runner = readFileSync(new URL('../scripts/test-run.mjs', import.meta.url), 'utf8');
  assert.match(runner, /testConcurrencyArguments\(\[\]\)/, 'scripts/test-run.mjs (test:fast, test:affected, fast tests) must pass the cap');
});
