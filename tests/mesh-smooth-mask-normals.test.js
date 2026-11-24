import assert from 'node:assert/strict';
import test from 'node:test';
import { smoothedMaskNormals } from '../src/mesh-smooth-mask-normals.js';

// A strip of quads along x. Vertex normals alternate between two tilts (in the x-y plane), which makes a fine zigzag in the
// slope; `tiltDegrees` picks how far the two tilts are apart.
function stripGeometry(tiltDegrees) {
  const cells = 12;
  const positions = [];
  const normals = [];
  for (let column = 0; column <= cells; column++) {
    for (const z of [0, 1]) {
      positions.push(column, 0, z);
      const angle = ((column % 2 === 0 ? 0 : tiltDegrees) * Math.PI) / 180;
      normals.push(Math.sin(angle), Math.cos(angle), 0);
    }
  }
  const indices = [];
  for (let column = 0; column < cells; column++) {
    const corner = column * 2;
    indices.push(corner, corner + 2, corner + 3, corner, corner + 3, corner + 1);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}

function slopeAt(normals, vertex) {
  return Math.acos(normals[vertex * 3 + 1]);
}

test('a zigzag of gentle tilts is evened out', () => {
  const geometry = stripGeometry(20);
  const smoothed = smoothedMaskNormals(geometry, geometry.normals);
  const middle = [10, 12, 14].map(vertex => slopeAt(smoothed, vertex));
  const swing = Math.max(...middle) - Math.min(...middle);
  assert.ok(swing < 0.5 * (20 * Math.PI) / 180, `the middle of the strip still swings ${swing} radians`);
});

test('a crease wider than the gate is left alone', () => {
  const geometry = stripGeometry(70);
  const smoothed = smoothedMaskNormals(geometry, geometry.normals);
  assert.ok(Math.abs(slopeAt(smoothed, 12) - 0) < 1e-3 && Math.abs(slopeAt(smoothed, 14) - (70 * Math.PI) / 180) < 1e-3, 'a 70 degree crease was averaged');
});

test('the result is cached per geometry and identical on a second geometry', () => {
  const first = stripGeometry(20);
  const second = stripGeometry(20);
  assert.equal(smoothedMaskNormals(first, first.normals), smoothedMaskNormals(first, first.normals));
  assert.deepEqual(smoothedMaskNormals(first, first.normals), smoothedMaskNormals(second, second.normals));
});
