import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { BLOOM_RADIUS_MAX, BLOOM_STRENGTH_MAX, EFFECT_PRESETS, bloomBlurPlan, resolveEffects } from '../src/effects.js';

test('object motion blur rejects a value outside 0 to 1 instead of ignoring it', () => {
  for (const objects of [-1, NaN, 'strong', 2]) {
    assert.throws(() => resolveEffects({ motionBlur: { objects } }), /Motion blur objects must be between 0 and 1/);
  }
  assert.deepEqual(resolveEffects({ motionBlur: { objects: 0 } }).motionBlur, { shutter: 0 });
  assert.equal(resolveEffects({ motionBlur: { objects: 0.5 } }).motionBlur.objects, 0.5);
});

test('neutral effects preserve the existing image by default', () => {
  assert.deepEqual(resolveEffects(), EFFECT_PRESETS.neutral);
});

test('partial bloom settings retain defaults without changing caller data', () => {
  const settings = { bloom: { strength: 0.4 } };
  const resolved = resolveEffects(settings);
  assert.equal(resolved.bloom.threshold, 1);
  assert.equal(resolved.bloom.strength, 0.4);
  assert.deepEqual(settings, { bloom: { strength: 0.4 } });
  for (const preset of Object.values(EFFECT_PRESETS)) assert.deepEqual(resolveEffects(preset), preset);
});

test('nonfinite or out-of-range effects fail before GPU uniforms are changed', () => {
  for (const settings of [{ saturation: Infinity }, { contrast: 0 }, { temperature: 2 }, { grain: -1 }, { bloom: { radius: NaN } }, { bloom: false }, null]) {
    assert.throws(() => resolveEffects(settings));
  }
});

test('bloom accepts strength up to 8 and radius up to 16 so an emissive part can glow (#3283)', () => {
  const bloom = resolveEffects({ bloom: { strength: 8, radius: 16 } }).bloom;
  assert.equal(bloom.strength, BLOOM_STRENGTH_MAX);
  assert.equal(bloom.radius, BLOOM_RADIUS_MAX);
  assert.throws(() => resolveEffects({ bloom: { strength: 8.5 } }), /Bloom strength must be between 0 and 8\./);
  assert.throws(() => resolveEffects({ bloom: { radius: 16.5 } }), /Bloom radius must be between 0.1 and 16\./);
});

test('bloom defaults stay strength 0, threshold 1, radius 1', () => {
  assert.deepEqual(resolveEffects().bloom, { strength: 0, threshold: 1, radius: 1 });
});

test('a bloom radius the old cap allowed blurs in one pair at its own spacing, a wider one adds bounded pairs', () => {
  for (const radius of [0.1, 1, 1.5, 4]) assert.deepEqual(bloomBlurPlan(radius), { pairs: 1, step: radius });
  assert.equal(bloomBlurPlan(6).pairs, 1);
  const widest = bloomBlurPlan(BLOOM_RADIUS_MAX);
  assert.ok(widest.pairs > 1 && widest.pairs <= 8, `pairs ${widest.pairs}`);
  assert.ok(widest.step <= 6 + 1e-9);
  assert.ok(Math.abs(widest.step * Math.sqrt(widest.pairs) - BLOOM_RADIUS_MAX) < 1e-9, 'blur widths add in quadrature, so the total spread follows the radius');
});

function countBloomBlurDraws(radius) {
  const draws = [];
  const target = name => ({ framebuffer: `${name}-framebuffer`, texture: `${name}-texture` });
  const context = new Proxy({}, {
    get: (_, property) => (property === 'drawArrays' ? () => draws.push(property) : () => {}),
  });
  const renderer = {
    context,
    ensureBloomTargets() {},
    bloomTargets: [target('a'), target('b')],
    bloomProgram: {},
    bloomUniforms: {},
    bloomWidth: 540,
    bloomHeight: 960,
    frameTexture: 'frame',
  };
  CrucibleRenderer.prototype.drawBloom.call(renderer, { strength: 1, threshold: 1, radius }, 'frame');
  return draws.length;
}

test('the renderer draws one blur pair for a radius the old cap allowed and the repeated pairs for radius 16 (#3283)', () => {
  assert.equal(countBloomBlurDraws(1), 2);
  assert.equal(countBloomBlurDraws(4), 2);
  assert.equal(countBloomBlurDraws(BLOOM_RADIUS_MAX), bloomBlurPlan(BLOOM_RADIUS_MAX).pairs * 2);
  assert.ok(countBloomBlurDraws(BLOOM_RADIUS_MAX) > 2);
});
