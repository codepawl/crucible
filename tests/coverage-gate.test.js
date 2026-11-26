import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShardSet, compareWithBaseline, mergeLcov, totalsOf } from '../scripts/coverage-gate.mjs';

const baseline = { lines: 90, branches: 80, functions: 90 };

function verdicts(percentages) {
  return Object.fromEntries(compareWithBaseline(percentages, baseline).map(result => [result.metric, result.ok]));
}

test('branch coverage may wander by run-to-run noise without failing the gate', () => {
  assert.deepEqual(verdicts({ lines: 90, branches: 78.6, functions: 90 }), { lines: true, branches: true, functions: true });
});

test('a real drop fails each metric past its own allowance', () => {
  assert.deepEqual(verdicts({ lines: 89.4, branches: 78.4, functions: 89.4 }), { lines: false, branches: false, functions: false });
});

test('unnamed functions merge by line, since each shard numbers them on its own', () => {
  const firstShard = ['SF:src/example.js', 'FN:10,anonymous_1', 'FN:20,anonymous_2', 'FN:30,named', 'FNDA:3,anonymous_1', 'FNDA:0,anonymous_2', 'FNDA:1,named', 'end_of_record'].join('\n');
  const secondShard = ['SF:src/example.js', 'FN:20,anonymous_1', 'FN:30,named', 'FNDA:0,anonymous_1', 'FNDA:0,named', 'end_of_record'].join('\n');
  const { totals } = totalsOf(mergeLcov([firstShard, secondShard]));
  assert.deepEqual(totals.functions, [2, 3]);
});

test('a function hit in only one shard counts as covered', () => {
  const firstShard = ['SF:src/example.js', 'FN:10,anonymous_4', 'FNDA:0,anonymous_4', 'end_of_record'].join('\n');
  const secondShard = ['SF:src/example.js', 'FN:10,anonymous_9', 'FNDA:2,anonymous_9', 'end_of_record'].join('\n');
  const { totals } = totalsOf(mergeLcov([firstShard, secondShard]));
  assert.deepEqual(totals.functions, [1, 1]);
});

// Real V8 shards number the blocks of a file in the order they report them, so one branch carries different block ids in
// different shards and a shard that never runs a function reports it as a single range.
const branchShardA = ['SF:src/example.js', 'BRDA:10,0,0,4', 'BRDA:10,1,0,0', 'BRDA:20,2,0,1', 'end_of_record'].join('\n');
const branchShardB = ['SF:src/example.js', 'BRDA:5,0,0,0', 'BRDA:10,1,0,0', 'BRDA:10,2,0,2', 'BRDA:20,3,0,0', 'end_of_record'].join('\n');
const branchShardC = ['SF:src/example.js', 'BRDA:10,7,0,0', 'end_of_record'].join('\n');

test('a branch counts once however the shards number their blocks', () => {
  const { totals } = totalsOf(mergeLcov([branchShardA, branchShardB, branchShardC]));
  assert.deepEqual(totals.branches, [3, 4]);
});

test('the branch total does not depend on how the same shards are grouped', () => {
  const allApart = totalsOf(mergeLcov([branchShardA, branchShardB, branchShardC])).totals.branches;
  const together = totalsOf(mergeLcov([[branchShardA, branchShardB].join('\n'), branchShardC])).totals.branches;
  assert.deepEqual(allApart, together);
});

const shardText = ['SF:src/example.js', 'FN:1,example', 'FNDA:1,example', 'BRDA:1,0,0,1', 'DA:1,1', 'end_of_record'].join('\n');

function shardSet(shardNumbers) {
  return {
    paths: shardNumbers.map(number => `coverage/shards/shard-${number}.info`),
    texts: shardNumbers.map(() => shardText),
  };
}

test('a complete shard set has no problems', () => {
  const { paths, texts } = shardSet([1, 2, 3]);
  assert.deepEqual(checkShardSet(paths, texts, 3), []);
});

test('a missing shard is named, with how many were found', () => {
  const { paths, texts } = shardSet([1, 3]);
  assert.deepEqual(checkShardSet(paths, texts, 3), ['missing shard 2: found 2 of 3']);
});

test('shards left over from a run with another shard count, and duplicates, are refused', () => {
  const left = shardSet([1, 2, 5]);
  assert.match(checkShardSet(left.paths, left.texts, 3).join('\n'), /shard 5, outside 1 to 3.*missing shard 3/s);
  const doubled = shardSet([1, 2, 2]);
  assert.match(checkShardSet(doubled.paths, doubled.texts, 2).join('\n'), /shard 2 appears 2 times/);
});

test('a shard file without source files is refused as unfinished', () => {
  const { paths } = shardSet([1, 2]);
  assert.match(checkShardSet(paths, [shardText, ''], 2).join('\n'), /shard-2\.info has no source files/);
});

test('the gate command refuses a partial shard set before merging and says to rerun all jobs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-shards-'));
  try {
    writeFileSync(join(folder, 'shard-1.info'), shardText);
    writeFileSync(join(folder, 'shard-3.info'), shardText);
    const baselinePath = join(folder, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify({ lines: 0, branches: 0, functions: 0 }));
    const gate = join(import.meta.dirname, '..', 'scripts', 'coverage-gate.mjs');
    const refused = spawnSync(process.execPath, [gate, folder, '--baseline', baselinePath, '--expect-shards', '3'], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /missing shard 2: found 2 of 3/);
    assert.match(refused.stderr, /Re-run all jobs/);
    assert.doesNotMatch(refused.stdout, /Coverage from/);

    writeFileSync(join(folder, 'shard-2.info'), shardText);
    const accepted = spawnSync(process.execPath, [gate, folder, '--baseline', baselinePath, '--expect-shards', '3'], { encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Coverage from 3 lcov file/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the gate command reports missing coverage and baseline paths cleanly without a raw stack', () => {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-cov-missing-'));
  try {
    const lcovPath = join(folder, 'unit.info');
    writeFileSync(lcovPath, shardText);
    const gate = join(import.meta.dirname, '..', 'scripts', 'coverage-gate.mjs');

    const missingCoverage = spawnSync(process.execPath, [gate, join(folder, 'missing.info')], { encoding: 'utf8' });
    assert.equal(missingCoverage.status, 1);
    assert.match(missingCoverage.stderr, /Coverage file or folder not found/);
    assert.doesNotMatch(missingCoverage.stderr, /\bat\s+/);

    const missingBaseline = spawnSync(process.execPath, [gate, lcovPath, '--baseline', join(folder, 'missing-baseline.json')], { encoding: 'utf8' });
    assert.equal(missingBaseline.status, 1);
    assert.match(missingBaseline.stderr, /Coverage baseline file not found/);
    assert.doesNotMatch(missingBaseline.stderr, /\bat\s+/);

    const missingBaselineFlag = spawnSync(process.execPath, [gate, lcovPath, '--baseline'], { encoding: 'utf8' });
    assert.equal(missingBaselineFlag.status, 1);
    assert.match(missingBaselineFlag.stderr, /Pass a baseline file path after --baseline/);
    assert.doesNotMatch(missingBaselineFlag.stderr, /\bat\s+/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
