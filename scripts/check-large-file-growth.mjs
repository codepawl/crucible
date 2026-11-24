// Warns when a branch adds lines to a src/*.js file that is already over 1500 lines at the merge base (#3402).
// Usage: npm run check:large-file-growth [-- --base <ref>]      (also a step of `npm run preflight`)
// Parallel pull requests collide in a few huge files, so a feature belongs in its own registered module (#3381).
// This rule prints a warning and exits 0. Making it fail is the work of #3405, which changes `main` to exit 1.
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

// `files` are { path, baseLines, headLines }; baseLines is null for a file the branch adds. Returns one warning line per file
// that is over the limit and grew (a new file counts from zero). Pure, and it never throws, so a warning cannot fail the run.
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

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function readHeadLines(path) {
  try {
    return lineCount(readFileSync(resolve(root, path), 'utf8'));
  } catch {
    return 0;
  }
}

export function changedLargeFileCandidates(baseRef) {
  const mergeBase = (git(['merge-base', baseRef, 'HEAD']) ?? baseRef).trim();
  const changed = (git(['diff', '--name-only', '--no-renames', mergeBase, '--', 'src']) ?? '').split('\n');
  const untracked = (git(['ls-files', '--others', '--exclude-standard', 'src']) ?? '').split('\n');
  return [...new Set([...changed, ...untracked])]
    .filter(path => path && isLargeFileCandidate(path))
    .map((path) => {
      const baseText = git(['show', `${mergeBase}:${path}`]);
      return { path, baseLines: baseText === null ? null : lineCount(baseText), headLines: readHeadLines(path) };
    });
}

function main(args) {
  const flagIndex = args.indexOf('--base');
  const baseRef = flagIndex < 0 ? 'origin/main' : args[flagIndex + 1];
  const warnings = largeFileGrowthWarnings(changedLargeFileCandidates(baseRef));
  for (const warning of warnings) console.log(`warning: ${warning}`);
  if (warnings.length === 0) console.log(`No src/*.js file over ${LARGE_FILE_LINE_LIMIT} lines grew (compared with ${baseRef}).`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main(process.argv.slice(2));
