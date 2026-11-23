import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnvironmentMap } from '../src/environment.js';
import { box } from '../src/geometry.js';
import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function occlusionImage(red) {
  return { image: { width: 1, height: 1, data: new Uint8Array([red, red, red, 255]) }, colorSpace: 'linear' };
}

function floorMaterial(extra) {
  return { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.8, 0.8, 0.8], ...extra };
}

const camera = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const OPTIONS = { width: 16, height: 16, samples: 24, bounces: 2, denoise: false, threads: 1, backend: 'cpu' };
const SUN_ONLY = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
// A white wall beside the floor and a sun that lights it from the side: the floor receives light only by bouncing off the wall.
const SIDE_SUN = { keyColor: [6, 6, 6], lightDirection: [-1, 0.5, 0] };

function floor(material) {
  return { name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [20, 0.1, 20]), material };
}

function wall() {
  return { name: 'wall', geometry: box(0, 1), matrix: placed([3, 2, 0], [0.2, 4, 20]), material: floorMaterial({ color: [1, 1, 1] }) };
}

async function centreBrightness(parts, environment) {
  const { linear } = await renderPathTracedImage({ parts, environment, camera }, OPTIONS);
  const centre = (8 * 16 + 8) * 3;
  return linear[centre] + linear[centre + 1] + linear[centre + 2];
}

test('a black occlusion map removes the light a surface gathers from a bounce', async () => {
  const directOnly = await centreBrightness([floor(floorMaterial())], SIDE_SUN);
  const open = await centreBrightness([floor(floorMaterial()), wall()], SIDE_SUN);
  const occluded = await centreBrightness([floor(floorMaterial({ occlusionMap: occlusionImage(0) })), wall()], SIDE_SUN);
  assert.ok(open > directOnly * 1.05, `the wall bounces light onto the floor: ${open} against ${directOnly}`);
  assert.ok(Math.abs(occluded - directOnly) < directOnly * 0.02, `with the map only the direct light is left: ${occluded} against ${directOnly}`);
});

test('a black occlusion map removes the sky light of a surface', async () => {
  const sky = { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.5), intensity: 1 }) };
  const open = await centreBrightness([floor(floorMaterial())], sky);
  const occluded = await centreBrightness([floor(floorMaterial({ occlusionMap: occlusionImage(0) }))], sky);
  assert.ok(open > 0.2, `the sky lights the floor: ${open}`);
  assert.ok(occluded < open * 0.05, `the occlusion map shuts the sky out: ${occluded} against ${open}`);
});

test('the occlusion map does not darken the direct light of the sun', async () => {
  const open = await centreBrightness([floor(floorMaterial())], SUN_ONLY);
  const occluded = await centreBrightness([floor(floorMaterial({ occlusionMap: occlusionImage(0) }))], SUN_ONLY);
  assert.ok(open > 0.5, `the floor is lit by the sun: ${open}`);
  assert.ok(Math.abs(occluded - open) < open * 0.02, `direct light is unchanged: ${occluded} against ${open}`);
});

test('occlusionStrength blends between no occlusion and the map', async () => {
  const parts = strength => [floor(floorMaterial({ occlusionMap: occlusionImage(0), occlusionStrength: strength })), wall()];
  const none = await centreBrightness(parts(0), SIDE_SUN);
  const half = await centreBrightness(parts(0.5), SIDE_SUN);
  const full = await centreBrightness(parts(1), SIDE_SUN);
  assert.ok(full < half && half < none, `strength 0, 0.5 and 1 darken in steps: ${none}, ${half}, ${full}`);
});

test('only the CPU tracer drops occlusionMap from its ignored list', () => {
  const parts = [floor(floorMaterial({ occlusionMap: occlusionImage(0) }))];
  assert.deepEqual(describeIgnoredFeatures(parts, {}, 'cpu').filter(note => note.startsWith('occlusionMap')), []);
  for (const backend of ['gpu', 'webgpu']) {
    assert.equal(describeIgnoredFeatures(parts, {}, backend).filter(note => note.startsWith('occlusionMap')).length, 1, backend);
  }
  const native = describeIgnoredFeatures(parts, {}, 'native', { kernelMaterials: true }).filter(note => note.startsWith('occlusionMap'));
  assert.equal(native.length, 1);
  assert.match(native[0], /codepawl\/cook#71/);
});
