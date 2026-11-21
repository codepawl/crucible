// Parts from a glTF file often share a name, so a world matrix is keyed by the part, never by its name (#1635 did it for the closed room test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { applyFloorSkyVisibility } from '../src/floor-sky-visibility.js';
import { packObjectMotion, sampleWorldMatrices } from '../src/object-motion-blur.js';

function slab(center, size) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name: 'slab', geometry: box(0, 1), matrix, material: { color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.9 } };
}

// A sealed room: six slabs that all carry the name "slab".
function sealedRoomOfOneName() {
  return [
    slab([0, -0.1, 0], [8.4, 0.2, 8.4]),
    slab([0, 3.1, 0], [8.4, 0.2, 8.4]),
    slab([-4.1, 1.5, 0], [0.2, 3, 8.4]),
    slab([4.1, 1.5, 0], [0.2, 3, 8.4]),
    slab([0, 1.5, 4.1], [8, 3, 0.2]),
    slab([0, 1.5, -4.1], [8, 3, 0.2]),
  ];
}

test('a sealed room whose parts share one name is still called a closed room', () => {
  const result = applyFloorSkyVisibility(sealedRoomOfOneName(), { maximumTexels: 400 });
  assert.equal(result.report.reason, 'closed room');
});

function fakeRenderer(parts) {
  return { batches: [{ parts }], drawsInOpaqueLoop: () => true, takesObjectIds: () => true };
}

test('two moving parts with one name each get their own motion', () => {
  const parts = [
    { name: 'wheel', matrix: mat4.fromTranslation(mat4.create(), [1, 0, 0]) },
    { name: 'wheel', matrix: mat4.fromTranslation(mat4.create(), [0, 1, 0]) },
  ];
  const previous = sampleWorldMatrices(parts);
  parts[0].matrix[12] = 3;
  parts[1].matrix[13] = 4;
  const current = sampleWorldMatrices(parts);
  const packed = packObjectMotion(fakeRenderer(parts), current, previous);
  assert.deepEqual([...packed.matrices.slice(0, 16)], [...mat4.fromTranslation(mat4.create(), [-2, 0, 0])]);
  assert.deepEqual([...packed.matrices.slice(16, 32)], [...mat4.fromTranslation(mat4.create(), [0, -3, 0])]);
});
