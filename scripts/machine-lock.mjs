// One heavy local test run at a time on a machine: test:affected and preflight take this lock (#3455).
// A second run prints `waiting for <pid> <command>` and starts when the first ends. CI is not locked.
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const MACHINE_LOCK_NAME = 'local-tests';
export const HELD_ENVIRONMENT_VARIABLE = 'CRUCIBLE_MACHINE_LOCK_HELD';

const DEFAULT_POLL_MILLISECONDS = 1000;
// A pid can be reused by an unrelated process after a crash, which would look held forever; a lock this old is stale.
const DEFAULT_MAXIMUM_AGE_MILLISECONDS = 2 * 60 * 60 * 1000;
// A lock file that stays empty or unreadable this long was left by a run that died while writing it.
const UNREADABLE_LOCK_MAXIMUM_AGE_MILLISECONDS = 10000;

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockPathFor(lockFolder, name) {
  return join(lockFolder, `crucible-machine-lock-${name.replace(/\W+/g, '-')}.json`);
}

function readHolder(lockPath) {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    return Number.isInteger(holder.pid) ? holder : null;
  } catch (error) {
    if (error.code === 'ENOENT') return { gone: true };
    return null;
  }
}

function isUnreadableLockOld(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > UNREADABLE_LOCK_MAXIMUM_AGE_MILLISECONDS;
  } catch (error) {
    return false;
  }
}

function removeLockFile(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function tryCreateLockFile(lockPath, command) {
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(descriptor);
  }
  return true;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Lowers this process so every child it spawns inherits below-normal priority (Windows children keep the priority class,
// so this reaches node even when `shell: true` starts cmd.exe first). Returns false when the platform refuses.
export function lowerOwnPriority() {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch (error) {
    return false;
  }
}

let staleCounter = 0;

function isTooOld(holder, maximumAgeMilliseconds) {
  const startedAt = Date.parse(holder.startedAt ?? '');
  return Number.isFinite(startedAt) && Date.now() - startedAt > maximumAgeMilliseconds;
}

// Removes a lock file seen as stale without ever deleting a live lock that another waiter created in between:
// the file is renamed to a name only this call uses, read back, and deleted only when it still holds the pid we judged dead.
// A live lock caught by mistake is linked back to its path.
function clearStaleLock(lockPath, staleHolder) {
  staleCounter += 1;
  const claimedPath = `${lockPath}.stale-${process.pid}-${staleCounter}`;
  try {
    renameSync(lockPath, claimedPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const claimed = readHolder(claimedPath);
  const stillTheStaleLock = claimed && !claimed.gone && claimed.pid === staleHolder.pid && claimed.startedAt === staleHolder.startedAt;
  if (!stillTheStaleLock && claimed !== null) {
    try {
      linkSync(claimedPath, lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  removeLockFile(claimedPath);
}

function isHeldByAncestor(lockPath, checkPidAlive) {
  const ownerPid = Number(process.env[HELD_ENVIRONMENT_VARIABLE]);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !checkPidAlive(ownerPid)) return false;
  return readHolder(lockPath)?.pid === ownerPid;
}

// Waits for the machine-wide lock and returns a release function. `command` is shown to whoever waits.
// `isPidAlive` is injectable so tests need no real second process; `beforeStaleClear` lets a test interleave two waiters.
// CI skips the lock. So does a nested run: the held variable holds the owner's pid, which must be alive and be the one in the lock file.
export async function acquireMachineLock({
  name = MACHINE_LOCK_NAME,
  command,
  lockFolder = os.tmpdir(),
  isCi = Boolean(process.env.CI),
  pollMilliseconds = DEFAULT_POLL_MILLISECONDS,
  maximumAgeMilliseconds = DEFAULT_MAXIMUM_AGE_MILLISECONDS,
  log = message => console.log(message),
  isPidAlive: checkPidAlive = isProcessAlive,
  beforeStaleClear = async () => {},
} = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new Error('acquireMachineLock needs { command }: the text shown to a run that waits, such as "npm run test:affected".');
  }
  if (isCi) return () => {};
  const lockPath = lockPathFor(lockFolder, name);
  if (isHeldByAncestor(lockPath, checkPidAlive)) return () => {};

  let announcedPid = null;
  while (!tryCreateLockFile(lockPath, command)) {
    const holder = readHolder(lockPath);
    if (holder?.gone) continue;
    const isStale = holder === null
      ? isUnreadableLockOld(lockPath)
      : !checkPidAlive(holder.pid) || isTooOld(holder, maximumAgeMilliseconds);
    if (isStale) {
      await beforeStaleClear(holder);
      if (holder) clearStaleLock(lockPath, holder);
      else removeLockFile(lockPath);
      continue;
    }
    if (holder && announcedPid !== holder.pid) {
      log(`waiting for ${holder.pid} ${holder.command ?? ''} (lock file ${lockPath})`);
      announcedPid = holder.pid;
    }
    await sleep(pollMilliseconds);
  }

  process.env[HELD_ENVIRONMENT_VARIABLE] = String(process.pid);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    delete process.env[HELD_ENVIRONMENT_VARIABLE];
    const holder = readHolder(lockPath);
    if (holder?.pid === process.pid) removeLockFile(lockPath);
  };
  const onInterrupt = () => {
    release();
    process.exit(130);
  };
  const onTerminate = () => {
    release();
    process.exit(143);
  };
  process.on('exit', release);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return release;
}

// The entry point of test:affected and preflight: take the lock, then lower priority for everything they spawn.
// CI gets neither, so it runs exactly as before.
export async function lockMachineForLocalTests(command) {
  if (process.env.CI) return () => {};
  const release = await acquireMachineLock({ command });
  lowerOwnPriority();
  return release;
}
