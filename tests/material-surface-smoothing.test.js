import assert from 'node:assert/strict';
import test from 'node:test';
import { surfaceMap } from '../src/material-surface-map.js';

// A grid of quads whose vertex normals alternate between flat and tilted, so the raw slope is a fine checkerboard of ramps.
function checkerboardGeometry(cells) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const tilt = Math.PI / 5;
  for (let row = 0; row <= cells; row++) {
    for (let column = 0; column <= cells; column++) {
      positions.push(column, 0, row);
      const angle = (row + column) % 2 === 0 ? 0 : tilt;
      normals.push(Math.sin(angle), Math.cos(angle), 0);
      uvs.push(column / cells, row / cells);
    }
  }
  const indices = [];
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const corner = row * (cells + 1) + column;
      indices.push(corner, corner + 1, corner + cells + 2, corner, corner + cells + 2, corner + cells + 1);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

test('the slope bake of a finely creased mesh swings less than the vertex values', () => {
  const cells = 128;
  const resolution = 512;
  const map = surfaceMap(checkerboardGeometry(cells), { output: 'slope', space: 'object' }, resolution, 'checkerboard');
  const rawSwing = Math.round((255 * (Math.PI / 5)) / (Math.PI / 2));
  let low = 255;
  let high = 0;
  for (let row = 200; row < 312; row++) {
    for (let column = 200; column < 312; column++) {
      const value = map.data[(row * resolution + column) * 4];
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  assert.ok(high - low < 0.6 * rawSwing, `the mask swings ${high - low} where the vertices differ by ${rawSwing}`);
});

// A row of quads that rises gently, then steeply: the last faces are steeper than 72 degrees, their neighbours are not. A
// per-triangle switch between smoothed and welded normals left a jump at the edge between the two kinds of face.
test('the mask has no jump where a steep face meets a gentle one', () => {
  const heights = [0, 0, 0.2, 3, 6];
  const tilts = [10, 10, 30, 80, 80];
  const positions = [];
  const normals = [];
  const uvs = [];
  heights.forEach((height, column) => {
    for (const z of [0, 1]) {
      positions.push(column, height, z);
      const angle = (tilts[column] * Math.PI) / 180;
      normals.push(Math.sin(angle), Math.cos(angle), 0);
      uvs.push(column / (heights.length - 1), z);
    }
  });
  const indices = [];
  for (let column = 0; column < heights.length - 1; column++) {
    const corner = column * 2;
    indices.push(corner, corner + 2, corner + 3, corner, corner + 3, corner + 1);
  }
  const geometry = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
  const resolution = 256;
  const map = surfaceMap(geometry, { output: 'slope', space: 'object' }, resolution, 'rise');
  let largestStep = 0;
  for (let column = 2; column < resolution - 2; column++) {
    const step = Math.abs(map.data[((resolution / 2) * resolution + column + 1) * 4] - map.data[((resolution / 2) * resolution + column) * 4]);
    largestStep = Math.max(largestStep, step);
  }
  assert.ok(largestStep <= 4, `the mask jumps by ${largestStep} between neighbouring texels`);
});
