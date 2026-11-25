import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { HELD_ENVIRONMENT_VARIABLE, acquireMachineLock, isProcessAlive, lowerOwnPriority } from '../scripts/machine-lock.mjs';

let lockFolder;
let heldBefore;

beforeEach(() => {
  lockFolder = mkdtempSync(join(os.tmpdir(), 'machine-lock-test-'));
  heldBefore = process.env[HELD_ENVIRONMENT_VARIABLE];
  delete process.env[HELD_ENVIRONMENT_VARIABLE];
});

afterEach(() => {
  rmSync(lockFolder, { recursive: true, force: true });
  if (heldBefore === undefined) delete process.env[HELD_ENVIRONMENT_VARIABLE];
  else process.env[HELD_ENVIRONMENT_VARIABLE] = heldBefore;
});

function lockFiles() {
  return readdirSync(lockFolder);
}

function options(extra = {}) {
  return { command: 'npm run test:affected', lockFolder, isCi: false, pollMilliseconds: 5, log: () => {}, ...extra };
}

describe('acquireMachineLock', () => {
  it('writes the pid and command, then removes the file on release', async () => {
    const release = await acquireMachineLock(options());
    assert.equal(lockFiles().length, 1);
    const holder = JSON.parse(readFileSync(join(lockFolder, lockFiles()[0]), 'utf8'));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.command, 'npm run test:affected');
    release();
    assert.deepEqual(lockFiles(), []);
  });

  it('makes a second run wait, print the waiting line once and start after the release', async () => {
    const release = await acquireMachineLock(options());
    delete process.env[HELD_ENVIRONMENT_VARIABLE];
    const lines = [];
    let secondHasLock = false;
    const second = acquireMachineLock(options({ log: line => lines.push(line), isPidAlive: () => true })).then(releaseSecond => {
      secondHasLock = true;
      return releaseSecond;
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(secondHasLock, false, 'the second run must wait while the first holds the lock');
    assert.deepEqual(lines, [`waiting for ${process.pid} npm run test:affected`]);
    release();
    const releaseSecond = await second;
    assert.equal(secondHasLock, true);
    releaseSecond();
    assert.deepEqual(lockFiles(), []);
  });

  it('clears a lock whose pid no longer runs without waiting', async () => {
    const deadPid = 2147483000;
    writeFileSync(join(lockFolder, 'crucible-machine-lock-local-tests.json'), JSON.stringify({ pid: deadPid, command: 'old run' }));
    const lines = [];
    const release = await acquireMachineLock(options({ log: line => lines.push(line), isPidAlive: pid => pid !== deadPid }));
    assert.deepEqual(lines, []);
    const holder = JSON.parse(readFileSync(join(lockFolder, lockFiles()[0]), 'utf8'));
    assert.equal(holder.pid, process.pid);
    release();
  });

  it('does nothing on CI', async () => {
    const release = await acquireMachineLock(options({ isCi: true }));
    assert.deepEqual(lockFiles(), []);
    assert.equal(process.env[HELD_ENVIRONMENT_VARIABLE], undefined);
    release();
  });

  it('lets a nested run that sees the held variable skip the lock', async () => {
    const release = await acquireMachineLock(options());
    assert.equal(process.env[HELD_ENVIRONMENT_VARIABLE], '1');
    const lines = [];
    const releaseNested = await acquireMachineLock(options({ log: line => lines.push(line), isPidAlive: () => true }));
    assert.deepEqual(lines, []);
    releaseNested();
    assert.equal(lockFiles().length, 1, 'the nested release must not free the outer lock');
    release();
    assert.deepEqual(lockFiles(), []);
    assert.equal(process.env[HELD_ENVIRONMENT_VARIABLE], undefined);
  });

  it('refuses a missing command with a message that says what to pass', async () => {
    await assert.rejects(acquireMachineLock({ lockFolder, isCi: false }), /needs \{ command \}/);
  });

  it('does not remove a lock file that another run took over', async () => {
    const release = await acquireMachineLock(options());
    const lockPath = join(lockFolder, lockFiles()[0]);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, command: 'other' }));
    release();
    assert.equal(existsSync(lockPath), true);
  });
});

describe('isProcessAlive and lowerOwnPriority', () => {
  it('sees this process as alive', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('lowers this process to below normal priority', () => {
    const before = os.getPriority(0);
    try {
      assert.equal(lowerOwnPriority(), true);
      assert.equal(os.getPriority(0), os.constants.priority.PRIORITY_BELOW_NORMAL);
    } finally {
      try {
        os.setPriority(0, before);
      } catch (error) {
        // Raising priority back may be refused; the test process ends soon anyway.
      }
    }
  });
});
