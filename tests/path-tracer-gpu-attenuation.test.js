import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import {
  ATTENUATION_TEXELS, packAtlas, packAttenuation, packMaterials, sceneUsesAttenuation,
} from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource, FRAGMENT_SOURCE, MATERIAL_TEXELS } from '../src/path-tracer-gpu-shader.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { traceOnWebGpu, uploadScene } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

// Issue #2230: Beer-Lambert absorption (attenuationColor, attenuationDistance) in the WebGL2 and WebGPU path tracers.

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };

function recordingDevice() {
  const written = new Map();
  return {
    written,
    limits: { maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: ({ label }) => ({ label }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: { writeBuffer: (buffer, offset, bytes) => written.set(buffer.label, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))) },
  };
}

function quad() {
  return {
    positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function occlusionImage(red) {
  return { image: { width: 2, height: 2, data: new Uint8Array(16).fill(red) }, colorSpace: 'linear' };
}

function sceneWith(materials) {
  return buildTraceScene(materials.map((material, index) => ({ name: `part-${index}`, geometry: quad(), material: { color: [1, 1, 1], ...material } })), {});
}

test('sceneUsesAttenuation and packAttenuation encode per-channel extinction and leave plain scenes untouched', () => {
  const plain = sceneWith([{ roughness: 0.5 }]);
  assert.equal(sceneUsesAttenuation(plain.materials), false);
  const absorbing = sceneWith([
    { roughness: 0.5 },
    { transmission: 1, attenuationColor: [0.5, 0.25, 1], attenuationDistance: 1 },
    { transmission: 1, attenuationColor: [0, 1, 1], attenuationDistance: 2 },
  ]);
  assert.equal(sceneUsesAttenuation(absorbing.materials), true);
  assert.equal(ATTENUATION_TEXELS, 1);
  const { data } = packAttenuation(absorbing.materials);
  assert.deepEqual(Array.from(data.subarray(0, 4)), [0, 0, 0, 0]);
  assert.ok(Math.abs(data[4] - Math.log(2)) < 1e-6);
  assert.ok(Math.abs(data[5] - Math.log(4)) < 1e-6);
  assert.equal(data[6], 0);
  assert.equal(data[7], 1);
  assert.equal(data[8], 1e6);
  assert.equal(data[11], 1);
});

test('WebGPU uploadScene appends attenuation after material records (and after occlusion when both are active)', () => {
  const without = recordingDevice();
  const plainScene = sceneWith([{}, {}]);
  uploadScene(without, plainScene);
  const paddedRecords = packMaterials(plainScene.materials, packAtlas([])).data.length;
  assert.equal(without.written.get('materials').length, paddedRecords);

  const onlyAttenuation = recordingDevice();
  uploadScene(onlyAttenuation, sceneWith([{}, { transmission: 1, attenuationColor: [0.5, 1, 1], attenuationDistance: 1 }]));
  const materialFloats = 2 * MATERIAL_TEXELS * 4;
  const attenTable = onlyAttenuation.written.get('materials').subarray(materialFloats, materialFloats + 8);
  assert.equal(attenTable[3], 0);
  assert.ok(Math.abs(attenTable[4] - Math.log(2)) < 1e-6);
  assert.equal(attenTable[7], 1);

  const both = recordingDevice();
  uploadScene(both, sceneWith([{ occlusionMap: occlusionImage(40) }, { transmission: 1, attenuationColor: [0.25, 1, 1], attenuationDistance: 1 }]));
  const afterOcclusion = 2 * (MATERIAL_TEXELS + 2) * 4;
  const bothAtten = both.written.get('materials').subarray(afterOcclusion, afterOcclusion + 8);
  assert.ok(Math.abs(bothAtten[4] - Math.log(4)) < 1e-6);
  assert.equal(bothAtten[7], 1);
});

test('default WebGL2 and WebGPU kernels stay byte-identical and wavefront refuses attenuation', async () => {
  assert.equal(buildFragmentSource({ hasAttenuation: false }), FRAGMENT_SOURCE);
  assert.equal(buildMegakernelSource({ hasAttenuation: false }), MEGAKERNEL_SOURCE);
  assert.doesNotMatch(FRAGMENT_SOURCE, /uAttenuation|absorbingMaterial/);
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /attenuationAt|absorbingMaterial/);
  assert.doesNotMatch(WAVEFRONT_SOURCE, /attenuationAt|absorbingMaterial/);
  assert.match(buildFragmentSource({ hasAttenuation: true }), /uniform sampler2D uAttenuation;/);
  const wgslBoth = buildMegakernelSource({ hasOcclusionMap: true, hasAttenuation: true });
  assert.match(wgslBoth, /fn attenuationAt\(materialIndex: i32\) -> vec4<f32>/);
  assert.match(wgslBoth, /\(MATERIAL_TEXELS \+ 2\) \+ materialIndex/);

  const scene = sceneWith([{ transmission: 1, attenuationColor: [0.5, 0.5, 0.5], attenuationDistance: 1 }]);
  await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volumetric absorption/);
});

async function measureAttenuationOnDevice() {
  const { box: boxGeometry } = await import('/src/geometry.js');
  const { createEnvironmentMap } = await import('/src/environment.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');

  const slabMatrix = thickness => new Float32Array([8, 0, 0, 0, 0, 8, 0, 0, 0, 0, thickness, 0, 0, 0, 0, 1]);
  const environment = { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(1) }) };
  const camera = { eye: [0, 0, 6], target: [0, 0, 0], up: [0, 1, 0], fov: 10 };
  const slabScene = (thickness, extra = {}) => ({
    parts: [{
      name: 'slab',
      geometry: boxGeometry(0, 1),
      matrix: slabMatrix(thickness),
      material: { tag: 'surface', metallic: 0, roughness: 0, emission: 0, color: [1, 1, 1], transmission: 1, ior: 1, ...extra },
    }],
    environment,
    camera,
  });
  const meanRgb = (linear) => {
    const mean = [0, 0, 0];
    const pixels = linear.length / 3;
    for (let pixel = 0; pixel < pixels; pixel++) {
      for (let channel = 0; channel < 3; channel++) mean[channel] += linear[pixel * 3 + channel] / pixels;
    }
    return mean;
  };
  const options = { width: 16, height: 16, samples: 1, bounces: 4, seed: 1, denoise: false, fireflyClamp: 1000, threads: 1 };
  const absorbing = { attenuationColor: [0.5, 0.25, 1], attenuationDistance: 1 };

  const out = {};
  for (const backend of ['cpu', 'gpu', 'webgpu']) {
    out[backend] = {
      thin: meanRgb((await renderPathTracedImage(slabScene(0.1, absorbing), { ...options, backend })).linear),
      deep: meanRgb((await renderPathTracedImage(slabScene(2, absorbing), { ...options, backend })).linear),
      clear: meanRgb((await renderPathTracedImage(slabScene(2, {}), { ...options, backend })).linear),
    };
  }

  // Deep water body over a white floor under a uniform white sky + combined occlusionMap check on WebGPU.
  const floorGeometry = {
    positions: new Float32Array([-20, 0, 20, 20, 0, 20, 20, 0, -20, -20, 0, -20]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const waterParts = [
    { name: 'floor', geometry: floorGeometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2.5, 0, 1]), material: { tag: 'surface', color: [0.9, 0.9, 0.9], metallic: 0, roughness: 0.9, occlusionMap: { image: { width: 2, height: 2, data: new Uint8Array(16).fill(255) }, colorSpace: 'linear' } } },
    { name: 'water', geometry: boxGeometry(0, 1), matrix: new Float32Array([20, 0, 0, 0, 0, 2, 0, 0, 0, 0, 20, 0, 0, -1.2, 0, 1]), material: { tag: 'water', color: [0.02, 0.2, 0.25], roughness: 0.02, absorption: [1.5, 0.2, 0.05], turbidity: 0.1 } },
  ];
  const waterCamera = { eye: [0, 2.5, 0.01], target: [0, -2, 0], up: [0, 0, -1], fov: 40 };
  const waterOpts = { width: 16, height: 16, samples: 16, bounces: 6, seed: 2, denoise: false, threads: 1 };
  out.water = {
    gpu: meanRgb((await renderPathTracedImage({ parts: waterParts, environment, camera: waterCamera }, { ...waterOpts, backend: 'gpu' })).linear),
    webgpu: meanRgb((await renderPathTracedImage({ parts: waterParts, environment, camera: waterCamera }, { ...waterOpts, backend: 'webgpu' })).linear),
  };
  return out;
}

test('WebGL2 and WebGPU match CPU Beer-Lambert absorption for glass slabs and tint deep water bodies', { timeout: 240_000 }, async context => {
  await withWebGpuPage(context, async page => {
    const results = await page.evaluate(measureAttenuationOnDevice);
    for (const backend of ['cpu', 'gpu', 'webgpu']) {
      const { thin, deep, clear } = results[backend];
      assert.ok(deep[0] < thin[0] * 0.5, `${backend} 2 m red (${deep[0]}) < 0.5 * 0.1 m red (${thin[0]})`);
      assert.ok(deep[1] < thin[1] * 0.1, `${backend} 2 m green (${deep[1]}) < 0.1 * 0.1 m green (${thin[1]})`);
      assert.ok(Math.abs(deep[2] - thin[2]) < 1e-3, `${backend} unabsorbed blue unchanged`);
      assert.ok(Math.abs(deep[0] - 0.25) < 0.01, `${backend} red 0.5^2 = 0.25, got ${deep[0]}`);
      assert.ok(Math.abs(deep[1] - 0.0625) < 0.01, `${backend} green 0.25^2 = 0.0625, got ${deep[1]}`);
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(clear[channel] - results.cpu.clear[channel]) < 1e-3, `${backend} clear slab matches CPU`);
      }
    }
    for (const backend of ['gpu', 'webgpu']) {
      const water = results.water[backend];
      assert.ok(water[2] > water[0] * 2, `${backend} deep water keeps far more blue (${water[2]}) than red (${water[0]})`);
      assert.ok(water[1] > water[0] * 1.5, `${backend} deep water keeps more green (${water[1]}) than red (${water[0]})`);
    }
  });
});
