import test from 'node:test';
import assert from 'node:assert/strict';
import { effectsNeedingDepth, withDepthForRequestedEffects } from '../src/file-scene-depth.js';

test('a scene file with ambient occlusion and no renderer.depth gets depth on', () => {
  const options = withDepthForRequestedEffects({ lodPixelError: 0.5 }, { ambientOcclusion: 1, ambientOcclusionRadius: 4 });
  assert.equal(options.depth, true);
  assert.equal(options.lodPixelError, 0.5);
});

test('every effect that reads the depth buffer turns depth on, and an explicit renderer.depth false does not undo it', () => {
  const requests = {
    ambientOcclusion: { ambientOcclusion: 0.5 },
    depthOfField: { depthOfField: { blur: 0.4, focusDistance: 3 } },
    motionBlur: { motionBlur: { shutter: 0.5 } },
    sunRays: { sunRays: { intensity: 0.3 } },
  };
  for (const [name, effects] of Object.entries(requests)) {
    assert.deepEqual(effectsNeedingDepth(effects), [name]);
    assert.equal(withDepthForRequestedEffects({ depth: false }, effects).depth, true, name);
  }
  assert.deepEqual(effectsNeedingDepth({ sunRays: {} }), ['sunRays'], 'sun rays default to a non-zero intensity');
});

test('effects that are off, and effects that do not read depth, leave the renderer options alone', () => {
  const options = { depth: false };
  const effects = { ambientOcclusion: 0, depthOfField: { blur: 0 }, motionBlur: { shutter: 0 }, sunRays: { intensity: 0 }, bloom: { strength: 1 }, vignette: 0.2 };
  assert.deepEqual(effectsNeedingDepth(effects), []);
  assert.equal(withDepthForRequestedEffects(options, effects), options);
  assert.equal(withDepthForRequestedEffects(options, undefined), options);
});
