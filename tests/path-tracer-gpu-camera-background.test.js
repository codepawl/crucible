import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_BACKGROUND } from '../src/clear-colour.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';
import { setSceneUniforms } from '../src/path-tracer-gpu.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import { box } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { buildTraceScene, cameraBackgroundWords } from '../src/path-tracer-scene.js';
import { MEGAKERNEL_SOURCE, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';

// Issue #2016, GPU half: with environment.world false the WebGL and WebGPU tracers draw the rasterizer's flat background where a
// camera ray escapes (straight on or through glass), and still light the scene with the map through every other escape.

const SKY_MAP = createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(2) });
const FLOOR = { name: 'floor', geometry: box(0, 1), matrix: new Float32Array([4, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.5, 0.5, 0.5] } };
const CAMERA = { eye: [0, 1, 0], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };
const OPTIONS = { width: 4, height: 4, seed: 1, bounces: 3, fireflyClamp: 10 };

function recordedUniforms(environment) {
  const recorded = new Map();
  const gl = new Proxy({ getUniformLocation: (_program, name) => name }, {
    get: (target, property) => target[property] ?? ((name, ...values) => recorded.set(name, values.flat())),
  });
  setSceneUniforms(gl, {}, buildTraceScene([FLOOR], environment), CAMERA, OPTIONS, 0);
  return recorded;
}

test('the camera background is the raster colour with a flag word, or nothing', () => {
  assert.deepEqual(cameraBackgroundWords(null), [0, 0, 0, 0]);
  assert.deepEqual(cameraBackgroundWords([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
});

test('the WebGL tracer uploads the raster background only for world false', () => {
  const [red, green, blue] = DEFAULT_BACKGROUND;
  assert.deepEqual(recordedUniforms({ map: SKY_MAP, world: false }).get('uCameraBackground'), [red, green, blue, 1]);
  assert.deepEqual(recordedUniforms({ map: SKY_MAP, world: true }).get('uCameraBackground'), [0, 0, 0, 0]);
  assert.deepEqual(recordedUniforms({ map: SKY_MAP }).get('uCameraBackground'), [0, 0, 0, 0]);
});

const KERNELS = [
  ['WebGL fragment kernel', buildFragmentSource(), /void addEscape\([^)]*bool isCameraRay\) \{\s*if \(isCameraRay && uCameraBackground\.w > 0\.0\) \{\s*addRadiance\(depth, throughput \* uCameraBackground\.rgb\);\s*return;/],
  ['WebGPU megakernel', MEGAKERNEL_SOURCE, /fn addEscape\([^)]*isCameraRay: bool\) \{\s*if \(isCameraRay && params\.cameraBackground\.w > 0\.0\) \{\s*addRadiance\(depth, throughput \* params\.cameraBackground\.xyz\);\s*return;/],
];

for (const [name, source, escapeShape] of KERNELS) {
  test(`${name} draws the background first in a camera ray's escape`, () => {
    assert.match(source, escapeShape);
  });

  test(`${name} passes the camera flag to every escape and drops it on the first diffuse bounce`, () => {
    assert.match(source, /addEscape\(depth, previousPdf, afterMirror,[^)]*isCameraRay\)/);
    assert.match(source, /isCameraRay = cameraRays/);
    assert.match(source, /isCameraRay = false;\s*(var|float) lobeUnit/);
  });

  test(`${name} keeps the flag through refracted glass and drops it on a reflection`, () => {
    assert.match(source, /dot\(direction, normal\) < 0\.0\)\s*(\{ )?throughput \*= hitColor;(\s*\})?\s*else(\s*\{)?\s*isCameraRay = false;/);
  });
}

test('the WebGPU wavefront carries the camera flag in its path state', () => {
  assert.match(WAVEFRONT_SOURCE, /FLAG_ALIVE \| FLAG_AFTER_MIRROR \| FLAG_CAMERA/);
  assert.match(WAVEFRONT_SOURCE, /\(flags & FLAG_CAMERA\) != 0u\)/);
  assert.match(WAVEFRONT_SOURCE, /select\(0u, FLAG_CAMERA, isCameraRay\)/);
});

test('the CPU, WebGL, WebGPU and native cycles tracers drop world false from their ignored list', () => {
  const notes = (backend, options) => describeIgnoredFeatures([FLOOR], { map: SKY_MAP, world: false }, backend, options).filter(note => note.includes('world: false'));
  assert.deepEqual(notes('cpu'), []);
  assert.deepEqual(notes('gpu'), []);
  assert.deepEqual(notes('webgpu'), []);
  assert.deepEqual(notes('native', { kernelMaterials: true }), []);
});
