import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLineArt } from '../src/line-art.js';
import { installRenderPasses } from '../src/render-passes.js';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { objectIdMetrics } from '../scripts/agent-object-id-metrics.mjs';

await loadAllAgentSceneModules();

const robotBytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

function loadRobot() {
  return parseGltf(robotBytes.buffer.slice(robotBytes.byteOffset, robotBytes.byteOffset + robotBytes.byteLength), { maxVertices: 500000 });
}

test('naming a crowd reaches every person part under one node', async () => {
  const assetId = 'ef'.repeat(32);
  const robot = await loadRobot();
  const walking = robot.animations.findIndex(animation => animation.name === 'Walking');
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    camera: { eye: [0, 3, 14], target: [0, 1, 0] },
    nodes: [
      { id: 'floor', geometry: 'ground', material: 'grass', scale: [40, 0.1, 40] },
      { id: 'people', asset: { id: assetId, crowd: { clip: walking, count: 40, seed: 5, spacing: 2 } } },
    ],
    environment: { lines: { nodes: { people: { lines: false } } } },
  };
  const assets = new Map([[assetCopyKey(assetId, 0), await loadRobot()], [assetCopyKey(assetId, 1), robot]]);
  const scene = createAgentScene(recipe, {}, { assets });
  const renderer = { batches: [{ parts: scene.parts }], drawsInOpaqueLoop: () => true, takesObjectIds: () => true };
  installRenderPasses(renderer);
  const nodes = renderer.passSupport.objectNodes();
  assert.deepEqual(Object.keys(nodes).sort(), ['floor', 'people']);
  assert.equal(nodes.people.length, scene.parts.length - nodes.floor.length);
  assert.ok(nodes.people.length >= 40);
});

test('the job metrics list the IDs of each node and flag a cut list', () => {
  const small = objectIdMetrics({ objectNames: ['a/0', 'a/1', 'b'], objectNodes: { a: [1, 2], b: [3] } });
  assert.deepEqual(small.objectNodes, { a: [1, 2], b: [3] });
  assert.equal(small.objectNodesTruncated, false);
  assert.equal(small.objectNamesTruncated, false);
  const names = Array.from({ length: 1001 }, (unused, index) => `n${index}`);
  const groups = Object.fromEntries(names.map((name, index) => [name, [index + 1]]));
  const large = objectIdMetrics({ objectNames: names, objectNodes: groups });
  assert.equal(Object.keys(large.objectNodes).length, 1000);
  assert.equal(large.objectNodesTruncated, true);
  assert.equal(large.objectNames.length, 1000);
  assert.equal(large.objectNamesTruncated, true);
  assert.deepEqual(objectIdMetrics({ objectNames: [] }).objectNodes, {});
});

test('lines.nodes null clears the map, and the error lists are cut with a count', () => {
  assert.equal(resolveLineArt({ nodes: null }).nodes, undefined);
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [{ id: 'floor', geometry: 'ground', material: 'grass' }],
    environment: { lines: { nodes: Object.fromEntries(Array.from({ length: 5 }, (unused, index) => [`missing${index}`, { lines: false }])) } },
  };
  assert.throws(() => createAgentScene(recipe, {}), /1 more are unknown too/);
  recipe.nodes = [{ id: 'empty' }];
  recipe.environment.lines.nodes = { empty: { lines: false } };
  assert.throws(() => createAgentScene(recipe, {}), /no children, so remove its entry/);
});
