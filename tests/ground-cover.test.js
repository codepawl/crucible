import assert from 'node:assert/strict';
import test from 'node:test';
import { bladeAnglesToUp, meanOf } from './support/grass-stance.mjs';
import { GROUND_COVER_LIMITS, groundCoverParts, normalizeGroundCover } from '../src/ground-cover.js';
import { CrucibleRenderer, groupParts } from '../src/renderer.js';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// A horizontal square of half-width `half` at height `y`, facing up.
function squarePart(name, half, y, materialName = name) {
  const positions = new Float32Array([-half, y, -half, -half, y, half, half, y, half, half, y, -half]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { name, geometry: { positions, indices }, matrix: IDENTITY, material: { name: materialName, tag: 'surface', color: [0.2, 0.3, 0.1] } };
}

// A slab lying on the lawn: its top face at y = 0.1 and its underside at the lawn's height.
const slabParts = () => [squarePart('Slab', 1, 0.1), squarePart('SlabUnderside', 1, 0)];
const lawnScene = () => [squarePart('Lawn', 5, 0), ...slabParts()];
const ENTRY = { surfaces: 'Lawn', length: 0.12, density: 400 };

function worldVertices(part) {
  const { positions } = part.geometry;
  const vertices = [];
  for (let index = 0; index < positions.length; index += 3) {
    vertices.push([positions[index] + part.matrix[12], positions[index + 1] + part.matrix[13], positions[index + 2] + part.matrix[14]]);
  }
  return vertices;
}

test('a scene file with no groundCover grows nothing, and bad entries say what to pass', () => {
  assert.deepEqual(normalizeGroundCover(undefined), []);
  assert.throws(() => normalizeGroundCover({}), /a list of at most 8 entries/);
  assert.throws(() => normalizeGroundCover([{}]), /surfaces.*a node or material name/);
  assert.throws(() => normalizeGroundCover([{ surfaces: 'Lawn', preset: 'moss' }]), /preset.*one of meadow, lawn/);
  assert.throws(() => normalizeGroundCover([{ surfaces: 'Lawn', length: 9 }]), /length.*from 0.01 to 2/);
  assert.throws(() => normalizeGroundCover([{ surfaces: 'Lawn', colour: [1, 0, 0] }]), /colour.*not a field/);
  assert.equal(normalizeGroundCover([{ surfaces: 'Lawn' }])[0].preset, 'lawn');
});

test('an unknown surface name fails and lists the names the GLB has', () => {
  const entries = normalizeGroundCover([{ surfaces: 'Meadow' }]);
  assert.throws(() => groundCoverParts(lawnScene(), entries, [0, 3, 8]), /Meadow.*it has Lawn, Slab/);
});

test('a named ground mesh grows blades on it, matched by node or material name', () => {
  const byNode = groundCoverParts(lawnScene(), normalizeGroundCover([ENTRY]), [0, 3, 8]);
  const byMaterial = groundCoverParts([squarePart('Mesh.001', 5, 0, 'LawnMaterial')], normalizeGroundCover([{ ...ENTRY, surfaces: 'LawnMaterial' }]), [0, 3, 8]);
  assert.ok(byNode.reduce((total, part) => total + part.bladeCount, 0) > 1000);
  assert.ok(byMaterial.length > 0);
  assert.ok(byNode.every(part => part.material.tag === 'grass'));
});

test('no blade stands on or through a slab laid on the lawn', () => {
  const parts = groundCoverParts(lawnScene(), normalizeGroundCover([ENTRY]), [0, 3, 8]);
  const inside = parts.flatMap(worldVertices).filter(([x, , z]) => Math.abs(x) < 0.85 && Math.abs(z) < 0.85);
  assert.equal(inside.length, 0, 'grass under or through the slab');
  const beside = parts.flatMap(worldVertices).filter(([x, , z]) => Math.abs(x) > 1.3 && Math.abs(x) < 2 && Math.abs(z) < 1);
  assert.ok(beside.length > 100, 'the lawn beside the slab still has grass');
});

test('two builds of the same scene are identical', () => {
  const build = () => groundCoverParts(lawnScene(), normalizeGroundCover([ENTRY]), [0, 3, 8]);
  const [first, second] = [build(), build()];
  assert.equal(first.length, second.length);
  first.forEach((part, index) => assert.deepEqual(part.geometry.positions, second[index].geometry.positions));
});

test('a field past the blade budget is refused before any frame', () => {
  assert.throws(() => groundCoverParts([squarePart('Lawn', 400, 0)], normalizeGroundCover([{ surfaces: 'Lawn', density: 5000 }]), [0, 3, 8]), new RegExp(`at most ${GROUND_COVER_LIMITS.maxBlades}`));
});

test('the blade budget counts every entry together, before any is grown', () => {
  // Each lawn needs at least 80 * 80 * 500 * 0.12 = 384,000 blades, under the 2,000,000 limit; eight need 3,072,000.
  const lawns = Array.from({ length: 8 }, (_, index) => squarePart(`Lawn${index}`, 40, 0));
  const entries = lawns.map((_, index) => ({ surfaces: `Lawn${index}`, density: 500 }));
  const started = performance.now();
  assert.throws(() => groundCoverParts(lawns, normalizeGroundCover(entries), [0, 3, 8]), /3072000 blades in all entries.*at most 2000000/);
  assert.ok(performance.now() - started < 1000, 'refused before growing any entry');
});

// A Blender export: the plane is built Z-up and the node matrix turns it into the Y-up lawn.
function zUpLawnPart(half) {
  const positions = new Float32Array([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]);
  const turnedIntoYUp = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  return { name: 'Lawn', geometry: { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }, matrix: turnedIntoYUp, material: { tag: 'surface', color: [0.07, 0.17, 0.03] } };
}

test('blades stand up on a rotated GLB surface (Z-up GLB, no wind)', () => {
  const [entry] = normalizeGroundCover([{ surfaces: 'Lawn', length: 0.12, density: 300 }]);
  const parts = groundCoverParts([zUpLawnPart(8)], [entry], [3.2, 0.9, 6]);
  assert.ok(meanOf(bladeAnglesToUp(parts)) < 20, 'blades grown on a rotated surface lean less than 20 degrees from world up');
});

test('ground-cover blades feel a length-scaled wind while a tree in the same scene keeps the scene wind', () => {
  const [entry] = normalizeGroundCover([{ surfaces: 'Lawn', length: 0.12, density: 300 }]);
  const grass = groundCoverParts([zUpLawnPart(8)], [entry], [3.2, 0.9, 6]);
  const tree = { name: 'Tree', geometry: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag: 'foliage', color: [0.1, 0.3, 0.1], roughness: 0.8, metallic: 0, emission: 0 } };
  const sceneWind = 0.3;
  const batches = groupParts([tree, ...grass]);
  const treeBatch = batches.find(batch => batch.some(part => part.material.tag === 'foliage'));
  const grassBatch = batches.find(batch => batch.some(part => part.material.tag === 'grass'));
  // The renderer's per-batch bind writes the wind uniform: the tree batch keeps the frame wind, the ground cover gets a share of it.
  const written = [];
  let lawnWind;
  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, { frameWind: sceneWind, windScaledBatch: false, uniforms: { wind: 'wind' }, context: { uniform1f: (name, value) => written.push(value) } });
  renderer.bindBatchWind({ parts: [grassBatch[0]] });
  renderer.bindBatchWind({ parts: [treeBatch[0]] });
  assert.ok(Math.abs(written[0] - 0.06) < 1e-9, `a 0.12 m lawn feels 0.3 * 0.12 / 0.6, got ${written[0]}`);
  lawnWind = written[0];
  assert.equal(written[1], sceneWind, 'the tree batch after it gets the scene wind back');
  const plain = Object.create(renderer);
  plain.windScaledBatch = false;
  written.length = 0;
  plain.bindBatchWind({ parts: [treeBatch[0]] });
  assert.equal(written.length, 0, 'a scene without scaled batches never writes the wind uniform');
  const windy = bladeAnglesToUp(grass, { strength: lawnWind });
  assert.ok(meanOf(windy) < 25, `with the default wind the mean blade angle to world up is ${meanOf(windy)} degrees`);
  assert.ok(meanOf(bladeAnglesToUp(grass, { strength: sceneWind })) > 40, 'the unscaled scene wind would bend 0.12 m blades far over');
});

test('parts that share a mesh but differ in wind share draw as separate batches', () => {
  const geometry = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const grassPart = windScale => ({ name: 'Grass', geometry, matrix: IDENTITY, material: { tag: 'grass', color: [1, 1, 1], roughness: 0.8, metallic: 0, emission: 0, ...(windScale === undefined ? {} : { windScale }) } });
  assert.equal(normalizeGroundCover([{ surfaces: 'Lawn', length: 0.12, wind: 0 }])[0].windScale, 0);
  assert.equal(groupParts([grassPart(0.2), grassPart(1), grassPart(undefined)]).length, 3);
});
