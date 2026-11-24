import assert from 'node:assert/strict';
import test from 'node:test';
import { surfaceMap } from '../src/material-surface-map.js';
import { weldedMaskNormals } from '../src/mesh-weld-normals.js';

const RESOLUTION = 64;
const SEAM_COLUMN = RESOLUTION / 2;
const LEFT_TILT = Math.PI / 18;
const RIGHT_TILT = (5 * Math.PI) / 18;

// Two quads side by side that meet along x = 0. Each quad has its own vertices at the seam (a crease split), carrying
// normals tilted 10 and 50 degrees from straight up, so the split normals alone give a jump at the seam.
function creasedGeometry() {
  const positions = [-1, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
  const left = [-Math.sin(LEFT_TILT), Math.cos(LEFT_TILT), 0];
  const right = [Math.sin(RIGHT_TILT), Math.cos(RIGHT_TILT), 0];
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from([...left, ...left, ...left, ...left, ...right, ...right, ...right, ...right]),
    uvs: Float32Array.from([0, 0, 0.5, 0, 0.5, 1, 0, 1, 0.5, 0, 1, 0, 1, 1, 0.5, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  };
}

function cubeWithHardEdges() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const faces = [[[1, 0, 0], [0, 0, -1]], [[0, 1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 0]]];
  faces.forEach(([normal, tangent], faceIndex) => {
    const bitangent = [normal[1] * tangent[2] - normal[2] * tangent[1], normal[2] * tangent[0] - normal[0] * tangent[2], normal[0] * tangent[1] - normal[1] * tangent[0]];
    const base = positions.length / 3;
    for (const [across, up] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) positions.push(0.5 * normal[axis] + 0.5 * across * tangent[axis] + 0.5 * up * bitangent[axis]);
      normals.push(...normal);
      uvs.push((faceIndex + (across + 1) / 2) / 3, (up + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices),
  };
}

function valueAt(map, column, row) {
  return map.data[(row * map.width + column) * 4];
}

test('two coincident vertices with different normals get the same mask value', () => {
  const geometry = creasedGeometry();
  const map = surfaceMap(geometry, { output: 'slope', space: 'object' }, RESOLUTION, 'mask');
  const row = RESOLUTION / 2;
  const jump = Math.abs(valueAt(map, SEAM_COLUMN, row) - valueAt(map, SEAM_COLUMN - 1, row));
  assert.ok(jump <= 4, `the slope mask jumps by ${jump} across the crease; the split normals were read instead of the welded one`);
  const welded = weldedMaskNormals(geometry);
  Array.from(welded.subarray(3, 6)).forEach((component, axis) => assert.ok(Math.abs(component - welded[12 + axis]) < 1e-2, 'the welded normals at the crease differ'));
});

test('welding leaves the shading normals untouched', () => {
  const geometry = creasedGeometry();
  const before = Array.from(geometry.normals);
  const welded = weldedMaskNormals(geometry);
  assert.notEqual(welded, geometry.normals);
  assert.deepEqual(Array.from(geometry.normals), before);
});

test('a mesh whose hard edges are sharp, or without creases, keeps its normals bit for bit', () => {
  const cube = cubeWithHardEdges();
  assert.deepEqual(Array.from(weldedMaskNormals(cube)), Array.from(cube.normals));
  const smooth = { ...creasedGeometry() };
  smooth.normals = Float32Array.from({ length: 24 }, (_, index) => (index % 3 === 1 ? 1 : 0));
  assert.equal(weldedMaskNormals(smooth), smooth.normals);
});

test('a mesh without normals has nothing to weld', () => {
  const { normals, ...bare } = creasedGeometry();
  assert.equal(weldedMaskNormals(bare), undefined);
  assert.ok(surfaceMap(bare, { output: 'slope', space: 'object' }, RESOLUTION, 'mask'));
});

function twoVerticesAt(firstAngleDegrees, secondAngleDegrees) {
  const normalAt = degrees => [Math.sin((degrees * Math.PI) / 180), Math.cos((degrees * Math.PI) / 180), 0];
  return {
    positions: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1]),
    normals: Float32Array.from([...normalAt(firstAngleDegrees), ...normalAt(secondAngleDegrees), ...normalAt(0), ...normalAt(0), ...normalAt(0), ...normalAt(0)]),
    indices: Uint32Array.from([0, 2, 3, 1, 4, 5]),
  };
}

test('a crease under a right angle welds and one over it stays hard', () => {
  const steep = twoVerticesAt(-40, 40);
  const steepWelded = weldedMaskNormals(steep);
  assert.deepEqual(Array.from(steepWelded.subarray(0, 3)), Array.from(steepWelded.subarray(3, 6)));
  const overhang = twoVerticesAt(-50, 50);
  assert.deepEqual(Array.from(weldedMaskNormals(overhang)), Array.from(overhang.normals));
});

function tiltFromUpDegrees(array, vertex) {
  const length = Math.hypot(array[vertex * 3], array[vertex * 3 + 1], array[vertex * 3 + 2]);
  return (Math.acos(array[vertex * 3 + 1] / length) * 180) / Math.PI;
}

test('a steep face welded to a flat one stays steeper than their plain average, and the flat face keeps the average', () => {
  const welded = weldedMaskNormals(twoVerticesAt(-80, 0));
  const steepTilt = tiltFromUpDegrees(welded, 0);
  const flatTilt = tiltFromUpDegrees(welded, 1);
  // The angle-weighted plain average of an 80 and a 0 degree normal leans about 56 degrees; a cliff vertex keeps the cliff's 80.
  assert.ok(steepTilt > 79, `the steep vertex leans ${steepTilt.toFixed(1)} degrees, a mix with the flat face lightens the cliff`);
  assert.ok(Math.abs(flatTilt - 55.6) < 1, `the flat vertex leans ${flatTilt.toFixed(1)} degrees, so the cliff darkens the gentle face next to it`);
});

test('the slope mask stays high next to the crease on the steep side', () => {
  const geometry = creasedGeometry();
  const steepTilt = (80 * Math.PI) / 180;
  const steep = [-Math.sin(steepTilt), Math.cos(steepTilt), 0];
  geometry.normals = Float32Array.from([...steep, ...steep, ...steep, ...steep, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const map = surfaceMap(geometry, { output: 'slope', space: 'object' }, RESOLUTION, 'mask');
  const nearCrease = valueAt(map, SEAM_COLUMN - 1, RESOLUTION / 2);
  // A plain average puts the crease at 40 degrees, a slope mask value of 113; the lean keeps it above 135.
  assert.ok(nearCrease >= 135, `the steep face reads ${nearCrease} next to the crease, the snow creeps up the cliff`);
});
