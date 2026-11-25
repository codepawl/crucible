import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { sequenceFrameIds } from '../src/agent-scene-assets.js';
import { namesCatalogTextureMaps, resolveTextureSetNames } from '../src/agent-asset-names.js';
import { createTerrain } from '../src/terrain.js';

await loadAllAgentSceneModules();

const LAYER_IDS = ['1', '2', '3', '4'].map(digit => ({
  color: `${digit}a`.repeat(32),
  normal: `${digit}b`.repeat(32),
  roughness: `${digit}c`.repeat(32),
  height: `${digit}d`.repeat(32),
  metallic: `${digit}e`.repeat(32),
  occlusion: `${digit}f`.repeat(32),
}));

function solidFrame(pixel, width = 4, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(pixel, offset);
  return { width, height, data };
}

function makePool() {
  const map = new Map();
  LAYER_IDS.forEach((ids, index) => {
    map.set(ids.color, solidFrame([40 + index * 40, 120, 60, 255]));
    map.set(ids.normal, solidFrame([128, 200, 255, 255]));
    map.set(ids.roughness, solidFrame([110 + index * 20, 110 + index * 20, 110 + index * 20, 255]));
    map.set(ids.height, solidFrame([60 + index * 45, 60 + index * 45, 60 + index * 45, 255]));
    map.set(ids.metallic, solidFrame([0, 0, 0, 255]));
    map.set(ids.occlusion, solidFrame([240, 240, 240, 255]));
  });
  return map;
}

function baseTerrainRecipe(terrainOverrides = {}, sceneOverrides = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'hills', type: 'terrain', size: 60, resolution: 32, amplitude: 6, seed: 7, ...terrainOverrides }],
    materials: [{ id: 'flat', color: [0.5, 0.5, 0.4] }],
    nodes: [{ id: 'ground', geometry: 'hills', material: 'flat' }],
    camera: { eye: [0, 18, 36], target: [0, 0, 0] },
    ...sceneOverrides,
  };
}

function fullSplatMaterial() {
  return {
    layers: [
      { name: 'grass', colorMap: LAYER_IDS[0].color, normalMap: LAYER_IDS[0].normal, roughnessMap: LAYER_IDS[0].roughness, heightMap: LAYER_IDS[0].height, tiling: 3.2, tint: [0.65, 0.92, 0.45] },
      { name: 'dirt', colorMap: LAYER_IDS[1].color, normalMap: LAYER_IDS[1].normal, roughnessMap: LAYER_IDS[1].roughness, heightMap: LAYER_IDS[1].height, tiling: 2.8 },
      { name: 'gravel', colorMap: LAYER_IDS[2].color, roughnessMap: LAYER_IDS[2].roughness, heightMap: LAYER_IDS[2].height, tiling: 3.5, normalStrength: 1.4 },
      { name: 'rock', colorMap: LAYER_IDS[3].color, normalMap: LAYER_IDS[3].normal, roughnessMap: LAYER_IDS[3].roughness, heightMap: LAYER_IDS[3].height, tiling: 5.5, triplanar: true },
    ],
    rules: [
      { layer: 'dirt', mask: 'road' },
      { layer: 2, slope: [14, 34], slopeSoftness: 5, height: [-10, 20], heightSoftness: 2 },
      { layer: 'rock', slope: [28, 90] },
    ],
    heightBlend: 0.25,
    heightInfluence: 1.1,
    antiTiling: 0.9,
    variation: 1.2,
    edgeNoise: 0.8,
    parallax: 0.04,
    triplanarStart: 32,
    triplanarEnd: 48,
    cavity: 0.6,
    textureSize: 64,
    maskResolution: 16,
    color: [0.95, 0.95, 0.92],
  };
}

test('default recipe terrain without material keeps flat material and unchanged geometry', () => {
  const plain = createAgentScene(baseTerrainRecipe());
  const part = plain.parts.find(candidate => candidate.name === 'ground');
  assert.equal(part.material.id, 'flat');
  assert.equal(part.material.layers, undefined);
  assert.equal(part.material.splat, undefined);
});

test('terrain.material builds a 4-layer splat material with rules, path mask and options', () => {
  const paths = [{ name: 'road', points: [[-25, 0], [0, 0], [25, 0]], width: 4, depth: 0.2 }];
  const recipe = baseTerrainRecipe({ paths, material: fullSplatMaterial() });
  const scene = createAgentScene(recipe, {}, { sequenceFrames: makePool() });
  const part = scene.parts.find(candidate => candidate.name === 'ground');

  assert.equal(part.material.tag, 'surface');
  assert.deepEqual(part.material.color, [0.95, 0.95, 0.92]);
  assert.equal(part.material.layers.length, 4);
  assert.equal(part.material.layers[0].scale, 3.2);
  assert.deepEqual(part.material.layers[0].tint, [0.65, 0.92, 0.45]);
  assert.equal(part.material.layers[2].normalStrength, 1.4);
  assert.equal(part.material.layers[3].triplanar, true);
  assert.equal(part.material.layers[0].triplanar, undefined);

  assert.equal(part.material.splat.rules[0], undefined);
  assert.deepEqual(part.material.splat.rules[1], { mask: 'r' });
  assert.deepEqual(part.material.splat.rules[2], { slope: [14, 34], slopeSoftness: 5, height: [-10, 20], heightSoftness: 2 });
  assert.deepEqual(part.material.splat.rules[3], { slope: [28, 90] });
  assert.equal(part.material.splat.heightBlend, 0.25);
  assert.equal(part.material.splat.heightInfluence, 1.1);
  assert.equal(part.material.splat.antiTiling, 0.9);
  assert.equal(part.material.splat.variation, 1.2);
  assert.equal(part.material.splat.edgeNoise, 0.8);
  assert.equal(part.material.splat.parallax, 0.04);
  assert.equal(part.material.splat.triplanarStart, 32);
  assert.equal(part.material.splat.triplanarEnd, 48);
  assert.equal(part.material.splat.cavity, 0.6);
  assert.equal(part.material.splat.textureSize, 64);
  assert.deepEqual(part.material.splat.maskBounds, [-30, -30, 30, 30]);
  assert.equal(part.material.splat.maskMap.colorSpace, 'linear');
  assert.equal(part.material.splat.maskMap.image.width, 16);
  assert.equal(part.material.splat.maskMap.image.height, 16);

  const terrain = createTerrain({ size: 60, chunks: 1, resolution: 32, seed: 7, height: { amplitude: 6, featureSize: 15, mountainMask: () => 0 }, paths });
  const expectedRow0 = terrain.pathMasks.image('road', 16).data;
  const actual = part.material.splat.maskMap.image.data;
  for (let pixel = 0; pixel < actual.length; pixel += 4) {
    assert.equal(actual[pixel], expectedRow0[pixel]);
  }
});

test('multiple named path masks pack into distinct RGBA channels of maskMap', () => {
  const paths = [
    { name: 'road', points: [[-20, -10], [20, -10]], width: 4, depth: 0.2, falloff: 1 },
    { name: 'stream', points: [[0, -20], [0, 20]], width: 4, depth: 0.3, falloff: 1 },
  ];
  const recipe = baseTerrainRecipe({
    paths,
    material: {
      layers: [
        { name: 'grass', colorMap: LAYER_IDS[0].color },
        { name: 'dirt', colorMap: LAYER_IDS[1].color },
        { name: 'gravel', colorMap: LAYER_IDS[2].color },
      ],
      rules: [
        { layer: 'dirt', mask: 'road' },
        { layer: 'gravel', mask: 'stream', invertMask: true },
      ],
      maskResolution: 32,
    },
  });
  const scene = createAgentScene(recipe, {}, { sequenceFrames: makePool() });
  const splat = scene.parts[0].material.splat;
  assert.deepEqual(splat.rules[1], { mask: 'r' });
  assert.deepEqual(splat.rules[2], { mask: 'g', invertMask: true });
  const maxR = Math.max(...splat.maskMap.image.data.filter((_, index) => index % 4 === 0));
  const maxG = Math.max(...splat.maskMap.image.data.filter((_, index) => index % 4 === 1));
  assert.equal(maxR, 255);
  assert.equal(maxG, 255);
});

test('textureSet resolution, DirectX green flip, boolean toggles and scale alias work cleanly', async () => {
  const recipe = baseTerrainRecipe({
    material: {
      layers: [
        { name: 'base', textureSet: 'grass_set', scale: 5 },
        { name: 'rock', textureSet: 'rock_set', tiling: 6 },
      ],
      rules: [{ layer: 'rock', slope: [30, 90] }],
      antiTiling: false,
      parallax: false,
      triplanar: true,
    },
  });
  assert.equal(namesCatalogTextureMaps(recipe), true);
  await resolveTextureSetNames(recipe, {
    resolveSet: name => (name === 'grass_set'
      ? { colorMap: LAYER_IDS[0].color, normalMap: LAYER_IDS[0].normal, normalConvention: 'directx', occlusionMap: LAYER_IDS[0].occlusion }
      : { colorMap: LAYER_IDS[3].color, roughnessMap: LAYER_IDS[3].roughness, heightMap: LAYER_IDS[3].height }),
    checkMap: async () => {},
  });
  assert.equal(sequenceFrameIds(recipe).length, 6);
  const scene = createAgentScene(recipe, {}, { sequenceFrames: makePool() });
  const material = scene.parts[0].material;
  assert.equal(material.layers[0].scale, 5);
  assert.equal(material.layers[0].triplanar, true);
  assert.equal(material.layers[1].triplanar, true);
  // DirectX flips green (200 -> 55).
  assert.equal(material.layers[0].normal.image.data[1], 55);
  assert.equal(material.splat.antiTiling, 0);
  assert.equal(material.splat.parallax, 0);
});

test('splat material keeps identity on unrelated edits, updates when edited, and follows chunked LOD terrain', () => {
  const pool = makePool();
  const recipe = baseTerrainRecipe(
    {
      chunks: 2,
      levels: 2,
      resolution: 16,
      material: {
        layers: [
          { colorMap: LAYER_IDS[0].color, tiling: 4 },
          { colorMap: LAYER_IDS[3].color, tiling: 6, triplanar: true },
        ],
        rules: [{ layer: 1, slope: [25, 90] }],
      },
    },
    {
      motion: {
        duration: 2,
        tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [0, 12, 24] }, { time: 2, value: [0, 80, 120] }] }],
      },
    },
  );
  const scene = createAgentScene(recipe, {}, { sequenceFrames: pool });
  const firstMaterial = scene.parts[0].material;
  scene.sampleMotion(0);
  const nearPart = scene.parts[0];
  assert.equal(nearPart.material, firstMaterial);
  const nearCount = nearPart.geometry.positions.length;
  scene.sampleMotion(2);
  const farPart = scene.parts[0];
  assert.equal(farPart.material, firstMaterial);
  assert.ok(farPart.geometry.positions.length < nearCount);

  scene.apply([{ type: 'set-camera', eye: [10, 20, 40] }], { expectedRevision: scene.revision });
  assert.equal(scene.parts[0].material, firstMaterial, 'unrelated edit reuses the cached splat material');

  const updatedTerrain = { ...structuredClone(recipe.geometries[0]), id: 'hills-updated' };
  updatedTerrain.material.parallax = 0;
  scene.apply([
    { type: 'add-geometry', geometry: updatedTerrain },
    { type: 'set-node', id: 'ground', geometry: 'hills-updated' },
  ], { expectedRevision: scene.revision });
  assert.notEqual(scene.parts[0].material, firstMaterial, 'editing terrain.material replaces the splat material');
  assert.equal(scene.parts[0].material.splat.parallax, 0);
});

test('terrain.material rejects invalid configurations with clear field errors', () => {
  const pool = makePool();
  const build = material => createAgentScene(baseTerrainRecipe({ material }), {}, { sequenceFrames: pool });

  assert.throws(() => build(null), /terrain\.material/);
  assert.throws(() => build({ layers: [] }), /terrain\.material\.layers/);
  assert.throws(() => build({ layers: [0, 1, 2, 3, 4].map(() => ({ colorMap: LAYER_IDS[0].color })) }), /1 to 4/);
  assert.throws(() => build({ layers: [{ textureSet: 'grass' }] }), /textureSet/);
  assert.throws(() => build({ layers: [{ colorMap: 'bad-id' }] }), /64 hexadecimal/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color, tiling: 2, scale: 2 }] }), /only one of tiling or scale/);
  assert.throws(() => build({ layers: [{ tiling: 2 }] }), /at least one of/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color, normalConvention: 'directx' }] }), /normalMap/);
  assert.throws(() => build({ layers: [{ name: 'a', colorMap: LAYER_IDS[0].color }, { name: 'a', colorMap: LAYER_IDS[1].color }] }), /unique layer name/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], rules: [{ layer: 'missing' }] }), /layers\[0\]|layer/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], rules: [{ layer: 0, slope: [20, 30] }, { layer: 0, slope: [40, 50] }] }), /at most 1 rules/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }, { colorMap: LAYER_IDS[1].color }], rules: [{ layer: 1, slope: [10, 20] }, { layer: 1, slope: [30, 40] }] }), /already targeted/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], rules: [{ layer: 0, mask: 'road' }] }), /no paths/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], rules: [{ layer: 0, invertMask: true }] }), /also sets mask/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], parallax: 0.5 }), /terrain\.material\.parallax/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], antiTiling: 2 }), /terrain\.material\.antiTiling/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], triplanarStart: 60, triplanarEnd: 40 }), /triplanarStart/);
  assert.throws(() => build({ layers: [{ colorMap: LAYER_IDS[0].color }], unknownKey: 1 }), /terrain\.material\.unknownKey/);
  assert.throws(() => createAgentScene(baseTerrainRecipe({ material: { layers: [{ colorMap: LAYER_IDS[0].color }] } })), /was not loaded/);
});

test('MCP scene_create accepts terrain.material with textureSet and carved road path mask', async context => {
  const assetsFolder = await mkdtemp(join(tmpdir(), 'crucible-terrain-splat-mcp-'));
  context.after(() => rm(assetsFolder, { recursive: true, force: true }));
  await mkdir(join(assetsFolder, 'grass'));
  await mkdir(join(assetsFolder, 'rock'));
  const makePng = rgba => sharp({ create: { width: 4, height: 4, channels: 4, background: rgba } }).png().toBuffer();
  await writeFile(join(assetsFolder, 'grass', 'grass_color.png'), await makePng({ r: 80, g: 140, b: 60, alpha: 255 }));
  await writeFile(join(assetsFolder, 'grass', 'grass_rough.png'), await makePng({ r: 180, g: 180, b: 180, alpha: 255 }));
  await writeFile(join(assetsFolder, 'rock', 'rock_color.png'), await makePng({ r: 120, g: 115, b: 110, alpha: 255 }));
  await writeFile(join(assetsFolder, 'rock', 'rock_nor_gl.png'), await makePng({ r: 128, g: 128, b: 255, alpha: 255 }));

  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createAgentRuntime } = await import('../scripts/agent-runtime.mjs');
  const { createAgentMcpServer } = await import('../scripts/mcp-server.mjs');
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, assets: assetsFolder });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'terrain-splat-mcp-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const recipe = {
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [
        {
          id: 'hill',
          type: 'terrain',
          size: 80,
          resolution: 32,
          amplitude: 8,
          paths: [{ name: 'trail', points: [[-30, 0], [30, 0]], width: 4, depth: 0.3 }],
          material: {
            layers: [
              { name: 'grass', textureSet: 'grass', tiling: 3 },
              { name: 'rock', textureSet: 'rock', tiling: 5, triplanar: true },
            ],
            rules: [{ layer: 'rock', mask: 'trail', slope: [20, 90] }],
          },
        },
      ],
      materials: [{ id: 'fallback', color: [0.5, 0.5, 0.5] }],
      nodes: [{ id: 'hill-node', geometry: 'hill', material: 'fallback' }],
      camera: { eye: [0, 20, 45], target: [0, 0, 0] },
    };
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  } finally {
    await client.close();
    await mcp.close();
    await runtime.close();
  }
});
