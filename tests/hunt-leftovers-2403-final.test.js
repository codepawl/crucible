import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { generateMeshGeometry } from '../src/agent-mesh.js';
import { exportObj } from '../src/export-mesh.js';
import { box } from '../src/geometry.js';

test('exportObj formats Float32Array material colors with formatNumber instead of Float32 string coercion (#2403)', () => {
  const { mtl } = exportObj([{
    name: 'Box',
    geometry: box(),
    matrix: mat4.create(),
    material: {
      color: new Float32Array([0.8, 0.1, 0.1]),
      emissiveColor: new Float32Array([0.8, 0.4, 0.2]),
      emission: 0.5,
      metallic: 0,
      roughness: 0.4,
    },
  }]);
  assert.match(mtl, /^Kd 0\.800000012 0\.100000001 0\.100000001$/m);
  assert.match(mtl, /^Ke 0\.400000006 0\.200000003 0\.100000001$/m);

  const exactArray = exportObj([{
    name: 'Box',
    geometry: box(),
    matrix: mat4.create(),
    material: { color: [0.5, 0.25, 0.125], metallic: 0, roughness: 0.4 },
  }]);
  const exactTyped = exportObj([{
    name: 'Box',
    geometry: box(),
    matrix: mat4.create(),
    material: { color: new Float32Array([0.5, 0.25, 0.125]), metallic: 0, roughness: 0.4 },
  }]);
  assert.equal(exactTyped.mtl, exactArray.mtl);
});

test('generateMeshGeometry edit cache respects maxVertices across calls (#2403)', () => {
  const edits = [{ op: 'subdivide_edges', edges: { all: true }, cuts: 3 }];
  const stack = [{ op: 'decimate', ratio: 0.1 }];
  const cacheKey = `hunt-2403-cache-${Date.now()}`;
  const large = generateMeshGeometry(() => box(0), edits, { maxVertices: 1000, stack, cacheKey });
  assert.ok(large.positions.length / 3 <= 35);
  assert.throws(
    () => generateMeshGeometry(() => box(0), edits, { maxVertices: 35, stack, cacheKey }),
    /within 35 vertices and 35 faces/,
  );
});
