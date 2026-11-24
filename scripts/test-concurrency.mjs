// How many test files node --test runs at once. Node's default is availableParallelism() - 1, which is 27 node
// processes on a 28-thread PC; several worktrees running the suite at once then exhaust memory (#3257).
// CRUCIBLE_TEST_CONCURRENCY overrides the default; the count never exceeds what Node itself would pick.
import { availableParallelism } from 'node:os';

export const DEFAULT_TEST_CONCURRENCY = 6;
export const TEST_CONCURRENCY_VARIABLE = 'CRUCIBLE_TEST_CONCURRENCY';

export function testConcurrency({ environment = process.env, parallelism = availableParallelism() } = {}) {
  const nodeDefault = Math.max(1, parallelism - 1);
  const raw = environment[TEST_CONCURRENCY_VARIABLE];
  if (raw === undefined || raw === '') return Math.min(DEFAULT_TEST_CONCURRENCY, nodeDefault);
  const requested = Number(raw);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`${TEST_CONCURRENCY_VARIABLE} must be a whole number of 1 or more, got "${raw}". Unset it to use ${DEFAULT_TEST_CONCURRENCY}.`);
  }
  return Math.min(requested, nodeDefault);
}

// The flag to put before the test files, or nothing when the caller already passed its own --test-concurrency.
export function testConcurrencyArguments(callerArguments, options) {
  if (callerArguments.some(argument => argument.startsWith('--test-concurrency'))) return [];
  return [`--test-concurrency=${testConcurrency(options)}`];
}
