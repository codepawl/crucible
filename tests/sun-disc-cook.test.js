import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { agentEnvironmentKey, agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { createEnvironmentMap } from '../src/environment.js';
import { registerCatalogEnvironment } from '../src/look-catalog.js';
import { pathTraceEnvironment } from '../src/path-trace-terms.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture, SUN_ANGULAR_RADIUS, sunDiscScaleOf } from '../src/path-tracer-scene.js';
import { MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { createCamera, renderPathTracedImage } from '../src/path-tracer.js';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { cookModule, cookTest } from './support/cook.js';

const LIGHT_RECORD_BYTES = 128;
const LIGHT_TYPE_SUN = 4;
const LIGHT_FLAG_CAMERA_VISIBLE = 4;
const HDRI_WIDTH = 128;
const HDRI_HEIGHT = 64;
const SUNNY_HDRI_ID = 'd'.repeat(64);

function makeSunnyHdri() {
  const data = new Float32Array(HDRI_WIDTH * HDRI_HEIGHT * 3);
  const sunDirection = [0, Math.sin((30 * Math.PI) / 180), -Math.cos((30 * Math.PI) / 180)];
  const sunThreshold = Math.cos((3 * Math.PI) / 180);
  for (let row = 0; row < HDRI_HEIGHT; row++) {
    const polar = ((row + 0.5) / HDRI_HEIGHT) * Math.PI;
    for (let column = 0; column < HDRI_WIDTH; column++) {
      const azimuth = ((column + 0.5) / HDRI_WIDTH) * 2 * Math.PI;
      const direction = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      const cosine = direction[0] * sunDirection[0] + direction[1] * sunDirection[1] + direction[2] * sunDirection[2];
      const color = cosine > sunThreshold ? [400, 360, 300] : [0.3, 0.4, 0.6];
      data.set(color, (row * HDRI_WIDTH + column) * 3);
    }
  }
  return { width: HDRI_WIDTH, height: HDRI_HEIGHT, data };
}

registerCatalogEnvironment(SUNNY_HDRI_ID, makeSunnyHdri());

const floorParts = [
  { name: 'floor', geometry: box(0), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -10, 0, 1]), material: { color: [0.5, 0.5, 0.5] } },
];

const sharedGeometry = box(0);
const instancedParts = [
  { name: 'first', geometry: sharedGeometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -10, 0, 1]), material: { color: [0.5, 0.5, 0.5] } },
  { name: 'second', geometry: sharedGeometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -10, 0, 1]), material: { color: [0.5, 0.5, 0.5] } },
];

function physicalTraceEnvironment(sky, extra = {}) {
  const { environment } = normalizeAgentLook({ environment: { sky: { type: 'physical', ...sky }, world: true, ...extra } });
  return pathTraceEnvironment(environment);
}

function sunTarget(elevationDegrees, rotationRadians = 0) {
  const elevation = (elevationDegrees * Math.PI) / 180;
  const baseZ = -Math.cos(elevation);
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  return [sine * baseZ * 10, 1 + Math.sin(elevation) * 10, cosine * baseZ * 10];
}

function countBrightPixels(rgba) {
  let count = 0;
  for (let pixel = 0; pixel < rgba.length; pixel += 4) {
    if (rgba[pixel] >= 250 && rgba[pixel + 1] >= 250 && rgba[pixel + 2] >= 250) count++;
  }
  return count;
}

test('buildTraceScene marks lights.sun.cameraVisible from sunDisc and suppresses it when sunDisc or world is false', () => {
  const withDisc = buildTraceScene(floorParts, physicalTraceEnvironment({ sunElevation: 20, sunDisc: true }, { sunAngularRadius: 0.02 }));
  assert.equal(withDisc.lights.sun.cameraVisible, true);
  assert.equal(withDisc.lights.sun.angularRadius, 0.02);
  assert.equal(withDisc.environment.sunDisc, undefined);

  const withoutDisc = buildTraceScene(floorParts, physicalTraceEnvironment({ sunElevation: 20, sunDisc: false }));
  assert.equal(withoutDisc.lights.sun.cameraVisible, undefined);
  assert.ok(withoutDisc.lights.sun.color.some(channel => channel > 0));

  const hiddenWorld = buildTraceScene(floorParts, physicalTraceEnvironment({ sunElevation: 20, sunDisc: true }, { world: false }));
  assert.equal(hiddenWorld.lights.sun.cameraVisible, undefined);

  const plainMap = createEnvironmentMap({ width: 4, height: 2, data: new Float32Array(4 * 2 * 3).fill(0.2) });
  const plainScene = buildTraceScene(floorParts, { map: plainMap, keyColor: [3, 3, 3], lightDirection: [0, 1, 0] });
  assert.equal(plainScene.lights.sun.cameraVisible, undefined);
});

test('keyFromHdri aligns lightDirection and cameraVisible sun cone across environmentRotation', () => {
  const normalized = normalizeAgentLook({ environment: { hdri: SUNNY_HDRI_ID, keyFromHdri: true, environmentRotation: Math.PI / 3, world: true } }).environment;
  const traced = pathTraceEnvironment(agentEnvironmentKey(normalized));
  const scene = buildTraceScene(floorParts, traced);
  assert.equal(scene.lights.sun.cameraVisible, true);
  scene.lights.sun.direction.forEach((component, axis) => assert.ok(Math.abs(component - traced.lightDirection[axis]) < 1e-12));
  const map = agentEnvironmentMap(normalized);
  assert.ok(map.sunDisc);
});

test('applyPhysicalSky rotates lightDirection with environmentRotation to match the rotated sunDisc', () => {
  const { environment } = normalizeAgentLook({ environment: { sky: { type: 'physical', sunElevation: 20, sunRotation: 0 }, environmentRotation: Math.PI / 2, world: true } });
  const map = agentEnvironmentMap(environment);
  const expected = sunTarget(20, Math.PI / 2);
  const length = Math.hypot(expected[0], expected[1] - 1, expected[2]);
  const unitExpected = [expected[0] / length, (expected[1] - 1) / length, expected[2] / length];
  environment.lightDirection.forEach((component, axis) => assert.ok(Math.abs(component - unitExpected[axis]) < 1e-9));
  assert.equal(map.rotation, Math.PI / 2);
});

test('sunDiscScaleOf matches Cycles disc solid angle and returns 0 when hidden or delta', () => {
  const defaultScale = sunDiscScaleOf({ cameraVisible: true });
  const expectedDefault = 1 / (Math.PI * Math.sin(SUN_ANGULAR_RADIUS) ** 2);
  assert.ok(Math.abs(defaultScale - expectedDefault) < 1e-6);
  assert.equal(sunDiscScaleOf({ cameraVisible: false, angularRadius: 0.02 }), 0);
  assert.equal(sunDiscScaleOf({ cameraVisible: true, angularRadius: 0 }), 0);
  assert.equal(sunDiscScaleOf(null), 0);
});

test('createCamera accepts 1 degree vertical FOV for telephoto sun checks', () => {
  const camera = createCamera({ eye: [0, 1, 0], target: [0, 1, -10], fov: 1 }, 64, 36);
  assert.ok(Math.abs(camera.halfHeight - Math.tan(Math.PI / 360)) < 1e-9);
});

test('CPU path tracer draws the analytic sun disc at sunAngularRadius and suppresses it when sunDisc is false', async () => {
  const width = 64;
  const height = 64;
  const camera = { eye: [0, 1, 0], target: sunTarget(20, Math.PI / 4), fov: 5 };
  const radius = 0.02;
  const withDisc = await renderPathTracedImage(
    { parts: floorParts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: true }, { environmentRotation: Math.PI / 4, sunAngularRadius: radius }), camera },
    { width, height, samples: 4, bounces: 1, seed: 1, denoise: false, threads: 1 },
  );
  const brightCount = countBrightPixels(withDisc.rgba);
  const equivalentDiameter = 2 * Math.sqrt(brightCount / Math.PI);
  const expectedDiameter = (2 * Math.tan(radius) / (2 * Math.tan((5 * Math.PI) / 360))) * height;
  assert.ok(Math.abs(equivalentDiameter - expectedDiameter) < 1.5, `measured ${equivalentDiameter} against ${expectedDiameter}`);

  const withoutDisc = await renderPathTracedImage(
    { parts: floorParts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: false }, { environmentRotation: Math.PI / 4, sunAngularRadius: radius }), camera },
    { width, height, samples: 4, bounces: 1, seed: 1, denoise: false, threads: 1 },
  );
  assert.equal(countBrightPixels(withoutDisc.rgba), 0);
});

test('WebGL2 and WebGPU path tracer shaders evaluate the camera-visible analytic sun disc', () => {
  const fragment = buildFragmentSource({});
  assert.match(fragment, /uniform vec3 uSunDiscRadiance;/);
  assert.match(fragment, /dot\(direction, uSunDirection\) >= uSunCosineMax/);
  assert.match(MEGAKERNEL_SOURCE, /params\.sunDirection\.w > 0\.0 && dot\(direction, params\.sunDirection\.xyz\) >= params\.sunColorAndCosine\.w/);
});

function readSunFlags(exported) {
  const bytes = Buffer.from(exported.tables.lights, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < exported.counts.lightCount; index++) {
    const base = index * LIGHT_RECORD_BYTES;
    if (view.getUint32(base + 12, true) === LIGHT_TYPE_SUN) return view.getUint32(base + 28, true);
  }
  return null;
}

test('exportNativeSceneTables stamps LIGHT_FLAG_CAMERA_VISIBLE onto flattened sun records when sunDisc is on', () => {
  const buildFakeV2Input = () => {
    const lights = new Uint8Array(LIGHT_RECORD_BYTES);
    const view = new DataView(lights.buffer);
    view.setUint32(12, LIGHT_TYPE_SUN, true);
    view.setUint32(28, 3, true);
    return { schemaVersion: 2, triangleCount: 12, lightCount: 1, lights };
  };
  const modules = {
    buildTraceScene,
    resolveTexture,
    buildNativeInput: () => { throw new Error('unexpected v1 fallback'); },
    buildJobNativeInput: () => { throw new Error('unexpected instanced path'); },
    buildFlattenedJobNativeInput: buildFakeV2Input,
    pack,
    gridVolumeInput: {},
  };
  const camera = createCamera({ eye: [0, 1, 0], target: sunTarget(20), fov: 5 }, 32, 32);
  const options = { width: 32, height: 32, samples: 1, bounces: 1, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
  const withDisc = exportNativeSceneTables({ parts: floorParts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: true }), camera, options, kernel: 'cycles', instancing: false, modules });
  assert.equal(readSunFlags(withDisc), 3 | LIGHT_FLAG_CAMERA_VISIBLE);
  const withoutDisc = exportNativeSceneTables({ parts: floorParts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: false }), camera, options, kernel: 'cycles', instancing: false, modules });
  assert.equal(readSunFlags(withoutDisc), 3);
});

cookTest('native Cook export sets LIGHT_FLAG_CAMERA_VISIBLE on both flattened and instanced scenes only when sunDisc is on', async () => {
  const { buildNativeInput } = await cookModule('pack-input');
  const { buildJobNativeInput, buildFlattenedJobNativeInput } = await cookModule('job-input');
  const gridVolumeInput = await cookModule('grid-volume-input');
  const modules = { buildTraceScene, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack, gridVolumeInput };
  const camera = createCamera({ eye: [0, 1, 0], target: sunTarget(20), fov: 5 }, 32, 32);
  const options = { width: 32, height: 32, samples: 1, bounces: 1, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };

  for (const [label, parts] of [['flattened', floorParts], ['instanced', instancedParts]]) {
    const withDisc = exportNativeSceneTables({ parts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: true }), camera, options, kernel: 'cycles', instancing: true, modules });
    assert.equal(readSunFlags(withDisc) & LIGHT_FLAG_CAMERA_VISIBLE, LIGHT_FLAG_CAMERA_VISIBLE, `${label} scene with sunDisc: true`);

    const withoutDisc = exportNativeSceneTables({ parts, environment: physicalTraceEnvironment({ sunElevation: 20, sunDisc: false }), camera, options, kernel: 'cycles', instancing: true, modules });
    assert.equal(readSunFlags(withoutDisc) & LIGHT_FLAG_CAMERA_VISIBLE, 0, `${label} scene with sunDisc: false`);
  }
});
