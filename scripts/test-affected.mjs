// Runs every tests/*.test.js that mentions one of the given source files, by name, or reaches one of them through the import graph.
// Usage: npm run test:affected -- src/foo.js scripts/bar.mjs
//        npm run test:affected            with no files, uses the files changed since origin/main (as preflight does)
import { basename } from 'node:path';
import { buildImportGraph } from './import-graph.mjs';
import { lockMachineForLocalTests } from './machine-lock.mjs';
import { changedPathsSince } from './preflight.mjs';
import { isMainModule, listTestFiles, repositoryRoot, runTestFiles } from './test-run.mjs';

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One pattern for all names: a name starts after a path separator, a quote or whitespace.
function mentionPattern(filePaths) {
  const names = new Set(filePaths.map(filePath => escapeForPattern(basename(filePath))));
  return new RegExp(`(^|[/'"\`\\s])(?:${[...names].join('|')})`);
}

// Test files (repo-relative, sorted) that reach a changed file through imports or re-exports of any depth, or that name a
// changed file or a file that reaches it (a script they spawn or read by path).
export function findAffectedTests(sourcePaths, folder = repositoryRoot) {
  const graph = buildImportGraph(folder);
  const reached = graph.reachedFrom(sourcePaths.map(toPosix));
  const pattern = mentionPattern([...reached]);
  return listTestFiles(folder).filter(testFile => reached.has(testFile) || pattern.test(graph.sourceOf(testFile)));
}

export function parseAffectedArguments(arguments_) {
  let baseRef = 'origin/main';
  const files = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--base') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--base needs a git ref such as origin/main.');
      baseRef = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--base=')) {
      const value = argument.slice('--base='.length);
      if (!value) throw new Error('--base needs a git ref such as origin/main.');
      baseRef = value;
      continue;
    }
    if (!argument.startsWith('--')) files.push(argument);
  }
  return { baseRef, files };
}

async function main(arguments_) {
  const { baseRef, files } = parseAffectedArguments(arguments_);
  const sourcePaths = files.length > 0 ? files : changedPathsSince(baseRef);
  if (sourcePaths.length === 0) {
    console.log(`No files changed since ${baseRef}; skipping affected tests.`);
    return;
  }
  const affected = findAffectedTests(sourcePaths);
  if (affected.length === 0) {
    console.log(`No test file mentions ${sourcePaths.length} changed file(s). Name the files to check: npm run test:affected -- <files...>`);
    return;
  }
  console.log(`Running ${affected.length} test file(s) that mention ${sourcePaths.length} file(s).`);
  await lockMachineForLocalTests('npm run test:affected');
  process.exit(runTestFiles(affected).code);
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
