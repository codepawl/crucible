import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { findSunBounceLights, findSunBounceLightsOnShell, roomIrradiance, SUN_BOUNCE_REASONS, SUN_BOUNCE_SHELL_SCALE_RANGE } from '../src/sun-bounce.js';
import { buildOccupancyGrid, proxyPairBudget, PROXY_MAXIMUM_PAIRS, PROXY_MINIMUM_PAIRS, rayHitDistance } from '../src/sky-voxel-proxy.js';
import { withFileSceneInteriorLight } from '../src/dense-lods.js';

// A closed room with a roof opening the sun reaches a patch of the floor through (the room of sun-bounce.test.js).
function roomScene(environment = {}) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.6, 0.5, 0.4], roughness: 0.8 }],
    nodes: [
      block('floor', [0, -0.05, 0], [10, 0.1, 10]),
      block('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      block('wall-right', [5, 2, 0], [0.2, 4, 10]),
      block('wall-front', [0, 2, 5], [10, 4, 0.2]),
      block('wall-back', [0, 2, -5], [10, 4, 0.2]),
      block('roof-left', [-2.9, 4.1, 0], [4.6, 0.2, 10.4]),
      block('roof-right', [2.9, 4.1, 0], [4.6, 0.2, 10.4]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment: { keyColor: [3, 3, 3], lightDirection: [0, 1, 0.2], floorSkyTrace: false, sunBounce: 0, ...environment },
  };
}

// Every triangle cut into four by its edge midpoints: the same surfaces with four times the triangles.
function subdivided(part) {
  const { positions, normals, indices } = part.geometry;
  const nextPositions = [];
  const nextNormals = [];
  const nextIndices = [];
  const vertexOf = index => [[...positions.slice(index * 3, index * 3 + 3)], [...normals.slice(index * 3, index * 3 + 3)]];
  const middle = (first, second) => first.map((value, axis) => (value + second[axis]) / 2);
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const corners = [0, 1, 2].map(slot => vertexOf(indices[triangle * 3 + slot]));
    const [first, second, third] = corners;
    const firstSecond = [middle(first[0], second[0]), first[1]];
    const secondThird = [middle(second[0], third[0]), first[1]];
    const thirdFirst = [middle(third[0], first[0]), first[1]];
    for (const corner of [[first, firstSecond, thirdFirst], [firstSecond, second, secondThird], [thirdFirst, secondThird, third], [firstSecond, secondThird, thirdFirst]]) {
      for (const [position, normal] of corner) {
        nextIndices.push(nextPositions.length / 3);
        nextPositions.push(...position);
        nextNormals.push(...normal);
      }
    }
  }
  return { ...part, geometry: { ...part.geometry, positions: Float32Array.from(nextPositions), normals: Float32Array.from(nextNormals), indices: Uint32Array.from(nextIndices) } };
}

// A prop of `triangles` tiny triangles, enough to take the scene past the light bake's limit.
function denseProp(triangles) {
  const positions = new Float32Array(triangles * 9);
  for (let triangle = 0; triangle < triangles; triangle++) {
    const x = -1 + (triangle % 500) * 0.004;
    const z = -1 + Math.floor(triangle / 500) * 0.004;
    positions.set([x, 0.5, z, x + 0.003, 0.5, z, x, 0.5, z + 0.003], triangle * 9);
  }
  const normals = new Float32Array(triangles * 9);
  for (let vertex = 0; vertex < triangles * 3; vertex++) normals[vertex * 3 + 1] = 1;
  const indices = Uint32Array.from({ length: triangles * 3 }, (unused, index) => index);
  return { name: 'dense-prop', geometry: { positions, normals, indices }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: { color: [0.5, 0.5, 0.5] } };
}

test('the room shell gives the same lights for the same room at one and four times the triangles', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const sparse = findSunBounceLightsOnShell(parts, environment);
  const dense = findSunBounceLightsOnShell(parts.map(subdivided), environment);
  assert.ok(sparse.length > 0, 'the room has sunlit patches');
  // The shell is the grid's boundary, so a denser mesh can move a face by one cell edge: positions and radii match to rounding, intensities to 3 digits.
  assert.equal(dense.length, sparse.length);
  dense.forEach((light, index) => {
    light.position.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - sparse[index].position[axis]) < 1e-9, `position ${light.position} against ${sparse[index].position}`));
    assert.ok(Math.abs(light.radius - sparse[index].radius) < 1e-9);
    assert.ok(Math.abs(light.intensity / sparse[index].intensity - 1) < 1e-3, `intensity ${light.intensity} against ${sparse[index].intensity}`);
  });
});

test('a room past the bake limit gets lights from its shell with largeScenes proxy, and none by default', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const dense = [...parts, denseProp(210_000)];
  const skipped = {};
  assert.deepEqual(findSunBounceLights(dense, environment, { report: skipped }), []);
  assert.equal(skipped.reason, 'too many triangles');
  assert.match(skipped.detail, /at most 200000 triangles.*largeScenes: 'proxy'/);
  const report = {};
  const lights = findSunBounceLights(dense, environment, { largeScenes: 'proxy', report });
  assert.ok(lights.length > 0);
  assert.equal(report.method, 'shell');
  assert.ok(lights.every(light => light.position.every(Number.isFinite) && light.intensity > 0));
  assert.throws(() => findSunBounceLights(dense, environment, { largeScenes: 'maybe' }), /largeScenes must be 'skip' or 'proxy'/);
});

test('shell lights sit inside the room, above the lit floor', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const lights = findSunBounceLightsOnShell(parts, environment);
  for (const light of lights) {
    assert.ok(Math.abs(light.position[0]) < 5 && Math.abs(light.position[2]) < 5 && light.position[1] > 0 && light.position[1] < 4, `light at ${light.position}`);
  }
});

test('every answer without lights says why in the report', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const reasonOf = (sceneParts, sceneEnvironment, options = {}) => {
    const report = {};
    assert.deepEqual(findSunBounceLights(sceneParts, sceneEnvironment, { report, ...options }), []);
    assert.ok(report.detail.length > 10 && (SUN_BOUNCE_REASONS[report.reason] ?? '') !== '');
    return report.reason;
  };
  assert.equal(reasonOf(parts, { ...environment, keyIntensity: 0 }), 'no sun');
  assert.equal(reasonOf(parts, environment, { strength: 0 }), 'no strength');
  assert.equal(reasonOf(parts.slice(0, 1), environment), 'open scene');
  assert.equal(reasonOf(parts.map(part => ({ ...part, material: { ...part.material, lightMap: {} } })), environment), 'baked light');
  assert.equal(reasonOf([...parts, denseProp(210_000)], environment), 'too many triangles');
});

test('a file scene past the bake limit reports its sky trace and bounce, and bounces from the shell', async () => {
  const { parts, environment } = createAgentScene(roomScene());
  const lit = await withFileSceneInteriorLight([...parts, denseProp(210_000)], { ...environment, sunBounce: 1, floorSkyTrace: true });
  assert.equal(lit.bounceReport.method, 'shell');
  assert.ok(lit.environment.pointLights.length > 0);
  const skipped = await withFileSceneInteriorLight([...parts, denseProp(210_000)], { ...environment, sunBounce: 1, floorSkyTrace: true }, { largeScenes: 'skip' });
  assert.equal(skipped.skyReport.reason, 'too many triangles');
  assert.equal(skipped.bounceReport.reason, 'too many triangles');
});

test('the sky proxy ray budget grows with the cells a scene occupies, between its floor and ceiling', () => {
  const { parts } = createAgentScene(roomScene());
  const small = proxyPairBudget(buildOccupancyGrid(parts, { maximumCells: 50_000 }));
  assert.equal(small, PROXY_MINIMUM_PAIRS);
  const fullGrid = { occupied: new Uint8Array(1_000_000).fill(1) };
  assert.equal(proxyPairBudget(fullGrid), PROXY_MAXIMUM_PAIRS);
  const middle = { occupied: new Uint8Array(1_000_000) };
  middle.occupied.fill(1, 0, 150_000);
  const grown = proxyPairBudget(middle);
  assert.ok(grown > PROXY_MINIMUM_PAIRS && grown < PROXY_MAXIMUM_PAIRS, `budget ${grown}`);
  assert.equal(proxyPairBudget(middle), grown);
});

test('rayHitDistance says how far a ray goes before it meets a cell, and Infinity when it escapes', () => {
  const { parts } = createAgentScene(roomScene());
  const grid = buildOccupancyGrid(parts, { maximumCells: 200_000 });
  const distance = rayHitDistance(grid, 3, 1, 0, 0, 1, 0);
  assert.ok(Math.abs(distance - 3) < 2 * grid.cellSize, `distance ${distance}`);
  assert.equal(rayHitDistance(grid, 20, 1, 20, 0, 1, 0), Infinity);
});

test('the shell scale is derived from the room and lands near the triangle path on a room with a small opening', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const report = {};
  const shellLights = findSunBounceLightsOnShell(parts, environment, { report });
  const triangleLights = findSunBounceLights(parts, environment);
  const [minimum, maximum] = SUN_BOUNCE_SHELL_SCALE_RANGE;
  assert.ok(report.shellScale >= minimum && report.shellScale <= maximum, `scale ${report.shellScale}`);
  assert.ok(report.shellScale > 0.5 && report.shellScale < 2, `a small opening needs about the physical amount, got ${report.shellScale}`);
  const brightest = lights => Math.max(...lights.map(light => light.intensity));
  const patchIntensities = shellLights.slice(0, -1).map(light => light.intensity);
  assert.ok(Math.max(...patchIntensities) < 5 * brightest(triangleLights), 'no shell patch light is blown out against the triangle path');
});

test('the shell adds one neutral light under the ceiling, inside the room', () => {
  const { parts, environment } = createAgentScene(roomScene());
  const lights = findSunBounceLightsOnShell(parts, environment);
  const ceiling = lights.at(-1);
  assert.deepEqual(ceiling.color, [1, 1, 1]);
  assert.ok(ceiling.position[1] > 1 && ceiling.position[1] < 4 && Math.abs(ceiling.position[0]) < 5 && Math.abs(ceiling.position[2]) < 5, `ceiling light at ${ceiling.position}`);
  assert.ok(lights.length <= 6, 'the patches and the ceiling light fit the six lights a scene gets');
});

test('roomIrradiance is the reflected power over the inside area and what it bounces on', () => {
  const samples = [{ flux: [3, 3, 3] }, { flux: [3, 3, 3] }];
  assert.equal(roomIrradiance(samples, { area: 10, meanAlbedo: 0.5 }), 6 / (10 * 0.5));
  assert.equal(roomIrradiance(samples, { area: 0, meanAlbedo: 0.5 }), 0);
});
