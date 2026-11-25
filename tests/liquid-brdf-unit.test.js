import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { copySceneIntoMipChain, resolveSceneDepth } from '../src/liquid-renderer.js';

function mockWebglContext() {
  let activeUnit = 0x84C0;
  let nextId = 1;
  const boundByUnit = new Map();
  return {
    TEXTURE0: 0x84C0,
    TEXTURE_2D: 0x0DE1,
    RGBA16F: 0x881A,
    RGBA8: 0x8058,
    DEPTH_COMPONENT24: 0x81A6,
    DEPTH_COMPONENT32F: 0x8CAC,
    DEPTH_COMPONENT: 0x1902,
    UNSIGNED_INT: 0x1405,
    FLOAT: 0x1406,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    FRAMEBUFFER: 0x8D40,
    READ_FRAMEBUFFER: 0x8CA8,
    DRAW_FRAMEBUFFER: 0x8CA9,
    COLOR_ATTACHMENT0: 0x8CE0,
    DEPTH_ATTACHMENT: 0x8D00,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    activeTexture(unit) {
      activeUnit = unit;
    },
    currentActiveUnit() {
      return activeUnit;
    },
    bindTexture(target, texture) {
      if (target === this.TEXTURE_2D) boundByUnit.set(activeUnit, texture);
    },
    boundTextureAt(unit) {
      return boundByUnit.get(unit);
    },
    createTexture: () => ({ id: nextId++ }),
    deleteTexture() {},
    texStorage2D() {},
    texImage2D() {},
    texParameteri() {},
    createFramebuffer: () => ({ id: nextId++ }),
    deleteFramebuffer() {},
    bindFramebuffer() {},
    framebufferTexture2D() {},
    blitFramebuffer() {},
    generateMipmap() {},
  };
}

test('bindEnvironmentTextures leaves TEXTURE0 active after binding specular and BRDF units', () => {
  const context = mockWebglContext();
  const specularTexture = { id: 'spec' };
  const brdfTexture = { id: 'brdf' };
  CrucibleRenderer.prototype.bindEnvironmentTextures.call({ context }, specularTexture, brdfTexture);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 9), specularTexture);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 10), brdfTexture);
  assert.equal(context.currentActiveUnit(), context.TEXTURE0);
});

test('copySceneIntoMipChain and resolveSceneDepth preserve TEXTURE10 when allocation or reuse runs', () => {
  const context = mockWebglContext();
  const brdfTexture = { id: 'brdf-lut' };
  context.activeTexture(context.TEXTURE0 + 10);
  context.bindTexture(context.TEXTURE_2D, brdfTexture);
  const renderer = {
    context,
    hdr: true,
    reversedDepth: false,
    multisampleFramebuffer: { id: 'msaa' },
    resolveFramebuffer: { id: 'resolve' },
    renderTargets: { record() {}, release() {} },
  };
  // Initial allocations while unit 10 is active must switch to TEXTURE0 and keep TEXTURE10 untouched.
  copySceneIntoMipChain(renderer, 64, 64);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 10), brdfTexture);
  assert.equal(context.currentActiveUnit(), context.TEXTURE0);

  context.activeTexture(context.TEXTURE0 + 10);
  resolveSceneDepth(renderer, 64, 64);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 10), brdfTexture);
  assert.equal(context.currentActiveUnit(), context.TEXTURE0);

  // Reuse paths on later frames must also switch away from TEXTURE10 before binding.
  context.activeTexture(context.TEXTURE0 + 10);
  copySceneIntoMipChain(renderer, 64, 64);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 10), brdfTexture);

  context.activeTexture(context.TEXTURE0 + 10);
  resolveSceneDepth(renderer, 64, 64);
  assert.equal(context.boundTextureAt(context.TEXTURE0 + 10), brdfTexture);
});
