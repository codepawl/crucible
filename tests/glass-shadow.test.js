import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';
import { createDepthFragmentShader } from '../src/shaders.js';
import { glassFaceTransmittance, normalIncidenceReflectance, volumeAbsorption } from '../src/glass-shadow.js';

// #3226: a transmissive part passes the light its faces do not reflect or absorb, so a clear glass ball still throws a shadow.

test('clear glass loses the light its two faces reflect: 4 percent each at index 1.5', () => {
  assert.ok(Math.abs(normalIncidenceReflectance(1.5) - 0.04) < 1e-12);
  const [red, green, blue] = glassFaceTransmittance({ transmission: 1 });
  assert.ok(Math.abs(red - 0.96) < 1e-12);
  assert.ok(Math.abs(red * red - 0.9216) < 1e-12, 'a ball draws two faces');
});

test('a denser glass reflects more, and the index is read from the material', () => {
  assert.ok(glassFaceTransmittance({ transmission: 1, ior: 2.4 })[0] < glassFaceTransmittance({ transmission: 1, ior: 1.2 })[0]);
});

test('tinted glass absorbs by thickness: half per face, so two faces take attenuationColor over the whole thickness', () => {
  const material = { transmission: 1, ior: 1.5, thickness: 1.6, attenuationColor: [1, 0.25, 0.04], attenuationDistance: 1.6 };
  const face = glassFaceTransmittance(material);
  const ball = face.map(channel => channel * channel);
  const wholeThickness = volumeAbsorption([1, 0.25, 0.04], 1.6, 1.6);
  ball.forEach((channel, index) => assert.ok(Math.abs(channel - 0.96 * 0.96 * wholeThickness[index]) < 1e-12));
  assert.ok(face[0] > face[1] && face[1] > face[2], 'red passes most');
});

test('no absorption without a finite attenuation distance or a thickness', () => {
  assert.deepEqual(volumeAbsorption([0.1, 0.1, 0.1], Infinity, 2), [1, 1, 1]);
  assert.deepEqual(volumeAbsorption([0.1, 0.1, 0.1], 1, 0), [1, 1, 1]);
  const thick = glassFaceTransmittance({ transmission: 1, thickness: 3 });
  assert.ok(Math.abs(thick[0] - 0.96) < 1e-12);
});

test('parts without transmission keep white, so blended parts and opaque scenes are untouched', () => {
  assert.deepEqual(glassFaceTransmittance({}), [1, 1, 1]);
  assert.deepEqual(glassFaceTransmittance({ transmission: 0, ior: 2.4, thickness: 2, attenuationColor: [0, 0, 0], attenuationDistance: 1 }), [1, 1, 1]);
});

test('the tint pass multiplies the face transmittance into the light that passes', () => {
  assert.match(createDepthFragmentShader(['tintedShadows']), /tintTransmission \* tintFaceTransmittance \* tintColor/);
});

test('the tint draw hands each glass batch its own face transmittance', () => {
  const calls = [];
  const context = new Proxy({}, {
    get(_, name) {
      if (name === 'checkFramebufferStatus') return () => 1;
      if (name === 'FRAMEBUFFER_COMPLETE') return 1;
      if (name === 'createTexture' || name === 'createFramebuffer') return () => ({});
      if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return 1;
      return (...args) => calls.push([name, ...args]);
    },
  });
  const layerState = new Array(10).fill(0);
  layerState[9] = 1;
  const tinted = { name: 'tinted', transmission: 1, ior: 1.5, thickness: 1.6, attenuationColor: [1, 0.25, 0.04], attenuationDistance: 1.6 };
  const clear = { name: 'clear', transmission: 1 };
  const batches = [tinted, clear].map(material => ({ castShadow: true, tintedShadow: true, layerState, parts: [{ material }] }));
  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, {
    context, batches, renderTargets: new RenderTargetLedger(), world: null, activeLightDirection: [1, 2, 3], shadowBounds: {},
    lightProjection: new Float32Array(16), tintedShadowsActive: true, shadowBiasPerSlope: 0.001,
    depthAlphaUniforms: { tintFaceTransmittance: 'faceTransmittance' }, applyAlphaState() {}, drawBatch() {}, selectShadowInstances: () => null,
  });
  renderer.drawTintedShadows();
  const values = calls.filter(([name, location]) => name === 'uniform3fv' && location === 'faceTransmittance').map(call => [...call[2]]);
  assert.equal(values.length, 2);
  assert.deepEqual(values[0], glassFaceTransmittance(tinted));
  assert.deepEqual(values[1], glassFaceTransmittance(clear));
  assert.ok(values[0][2] < values[1][2]);
});
