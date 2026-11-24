import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { createFragmentShader, layerTextureSupport } from '../src/shaders.js';
import '../src/world-material-shader.js';

const COLORS = [[0.01, 0.12, 0.2], [0.04, 0.4, 0.5], [0.3, 0.85, 0.9]];

function sceneWith(material) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'box' }],
    materials: [{ id: 'sea', ...material }],
    nodes: [{ id: 'sea', geometry: 'sheet', material: 'sea' }],
  });
}

function rampOf(waterRamp) {
  return sceneWith({ tag: 'water', waterRamp }).parts[0].material.waterRamp;
}

test('a water ramp keeps its colours and fills the defaults', () => {
  const ramp = rampOf({ colors: COLORS });
  assert.deepEqual(ramp.colors, COLORS);
  assert.deepEqual(ramp.drivers, { height: 1, facing: 0, sun: 0 });
  assert.deepEqual(ramp.heightRange, [-1, 1]);
  assert.equal(ramp.steps, 'hard');
  assert.equal(ramp.crestTint, undefined);
});

test('a water ramp keeps drivers, steps and the crest tint', () => {
  const ramp = rampOf({ colors: COLORS, drivers: { height: 0.7, sun: 0.3 }, heightRange: [-2, 3], steps: 'soft', crestTint: { color: [0.7, 1, 0.9], strength: 0.5 } });
  assert.deepEqual(ramp.drivers, { height: 0.7, facing: 0, sun: 0.3 });
  assert.deepEqual(ramp.heightRange, [-2, 3]);
  assert.equal(ramp.steps, 'soft');
  assert.deepEqual(ramp.crestTint, { color: [0.7, 1, 0.9], strength: 0.5 });
});

test('the stored ramp is accepted again, so a render job can rebuild the scene from its snapshot', () => {
  const first = rampOf({ colors: COLORS, drivers: { facing: 1 }, crestTint: { color: [1, 1, 1] } });
  assert.deepEqual(rampOf(JSON.parse(JSON.stringify(first))), first);
});

test('a bad water ramp is refused with what to pass instead', () => {
  assert.throws(() => rampOf({ colors: COLORS.slice(0, 2) }), /3 to 5 colours from deep to bright/);
  assert.throws(() => rampOf({ colors: [...COLORS, ...COLORS] }), /3 to 5 colours/);
  assert.throws(() => rampOf({ colors: COLORS, steps: 'smooth' }), /steps must be one of hard, soft/);
  assert.throws(() => rampOf({ colors: COLORS, drivers: { depth: 1 } }), /no depth; pass weights for height, facing, sun/);
  assert.throws(() => rampOf({ colors: COLORS, drivers: { height: 0 } }), /at least one above 0/);
  assert.throws(() => rampOf({ colors: COLORS, heightRange: [2, 2] }), /low below high/);
  assert.throws(() => rampOf({ colors: COLORS, crestTint: { strength: 0.5 } }), /crestTint must be/);
  assert.throws(() => rampOf({ colors: COLORS, speed: 2 }), /no speed/);
  assert.throws(() => rampOf({ colors: [[0, 0, -1], COLORS[1], COLORS[2]] }), /colors\[0\] must be three numbers from 0 to 16/);
});

test('a ramp needs the water tag', () => {
  assert.throws(() => sceneWith({ waterRamp: { colors: COLORS } }), /waterRamp needs the water tag/);
  assert.equal(sceneWith({ tag: 'water' }).parts[0].material.waterRamp, undefined);
});

test('the water shader draws the ramp over the sky reflection only when a ramp is bound', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /vec3 waterRampTone\(float height, float facing, float sun\)/);
  assert.match(shader, /if \(waterRampHead\.x > 0\.5\)/);
  assert.match(shader, /if \(waterRampOwns > 0\.5\) radiance = waterRampRadiance \* \(1\.0 - waterFoam\)/);
});

function recordingRenderer() {
  const calls = [];
  const names = ['uniform4f', 'uniform3f', 'uniform2f', 'uniform3fv', 'uniform4fv', 'uniform1i', 'uniform1f'];
  const context = { getUniformLocation: (program, name) => name, isEnabled: () => false, BLEND: 3042 };
  for (const name of names) {
    context[name] = (location, ...values) => calls.push([name, location, values.flatMap(value => (value?.length === undefined ? [value] : [...value]))]);
  }
  return { calls, renderer: { shaderFeatures: new Set(['water']), program: {}, context, batches: [] } };
}

function sentUniforms(material) {
  const { calls, renderer } = recordingRenderer();
  layerTextureSupport.bind(renderer, [], [], { parts: [{ material }] });
  return Object.fromEntries(calls.filter(([, location]) => String(location).startsWith('waterRamp')).map(([, location, values]) => [location, values]));
}

test('a batch with a ramp sends it and a batch without one turns it off', () => {
  const ramp = rampOf({ colors: COLORS, drivers: { height: 0.7, sun: 0.3 }, steps: 'soft', crestTint: { color: [0.5, 1, 0.5], strength: 0.4 } });
  const sent = sentUniforms({ tag: 'water', waterRamp: ramp });
  assert.deepEqual(sent.waterRampHead, [3, 1, 0, 0]);
  assert.deepEqual(sent.waterRampWeights, [0.7, 0, 0.3]);
  assert.deepEqual(sent.waterRampCrest, [0.5, 1, 0.5, 0.4]);
  assert.deepEqual(sent.waterRampColors.slice(0, 9), COLORS.flat().map(Math.fround));
  assert.deepEqual(sent.waterRampColors.slice(9), new Array(6).fill(0));
  assert.deepEqual(sentUniforms({ tag: 'water' }).waterRampHead, [0, 0, 0, 0]);
});

test('a ramp colour given as a hex is stored as the linear colour that shows as that hex', () => {
  const ramp = rampOf({ colors: ['#19617c', '#38aabc', '#95edf3'], crestTint: { color: '#ffffff' } });
  const encode = linear => Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
  assert.deepEqual(ramp.colors.map(color => color.map(encode)), [[0x19, 0x61, 0x7c], [0x38, 0xaa, 0xbc], [0x95, 0xed, 0xf3]]);
  assert.deepEqual(ramp.crestTint.color, [1, 1, 1]);
  assert.throws(() => rampOf({ colors: ['#19617', COLORS[1], COLORS[2]] }), /colors\[0\]/);
});

test('the water shader maps the ramp back through the view transform and keeps the haze off it', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /vec3 waterRampRadianceFor\(vec3 asked\)/);
  assert.match(shader, /toneMap\(guess \+ 0\.002\)/);
  assert.match(shader, /waterRampRadiance = waterRampRadianceFor\(/);
  assert.match(shader, /float fogDensity = waterRampOwns > 0\.5 \? 0\.0 : fogDensity;/);
});
