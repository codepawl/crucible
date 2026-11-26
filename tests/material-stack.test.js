import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_LAYER_STACK_LIMITS,
  heightBlendWeight,
  normalizeMaterialLayerStack,
  bakeMaterialLayerStack,
} from '../src/material-stack.js';
import { normalizeMaterialPattern, bakeMaterialPattern } from '../src/material-patterns.js';
import { MATERIAL_GRAPH_LIMITS } from '../src/material-name-lists.js';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';

function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function srgbToLinear(byte) {
  const normalized = byte / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

test('heightBlendWeight keeps mask endpoints fixed, falls back linearly at 0, and sharpens around height differences', () => {
  assert.equal(heightBlendWeight(0, 0.9, 0.1, 0.95), 0);
  assert.equal(heightBlendWeight(1, 0.1, 0.9, 0.95), 1);
  assert.ok(Math.abs(heightBlendWeight(0.37, 0.9, 0.1, 0) - 0.37) < 1e-6);

  // When the base ridge is taller than the top cover, heightBlend pushes the weight down (base pokes through).
  const ridgeBaseWeight = heightBlendWeight(0.5, 0.9, 0.2, 0.85);
  const creviceBaseWeight = heightBlendWeight(0.5, 0.2, 0.9, 0.85);
  assert.ok(ridgeBaseWeight < 0.2, `expected rock ridge to poke through cover, got weight ${ridgeBaseWeight}`);
  assert.ok(creviceBaseWeight > 0.8, `expected cover to fill low crevice, got weight ${creviceBaseWeight}`);
  assert.ok(Math.abs(ridgeBaseWeight + creviceBaseWeight - 1) < 1e-6, 'heightBlendWeight stays symmetric under layer swap');
});

test('two-layer PBR stack blends colour, roughness, metallic, and height and bakes normal maps deterministically', () => {
  const stacked = normalizeMaterialPattern({
    type: 'layers',
    resolution: 256,
    bump: 1,
    layers: [
      { pattern: { type: 'metal', size: 1, count: 4 }, color: [0.8, 0.8, 0.85], roughness: 0.25, height: 0.8 },
      { color: [0.25, 0.12, 0.05], roughness: 0.9, metallic: 0, height: 0.2, mask: { uv: 'u' }, heightBlend: 0 },
    ],
  });
  const firstBake = bakeMaterialPattern(stacked);
  const secondBake = bakeMaterialPattern(stacked);
  assert.deepEqual(firstBake.map.image.data, secondBake.map.image.data);
  assert.deepEqual(firstBake.normalMap.image.data, secondBake.normalMap.image.data);
  assert.deepEqual(firstBake.metallicRoughnessMap.image.data, secondBake.metallicRoughnessMap.image.data);

  // Row 0 covers u from near 0 (base metal) to near 1 (soil cover).
  const leftOffset = 0;
  const rightOffset = (256 - 1) * 4;
  const centerOffset = 128 * 4;
  const leftRoughness = firstBake.metallicRoughnessMap.image.data[leftOffset + 1] / 255;
  const leftMetallic = firstBake.metallicRoughnessMap.image.data[leftOffset + 2] / 255;
  const rightRoughness = firstBake.metallicRoughnessMap.image.data[rightOffset + 1] / 255;
  const rightMetallic = firstBake.metallicRoughnessMap.image.data[rightOffset + 2] / 255;
  const midRoughness = firstBake.metallicRoughnessMap.image.data[centerOffset + 1] / 255;
  const midMetallic = firstBake.metallicRoughnessMap.image.data[centerOffset + 2] / 255;

  assert.ok(Math.abs(leftRoughness - 0.25) < 0.02);
  assert.ok(Math.abs(leftMetallic - 1) < 0.02);
  assert.ok(Math.abs(rightRoughness - 0.9) < 0.02);
  assert.ok(Math.abs(rightMetallic - 0) < 0.02);
  assert.ok(midRoughness > 0.5 && midRoughness < 0.65);
  assert.ok(midMetallic > 0.45 && midMetallic < 0.55);

  const leftRed = srgbToLinear(firstBake.map.image.data[leftOffset]);
  const rightRed = srgbToLinear(firstBake.map.image.data[rightOffset]);
  const midRed = srgbToLinear(firstBake.map.image.data[centerOffset]);
  assert.ok(Math.abs(leftRed - 0.8) < 0.02);
  assert.ok(Math.abs(rightRed - 0.25) < 0.02);
  assert.ok(midRed > 0.48 && midRed < 0.58);
});

test('heightBlend creates a sharper height-gated edge than a linear cross-fade on rough stone under soil', () => {
  const maskNode = { clamp: [{ add: [{ uv: 'u' }, { mul: [{ noise: { scale: 6, octaves: 2, seed: 3 } }, 0.3] }] }, 0, 1] };
  const makeStack = heightBlend => normalizeMaterialPattern({
    type: 'layers',
    resolution: 256,
    bump: 1.2,
    layers: [
      { color: [0.45, 0.44, 0.42], roughness: 0.3, height: { noise: { scale: 8, octaves: 3, seed: 5 } } },
      { graph: { color: [0.36, 0.22, 0.11], roughness: 0.9, height: 0.35 }, mask: maskNode, heightBlend },
    ],
  });
  const soft = bakeMaterialPattern(makeStack(0));
  const crisp = bakeMaterialPattern(makeStack(0.95));

  assert.equal(soft.metallicRoughnessMap.image.data[2], 0);
  assert.equal(crisp.metallicRoughnessMap.image.data[2], 0);

  // Measure pixels strictly in the intermediate roughness transition band between 0.38 and 0.82.
  let softIntermediate = 0;
  let crispIntermediate = 0;
  for (let index = 0; index < soft.metallicRoughnessMap.image.data.length; index += 4) {
    const softRough = soft.metallicRoughnessMap.image.data[index + 1] / 255;
    const crispRough = crisp.metallicRoughnessMap.image.data[index + 1] / 255;
    if (softRough > 0.38 && softRough < 0.82) softIntermediate++;
    if (crispRough > 0.38 && crispRough < 0.82) crispIntermediate++;
  }
  assert.ok(crispIntermediate < softIntermediate * 0.4, `expected crisp heightBlend transition to narrow intermediate band (${crispIntermediate} < ${softIntermediate * 0.4})`);
});

test('layer stacks support up to 4 layers and combine pattern, graph, and direct fields', () => {
  const fourLayers = normalizeMaterialLayerStack([
    { color: [0.1, 0.1, 0.1], roughness: 0.8, metallic: 0, height: 0.2 },
    { pattern: { type: 'rust', count: 4 }, mask: 0.5, heightBlend: 0.4 },
    { graph: { color: [0.15, 0.3, 0.1], roughness: 0.7, metallic: 0, height: 0.6 }, mask: 0.5 },
    { color: [0.9, 0.9, 0.95], roughness: 0.3, height: 0.95, mask: 0.5, heightBlend: 0.9 },
  ], 256, normalizeMaterialPattern);
  assert.equal(fourLayers.length, 4);
  assert.deepEqual(normalizeMaterialLayerStack(fourLayers, 256, normalizeMaterialPattern), fourLayers);
  const baked = bakeMaterialLayerStack(fourLayers, { resolution: 256, bump: 1, size: 1 }, null, null, () => ({
    red: 0.4, green: 0.2, blue: 0.1, height: 0.5, roughness: 0.7, metal: 0.5,
  }));
  assert.equal(baked.map.colorSpace, 'srgb');
  assert.equal(baked.normalMap.colorSpace, 'linear');
  assert.equal(baked.metallicRoughnessMap.colorSpace, 'linear');
  assert.ok(Math.abs(srgbToLinear(baked.map.image.data[0]) - 0.9) < 0.02);
});

test('layer stack bounds and validation errors name the failing field', () => {
  assert.equal(MATERIAL_LAYER_STACK_LIMITS.maxLayers, 4);
  const base = { color: [0.2, 0.2, 0.2] };
  assert.throws(() => normalizeMaterialLayerStack([], 256, normalizeMaterialPattern), /1 to 4 layers/);
  assert.throws(() => normalizeMaterialLayerStack([base, { ...base, mask: 0.5 }, { ...base, mask: 0.5 }, { ...base, mask: 0.5 }, { ...base, mask: 0.5 }], 256, normalizeMaterialPattern), /1 to 4 layers/);
  assert.throws(() => normalizeMaterialLayerStack([{ ...base, mask: 0.5 }], 256, normalizeMaterialPattern), /layer 0.*does not take mask/);
  assert.throws(() => normalizeMaterialLayerStack([{ ...base, heightBlend: 0.5 }], 256, normalizeMaterialPattern), /layer 0.*does not take mask or heightBlend/);
  assert.throws(() => normalizeMaterialLayerStack([base, base], 256, normalizeMaterialPattern), /layer 1 needs mask/);
  assert.throws(() => normalizeMaterialLayerStack([base, { ...base, mask: 0.5, heightBlend: 1.5 }], 256, normalizeMaterialPattern), /heightBlend must be a number between 0 and 1/);
  assert.throws(() => normalizeMaterialLayerStack([base, { ...base, mask: [1, 0, 0] }], 256, normalizeMaterialPattern), /needs a number, not a vector/);
  assert.throws(() => normalizeMaterialLayerStack([{ pattern: { type: 'stone' }, graph: { color: [0.5, 0.5, 0.5] } }], 256, normalizeMaterialPattern), /cannot set both pattern and graph/);
  assert.throws(() => normalizeMaterialLayerStack([{ pattern: { type: 'graph', graph: { color: [0.5, 0.5, 0.5] } } }], 256, normalizeMaterialPattern), /must be a preset pattern/);
  assert.throws(() => normalizeMaterialLayerStack([{}], 256, normalizeMaterialPattern), /needs pattern, graph, or at least one PBR field/);
  assert.throws(() => normalizeMaterialLayerStack([{ color: [0.2, 0.2, 0.2], graph: { color: [0.3, 0.3, 0.3] } }], 256, normalizeMaterialPattern), /sets color in both/);
  assert.throws(() => normalizeMaterialLayerStack([{ unknownField: 1, ...base }], 256, normalizeMaterialPattern), /unknown field "unknownField"/);

  // Combined graph budget across stacked layers rejects > 64 nodes (each single mask is valid alone).
  const pairSum = (a, b) => ({ add: [a, b] });
  const eightNoises = seed => pairSum(
    pairSum(
      pairSum({ noise: { scale: 2, octaves: 1, seed } }, { noise: { scale: 3, octaves: 1, seed: seed + 1 } }),
      pairSum({ noise: { scale: 4, octaves: 1, seed: seed + 2 } }, { noise: { scale: 5, octaves: 1, seed: seed + 3 } }),
    ),
    pairSum(
      pairSum({ noise: { scale: 6, octaves: 1, seed: seed + 4 } }, { noise: { scale: 7, octaves: 1, seed: seed + 5 } }),
      pairSum({ noise: { scale: 8, octaves: 1, seed: seed + 6 } }, { noise: { scale: 9, octaves: 1, seed: seed + 7 } }),
    ),
  );
  const wideLayerMask = seed => pairSum(
    eightNoises(seed),
    pairSum(
      pairSum({ noise: { scale: 10, octaves: 1, seed: seed + 8 } }, { noise: { scale: 11, octaves: 1, seed: seed + 9 } }),
      pairSum({ noise: { scale: 12, octaves: 1, seed: seed + 10 } }, { noise: { scale: 13, octaves: 1, seed: seed + 11 } }),
    ),
  );
  assert.throws(
    () => normalizeMaterialLayerStack([
      base,
      { ...base, mask: wideLayerMask(1) },
      { ...base, mask: wideLayerMask(20) },
      { ...base, mask: wideLayerMask(40) },
    ], 256, normalizeMaterialPattern),
    new RegExp(`limit is ${MATERIAL_GRAPH_LIMITS.maxNodes}|over the limit`),
  );
});

test('recipe materials support material.layers and pattern.layers, including surface and vertexGroup masks', async () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'terrainBlock', type: 'box' },
      { id: 'uvBall', type: 'sphere' },
    ],
    materials: [
      {
        id: 'rockSoil',
        layers: [
          { pattern: { type: 'stone', count: 4 } },
          { color: [0.3, 0.2, 0.1], roughness: 0.9, metallic: 0, height: 0.3, mask: { noise: { scale: 4, octaves: 2 } }, heightBlend: 0.8 },
        ],
      },
      {
        id: 'slopeLayer',
        pattern: {
          type: 'layers',
          mapping: 'uv',
          resolution: 256,
          layers: [
            { pattern: { type: 'stone', count: 4 } },
            { color: [0.85, 0.88, 0.92], roughness: 0.85, height: 0.7, mask: { surface: { output: 'normalY', space: 'world' } }, heightBlend: 0.6 },
          ],
        },
      },
    ],
    nodes: [
      { id: 'slab', geometry: 'terrainBlock', material: 'rockSoil' },
      { id: 'slope', geometry: 'uvBall', material: 'slopeLayer', translation: [2, 0, 0] },
    ],
  };

  assert.ok(agentSceneModulesNeeded(recipe).includes('patterns'));
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  const rockSoil = scene.parts[0].material;
  assert.equal(rockSoil.pattern.type, 'layers');
  assert.equal(rockSoil.layers, undefined);
  assert.equal(rockSoil.roughness, 1);
  assert.equal(rockSoil.metallic, 1);
  assert.ok(rockSoil.map.image.data.length > 0);
  assert.ok(rockSoil.normalMap.image.data.length > 0);
  assert.ok(rockSoil.metallicRoughnessMap.image.data.length > 0);

  const slopeMaterial = scene.parts[1].material;
  assert.equal(slopeMaterial.pattern.mapping, 'uv');
  assert.ok(slopeMaterial.map.image.data.length === 256 * 256 * 4);

  assert.throws(
    () => createAgentScene({
      ...recipe,
      materials: [{ id: 'bad', pattern: { type: 'stone' }, layers: [{ color: [0.5, 0.5, 0.5] }] }],
      nodes: [{ id: 'slab', geometry: 'terrainBlock', material: 'bad' }],
    }),
    /omitted when pattern is set/,
  );

  // Surface node in a layer requires UV mapping.
  assert.throws(
    () => normalizeMaterialPattern({
      type: 'layers',
      layers: [
        { pattern: { type: 'stone' } },
        { color: [0.9, 0.9, 0.9], mask: { surface: { output: 'slope' } } },
      ],
    }),
    /set "mapping": "uv"/,
  );
});
