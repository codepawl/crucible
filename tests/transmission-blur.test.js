import test from 'node:test';
import assert from 'node:assert/strict';
import { BLUR_IOR_FULL, MINIMUM_BLUR_LEVEL, batchesNeedRefractionMips, iorBlurShare, mipLevelCount, transmissionBlurGlsl, transmissionBlurLevel } from '../src/transmission-blur.js';
import { copySceneIntoMipChain } from '../src/liquid-renderer.js';
import { createFragmentShader, liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';

// Issue #3148: rough glass blurs what it refracts, by reading a blurrier mip level of the opaque scene.

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const glassBatch = (roughness, indexOfRefraction = 1.5, transmission = 1) => ({ layerState: { 9: transmission, 10: indexOfRefraction }, parts: [{ material: { roughness } }] });

test('the blur level is log2 of the larger side times the microfacet width (roughness squared) at glass IOR', () => {
  close(transmissionBlurLevel(0.5, 1.5, 1024, 512), 2.5);
  close(transmissionBlurLevel(1, 2.4, 1024, 512), 10);
  close(transmissionBlurLevel(0.25, 1.5, 512, 1024), 0.625);
});

test('a glTF cornea of roughness 0.076 stays sharp: its blur is far below a mip, where a linear roughness blurred it by three quarters of one', () => {
  const corneaLevel = transmissionBlurLevel(0.0759494, 1.5, 960, 540);
  assert.ok(corneaLevel < 0.1, `the cornea blurs ${corneaLevel} mips`);
  assert.equal(batchesNeedRefractionMips([glassBatch(0.0759494)], 960, 540), false, 'no mip chain for the cornea');
});

test('an index of refraction of 1 gives no blur and the share is capped at the glass index', () => {
  assert.equal(transmissionBlurLevel(1, 1, 1024, 1024), 0);
  close(iorBlurShare(1.25), 0.5);
  close(iorBlurShare(BLUR_IOR_FULL), 1);
  close(iorBlurShare(3), 1);
});

test('the shader clamps roughness to 0.02 before it reads it, so the reference does too', () => {
  close(transmissionBlurLevel(0, 1.5, 1024, 1024), transmissionBlurLevel(0.02, 1.5, 1024, 1024));
  close(transmissionBlurLevel(5, 1.5, 1024, 1024), transmissionBlurLevel(1, 1.5, 1024, 1024));
});

test('a mip chain runs down to one texel', () => {
  assert.equal(mipLevelCount(960, 540), 10);
  assert.equal(mipLevelCount(1, 1), 1);
  assert.equal(mipLevelCount(1024, 1024), 11);
});

test('only glass that is rough enough asks for the mip chain', () => {
  assert.equal(batchesNeedRefractionMips([glassBatch(0.5)], 960, 540), true);
  assert.equal(batchesNeedRefractionMips([glassBatch(0.02)], 960, 540), false, 'a mirror-smooth pane reads the sharp image');
  assert.equal(batchesNeedRefractionMips([glassBatch(0.9, 1)], 960, 540), false, 'an index of 1 does not blur');
  assert.equal(batchesNeedRefractionMips([glassBatch(0.9, 1.5, 0)], 960, 540), false, 'a liquid or foam part has no transmission');
  assert.equal(batchesNeedRefractionMips([], 960, 540), false);
  assert.ok(transmissionBlurLevel(0.02, 1.5, 960, 540) < MINIMUM_BLUR_LEVEL);
});

test('the blur code ships in the liquid program only: the default program text never carries it', () => {
  assert.ok(liquidFragmentSource().includes(transmissionBlurGlsl), 'the liquid program reads the blurred level');
  assert.ok(liquidFragmentSource().includes('textureLod(sceneColor, refracted, blurLevel)'));
  assert.equal(createFragmentShader(new Set()).includes('transmissionBlurLevel'), false);
});

function recordingContext() {
  const calls = [];
  const constants = { TEXTURE_2D: 'TEXTURE_2D', RGBA16F: 'RGBA16F', RGBA8: 'RGBA8', FRAMEBUFFER: 'FRAMEBUFFER', READ_FRAMEBUFFER: 'READ', DRAW_FRAMEBUFFER: 'DRAW', COLOR_ATTACHMENT0: 'COLOR0', COLOR_BUFFER_BIT: 'COLOR', NEAREST: 'NEAREST' };
  let nextId = 0;
  const context = new Proxy({}, {
    get(target, name) {
      if (name in constants) return constants[name];
      if (typeof name !== 'string' || /^[A-Z_0-9]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args]);
        return name.startsWith('create') ? { id: ++nextId, kind: name } : undefined;
      };
    },
  });
  return { context, calls };
}

test('the scene copy builds one mip chain, fills it by blit, and rebuilds it only when the size changes', () => {
  const { context, calls } = recordingContext();
  const renderer = { context, hdr: true, resolveFramebuffer: { id: 'resolve' } };
  const first = copySceneIntoMipChain(renderer, 960, 540);
  const storage = calls.find(call => call[0] === 'texStorage2D');
  assert.deepEqual(storage.slice(1), ['TEXTURE_2D', 10, 'RGBA16F', 960, 540]);
  assert.equal(calls.filter(call => call[0] === 'blitFramebuffer').length, 1);
  assert.equal(calls.filter(call => call[0] === 'generateMipmap').length, 1);
  assert.equal(copySceneIntoMipChain(renderer, 960, 540), first, 'the same size reuses the texture');
  assert.equal(calls.filter(call => call[0] === 'texStorage2D').length, 1);
  assert.equal(calls.filter(call => call[0] === 'generateMipmap').length, 2, 'every frame regenerates the levels');
  const second = copySceneIntoMipChain(renderer, 640, 360);
  assert.notEqual(second, first);
  assert.equal(calls.filter(call => call[0] === 'deleteTexture').length, 1, 'the old chain is freed');
  assert.equal(calls.filter(call => call[0] === 'deleteFramebuffer').length, 1);
});

test('releasing the mip chain frees its texture and framebuffer and clears the renderer slot', () => {
  const { context, calls } = recordingContext();
  const renderer = { context, hdr: false, resolveFramebuffer: { id: 'resolve' } };
  copySceneIntoMipChain(renderer, 320, 200);
  assert.deepEqual(calls.find(call => call[0] === 'texStorage2D').slice(1, 4), ['TEXTURE_2D', 9, 'RGBA8']);
  renderer.refractionChain.release();
  assert.equal(renderer.refractionChain, null);
  assert.equal(calls.filter(call => call[0] === 'deleteTexture').length, 1);
  assert.equal(calls.filter(call => call[0] === 'deleteFramebuffer').length, 1);
});
