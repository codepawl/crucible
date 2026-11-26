import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { largeFileGrowthWarnings, runLargeFileGrowthCheck } from '../scripts/check-large-file-growth.mjs';
import { planChecks, runChecks } from '../scripts/preflight.mjs';

function runGit(folder, args) {
  const result = spawnSync('git', args, { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function linesText(count) {
  return `${Array.from({ length: count }, (_, index) => `// line ${index + 1}`).join('\n')}\n`;
}

test('a file over 1500 lines that gains lines reports the counts and the fix', () => {
  const [message] = largeFileGrowthWarnings([{ path: 'src/studio.js', baseLines: 5268, headLines: 5300 }]);
  assert.match(message, /^src\/studio\.js: 5268 lines at the base, 5300 now/);
  assert.match(message, /own registered module instead of growing this file, see #3381/);
});

test('a big file that shrinks or stays the same is silent', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'src/studio.js', baseLines: 5268, headLines: 5200 },
    { path: 'src/renderer.js', baseLines: 3502, headLines: 3502 },
  ]), []);
});

test('a file at or under the limit is silent even when it grows past it later', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'src/small.js', baseLines: 200, headLines: 900 },
    { path: 'src/edge.js', baseLines: 1500, headLines: 1600 },
  ]), []);
});

test('a new file already over the limit fails, a new small file does not', () => {
  const failures = largeFileGrowthWarnings([
    { path: 'src/huge-new.js', baseLines: null, headLines: 1800 },
    { path: 'src/small-new.js', baseLines: null, headLines: 100 },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^src\/huge-new\.js: new file, 1800 now/);
});

test('only src/*.js files are checked', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'docs/big.md', baseLines: 5000, headLines: 5100 },
    { path: 'src/nested/big.js', baseLines: 5000, headLines: 5100 },
  ]), []);
});

test('runLargeFileGrowthCheck exits 1 with the counts and fix when a large src/*.js file grows, and 0 otherwise', () => {
  const repositoryFolder = mkdtempSync(join(tmpdir(), 'crucible-large-file-'));
  try {
    runGit(repositoryFolder, ['init', '-b', 'main']);
    runGit(repositoryFolder, ['config', 'user.email', 'test@example.com']);
    runGit(repositoryFolder, ['config', 'user.name', 'Test User']);
    mkdirSync(join(repositoryFolder, 'src'), { recursive: true });
    writeFileSync(join(repositoryFolder, 'src', 'big.js'), linesText(1501), 'utf8');
    writeFileSync(join(repositoryFolder, 'src', 'small.js'), linesText(10), 'utf8');
    runGit(repositoryFolder, ['add', 'src/big.js', 'src/small.js']);
    runGit(repositoryFolder, ['commit', '-m', 'base']);
    runGit(repositoryFolder, ['checkout', '-b', 'feature']);

    writeFileSync(join(repositoryFolder, 'src', 'small.js'), linesText(25), 'utf8');
    const cleanOut = [];
    const cleanErrors = [];
    const cleanCode = runLargeFileGrowthCheck(['--base', 'main'], {
      folder: repositoryFolder,
      writeOut: line => cleanOut.push(line),
      writeError: line => cleanErrors.push(line),
    });
    assert.equal(cleanCode, 0);
    assert.deepEqual(cleanErrors, []);
    assert.match(cleanOut[0], /No src\/\*\.js file over 1500 lines grew \(compared with main\)\./);

    writeFileSync(join(repositoryFolder, 'src', 'big.js'), linesText(1502), 'utf8');
    const failOut = [];
    const failErrors = [];
    const failCode = runLargeFileGrowthCheck(['--base', 'main'], {
      folder: repositoryFolder,
      writeOut: line => failOut.push(line),
      writeError: line => failErrors.push(line),
    });
    assert.equal(failCode, 1);
    assert.deepEqual(failOut, []);
    assert.equal(failErrors.length, 1);
    assert.match(failErrors[0], /^src\/big\.js: 1501 lines at the base, 1502 now \(limit 1500\)\. Add the feature as its own registered module instead of growing this file, see #3381\.$/);
  } finally {
    rmSync(repositoryFolder, { recursive: true, force: true });
  }
});

test('preflight plans large file growth as a failing gate when the script exits 1', async () => {
  const check = planChecks(['src/studio.js'], { skipTests: true, baseRef: 'origin/main' }).find(planned => planned.name === 'large file growth');
  assert.equal(check.skipped, null);
  assert.equal(check.failure, undefined);
  assert.equal(check.showOutput, undefined);
  assert.deepEqual(check.command, ['node', 'scripts/check-large-file-growth.mjs', '--base', 'origin/main']);
  assert.match(check.fix, /#3381/);

  const skipped = planChecks(['docs/a.md'], { skipTests: true }).find(planned => planned.name === 'large file growth');
  assert.match(skipped.skipped, /no src\/\*\.js file changed/);

  const outputs = [];
  const results = await runChecks([check], {
    writeOutput: text => outputs.push(text),
    readLog: () => 'src/studio.js: 5268 lines at the base, 5270 now (limit 1500). Add the feature as its own registered module instead of growing this file, see #3381.\n',
    rootFolder: '/repo',
    runCommand: async () => ({ code: 1, logPath: '/repo/artifacts/preflight/large-file-growth.log' }),
  });
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].detail, /^exit 1/);
  assert.match(results[0].fix, /#3381/);
  assert.ok(outputs.some(text => text.includes('src/studio.js: 5268 lines at the base, 5270 now')));
});
