// A scratch folder for a script or bench run that removes itself when the process exits (#2848).
//
// Smoke and bench scripts used `mkdtemp(join(tmpdir(), 'crucible-...'))` and left the folder behind on every run, so
// the OS temp folder grew by gigabytes (job outputs, rendered frames, packed tarballs). Use this instead.
// It also removes the folder when the script ends through `process.exit()` or a thrown error, because it runs on exit.
// Set CRUCIBLE_KEEP_TEMP=1 to keep the folder to inspect what a run wrote; its path is printed on stderr.
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratchDirectories = new Set();
let exitHandlerInstalled = false;

function removeScratchDirectories() {
  for (const directory of scratchDirectories) {
    if (process.env.CRUCIBLE_KEEP_TEMP === '1') {
      process.stderr.write(`Scratch folder kept: ${directory}\n`);
      continue;
    }
    try {
      // Retries because Windows keeps a folder locked for a moment after the child that used it has stopped.
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A locked file must not change the script's exit code.
    }
  }
  scratchDirectories.clear();
}

// Makes `<temp folder>/<prefix>XXXXXX` (or under `parentFolder`) and returns its path.
export async function createScratchDirectory(prefix, parentFolder = tmpdir()) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('createScratchDirectory needs a prefix such as "crucible-smoke-" so a leftover folder can be traced to its script.');
  }
  const directory = await mkdtemp(join(parentFolder, prefix));
  scratchDirectories.add(directory);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', removeScratchDirectories);
  }
  return directory;
}
