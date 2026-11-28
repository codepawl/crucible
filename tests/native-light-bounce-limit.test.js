import assert from 'node:assert/strict';

import { cookInstalled, cookModule, cookTest } from './support/cook.js';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const cook = await cookModule();
const { STRUCT_STRIDES_V2, buildNativeInput, buildNativeInputV2, findNativeAddon, traceNative, upgradeNativeInputV1ToV2 } = cook ?? {};
const addonSkip = !cookInstalled || !findNativeAddon?.() ? 'the native addon is not built' : false;

const LIGHT_FLAGS_WORD_INDEX = 7;
const LIGHT_BOUNCE_LIMIT_SHIFT = 8;
const LIGHT_BOUNCE_LIMIT_MASK = 0xff;

function floorPart() {
  const matrix = new Float32Array([4, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 4, 0, 0, -0.05, 0, 1]);
  return { name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } };
}

// A sun, a point, a spot and an area light, in the order Cook packs them.
function lampEnvironment(limits) {
  return {
    keyColor: [1, 1, 1],
    lightDirection: [0, 1, 0],
    ...limits.environment,
    pointLights: [{ position: [0, 2, 0], color: [1, 1, 1], intensity: 5, radius: 0.3, ...limits.point }],
    spotLights: [{ position: [1, 3, 0], direction: [0, -1, 0], angle: 0.6, intensity: 5, radius: 0.2, ...limits.spot }],
    areaLights: [{ position: [2, 3, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 5, ...limits.area }],
  };
}

const cameraDescription = { eye: [0, 1, 6], target: [0, 0, 0], fov: 45 };
const optionsOfPack = { width: 8, height: 8, samples: 1 };

// The limit each of the four light records carries: -1 for none, else the limit.
function packedLimits(v2) {
  const stride = STRUCT_STRIDES_V2.light;
  const words = new Uint32Array(v2.lights.buffer, v2.lights.byteOffset, v2.lights.byteLength / 4);
  return [0, 1, 2, 3].map(index => ((words[(index * stride) / 4 + LIGHT_FLAGS_WORD_INDEX] >>> LIGHT_BOUNCE_LIMIT_SHIFT) & LIGHT_BOUNCE_LIMIT_MASK) - 1);
}

const LIMITS = { environment: { sunMaxBounces: 2 }, point: { maxBounces: 0 }, spot: { maxBounces: 1 }, area: { maxBounces: 254 } };

cookTest('the v2 light records carry the limit of the sun and of each point, spot and area light', () => {
  const scene = buildTraceScene([floorPart()], lampEnvironment(LIMITS));
  const v2 = buildNativeInputV2(scene, createCamera(cameraDescription, 8, 8), optionsOfPack);
  assert.deepEqual(packedLimits(v2), [2, 0, 1, 254]);
});

cookTest('the v1 input a render job packs keeps the same limits through its upgrade to v2', () => {
  const scene = buildTraceScene([floorPart()], lampEnvironment(LIMITS));
  const v1 = buildNativeInput(scene, createCamera(cameraDescription, 8, 8), optionsOfPack, pack);
  assert.deepEqual(packedLimits(upgradeNativeInputV1ToV2(v1, optionsOfPack)), [2, 0, 1, 254]);
});

cookTest('lights without a limit pack as no limit in both input versions', () => {
  const scene = buildTraceScene([floorPart()], lampEnvironment({}));
  const camera = createCamera(cameraDescription, 8, 8);
  assert.deepEqual(packedLimits(buildNativeInputV2(scene, camera, optionsOfPack)), [-1, -1, -1, -1]);
  assert.deepEqual(packedLimits(upgradeNativeInputV1ToV2(buildNativeInput(scene, camera, optionsOfPack, pack), optionsOfPack)), [-1, -1, -1, -1]);
});

function boxPart(name, [scaleX, scaleY, scaleZ], [translateX, translateY, translateZ]) {
  const matrix = new Float32Array([scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, translateX, translateY, translateZ, 1]);
  return { name, geometry: box(0, 1), matrix, material: { color: [0.8, 0.8, 0.8], roughness: 1 } };
}

function meanRgb(rgba) {
  const pixelCount = rgba.length / 4;
  let total = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const base = pixel * 4;
    total += rgba[base] + rgba[base + 1] + rgba[base + 2];
  }
  return total / (pixelCount * 3);
}

const BLACK_MAP = { width: 2, height: 1, data: new Float32Array(6) };

function traceBounceScene(parts, environment, cameraSettings, testContext) {
  const width = 16;
  const height = 16;
  const samples = 32;
  const scene = buildTraceScene(parts, { fillIntensity: 0, ambientIntensity: 0, map: BLACK_MAP, ...environment });
  const camera = createCamera(cameraSettings, width, height);
  const input = buildNativeInputV2(scene, camera, { width, height, samples, bounces: 4, seed: 1 });
  try {
    return traceNative(input, { width, height, samples, bounces: 4, seed: 1, kernel: 'cycles' });
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) {
      testContext.skip(error.message);
      return null;
    }
    throw error;
  }
}

cookTest('Cook trace stops the sun and a point light after their own bounce limit', { skip: addonSkip }, testContext => {
  // Sunlit floor at y=0 and vertical target wall at z=-2; lightDirection [0, 1, -0.5] backlights the wall's +z face so only floor bounces reach it.
  const wallAndFloor = [
    boxPart('floor', [8, 0.1, 8], [0, -0.05, 0]),
    boxPart('wall', [8, 4, 0.1], [0, 2, -2.05]),
  ];
  const wallCamera = { eye: [0, 1.5, 1.5], target: [0, 1.5, -2], fov: 25 };

  const sunStopped = traceBounceScene(wallAndFloor, { keyColor: [12, 12, 12], lightDirection: [0, 1, -0.5], sunMaxBounces: 0 }, wallCamera, testContext);
  if (!sunStopped) return;
  const sunBounced = traceBounceScene(wallAndFloor, { keyColor: [12, 12, 12], lightDirection: [0, 1, -0.5], sunMaxBounces: 1 }, wallCamera, testContext);
  assert.ok(meanRgb(sunStopped.rgba) < 1e-5, `sunMaxBounces: 0 should leave bounce-lit wall dark, got ${meanRgb(sunStopped.rgba)}`);
  assert.ok(meanRgb(sunBounced.rgba) > 0.05, `sunMaxBounces: 1 should bounce sun light onto wall, got ${meanRgb(sunBounced.rgba)}`);

  // Point light below a shelf: shelf (z=-2..0 at y=0.9) shadows the upper wall from direct light so only the z>0 floor bounce reaches it.
  const shadowedBounceParts = [
    ...wallAndFloor,
    boxPart('shelf', [8, 0.1, 2], [0, 0.9, -1.0]),
  ];
  const upperWallCamera = { eye: [0, 2.2, 1.5], target: [0, 2.2, -2], fov: 20 };
  const pointLight = { position: [0, 0.5, 0.0], color: [1, 1, 1], intensity: 400, radius: 0.05 };

  const pointStopped = traceBounceScene(shadowedBounceParts, { keyColor: [0, 0, 0], pointLights: [{ ...pointLight, maxBounces: 0 }] }, upperWallCamera, testContext);
  const pointBounced = traceBounceScene(shadowedBounceParts, { keyColor: [0, 0, 0], pointLights: [{ ...pointLight, maxBounces: 1 }] }, upperWallCamera, testContext);
  assert.ok(meanRgb(pointStopped.rgba) < 1e-5, `maxBounces: 0 should leave shadowed wall dark, got ${meanRgb(pointStopped.rgba)}`);
  assert.ok(meanRgb(pointBounced.rgba) > 0.05, `maxBounces: 1 should bounce point light onto wall, got ${meanRgb(pointBounced.rgba)}`);
});
