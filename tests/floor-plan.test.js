import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { generateFloorPlanGeometry, floorPlanVertexEstimate } from '../src/agent-floor-plan.js';

const HEIGHT = 2.7;
const LARGE_VERTEX_LIMIT = 1_000_000;

function build(plan, part) {
  return generateFloorPlanGeometry(part === undefined ? plan : { ...plan, part }, LARGE_VERTEX_LIMIT);
}

function trianglesOf(mesh) {
  const triangles = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const corners = [0, 1, 2].map(corner => Array.from(mesh.positions.subarray(mesh.indices[offset + corner] * 3, mesh.indices[offset + corner] * 3 + 3)));
    const normal = Array.from(mesh.normals.subarray(mesh.indices[offset] * 3, mesh.indices[offset] * 3 + 3));
    triangles.push({ corners, normal });
  }
  return triangles;
}

function areaOf({ corners }) {
  const [first, second, third] = corners;
  const edgeOne = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const edgeTwo = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  return Math.hypot(
    edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
    edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
    edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
  ) / 2;
}

function facing(mesh, predicate) {
  return trianglesOf(mesh).filter(predicate);
}

function topTriangles(mesh, height = HEIGHT) {
  return facing(mesh, triangle => triangle.normal[1] > 0.99 && triangle.corners.every(corner => Math.abs(corner[1] - height) < 1e-5));
}

function totalArea(triangles) {
  return triangles.reduce((sum, triangle) => sum + areaOf(triangle), 0);
}

function centroidOf({ corners }) {
  return [0, 1, 2].map(axis => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3);
}

function pointInsideTriangle(point, { corners }) {
  const sides = [[0, 1], [1, 2], [2, 0]].map(([from, to]) => (corners[to][0] - corners[from][0]) * (point[2] - corners[from][2])
    - (corners[to][2] - corners[from][2]) * (point[0] - corners[from][0]));
  return sides.every(side => side > 1e-7) || sides.every(side => side < -1e-7);
}

// No triangle's centre may lie inside another triangle of the same layer: that would be an overlap.
function overlappingPairs(triangles) {
  let overlaps = 0;
  triangles.forEach((triangle, index) => {
    triangles.forEach((other, otherIndex) => {
      if (index !== otherIndex && pointInsideTriangle(centroidOf(triangle), other)) overlaps += 1;
    });
  });
  return overlaps;
}

function wall(from, to, thickness) {
  return thickness === undefined ? { from, to } : { from, to, thickness };
}

const L_CORNER = { walls: [wall([0, 0], [4, 0]), wall([4, 0], [4, 3])] };
const T_CORNER = { walls: [wall([0, 0], [4, 0]), wall([2, 0], [2, 3])] };
const X_CORNER = { walls: [wall([-2, 0], [2, 0]), wall([0, -2], [0, 2])] };
const TWO_ROOMS = {
  walls: [wall([0, 0], [8, 0]), wall([8, 0], [8, 5]), wall([8, 5], [0, 5]), wall([0, 5], [0, 0]), wall([4, 0], [4, 5])],
  openings: [
    { wall: 0, offset: 1, kind: 'door' },
    { wall: 0, offset: 5, kind: 'window' },
    { wall: 4, offset: 2, kind: 'door' },
    { wall: 2, offset: 1.5, kind: 'window', width: 1.5 },
  ],
};

test('an L corner is mitred: the tops tile the joined walls with no gap and no overlap', () => {
  const mesh = build(L_CORNER, 'walls');
  const tops = topTriangles(mesh);
  // Two 0.2 m walls, 4.1 m and 3.1 m long past the shared 0.2 m square: 0.82 + 0.62 - 0.04.
  assert.ok(Math.abs(totalArea(tops) - 1.4) < 1e-6, `top area ${totalArea(tops)}`);
  assert.equal(overlappingPairs(tops), 0);
  const corners = new Set(tops.flatMap(triangle => triangle.corners.map(corner => `${corner[0].toFixed(4)},${corner[2].toFixed(4)}`)));
  assert.ok(corners.has('4.1000,-0.1000'), 'outer mitre point');
  assert.ok(corners.has('3.9000,0.1000'), 'inner mitre point');
});

test('a T corner needs no overlap or gap where a wall ends on the side of another', () => {
  const mesh = build(T_CORNER, 'walls');
  const tops = topTriangles(mesh);
  // The through wall is 4 x 0.2, the stem adds 0.2 x 2.9 past its face.
  assert.ok(Math.abs(totalArea(tops) - 1.38) < 1e-6, `top area ${totalArea(tops)}`);
  assert.equal(overlappingPairs(tops), 0);
});

test('an X corner of two crossing walls splits both and tiles the cross', () => {
  const mesh = build(X_CORNER, 'walls');
  const tops = topTriangles(mesh);
  assert.ok(Math.abs(totalArea(tops) - 1.56) < 1e-6, `top area ${totalArea(tops)}`);
  assert.equal(overlappingPairs(tops), 0);
});

test('four walls that share one end point meet as an X with a cap over the middle', () => {
  const mesh = build({ walls: [wall([0, 0], [2, 0]), wall([0, 0], [-2, 0]), wall([0, 0], [0, 2]), wall([0, 0], [0, -2])] }, 'walls');
  const tops = topTriangles(mesh);
  assert.ok(Math.abs(totalArea(tops) - 1.56) < 1e-6, `top area ${totalArea(tops)}`);
  assert.equal(overlappingPairs(tops), 0);
});

test('walls of different thickness meet with a closed step and no gap', () => {
  const mesh = build({ walls: [wall([0, 0], [4, 0], 0.3), wall([4, 0], [4, 3], 0.2)] }, 'walls');
  const tops = topTriangles(mesh);
  assert.equal(overlappingPairs(tops), 0);
  assert.ok(totalArea(tops) > 1.5 && totalArea(tops) < 2);
});

test('a door opening is cut to its width and height, with a jamb and a lintel', () => {
  const plan = { walls: [wall([0, 0], [4, 0])], openings: [{ wall: 0, offset: 1, width: 0.9, height: 2.1, kind: 'door' }] };
  const mesh = build(plan, 'walls');
  const frontFaces = facing(mesh, triangle => triangle.normal[2] > 0.99 && triangle.corners.every(corner => Math.abs(corner[2] - 0.1) < 1e-6));
  assert.ok(Math.abs(totalArea(frontFaces) - (4 * HEIGHT - 0.9 * 2.1)) < 1e-6);
  const jambs = facing(mesh, triangle => Math.abs(triangle.normal[0]) > 0.99 && triangle.corners.every(corner => corner[0] > 0.99 && corner[0] < 1.91));
  assert.ok(Math.abs(totalArea(jambs) - 2 * 0.2 * 2.1) < 1e-6);
  const lintel = facing(mesh, triangle => triangle.normal[1] < -0.99);
  assert.ok(Math.abs(totalArea(lintel) - 0.9 * 0.2) < 1e-6);
  assert.equal(facing(mesh, triangle => triangle.normal[1] > 0.99 && triangle.corners.every(corner => corner[1] < 0.01)).length, 0, 'a door has no sill face');
});

test('a window has a sill, a lintel and the wall above and below it', () => {
  const plan = { walls: [wall([0, 0], [4, 0])], openings: [{ wall: 0, offset: 2, width: 1.2, height: 1.2, sill: 0.9, kind: 'window' }] };
  const mesh = build(plan, 'walls');
  const frontFaces = facing(mesh, triangle => triangle.normal[2] > 0.99 && triangle.corners.every(corner => Math.abs(corner[2] - 0.1) < 1e-6));
  assert.ok(Math.abs(totalArea(frontFaces) - (4 * HEIGHT - 1.2 * 1.2)) < 1e-6);
  const sill = facing(mesh, triangle => triangle.normal[1] > 0.99 && triangle.corners.every(corner => Math.abs(corner[1] - 0.9) < 1e-6));
  assert.ok(Math.abs(totalArea(sill) - 1.2 * 0.2) < 1e-6);
  const lintel = facing(mesh, triangle => triangle.normal[1] < -0.99 && triangle.corners.every(corner => Math.abs(corner[1] - 2.1) < 1e-6));
  assert.ok(Math.abs(totalArea(lintel) - 1.2 * 0.2) < 1e-6);
});

test('the wall top stays whole above openings and is cut at their edges', () => {
  const plan = { walls: [wall([0, 0], [4, 0])], openings: [{ wall: 0, offset: 1, kind: 'door' }, { wall: 0, offset: 2.5, kind: 'window' }] };
  const tops = topTriangles(build(plan, 'walls'));
  assert.ok(Math.abs(totalArea(tops) - 0.8) < 1e-6);
  assert.equal(overlappingPairs(tops), 0);
});

test('two rooms get a floor and a ceiling each, and the floor carries across a doorway', () => {
  const mesh = build(TWO_ROOMS, 'floor');
  const floorTriangles = trianglesOf(mesh);
  // Two rooms of 3.8 x 4.8 inside the walls, plus a 0.9 x 0.2 threshold under each of the two doors.
  assert.ok(Math.abs(totalArea(floorTriangles) - (2 * 3.8 * 4.8 + 2 * 0.9 * 0.2)) < 1e-4);
  assert.ok(floorTriangles.every(triangle => triangle.normal[1] > 0.99));
  const ceiling = trianglesOf(build(TWO_ROOMS, 'ceiling'));
  assert.ok(Math.abs(totalArea(ceiling) - 2 * 3.8 * 4.8) < 1e-4);
  assert.ok(ceiling.every(triangle => triangle.normal[1] < -0.99 && triangle.corners.every(corner => Math.abs(corner[1] - HEIGHT) < 1e-6)));
});

test('door and window presets fill their openings inside the wall', () => {
  const doors = build(TWO_ROOMS, 'doors');
  const windows = build(TWO_ROOMS, 'windows');
  const glass = build(TWO_ROOMS, 'glass');
  for (const [mesh, count] of [[doors, 2], [windows, 2], [glass, 2]]) {
    assert.equal(mesh.positions.length / 3 % count, 0);
    for (let offset = 1; offset < mesh.positions.length; offset += 3) assert.ok(mesh.positions[offset] >= 0 && mesh.positions[offset] <= HEIGHT);
  }
  const highestDoor = Math.max(...Array.from(doors.positions).filter((_, index) => index % 3 === 1));
  assert.ok(Math.abs(highestDoor - 2.1) < 1e-6, 'a door is 2.1 m tall by default');
  const lowestWindow = Math.min(...Array.from(windows.positions).filter((_, index) => index % 3 === 1));
  assert.ok(Math.abs(lowestWindow - 0.9) < 1e-6, 'a window sits 0.9 m up by default');
  assert.equal(build(TWO_ROOMS, 'all').positions.length / 3, ['walls', 'floor', 'ceiling', 'doors', 'windows', 'glass'].reduce((sum, part) => sum + build(TWO_ROOMS, part).positions.length / 3, 0));
});

test('the same plan builds the same bytes every time', () => {
  const first = build(TWO_ROOMS);
  const second = build(JSON.parse(JSON.stringify(TWO_ROOMS)));
  for (const key of ['positions', 'normals', 'uvs', 'indices']) {
    assert.ok(Buffer.from(first[key].buffer).equals(Buffer.from(second[key].buffer)), key);
  }
});

test('a recipe floorPlan geometry becomes a part and each piece takes its own material', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'plaster', color: [0.9, 0.88, 0.82], roughness: 0.9 }, { id: 'oak', color: [0.5, 0.35, 0.2], roughness: 0.6 }],
    geometries: [
      { id: 'house-walls', type: 'floorPlan', part: 'walls', ...TWO_ROOMS },
      { id: 'house-floor', type: 'floorPlan', part: 'floor', ...TWO_ROOMS },
    ],
    nodes: [{ id: 'walls', geometry: 'house-walls', material: 'plaster' }, { id: 'floor', geometry: 'house-floor', material: 'oak' }],
  };
  const scene = createAgentScene(recipe);
  assert.equal(scene.parts.length, 2);
  assert.equal(scene.parts[0].geometry.positions.length, build(TWO_ROOMS, 'walls').positions.length);
  assert.throws(() => createAgentScene(recipe, { maxVertices: 300 }), /vertices|maxVertices/);
  assert.throws(() => createAgentScene({ ...recipe, geometries: [{ id: 'house-walls', type: 'floorPlan', ...TWO_ROOMS, colour: 'red' }] }), /colour/);
});

test('the vertex estimate is an upper bound of what a plan builds', () => {
  assert.ok(floorPlanVertexEstimate(TWO_ROOMS) >= build(TWO_ROOMS).positions.length / 3);
});

test('openings past the end of a wall, over each other or above the wall are refused with the fix', () => {
  const withOpening = opening => ({ walls: [wall([0, 0], [4, 0])], openings: Array.isArray(opening) ? opening : [opening] });
  assert.throws(() => build(withOpening({ wall: 0, offset: 3.5, width: 0.9, kind: 'door' })), /openings\[0\]\.offset.*to 3\.1 so that/);
  assert.throws(() => build(withOpening({ wall: 3, offset: 1, kind: 'door' })), /openings\[0\]\.wall.*0 to 0/);
  assert.throws(() => build(withOpening({ wall: 0, offset: 1, sill: 0.9, height: 1.8, kind: 'window' })), /openings\[0\]\.height.*sill \(0\.9\) \+ height.*under the wall height 2\.7/);
  assert.throws(() => build(withOpening([{ wall: 0, offset: 1, kind: 'door' }, { wall: 0, offset: 1.5, kind: 'window' }])), /openings\[1\]\.offset.*clears opening 0/);
  assert.throws(() => build(withOpening({ wall: 0, offset: 1, kind: 'gate' })), /openings\[0\]\.kind.*door, window/);
  assert.throws(() => build(withOpening({ wall: 0, offset: 1, sill: 0.001 })), /openings\[0\]\.sill/);
  assert.throws(() => build(withOpening({ wall: 0, offset: 1, nope: 1 })), /openings\[0\]\.nope/);
});

test('an opening must sit clear of a joint and of the mitred end of its wall', () => {
  const corner = { ...L_CORNER, openings: [{ wall: 0, offset: 3.5, width: 0.5, kind: 'window' }] };
  assert.throws(() => build(corner), /openings\[0\]\.offset.*mitred corner.*between/);
  const acrossJoint = { ...T_CORNER, openings: [{ wall: 0, offset: 1.5, width: 1, kind: 'door' }] };
  assert.throws(() => build(acrossJoint), /openings\[0\]\.offset.*not across one/);
});

test('walls and openings are bounded, and bad walls name the field to fix', () => {
  const manyWalls = Array.from({ length: 257 }, (_, index) => wall([index * 2, 0], [index * 2 + 1, 0]));
  assert.throws(() => build({ walls: manyWalls }), /floorPlan\.walls.*at most 256/);
  const manyOpenings = Array.from({ length: 257 }, () => ({ wall: 0, offset: 1 }));
  assert.throws(() => build({ walls: [wall([0, 0], [4, 0])], openings: manyOpenings }), /floorPlan\.openings.*at most 256/);
  assert.throws(() => build({ walls: [] }), /floorPlan\.walls/);
  assert.throws(() => build({ walls: [wall([0, 0], [0.01, 0])] }), /walls\[0\]\.to.*at least 0\.1 m/);
  assert.throws(() => build({ walls: [wall([0, 0], [1, 0], 5)] }), /walls\[0\]\.thickness.*2/);
  assert.throws(() => build({ walls: [wall([0, 0], [4, Number.NaN])] }), /walls\[0\]\.to/);
  assert.throws(() => build({ walls: [{ from: [0, 0], to: [4, 0], height: 3 }] }), /walls\[0\]\.height/);
  assert.throws(() => build({ walls: [wall([0, 0], [4, 0])], height: 30 }), /floorPlan\.height/);
  assert.throws(() => build({ walls: [wall([0, 0], [4, 0])], part: 'roof' }), /floorPlan\.part.*one of all, walls/);
});

test('walls that overlap, meet at a sharp angle or use up their own length are refused', () => {
  assert.throws(() => build({ walls: [wall([0, 0], [4, 0]), wall([2, 0], [6, 0])] }), /run on top of each other/);
  assert.throws(() => build({ walls: [wall([0, 0], [4, 0]), wall([0, 0], [4, 0.5])] }), /at least 15 degrees apart/);
  assert.throws(() => build({ walls: [wall([0, 0], [0.15, 0]), wall([0.15, 0], [0.15, 4]), wall([0, 0], [0, 4])], height: 2.7 }, 'walls'), /long enough/);
});

test('a part the plan lacks is an error, not an empty mesh', () => {
  assert.throws(() => build(L_CORNER, 'floor'), /floor and ceiling need walls that close into a room/);
  assert.throws(() => build(L_CORNER, 'doors'), /no door openings exist/);
  assert.throws(() => build(L_CORNER, 'glass'), /no window openings exist/);
});
