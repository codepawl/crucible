import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildCopyScene } from '../bench/instancing/copies-scene.mjs';
import { createEnvironmentMap } from '../src/environment.js';
import { renderPathTracedImage } from '../src/path-tracer.js';

// The albedo guide of the CPU tracer is the definition Cook's `cycles` kernel writes (#1941), except 1 for a ray that finds
// nothing, where Cook writes the clamped sky: the sum of the lobe weights (diffuse, plus specular and coat times Fresnel) at the first
// surface, and a glass lobe adding its Fresnel reflection plus the base colour times the rest.

const QUAD = {
  positions: new Float32Array([-40, 0, -40, 40, 0, -40, 40, 0, 40, -40, 0, 40]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
};
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const LOOKING_UP = { eye: [0, 3, 0], target: [0, 10, 0], up: [0, 0, 1], fov: 40 };
const SIZE = 16;
const SMALL = { width: SIZE, height: SIZE, samples: 4, bounces: 2, threads: 1, denoise: false, seed: 5 };
const CENTER = (SIZE / 2) * SIZE + SIZE / 2;
// The reflectance of glass at normal incidence, ((ior - 1) / (ior + 1)) squared, for the default ior of 1.5.
const GLASS_NORMAL_REFLECTANCE = 0.04;

function constantSky(value) {
  return createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(value) });
}

async function centerAlbedo(material, environment = { skyColor: [0.5, 0.5, 0.5] }) {
  const part = { name: 'floor', geometry: QUAD, matrix: IDENTITY, material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5, ...material } };
  const result = await renderPathTracedImage({ parts: [part], environment, camera: LOOKING_DOWN }, SMALL);
  return [0, 1, 2].map(channel => result.features.albedo[CENTER * 3 + channel]);
}

function assertClose(actual, expected, label) {
  actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 1e-3, `${label} channel ${channel}: ${value} is not ${expected[channel]}`));
}

test('a ray that escapes writes 1 whatever the sky, and 0 without an environment', async () => {
  const part = { name: 'floor', geometry: QUAD, matrix: IDENTITY, material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5 } };
  const albedoOf = async environment => (await renderPathTracedImage({ parts: [part], environment, camera: LOOKING_UP }, SMALL)).features.albedo[CENTER * 3];
  assert.equal(await albedoOf({ map: constantSky(0.4) }), 1);
  assert.equal(await albedoOf({ map: constantSky(0) }), 1);
  assert.equal(await albedoOf({ map: constantSky(3) }), 1);
  assert.equal(await albedoOf({}), 0);
});

test('a metal writes its reflectivity at normal incidence', async () => {
  assertClose(await centerAlbedo({ metallic: 1, roughness: 0.4, color: [0.9, 0.5, 0.2] }), [0.9, 0.5, 0.2], 'metal');
});

test('glass writes the Fresnel blend of its reflected share and its colour, not 1', async () => {
  const color = [0.5, 0.8, 1];
  const expected = color.map(channel => GLASS_NORMAL_REFLECTANCE + channel * (1 - GLASS_NORMAL_REFLECTANCE));
  assertClose(await centerAlbedo({ transmission: 1, roughness: 0.05, color }), expected, 'glass');
});

test('a part with transmission blends the surface lobes and the glass lobe by that share, without noise from the glass choice', async () => {
  const color = [0.6, 0.6, 0.6];
  const glass = GLASS_NORMAL_REFLECTANCE + color[0] * (1 - GLASS_NORMAL_REFLECTANCE);
  const [opaque] = await centerAlbedo({ metallic: 0, transmission: 0, roughness: 0.3, color });
  const expected = 0.5 * opaque + 0.5 * glass;
  assertClose(await centerAlbedo({ metallic: 0, transmission: 0.5, roughness: 0.3, color }), [expected, expected, expected], 'half glass dielectric');
});

test('a metal does not transmit: transmission scales by one minus metallic (#2827)', async () => {
  const color = [0.9, 0.5, 0.2];
  const opaqueMetal = await centerAlbedo({ metallic: 1, transmission: 0, roughness: 0.4, color });
  assertClose(await centerAlbedo({ metallic: 1, transmission: 1, roughness: 0.4, color }), opaqueMetal, 'metal with full transmission');
  // At metallic 0.5 half of the transmission is left: the albedo is half the opaque surface and half the glass lobe.
  const opaqueHalfMetal = await centerAlbedo({ metallic: 0.5, transmission: 0, roughness: 0.4, color });
  const glass = color.map(channel => GLASS_NORMAL_REFLECTANCE + channel * (1 - GLASS_NORMAL_REFLECTANCE));
  const expected = opaqueHalfMetal.map((channel, index) => 0.5 * channel + 0.5 * glass[index]);
  assertClose(await centerAlbedo({ metallic: 0.5, transmission: 1, roughness: 0.4, color }), expected, 'half metal with full transmission');
});

test('a metal with transmission renders the same picture as the metal without it, and glass still lets the sky through (#2827)', async () => {
  const meanOf = async material => {
    const part = { name: 'floor', geometry: QUAD, matrix: IDENTITY, material: { tag: 'surface', color: [0.9, 0.5, 0.2], metallic: 0, roughness: 0.4, ...material } };
    const result = await renderPathTracedImage({ parts: [part], environment: { map: constantSky(0.5) }, camera: LOOKING_DOWN }, SMALL);
    return Array.from(result.linear).reduce((sum, value) => sum + value, 0) / result.linear.length;
  };
  const opaqueMetal = await meanOf({ metallic: 1, transmission: 0 });
  assert.equal(await meanOf({ metallic: 1, transmission: 1 }), opaqueMetal);
  assert.notEqual(await meanOf({ metallic: 0, transmission: 1 }), await meanOf({ metallic: 0, transmission: 0 }));
});

test('a matte dielectric writes its diffuse colour plus the specular layer on top, and a clear coat adds its share', async () => {
  const [plain] = await centerAlbedo({ roughness: 1, color: [0.5, 0.5, 0.5] });
  const [coated] = await centerAlbedo({ roughness: 1, color: [0.5, 0.5, 0.5], clearcoat: 1 });
  assert.ok(plain > 0.5 * 0.9 && plain < 0.6, `matte albedo ${plain}`);
  assert.ok(coated < plain + GLASS_NORMAL_REFLECTANCE && coated > plain - 0.05, `coated albedo ${coated} against ${plain}`);
});

// The 200-copy scene of tests/native-albedo-reference.test.js. Cook's albedo sum on it is 2489.36 on an RTX 3060 (Vulkan, Cook 0.2.0).
// The CPU tracer's sum is pinned as it is now; it sits about 2 percent above Cook's (1.9 at 16 samples, 2.1 at 64), most likely because Cook's layering uses multiple-scatter GGX
// lookup tables for the specular albedo and the CPU tracer uses an analytic fit. Before #1941 it was 35045.9 (+1308 percent).
const COOK_REFERENCE_ALBEDO_SUM = 2489.3600443217438;
const CPU_ALBEDO_SUM_AT_16_SAMPLES = 2536.6155550964177;

test('the CPU albedo sum of the 200-copy scene is pinned and within 3 percent of the sum Cook writes', async () => {
  const { parts, environment } = buildCopyScene('emissive', 200);
  const camera = { eye: [0, 0, 14], target: [0, 0, -3], fov: 50 };
  const result = await renderPathTracedImage({ parts, environment, camera }, { width: 128, height: 96, samples: 16, seed: 1, denoise: false, noiseThreshold: 0, threads: 1 });
  let sum = 0;
  for (const value of result.features.albedo) sum += value;
  assert.ok(Math.abs(sum - CPU_ALBEDO_SUM_AT_16_SAMPLES) / CPU_ALBEDO_SUM_AT_16_SAMPLES < 1e-6, `CPU albedo sum ${sum}`);
  assert.ok(Math.abs(sum - COOK_REFERENCE_ALBEDO_SUM) / COOK_REFERENCE_ALBEDO_SUM < 0.03, `CPU albedo sum ${sum} against Cook's ${COOK_REFERENCE_ALBEDO_SUM}`);
});

// The albedo only feeds the denoisers, so an undenoised picture must not move. This hash was taken on origin/main before #1941.
// Re-recorded for #2318: the sun's shadow ray now passes through the glass part, which lights the floor under it.
test('the undenoised beauty is byte for byte what it was before the albedo definition changed', async () => {
  const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5], map: constantSky(0.4) };
  const parts = [
    { name: 'floor', geometry: QUAD, matrix: IDENTITY, material: { tag: 'surface', color: [0.6, 0.5, 0.4], metallic: 0, roughness: 0.8 } },
    { name: 'glass', geometry: QUAD, matrix: new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 1]), material: { tag: 'surface', color: [0.9, 1, 0.9], metallic: 0, roughness: 0.1, transmission: 0.7, clearcoat: 0.5 } },
  ];
  const camera = { eye: [0, 2, 2.5], target: [0, 0.3, 0], up: [0, 1, 0], fov: 40 };
  const result = await renderPathTracedImage({ parts, environment, camera }, { width: 24, height: 18, samples: 8, bounces: 4, seed: 3, threads: 1, denoise: false });
  const hash = createHash('sha256').update(Buffer.from(result.linear.buffer, result.linear.byteOffset, result.linear.byteLength)).digest('hex');
  assert.equal(hash, 'd7e3507874276f02e8eeaee00007266b6606f8a6572a2446af09e64d4d7722d3');
});
