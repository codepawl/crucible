import assert from 'node:assert/strict';
import test from 'node:test';
import { CrucibleRenderer, DEFAULT_TEXTURE_ANISOTROPY, textureDescriptorInfo } from '../src/renderer.js';
import { createCoverageMips, leafTextureDescriptor } from '../src/vegetation-textures.js';

function rendererRecordingUploads() {
  const renderer = Object.create(CrucibleRenderer.prototype);
  const calls = [];
  renderer.maxAnisotropy = DEFAULT_TEXTURE_ANISOTROPY;
  renderer.textures = new Map();
  renderer.context = {
    RGBA8: 32856, SRGB8_ALPHA8: 35907, MAX_TEXTURE_SIZE: 3379, TEXTURE_2D: 3553,
    getParameter(parameter) { return parameter === this.MAX_TEXTURE_SIZE ? 8192 : 0; },
    getExtension: () => null,
    createTexture: () => ({}), bindTexture() {}, pixelStorei() {}, texParameteri() {}, deleteTexture() {},
    generateMipmap: () => calls.push(['generateMipmap']),
    texImage2D: (target, level, format, width, height) => calls.push(['texImage2D', level, format, width, height]),
  };
  return { renderer, calls };
}

test('a descriptor with its own mip levels uploads them and skips generateMipmap', () => {
  const { renderer, calls } = rendererRecordingUploads();
  const map = leafTextureDescriptor('twig', [70, 110, 40]);
  renderer.createTexture(map);
  const uploadedLevels = calls.filter(call => call[0] === 'texImage2D').map(call => call[1]);
  assert.deepEqual(uploadedLevels, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(calls.find(call => call[1] === 1), ['texImage2D', 1, 35907, 128, 128]);
  assert.deepEqual(calls.at(-1), ['texImage2D', 8, 35907, 1, 1]);
  assert.equal(calls.some(call => call[0] === 'generateMipmap'), false);
});

test('a plain descriptor still generates its mipmaps', () => {
  const { renderer, calls } = rendererRecordingUploads();
  renderer.createTexture({ image: { width: 4, height: 4 }, colorSpace: 'srgb' });
  assert.deepEqual(calls.map(call => call[0]), ['texImage2D', 'generateMipmap']);
});

test('mip levels of the wrong count or size are rejected', () => {
  const base = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
  const levels = createCoverageMips(base).slice(1);
  assert.equal(textureDescriptorInfo({ image: base, mipLevels: levels }).mipLevels, levels);
  assert.throws(() => textureDescriptorInfo({ image: base, mipLevels: levels.slice(1) }), /mipLevels must be every level/);
  assert.throws(() => textureDescriptorInfo({ image: base, mipLevels: [levels[1], levels[0]] }), /mipLevels must be every level/);
});
