// Decides how much of the Test workflow a pull request needs: node scripts/ci-plan.mjs
// A pull request that touches only docs, change notes, markdown, the site pages or the Studio UI runs "light": the affected
// test files in one job instead of twelve shards, the coverage gate, the bun smoke and the Cook-less leg. Any other path, or
// no paths at all, runs "full". The workflow runs this on the merge commit (needs fetch-depth 2) and needs no npm install.
// Prints mode=, reason= and tests= lines, ready to append to $GITHUB_OUTPUT.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAffectedTests } from './test-affected.mjs';
import { isMainModule, listTestFiles, repositoryRoot } from './test-run.mjs';

export const LIGHT_MODE = 'light';
export const FULL_MODE = 'full';

const GITHUB_FOLDER = /^\.github\//;
const SKILLS_FOLDER = /^skills\//;
const MARKDOWN_FILE = /\.md$/;

// A path is low risk when no shipped runtime code, build input, workflow or dependency list depends on it.
const LIGHT_PATH_RULES = [
  { name: 'docs', matches: path => path.startsWith('docs/') },
  { name: 'change notes', matches: path => path.startsWith('changes/') },
  { name: 'markdown outside skills', matches: path => MARKDOWN_FILE.test(path) && !SKILLS_FOLDER.test(path) && !GITHUB_FOLDER.test(path) },
  { name: 'site pages', matches: path => path.startsWith('site/') },
  { name: 'Studio source', matches: path => /^src\/studio(-[^/]*)?\.(js|css)$/.test(path) },
  { name: 'Studio tests', matches: path => /^tests\/studio(-[^/]*)?\.test\.js$/.test(path) },
];

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function lightRuleFor(path) {
  return LIGHT_PATH_RULES.find(rule => rule.matches(path));
}

// Pure: repo-relative paths in, { mode, reason } out. The reason names the first path that forces a full run.
export function classifyChangedFiles(paths) {
  const normalized = paths.map(toPosix).filter(Boolean);
  if (normalized.length === 0) return { mode: FULL_MODE, reason: 'no changed files were found, so everything runs' };
  const heavyPath = normalized.find(path => !lightRuleFor(path));
  if (heavyPath) return { mode: FULL_MODE, reason: `${heavyPath} is not on the low-risk list` };
  const groups = [...new Set(normalized.map(path => lightRuleFor(path).name))];
  return { mode: LIGHT_MODE, reason: `only ${groups.join(', ')} changed` };
}

const DOCUMENT_FOLDERS = ['docs/', 'changes/', 'site/'];
const STUDIO_SOURCE_PATH = /^src\/studio(-[^/]*)?\.(js|css)$/;
const STUDIO_TEST_FILE = /^tests\/studio(-[^/]*)?\.test\.js$/;

function isDocumentPath(path) {
  return DOCUMENT_FOLDERS.some(folder => path.startsWith(folder)) || path.endsWith('.md');
}

// Tests that read documents, change notes or site pages by pattern never name the one file that changed.
// These search test source text, not paths, so plain substring checks are what is meant.
function mentionsDocuments(source) {
  return DOCUMENT_FOLDERS.some(folder => source.includes(folder)) || /\.md\b/.test(source);
}

function mentionsStudioSource(source) {
  return source.includes('src/studio');
}

function testsWhere(folder, keep) {
  return listTestFiles(folder).filter(testFile => keep(testFile, readFileSync(join(folder, testFile), 'utf8')));
}

// Every test the light run needs: those that mention a changed file, plus the wide nets for documents and the Studio.
export function selectLightTests(paths, folder = repositoryRoot) {
  const normalized = paths.map(toPosix);
  const selected = new Set(findAffectedTests(normalized, folder));
  if (normalized.some(isDocumentPath)) {
    testsWhere(folder, (_testFile, source) => mentionsDocuments(source)).forEach(testFile => selected.add(testFile));
  }
  if (normalized.some(path => STUDIO_SOURCE_PATH.test(path))) {
    testsWhere(folder, (testFile, source) => STUDIO_TEST_FILE.test(testFile) || mentionsStudioSource(source)).forEach(testFile => selected.add(testFile));
  }
  return [...selected].sort();
}

function changedPathsOfMergeCommit() {
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

function main(arguments_) {
  const requested = arguments_.filter(argument => !argument.startsWith('--'));
  const changedPaths = requested.length > 0 ? requested : changedPathsOfMergeCommit();
  const { mode, reason } = classifyChangedFiles(changedPaths);
  const tests = mode === LIGHT_MODE ? selectLightTests(changedPaths) : [];
  console.log(`mode=${mode}`);
  console.log(`reason=${reason}`);
  console.log(`tests=${tests.join(' ')}`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
