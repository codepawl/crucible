// One heavy local test run at a time on a machine: test:affected and preflight take this lock (#3455).
// A second run prints `waiting for <pid> <command>` and starts when the first ends. CI is not locked.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const MACHINE_LOCK_NAME = 'local-tests';
export const HELD_ENVIRONMENT_VARIABLE = 'CRUCIBLE_MACHINE_LOCK_HELD';

const DEFAULT_POLL_MILLISECONDS = 1000;
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

// Waits for the machine-wide lock and returns a release function. `command` is shown to whoever waits.
// `isPidAlive` is injectable so tests need no real second process. A nested run (the held variable is set) and CI skip it.
export async function acquireMachineLock({
  name = MACHINE_LOCK_NAME,
  command,
  lockFolder = os.tmpdir(),
  isCi = Boolean(process.env.CI),
  pollMilliseconds = DEFAULT_POLL_MILLISECONDS,
  log = message => console.log(message),
  isPidAlive: checkPidAlive = isProcessAlive,
} = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new Error('acquireMachineLock needs { command }: the text shown to a run that waits, such as "npm run test:affected".');
  }
  if (isCi || process.env[HELD_ENVIRONMENT_VARIABLE] === '1') return () => {};

  const lockPath = lockPathFor(lockFolder, name);
  let announcedPid = null;
  while (!tryCreateLockFile(lockPath, command)) {
    const holder = readHolder(lockPath);
    const holderIsGone = holder?.gone || (holder === null && isUnreadableLockOld(lockPath)) || (holder?.pid && !checkPidAlive(holder.pid));
    if (holderIsGone) {
      if (!holder?.gone) removeLockFile(lockPath);
      continue;
    }
    if (holder?.pid && announcedPid !== holder.pid) {
      log(`waiting for ${holder.pid} ${holder.command ?? ''}`.trimEnd());
      announcedPid = holder.pid;
    }
    await sleep(pollMilliseconds);
  }

  process.env[HELD_ENVIRONMENT_VARIABLE] = '1';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    process.removeListener('SIGINT', onInterrupt);
    delete process.env[HELD_ENVIRONMENT_VARIABLE];
    const holder = readHolder(lockPath);
    if (holder?.pid === process.pid) removeLockFile(lockPath);
  };
  const onInterrupt = () => {
    release();
    process.exit(130);
  };
  process.on('exit', release);
  process.on('SIGINT', onInterrupt);
  return release;
}

// The entry point of test:affected and preflight: take the lock, then lower priority for everything they spawn.
export async function lockMachineForLocalTests(command) {
  const release = await acquireMachineLock({ command });
  lowerOwnPriority();
  return release;
}
