import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { FULL_MODE, LIGHT_MODE, classifyChangedFiles } from '../scripts/ci-plan.mjs';

const LIGHT_EXAMPLES = [
  ['docs/studio.md'],
  ['docs/images/flow.png'],
  ['changes/3378.md'],
  ['README.md', 'CONTRIBUTING.md'],
  ['packages/blender-addon/README.md'],
  ['site/index.html'],
  ['src/studio-icons.js'],
  ['src/studio.js', 'tests/studio-icons.test.js', 'changes/12.md'],
  ['tests/studio-keymap.test.js'],
  ['src\\studio-styles.js'],
];

const FULL_EXAMPLES = [
  ['src/renderer.js'],
  ['src/shaders/glass.glsl'],
  ['src/mcp-server.js'],
  ['src/agent-tools.js'],
  ['scripts/ci-plan.mjs'],
  ['bin/crucible-mcp.mjs'],
  ['packages/blender-addon/addon.py'],
  ['skills/build-crucible-scene/SKILL.md'],
  ['skills/README.md'],
  ['package.json'],
  ['package-lock.json'],
  ['.github/workflows/test.yml'],
  ['.github/CONTRIBUTING.md'],
  ['config/test-timings.json'],
  ['bench/size/budgets.json'],
  ['docs/studio.md', 'src/renderer.js'],
  ['src/studio/panel.js'],
  ['src/studios.js'],
  ['tests/renderer.test.js'],
];

test('paths that only touch docs, notes, markdown, the site or the Studio UI run light', () => {
  for (const paths of LIGHT_EXAMPLES) {
    assert.equal(classifyChangedFiles(paths).mode, LIGHT_MODE, paths.join(', '));
  }
});

test('any other path runs the full workflow and the reason names it', () => {
  for (const paths of FULL_EXAMPLES) {
    const { mode, reason } = classifyChangedFiles(paths);
    assert.equal(mode, FULL_MODE, paths.join(', '));
    assert.match(reason, /not on the low-risk list/);
  }
});

test('one heavy path among light ones forces a full run', () => {
  const { mode, reason } = classifyChangedFiles(['docs/a.md', 'src/studio.js', 'src/shadows.js']);
  assert.equal(mode, FULL_MODE);
  assert.match(reason, /src\/shadows\.js/);
});

test('an empty list runs full', () => {
  assert.equal(classifyChangedFiles([]).mode, FULL_MODE);
  assert.equal(classifyChangedFiles(['', '']).mode, FULL_MODE);
});

test('the command line prints the mode and the tests that mention a changed file', () => {
  const result = spawnSync(process.execPath, ['scripts/ci-plan.mjs', 'tests/studio-keymap.test.js', 'docs/studio.md'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(lines.mode, LIGHT_MODE);
  assert.ok(lines.tests.split(' ').includes('tests/studio-keymap.test.js'), lines.tests);
});

test('the command line prints no tests in full mode', () => {
  const result = spawnSync(process.execPath, ['scripts/ci-plan.mjs', 'src/renderer.js'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mode=full$/m);
  assert.match(result.stdout, /^tests=$/m);
});
