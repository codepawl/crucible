import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFragmentSource, FRAGMENT_SOURCE } from '../src/path-tracer-gpu-shader.js';
import { REALTIME_KERNEL_PIECES } from '../src/path-tracer-realtime-webgpu-kernel.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

// Issues #1941: WebGL2, WebGPU (megakernel and wavefront), and realtime WebGPU tracers all write the shared first-hit
// albedo definition (writeFirstHitAlbedo in path-tracer-shading.js) while keeping vec3(1.0) for escaped camera rays.

test('every GPU and WebGPU path tracer kernel defines and uses the shared firstHitAlbedo formula', () => {
  const kernels = [
    ['WebGL2 fragment', FRAGMENT_SOURCE],
    ['WebGL2 realtime', buildFragmentSource({ radianceCache: true })],
    ['WebGPU megakernel', MEGAKERNEL_SOURCE],
    ['WebGPU realtime', buildMegakernelSource({ realtime: REALTIME_KERNEL_PIECES })],
    ['WebGPU wavefront', WAVEFRONT_SOURCE],
  ];
  for (const [name, source] of kernels) {
    assert.match(source, /firstHitAlbedo\(/, `${name} defines firstHitAlbedo`);
    assert.match(source, /schlick\(ratio \* ratio, viewCosine\)/, `${name} computes glass Fresnel from IOR`);
    assert.match(source, /surfaceDiffuse \+ surfaceSpecularWeight \* schlickColor\(surfaceSpecularNormal, surfaceViewCosine\) \+ vec3/, `${name} sums the surface lobe weights`);
    assert.doesNotMatch(source, /isGlass \? vec3\(1\.0\) : hitColor|select\(hitColor, vec3<f32>\(1\.0\), isGlass\)/, `${name} no longer writes the old albedo`);
  }
  assert.match(FRAGMENT_SOURCE, /float albedoTransmission = hitTransmission \* \(1\.0 - hitMetallic\);/);
  assert.match(FRAGMENT_SOURCE, /featureAlbedo = firstHitAlbedo\(normal, -direction, albedoTransmission\);/);
  assert.match(MEGAKERNEL_SOURCE, /featureAlbedo = firstHitAlbedo\(normal, -direction\);/);
  assert.match(WAVEFRONT_SOURCE, /storeVector\(base \+ 4u, vec4<f32>\(firstHitAlbedo\(normal, -direction\), 0\.0\)\);/);
  assert.match(FRAGMENT_SOURCE, /featureAlbedo = vec3\(1\.0\);/);
  assert.match(MEGAKERNEL_SOURCE, /featureAlbedo = vec3<f32>\(1\.0\);/);
  assert.match(WAVEFRONT_SOURCE, /storeVector\(base \+ 4u, vec4<f32>\(1\.0, 1\.0, 1\.0, 0\.0\)\);/);

  // Neither prepareSurface nor firstHitAlbedo draws random numbers, so the path RNG sequence and undenoised beauty stay unchanged.
  for (const [label, source] of [['WebGL2', FRAGMENT_SOURCE], ['WebGPU', MEGAKERNEL_SOURCE]]) {
    const start = source.indexOf('firstHitAlbedo(');
    const body = source.slice(start, source.indexOf('\n}', start) + 2);
    assert.doesNotMatch(body, /nextRandom\(|radiance|throughput/, `${label} firstHitAlbedo stays pure`);
  }
});

async function measureAlbedosOnDevice() {
  const { createEnvironmentMap } = await import('/src/environment.js');
  const { createCamera, renderPathTracedImage } = await import('/src/path-tracer.js');
  const { buildTraceSceneForDevice } = await import('/src/path-tracer-scene.js');
  const webGpuModule = await import('/src/path-tracer-webgpu.js');

  const quad = {
    positions: new Float32Array([-40, 0, -40, 40, 0, -40, 40, 0, 40, -40, 0, 40]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const lookingDown = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
  const lookingUp = { eye: [0, 3, 0], target: [0, 10, 0], up: [0, 0, 1], fov: 40 };
  const size = 16;
  const center = (size / 2) * size + size / 2;
  const sky = { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.4) }) };

  const pixelAt = (albedo, x, y) => [0, 1, 2].map(channel => albedo[(y * size + x) * 3 + channel]);
  const runCase = async (material, camera = lookingDown, environment = {}, samples = 4) => {
    const parts = [{ name: 'floor', geometry: quad, matrix: identity, material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5, ...material } }];
    const baseOptions = { width: size, height: size, samples, bounces: 2, denoise: false, seed: 5 };
    const cpu = await renderPathTracedImage({ parts, environment, camera }, { ...baseOptions, threads: 1, backend: 'cpu' });
    const gpu = await renderPathTracedImage({ parts, environment, camera }, { ...baseOptions, backend: 'gpu' });
    const webgpu = await renderPathTracedImage({ parts, environment, camera }, { ...baseOptions, backend: 'webgpu' });
    const view = createCamera(camera, size, size);
    const traceScene = await buildTraceSceneForDevice(parts, environment, webGpuModule, { eye: view.eye });
    const wavefront = await webGpuModule.traceOnWebGpu(traceScene, view, { ...baseOptions, kernel: 'wavefront', fireflyClamp: 1000 }, () => {});
    return {
      cpu: pixelAt(cpu.features.albedo, 8, 8),
      gpu: pixelAt(gpu.features.albedo, 8, 8),
      webgpu: pixelAt(webgpu.features.albedo, 8, 8),
      wavefront: pixelAt(wavefront.albedo, 8, 8),
      partialPixels: samples === 1 ? [pixelAt(gpu.features.albedo, 4, 4), pixelAt(gpu.features.albedo, 12, 12), pixelAt(webgpu.features.albedo, 4, 4), pixelAt(wavefront.albedo, 12, 12)] : null,
      beauty: { gpu: Array.from(gpu.linear.slice(center * 3, center * 3 + 3)), webgpu: Array.from(webgpu.linear.slice(center * 3, center * 3 + 3)) },
    };
  };

  const beautyMeans = await (async () => {
    const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5], map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.4) }) };
    const half = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 1]);
    const metalMatrix = new Float32Array([0.35, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0.35, 0, -0.8, 0.35, 0, 1]);
    const directParts = [
      { name: 'floor', geometry: quad, matrix: identity, material: { tag: 'surface', color: [0.6, 0.5, 0.4], metallic: 0, roughness: 0.8 } },
      { name: 'coat', geometry: quad, matrix: half, material: { tag: 'surface', color: [0.9, 1, 0.9], metallic: 0, roughness: 0.6, clearcoat: 0.5 } },
    ];
    const mixedParts = [
      directParts[0],
      { name: 'glass', geometry: quad, matrix: half, material: { tag: 'surface', color: [0.9, 1, 0.9], metallic: 0, roughness: 0.1, transmission: 0.7, clearcoat: 0.5 } },
      { name: 'metal', geometry: quad, matrix: metalMatrix, material: { tag: 'surface', color: [0.9, 0.6, 0.3], metallic: 1, roughness: 0.3 } },
    ];
    const camera = { eye: [0, 2, 2.5], target: [0, 0.3, 0], up: [0, 1, 0], fov: 40 };
    const meanOf = async (sceneParts, backend, bounces, samples) => {
      const rendered = await renderPathTracedImage({ parts: sceneParts, environment, camera }, { width: 24, height: 18, samples, bounces, seed: 3, threads: 1, backend, denoise: false });
      let sum = 0;
      for (let index = 0; index < rendered.linear.length; index++) sum += rendered.linear[index];
      return sum / rendered.linear.length;
    };
    return {
      directCpu: await meanOf(directParts, 'cpu', 1, 16),
      directGpu: await meanOf(directParts, 'gpu', 1, 16),
      directWebgpu: await meanOf(directParts, 'webgpu', 1, 16),
      mixedGpu: await meanOf(mixedParts, 'gpu', 4, 8),
      mixedWebgpu: await meanOf(mixedParts, 'webgpu', 4, 8),
    };
  })();

  return {
    matte: await runCase({ color: [0.6, 0.4, 0.2], metallic: 0, roughness: 0.9 }),
    metal: await runCase({ color: [0.9, 0.5, 0.2], metallic: 1, roughness: 0.4 }),
    glass: await runCase({ color: [0.5, 0.8, 1], transmission: 1, roughness: 0.05 }),
    partialTransmission: await runCase({ color: [0.6, 0.6, 0.6], metallic: 0, transmission: 0.5, roughness: 0.3 }, lookingDown, {}, 1),
    clearcoat: await runCase({ color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.9, clearcoat: 1 }),
    metalWithTransmission: await runCase({ color: [0.9, 0.5, 0.2], metallic: 1, transmission: 1, roughness: 0.4 }),
    skyWithEnv: await runCase({}, lookingUp, sky),
    skyWithoutEnv: await runCase({}, lookingUp, {}),
    beautyMeans,
  };
}

function assertChannelsClose(actual, expected, label) {
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-3, `${label} channel ${channel}: ${actual[channel]} vs ${expected[channel]}`);
  }
}

test('WebGL2 and WebGPU (megakernel and wavefront) match CPU first-hit albedo across materials and keep escaped sky at 1', { timeout: 240_000 }, async context => {
  await withWebGpuPage(context, async page => {
    const results = await page.evaluate(measureAlbedosOnDevice);
    for (const name of ['matte', 'metal', 'glass', 'partialTransmission', 'clearcoat', 'metalWithTransmission']) {
      const item = results[name];
      assertChannelsClose(item.gpu, item.cpu, `${name} gpu`);
      assertChannelsClose(item.webgpu, item.cpu, `${name} webgpu`);
      assertChannelsClose(item.wavefront, item.cpu, `${name} wavefront`);
    }
    // Partial transmission at 1 sample has zero stochastic noise across pixels.
    for (const samplePixel of results.partialTransmission.partialPixels) {
      assertChannelsClose(samplePixel, results.partialTransmission.cpu, 'partialTransmission deterministic pixel');
    }
    assertChannelsClose(results.skyWithEnv.gpu, [1, 1, 1], 'skyWithEnv gpu');
    assertChannelsClose(results.skyWithEnv.webgpu, [1, 1, 1], 'skyWithEnv webgpu');
    assertChannelsClose(results.skyWithEnv.wavefront, [1, 1, 1], 'skyWithEnv wavefront');
    assertChannelsClose(results.skyWithoutEnv.gpu, [1, 1, 1], 'skyWithoutEnv gpu');
    assertChannelsClose(results.skyWithoutEnv.webgpu, [1, 1, 1], 'skyWithoutEnv webgpu');
    assertChannelsClose(results.skyWithoutEnv.wavefront, [1, 1, 1], 'skyWithoutEnv wavefront');
    assert.ok(Math.abs(results.beautyMeans.directGpu - results.beautyMeans.directCpu) < 0.02, `gpu direct beauty ${results.beautyMeans.directGpu} vs cpu ${results.beautyMeans.directCpu}`);
    assert.ok(Math.abs(results.beautyMeans.directWebgpu - results.beautyMeans.directCpu) < 0.02, `webgpu direct beauty ${results.beautyMeans.directWebgpu} vs cpu ${results.beautyMeans.directCpu}`);
    assert.ok(Math.abs(results.beautyMeans.mixedGpu - results.beautyMeans.mixedWebgpu) < 0.02, `mixed beauty gpu ${results.beautyMeans.mixedGpu} vs webgpu ${results.beautyMeans.mixedWebgpu}`);
  });
});
