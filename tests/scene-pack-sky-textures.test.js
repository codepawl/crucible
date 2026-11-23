import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { agentEnvironmentMap } from '../src/agent-look.js';
import { registerCatalogEnvironment } from '../src/look-catalog.js';
import { decodePack, encodePack } from '../src/scene-pack-format.js';
import { checkImageBudget, countImageTexels, PACK_MAX_IMAGE_TEXELS } from '../src/scene-pack-limits.js';
import { PACK_MAX_SKY_WIDTH, packedSkyOf } from '../src/scene-pack-sky.js';
import { createPackEnvironmentMap } from '../src/scene-pack-environment.js';
import { partsWithImageData } from '../src/scene-pack-images.js';
import { compileRecipeToPack, validatePackRecipe } from '../src/scene-pack.js';

const RGBE_RELATIVE_TOLERANCE = 1 / 128;
const COLOUR_MAP_ID = 'c'.repeat(64);
const SECOND_MAP_ID = 'd'.repeat(64);
const BIG_SKY_ID = 'e'.repeat(64);

// These bytes were measured on origin/main before the sky and image work: a recipe with neither must still pack to them.
const PLAIN_PACK = Object.freeze({
  bytes: 148120,
  sha256: 'ada4797627d9812c6589d2e8fc4869baf2dfad3d6e6feb7a7172ea70d7eaffa1',
});

function plainRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }, { id: 'red', color: [0.8, 0.1, 0.1], roughness: 0.2 }],
    nodes: [
      { id: 'cube', geometry: 'cube', material: 'blue' },
      { id: 'ball', geometry: 'ball', material: 'red', translation: [1.5, 0.5, 0] },
    ],
  };
}

function colourImage(size, seed) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < data.length; index++) data[index] = (index * 7 + seed) % 256;
  return { width: size, height: size, data };
}

function texturedRecipe(colorMapIds) {
  const recipe = plainRecipe();
  recipe.materials = colorMapIds.map((colorMap, index) => ({ id: `tex${index}`, colorMap }));
  recipe.nodes = colorMapIds.map((_, index) => ({ id: `ball${index}`, geometry: 'ball', material: `tex${index}`, translation: [index * 2, 0, 0] }));
  return recipe;
}

function bundledSkyRecipe(extra = {}) {
  return { ...plainRecipe(), environment: { hdri: 'sky-clouds', environmentIntensity: 1.5, environmentRotation: 0.7, world: true, ...extra } };
}

function worstRelativeError(expected, actual) {
  let worst = 0;
  for (let pixel = 0; pixel < expected.length; pixel += 3) {
    const brightest = Math.max(expected[pixel], expected[pixel + 1], expected[pixel + 2]);
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(expected[pixel + channel] - actual[pixel + channel]);
      worst = Math.max(worst, brightest === 0 ? error : error / brightest);
    }
  }
  return worst;
}

test('a recipe with no sky image and no texture packs to the same bytes as before', async () => {
  const bytes = await compileRecipeToPack(plainRecipe());
  assert.equal(bytes.length, PLAIN_PACK.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PLAIN_PACK.sha256);
  assert.equal(decodePack(bytes).environmentMap, undefined);
});

test('a colour image round-trips byte for byte with its descriptor and the part uvs, and a shared image is stored once', async () => {
  const image = colourImage(64, 3);
  const pool = new Map([[COLOUR_MAP_ID, image]]);
  const single = await compileRecipeToPack(texturedRecipe([COLOUR_MAP_ID]), { catalogImages: pool });
  const packed = decodePack(single);
  const map = packed.parts[0].material.map;
  assert.deepEqual([map.image.width, map.image.height, map.colorSpace], [64, 64, 'srgb']);
  assert.ok(map.image.data instanceof Uint8ClampedArray);
  assert.deepEqual(Buffer.from(map.image.data), Buffer.from(image.data));
  assert.ok(packed.parts[0].geometry.uvs instanceof Float32Array && packed.parts[0].geometry.uvs.length > 0, 'the uvs travel with the part');

  const shared = await compileRecipeToPack(texturedRecipe([COLOUR_MAP_ID, COLOUR_MAP_ID]), { catalogImages: pool });
  const sharedParts = decodePack(shared).parts;
  assert.deepEqual(Buffer.from(sharedParts[1].material.map.image.data), Buffer.from(image.data));
  const distinctPool = new Map([[COLOUR_MAP_ID, image], [SECOND_MAP_ID, colourImage(64, 4)]]);
  const distinct = await compileRecipeToPack(texturedRecipe([COLOUR_MAP_ID, SECOND_MAP_ID]), { catalogImages: distinctPool });
  assert.equal(distinct.length - shared.length, image.data.length, 'two different images cost one image more than one image used twice');

  const runtimeParts = partsWithImageData(packed.parts);
  assert.equal(runtimeParts[0].material.map.image.width, 64);
});

test('an ImageData texture packs as plain pixels and comes back as the same bytes', () => {
  class ImageData {
    get [Symbol.toStringTag]() {
      return 'ImageData';
    }

    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  const data = colourImage(4, 9).data;
  const decoded = decodePack(encodePack({ texture: { image: new ImageData(data, 4, 4), colorSpace: 'srgb', wrapS: 'repeat' } }));
  assert.deepEqual(decoded.texture.image.width, 4);
  assert.deepEqual(Buffer.from(decoded.texture.image.data), Buffer.from(data));
  assert.equal(decoded.texture.wrapS, 'repeat');
});

test('textures over the texel budget are refused with the part, the texels and what to change', async () => {
  const pool = new Map([[COLOUR_MAP_ID, colourImage(64, 1)]]);
  const recipe = texturedRecipe([COLOUR_MAP_ID]);
  await assert.rejects(compileRecipeToPack(recipe, { catalogImages: pool, maxImageTexels: 4095 }), error => {
    assert.match(error.message, /textures on the parts hold 4096 texels/);
    assert.match(error.message, /over the 4095/);
    assert.match(error.message, /Part "ball0" holds the most \(4096 texels\)/);
    assert.match(error.message, /smaller colorMap/);
    return true;
  });
  await assert.doesNotReject(compileRecipeToPack(recipe, { catalogImages: pool, maxImageTexels: 4096 }));
  assert.equal(PACK_MAX_IMAGE_TEXELS, 1024 * 1024);
});

test('the budget counts a shared image once and different images together', async () => {
  const pool = new Map([[COLOUR_MAP_ID, colourImage(32, 1)], [SECOND_MAP_ID, colourImage(32, 2)]]);
  await loadAllAgentSceneModules();
  const sameTwice = createAgentScene(texturedRecipe([COLOUR_MAP_ID, COLOUR_MAP_ID]), {}, { sequenceFrames: pool });
  assert.equal(countImageTexels(sameTwice.parts).texels, 1024);
  const different = createAgentScene(texturedRecipe([COLOUR_MAP_ID, SECOND_MAP_ID]), {}, { sequenceFrames: pool });
  assert.equal(countImageTexels(different.parts).texels, 2048);
  assert.throws(() => checkImageBudget(different.parts, 2047), /hold 2048 texels/);
});

test('the command line refuses a catalog image it cannot read, naming the material', async () => {
  await assert.rejects(compileRecipeToPack(texturedRecipe([COLOUR_MAP_ID])), /materials\["tex0"\]\.colorMap: crucible pack cannot read the asset catalog/);
});

test('a bundled sky packs, round-trips within RGBE precision and lights like the agent scene', async () => {
  const recipe = bundledSkyRecipe();
  const packed = decodePack(await compileRecipeToPack(recipe));
  assert.ok(packed.environmentMap.data instanceof Float32Array);
  assert.equal(packed.environment.hdri, 'sky-clouds');

  const runtimeMap = await createPackEnvironmentMap(packed);
  await loadAllAgentSceneModules();
  const agentScene = createAgentScene(bundledSkyRecipe());
  const agentMap = agentEnvironmentMap(agentScene.environment);
  assert.deepEqual([runtimeMap.width, runtimeMap.height], [agentMap.width, agentMap.height]);
  assert.deepEqual([runtimeMap.intensity, runtimeMap.rotation, runtimeMap.showBackground, runtimeMap.backgroundBlur], [agentMap.intensity, agentMap.rotation, agentMap.showBackground, agentMap.backgroundBlur]);
  assert.equal(runtimeMap.sunDisc, agentMap.sunDisc);
  assert.ok(worstRelativeError(agentMap.data, runtimeMap.data) <= RGBE_RELATIVE_TOLERANCE);
});

test('a scene without a sky image lights from its named setup', async () => {
  const packed = decodePack(await compileRecipeToPack(plainRecipe()));
  const map = await createPackEnvironmentMap(packed);
  assert.equal(map.kind, 'environment-map');
  assert.equal(packed.environmentMap, undefined);
});

test('a sky wider than the pack limit is halved with its light kept, and a catalog sky is refused on the command line', async () => {
  const width = 2048;
  const height = 1024;
  const data = new Float32Array(width * height * 3);
  for (let index = 0; index < data.length; index++) data[index] = 0.25 + (index % 9) * 0.1;
  registerCatalogEnvironment(BIG_SKY_ID, { width, height, data });
  const environment = { hdri: BIG_SKY_ID, environmentIntensity: 1, environmentRotation: 0, world: false };
  const full = agentEnvironmentMap(environment);
  const map = packedSkyOf(environment);
  assert.deepEqual([map.width, map.height], [PACK_MAX_SKY_WIDTH, PACK_MAX_SKY_WIDTH / 2]);
  const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
  assert.ok(Math.abs(mean(map.data) - mean(full.data)) < 1e-4, 'the average radiance does not change');
  assert.equal(packedSkyOf({ setup: 'studio' }), undefined);
  assert.throws(() => validatePackRecipe({ ...plainRecipe(), environment: { sky: {} } }), /environment\.sky/);
  await assert.rejects(compileRecipeToPack({ ...plainRecipe(), environment: { hdri: 'f'.repeat(64) } }), /reads only the bundled skies \(sky-clouds, studio-softbox\)/);
});

test('the pack file sizes of a plain scene, a 512 colour map and a sky at the limit are stable', async () => {
  const sizes = {};
  sizes.plain = (await compileRecipeToPack(plainRecipe())).length;
  const pool = new Map([[COLOUR_MAP_ID, colourImage(512, 5)]]);
  sizes.colourMap = (await compileRecipeToPack(texturedRecipe([COLOUR_MAP_ID]), { catalogImages: pool })).length;
  const width = PACK_MAX_SKY_WIDTH;
  const height = width / 2;
  const data = new Float32Array(width * height * 3).fill(0.5);
  const limitSkyId = 'a'.repeat(64);
  registerCatalogEnvironment(limitSkyId, { width, height, data });
  const skyScene = createAgentScene({ ...plainRecipe(), environment: { hdri: limitSkyId } });
  sizes.sky = encodePack({ environment: skyScene.environment, environmentMap: packedSkyOf(skyScene.environment) }).length;
  assert.equal(sizes.plain, PLAIN_PACK.bytes);
  assert.ok(sizes.colourMap >= 512 * 512 * 4);
  assert.ok(sizes.sky >= width * height * 4 && sizes.sky < width * height * 4 + 4096);
  console.log(`pack sizes: ${JSON.stringify(sizes)}`);
});
