import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createEnvironmentMap } from '../src/environment.js';
import { withFileSceneInteriorLight } from '../src/dense-lods.js';
import { applyFloorSkyVisibility } from '../src/floor-sky-visibility.js';
import { partDiffuseAlbedo } from '../src/ground-bounce.js';
import {
  buildOccupancyGrid,
  PROXY_MAXIMUM_PAIRS,
  PROXY_MINIMUM_PAIRS,
  proxyPairBudget,
  rayHitDistance,
} from '../src/sky-voxel-proxy.js';
import {
  findSunBounceLights,
  findSunBounceLightsOnShell,
  roomMultiBounceRadiance,
  SUN_BOUNCE_REASONS,
  withSunBounce,
} from '../src/sun-bounce.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ROOM_ENVIRONMENT = {
  keyColor: [3, 2.7, 2.2],
  keyIntensity: 1,
  lightDirection: [-0.85, 0.45, 0.25],
  floorSkyTrace: false,
};

function subdividedFloorPart(divisions, width = 10, depth = 10, height = -0.02) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let row = 0; row <= divisions; row++) {
    for (let column = 0; column <= divisions; column++) {
      positions.push(-width / 2 + (width * column) / divisions, height, -depth / 2 + (depth * row) / divisions);
      normals.push(0, 1, 0);
    }
  }
  for (let row = 0; row < divisions; row++) {
    for (let column = 0; column < divisions; column++) {
      const topLeft = row * (divisions + 1) + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + divisions + 1;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  return {
    name: 'dense-floor',
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
    },
    matrix: IDENTITY,
    material: { color: [0.55, 0.48, 0.4], roughness: 0.85 },
  };
}

function sunlitWindowRoom(floorDivisions = 8, densePropDivisions = 0) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'plaster', translation, scale });
  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'plaster', color: [0.62, 0.56, 0.48], roughness: 0.85 }],
    nodes: [
      block('wall-right', [5, 2, 0], [0.2, 4, 10]),
      block('wall-front', [0, 2, 5], [10, 4, 0.2]),
      block('wall-back', [0, 2, -5], [10, 4, 0.2]),
      block('wall-left-south', [-5, 2, 3], [0.2, 4, 4]),
      block('wall-left-north', [-5, 2, -3], [0.2, 4, 4]),
      block('wall-left-sill', [-5, 0.5, 0], [0.2, 1, 2]),
      block('wall-left-lintel', [-5, 3.5, 0], [0.2, 1, 2]),
      block('roof', [0, 4.1, 0], [10.4, 0.2, 10.4]),
    ],
    camera: { eye: [2, 1.6, 3.5], target: [0, 1.4, 0], fov: 60, near: 0.05, far: 40 },
    environment: ROOM_ENVIRONMENT,
  });
  const parts = [subdividedFloorPart(floorDivisions), ...scene.parts];
  if (densePropDivisions > 0) {
    const plinth = subdividedFloorPart(densePropDivisions, 1, 1, 0.02);
    plinth.name = 'dense-plinth';
    parts.push(plinth);
  }
  return {
    parts,
    environment: scene.environment,
  };
}

function flatEnvironmentMap(color = [0.4, 0.5, 0.7]) {
  const width = 4;
  const height = 2;
  const data = new Float32Array(width * height * 3);
  for (let texel = 0; texel < width * height; texel++) {
    data[texel * 3] = color[0];
    data[texel * 3 + 1] = color[1];
    data[texel * 3 + 2] = color[2];
  }
  return createEnvironmentMap({ width, height, data, intensity: 1 });
}

test('room-shell bounce produces identical lights across mesh densities without a triangle budget', () => {
  const coarse = sunlitWindowRoom(12);
  const dense = sunlitWindowRoom(48);
  const coarseReport = {};
  const denseReport = {};
  const coarseLights = findSunBounceLightsOnShell(coarse.parts, coarse.environment, { report: coarseReport });
  const denseLights = findSunBounceLightsOnShell(dense.parts, dense.environment, { report: denseReport });
  assert.ok(coarseLights.length > 0);
  assert.equal(coarseReport.method, 'shell');
  assert.equal(denseReport.method, 'shell');
  assert.deepEqual(coarseLights, denseLights);
  assert.deepEqual(coarseReport.multiBounceRadiance, denseReport.multiBounceRadiance);
});

test('findSunBounceLights surfaces clear reasons on oversized, open, and sunless rooms', () => {
  const { parts: denseParts, environment } = sunlitWindowRoom(8, 320);
  const skipReport = {};
  const skipped = findSunBounceLights(denseParts, environment, { report: skipReport, largeScenes: 'skip' });
  assert.deepEqual(skipped, []);
  assert.equal(skipReport.reason, 'too many triangles');
  assert.ok(skipReport.detail.includes("largeScenes: 'proxy'"));

  const proxyReport = {};
  const shellLights = findSunBounceLights(denseParts, environment, { report: proxyReport, largeScenes: 'proxy' });
  assert.ok(shellLights.length > 0);
  assert.equal(proxyReport.method, 'shell');

  const openReport = {};
  assert.deepEqual(findSunBounceLights([denseParts[0]], environment, { report: openReport }), []);
  assert.equal(openReport.reason, 'open scene');
  assert.equal(openReport.detail, SUN_BOUNCE_REASONS['open scene']);

  const darkReport = {};
  assert.deepEqual(findSunBounceLights(denseParts, { ...environment, keyIntensity: 0 }, { report: darkReport }), []);
  assert.equal(darkReport.reason, 'no sun');

  assert.throws(() => findSunBounceLights(denseParts, environment, { largeScenes: 'invalid' }), RangeError);
});

test('proxyPairBudget scales with occupied voxels and rayHitDistance measures enclosure depth', () => {
  const smallRoom = sunlitWindowRoom(6).parts;
  const smallGrid = buildOccupancyGrid(smallRoom, { maximumCells: 20_000 });
  const largeGrid = buildOccupancyGrid(smallRoom, { maximumCells: 250_000 });
  const smallBudget = proxyPairBudget(smallGrid);
  const largeBudget = proxyPairBudget(largeGrid);
  assert.equal(smallBudget, PROXY_MINIMUM_PAIRS);
  assert.ok(largeBudget >= smallBudget && largeBudget <= PROXY_MAXIMUM_PAIRS);
  assert.equal(proxyPairBudget({ occupied: new Uint8Array(300_000).fill(1) }), PROXY_MAXIMUM_PAIRS);

  assert.ok(Number.isFinite(rayHitDistance(smallGrid, 0, 1.5, 0, 0, 1, 0)));
  assert.equal(rayHitDistance(smallGrid, 0, 6, 0, 0, 1, 0), Infinity);
});

test('roomMultiBounceRadiance derives exact multi-bounce flux and preserves open scenes', async () => {
  const samples = [
    { flux: [10, 8, 4] },
    { flux: [5, 2, 1] },
  ];
  const interior = { area: 100, albedo: [0.5, 0.25, 0.2], meanAlbedo: 0.3166 };
  const radiance = roomMultiBounceRadiance(samples, interior);
  const expected = [0, 1, 2].map(channel => {
    const power = samples[0].flux[channel] + samples[1].flux[channel];
    const rho = interior.albedo[channel];
    return (power * rho) / (interior.area * (1 - rho) * Math.PI);
  });
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(radiance[channel] - expected[channel]) < 1e-12);
  }
  assert.deepEqual(roomMultiBounceRadiance(samples, { area: 0, albedo: [0.5, 0.5, 0.5] }), [0, 0, 0]);

  const { parts: denseParts, environment } = sunlitWindowRoom(8, 320);
  const map = flatEnvironmentMap([0.2, 0.3, 0.6]);
  const envWithMap = { ...environment, floorSkyTrace: true, map };
  const lit = await withFileSceneInteriorLight(denseParts, envWithMap);
  assert.equal(lit.skyReport.method, 'proxy');
  assert.equal(lit.bounceReport.method, 'shell');
  assert.ok(lit.environment.pointLights.length > 0);
  assert.ok(Array.isArray(lit.environment.map.bounce));
  assert.ok(lit.environment.map.bounce[0] > lit.environment.map.bounce[2]);

  const skyTraced = applyFloorSkyVisibility(denseParts, { onlyClosedRooms: true, surfaces: 'all', strength: 1, largeScenes: 'proxy' });
  assert.equal(skyTraced.report.method, 'proxy');
  const bounceReport = {};
  const bounced = withSunBounce(skyTraced.parts, envWithMap, {
    largeScenes: 'proxy',
    report: bounceReport,
    interiorFill: skyTraced.report.interiorFill,
  });
  assert.equal(bounceReport.method, 'shell');
  assert.ok(Array.isArray(bounced.map.bounce));

  const openParts = [denseParts[0], denseParts[denseParts.length - 1]];
  const openResult = await withFileSceneInteriorLight(openParts, envWithMap);
  assert.equal(openResult.parts, openParts);
  assert.equal(openResult.environment, envWithMap);
  assert.equal(openResult.skyReport.reason, 'open scene');
  assert.equal(openResult.bounceReport.reason, 'open scene');
});

test('partDiffuseAlbedo reads browser-decoded drawable textures without image.data', () => {
  const previousOffscreen = globalThis.OffscreenCanvas;
  const filledRgba = new Uint8ClampedArray(32 * 32 * 4);
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    filledRgba[pixel * 4] = 255;
    filledRgba[pixel * 4 + 1] = 128;
    filledRgba[pixel * 4 + 2] = 0;
    filledRgba[pixel * 4 + 3] = 255;
  }
  globalThis.OffscreenCanvas = class FakeOffscreenCanvas {
    getContext() {
      return {
        drawImage() {},
        getImageData() {
          return { data: filledRgba };
        },
      };
    }
  };
  try {
    const drawableImage = { width: 64, height: 64 };
    const albedo = partDiffuseAlbedo({ color: [1, 1, 1], map: { image: drawableImage } });
    assert.ok(Math.abs(albedo[0] - 1) < 1e-6);
    assert.ok(albedo[1] > 0.2 && albedo[1] < 0.25);
    assert.equal(albedo[2], 0);
  } finally {
    globalThis.OffscreenCanvas = previousOffscreen;
  }
});
