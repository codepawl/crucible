// `npm test` and `npm run test:coverage` go through this file so the local run caps how many test files run at
// once (scripts/test-concurrency.mjs, #3257). Every argument is passed on to `node --test` unchanged.
// Usage: node scripts/node-test.mjs [node --test options] [test files]
import { spawnSync } from 'node:child_process';
import { lowerOwnPriority } from './machine-lock.mjs';
import { testConcurrencyArguments } from './test-concurrency.mjs';

if (!process.env.CI) lowerOwnPriority();
const callerArguments = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...testConcurrencyArguments(callerArguments), ...callerArguments], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
