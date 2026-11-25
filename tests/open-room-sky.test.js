// A set open on one side (three walls and a ceiling) is a room for the sky trace: the ceiling and the walls hide the sky they cover,
// as in a closed room, instead of the whole sky lighting them as if they stood outdoors (#3389).
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { applyDefaultFloorSky, interiorWeight } from '../src/floor-sky-visibility.js';
import { fittedRoomHasWalls, OPEN_SIDED_ROOM_WALL_SHARE } from '../src/fitted-closed-room.js';
import { partMatrixLookup } from '../src/closed-room.js';

const SUN = { keyColor: [3, 3, 3], lightDirection: [-0.4, -1, -0.3] };
const SMALL_TRACE = { maximumTexels: 1500 };

// `rounded` turns every box by a hair (0.01 degrees), which leaves it out of the join test (src/room-box-joins.js, #3433): the boxes keep their rounded edges
// instead of being drawn sharp where they meet.
function setParts({ front = false, ceiling = true, rounded = false } = {}) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'wall', translation, scale, ...(rounded ? { rotation: [0, 0, 1e-4, 1] } : {}) });
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

// The mean over the vertices of the face that looks into the room (normal along `axis` with `sign`): the outer faces see the whole sky and would hide what the room face sees.
function meanSkyVisibility(result, name, axis, sign) {
  const { normals, skyVisibility } = result.parts.find(part => part.name === name).geometry;
  assert.ok(skyVisibility, `${name} carries the sky it sees`);
  const roomFace = [];
  for (let vertex = 0; vertex < skyVisibility.length; vertex++) {
    if (normals[vertex * 3 + axis] * sign > 0.9) roomFace.push(skyVisibility[vertex]);
  }
  assert.ok(roomFace.length > 20, `${name} has ${roomFace.length} points on its room face`);
  return roomFace.reduce((total, value) => total + value, 0) / roomFace.length;
}

test('three walls and a ceiling have walls on three quarters of the ring: a room for the loose test, not the strict one', () => {
  const parts = setParts();
  assert.equal(fittedRoomHasWalls(parts, partMatrixLookup(parts)), false);
  assert.equal(fittedRoomHasWalls(parts, partMatrixLookup(parts), OPEN_SIDED_ROOM_WALL_SHARE), true);
});

test('an open-sided set gets the sky trace on its ceiling and walls, and the report names the branch', () => {
  const result = applyDefaultFloorSky(setParts(), SUN, SMALL_TRACE);
  assert.equal(result.report.branch, 'open-sided room, every surface traced');
  assert.ok(meanSkyVisibility(result, 'ceiling', 1, -1) < 0.7, 'the ceiling underside no longer sees the whole sky');
  assert.ok(meanSkyVisibility(result, 'wall-back', 2, 1) < 0.7, 'the back wall no longer sees the whole sky');
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

test('the fill of an open-sided room fades out between a quarter and a half of escaping rays', () => {
  assert.equal(interiorWeight(0, true), 1);
  assert.equal(interiorWeight(0.25, true), 1);
  const justPast = interiorWeight(0.2501, true);
  assert.ok(justPast < 1 && justPast > 0.99, `just past a quarter: ${justPast}`);
  assert.ok(Math.abs(interiorWeight(0.375, true) - 0.5) < 1e-9);
  const justBefore = interiorWeight(0.4999, true);
  assert.ok(justBefore > 0 && justBefore < 0.01, `just before a half: ${justBefore}`);
  assert.equal(interiorWeight(0.5, true), 0);
  assert.equal(interiorWeight(0.9, true), 0);
});

test('a room walled all round keeps the hard cut at a quarter of escaping rays', () => {
  assert.equal(interiorWeight(0.25, false), 1);
  assert.equal(interiorWeight(0.2501, false), 0);
  assert.equal(interiorWeight(0.375, false), 0);
});

// The rounded edge of the back wall runs along its top and bottom: with the corner falloff of the fill and a coarse cut, a point there and its
// neighbours differed a lot, which drew a scalloped line. Points on one ring of the rounded edge share a height.
test('the rounded edge of a wall of an open-sided set has no alternating sky values', () => {
  const result = applyDefaultFloorSky(setParts({ rounded: true }), SUN, { maximumTexels: 3000 });
  const { positions, normals, skyVisibility } = result.parts.find(part => part.name === 'wall-back').geometry;
  const rings = new Map();
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const sideways = Math.abs(normals[vertex * 3]);
    if (normals[vertex * 3 + 2] < 0.1 || normals[vertex * 3 + 2] > 0.99 || sideways > 0.05) continue;
    const ring = positions[vertex * 3 + 1].toFixed(3);
    if (!rings.has(ring)) rings.set(ring, []);
    rings.get(ring).push({ across: positions[vertex * 3], sky: skyVisibility[vertex] });
  }
  let largestStep = 0;
  let pointsCompared = 0;
  for (const ring of rings.values()) {
    ring.sort((first, second) => first.across - second.across);
    for (let index = 1; index < ring.length; index++) {
      largestStep = Math.max(largestStep, Math.abs(ring[index].sky - ring[index - 1].sky));
      pointsCompared++;
    }
  }
  assert.ok(pointsCompared > 20, `the rounded edge has points (${pointsCompared})`);
  assert.ok(largestStep < 0.06, `neighbouring points of one ring differ by ${largestStep}`);
});
