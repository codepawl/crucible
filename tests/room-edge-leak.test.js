import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { MAXIMUM_JOINED_BOX_NODES } from '../src/room-box-joins.js';
import { beveledJoinNodes, roomEdgeLeakDiagnostic } from '../src/room-edge-leak.js';

const WALL = 0.2;

function slab(id, translation, scale) {
  return { id, geometry: 'box', material: 'stone', translation, scale };
}

// A 10 x 6 x 10 room of six slabs that meet face to face.
function roomRecipe(boxGeometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [boxGeometry],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [
      slab('floor', [0, -3, 0], [10, WALL, 10]),
      slab('north', [0, 0, -5], [10, 6, WALL]),
      slab('south', [0, 0, 5], [10, 6, WALL]),
      slab('west', [-5, 0, 0], [WALL, 6, 10]),
      slab('east', [5, 0, 0], [WALL, 6, 10]),
      slab('roof', [0, 3, 0], [10, WALL, 10]),
    ],
  };
}

async function inspectedKinds(recipe) {
  await loadAgentSceneModules(recipe);
  return (createAgentScene(recipe).inspect().diagnostics ?? []).map(entry => entry.kind);
}

// A room whose boxes stay rounded: with more rounded boxes than the join test compares (src/room-box-joins.js), none of them is drawn sharp.
function roomOfRoundedBoxes() {
  const recipe = roomRecipe({ id: 'box', type: 'box' });
  const crowd = Array.from({ length: MAXIMUM_JOINED_BOX_NODES }, (_, index) => slab(`filler-${index}`, [100 + index * 3, 0, 0], [1, 1, 1]));
  return { ...recipe, nodes: [...recipe.nodes, ...crowd] };
}

test('a room of default-bevel boxes that stay rounded gets a room-edge-leak diagnostic that names the fix', () => {
  const found = roomEdgeLeakDiagnostic(roomOfRoundedBoxes());
  assert.equal(found.severity, 'warning');
  assert.match(found.fix, /"bevel": 0/);
});

test('the default six-slab room is drawn sharp at its joins, so it gets no room-edge-leak diagnostic', async () => {
  const recipe = roomRecipe({ id: 'box', type: 'box' });
  assert.deepEqual(beveledJoinNodes(recipe), []);
  assert.equal(roomEdgeLeakDiagnostic(recipe), null);
  assert.ok(!(await inspectedKinds(recipe)).includes('room-edge-leak'));
});

test('a closed room of bevel 0 boxes has no room-edge-leak diagnostic', async () => {
  assert.ok(!(await inspectedKinds(roomRecipe({ id: 'box', type: 'box', bevel: 0 }))).includes('room-edge-leak'));
});

test('a few beveled props that touch a floor are not a room', () => {
  const recipe = roomRecipe({ id: 'box', type: 'box' });
  recipe.nodes = recipe.nodes.slice(0, 3);
  assert.deepEqual(beveledJoinNodes(recipe), []);
});

test('rotated and parented boxes are left out of the join test', () => {
  const recipe = roomRecipe({ id: 'box', type: 'box' });
  recipe.nodes = recipe.nodes.map(node => ({ ...node, rotation: [0, 0.7071068, 0, 0.7071068] }));
  assert.deepEqual(beveledJoinNodes(recipe), []);
});
