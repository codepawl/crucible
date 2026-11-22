import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { createTerrain } from '../src/terrain.js';
import { createRecipeTerrain, generateTerrainGeometry, terrainVertexEstimate, TERRAIN_LIMITS } from '../src/agent-terrain.js';

await loadAllAgentSceneModules();

const MAX_VERTICES = 250_000;

function positionHash(geometry) {
  return createHash('sha256').update(Buffer.from(geometry.positions.buffer, geometry.positions.byteOffset, geometry.positions.byteLength)).digest('hex');
}

function heightsOf(record) {
  return Array.from(generateTerrainGeometry({ type: 'terrain', ...record }, MAX_VERTICES).positions).filter((_, index) => index % 3 === 1);
}

function trianglesOf(scene) {
  return scene.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
}

function sceneWith(terrain, camera) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', ...terrain }],
    materials: [{ id: 'grass', color: [0.3, 0.5, 0.2] }],
    nodes: [{ id: 'hills', geometry: 'ground', material: 'grass' }],
    camera,
  });
}

const CHUNKED = { size: 400, resolution: 16, chunks: 4, levels: 3, amplitude: 10, seed: 5 };

test('an old record keeps its heights byte for byte', () => {
  const oldWay = createTerrain({ size: 40, chunks: 1, levels: 1, resolution: 64, seed: 1, height: { amplitude: 1, featureSize: 10, warp: 0, mountainMask: () => 0 } });
  const current = generateTerrainGeometry({ type: 'terrain' }, MAX_VERTICES);
  assert.equal(positionHash(current), positionHash(oldWay.parts[0].geometry));
  const seeded = { size: 90, resolution: 30, seed: 7, amplitude: 4, holes: [{ center: [3, 3], radius: 5 }] };
  const oldSeeded = createTerrain({ size: 90, chunks: 1, levels: 1, resolution: 30, seed: 7, holes: seeded.holes, height: { amplitude: 4, featureSize: 22.5, warp: 0, mountainMask: () => 0 } });
  assert.equal(positionHash(generateTerrainGeometry({ type: 'terrain', ...seeded }, MAX_VERTICES)), positionHash(oldSeeded.parts[0].geometry));
  assert.deepEqual(Array.from(current.indices), Array.from(oldWay.parts[0].geometry.indices));
});

test('each noise field changes the heights it names', () => {
  const base = { size: 200, resolution: 40, amplitude: 8, seed: 3 };
  const baseHeights = heightsOf(base);
  const changes = {
    featureSize: { featureSize: 15 },
    octaves: { octaves: 2 },
    warp: { warp: 30 },
    ridged: { ridged: true, mountainAmplitude: 60 },
    mountainAmplitude: { mountainMask: 1, mountainAmplitude: 80 },
    mountainMask: { mountainMask: 0.5 },
  };
  for (const [field, change] of Object.entries(changes)) {
    assert.notDeepEqual(heightsOf({ ...base, ...change }), baseHeights, `${field} must change the heights`);
  }
  const lowMountains = heightsOf({ ...base, mountainMask: 1, mountainAmplitude: 10 });
  const highMountains = heightsOf({ ...base, mountainMask: 1, mountainAmplitude: 100 });
  assert.ok(Math.max(...highMountains) > Math.max(...lowMountains) + 20, 'mountainAmplitude scales the ridges');
  assert.deepEqual(heightsOf({ ...base, ridged: false, warp: 0 }), baseHeights);
});

test('the noise fields reach the library: a record equals createTerrain with the same options', () => {
  const record = { size: 300, resolution: 24, seed: 9, amplitude: 12, featureSize: 70, octaves: 3, warp: 20, mountainAmplitude: 55, mountainMask: 0.6 };
  const direct = createTerrain({ size: 300, chunks: 1, levels: 1, resolution: 24, seed: 9, height: { amplitude: 12, featureSize: 70, octaves: 3, warp: 20, mountainAmplitude: 55, mountainMask: () => 0.6 } });
  assert.equal(positionHash(generateTerrainGeometry({ type: 'terrain', ...record }, MAX_VERTICES)), positionHash(direct.parts[0].geometry));
  const ridged = createTerrain({ size: 300, chunks: 1, levels: 1, resolution: 24, seed: 9, height: { amplitude: 12, featureSize: 75, warp: 0 } });
  assert.equal(positionHash(generateTerrainGeometry({ type: 'terrain', size: 300, resolution: 24, seed: 9, amplitude: 12, ridged: true }, MAX_VERTICES)), positionHash(ridged.parts[0].geometry));
});

test('chunks and levels build the finest mesh, and the ground height does not depend on them', () => {
  const single = createRecipeTerrain({ size: 400, resolution: 64, seed: 5, amplitude: 10 });
  const chunked = createRecipeTerrain(CHUNKED);
  assert.equal(chunked.heightAt(37, -120), single.heightAt(37, -120));
  const geometry = generateTerrainGeometry({ type: 'terrain', ...CHUNKED }, MAX_VERTICES);
  assert.equal(geometry.indices.length / 3, 4 * 4 * 16 * 16 * 2);
  assert.equal(terrainVertexEstimate(CHUNKED), 4 * 4 * 17 * 17);
  assert.equal(geometry.positions.length / 3, 4 * 4 * 17 * 17);
});

test('the scene draws fewer triangles the farther the camera is, and keeps the mesh while the levels stay', () => {
  const near = sceneWith(CHUNKED, { eye: [10, 20, 150], target: [0, 0, 0] });
  const far = sceneWith(CHUNKED, { eye: [10, 900, 1400], target: [0, 0, 0] });
  assert.ok(trianglesOf(near) > trianglesOf(far) * 2, `near ${trianglesOf(near)} vs far ${trianglesOf(far)}`);
  assert.ok(trianglesOf(near) <= 4 * 4 * 16 * 16 * 2);
  const stillFar = sceneWith(CHUNKED, { eye: [12, 905, 1405], target: [0, 0, 0] });
  assert.equal(trianglesOf(stillFar), trianglesOf(far));
});

test('a camera track moves the levels at each sampled time', () => {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', ...CHUNKED }],
    materials: [{ id: 'grass', color: [0.3, 0.5, 0.2] }],
    nodes: [{ id: 'hills', geometry: 'ground', material: 'grass' }],
    camera: { eye: [10, 20, 150], target: [0, 0, 0] },
    motion: { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [10, 20, 150] }, { time: 2, value: [10, 900, 1400] }] }] },
  });
  scene.sampleMotion(0);
  const nearTriangles = trianglesOf(scene);
  scene.sampleMotion(2);
  const farTriangles = trianglesOf(scene);
  assert.ok(nearTriangles > farTriangles * 2, `near ${nearTriangles} vs far ${farTriangles}`);
  scene.sampleMotion(0);
  assert.equal(trianglesOf(scene), nearTriangles);
});

test('a moved ground sees the camera where it is in the world', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', ...CHUNKED }],
    materials: [{ id: 'grass', color: [0.3, 0.5, 0.2] }],
    nodes: [{ id: 'hills', geometry: 'ground', material: 'grass', translation: [5000, 0, 0] }],
    camera: { eye: [5010, 20, 150], target: [5000, 0, 0] },
  };
  const moved = trianglesOf(createAgentScene(recipe));
  const origin = trianglesOf(sceneWith(CHUNKED, { eye: [10, 20, 150], target: [0, 0, 0] }));
  assert.equal(moved, origin);
});

test('terrain fields name what to pass when they are wrong', () => {
  const cases = [
    [{ chunks: 0 }, /terrain\.chunks.*from 1 to 64/s],
    [{ chunks: 2.5 }, /terrain\.chunks.*whole number/s],
    [{ levels: 7 }, /terrain\.levels.*from 1 to 6/s],
    [{ levels: 3, resolution: 18 }, /terrain\.resolution.*divisible by 4.*such as 20/s],
    [{ chunks: 64, resolution: 128 }, /terrain\.chunks.*at most 4096 cells per side/s],
    [{ resolution: 500 }, /terrain\.resolution.*from 2 to 499/s],
    [{ octaves: 1.5 }, /terrain\.octaves.*whole number/s],
    [{ octaves: 9 }, /terrain\.octaves.*from 1 to 8/s],
    [{ warp: -1 }, /terrain\.warp.*from 0 to 1000/s],
    [{ featureSize: 0 }, /terrain\.featureSize.*from 0\.01/s],
    [{ mountainAmplitude: 501 }, /terrain\.mountainAmplitude.*from 0 to 500/s],
    [{ mountainMask: 2 }, /terrain\.mountainMask.*from 0 to 1/s],
    [{ ridged: 'yes' }, /terrain\.ridged.*true or false/s],
    [{ ridged: true, mountainMask: 0.5 }, /terrain\.mountainMask.*drop one of the two/s],
  ];
  for (const [change, message] of cases) {
    assert.throws(() => terrainVertexEstimate({ type: 'terrain', ...change }), message, JSON.stringify(change));
  }
  assert.throws(() => sceneWith({ chunks: 20, resolution: 64 }, { eye: [0, 5, 5], target: [0, 0, 0] }), /maxVertices|vertices/);
  assert.throws(() => sceneWith({ octaves: null }, { eye: [0, 5, 5], target: [0, 0, 0] }), /octaves/);
});

test('the documented limits hold', () => {
  assert.deepEqual(TERRAIN_LIMITS.resolution, [2, 499]);
  assert.ok((TERRAIN_LIMITS.resolution[1] + 1) ** 2 <= MAX_VERTICES);
  assert.ok((TERRAIN_LIMITS.resolution[1] + 2) ** 2 > MAX_VERTICES);
  assert.doesNotThrow(() => terrainVertexEstimate({ resolution: 499 }));
});

test('scene_create accepts the terrain noise and chunk fields through the tool schema', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createAgentRuntime } = await import('../scripts/agent-runtime.mjs');
  const { createAgentMcpServer } = await import('../scripts/mcp-server.mjs');
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192 });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'terrain-noise-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const recipe = {
      format: 'crucible.scene', schemaVersion: 1,
      geometries: [{ id: 'ground', type: 'terrain', size: 300, resolution: 16, chunks: 4, levels: 3, featureSize: 60, octaves: 4, warp: 20, ridged: true, mountainAmplitude: 50 }],
      materials: [{ id: 'earth', color: [0.4, 0.4, 0.3] }],
      nodes: [{ id: 'land', geometry: 'ground', material: 'earth' }],
      camera: { eye: [0, 60, 200], target: [0, 10, 0] },
    };
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  } finally {
    await client.close();
    await mcp.close();
    await runtime.close();
  }
});
