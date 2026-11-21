import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { ACCEPTED_CLI_OPTIONS, runMcpCli } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';

// The repository root is an existing absolute folder that is not a temporary directory.
const ABSOLUTE_FOLDER = fileURLToPath(new URL('..', import.meta.url));

function singleGeometryRecipe(geometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [geometry],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: `node-${geometry.id}`, geometry: geometry.id, material: 'paint' }],
  };
}

test('runMcpCli rejects a relative --packs, --assets, --audio or --ffmpeg and a missing --browser before serving', async () => {
  const cases = [
    [['--packs', 'relative/packs'], /Packs root must be an explicit absolute directory path\./],
    [['--assets', 'relative/assets'], /Asset root must be an explicit absolute directory path\./],
    [['--ffmpeg', 'relative/ffmpeg'], /FFmpeg must be on PATH or configured with an existing absolute executable path\./],
    [['--audio', 'relative/audio'], /Audio root must be an explicit absolute directory path\./],
    [['--browser', '/nope/chrome'], /The configured browser executable does not exist\./],
  ];
  for (const [argumentsValue, message] of cases) {
    await assert.rejects(() => runMcpCli({ argumentsValue: ['--jobs', ABSOLUTE_FOLDER, ...argumentsValue] }), message);
  }
});

test('runMcpCli accepts only on or off for --branches, --relations and --findings', async () => {
  for (const flag of ['--branches', '--relations', '--findings']) {
    for (const value of ['false', '0', 'OFF']) {
      await assert.rejects(() => runMcpCli({ argumentsValue: [flag, value] }),
        error => error.message.includes(`${flag.slice(2)} must be on or off`) && error.message.includes(`"${value}"`));
    }
  }
});

test('scene_restore rejects more than one of checkpointId, revision and branch', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(() => runtime.restore({ expectedRevision: 2, checkpointId: 'ck0', revision: 1 }),
    /pass exactly one of checkpointId, revision or branch; got checkpointId and revision\./);
  await assert.rejects(() => runtime.restore({ expectedRevision: 2, revision: 1, branch: 'side' }),
    /got revision and branch\./);
});

test('a terrain resolution that is not a number names the real range', () => {
  const recipe = singleGeometryRecipe({ id: 'ground', type: 'terrain', size: 10, resolution: 'abc' });
  assert.throws(() => createAgentScene(recipe, {}), /terrain\.resolution: got "abc"; expected a number from 2 to 256/);
});

test('the geometry preflight error names the geometry and the numbers, and checkpoints only when held', () => {
  const recipe = singleGeometryRecipe({ id: 'ball', type: 'mesh', base: { type: 'sphere', segments: 512, rings: 512 } });
  assert.throws(() => createAgentScene(recipe, {}), error => {
    assert.match(error.message, /^geometry\.vertices: got \d+; expected a geometry preflight peak of at most \d+ vertices and \d+ bytes \(this needs \d+ bytes\): /);
    assert.match(error.message, /"ball"/);
    assert.match(error.message, /\d+ vertices are already held by the active scene, checkpoints and staged resources and \d+ are new/);
    assert.match(error.message, /Reduce detail\.$/);
    assert.doesNotMatch(error.message, /checkpoints\./);
    return true;
  });
});

test('the geometry preflight error suggests releasing checkpoints when one is held', () => {
  const session = createAgentScene(singleGeometryRecipe({ id: 'box', type: 'box', bevel: 0 }), { maxVertices: 24, maxGeometryBytes: 1344 });
  session.checkpoint();
  session.apply([
    { type: 'remove-node', id: 'node-box' },
    { type: 'remove-geometry', id: 'box' },
  ], { expectedRevision: 0 });
  const add = [{ type: 'add-geometry', geometry: { id: 'new', type: 'box', bevel: 0 } }];
  assert.throws(() => session.apply(add, { expectedRevision: 1 }), error => {
    assert.match(error.message, /Reduce detail or release checkpoints\.$/);
    return true;
  });
});

for (const field of ['size', 'resolution', 'amplitude']) {
  test(`a null terrain ${field} is rejected, not read as the default`, () => {
    const recipe = singleGeometryRecipe({ id: 'ground', type: 'terrain', [field]: null });
    assert.throws(() => createAgentScene(recipe, {}), new RegExp(`${field}: got null`));
  });
}

test('the path tracer text points at the real scene_capabilities topic', async () => {
  const server = await readFile(new URL('../scripts/mcp-server.mjs', import.meta.url), 'utf8');
  const jobs = await readFile(new URL('../skills/render-crucible-media/references/jobs.md', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /scene_capabilities pathTracer/);
  assert.doesNotMatch(jobs, /`scene_capabilities`\s*\(`pathTracer`\)/);
  assert.match(jobs, /topic `jobs`, key `pathTracer`/);
});

test('crucible-mcp --help lists every option runMcpCli accepts', async () => {
  const bin = await readFile(new URL('../bin/crucible-mcp-flags.mjs', import.meta.url), 'utf8');
  for (const option of ACCEPTED_CLI_OPTIONS) {
    assert.ok(bin.includes(option), `${option} missing from --help`);
  }
});

test('runMcpCli rejects a --max-asset-bytes outside 1 MiB to 256 MiB, naming the range (#2841)', async () => {
  for (const value of ['abc', '100', '999999999999', '1.5']) {
    await assert.rejects(() => runMcpCli({ argumentsValue: ['--max-asset-bytes', value] }),
      error => error instanceof RangeError && /--max-asset-bytes must be a whole number of bytes from 1048576/.test(error.message));
  }
  assert.ok(ACCEPTED_CLI_OPTIONS.includes('--max-asset-bytes'));
});
