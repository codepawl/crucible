import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildImportGraph } from '../scripts/import-graph.mjs';
import { findAffectedTests, parseAffectedArguments } from '../scripts/test-affected.mjs';
import { sampleTestFiles } from '../scripts/test-fast.mjs';
import { buildCompactReport } from '../scripts/test-compact-reporter.mjs';
import { findBlockingChanges, parseArguments, runMutationCheck } from '../scripts/test-mutation-check.mjs';
import { listTestFiles, runTestFiles } from '../scripts/test-run.mjs';

function git(folder, ...arguments_) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...arguments_], { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(folder, path, text) {
  mkdirSync(join(folder, path, '..'), { recursive: true });
  writeFileSync(join(folder, path), text);
}

// A tiny repository: src/value.js exports a number, tests/value.test.js pins it, one commit on main.
function makeRepository() {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-test-commands-'));
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'core.autocrlf', 'false');
  write(folder, 'src/value.js', 'export const value = 1;\n');
  write(folder, 'src/index.js', "export { value } from './value.js';\n");
  write(folder, 'tests/value.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.js';\ntest('value is two', () => assert.equal(value, 2));\n");
  write(folder, 'tests/index.test.js', "import test from 'node:test';\nimport { value } from '../src/index.js';\ntest('index exports value', () => value);\n");
  write(folder, 'tests/other.test.js', "import test from 'node:test';\ntest('unrelated', () => {});\n");
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'base');
  git(folder, 'checkout', '-q', '-b', 'fix');
  return folder;
}

test('affected tests equal a manual grep over tests/ for a one-file change', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const target = 'scripts/shard-test-files.mjs';
  const manual = listTestFiles(root).filter(file => readFileSync(join(root, file), 'utf8').includes('shard-test-files.mjs'));
  assert.ok(manual.length > 0);
  assert.deepEqual(findAffectedTests([target], root), manual);
});

test('affected tests follow one level of re-export and skip unrelated tests', () => {
  const folder = makeRepository();
  try {
    assert.deepEqual(buildImportGraph(folder).importersOf('src/value.js').sort(), ['src/index.js', 'tests/value.test.js']);
    assert.deepEqual(findAffectedTests(['src/value.js'], folder), ['tests/index.test.js', 'tests/value.test.js']);
    assert.deepEqual(findAffectedTests(['tests/other.test.js'], folder), ['tests/other.test.js']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('affected tests reach a changed file through a two-step import chain', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/leaf.js', 'export const leaf = 1;\n');
    write(folder, 'src/middle.js', "import { leaf } from './leaf.js';\nexport const middle = leaf + 1;\n");
    write(folder, 'src/top.js', "export * from './middle.js';\n");
    write(folder, 'tests/top.test.js', "import test from 'node:test';\nimport { middle } from '../src/top.js';\ntest('top', () => middle);\n");
    write(folder, 'tests/spawns.test.js', "import test from 'node:test';\ntest('spawns', () => ['scripts/run-leaf.mjs']);\n");
    write(folder, 'scripts/run-leaf.mjs', "import { leaf } from '../src/leaf.js';\nconsole.log(leaf);\n");
    assert.deepEqual(findAffectedTests(['src/leaf.js'], folder), ['tests/spawns.test.js', 'tests/top.test.js']);
    assert.deepEqual(findAffectedTests(['src/middle.js'], folder), ['tests/top.test.js']);
    assert.deepEqual(findAffectedTests(['src/top.js'], folder), ['tests/top.test.js']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the import graph walks every step of a chain, not one level', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/leaf.js', 'export const leaf = 1;\n');
    write(folder, 'src/middle.js', "import { leaf } from './leaf.js';\nexport const middle = leaf;\n");
    write(folder, 'src/top.js', "export * from './middle.js';\n");
    write(folder, 'tests/top.test.js', "import { middle } from '../src/top.js';\nmiddle;\n");
    const reached = buildImportGraph(folder).reachedFrom(['src/leaf.js']);
    assert.deepEqual([...reached].sort(), ['src/leaf.js', 'src/middle.js', 'src/top.js', 'tests/top.test.js']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('affected tests follow a new URL reference in the middle of an import chain', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/target.js', 'export const target = 1;\n');
    write(folder, 'src/loader.js', "export const targetUrl = new URL('./target.js', import.meta.url);\n");
    write(folder, 'tests/loader.test.js', "import test from 'node:test';\nimport { targetUrl } from '../src/loader.js';\ntest('loader', () => targetUrl);\n");
    assert.deepEqual(findAffectedTests(['src/target.js'], folder), ['tests/loader.test.js']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the fast sample is about ten percent, repeatable per seed and different across seeds', () => {
  const files = Array.from({ length: 200 }, (_, index) => `tests/file-${index}.test.js`);
  const sample = sampleTestFiles(files, 'branch-a');
  assert.equal(sample.length, 20);
  assert.deepEqual(sampleTestFiles(files, 'branch-a'), sample);
  assert.notDeepEqual(sampleTestFiles(files, 'branch-b'), sample);
  assert.equal(sampleTestFiles(files.slice(0, 3), 'x').length, 1);
  assert.throws(() => sampleTestFiles(files, 'x', 0), /--percent must be above 0/);
});

test('the compact report stays within 20 lines for ten or more failures', () => {
  const failures = Array.from({ length: 14 }, (_, index) => ({ file: 'tests/a.test.js', name: `case ${index}`, message: 'expected 1 to equal 2' }));
  const lines = buildCompactReport({ failures, passCount: 30, failCount: 14, logPath: 'artifacts/test-logs/x.tap' });
  assert.ok(lines.length <= 20);
  assert.equal(lines[0], 'FAIL tests/a.test.js :: case 0 :: expected 1 to equal 2');
  assert.match(lines.at(-2), /4 more failures/);
  assert.match(lines.at(-1), /FAILED: 30 passed, 14 failed .*x\.tap/);
});

test('a real failing run prints one line per failure and writes the full TAP log', () => {
  const folder = makeRepository();
  try {
    const run = runTestFiles(['tests/value.test.js', 'tests/other.test.js'], { folder, quiet: true });
    assert.notEqual(run.code, 0);
    assert.equal(run.failures.length, 1);
    assert.equal(run.failures[0].file, 'tests/value.test.js');
    assert.equal(run.failures[0].name, 'value is two');
    assert.match(run.failures[0].message, /Expected values to be strictly equal/);
    assert.match(readFileSync(run.logPath, 'utf8'), /not ok 1 - value is two|TAP version/);
    assert.equal(readdirSync(join(folder, 'artifacts', 'test-logs')).some(name => name.endsWith('.failures.json')), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('mutation check reports the failing tests and restores the tree', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/value.js', 'export const value = 2;\n');
    git(folder, 'commit', '-q', '-am', 'fix');
    write(folder, 'src/extra.js', 'export const extra = 3;\n');
    git(folder, 'add', '-N', 'src/extra.js');
    const before = git(folder, 'diff', 'main', '--', 'src');
    const result = runMutationCheck(['tests/value.test.js'], { folder, baseRef: 'main', runTests: (files, options) => runTestFiles(files, { ...options, quiet: true }) });
    assert.deepEqual(result.failingTests.map(failure => failure.name), ['value is two']);
    assert.equal(result.restored, true);
    assert.equal(git(folder, 'diff', 'main', '--', 'src'), before);
    assert.equal(readFileSync(join(folder, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(readFileSync(join(folder, 'src/extra.js'), 'utf8'), 'export const extra = 3;\n');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('mutation check restores the tree even when the test run throws', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/value.js', 'export const value = 2;\n');
    assert.throws(() => runMutationCheck(['tests/value.test.js'], { folder, baseRef: 'main', runTests: () => { throw new Error('runner crashed'); } }), /runner crashed/);
    assert.equal(readFileSync(join(folder, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('mutation check reports a test that passes without the fix', () => {
  const folder = makeRepository();
  try {
    write(folder, 'src/value.js', 'export const value = 2;\n');
    const result = runMutationCheck(['tests/other.test.js'], { folder, baseRef: 'main', runTests: (files, options) => runTestFiles(files, { ...options, quiet: true }) });
    assert.equal(result.failingTests.length, 0);
    assert.equal(result.passingRun, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('mutation check refuses unstaged changes outside src, bin and packages, and an empty change', () => {
  const folder = makeRepository();
  try {
    assert.throws(() => runMutationCheck(['tests/value.test.js'], { folder, baseRef: 'main' }), /Nothing to revert/);
    write(folder, 'src/value.js', 'export const value = 2;\n');
    write(folder, 'tests/other.test.js', "import test from 'node:test';\ntest('edited', () => {});\n");
    assert.throws(() => runMutationCheck(['tests/value.test.js'], { folder, baseRef: 'main' }), /tests\/other\.test\.js has unstaged changes outside/);
    assert.equal(readFileSync(join(folder, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    assert.throws(() => runMutationCheck(['tests/missing.test.js'], { folder, baseRef: 'main' }), /Test file not found/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('blocking changes name untracked source files and allow untracked tests', () => {
  assert.deepEqual(findBlockingChanges('?? tests/new.test.js\n M src/a.js\nM  docs/a.md\n'), []);
  assert.equal(findBlockingChanges('?? src/new.js\n').length, 1);
  assert.equal(findBlockingChanges(' M docs/a.md\n').length, 1);
});

test('mutation check arguments keep every test path and read --base', () => {
  assert.deepEqual(parseArguments(['tests/a.test.js', 'tests/b.test.js']), { baseRef: 'origin/main', testFiles: ['tests/a.test.js', 'tests/b.test.js'] });
  assert.deepEqual(parseArguments(['tests/a.test.js', '--base', 'main']), { baseRef: 'main', testFiles: ['tests/a.test.js'] });
});

test('mutation check reverts a change under scripts/ too', () => {
  const folder = makeRepository();
  try {
    git(folder, 'checkout', '-q', 'main');
    write(folder, 'scripts/answer.mjs', 'export const answer = 1;\n');
    write(folder, 'tests/answer.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../scripts/answer.mjs';\ntest('answer is two', () => assert.equal(answer, 2));\n");
    git(folder, 'add', '-A');
    git(folder, 'commit', '-q', '-m', 'script and test');
    git(folder, 'checkout', '-q', '-b', 'script-fix');
    write(folder, 'scripts/answer.mjs', 'export const answer = 2;\n');
    git(folder, 'commit', '-q', '-am', 'fix script');
    const result = runMutationCheck(['tests/answer.test.js'], { folder, baseRef: 'main', runTests: (files, options) => runTestFiles(files, { ...options, quiet: true }) });
    assert.deepEqual(result.failingTests.map(failure => failure.name), ['answer is two']);
    assert.equal(readFileSync(join(folder, 'scripts/answer.mjs'), 'utf8'), 'export const answer = 2;\n');
    assert.equal(findBlockingChanges('?? scripts/new.mjs\n').length, 1);
    assert.deepEqual(findBlockingChanges(' M scripts/answer.mjs\n'), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('mutation check arguments accept --base=<ref> and refuse a missing ref or an unknown option', () => {
  assert.deepEqual(parseArguments(['tests/a.test.js', '--base=main']), { baseRef: 'main', testFiles: ['tests/a.test.js'] });
  assert.throws(() => parseArguments(['tests/a.test.js', '--base']), /--base needs a ref/);
  assert.throws(() => parseArguments(['--base=', 'tests/a.test.js']), /--base needs a ref/);
  assert.throws(() => parseArguments(['tests/a.test.js', '--bsae', 'main']), /Unknown option --bsae/);
});

test('parseAffectedArguments reads --base and positional file paths', () => {
  assert.deepEqual(parseAffectedArguments([]), { baseRef: 'origin/main', files: [] });
  assert.deepEqual(parseAffectedArguments(['--base', 'HEAD~1', 'src/a.js']), { baseRef: 'HEAD~1', files: ['src/a.js'] });
  assert.deepEqual(parseAffectedArguments(['--base=main', 'scripts/b.mjs']), { baseRef: 'main', files: ['scripts/b.mjs'] });
  assert.throws(() => parseAffectedArguments(['--base']), /--base needs a git ref/);
  assert.throws(() => parseAffectedArguments(['--base=']), /--base needs a git ref/);
});

test('runTestFiles lowers child process priority to below normal when CI is unset', () => {
  const folder = makeRepository();
  try {
    write(folder, 'tests/priority.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport os from 'node:os';\ntest('priority is below normal', () => { assert.equal(os.getPriority(0), os.constants.priority.PRIORITY_BELOW_NORMAL); });\n");
    const testRunUrl = pathToFileURL(join(process.cwd(), 'scripts/test-run.mjs')).href;
    const childEnvironment = { ...process.env };
    delete childEnvironment.CI;
    delete childEnvironment.NODE_TEST_CONTEXT;
    const probeScript = [
      `import os from 'node:os';`,
      `import { runTestFiles } from ${JSON.stringify(testRunUrl)};`,
      `const result = runTestFiles(['tests/priority.test.js'], { folder: ${JSON.stringify(folder)}, quiet: true });`,
      'if (os.getPriority(0) !== os.constants.priority.PRIORITY_BELOW_NORMAL) process.exit(2);',
      'process.exit(result.code);',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], { encoding: 'utf8', env: childEnvironment });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
