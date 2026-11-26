import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { icoSphere } from '../src/geometry.js';
import { packNodes } from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, buildTraceSceneForDevice, isInstancedScene } from '../src/path-tracer-scene.js';
import { WEBGPU_INSTANCE_VECTORS } from '../src/path-tracer-webgpu-instancing.js';
import { buildMegakernelSource, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { prepareRealtimeKernel, supportsInstancing, traceOnWebGpu, uploadScene } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

// Issue #2239: the WebGPU megakernel keeps copies of one mesh as instances (one triangle table and bottom-level BVH per mesh, a
// top-level BVH over the copies, the records in the node buffer) instead of flattening every copy into the triangle table.

const SPHERE = icoSphere(2);
const SPHERE_TRIANGLES = SPHERE.indices.length / 3;
const LIMIT = 4 * SPHERE_TRIANGLES;

function translation(x, y = 0, z = 0) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function copies(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `copy-${index}`,
    geometry: SPHERE,
    matrix: translation(index * 3, 0.5, -index),
    material: { color: [0.2 + index * 0.1, 0.5, 0.7], roughness: 0.4 },
  }));
}

// Node has no WebGPU constants; the recording device ignores them.
globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };

function digestOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

// A device that keeps what is written to each buffer, so the tables the tracer uploads can be read back without a GPU.
function recordingDevice(maxStorageBufferBindingSize = 1 << 30) {
  const written = new Map();
  return {
    written,
    limits: { maxStorageBufferBindingSize },
    createBuffer: ({ label }) => ({ label }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: { writeBuffer: (buffer, offset, bytes) => written.set(buffer.label, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))) },
  };
}

// The digests of the default megakernel, the texel megakernel and the wavefront WGSL, taken on origin/main before instancing existed
// updated for the lamp-mesh shadow pass-through (#2353), for the flat camera background of world false (#2016) and for metals that do not transmit (#2827).
// A scene without shared geometry compiles exactly this text. Change them only with an intended change of the flat kernel.
// All three moved for the emission Fresnel line of fillHit (#3282) and the camera-visible analytic sun disc in addEscape (#2164); nothing else in the flat kernels changed.
const FLAT_MEGAKERNEL_DIGEST = '22a2d64905daba60';
const FLAT_TEXEL_KERNEL_DIGEST = 'c7234d5cce1cc8f1';
const FLAT_WAVEFRONT_DIGEST = '0d456b8b4c43905b';

test('a scene without shared geometry compiles the WGSL origin/main compiled', () => {
  assert.equal(digestOf(buildMegakernelSource()).slice(0, 16), FLAT_MEGAKERNEL_DIGEST);
  assert.equal(digestOf(buildMegakernelSource({ texelBake: true })).slice(0, 16), FLAT_TEXEL_KERNEL_DIGEST);
  assert.equal(digestOf(WAVEFRONT_SOURCE).slice(0, 16), FLAT_WAVEFRONT_DIGEST);
  assert.equal(buildMegakernelSource({ instanced: false }), buildMegakernelSource());
  assert.doesNotMatch(buildMegakernelSource(), /instanceRecord|nearestInstance|traceInstance/);
});

test('the instanced kernel walks the bottom-level BVH of each copy and moves the hit to the world', () => {
  for (const variant of [{}, { texelBake: true }, { hasSubsurface: true, hasVolume: true }]) {
    const source = buildMegakernelSource({ ...variant, instanced: true });
    assert.match(source, /fn traceInstance\(/);
    assert.match(source, /surfaceVectorToWorld\(triangles\[base \+ 1\]\.xyz\)/);
    assert.match(source, /normalToWorld\(normalOneData\.xyz\)/);
    assert.match(source, /hitMaterialIndex = nearestMaterial;/);
    assert.doesNotMatch(source, /i32\(triangles\[nearestSlot \* TRIANGLE_TEXELS\]\.w\)/, 'the material comes from the instance, not the triangle');
  }
});

test('an instanced scene uploads each mesh once, with its instance records behind the nodes', () => {
  const scene = buildTraceScene(copies(3), {}, { instancing: true, gpuTriangleLimit: LIMIT });
  assert.equal(isInstancedScene(scene), true);
  const device = recordingDevice();
  const uploaded = uploadScene(device, scene);
  const nodes = device.written.get('bvh nodes');
  const triangles = device.written.get('triangles');
  const flatTriangles = recordingDevice();
  uploadScene(flatTriangles, buildTraceScene(copies(3), {}));
  assert.ok(triangles.length < flatTriangles.written.get('triangles').length, 'one mesh, not three copies');
  const header = uploaded.instanceHeader * 4;
  assert.ok(header > 0 && nodes[header] > 0, 'the header names a top-level root behind the bottom-level nodes');
  const records = nodes.subarray(header + 4, header + 4 + 3 * WEBGPU_INSTANCE_VECTORS * 4);
  const roots = new Set();
  const materials = [];
  for (let slot = 0; slot < 3; slot++) {
    roots.add(records[slot * WEBGPU_INSTANCE_VECTORS * 4 + 24]);
    materials.push(records[slot * WEBGPU_INSTANCE_VECTORS * 4 + 25]);
  }
  assert.equal(roots.size, 1, 'all copies start at the same bottom-level root');
  assert.deepEqual(materials.sort(), [0, 1, 2]);
});

test('a flat scene uploads the node table as it always did, with no instance header', () => {
  const scene = buildTraceScene(copies(2), {});
  const device = recordingDevice();
  const uploaded = uploadScene(device, scene);
  assert.equal(uploaded.instanceHeader, 0);
  assert.deepEqual(Array.from(device.written.get('bvh nodes')), Array.from(packNodes(scene.bvh).data));
});

test('the instance tables are bounded by one storage buffer, and the error says what to do', () => {
  const scene = buildTraceScene(copies(3), {}, { instancing: true, gpuTriangleLimit: LIMIT });
  assert.throws(() => uploadScene(recordingDevice(4096), scene), error => error instanceof RangeError && /3 instance records.*at most 4096 bytes.*Remove copies or merge small meshes/.test(error.message));
});

test('the WebGPU tracer asks for instanced scenes, and the kernels that cannot read them refuse one', async () => {
  assert.equal(supportsInstancing, true);
  const parts = copies(2);
  const instanced = await buildTraceSceneForDevice(parts, {}, { supportsInstancing, gpuTriangleLimit: () => LIMIT });
  assert.equal(isInstancedScene(instanced), true);
  await assert.rejects(traceOnWebGpu(instanced, {}, { kernel: 'wavefront' }, () => {}), { name: 'RangeError', message: /wavefront kernel does not read instanced scenes.*megakernel/ });
  await assert.rejects(prepareRealtimeKernel(instanced, {}, {}), { name: 'RangeError', message: /real-time tracer does not read instanced scenes/ });
});

async function measureInstancedAgainstFlat() {
  const { icoSphere: sphere, box: cube } = await import('/src/geometry.js');
  const { buildTraceScene: build, uniqueTriangleCount: count } = await import('/src/path-tracer-scene.js');
  const { createCamera, normalizePathTracerOptions } = await import('/src/path-tracer.js');
  const gpuModule = await import('/src/path-tracer-webgpu.js');
  const shared = sphere(2);
  const place = (x, y, z, scale) => [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1];
  const rotated = [0.56, 0.42, 0, 0, -0.42, 0.56, 0, 0, 0, 0, 1, 0, 0.4, 1.2, -0.2, 1];
  const parts = [
    { name: 'floor', geometry: cube(0, 1), matrix: [8, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 8, 0, 0, -0.1, 0, 1], material: { color: [0.6, 0.6, 0.6] } },
    { name: 'left', geometry: shared, matrix: place(-1.4, 0.6, 0, 0.6), material: { color: [0.9, 0.2, 0.2], roughness: 0.3 } },
    { name: 'middle', geometry: shared, matrix: rotated, material: { color: [0.2, 0.8, 0.3], metallic: 1, roughness: 0.2 } },
    { name: 'right', geometry: shared, matrix: [-0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 1.5, 0.5, 0.3, 1], material: { color: [0.2, 0.3, 0.9], roughness: 0.6 } },
  ];
  const environment = { keyColor: [1, 0.95, 0.9], lightDirection: [0.4, 1, 0.3], keyIntensity: 3, pointLights: [{ position: [0, 3, 1], color: [1, 1, 1], intensity: 10, radius: 0.1 }] };
  const width = 48;
  const height = 32;
  const options = normalizePathTracerOptions({ width, height, samples: 8, bounces: 3, seed: 7, backend: 'webgpu', denoiser: 'none', threads: 1 });
  const view = createCamera({ eye: [0, 1.8, 5], target: [0, 0.6, 0], fov: 50 }, width, height);
  const limit = 1_000_000;
  const flat = build(parts, environment, { gpuTriangleLimit: limit });
  const instanced = build(parts, environment, { gpuTriangleLimit: limit, instancing: true });
  const flatImage = await gpuModule.traceOnWebGpu(flat, view, options, () => {});
  const instancedImage = await gpuModule.traceOnWebGpu(instanced, view, options, () => {});
  let squared = 0;
  let sum = 0;
  for (let index = 0; index < flatImage.color.length; index++) {
    squared += (flatImage.color[index] - instancedImage.color[index]) ** 2;
    sum += flatImage.color[index];
  }
  return {
    rmse: Math.sqrt(squared / flatImage.color.length),
    mean: sum / flatImage.color.length,
    flatTriangles: count(flat),
    instancedTriangles: count(instanced),
    instancedFlag: Array.isArray(instanced.instances),
  };
}

test('on the WebGPU megakernel an instanced scene renders what the flattened scene renders', { timeout: 240_000 }, async context => {
  await withWebGpuPage(context, async page => {
    const result = await page.evaluate(measureInstancedAgainstFlat);
    assert.equal(result.instancedFlag, true);
    assert.ok(result.instancedTriangles < result.flatTriangles);
    assert.ok(result.mean > 0.05, `the picture is not black (mean ${result.mean})`);
    assert.ok(result.rmse < result.mean * 0.001, `instanced and flattened pictures match within noise (rmse ${result.rmse}, mean ${result.mean})`);
  });
});
