import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { applyDefaultFloorSky } from '../src/floor-sky-visibility.js';

// A closed room: a floor, four walls and a closed roof, lit by a sun.
function room(environment = {}) {
  const wall = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.5, 0.45, 0.4], roughness: 0.8 }],
    nodes: [
      wall('floor', [0, -0.05, 0], [10, 0.1, 10]),
      wall('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      wall('wall-right', [5, 2, 0], [0.2, 4, 10]),
      wall('wall-front', [0, 2, 5], [10, 4, 0.2]),
      wall('wall-back', [0, 2, -5], [10, 4, 0.2]),
      wall('roof-a', [-2.5, 4.1, 0], [5.2, 0.2, 10.4]),
      wall('roof-b', [2.5, 4.1, 0], [5.2, 0.2, 10.4]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment,
  };
}

function floorHasSkyVisibility(scene) {
  return Boolean(scene.parts.find(part => part.name === 'floor').geometry.skyVisibility);
}

// The recipe path runs the same call with the default texel count, which takes seconds; the test keeps the trace small.
test('a closed room lit by a sun gets the floor sky trace by default', () => {
  const { parts } = createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }));
  const result = applyDefaultFloorSky(parts, { keyColor: [3, 3, 3] }, { maximumTexels: 400 });
  assert.equal(result.report.reason, null);
  assert.ok(result.parts.find(part => part.name === 'floor').geometry.skyVisibility);
});

test('environment.floorSkyTrace false turns the trace off', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }))), false);
});

test('environment.floorSkyTrace that is not a boolean is refused, not read as on', () => {
  for (const value of ['off', 0, null, { enabled: false }]) {
    assert.throws(() => createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: value })), /environment\.floorSkyTrace: got .*; expected true or false/);
  }
});

test('a room with no sun and open ground are left as they were', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [0, 0, 0] }))), false);
  const open = room({ keyColor: [3, 3, 3] });
  open.nodes = open.nodes.filter(node => node.id === 'floor' || node.id === 'roof-a');
  assert.equal(floorHasSkyVisibility(createAgentScene(open)), false);
});

// The demo room without its one boolean geometry. Moving the pendant bulb changes whether the sky trace cuts the ground, and
// a retained part keeps its old matrix until the commit, so an edit in place used to stage the trace against the old place (#3064).
test('a node moved in place gives the ground the geometry a build of the edited recipe gives', () => {
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  delete recipe.bake;
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'organiser');
  recipe.geometries = recipe.geometries.filter(geometry => geometry.id !== 'organiser');
  const edited = createAgentScene(recipe);
  const movedBulb = { type: 'set-node', id: 'pendant-bulb', translation: [0.3, 1.7, 0.2] };
  const groundOf = scene => scene.parts.find(part => part.name === 'ground').geometry;
  const plainGroundVertices = groundOf(edited).positions.length;
  const movedRecipe = structuredClone(edited.exportRecipe());
  movedRecipe.nodes.find(node => node.id === movedBulb.id).translation = movedBulb.translation;
  edited.apply([movedBulb], { expectedRevision: edited.revision });
  const freshGround = groundOf(createAgentScene(movedRecipe));
  assert.ok(freshGround.positions.length > plainGroundVertices, 'the moved bulb makes the sky trace cut the ground');
  for (const field of Object.keys(freshGround)) {
    assert.deepEqual(groundOf(edited)[field], freshGround[field], field);
  }
});
