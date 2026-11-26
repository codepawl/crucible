import test from 'node:test';
import assert from 'node:assert/strict';
import * as worldMaterials from '../src/world-material-shader.js';
import { applyFileSceneMaterialOverrides, logGltfWarnings, needsWorldMaterialsForOverrides } from '../src/file-scene-overrides.js';

test('needsWorldMaterialsForOverrides checks entries and validates type', () => {
  assert.equal(needsWorldMaterialsForOverrides(undefined), false);
  assert.equal(needsWorldMaterialsForOverrides({ Glass: { opacity: 0.5 } }), false);
  assert.equal(needsWorldMaterialsForOverrides({ Pool: { tag: 'water', waterPreset: 'lake' } }), true);
  assert.throws(() => needsWorldMaterialsForOverrides(['water']), TypeError);
});

test('applyFileSceneMaterialOverrides leaves parts untouched when overrides are absent or empty', () => {
  const parts = Object.freeze([{ material: { name: 'Brick', color: [1, 1, 1] } }]);
  assert.equal(applyFileSceneMaterialOverrides(parts, undefined), parts);
  assert.equal(applyFileSceneMaterialOverrides(parts, {}), parts);
  assert.throws(() => applyFileSceneMaterialOverrides(parts, 'invalid'), TypeError);
});

test('applyFileSceneMaterialOverrides applies water overrides via worldMaterials and leaves others by reference', () => {
  const wall = Object.freeze({ material: Object.freeze({ name: 'Brick', color: [0.8, 0.5, 0.4] }) });
  const fakeMap = { image: {} };
  const pool = Object.freeze({
    material: Object.freeze({
      name: 'BasinWater',
      tag: 'gltf',
      color: [0.3, 0.7, 0.9],
      normalMap: fakeMap,
      metallicRoughnessMap: fakeMap,
      occlusionMap: fakeMap,
      emissiveMap: fakeMap,
    }),
  });
  const result = applyFileSceneMaterialOverrides(
    [wall, pool],
    {
      BasinWater: {
        tag: 'water',
        waterPreset: 'lake',
        alphaMode: 'blend',
        opacity: 0.62,
        roughness: 0.08,
        ripples: { strength: 0.85, speed: 1.2 },
      },
    },
    worldMaterials,
  );
  assert.equal(result[0], wall);
  const waterMaterial = result[1].material;
  assert.equal(waterMaterial.tag, 'water');
  assert.equal(waterMaterial.alphaMode, 'blend');
  assert.equal(waterMaterial.opacity, 0.62);
  assert.equal(waterMaterial.roughness, 0.08);
  assert.equal(waterMaterial.waterPreset, 'lake');
  assert.deepEqual(waterMaterial.ripples, { strength: 0.85, speed: 1.2 });
  assert.equal(waterMaterial.normalMap, undefined);
  assert.equal(waterMaterial.metallicRoughnessMap, undefined);
  assert.equal(waterMaterial.occlusionMap, undefined);
  assert.equal(waterMaterial.emissiveMap, undefined);
  assert.throws(() => applyFileSceneMaterialOverrides([pool], { BasinWater: { tag: 'water' } }), Error);
});

test('logGltfWarnings logs every decoded glTF warning once', () => {
  const seen = [];
  logGltfWarnings(undefined, text => seen.push(text));
  assert.deepEqual(seen, []);
  logGltfWarnings(['Downscaled 6 texture image(s) to fit maxTexturePixels'], text => seen.push(text));
  assert.deepEqual(seen, ['glTF: Downscaled 6 texture image(s) to fit maxTexturePixels']);
});
