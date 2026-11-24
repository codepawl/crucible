// A set open on one side (three walls and a ceiling) is a room for the sky trace: the ceiling and the walls hide the sky they cover,
// as in a closed room, instead of the whole sky lighting them as if they stood outdoors (#3389).
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { applyDefaultFloorSky } from '../src/floor-sky-visibility.js';
import { fittedRoomHasWalls, OPEN_SIDED_ROOM_WALL_SHARE } from '../src/fitted-closed-room.js';
import { partMatrixLookup } from '../src/closed-room.js';

const SUN = { keyColor: [3, 3, 3], lightDirection: [-0.4, -1, -0.3] };
const SMALL_TRACE = { maximumTexels: 1500 };

function setParts({ front = false, ceiling = true } = {}) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'wall', translation, scale });
  const { parts } = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'wall', color: [0.85, 0.62, 0.3], roughness: 0.9 }],
    nodes: [
      block('floor', [0, -0.05, 0], [10, 0.1, 8]),
      block('wall-back', [0, 2, -4], [10, 4, 0.2]),
      block('wall-left', [-5, 2, 0], [0.2, 4, 8]),
      block('wall-right', [5, 2, 0], [0.2, 4, 8]),
      ...(ceiling ? [block('ceiling', [0, 4.1, 0], [10.4, 0.2, 8.4])] : []),
      ...(front ? [block('wall-front', [0, 2, 4], [10, 4, 0.2])] : []),
    ],
    camera: { eye: [0, 1.6, 7.5], target: [0, 2, -1], fov: 70, near: 0.05, far: 60 },
    environment: { ...SUN, floorSkyTrace: false },
  });
  return parts;
}

function meanSkyVisibility(result, name) {
  const visibility = result.parts.find(part => part.name === name).geometry.skyVisibility;
  assert.ok(visibility, `${name} carries the sky it sees`);
  return visibility.reduce((total, value) => total + value, 0) / visibility.length;
}

test('three walls and a ceiling have walls on three quarters of the ring: a room for the loose test, not the strict one', () => {
  const parts = setParts();
  assert.equal(fittedRoomHasWalls(parts, partMatrixLookup(parts)), false);
  assert.equal(fittedRoomHasWalls(parts, partMatrixLookup(parts), OPEN_SIDED_ROOM_WALL_SHARE), true);
});

test('an open-sided set gets the sky trace on its ceiling and walls, and the report names the branch', () => {
  const result = applyDefaultFloorSky(setParts(), SUN, SMALL_TRACE);
  assert.equal(result.report.branch, 'open-sided room, every surface traced');
  assert.ok(meanSkyVisibility(result, 'ceiling') < 0.7, 'the ceiling underside no longer sees the whole sky');
  assert.ok(meanSkyVisibility(result, 'wall-back') < 0.7, 'the back wall no longer sees the whole sky');
});

test('a sealed room keeps its branch', () => {
  assert.equal(applyDefaultFloorSky(setParts({ front: true }), SUN, SMALL_TRACE).report.branch, 'closed room, every surface traced');
});

test('open ground says it was skipped', () => {
  const ground = setParts({ ceiling: false }).filter(part => part.name === 'floor' || part.name === 'wall-back');
  const result = applyDefaultFloorSky(ground, SUN, SMALL_TRACE);
  assert.equal(result.parts, ground);
  assert.match(result.report.branch, /skipped$/);
});
