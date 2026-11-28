#!/usr/bin/env node
// Traces which files can change what the Cook addon job tests, so the workflow runs only for those (#1796, #3415).
// It starts at every test whose import statements load tests/support/cook.js (not a mention in text, #1830), follows relative static imports and `import('./literal')` calls,
// and either prints the traced workflow path lines or decides `--should-run` for a list of changed files.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsFile } from './import-specifiers.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COOK_SUPPORT_FILE = 'tests/support/cook.js';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Infrastructure, package, and workflow files that always affect the Cook addon job even when not imported by a test.
export const ALWAYS_RUN_PATHS = new Set([
  'package.json',
  'package-lock.json',
  '.github/workflows/cook-addon.yml',
  'bin/crucible-mcp.mjs',
  'bin/crucible-oidn-fetch.mjs',
  'scripts/addon-job-paths.mjs',
  'scripts/agent-memory-guard.mjs',
  'scripts/build-mcp.mjs',
  'scripts/check-first-native-job.mjs',
  'scripts/cook-addon-cache-key.mjs',
  'scripts/import-specifiers.mjs',
  'scripts/scratch-directory.mjs',
  'scripts/summarize-addon-tests.mjs',
  'scripts/test-hang-guard.mjs',
  'tests/addon-job-paths.test.js',
  'tests/cook-addon-cache-key.test.js',
  'tests/fixtures/demo-room.recipe.json',
]);

export const ALWAYS_RUN_PREFIXES = Object.freeze([
  'packages/denoise-oidn/',
  '.github/actions/setup/',
]);

// `from '...'`, bare `import '...'`, `import('...')` and `require('...')` with a relative literal path.
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

// Tests also start scripts and read sources by a literal repository path, for example join(root, 'scripts/native-png.mjs').
const PATH_LITERAL_PATTERN = /['"`](?:\.\.?\/)*((?:scripts|src|bench|packages)\/[\w./-]+\.(?:m?js|cjs))['"`]/g;

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function defaultRunGit(args, cwd = repositoryRoot) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

/** Test files whose real import statements load the Cook helper; a mention in a string or comment does not count. */
export function addonTestFiles(
  testFiles = gitLines(['ls-files', 'tests']).filter((file) => /\.(m?js|cjs)$/.test(file)),
  readSource = (file) => readFileSync(join(repositoryRoot, file), 'utf8'),
) {
  return testFiles
    .filter((file) => file !== COOK_SUPPORT_FILE)
    .filter((file) => importsFile(readSource(file), file, COOK_SUPPORT_FILE))
    .sort();
}

function resolveImport(importerPath, specifier, fileExists) {
  const target = toPosix(join(dirname(importerPath), specifier));
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}/index.js`];
  return candidates.find((candidate) => /\.(m?js|cjs)$/.test(candidate) && fileExists(candidate)) ?? null;
}

/** Every repository file the addon tests reach through relative imports, including the tests themselves. Sorted. */
export function traceAddonFiles(
  entryFiles = [...addonTestFiles(), COOK_SUPPORT_FILE],
  {
    readSource = (file) => readFileSync(join(repositoryRoot, file), 'utf8'),
    fileExists = (file) => existsSync(join(repositoryRoot, file)),
  } = {},
) {
  const reached = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const current = queue.pop();
    if (reached.has(current) || !fileExists(current)) continue;
    reached.add(current);
    const source = readSource(current);
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveImport(current, match[2], fileExists);
      if (resolved !== null) queue.push(resolved);
    }
    for (const match of source.matchAll(PATH_LITERAL_PATTERN)) {
      if (fileExists(match[1])) queue.push(match[1]);
    }
  }
  return [...reached].sort();
}

export function isAlwaysRunPath(filePath) {
  const normalized = toPosix(filePath);
  return ALWAYS_RUN_PATHS.has(normalized) || ALWAYS_RUN_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Decides whether the Cook addon job needs to run for a list of changed repository paths. */
export function shouldRunAddonJob(changedPaths, tracedFiles = traceAddonFiles()) {
  const normalized = changedPaths.map(toPosix).filter(Boolean);
  if (normalized.length === 0) {
    return { run: true, matches: [], reason: 'no changed files were found, running as a safeguard' };
  }
  const tracedSet = new Set(tracedFiles.map(toPosix));
  const matches = normalized.filter((file) => tracedSet.has(file) || isAlwaysRunPath(file));
  if (matches.length > 0) {
    const preview = matches.slice(0, 5).join(', ');
    const suffix = matches.length > 5 ? `, and ${matches.length - 5} more` : '';
    return { run: true, matches, reason: `matched ${matches.length} addon path(s): ${preview}${suffix}` };
  }
  return { run: false, matches: [], reason: `none of ${normalized.length} changed file(s) reach Cook addon tests` };
}

function commitExists(reference, runGit) {
  return runGit(['rev-parse', '--verify', '--quiet', `${reference}^{commit}`]).status === 0;
}

function pullRequestMergeBase(runGit) {
  const parentsResult = runGit(['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (parentsResult.status !== 0) return null;
  const parents = parentsResult.stdout.trim().split(/\s+/);
  return parents.length === 3 ? parents[1] : null;
}

function eventPullRequestBaseSha(eventPath) {
  if (!eventPath || !existsSync(eventPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(eventPath, 'utf8'));
    return payload?.pull_request?.base?.sha ?? null;
  } catch {
    return null;
  }
}

function resolveComparisonBase({ baseRef, eventPath, runGit }) {
  if (baseRef) {
    if (!commitExists(baseRef, runGit)) {
      runGit(['fetch', '--no-tags', '--depth=1', 'origin', baseRef]);
    }
    if (commitExists(baseRef, runGit)) {
      const mergeBase = runGit(['merge-base', baseRef, 'HEAD']);
      return mergeBase.status === 0 ? mergeBase.stdout.trim() : baseRef;
    }
    return pullRequestMergeBase(runGit);
  }
  const mergeParent = pullRequestMergeBase(runGit);
  if (mergeParent) return mergeParent;
  const eventBaseSha = eventPullRequestBaseSha(eventPath);
  if (eventBaseSha) {
    if (!commitExists(eventBaseSha, runGit)) {
      runGit(['fetch', '--no-tags', '--depth=1', 'origin', eventBaseSha]);
    }
    if (commitExists(eventBaseSha, runGit)) return eventBaseSha;
  }
  if (commitExists('origin/main', runGit)) {
    const mergeBase = runGit(['merge-base', 'origin/main', 'HEAD']);
    return mergeBase.status === 0 ? mergeBase.stdout.trim() : 'origin/main';
  }
  return commitExists('HEAD^1', runGit) ? 'HEAD^1' : null;
}

/** Lists repository paths changed relative to the pull request base commit, or null when git cannot determine them. */
export function changedFilesFromGit({
  baseRef = null,
  eventPath = process.env.GITHUB_EVENT_PATH ?? null,
  runGit = (args) => defaultRunGit(args),
} = {}) {
  const comparisonBase = resolveComparisonBase({ baseRef, eventPath, runGit });
  if (!comparisonBase) return null;
  const diffResult = runGit(['diff', '--name-only', '--no-renames', comparisonBase, 'HEAD']);
  if (diffResult.status !== 0) return null;
  return diffResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseArguments(argv) {
  let checkChanged = false;
  let baseRef = null;
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--should-run' || argument === '--check-changed') {
      checkChanged = true;
    } else if (argument === '--base') {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Pass a branch or commit after --base, such as --base origin/main.');
      }
      baseRef = next;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown flag: ${argument}. Use --should-run (or --check-changed) and optional --base <ref>.`);
    } else {
      files.push(argument);
    }
  }
  return { checkChanged, baseRef, files };
}

function main() {
  const { checkChanged, baseRef, files } = parseArguments(process.argv.slice(2));
  if (!checkChanged) {
    const traced = traceAddonFiles();
    const tracedSource = traced.filter((file) => file.startsWith('src/'));
    const allSource = gitLines(['ls-files', 'src']);
    for (const file of traced) console.log(`      - '${file}'`);
    console.error(`traced ${traced.length} files, ${tracedSource.length} of ${allSource.length} src files`);
    return;
  }
  const changed = files.length > 0 ? files : changedFilesFromGit({ baseRef });
  const decision = changed === null
    ? { run: true, matches: [], reason: 'could not determine changed files from git, running as a safeguard' }
    : shouldRunAddonJob(changed);
  console.log(`run=${decision.run}`);
  console.log(`reason=${decision.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
