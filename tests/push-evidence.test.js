import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  formatReport,
  parseArguments,
  parseRemoteUrl,
  pushEvidence,
  rawUrl,
} from '../scripts/push-evidence.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// Builds a commit with one file under pr-20/ inside a bare repository, as another worker's push would have.
function createOtherWorkerCommit(bareRepositoryPath) {
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: bareRepositoryPath, input: 'other picture', encoding: 'utf8' }).stdout.trim();
  const folderTree = spawnSync('git', ['mktree'], { cwd: bareRepositoryPath, input: `100644 blob ${blob}\tother.png\n`, encoding: 'utf8' }).stdout.trim();
  const rootTree = spawnSync('git', ['mktree'], { cwd: bareRepositoryPath, input: `040000 tree ${folderTree}\tpr-20\n`, encoding: 'utf8' }).stdout.trim();
  const identity = ['-c', 'user.name=Other', '-c', 'user.email=other@example.com'];
  return git([...identity, 'commit-tree', rootTree, '-m', 'Add evidence for PR #20'], bareRepositoryPath);
}

describe('push-evidence', () => {
  let sandbox;
  let bareRepository;
  let clone;

  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'push-evidence-test-')));
    bareRepository = join(sandbox, 'remote.git');
    clone = join(sandbox, 'clone');
    git(['init', '--bare', '--quiet', bareRepository], sandbox);
    git(['clone', '--quiet', bareRepository, clone], sandbox);
    git(['config', 'user.email', 'test@example.com'], clone);
    git(['config', 'user.name', 'Test'], clone);
    writeFileSync(join(clone, 'readme.txt'), 'hello');
    git(['add', '.'], clone);
    git(['commit', '--quiet', '-m', 'first'], clone);
    mkdirSync(join(clone, 'artifacts'));
    writeFileSync(join(clone, 'artifacts', 'before.png'), 'before picture');
    writeFileSync(join(clone, 'artifacts', 'after.png'), 'after picture');
  });

  after(() => rmSync(sandbox, { recursive: true, force: true }));

  test('the first push creates an orphan evidence branch, without touching the clone', () => {
    const headBefore = git(['rev-parse', 'HEAD'], clone);
    const statusBefore = git(['status', '--porcelain', '--untracked-files=all'], clone);
    const stagedBefore = git(['ls-files', '--stage'], clone);

    const report = pushEvidence({ prNumber: 7, files: ['artifacts/before.png'], cwd: clone });
    assert.equal(report.branch, 'evidence');
    assert.equal(git(['ls-tree', '-r', '--name-only', 'evidence'], bareRepository), 'pr-7/before.png');
    assert.equal(git(['rev-list', '--count', 'evidence'], bareRepository), '1');
    assert.equal(git(['rev-list', '--max-parents=0', 'evidence'], bareRepository), git(['rev-parse', 'evidence'], bareRepository));

    assert.equal(git(['rev-parse', 'HEAD'], clone), headBefore);
    assert.equal(git(['status', '--porcelain', '--untracked-files=all'], clone), statusBefore);
    assert.equal(git(['ls-files', '--stage'], clone), stagedBefore);
  });

  test('later pushes add to the tip and keep every other pull request folder', () => {
    pushEvidence({ prNumber: 7, files: ['artifacts/after.png'], cwd: clone });
    pushEvidence({ prNumber: 8, files: ['artifacts/after.png'], cwd: clone });
    assert.equal(
      git(['ls-tree', '-r', '--name-only', 'evidence'], bareRepository),
      'pr-7/after.png\npr-7/before.png\npr-8/after.png',
    );
    assert.equal(git(['rev-list', '--count', 'evidence'], bareRepository), '3');
    assert.equal(git(['show', 'evidence:pr-7/before.png'], bareRepository), 'before picture');
    assert.equal(git(['branch', '--list', 'evidence-pr-*'], bareRepository), '');
  });

  test('a rejected push is rebuilt on the new tip and retried without dropping the other push', () => {
    const racingRemote = join(sandbox, 'racing.git');
    git(['init', '--bare', '--quiet', racingRemote], sandbox);
    git(['remote', 'add', 'racing', racingRemote], clone);
    const otherWorkerCommit = createOtherWorkerCommit(racingRemote);
    const marker = join(racingRemote, 'rejected-once');
    const hookPath = join(racingRemote, 'hooks', 'pre-receive');
    const toGitPath = (path) => path.replaceAll('\\', '/');
    writeFileSync(
      hookPath,
      `#!/bin/sh\nif [ ! -f "${toGitPath(marker)}" ]; then\n  touch "${toGitPath(marker)}"\n  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  git update-ref refs/heads/evidence ${otherWorkerCommit}\n  echo "simulated race" >&2\n  exit 1\nfi\n`,
    );
    chmodSync(hookPath, 0o755);

    const waits = [];
    pushEvidence({ prNumber: 21, files: ['artifacts/before.png'], remote: 'racing', cwd: clone, wait: (milliseconds) => waits.push(milliseconds) });

    assert.equal(waits.length, 1);
    assert.equal(
      git(['ls-tree', '-r', '--name-only', 'evidence'], racingRemote),
      'pr-20/other.png\npr-21/before.png',
    );
    assert.equal(git(['rev-list', '--count', 'evidence'], racingRemote), '2');
  });

  test('gives up with a clear error after five rejected pushes', () => {
    const stubbornRemote = join(sandbox, 'stubborn.git');
    git(['init', '--bare', '--quiet', stubbornRemote], sandbox);
    git(['remote', 'add', 'stubborn', stubbornRemote], clone);
    const hookPath = join(stubbornRemote, 'hooks', 'pre-receive');
    writeFileSync(hookPath, '#!/bin/sh\necho "always refused" >&2\nexit 1\n');
    chmodSync(hookPath, 0o755);

    const waits = [];
    assert.throws(
      () => pushEvidence({ prNumber: 22, files: ['artifacts/before.png'], remote: 'stubborn', cwd: clone, wait: (milliseconds) => waits.push(milliseconds) }),
      /after 5 attempts/,
    );
    assert.equal(waits.length, 4);
  });

  test('dry run pushes nothing', () => {
    const report = pushEvidence({ prNumber: 30, files: ['artifacts/after.png'], dryRun: true, cwd: clone });
    assert.equal(report.dryRun, true);
    assert.equal(git(['ls-tree', '-r', '--name-only', 'evidence'], bareRepository).includes('pr-30'), false);
  });

  test('refuses bad input with a message that says what to pass', () => {
    assert.throws(() => parseArguments(['abc', 'a.png']), /positive integer/);
    assert.throws(() => parseArguments(['0', 'a.png']), /positive integer/);
    assert.throws(() => pushEvidence({ prNumber: 9, files: [], cwd: clone }), /at least one picture/);
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['missing.png'], cwd: clone }), /File not found/);
    writeFileSync(join(clone, 'artifacts', 'notes.txt'), 'text');
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['artifacts/notes.txt'], cwd: clone }), /Pass one of: .png/);
    writeFileSync(join(clone, 'artifacts', 'huge.mp4'), Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['artifacts/huge.mp4'], cwd: clone }), /over the 20 MB limit/);
  });

  test('refuses a file outside the repository and the temp folder', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts.png' : '/etc/hosts.png';
    assert.throws(() => pushEvidence({ prNumber: 9, files: [outside], cwd: clone }), /not found|outside the repository/);
  });

  test('builds raw URLs and Markdown from a GitHub remote', () => {
    const repository = parseRemoteUrl('https://github.com/codepawl/crucible.git');
    assert.deepEqual(repository, { owner: 'codepawl', repository: 'crucible' });
    assert.deepEqual(parseRemoteUrl('git@github.com:codepawl/crucible.git'), repository);
    const url = rawUrl(repository, 12, 'a.png');
    assert.equal(url, 'https://raw.githubusercontent.com/codepawl/crucible/evidence/pr-12/a.png');
    const report = formatReport({ branch: 'evidence', links: [{ name: 'a.png', url }], dryRun: false });
    assert.match(report, /!\[a\.png\]\(https:\/\/raw\.githubusercontent\.com\/codepawl\/crucible\/evidence\/pr-12\/a\.png\)/);
  });
});
