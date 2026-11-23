// A recipe with a light bake reuses the light and the unwrap it already traced while what they read is unchanged (issue 3052).
// Every bake here is the 8 box closed room at the lowest settings, so the whole file runs in a few seconds even under coverage.
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudioController } from '../src/studio.js';
import { bakesTraced, bakeReuseStats, clearBakeReuse } from '../src/agent-bake.js';
import { unwrapsComputed } from '../src/light-bake.js';
import { contentFingerprint } from '../src/content-fingerprint.js';
import { closedRoom } from './support/agent-bake-rooms.mjs';

const CHANNEL_IDS = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));

function bakedRoom() {
  return closedRoom({ bake: { preset: 'draft', samples: 2, bounces: 1, texelsPerUnit: 1, probes: false } });
}

function catalogImages(shade) {
  const data = new Uint8ClampedArray(2 * 2 * 4).fill(shade);
  return new Map(CHANNEL_IDS.map(id => [id, { width: 2, height: 2, data: Uint8ClampedArray.from(data) }]));
}

function sceneOf(recipe) {
  return createAgentScene(structuredClone(recipe), {}, { sequenceFrames: catalogImages(180) });
}

function controllerOn(recipe) {
  return createStudioController({ scene: sceneOf(recipe), viewportWidth: 800, viewportHeight: 600 });
}

function hashOf(typedArray) {
  return createHash('sha256').update(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)).digest('hex');
}

// Everything a bake wrote or kept, by part: the geometry buffers (positions, normals, both uv sets, indices) and the bytes of
// every texture the renderer would draw the baked light from.
function bakedBytes(scene) {
  const bytes = {};
  for (const part of scene.parts) {
    for (const [field, value] of Object.entries(part.geometry)) {
      if (ArrayBuffer.isView(value)) {
        bytes[`${part.name}.geometry.${field}`] = hashOf(value);
      }
    }
    for (const field of ['emissiveMap', 'lightMap', 'occlusionMap', 'map']) {
      const image = part.material[field]?.image;
      if (image) {
        bytes[`${part.name}.${field}`] = hashOf(image.data ?? image.bytes);
      }
    }
  }
  return bytes;
}

function freshBytes(recipe) {
  clearBakeReuse();
  return bakedBytes(sceneOf(recipe));
}

function editedRoom(edit) {
  const recipe = bakedRoom();
  edit(recipe);
  return recipe;
}

function nodeOf(recipe, id) {
  return recipe.nodes.find(node => node.id === id);
}

function movedBlock(recipe) {
  const moved = structuredClone(recipe);
  nodeOf(moved, 'block').translation = [0.4, 0.6, -0.2];
  return moved;
}

function recoloured(recipe) {
  const changed = structuredClone(recipe);
  changed.materials.find(material => material.id === 'white').color = [0.8, 0.1, 0.1];
  return changed;
}

test('loading a recipe through the Studio controller with nothing changed runs no bake', () => {
  const controller = controllerOn(bakedRoom());
  const tracedBefore = bakesTraced();
  controller.loadRecipe(structuredClone(controller.exportRecipe()));
  assert.equal(bakesTraced(), tracedBefore);
});

test('a one-node move through the controller bakes once, and unwraps nothing again', () => {
  const controller = controllerOn(bakedRoom());
  const tracedBefore = bakesTraced();
  const unwrapsBefore = unwrapsComputed();
  controller.loadRecipe(movedBlock(controller.exportRecipe()));
  assert.equal(bakesTraced() - tracedBefore, 1);
  assert.equal(unwrapsComputed(), unwrapsBefore);
});

test('a material colour edit traces again but does not unwrap again', () => {
  const controller = controllerOn(bakedRoom());
  const tracedBefore = bakesTraced();
  const unwrapsBefore = unwrapsComputed();
  controller.loadRecipe(recoloured(controller.exportRecipe()));
  assert.equal(bakesTraced() - tracedBefore, 1, 'the colour feeds the bounce, so the light is traced again');
  assert.equal(unwrapsComputed(), unwrapsBefore);
});

test('an unwrap of unchanged geometry is not computed again by a second bake of the same scene shape', () => {
  clearBakeReuse();
  sceneOf(bakedRoom());
  const unwrapsBefore = unwrapsComputed();
  sceneOf(editedRoom(recipe => { recipe.environment.pointLights[0].intensity = 20; }));
  assert.equal(unwrapsComputed(), unwrapsBefore);
});

test('reused light and geometry equal a fresh build byte for byte after a load, a move and a colour edit', () => {
  clearBakeReuse();
  const controller = controllerOn(bakedRoom());
  const cases = [];
  controller.loadRecipe(structuredClone(controller.exportRecipe()));
  cases.push(['unchanged', controller.exportRecipe(), bakedBytes(controller.scene)]);
  controller.loadRecipe(movedBlock(controller.exportRecipe()));
  cases.push(['moved', controller.exportRecipe(), bakedBytes(controller.scene)]);
  controller.loadRecipe(recoloured(controller.exportRecipe()));
  cases.push(['recoloured', controller.exportRecipe(), bakedBytes(controller.scene)]);
  controller.loadRecipe(movedBlock(bakedRoom()));
  cases.push(['back to an earlier recipe', controller.exportRecipe(), bakedBytes(controller.scene)]);
  for (const [name, recipe, reusedBytes] of cases) {
    assert.deepEqual(reusedBytes, freshBytes(recipe), name);
  }
});

// One test per kind of input the bake key reads: each change must trace again and give exactly what a fresh build gives.
const KEY_INPUTS = [
  ['a light', recipe => { recipe.environment.pointLights[0].intensity = 30; }],
  ['the sky', recipe => { recipe.environment.skyTop = [0.9, 0.2, 0.2]; recipe.environment.skyBottom = [0.1, 0.1, 0.6]; }],
  ['a bake setting', recipe => { recipe.bake.samples = 3; }],
  ['one vertex position', recipe => {
    recipe.geometries.push({ id: 'rounded', type: 'mesh', base: { type: 'box' }, edits: [{ op: 'bevel', edges: { all: true }, width: 0.1, segments: 1 }] });
    nodeOf(recipe, 'block').geometry = 'rounded';
  }],
  ['a material texture map', recipe => { recipe.materials.find(material => material.id === 'white').colorMap = CHANNEL_IDS[0]; }],
  ['an emissive value', recipe => { recipe.materials.find(material => material.id === 'lamp').emission = 5; }],
];

for (const [name, edit] of KEY_INPUTS) {
  test(`a changed ${name} traces again and equals a fresh build`, () => {
    clearBakeReuse();
    sceneOf(bakedRoom());
    const changed = editedRoom(edit);
    const tracedBefore = bakesTraced();
    const reusedBytes = bakedBytes(sceneOf(changed));
    assert.equal(bakesTraced() - tracedBefore, 1, `${name} is read by the bake, so the old light must not be reused`);
    assert.deepEqual(reusedBytes, freshBytes(changed));
  });
}

test('a larger block never gets the light of another recipe', () => {
  clearBakeReuse();
  const baseBytes = bakedBytes(sceneOf(bakedRoom()));
  const largerBlock = editedRoom(recipe => { nodeOf(recipe, 'block').scale = [1.6, 1.6, 1.6]; });
  const reusedBytes = bakedBytes(sceneOf(largerBlock));
  assert.notDeepEqual(reusedBytes, baseBytes);
  assert.deepEqual(reusedBytes, freshBytes(largerBlock));
});

test('a scene that edits and scribbles over its bake leaves the next scene of the same recipe untouched', () => {
  clearBakeReuse();
  const recipe = bakedRoom();
  const sceneA = sceneOf(recipe);
  const sceneB = sceneOf(recipe);
  const tracedBefore = bakesTraced();
  sceneA.apply([{ type: 'set-node', id: 'block', translation: [0.4, 0.6, -0.2] }], { expectedRevision: sceneA.revision });
  // What a renderer or an editor might do to the buffers it was given: overwrite them, as a dispose that recycles them would.
  for (const part of sceneA.parts) {
    for (const value of Object.values(part.geometry)) {
      if (ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
        value.fill(0);
      }
    }
    for (const field of ['emissiveMap', 'lightMap', 'occlusionMap']) {
      part.material[field]?.image?.data?.fill?.(0);
    }
  }
  const expected = freshBytes(recipe);
  assert.deepEqual(bakedBytes(sceneB), expected, 'the second scene, built from a hit, kept its own buffers');
  clearBakeReuse();
  const sceneC = sceneOf(recipe);
  const sceneD = sceneOf(recipe);
  for (const part of sceneC.parts) {
    for (const value of Object.values(part.geometry)) {
      if (ArrayBuffer.isView(value)) {
        value.fill(0);
      }
    }
  }
  assert.deepEqual(bakedBytes(sceneD), expected, 'a third build after the first scene was scribbled over still equals a fresh build');
  assert.ok(bakesTraced() >= tracedBefore);
});

test('a value the fingerprint cannot read gets no key, so nothing is reused for it', () => {
  assert.equal(contentFingerprint({ light: () => 1 }), null);
  assert.equal(contentFingerprint({ light: new Set([1]) }), null);
  assert.equal(contentFingerprint({ light: new ArrayBuffer(8) }), null);
  assert.equal(contentFingerprint({ light: new (class Lamp { constructor() { this.hidden = 1; } })() }), null);
  assert.equal(contentFingerprint({ light: new Float32Array([1, 2]), name: 'lamp' }) === null, false);
  assert.equal(contentFingerprint({ a: 1 }), contentFingerprint({ a: 1 }));
  assert.notEqual(contentFingerprint({ a: 1 }), contentFingerprint({ a: 2 }));
});

test('the reuse caches stay inside their bounds', () => {
  clearBakeReuse();
  for (let step = 0; step < 6; step++) {
    sceneOf(editedRoom(recipe => { recipe.environment.pointLights[0].intensity = 10 + step; }));
  }
  const { entries, bytes, maximumEntries, maximumBytes } = bakeReuseStats();
  assert.ok(entries <= maximumEntries);
  assert.ok(bytes <= maximumBytes);
});
