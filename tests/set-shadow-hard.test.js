import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

// Issue 3044: the MCP schema and the recipe take shadow.hard, but set-shadow rejected it on a scene without it.

function plainRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box' }],
    materials: [{ id: 'paint', color: [1, 1, 1] }],
    nodes: [{ id: 'floor', geometry: 'slab', material: 'paint' }],
  };
}

test('set-shadow turns on hard shadows in a scene that never set them', () => {
  const scene = createAgentScene(plainRecipe());
  scene.apply([{ type: 'set-shadow', shadow: { hard: true } }], { expectedRevision: 0 });
  assert.equal(scene.exportRecipe().shadow.hard, true);
});

test('set-shadow still names the fields when a key is misspelled', () => {
  const scene = createAgentScene(plainRecipe());
  assert.throws(
    () => scene.apply([{ type: 'set-shadow', shadow: { resolutoin: 2048 } }], { expectedRevision: 0 }),
    /shadow\.resolutoin: got 2048; expected one of the fields target, extent, distance, near, far, hard; remove resolutoin/,
  );
});
