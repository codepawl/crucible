import assert from 'node:assert/strict';
import test from 'node:test';
import { CrucibleRenderer, DEFAULT_TEXTURE_ANISOTROPY, configureTexture } from '../src/renderer.js';

const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const ANISOTROPY_PARAMETER = 34046;
const HARDWARE_LIMIT_PARAMETER = 34047;

function rendererWithHardwareLimit(maxAnisotropy, hardwareLimit) {
  const renderer = Object.create(CrucibleRenderer.prototype);
  const appliedLevels = [];
  renderer.maxAnisotropy = maxAnisotropy;
  renderer.context = {
    TEXTURE_2D: 3553, TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    getExtension: () => ({ TEXTURE_MAX_ANISOTROPY_EXT: ANISOTROPY_PARAMETER, MAX_TEXTURE_MAX_ANISOTROPY_EXT: HARDWARE_LIMIT_PARAMETER }),
    getParameter: () => hardwareLimit,
    texParameteri() {},
    generateMipmap() {},
    texParameterf: (target, name, value) => appliedLevels.push(value),
  };
  return { renderer, appliedLevels };
}

const smoothInfo = { wrapS: 10497, wrapT: 10497, minFilter: LINEAR_MIPMAP_LINEAR, magFilter: LINEAR, mipmaps: true };

test('a floor seen at a grazing angle is filtered 16x anisotropically by default (#2836)', () => {
  assert.equal(DEFAULT_TEXTURE_ANISOTROPY, 16);
  const { renderer, appliedLevels } = rendererWithHardwareLimit(DEFAULT_TEXTURE_ANISOTROPY, 16);
  configureTexture(renderer, smoothInfo);
  assert.deepEqual(appliedLevels, [16]);
});

test('maxAnisotropy lowers the level, and a weaker GPU still caps it', () => {
  const lowered = rendererWithHardwareLimit(4, 16);
  configureTexture(lowered.renderer, smoothInfo);
  assert.deepEqual(lowered.appliedLevels, [4]);
  const weakGpu = rendererWithHardwareLimit(16, 8);
  configureTexture(weakGpu.renderer, smoothInfo);
  assert.deepEqual(weakGpu.appliedLevels, [8]);
});

test('maxAnisotropy rejects values that are not a whole number from 1 to 16', () => {
  for (const maxAnisotropy of [0, 17, 2.5, NaN, '8']) {
    assert.throws(() => new CrucibleRenderer({}, [], { maxAnisotropy }), /maxAnisotropy must be a whole number from 1 to 16, got/);
  }
});
