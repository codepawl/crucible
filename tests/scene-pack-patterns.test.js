import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { decodePack } from '../src/scene-pack-format.js';
import { partsWithImageData } from '../src/scene-pack-images.js';
import { compileRecipeToPack, validatePackRecipe } from '../src/scene-pack.js';
import { countImageTexels } from '../src/scene-pack-limits.js';

const TEXTURE_SLOTS = ['map', 'normalMap', 'metallicRoughnessMap'];

function patternRoomRecipe() {
  return JSON.parse(readFileSync(new URL('./fixtures/pack-pattern-room.recipe.json', import.meta.url), 'utf8'));
}

test('a recipe with procedural patterns passes the pack validation', () => {
  assert.doesNotThrow(() => validatePackRecipe(patternRoomRecipe()));
});

test('a packed pattern room carries the baked textures of the recipe build byte for byte and no pattern field', async () => {
  await loadAllAgentSceneModules();
  const live = createAgentScene(patternRoomRecipe());
  const packed = decodePack(await compileRecipeToPack(patternRoomRecipe()));
  assert.equal(packed.parts.length, live.parts.length);
  live.parts.forEach((part, index) => {
    const stored = packed.parts[index].material;
    assert.equal(stored.pattern, undefined, `${part.name} drops the pattern, the page never evaluates it`);
    for (const slot of TEXTURE_SLOTS) {
      const expected = part.material[slot];
      assert.ok(stored[slot], `${part.name} keeps ${slot}`);
      assert.equal(stored[slot].image.width, expected.image.width);
      assert.equal(stored[slot].colorSpace, expected.colorSpace);
      assert.deepEqual(Buffer.from(stored[slot].image.data), Buffer.from(expected.image.data), `${part.name} ${slot} texels`);
    }
    assert.equal(stored.boxMapScale, part.material.boxMapScale, `${part.name} keeps its box mapping scale`);
    assert.equal(stored.boxMapAxis, part.material.boxMapAxis, `${part.name} keeps its box mapping axis`);
  });
  assert.equal(partsWithImageData(packed.parts).length, packed.parts.length);
});

test('patterns over the image budget are baked at 256 and then fit, instead of refusing the recipe', async () => {
  const recipe = patternRoomRecipe();
  for (const material of recipe.materials) material.pattern.resolution = 512;
  const full = createAgentScene(recipe);
  const budget = Math.floor(countImageTexels(full.parts).texels / 2);
  const packed = decodePack(await compileRecipeToPack(recipe, { maxImageTexels: budget }));
  assert.equal(packed.parts[0].material.map.image.width, 256);
  assert.ok(countImageTexels(partsWithImageData(packed.parts)).texels <= budget);
});

test('patterns that do not fit even at 256 are refused with the part and what to change', async () => {
  const recipe = patternRoomRecipe();
  await assert.rejects(
    compileRecipeToPack(recipe, { maxImageTexels: 1000 }),
    error => error instanceof TypeError && /Part "/.test(error.message) && /over the 1000/.test(error.message),
  );
});

test('packing a pattern room twice gives the same bytes', async () => {
  const first = await compileRecipeToPack(patternRoomRecipe());
  const second = await compileRecipeToPack(patternRoomRecipe());
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

const IMAGE_ASSET = 'a'.repeat(64);

function imageGraphRecipe() {
  const recipe = patternRoomRecipe();
  recipe.materials[0].pattern = { type: 'graph', resolution: 256, graph: { color: { image: { asset: IMAGE_ASSET } } } };
  return recipe;
}

test('a graph pattern with a catalog image node is refused without a catalog and names the material', async () => {
  await assert.rejects(
    compileRecipeToPack(imageGraphRecipe()),
    error => error instanceof TypeError && error.message.startsWith('recipe.materials["floor"].pattern.graph:') && /Studio/.test(error.message),
  );
});

test('a graph pattern with a catalog image node packs its baked colour when the host has the catalog', async () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([200, 30, 30, 255], index);
  const catalogImages = new Map([[IMAGE_ASSET, { width: 4, height: 4, data: pixels }]]);
  const packed = decodePack(await compileRecipeToPack(imageGraphRecipe(), { catalogImages }));
  const colour = packed.parts[0].material.map;
  assert.equal(colour.image.width, 256);
  assert.ok(colour.image.data[0] > colour.image.data[1] * 2, 'the packed floor is red like the catalog image');
  assert.equal(packed.parts[0].material.pattern, undefined);
});
