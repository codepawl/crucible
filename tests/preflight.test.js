import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONCURRENCY, isVersionBump, manualChecksFor, planChecks, runChecks } from '../scripts/preflight.mjs';

function checkNamed(checks, name) {
  return checks.find(check => check.name === name);
}

test('a docs-only change runs the link check and skips the code gates', () => {
  const checks = planChecks(['docs/guide.md']);
  assert.equal(checkNamed(checks, 'links').skipped, null);
  assert.match(checkNamed(checks, 'size').skipped, /no shipped code/);
  assert.match(checkNamed(checks, 'tool cost').skipped, /no MCP tool code/);
  assert.match(checkNamed(checks, 'change note').skipped, /no change under/);
});

test('a source change without a change note fails the note check', () => {
  const checks = planChecks(['src/camera.js']);
  assert.match(checkNamed(checks, 'change note').failure, /changes\/<issue>\.md/);
  assert.equal(checkNamed(checks, 'size').skipped, null);
});

test('a size note alone does not count as a change note', () => {
  const checks = planChecks(['src/camera.js', 'changes/700.size.md']);
  assert.ok(checkNamed(checks, 'change note').failure);
  const withNote = planChecks(['src/camera.js', 'changes/700.size.md', 'changes/700.md']);
  assert.equal(checkNamed(withNote, 'change note').failure, null);
});

test('a release (version bump) may edit protected files and fold every change note', () => {
  const releasePaths = ['CHANGELOG.md', 'bench/size/budgets.json', 'bench/tool-cost-budgets.json', 'package.json', 'src/version.js', 'changes/700.md'];
  const checks = planChecks(releasePaths, { release: true });
  assert.equal(checkNamed(checks, 'protected files').failure, null);
  assert.match(checkNamed(checks, 'protected files').skipped, /release/);
  assert.equal(checkNamed(checks, 'change note').failure, null);
  assert.equal(isVersionBump('{"version":"0.18.0"}', '{"version":"0.19.0"}'), true);
  assert.equal(isVersionBump('{"version":"0.18.0"}', '{"version":"0.18.0","name":"x"}'), false);
  assert.equal(isVersionBump(null, '{"version":"0.19.0"}'), false);
  const notRelease = planChecks(releasePaths);
  assert.match(checkNamed(notRelease, 'protected files').failure, /CHANGELOG\.md/);
});

test('editing a protected file fails with the alternative', () => {
  const checks = planChecks(['CHANGELOG.md', 'bench/size/budgets.json']);
  const failure = checkNamed(checks, 'protected files').failure;
  assert.match(failure, /CHANGELOG\.md: Add a changes/);
  assert.match(failure, /budgets\.json: Accept a size increase/);
});

test('MCP tool code runs the schema and tool cost checks', () => {
  const checks = planChecks(['src\\agent-scene.js', 'changes/700.md']);
  assert.equal(checkNamed(checks, 'tool schemas').skipped, null);
  assert.equal(checkNamed(checks, 'tool cost').skipped, null);
});

test('the MCP server scripts that shape tool results run the tool cost check', () => {
  for (const path of ['scripts/capabilities-topics.mjs', 'scripts/mcp-server.mjs', 'scripts/tool-examples.mjs']) {
    assert.equal(checkNamed(planChecks([path, 'changes/700.md']), 'tool cost').skipped, null, path);
  }
});

test('--skip-tests skips the build, the tests and the coverage gate', () => {
  const checks = planChecks(['src/camera.js'], { skipTests: true });
  for (const name of ['build library', 'unit tests and coverage', 'coverage gate']) {
    assert.match(checkNamed(checks, name).skipped, /--skip-tests/);
  }
});

test('manual GPU checks are pointed out by the files they cover', () => {
  const commands = manualChecksFor(['src/cascaded-shadows.js', 'src/gltf-loader.js']).map(check => check.command);
  assert.deepEqual(commands, ['npm run reference', 'npm run smoke:character']);
  assert.deepEqual(manualChecksFor(['docs/guide.md']), []);
});

test('the add-on python tests run only when a file under packages/blender-addon/ changed', () => {
  assert.match(checkNamed(planChecks(['src/camera.js']), 'add-on python tests').skipped, /no file under packages\/blender-addon/);
  const checks = planChecks(['packages/blender-addon/cook_blender/blender_conversions.py', 'changes/1.md']);
  assert.equal(checkNamed(checks, 'add-on python tests').skipped, null);
});

test('the names check runs for a changed source file and is skipped for docs', () => {
  assert.equal(checkNamed(planChecks(['src/camera.js']), 'names').skipped, null);
  assert.match(checkNamed(planChecks(['docs/guide.md']), 'names').skipped, /no scanned source/);
});

test('planChecks orders unit tests after build library and build library after package links', () => {
  const checks = planChecks(['src/camera.js', 'docs/guide.md', 'changes/1.md']);
  assert.equal(checkNamed(checks, 'unit tests and coverage').dependsOn, 'build library');
  assert.deepEqual(checkNamed(checks, 'build library').after, ['package links']);
});

test('runChecks runs ready checks concurrently within the concurrency cap and preserves check order', async () => {
  assert.equal(DEFAULT_CONCURRENCY, 4);
  let active = 0;
  let peakActive = 0;
  const delays = new Map([['slow', 40], ['medium', 15], ['fast', 5], ['tail', 5]]);
  const checks = [
    { name: 'inline ok', kind: 'inline', skipped: null, failure: null },
    { name: 'slow', command: ['node', 'slow'], skipped: null },
    { name: 'medium', command: ['node', 'medium'], skipped: null },
    { name: 'fast', command: ['node', 'fast'], skipped: null },
    { name: 'tail', command: ['node', 'tail'], skipped: null },
  ];
  const outputs = [];
  const results = await runChecks(checks, {
    concurrency: 2,
    writeOutput: text => outputs.push(text),
    readLog: () => '',
    rootFolder: '/repo',
    runCommand: async check => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolveWait => setTimeout(resolveWait, delays.get(check.name)));
      active--;
      return { code: 0, logPath: `/repo/artifacts/preflight/${check.name}.log` };
    },
  });
  assert.equal(peakActive, 2);
  assert.deepEqual(results.map(result => result.name), ['inline ok', 'slow', 'medium', 'fast', 'tail']);
  assert.deepEqual(results.map(result => result.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('runChecks skips dependents on failure but still runs after-ordered checks when the prior check fails', async () => {
  const events = [];
  const checks = [
    { name: 'package links', command: ['node', 'links'], skipped: null, fix: 'fix links' },
    { name: 'build library', command: ['node', 'build'], skipped: null, after: ['package links'], fix: 'fix build' },
    { name: 'unit tests', command: ['node', 'test'], skipped: null, dependsOn: 'build library', fix: 'fix tests' },
    { name: 'coverage gate', command: ['node', 'cov'], skipped: null, dependsOn: 'unit tests', fix: 'fix cov' },
  ];
  const outputs = [];
  const results = await runChecks(checks, {
    concurrency: 4,
    writeOutput: text => outputs.push(text),
    readLog: path => `line 1 of ${path}\nline 2 of ${path}\n`,
    rootFolder: '/repo',
    runCommand: async check => {
      events.push(`start:${check.name}`);
      await new Promise(resolveWait => setTimeout(resolveWait, check.name === 'package links' ? 20 : 5));
      events.push(`end:${check.name}`);
      return { code: check.name === 'unit tests' ? 0 : 1, logPath: `/repo/artifacts/preflight/${check.name}.log` };
    },
  });
  assert.ok(events.indexOf('end:package links') < events.indexOf('start:build library'), 'build library waited for package links');
  assert.deepEqual(results.map(result => result.status), ['fail', 'fail', 'skip', 'skip']);
  assert.equal(results[2].detail, 'build library did not pass');
  assert.equal(results[3].detail, 'unit tests did not pass');
  assert.ok(outputs.some(text => text.includes('line 2 of /repo/artifacts/preflight/package links.log')));
});
