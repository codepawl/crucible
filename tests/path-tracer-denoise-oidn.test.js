import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { decodePfm, denoiseWithOidn, encodePfm, findOidnBinary } from '../src/denoise-oidn.js';
import { PATH_TRACER_CAPABILITIES, PATH_TRACER_DENOISERS as JOB_DENOISERS } from '../src/path-tracer-capabilities.js';
import { normalizePathTracerOptions, PATH_TRACER_DENOISERS, renderPathTracedImage } from '../src/path-tracer.js';
import { chooseDenoiser } from '../scripts/agent-path-trace-denoise.mjs';
import { budgetCandidates } from '../scripts/agent-render-budget.mjs';
import { FINAL_TIER_RENDERER } from '../scripts/agent-render-quality.mjs';

test('denoise takes a boolean or a name and keeps the boolean the tracer reports', () => {
  assert.equal(normalizePathTracerOptions({}).denoiser, 'wavelet');
  assert.equal(normalizePathTracerOptions({ denoise: false }).denoiser, 'none');
  for (const name of PATH_TRACER_DENOISERS) {
    const options = normalizePathTracerOptions({ denoise: name });
    assert.equal(options.denoiser, name);
    assert.equal(options.denoise, name !== 'none');
  }
  assert.deepEqual([...JOB_DENOISERS], [...PATH_TRACER_DENOISERS]);
  assert.throws(() => normalizePathTracerOptions({ denoise: 'bm3d' }), /denoise must be/);
  assert.throws(() => normalizePathTracerOptions({ denoise: 1 }), /denoise must be/);
});

test('denoise "oidn" leaves the colour as traced and returns the feature images for the caller', async () => {
  const quad = { name: 'floor', geometry: { positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) },
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5 } };
  const scene = { parts: [quad], environment: {}, camera: { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 } };
  const options = { width: 16, height: 16, samples: 4, bounces: 1, threads: 1 };
  const external = await renderPathTracedImage(scene, { ...options, denoise: 'oidn' });
  const none = await renderPathTracedImage(scene, { ...options, denoise: false });
  assert.deepEqual(external.linear, none.linear);
  assert.equal(external.report.denoiser, 'oidn');
  assert.equal(external.report.denoised, false);
  assert.equal(external.features.albedo.length, 16 * 16 * 3);
  assert.equal(external.features.normal.length, 16 * 16 * 3);
});

test('a job that asks for oidn without the binary runs the wavelet filter and says why', async context => {
  const saved = process.env.OIDN_DENOISE_PATH;
  process.env.OIDN_DENOISE_PATH = 'does-not-exist/oidnDenoise';
  context.after(() => {
    if (saved === undefined) delete process.env.OIDN_DENOISE_PATH;
    else process.env.OIDN_DENOISE_PATH = saved;
  });
  const choice = await chooseDenoiser('oidn');
  assert.equal(choice.denoise, 'wavelet');
  assert.match(choice.note, /oidn.*needs the OIDN binary.*crucible-oidn-fetch.*wavelet filter ran instead/s);
  const defaultChoice = await chooseDenoiser(true);
  assert.equal(defaultChoice.denoise, 'wavelet');
  assert.match(defaultChoice.note, /denoise true uses OIDN.*crucible-oidn-fetch.*wavelet filter ran instead/s);
  await assert.rejects(denoiseWithOidn({ width: 1, height: 1, color: new Float32Array(3), albedo: new Float32Array(3), normal: new Float32Array(3) }), /not installed/);
});

test('PFM files keep the pixels and store rows bottom to top', () => {
  const pixels = Float32Array.from({ length: 4 * 3 * 3 }, (_, index) => index / 7);
  const bytes = encodePfm(pixels, 4, 3);
  assert.equal(bytes.toString('latin1', 0, 12), 'PF\n4 3\n-1.0\n');
  const firstStoredRow = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 12, bytes.byteOffset + 12 + 48));
  assert.deepEqual(firstStoredRow, pixels.subarray(24, 36));
  assert.deepEqual(decodePfm(bytes, 4, 3), pixels);
  assert.throws(() => decodePfm(bytes, 5, 3), /not the expected/);
});

test('decodePfm refuses a truncated pixel body and names both sizes', () => {
  const pixels = Float32Array.from({ length: 4 * 3 * 3 }, (_, index) => index / 7);
  const bytes = encodePfm(pixels, 4, 3);
  const truncated = bytes.subarray(0, bytes.length - 4);
  assert.throws(() => decodePfm(truncated, 4, 3), /truncated PFM: 140 pixel bytes for 4 x 3, expected 144/);
  assert.deepEqual(decodePfm(bytes, 4, 3), pixels);
});

test('the installed OIDN removes noise from a flat image and gives the same bytes twice', { skip: findOidnBinary() ? false : 'the oidnDenoise binary is not fetched' }, async () => {
  assert.ok(existsSync(findOidnBinary()));
  const width = 64;
  const height = 64;
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const color = Float32Array.from({ length: width * height * 3 }, () => 0.5 + (random() - 0.5) * 0.4);
  const albedo = new Float32Array(width * height * 3).fill(0.8);
  const normal = Float32Array.from({ length: width * height * 3 }, (_, index) => (index % 3 === 1 ? 1 : 0));
  const spread = values => Math.max(...values) - Math.min(...values);
  const first = await denoiseWithOidn({ width, height, color, albedo, normal });
  const second = await denoiseWithOidn({ width, height, color, albedo, normal });
  assert.ok(spread(first) < spread(color), `spread ${spread(first)} against ${spread(color)}`);
  assert.deepEqual(first, second);
});

test('denoise true picks OIDN on every backend when it is installed and says which filter ran when it is not', async () => {
  const installed = { findOidnBinary: () => 'oidn' };
  for (const native of [false, true]) {
    const withOidn = await chooseDenoiser(true, { native, loadOidn: async () => installed });
    assert.equal(withOidn.denoise, 'oidn');
    assert.equal(withOidn.denoiser, installed);
    assert.equal(withOidn.note, undefined, 'a filter that ran as asked is not a fallback, so it carries no note');
  }
  const withoutOnCpuOrGpu = await chooseDenoiser(true, { loadOidn: async () => null });
  assert.equal(withoutOnCpuOrGpu.denoise, 'wavelet');
  assert.match(withoutOnCpuOrGpu.note, /denoise true uses OIDN, which needs the OIDN binary.*crucible-oidn-fetch.*wavelet filter ran instead/s);
  const withoutOnNative = await chooseDenoiser(true, { native: true, loadOidn: async () => null });
  assert.equal(withoutOnNative.denoise, 'atrous');
  assert.match(withoutOnNative.note, /GPU a-trous filter ran instead/);
  const explicit = await chooseDenoiser('oidn', { native: true, loadOidn: async () => null });
  assert.equal(explicit.denoise, 'atrous');
  assert.match(explicit.note, /denoise "oidn".*GPU a-trous filter ran instead/s);
  assert.equal((await chooseDenoiser('oidn', { loadOidn: async () => null })).denoise, 'wavelet');
});

test('the final tier keeps the wavelet filter when OIDN is missing, also on native', async () => {
  const missing = await chooseDenoiser(FINAL_TIER_RENDERER.denoise, { native: true, keepWavelet: true, loadOidn: async () => null });
  assert.equal(missing.denoise, 'wavelet');
  assert.match(missing.note, /wavelet filter ran instead/);
  const installed = { findOidnBinary: () => 'oidn' };
  assert.equal((await chooseDenoiser(FINAL_TIER_RENDERER.denoise, { native: true, keepWavelet: true, loadOidn: async () => installed })).denoise, 'oidn');
});

test('the final tier and every budget path tracer candidate ask for denoise true, which means OIDN when installed', () => {
  assert.equal(FINAL_TIER_RENDERER.denoise, true);
  const candidates = budgetCandidates({ kind: 'image', width: 640, height: 360 }, 'gpu').filter(candidate => candidate.tier === 'final');
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) assert.equal(candidate.settings.renderer.denoise, true);
});

test('explicit denoise values keep their meaning on every backend and never load OIDN', async () => {
  const loadOidn = async () => { throw new Error('must not load OIDN'); };
  for (const native of [false, true]) {
    assert.deepEqual(await chooseDenoiser(false, { native, loadOidn }), { denoise: false });
    assert.deepEqual(await chooseDenoiser('wavelet', { native, loadOidn }), { denoise: 'wavelet' });
    assert.deepEqual(await chooseDenoiser('none', { native, loadOidn }), { denoise: 'none' });
  }
});

test('a source checkout finds the fetched OIDN package without it being installed under node_modules', { skip: findOidnBinary() ? false : 'the oidnDenoise binary is not fetched' }, async () => {
  const choice = await chooseDenoiser('oidn');
  assert.equal(choice.denoise, 'oidn');
  assert.equal(typeof choice.denoiser.denoiseWithOidn, 'function');
});

test('the job capability text says how to fetch the OIDN binary and what runs without it', () => {
  const { setting } = PATH_TRACER_CAPABILITIES;
  assert.match(setting, /denoise true \(the default\) and "oidn" use OIDN when its binary is installed/);
  assert.match(setting, /final quality tier/);
  assert.match(setting, /crucible-oidn-fetch/);
  assert.match(setting, /wavelet filter.*denoiserNote/s);
});

test('denoiseWithOidn refuses buffers that do not match width x height and missing guide images', async () => {
  const image = new Float32Array(2 * 2 * 3);
  const good = { width: 2, height: 2, color: image, albedo: image, normal: image };
  await assert.rejects(denoiseWithOidn({ ...good, width: 3 }), /color holds 12 floats.*3 x 2 pixels need 18/);
  await assert.rejects(denoiseWithOidn({ ...good, normal: new Float32Array(9) }), /normal holds 9 floats/);
  await assert.rejects(denoiseWithOidn({ ...good, albedo: undefined }), /albedo must be a Float32Array/);
  await assert.rejects(denoiseWithOidn({ ...good, height: 0 }), /height must be a whole number/);
});
