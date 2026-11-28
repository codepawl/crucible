import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { describeIgnoredFeatures } from '../src/path-tracer.js';
import { OCCLUSION_TEXELS, packAtlas, packMaterials, packOcclusion, sceneUsesOcclusionMap } from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { traceOnWebGpu, uploadScene } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

// Issue #2910: the WebGPU megakernel reads a material's occlusionMap from a table after the material records and scales only indirect
// light with it, as the CPU tracer does (tests/path-tracer-occlusion-map.test.js).

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
  return buildTraceScene(materials.map((material, index) => ({ name: `part-${index}`, geometry: quad(), material: { color: [0.5, 0.5, 0.5], ...material } })), {});
}

test('the occlusion map reaches the WebGPU trace scene with its strength', () => {
  const scene = sceneWith([{}, { occlusionMap: occlusionImage(40), occlusionStrength: 0.6 }]);
  assert.equal(sceneUsesOcclusionMap(scene.materials), true);
  assert.equal(scene.materials[0].occlusionTexture, null);
  assert.equal(scene.materials[1].occlusionStrength, 0.6);
  assert.equal(sceneUsesOcclusionMap(sceneWith([{}]).materials), false);
});

test('the occlusion table holds a rectangle and the strength per material, and nothing for a material without a map', () => {
  const scene = sceneWith([{}, { occlusionMap: occlusionImage(40), occlusionStrength: 0.6 }]);
  const atlas = packAtlas(scene.materials, { withOcclusion: true });
  const { data } = packOcclusion(scene.materials, atlas);
  assert.equal(OCCLUSION_TEXELS, 2);
  assert.deepEqual(Array.from(data.subarray(0, 4)), [0, 0, 0, 0], 'a material without the map has a rectangle of width 0');
  const place = atlas.placements.get(scene.materials[1].occlusionTexture.data);
  assert.deepEqual(Array.from(data.subarray(8, 12)), [place.x, place.y, 2, 2]);
  assert.ok(Math.abs(data[13] - 0.6) < 1e-6, 'the strength sits in the second vector');
  assert.equal(packAtlas(scene.materials).width, 1, 'the other tracers keep an atlas without occlusion maps');
});

test('the upload puts the occlusion table right after the material records, only for a scene that has a map', () => {
  const withMap = recordingDevice();
  uploadScene(withMap, sceneWith([{ occlusionMap: occlusionImage(40) }, {}]));
  const materialTexels = 2 * 10;
  const table = withMap.written.get('materials').subarray(materialTexels * 4, (materialTexels + OCCLUSION_TEXELS * 2) * 4);
  assert.equal(table[2], 2, 'the first material has a map 2 texels wide');
  assert.equal(table[10], 0, 'the second material has none');
  const without = recordingDevice();
  uploadScene(without, sceneWith([{}, {}]));
  const paddedRecords = packMaterials(sceneWith([{}, {}]).materials, packAtlas([])).data.length;
  assert.equal(without.written.get('materials').length, paddedRecords, 'a scene without the map uploads the padded material records alone, as before');
});

test('only the sky and the bounced light are scaled by the occlusion map, in the megakernel of a scene that has one', () => {
  const source = buildMegakernelSource({ hasOcclusionMap: true });
  assert.match(source, /hitOcclusion = occlusionAt\(uv, secondUv\);/);
  assert.match(source, /1\.0 \+ settings\.y \* \(texel\.r - 1\.0\)/, 'glTF semantics: mix(1, map, strength)');
  assert.match(source, /transmittance \* select\(1\.0, hitOcclusion, weightMode == 1\)/, 'the sky shadow ray carries it, the sun and lights do not');
  assert.match(source, /if \(cosine <= 0\.0\) \{ break; \}\s+throughput \*= hitOcclusion;/, 'the next leg is indirect light');
  assert.equal((source.match(/hitOcclusion/g) ?? []).length, 4, 'no other place reads the occlusion');
});

test('a scene without the map compiles the kernels it had', () => {
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /hitOcclusion|occlusionAt/);
  assert.doesNotMatch(WAVEFRONT_SOURCE, /hitOcclusion|occlusionAt/);
  assert.equal(buildMegakernelSource({ hasOcclusionMap: false }), MEGAKERNEL_SOURCE);
  assert.equal(createHash('sha256').update(buildMegakernelSource({ texelBake: true })).digest('hex').length, 64);
});

test('the wavefront kernel refuses an occlusion map before it asks for an adapter', async () => {
  const scene = sceneWith([{ occlusionMap: occlusionImage(40) }]);
  await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace occlusion maps/);
});

test('webgpu and native cycles drop occlusionMap from their ignored list while gpu keeps it', () => {
  const parts = [{ name: 'floor', geometry: quad(), material: { occlusionMap: occlusionImage(0) } }];
  const noted = backend => describeIgnoredFeatures(parts, {}, backend).filter(note => note.startsWith('occlusionMap'));
  assert.deepEqual(noted('webgpu'), []);
  assert.deepEqual(noted('cpu'), []);
  assert.equal(noted('gpu').length, 1);
  assert.deepEqual(describeIgnoredFeatures(parts, {}, 'webgpu', { kernelMaterials: true }).filter(note => note.startsWith('occlusionMap')), []);
});

async function traceFloorBrightness() {
  const { box } = await import('/src/geometry.js');
  const { createEnvironmentMap } = await import('/src/environment.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const blackMap = { image: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }, colorSpace: 'linear' };
  const floor = extra => [{ name: 'floor', geometry: box(0, 1), matrix: new Float32Array([20, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 20, 0, 0, -0.05, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.8, 0.8, 0.8], ...extra } }];
  const camera = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
  const options = { width: 16, height: 16, samples: 24, bounces: 2, denoise: false, backend: 'webgpu', seed: 3 };
  const sky = { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.5), intensity: 1 }) };
  const sun = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
  const centre = async (parts, environment) => {
    const { linear } = await renderPathTracedImage({ parts, environment, camera }, options);
    const index = (8 * 16 + 8) * 3;
    return linear[index] + linear[index + 1] + linear[index + 2];
  };
  return {
    skyOpen: await centre(floor({}), sky),
    skyOccluded: await centre(floor({ occlusionMap: blackMap }), sky),
    sunOpen: await centre(floor({}), sun),
    sunOccluded: await centre(floor({ occlusionMap: blackMap }), sun),
  };
}

test('on the WebGPU megakernel a black occlusion map shuts out the sky and leaves the sun alone', { timeout: 240_000 }, async context => {
  await withWebGpuPage(context, async page => {
    const result = await page.evaluate(traceFloorBrightness);
    assert.ok(result.skyOpen > 0.2, `the sky lights the floor: ${result.skyOpen}`);
    assert.ok(result.skyOccluded < result.skyOpen * 0.05, `the map shuts the sky out: ${result.skyOccluded} against ${result.skyOpen}`);
    assert.ok(result.sunOpen > 0.5, `the sun lights the floor: ${result.sunOpen}`);
    assert.ok(Math.abs(result.sunOccluded - result.sunOpen) < result.sunOpen * 0.02, `direct light is unchanged: ${result.sunOccluded} against ${result.sunOpen}`);
  });
});
