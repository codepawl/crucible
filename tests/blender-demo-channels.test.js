import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const UNITTEST_ARGUMENTS = ['-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_blender_demo_channels.py'];

function pythonRunner() {
  // uv first: on Windows a bare python is the Store alias, which passes a probe and then fails the run.
  const uvProbe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (uvProbe.status === 0) return { command: 'uv', arguments: ['run', '--no-project', 'python', ...UNITTEST_ARGUMENTS] };
  for (const interpreter of ['python3', 'python']) {
    const probe = spawnSync(interpreter, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { encoding: 'utf8' });
    if (probe.status === 0) return { command: interpreter, arguments: UNITTEST_ARGUMENTS };
  }
  return null;
}

// The classification of which Blender material channels the glTF exporter drops (scripts/blender_demo_channels.py) needs no Blender.
test('the Blender demo export channel classification tests pass', (testContext) => {
  const runner = pythonRunner();
  if (!runner) {
    testContext.skip('no python3 or python, and no uv, on PATH');
    return;
  }
  const result = spawnSync(runner.command, runner.arguments, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
