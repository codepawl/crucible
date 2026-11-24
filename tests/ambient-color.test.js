import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { CrucibleRenderer } from '../src/renderer.js';

function environmentFor(fields) {
  return normalizeAgentLook({ environment: fields }).environment;
}

function uploadedUniforms(lighting) {
  const calls = {};
  const context = {
    uniform3fv: (name, value) => { calls.irradiance = Array.from(value); },
    uniform3f: (name, ...values) => { calls[name] = values; },
  };
  const renderer = { context, lighting, environmentResources: { irradiance: new Float32Array(27).fill(0.1) } };
  const uniforms = { 'environmentIrradiance[0]': 'irradiance', environmentBounce: 'bounce', environmentDiffuseFrame: 'frame' };
  CrucibleRenderer.prototype.applyDiffuseUniforms.call(renderer, { rotation: 0, intensity: 2 }, uniforms, true);
  return calls;
}

test('a recipe without ambientColor or a diffuse scale keeps its shape and its uniforms', () => {
  const environment = environmentFor({});
  assert.equal(environment.ambientColor, undefined);
  assert.equal(environment.environmentDiffuseScale, undefined);
  const lighting = updateLightingState(createLightingState(), environment);
  const calls = uploadedUniforms(lighting);
  assert.deepEqual(calls.bounce, [0, 0, 0]);
  assert.deepEqual(calls.frame, [1, 0, 2]);
  assert.equal(calls.irradiance[0], Math.fround(0.1));
});

test('ambientColor stays out of the diffuse light and the diffuse scale multiplies the diffuse light only', () => {
  const environment = environmentFor({ ambientColor: [0.3, 0.2, 0.1], environmentDiffuseScale: 0.5 });
  const lighting = updateLightingState(createLightingState(), environment);
  assert.deepEqual(Array.from(lighting.ambientColor).map(value => Number(value.toFixed(4))), [0.3, 0.2, 0.1]);
  const calls = uploadedUniforms(lighting);
  assert.deepEqual(calls.bounce, [0, 0, 0], 'the fill is not a bounce: adding it to the irradiance lit sunlit ground as well as shadow');
  assert.deepEqual(calls.frame, [1, 0, 1]);
  assert.equal(calls.irradiance[0], Math.fround(0.1));
});

test('ambientColor and environmentDiffuseScale errors name the field and the range', () => {
  assert.throws(() => environmentFor({ ambientColor: [1, 2] }), /environment\.ambientColor.*three numbers/);
  assert.throws(() => environmentFor({ ambientColor: [0.5, 0.5, 11] }), /environment\.ambientColor\[2\]/);
  assert.throws(() => environmentFor({ environmentDiffuseScale: -1 }), /environment\.environmentDiffuseScale/);
});
