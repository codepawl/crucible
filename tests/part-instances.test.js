import test from 'node:test';
import assert from 'node:assert/strict';
import { mat3, mat4 } from 'gl-matrix';
import { CrucibleRenderer } from '../src/renderer.js';
import { MAX_PART_INSTANCES, expandInstancedParts, validatePartInstances } from '../src/part-instances.js';
import { materialLayerState } from '../src/material-layers.js';
import { InstanceSelection, extractFrustumPlanes, selectInstances } from '../src/render-culling.js';

const GEOMETRY = {};
const STRIDE = 42;

function translationList(positions) {
  const matrices = new Float32Array(positions.length * 16);
  positions.forEach(([x, y, z], index) => mat4.fromTranslation(matrices.subarray(index * 16, index * 16 + 16), [x, y, z]));
  return matrices;
}

function createPart(positions, extra = {}, material = {}) {
  return {
    name: 'crowd', geometry: GEOMETRY, matrix: mat4.create(),
    material: { color: [0.1, 0.2, 0.3], metallic: 0.5, roughness: 0.3, emission: 0, ...material },
    instances: { matrices: translationList(positions), version: 0, ...extra },
  };
}

/** A renderer with the real instance path and a recorded upload log, built over a stub of the batch. */
function createRenderer(parts) {
  const expansion = expandInstancedParts(parts, null);
  const batch = { instanceBuffer: {}, instanceData: new Float32Array(expansion.parts.length * STRIDE), castShadow: true, receivesShadow: true, compositeMode: 0, alphaMode: parts[0].material.alphaMode ?? 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false, pass: 'opaque', mirrored: false };
  const uploads = [];
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData: (target, offset, data) => uploads.push(data.length) };
  renderer.sceneParts = parts;
  renderer.instanceGroups = expansion.groups ?? new Map();
  renderer.partLocations = new Map(expansion.parts.map((part, index) => [part, {
    batch, index, geometry: GEOMETRY, map: null, normalMatrix: mat3.create(), layerState: materialLayerState({}), skin: null,
    mapState: [null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02],
  }]));
  renderer.updateBatches = new Set();
  renderer.updateSkins = new Set();
  renderer.shadowsDirty = false;
  renderer.updateParts(expansion.parts);
  uploads.length = 0;
  renderer.shadowsDirty = false;
  return { renderer, batch, uploads, expansion };
}

test('an instance list is checked at the boundary and the errors say what to pass', () => {
  const bad = (instances, pattern, material) => assert.throws(() => validatePartInstances({ ...createPart([[0, 0, 0]], {}, material), instances }), pattern);
  bad({ matrices: new Float32Array(17) }, /multiple of 16/);
  bad({ matrices: new Float32Array(0) }, /a multiple of 16 numbers, at least 16/);
  bad({ matrices: [1, 2, 3] }, /Float32Array/);
  bad({ matrices: Object.assign(new Float32Array(16), { 5: NaN }) }, /NaN or Infinity/);
  bad({ matrices: new Float32Array(32), colors: new Float32Array(3) }, /colors of crowd must be a Float32Array of 6 numbers/);
  bad({ matrices: new Float32Array(32), colors: new Float32Array([0, 0, 0, 0, 0, Infinity]) }, /colors .* NaN or Infinity/);
  bad({ matrices: new Float32Array(32), opacities: new Float32Array(1) }, /opacities of crowd must be a Float32Array of 2 numbers/);
  bad({ matrices: new Float32Array(16), opacities: new Float32Array(1) }, /alphaMode 'blend' or 'add'/);
  bad({ matrices: new Float32Array(16), version: 1.5 }, /version/);
  bad({ matrices: new Float32Array((MAX_PART_INSTANCES + 1) * 16) }, /above the limit of 65536\. Split/);
  assert.throws(() => validatePartInstances({ ...createPart([[0, 0, 0]]), skin: {} }), /skinned or morphed/);
  assert.equal(validatePartInstances(createPart([[0, 0, 0], [1, 0, 0]])), 2);
});

test('parts without an instance list pass through unchanged', () => {
  const plain = [{ name: 'a', geometry: GEOMETRY, matrix: mat4.create(), material: {} }];
  const expansion = expandInstancedParts(plain, null);
  assert.equal(expansion.parts, plain);
  assert.equal(expansion.groups, null);
});

test('one part becomes one stand-in per copy that inherits the part and owns its world matrix', () => {
  const part = createPart([[1, 0, 0], [0, 2, 0]]);
  part.matrix[13] = 10;
  const { parts, groups } = expandInstancedParts([part], null);
  assert.equal(parts.length, 2);
  assert.equal(parts[1].geometry, GEOMETRY);
  assert.equal(parts[1].material, part.material);
  assert.equal(parts[1].name, 'crowd[1]');
  assert.deepEqual([...parts[1].matrix.subarray(12, 15)], [0, 12, 0]);
  assert.equal(groups.get(part).count, 2);
});

test('editing the list in place uploads once when the version is raised, and not at all when nothing changed', () => {
  const part = createPart([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
  const { renderer, batch, uploads } = createRenderer([part]);
  renderer.updateParts([part]);
  assert.deepEqual(uploads, [], 'an unchanged list uploads nothing');
  part.instances.matrices[16 + 12] = 7;
  renderer.updateParts([part]);
  assert.deepEqual(uploads, [], 'an edit without a new version is not seen');
  part.instances.version++;
  renderer.updateParts([part]);
  assert.deepEqual(uploads, [3 * STRIDE]);
  assert.equal(batch.instanceData[STRIDE + 12], 7);
  assert.equal(renderer.shadowsDirty, true);
  renderer.updateInstances(part);
  assert.equal(uploads.length, 2, 'updateInstances uploads without a new version');
});

test('moving the part moves every copy, and a replaced list asks for replaceParts', () => {
  const part = createPart([[0, 0, 0], [1, 0, 0]]);
  const { renderer, batch } = createRenderer([part]);
  part.matrix[14] = -3;
  renderer.updateParts([part]);
  assert.deepEqual([batch.instanceData[12], batch.instanceData[STRIDE + 12], batch.instanceData[STRIDE + 14]], [0, 1, -3]);
  part.instances = { matrices: new Float32Array(48), version: 0 };
  assert.throws(() => renderer.updateParts([part]), /instances object of crowd was replaced/);
});

test('a list with another number of copies asks for replaceParts', () => {
  const part = createPart([[0, 0, 0], [1, 0, 0]]);
  const { renderer } = createRenderer([part]);
  part.instances.matrices = new Float32Array(48);
  assert.throws(() => renderer.updateParts([part]), /changed from 2\. Call replaceParts/);
});

test('a copy can carry its own colour and opacity without a part for it', () => {
  const part = createPart([[0, 0, 0], [1, 0, 0]], { colors: new Float32Array([1, 0, 0, 0, 1, 0]), opacities: new Float32Array([1, 0.25]) }, { alphaMode: 'blend', opacity: 0.8 });
  const { renderer, batch } = createRenderer([part]);
  assert.deepEqual([...batch.instanceData.subarray(25, 28)], [1, 0, 0]);
  assert.deepEqual([...batch.instanceData.subarray(STRIDE + 25, STRIDE + 28)], [0, 1, 0]);
  assert.deepEqual([...batch.instanceData.subarray(STRIDE + 38, STRIDE + 41)], [0, 1, 0], 'emission follows the copy colour');
  assert.ok(Math.abs(batch.instanceData[STRIDE + 41] - 0.2) < 1e-6);
  part.instances.colors[0] = 0.5;
  part.instances.version++;
  renderer.updateParts([part]);
  assert.equal(batch.instanceData[25], 0.5);
});

test('a copy with a zero scale is hidden and shows again when it is restored', () => {
  const part = createPart([[0, 0, 0], [1, 0, 0]]);
  const { renderer, batch } = createRenderer([part]);
  part.instances.matrices.fill(0, 0, 16);
  part.instances.version++;
  renderer.updateParts([part]);
  assert.deepEqual([...batch.instanceData.subarray(0, 25)], new Array(25).fill(0));
  mat4.identity(part.instances.matrices.subarray(0, 16));
  part.instances.version++;
  renderer.updateParts([part]);
  assert.equal(batch.instanceData[0], 1);
});

test('culling still chooses copies one by one from the packed matrices', () => {
  const part = createPart([[0, 0, 0], [500, 0, 0], [0, 0, 50], [2, 1, 0]]);
  const { batch } = createRenderer([part]);
  const projection = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.5, 100);
  const view = mat4.lookAt(mat4.create(), [0, 0, 10], [0, 0, 0], [0, 1, 0]);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  const planes = extractFrustumPlanes(viewProjection, new Float32Array(24));
  const selection = selectInstances(new InstanceSelection(4, 1), {
    instanceData: batch.instanceData, instanceCount: 4, stride: STRIDE, bounds: { center: [0, 0, 0], radius: 1 }, levelErrors: [0], planes, viewProjection, pixelsPerUnit: 270 * projection[5],
  });
  assert.deepEqual([...selection.indices[0].subarray(0, selection.counts[0])], [0, 3]);
});
