import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyFileSceneMaterials,
  collectFileSceneWarnings,
  reportFileSceneWarnings,
  resolveFileSceneGltfOptions,
} from '../src/file-scene.js';
import { GLTF_CAPABILITIES } from '../src/gltf.js';
import { registeredFeatureCode } from '../src/shader-registry.js';
import { applyWaterReflection } from '../src/water-reflection.js';
import { printSceneWarnings } from '../scripts/render-media.mjs';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function flatQuadGeometry(halfSize) {
  return {
    positions: new Float32Array([
      -halfSize, 0, -halfSize,
      -halfSize, 0, halfSize,
      halfSize, 0, halfSize,
      halfSize, 0, -halfSize,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function gltfMaterial(name, extra = {}) {
  return {
    name,
    tag: 'gltf',
    color: [0.6, 0.6, 0.6],
    metallic: 0,
    roughness: 0.8,
    emission: 0,
    emissiveColor: [0, 0, 0],
    normalScale: [1, 1],
    occlusionStrength: 1,
    alphaMode: 'opaque',
    alphaCutoff: 0.5,
    opacity: 1,
    doubleSided: false,
    ...extra,
  };
}

test('applyFileSceneMaterials validates description.materials and entries', async () => {
  const parts = [{ name: 'mesh', geometry: flatQuadGeometry(1), matrix: IDENTITY, material: gltfMaterial('Water') }];
  for (const invalid of [null, [], 'Water', 42, new Map()]) {
    await assert.rejects(applyFileSceneMaterials(parts, invalid), { name: 'TypeError', message: /"materials" must be a plain object/ });
  }
  await assert.rejects(applyFileSceneMaterials(parts, { Water: null }), { name: 'TypeError', message: /"materials\.Water" must be a plain object/ });
  await assert.rejects(applyFileSceneMaterials(parts, { Water: [] }), { name: 'TypeError', message: /"materials\.Water" must be a plain object/ });
  await assert.rejects(applyFileSceneMaterials(parts, { Water: { snippet: 'void main(){}' } }), { name: 'TypeError', message: /not a supported material override field/ });
  await assert.rejects(applyFileSceneMaterials(parts, { Water: { map: { image: {} } } }), { name: 'TypeError', message: /not a supported material override field/ });
  await assert.rejects(applyFileSceneMaterials(parts, { Water: { tag: 'bogus' } }), { name: 'RangeError', message: /materials\.Water\.tag/ });
  await assert.rejects(applyFileSceneMaterials(parts, { Water: { roughness: 2 } }), { name: 'RangeError', message: /materials\.Water\.roughness/ });
});

test('applyFileSceneMaterials matches by material.name, preserves shared batch materials, and promotes blended opacity', async () => {
  const sharedWater = gltfMaterial('Ocean');
  const rockMaterial = gltfMaterial('Rock');
  const unnamedMaterial = gltfMaterial(undefined);
  const parts = [
    { name: 'ocean-a', geometry: flatQuadGeometry(10), matrix: IDENTITY, material: sharedWater },
    { name: 'ocean-b', geometry: flatQuadGeometry(10), matrix: IDENTITY, material: sharedWater },
    { name: 'rock', geometry: flatQuadGeometry(1), matrix: IDENTITY, material: rockMaterial },
    { name: 'unnamed', geometry: flatQuadGeometry(1), matrix: IDENTITY, material: unnamedMaterial },
  ];
  const { parts: updated, replaced } = await applyFileSceneMaterials(parts, {
    Ocean: { color: [0.05, 0.2, 0.3], roughness: 0.04, opacity: 0.85 },
    toString: { color: [1, 0, 0] },
  });
  assert.equal(updated[0].material, updated[1].material, 'parts sharing a source material keep sharing the merged copy');
  assert.notEqual(updated[0].material, sharedWater, 'source material object is not mutated in place');
  assert.equal(sharedWater.roughness, 0.8);
  assert.deepEqual(updated[0].material.color, [0.05, 0.2, 0.3]);
  assert.equal(updated[0].material.roughness, 0.04);
  assert.equal(updated[0].material.opacity, 0.85);
  assert.equal(updated[0].material.alphaMode, 'blend');
  assert.equal(updated[2], parts[2]);
  assert.equal(updated[3], parts[3]);
  assert.equal(replaced.get(parts[0]), updated[0]);
  assert.equal(replaced.get(parts[1]), updated[1]);
  assert.equal(replaced.has(parts[2]), false);
});

test('applyFileSceneMaterials dynamically loads world-material-shader for water overrides, copies water fields, and enables waterReflection', async () => {
  const lakeMaterial = gltfMaterial('LakeWater', {
    map: { image: { width: 1, height: 1 } },
    normalMap: { image: { width: 1, height: 1 } },
    metallicRoughnessMap: { image: { width: 1, height: 1 } },
    occlusionMap: { image: { width: 1, height: 1 } },
    emissiveMap: { image: { width: 1, height: 1 } },
  });
  const bankMaterial = gltfMaterial('Bank');
  const parts = [
    { name: 'lake', geometry: flatQuadGeometry(50), matrix: IDENTITY, material: lakeMaterial },
    { name: 'bank', geometry: flatQuadGeometry(5), matrix: IDENTITY, material: bankMaterial },
  ];
  const { parts: updated } = await applyFileSceneMaterials(parts, {
    LakeWater: {
      tag: 'water',
      waterPreset: 'sea',
      roughness: 0.05,
      opacity: 0.9,
      ripples: { strength: 0.4, speed: 0.6, windDirection: 45 },
      contactFoam: { width: 8, hardness: 0.9 },
      waterRamp: { colors: [[0.02, 0.1, 0.2], [0.1, 0.4, 0.5], [0.4, 0.8, 0.85]] },
    },
  });
  assert.ok(registeredFeatureCode.has('worldMaterials'), 'world-material-shader must register its shader code on water override');
  const water = updated[0].material;
  assert.equal(water.tag, 'water');
  assert.equal(water.waterPreset, 'sea');
  assert.deepEqual(water.absorption, [0.4, 0.06, 0.02]);
  assert.equal(water.turbidity, 0.1);
  assert.equal(water.ripples.strength, 0.4);
  assert.equal(water.contactFoam.width, 8);
  assert.equal(water.waterRamp.colors.length, 3);
  assert.ok(water.map, 'base map stays on water material');
  assert.equal(water.normalMap, undefined);
  assert.equal(water.metallicRoughnessMap, undefined);
  assert.equal(water.occlusionMap, undefined);
  assert.equal(water.emissiveMap, undefined);

  const reflection = applyWaterReflection(updated);
  assert.ok(reflection.surface, 'water override must qualify for applyWaterReflection');
  assert.deepEqual(reflection.surface.partIndices, [0]);

  const { parts: tweaked } = await applyFileSceneMaterials([updated[0]], {
    LakeWater: { roughness: 0.08 },
  });
  assert.equal(tweaked[0].material.waterPreset, 'sea', 'existing water preset stays when override omits waterPreset');
  assert.deepEqual(tweaked[0].material.absorption, [0.4, 0.06, 0.02]);

  await assert.rejects(
    applyFileSceneMaterials([parts[1]], { Bank: { waterPreset: 'sea' } }),
    { name: 'RangeError', message: /need the water tag/ },
  );
});

test('resolveFileSceneGltfOptions scales maxTexturePixels proportionally above 384 MiB unless explicitly set', () => {
  const defaultPixels = GLTF_CAPABILITIES.limits.maxTexturePixels;
  assert.deepEqual(resolveFileSceneGltfOptions({}), {});
  assert.deepEqual(resolveFileSceneGltfOptions({ renderer: { memoryBudgetMiB: 384 } }), {});
  assert.deepEqual(resolveFileSceneGltfOptions({ renderer: { memoryBudgetMiB: 256 } }), {});
  assert.equal(resolveFileSceneGltfOptions({ renderer: { memoryBudgetMiB: 768 } }).maxTexturePixels, defaultPixels * 2);
  assert.equal(
    resolveFileSceneGltfOptions({ renderer: { memoryBudgetMiB: 1024 } }).maxTexturePixels,
    Math.round(defaultPixels * (1024 / 384)),
  );
  assert.equal(
    resolveFileSceneGltfOptions({
      renderer: { memoryBudgetMiB: 1024 },
      gltfOptions: { maxTexturePixels: 4_194_304, maxVertices: 1_000_000 },
    }).maxTexturePixels,
    4_194_304,
  );
  assert.throws(() => resolveFileSceneGltfOptions({ gltfOptions: 'bad' }), /"gltfOptions" must be a plain object/);
});

test('collectFileSceneWarnings, reportFileSceneWarnings, and printSceneWarnings surface loadGltf warnings', () => {
  const warnings = collectFileSceneWarnings(
    ['Scaled 2 texture image(s) to fit maxTexturePixels: albedo, normal.', 'KHR_materials_variants is accepted but not rendered.'],
    ['KHR_materials_variants is accepted but not rendered.', 'Skipped 1 primitive(s) in mesh Wire: Crucible draws triangles only.'],
  );
  assert.deepEqual(warnings, [
    'Scaled 2 texture image(s) to fit maxTexturePixels: albedo, normal.',
    'KHR_materials_variants is accepted but not rendered.',
    'Skipped 1 primitive(s) in mesh Wire: Crucible draws triangles only.',
  ]);

  const logged = [];
  reportFileSceneWarnings(warnings, message => logged.push(message));
  assert.deepEqual(logged, warnings);

  const printed = [];
  printSceneWarnings([], message => printed.push(message));
  assert.deepEqual(printed, []);
  printSceneWarnings(warnings, message => printed.push(message));
  assert.equal(printed[0], 'Scene load warnings (3):');
  assert.match(printed[1], /Scaled 2 texture image\(s\)/);
  assert.match(printed[3], /Skipped 1 primitive\(s\)/);
});

test('applyFileSceneMaterials supports glass layer fields and keeps normalMap on foliage while stripping layers', async () => {
  const fakeMap = { image: { width: 1, height: 1 } };
  const glass = gltfMaterial('WindowGlass');
  const leaf = gltfMaterial('Leaf', { normalMap: fakeMap, metallicRoughnessMap: fakeMap, clearcoat: 0.4 });
  const parts = [
    { name: 'window', geometry: flatQuadGeometry(1), matrix: IDENTITY, material: glass },
    { name: 'leaf', geometry: flatQuadGeometry(1), matrix: IDENTITY, material: leaf },
  ];
  const { parts: updated } = await applyFileSceneMaterials(parts, {
    WindowGlass: {
      transmission: 0.9,
      ior: 1.52,
      thickness: 0.08,
      attenuationColor: [0.85, 0.95, 0.9],
      attenuationDistance: 2.5,
    },
    Leaf: { tag: 'foliage', color: [0.2, 0.55, 0.2] },
  });
  assert.equal(updated[0].material.transmission, 0.9);
  assert.equal(updated[0].material.ior, 1.52);
  assert.equal(updated[0].material.thickness, 0.08);
  assert.deepEqual(updated[0].material.attenuationColor, [0.85, 0.95, 0.9]);
  assert.equal(updated[0].material.attenuationDistance, 2.5);
  assert.equal(updated[1].material.tag, 'foliage');
  assert.equal(updated[1].material.normalMap, fakeMap);
  assert.equal(updated[1].material.metallicRoughnessMap, undefined);
  assert.equal(updated[1].material.layers, undefined);
});

test('src/file-scene.js and scripts/render-media.mjs wire dynamic water import, warnings, and gltfOptions', () => {
  const fileSceneSource = readFileSync(new URL('../src/file-scene.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fileSceneSource, /import\s+[^;]*from\s+['"]\.\/world-material-shader\.js['"]/);
  assert.ok(fileSceneSource.includes("import('./world-material-shader.js')"));
  assert.match(fileSceneSource, /const gltfOptions = resolveFileSceneGltfOptions\(description\)/);
  assert.match(fileSceneSource, /loadStagedParts\(description, asset, model, sharedTextures, gltfOptions\)/);
  assert.match(fileSceneSource, /reportFileSceneWarnings\(warnings\)/);
  assert.match(fileSceneSource, /window\.__scene\s*=\s*\{[^\n]*\bwarnings\b/);
  assert.ok(
    fileSceneSource.indexOf('applyFileSceneMaterials(') < fileSceneSource.indexOf('applyWaterReflection('),
    'materials overrides must run before applyWaterReflection',
  );

  const renderMediaSource = readFileSync(new URL('../scripts/render-media.mjs', import.meta.url), 'utf8');
  assert.match(renderMediaSource, /window\.__scene\?\.warnings/);
  assert.match(renderMediaSource, /printSceneWarnings\(sceneWarnings\)/);
});
