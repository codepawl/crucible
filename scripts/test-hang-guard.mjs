// Preloaded into every test file process (node --import ./scripts/test-hang-guard.mjs, see the test scripts in package.json).
// Besides the hang guard below it gives the file a private temp folder that is removed at exit (scripts/test-private-temp.mjs, #2848).
//
// `--test-timeout` fails a test that runs too long and names it, but the file's process then stays alive for as long as
// a Chrome, a dev server or any other child it started keeps a handle open (#1320: one CI shard printed nothing for 14
// minutes until the job was cancelled). This guard adds three things:
//   1. a grace stop: a few seconds after node:test reports "test timed out after ...", the file is stopped, its children
//      are killed and it exits 1, so a hang ends right after the test's own timeout, with the test named above the file;
//   2. a file limit: when the process is still alive after CRUCIBLE_TEST_FILE_LIMIT_MS (a hang that never trips a test
//      timeout), the same stop happens;
//   3. a cleanup at exit: a child the file started and left running is killed, so a green file leaves nothing behind.
// Children are killed with their descendants: through `taskkill /T` on Windows and a walk over `ps` on Linux and macOS.
// A child started with `detached: true` on purpose is left alone at a normal exit, but not at a stop.
// Limit: all of this runs on the file's own event loop. A test that blocks the loop (a long spawnSync or execFileSync
// without a `timeout` option) is not stopped until it returns, so synchronous child calls in tests set `timeout`.
import { ChildProcess, spawnSync } from 'node:child_process';
import { installPrivateTempFolder } from './test-private-temp.mjs';

export const DEFAULT_FILE_LIMIT_MS = 660000;
export const DEFAULT_GRACE_AFTER_TIMEOUT_MS = 10000;
// setTimeout runs a longer delay after 1 ms, which would stop a healthy file at once.
const LONGEST_TIMER_MS = 2 ** 31 - 1;
const TEST_TIMEOUT_MESSAGE = /test timed out after \d+ms/;

const startedChildren = [];
const originalSpawn = ChildProcess.prototype.spawn;

// `node --test` loads preloaded modules in its own runner process too. Only the processes that run one test file are guarded.
const runsOneTestFile = process.env.NODE_TEST_CONTEXT !== undefined;

if (runsOneTestFile) {
  ChildProcess.prototype.spawn = function trackedSpawn(options) {
    const result = originalSpawn.call(this, options);
    startedChildren.push({ child: this, detached: Boolean(options?.detached) });
    return result;
  };
}

function isRunning(child) {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

// Parses `ps -A -o pid=,ppid=` output into a map from a parent to its direct children.
export function childrenByParent(psOutput) {
  const children = new Map();
  for (const line of psOutput.split('\n')) {
    const [processId, parentId] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(processId) || !Number.isInteger(parentId)) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(processId);
  }
  return children;
}

export function descendantsOf(rootProcessId, children) {
  const found = [];
  const pending = [rootProcessId];
  while (pending.length > 0) {
    for (const childId of children.get(pending.pop()) ?? []) {
      found.push(childId);
      pending.push(childId);
    }
  }
  return found;
}

function killPosixDescendants(rootProcessId) {
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000 });
  if (listing.status !== 0) return;
  for (const processId of descendantsOf(rootProcessId, childrenByParent(listing.stdout))) {
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }
}

function killTree(child, detached) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    // Descendants first: once the child dies its own children are re-parented and can no longer be found from it.
    killPosixDescendants(child.pid);
    if (detached) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group may already be gone.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have exited between the check and the kill.
  }
}

export function killStartedChildren({ includeDetached }) {
  const killedProcessIds = [];
  for (const { child, detached } of startedChildren) {
    if (!isRunning(child)) continue;
    if (detached && !includeDetached) continue;
    killedProcessIds.push(child.pid);
    killTree(child, detached);
  }
  return killedProcessIds;
}

function positiveMilliseconds(environment, name, defaultValue) {
  const raw = environment[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > LONGEST_TIMER_MS) {
    throw new Error(`${name} must be a positive number of milliseconds, at most ${LONGEST_TIMER_MS}, got "${raw}". Unset it to use ${defaultValue}.`);
  }
  return parsed;
}

export function fileLimitMilliseconds(environment = process.env) {
  return positiveMilliseconds(environment, 'CRUCIBLE_TEST_FILE_LIMIT_MS', DEFAULT_FILE_LIMIT_MS);
}

export function graceAfterTimeoutMilliseconds(environment = process.env) {
  return positiveMilliseconds(environment, 'CRUCIBLE_TEST_GRACE_AFTER_TIMEOUT_MS', DEFAULT_GRACE_AFTER_TIMEOUT_MS);
}

function describeHang(reason, killedProcessIds) {
  const killed = killedProcessIds.length === 0 ? 'none' : killedProcessIds.join(', ');
  return (
    `\nTEST FILE HUNG: ${process.argv[1] ?? 'unknown file'} ${reason} and was stopped. ` +
    `Child processes killed: ${killed}. ` +
    'The test that timed out is named above by node:test ("test timed out after ..."); run the file alone with node --test <file> to reproduce.\n'
  );
}

function stopFile(reason) {
  const killedProcessIds = killStartedChildren({ includeDetached: true });
  process.stderr.write(describeHang(reason, killedProcessIds));
  process.exit(1);
}

// node:test reports to its runner through this process's stdout, so a timed out test shows up in what is written there.
function watchForTestTimeout(graceMilliseconds) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let graceTimer;
  process.stdout.write = function writeAndWatch(chunk, ...rest) {
    if (graceTimer === undefined) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
      if (TEST_TIMEOUT_MESSAGE.test(text)) {
        graceTimer = setTimeout(() => stopFile(`was still running ${graceMilliseconds} ms after a test timed out`), graceMilliseconds);
        graceTimer.unref();
      }
    }
    return originalWrite(chunk, ...rest);
  };
}

function startWatchdog() {
  const limitMilliseconds = fileLimitMilliseconds();
  const watchdog = setTimeout(() => stopFile(`was still running after ${limitMilliseconds} ms`), limitMilliseconds);
  watchdog.unref();
  watchForTestTimeout(graceAfterTimeoutMilliseconds());
  process.on('exit', () => {
    killStartedChildren({ includeDetached: false });
  });
  // After the exit handler above, so the children that use the folder are stopped before it is removed.
  installPrivateTempFolder();
}

if (runsOneTestFile) startWatchdog();
