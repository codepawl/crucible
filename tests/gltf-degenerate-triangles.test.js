import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

/** One mesh "Plate" with four vertices (a unit square corner set plus a point on the first edge) and the given index list. */
function plateDocument(indexList) {
  const floatBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0, 0]).buffer);
  const indexBytes = new Uint8Array(new Uint16Array(indexList).buffer);
  const bytes = new Uint8Array(floatBytes.length + indexBytes.length);
  bytes.set(floatBytes);
  bytes.set(indexBytes, floatBytes.length);
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: 'Plate', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: indexList.length, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: floatBytes.length }, { buffer: 0, byteOffset: floatBytes.length, byteLength: indexBytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  });
}

test('repeated-index and zero-area triangles are dropped, counted and the good triangles keep their order', async () => {
  // 0 1 2 good; 3 3 1 repeated; 0 1 3 collinear (zero area); 1 2 0 good.
  const asset = await parseGltf(plateDocument([0, 1, 2, 3, 3, 1, 0, 1, 3, 1, 2, 0]));
  assert.deepEqual([...asset.parts[0].geometry.indices], [0, 1, 2, 1, 2, 0]);
  assert.deepEqual(asset.warnings, ['Repaired primitive 0 of mesh "Plate": dropped 2 degenerate triangle(s) of 4 (1 with a repeated index, 1 with zero area).']);
});

test('an out-of-range index names the bad value, where it sits and what to do', async () => {
  await assert.rejects(parseGltf(plateDocument([0, 1, 2, 0, 1, 9])), /primitive 0 of mesh "Plate": an index is out of range of its POSITION accessor \(index value 9 at position 5 of 6, but the accessor has 4 vertices\); re-export/);
});

test('a mesh without degenerate triangles loads with its indices untouched and no warning', async () => {
  const asset = await parseGltf(plateDocument([0, 1, 2, 2, 1, 0]));
  assert.deepEqual([...asset.parts[0].geometry.indices], [0, 1, 2, 2, 1, 0]);
  assert.deepEqual(asset.warnings, []);
});

test('a mesh made only of degenerate triangles is still refused', async () => {
  await assert.rejects(parseGltf(plateDocument([0, 0, 1, 0, 1, 3])), /every triangle has zero area/);
});
