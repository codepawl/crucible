// Gives each test file its own temp folder and removes it when the file's process exits (#2848).
//
// Tests and bench scripts make scratch folders with `mkdtemp(join(tmpdir(), ...))` and Chrome writes its user-data
// folder under the same place. Many of them never removed it, so the OS temp folder grew by tens of GB a week.
// `os.tmpdir()` reads TMPDIR, TEMP and TMP on every call, so pointing them at one private folder per test file process
// (children inherit them) makes every folder the file or its children create land in one place that is deleted at exit.
// The folder is named after the process id, so a clean-up only ever touches what this process made.
// Set CRUCIBLE_KEEP_TEST_TEMP=1 to keep the folder and read what a test wrote; its path is printed on stderr.
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PRIVATE_TEMP_PREFIX = 'crucible-test-temp-';
const TEMP_VARIABLES = ['TMPDIR', 'TEMP', 'TMP'];

export function privateTempFolderName(processId, startedAtMilliseconds) {
  return `${PRIVATE_TEMP_PREFIX}${processId}-${startedAtMilliseconds}`;
}

// Points the temp variables of `environment` at a new folder under `parentFolder` and returns the folder.
export function usePrivateTempFolder(environment, parentFolder, processId = process.pid, startedAtMilliseconds = Date.now()) {
  const folder = join(parentFolder, privateTempFolderName(processId, startedAtMilliseconds));
  mkdirSync(folder, { recursive: true });
  for (const name of TEMP_VARIABLES) environment[name] = folder;
  return folder;
}

// Retries because Windows keeps a folder locked for a moment after the Chrome or server that used it has stopped.
export function removePrivateTempFolder(folder) {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Call once, in a process that runs a single test file, after the guard has registered its own exit handler that kills
// the file's children: exit handlers run in the order they were added, so the children are gone before the folder is.
export function installPrivateTempFolder(environment = process.env) {
  const folder = usePrivateTempFolder(environment, tmpdir());
  process.on('exit', () => {
    if (environment.CRUCIBLE_KEEP_TEST_TEMP === '1') {
      process.stderr.write(`Test temp folder kept: ${folder}\n`);
      return;
    }
    try {
      removePrivateTempFolder(folder);
    } catch {
      // A locked file must not change the test result; the folder is named after this process, so a later sweep can find it.
    }
  });
  return folder;
}
