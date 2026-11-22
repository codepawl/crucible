import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { clutterOptionsFor, normalizeClutter, CLUTTER_LIMITS } from '../src/agent-clutter.js';
import { createClutter } from '../src/clutter.js';

await loadAllAgentSceneModules();

const GROUND = { id: 'ground', type: 'terrain', size: 40, resolution: 32, seed: 3, amplitude: 2 };
const LAYER = { preset: 'forest', terrain: 'hills', seed: 4, cullDistance: 20 };

function floorRecipe(clutter, extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [GROUND, { id: 'marker', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.4, 0.1] }],
    nodes: [
      { id: 'hills', geometry: 'ground', material: 'grass' },
      ...(clutter ? [{ id: 'floor', clutter }] : []),
      ...(extra.nodes ?? []),
    ],
    camera: extra.camera ?? { eye: [0, 3, 10], target: [0, 0, 0] },
  };
}

function clutterParts(scene) {
  return scene.parts.filter(part => part.name.startsWith('floor/'));
}

function fingerprint(scene) {
  const hash = createHash('sha256');
  for (const part of clutterParts(scene)) {
    hash.update(part.name);
    hash.update(Buffer.from(part.matrix.buffer, part.matrix.byteOffset, part.matrix.byteLength));
    hash.update(Buffer.from(part.geometry.positions.buffer, part.geometry.positions.byteOffset, part.geometry.positions.byteLength));
  }
  return hash.digest('hex');
}

function layerError(layer, pattern, recipeOverrides) {
  assert.throws(() => createAgentScene(floorRecipe([layer], recipeOverrides)), pattern);
}

test('a forest layer scatters stones, twigs and leaves over the terrain and scene_inspect reports it', () => {
  const scene = createAgentScene(floorRecipe([LAYER]));
  const parts = clutterParts(scene);
  assert.ok(parts.length > 10, `built ${parts.length} parts`);
  for (const kind of ['rocks', 'pebbles', 'litter']) assert.ok(parts.some(part => part.name.includes(`/${kind}-`)), `${kind} tiles exist`);
  const [report] = scene.inspect().clutter;
  assert.equal(report.node, 'floor');
  assert.equal(report.preset, 'forest');
  assert.ok(report.triangles > 1000);
  assert.ok(report.items > 1000, `drew ${report.items} items`);
  assert.equal(report.levels.reduce((total, count) => total + count, 0), report.tiles);
  assert.ok(parts.some(part => part.material.moss > 0), 'rocks carry the moss layer');
  assert.ok(parts.filter(part => part.name.includes('/litter-')).every(part => part.castShadow !== true));
});

test('the same recipe gives the same stones byte for byte, and another seed gives other ones', () => {
  const first = fingerprint(createAgentScene(floorRecipe([LAYER])));
  assert.equal(fingerprint(createAgentScene(floorRecipe([LAYER]))), first);
  assert.notEqual(fingerprint(createAgentScene(floorRecipe([{ ...LAYER, seed: 5 }]))), first);
});

test('the recipe path builds the same geometry as createClutter with the same options', () => {
  const scene = createAgentScene(floorRecipe([LAYER]));
  const [normalized] = normalizeClutter([LAYER]);
  const recipe = floorRecipe([LAYER]);
  const groupNode = { id: 'floor', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null };
  recipe.nodes.forEach(node => Object.assign(node, { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null }));
  const addon = createClutter({ ...clutterOptionsFor(recipe, groupNode, normalized), eye: [0, 3, 10] });
  assert.equal(scene.inspect().clutter[0].triangles, addon.stats().triangles);
});

test('density scales the item count and the camera decides which tiles are built', () => {
  const sparse = createAgentScene(floorRecipe([{ ...LAYER, density: 0.2 }])).inspect().clutter[0].triangles;
  const normal = createAgentScene(floorRecipe([LAYER])).inspect().clutter[0].triangles;
  assert.ok(sparse < normal / 2, `${sparse} against ${normal}`);
  const near = createAgentScene(floorRecipe([LAYER], { camera: { eye: [0, 2, 0], target: [0, 0, -5] } })).inspect().clutter[0];
  const far = createAgentScene(floorRecipe([LAYER], { camera: { eye: [0, 2, 400], target: [0, 0, 0] } })).inspect().clutter[0];
  assert.equal(far.tiles, 0);
  assert.ok(near.tiles > 0);
});

test('exclusions, masks and the slope limit decide where stones may stand', () => {
  const recipe = floorRecipe([LAYER]);
  const groupNode = { id: 'floor', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null };
  recipe.nodes.forEach(node => Object.assign(node, { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null }));
  const optionsFor = layer => clutterOptionsFor(recipe, groupNode, normalizeClutter([{ ...LAYER, ...layer }])[0]);

  const cleared = optionsFor({ exclude: [{ center: [0, 0], radius: 5 }, { min: [8, 8], max: [12, 12] }] }).mask;
  assert.equal(cleared(1, 1), 0);
  assert.equal(cleared(10, 10), 0);
  assert.ok(cleared(-15, 15) > 0);

  const banked = optionsFor({ mask: [{ center: [0, 0], radius: 4, feather: 4 }] }).mask;
  assert.equal(banked(1, 1), 1);
  assert.ok(banked(6, 0) > 0 && banked(6, 0) < 1, 'the feather fades the coverage');
  assert.equal(banked(15, 15), 0);

  const flatOnly = optionsFor({ slopeLimit: 0 }).mask;
  assert.equal(flatOnly(-10, 10), 0, 'a limit of 0 degrees refuses any slope');
});

test('a node named in exclude is measured in the group frame, and excluding the whole ground leaves nothing', () => {
  const scene = createAgentScene(floorRecipe([{ ...LAYER, exclude: [{ node: 'pond', radius: 100 }] }], {
    nodes: [{ id: 'pond', geometry: 'marker', material: 'grass' }],
  }));
  assert.equal(clutterParts(scene).length, 0);
});

test('a flat area works without terrain and a scene without clutter is unchanged', () => {
  const flat = createAgentScene(floorRecipe([{ preset: 'scree', area: { min: [-5, -5], max: [5, 5] }, cullDistance: 20 }]));
  assert.ok(clutterParts(flat).length > 0);
  const plain = createAgentScene(floorRecipe(null));
  assert.equal(plain.inspect().clutter, undefined);
  assert.deepEqual(plain.parts.map(part => part.name), ['hills']);
});

test('the clutter parts stay out of exports', () => {
  const scene = createAgentScene(floorRecipe([LAYER]));
  const exported = scene.exportRecipe();
  assert.equal(exported.nodes.length, 2);
  assert.equal(exported.geometries.length, 2);
  assert.deepEqual(exported.nodes.find(node => node.id === 'floor').clutter[0].preset, 'forest');
});

test('invalid clutter fields fail with what to pass instead', () => {
  layerError({ terrain: 'hills', typo: 1 }, /clutter\[0\]\.typo: .*no such field; use one of preset, terrain/);
  layerError({ preset: 'meadow' }, /clutter\[0\]\.terrain: .*terrain node, such as "ground", or an area/);
  layerError({ preset: 'jungle', terrain: 'hills' }, /clutter\[0\]\.preset: got "jungle"; expected one of meadow, forest, riverbed, scree/);
  layerError({ terrain: 'hills', density: 9 }, /clutter\[0\]\.density: got 9; expected a number from 0\.01 to 4/);
  layerError({ terrain: 'hills', slopeLimit: 120 }, /clutter\[0\]\.slopeLimit: .*0 to 90/);
  layerError({ terrain: 'hills', cullDistance: 500 }, /clutter\[0\]\.cullDistance: .*5 to 100/);
  layerError({ terrain: 'marker' }, /clutter\[0\]\.terrain: got "marker"; expected the ID of a node that draws a terrain geometry/);
  layerError({ terrain: 'hills', exclude: [{ node: 'missing', radius: 2 }] }, /clutter\[0\]\.exclude\[0\]\.node: got "missing"; expected the ID of a node in the recipe/);
  layerError({ terrain: 'hills', exclude: [{ center: [0, 0] }] }, /exclude\[0\]\.radius/);
  layerError({ terrain: 'hills', mask: [{ min: [0, 0], max: [-1, -1] }] }, /clutter\[0\]\.mask\[0\]\.max: .*above min/);
  layerError({ terrain: 'hills', area: { min: [100, 100], max: [120, 120] } }, /clutter\[0\]\.area: .*overlaps the ground/);
});

test('limits keep layers, area, planned items and generated nodes bounded', () => {
  const tooMany = Array.from({ length: CLUTTER_LIMITS.maxLayers + 1 }, () => LAYER);
  assert.throws(() => createAgentScene(floorRecipe(tooMany)), /clutter: got "5 layers"; expected a list of 1 to 4 layers/);
  const twoNodes = floorRecipe([LAYER, LAYER, LAYER], { nodes: [{ id: 'more', clutter: [LAYER, LAYER] }] });
  assert.throws(() => createAgentScene(twoNodes), /clutter: got "5 layers across 2 nodes"; expected at most 4 layers in the whole recipe/);
  assert.throws(() => createAgentScene(floorRecipe([])), /clutter: got "0 layers"/);
  assert.throws(() => createAgentScene(floorRecipe({ preset: 'forest' })), /clutter: got .*expected a list of 1 to 4 layers/);
  layerError({ area: { min: [-150, -150], max: [150, 150] } }, /clutter\[0\]\.area: got "90000 square metres"; expected an area of at most 40000/);
  layerError({ preset: 'scree', area: { min: [-100, -100], max: [100, 100] }, density: 4, cullDistance: 100 }, /clutter\[0\]\.density: got 4; expected a density that keeps the items within cullDistance under 120000/);
  const maskCount = Array.from({ length: CLUTTER_LIMITS.maxMaskShapes + 1 }, () => ({ center: [0, 0], radius: 1 }));
  layerError({ terrain: 'hills', mask: maskCount }, /clutter\[0\]\.mask: got "9 entries"; expected a list of at most 8 entries/);
  const crowded = { ...floorRecipe([{ preset: 'riverbed', terrain: 'hills', cullDistance: 40 }]), };
  assert.throws(() => createAgentScene(crowded, { maxNodes: 40 }), /maxNodes 40/);
});

test('a node cannot hold clutter together with geometry or vegetation', () => {
  const recipe = floorRecipe([LAYER]);
  recipe.nodes[1] = { id: 'floor', geometry: 'marker', material: 'grass', clutter: [LAYER] };
  assert.throws(() => createAgentScene(recipe), /geometry: got "marker"; expected nothing, because a node that scatters clutter is a group/);
});
