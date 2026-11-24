import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { findWaterBody } from '../src/world-material-shader.js';
import { WATER_CAUSTICS_RANGES, resolveWaterCaustics, waterCausticsUniform } from '../src/water-caustics.js';
import { box } from '../src/geometry.js';
import { createFragmentShader } from '../src/shaders.js';

function waterPart(material) {
  const matrix = new Float32Array([40, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 40, 0, 0, 0, 0, 1]);
  return { name: 'water', geometry: box(0, 1), matrix, material };
}

function recipe(material) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'sheet', type: 'box', bevel: 0 }], materials: [{ id: 'water', ...material }], nodes: [{ id: 'sheet', geometry: 'sheet', material: 'water', scale: [10, 0.1, 10] }] };
}

test('caustics are off unless a water material asks for them, and an empty object takes the defaults', () => {
  assert.equal(resolveWaterCaustics(undefined), null);
  assert.equal(resolveWaterCaustics(null), null);
  const defaults = resolveWaterCaustics({});
  for (const [field, range] of Object.entries(WATER_CAUSTICS_RANGES)) assert.equal(defaults[field], range.default);
  assert.deepEqual(resolveWaterCaustics({ intensity: 4, scale: 0.5 }), { ...defaults, intensity: 4, scale: 0.5 });
});

test('caustics fields fail with the field name and the range to pass', () => {
  assert.throws(() => resolveWaterCaustics({ intensity: 11 }), /caustics\.intensity must be a number from 0 to 10/);
  assert.throws(() => resolveWaterCaustics({ scale: 0 }), /caustics\.scale must be a number from 0\.05 to 50/);
  assert.throws(() => resolveWaterCaustics({ depthFade: Number.NaN }), /caustics\.depthFade/);
  assert.throws(() => resolveWaterCaustics({ speeed: 1 }), /caustics has no field speeed; pass scale, speed, intensity, depthFade/);
  assert.throws(() => resolveWaterCaustics(2), /caustics must be an object/);
});

test('the shader uniform is all zero for no caustics and for intensity 0', () => {
  assert.deepEqual(waterCausticsUniform(null), [0, 0, 0, 0]);
  assert.deepEqual(waterCausticsUniform(resolveWaterCaustics({ intensity: 0 })), [0, 0, 0, 0]);
  assert.deepEqual(waterCausticsUniform(resolveWaterCaustics({ scale: 2, speed: 1, intensity: 3, depthFade: 0.5 })), [2, 1, 3, 0.5]);
});

test('a recipe water material carries resolved caustics; other tags and bad values refuse them', () => {
  const material = createAgentScene(recipe({ tag: 'water', caustics: { intensity: 3 } })).parts[0].material;
  assert.equal(material.caustics.intensity, 3);
  assert.equal(material.caustics.scale, WATER_CAUSTICS_RANGES.scale.default);
  assert.equal(createAgentScene(recipe({ tag: 'water' })).parts[0].material.caustics, undefined);
  assert.throws(() => createAgentScene(recipe({ tag: 'surface', caustics: {} })), /need the water tag/);
  assert.throws(() => createAgentScene(recipe({ tag: 'water', caustics: { intensity: -1 } })), /caustics\.intensity/);
});

test('the water body hands its caustics to the renderer and none when the material has none', () => {
  const caustics = resolveWaterCaustics({ intensity: 2 });
  assert.deepEqual(findWaterBody([waterPart({ tag: 'water', caustics })]).caustics, caustics);
  assert.equal(findWaterBody([waterPart({ tag: 'water' })]).caustics, null);
});

test('the shader adds the net to the sun below the surface only and stays out of a shader without water', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('float causticGain(vec3 position, float depth)'));
  assert.match(source, /else if \(waterBody\.z > 0\.5 && worldPosition\.y < \(waterSurfaceLevel = waterLevelAt\(worldPosition\)\)\) \{[\s\S]*if \(waterCaustics\.z > 0\.0\) waterSunTransmittance \*= causticGain\(worldPosition, waterDepth\);[\s\S]*\}\s*vec3 keyColor = keyColor \* waterSunTransmittance;/);
  assert.ok(!createFragmentShader([]).includes('causticGain'));
});
