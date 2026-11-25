// Runs every tests/*.test.js that mentions one of the given source files, by name, or reaches one of them through the import graph.
// Usage: npm run test:affected -- src/foo.js scripts/bar.mjs
//        npm run test:affected            with no files, uses the files changed since origin/main (as preflight does)
import { basename } from 'node:path';
import { buildImportGraph } from './import-graph.mjs';
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

async function main(arguments_) {
  const requested = arguments_.filter(argument => !argument.startsWith('--'));
  const sourcePaths = requested.length > 0 ? requested : changedPathsSince('origin/main');
  const affected = findAffectedTests(sourcePaths);
  if (affected.length === 0) {
    console.log(`No test file mentions ${sourcePaths.length} changed file(s). Name the files to check: npm run test:affected -- <files...>`);
    return;
  }
  console.log(`Running ${affected.length} test file(s) that mention ${sourcePaths.length} file(s).`);
  process.exit(runTestFiles(affected).code);
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
