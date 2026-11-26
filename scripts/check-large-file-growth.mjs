// Fails when a branch adds lines to a src/*.js file that is already over 1500 lines at the merge base (#3402, #3405).
// Usage: npm run check:large-file-growth [-- --base <ref>]      (also a step of `npm run preflight`)
// Parallel pull requests collide in a few huge files, so a feature belongs in its own registered module (#3381).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const LARGE_FILE_LINE_LIMIT = 1500;
const SOURCE_FILE = /^src\/[^/]+\.js$/;

export function isLargeFileCandidate(path) {
  return SOURCE_FILE.test(path.replace(/\\/g, '/'));
}

// `files` are { path, baseLines, headLines }; baseLines is null for a file the branch adds. Returns one line per file
// that is over the limit and grew (a new file counts from zero). Pure, and it never throws.
export function largeFileGrowthWarnings(files) {
  return files
    .filter(({ path, baseLines, headLines }) => {
      if (!isLargeFileCandidate(path)) return false;
      const overLimit = (baseLines ?? headLines) > LARGE_FILE_LINE_LIMIT;
      return overLimit && headLines > (baseLines ?? 0);
    })
    .map(({ path, baseLines, headLines }) => {
      const before = baseLines === null ? 'new file' : `${baseLines} lines at the base`;
      return `${path}: ${before}, ${headLines} now (limit ${LARGE_FILE_LINE_LIMIT}). Add the feature as its own registered module instead of growing this file, see #3381.`;
    });
}

function git(args, folder = root) {
  const result = spawnSync('git', args, { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function readHeadLines(path, folder = root) {
  try {
    return lineCount(readFileSync(resolve(folder, path), 'utf8'));
  } catch {
    return 0;
  }
}

export function changedLargeFileCandidates(baseRef, folder = root) {
  const mergeBase = (git(['merge-base', baseRef, 'HEAD'], folder) ?? baseRef).trim();
  const changed = (git(['diff', '--name-only', '--no-renames', mergeBase, '--', 'src'], folder) ?? '').split(/\r?\n/);
  const untracked = (git(['ls-files', '--others', '--exclude-standard', 'src'], folder) ?? '').split(/\r?\n/);
  return [...new Set([...changed, ...untracked])]
    .filter(path => path && isLargeFileCandidate(path))
    .map((path) => {
      const baseText = git(['show', `${mergeBase}:${path}`], folder);
      return { path, baseLines: baseText === null ? null : lineCount(baseText), headLines: readHeadLines(path, folder) };
    });
}

export function runLargeFileGrowthCheck(args, {
  folder = root,
  writeOut = line => console.log(line),
  writeError = line => console.error(line),
} = {}) {
  const flagIndex = args.indexOf('--base');
  const baseRef = flagIndex < 0 ? 'origin/main' : args[flagIndex + 1];
  const failures = largeFileGrowthWarnings(changedLargeFileCandidates(baseRef, folder));
  for (const failure of failures) writeError(failure);
  if (failures.length > 0) return 1;
  writeOut(`No src/*.js file over ${LARGE_FILE_LINE_LIMIT} lines grew (compared with ${baseRef}).`);
  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.exitCode = runLargeFileGrowthCheck(process.argv.slice(2));
}
