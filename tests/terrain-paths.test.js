import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadAllAgentSceneModules, createAgentScene } from '../src/agent-scene.js';
import { createTerrain } from '../src/terrain.js';
import { createRecipeTerrain, generateTerrainGeometry, terrainVertexEstimate } from '../src/agent-terrain.js';
import { createTerrainPaths, normalizeTerrainPaths, TERRAIN_PATH_LIMITS } from '../src/terrain-paths.js';

await loadAllAgentSceneModules();

const MAX_VERTICES = 250_000;
const hillHeight = (x, z) => 3 * Math.sin(x * 0.11) + 2 * Math.cos(z * 0.07);
const ROAD = { name: 'road', points: [[-40, -10], [0, 10], [40, -10]], width: 6, depth: 0.5, falloff: 4, smooth: false };
// Unit vector across the first segment of ROAD, which runs from (-40, -10) to (0, 10).
const ACROSS = [10 / Math.hypot(20, 10), -20 / Math.hypot(20, 10)];

function positionHash(geometry) {
  return createHash('sha256').update(Buffer.from(geometry.positions.buffer, geometry.positions.byteOffset, geometry.positions.byteLength)).digest('hex');
}

function offsetFromCentre(distance) {
  return [-20 + ACROSS[0] * distance, 0 + ACROSS[1] * distance];
}

test('the bed across the width is the centre-line height minus depth, and the hills return past the falloff', () => {
  const carved = createTerrainPaths([ROAD], hillHeight);
  const footHeight = hillHeight(-20, 0);
  assert.ok(Math.abs(carved.height(-20, 0) - (footHeight - 0.5)) < 1e-9);
  assert.ok(Math.abs(carved.height(...offsetFromCentre(2.9)) - (footHeight - 0.5)) < 1e-9, 'inside half the width the bed is flat across');
  const beyond = offsetFromCentre(8);
  assert.equal(carved.height(...beyond), hillHeight(...beyond), 'past width / 2 + falloff the ground is untouched');
  assert.equal(carved.height(200, 200), hillHeight(200, 200));
  const edge = offsetFromCentre(5);
  const edgeHeight = carved.height(...edge);
  assert.ok(edgeHeight > footHeight - 0.5 && edgeHeight < hillHeight(...edge), 'the falloff blends between the bed and the hills');
});

test('crown raises the middle, ruts cut two grooves and the shoulder raises a lip', () => {
  const flat = () => 0;
  const base = { points: [[-30, 0], [30, 0]], width: 8, depth: 0.4, falloff: 6 };
  const plain = createTerrainPaths([base], flat);
  const crowned = createTerrainPaths([{ ...base, crown: 0.2 }], flat);
  const rutted = createTerrainPaths([{ ...base, ruts: 0.1 }], flat);
  const shouldered = createTerrainPaths([{ ...base, shoulder: 0.3 }], flat);
  assert.ok(Math.abs(crowned.height(0, 0) - plain.height(0, 0) - 0.2) < 1e-9);
  assert.equal(crowned.height(0, 4), plain.height(0, 4));
  assert.ok(Math.abs(plain.height(0, 1.8) - rutted.height(0, 1.8) - 0.1) < 1e-9, 'a rut sits at 0.225 of the width on each side');
  assert.ok(Math.abs(plain.height(0, -1.8) - rutted.height(0, -1.8) - 0.1) < 1e-9);
  assert.ok(plain.height(0, 0) - rutted.height(0, 0) < 0.02, 'the centre line holds only the tail of the two ruts');
  assert.ok(shouldered.height(0, 7) > plain.height(0, 7) + 0.1, 'a lip beside the road');
  assert.equal(shouldered.height(0, 20), 0);
});

test('with crown 0 the strip between two ruts is no higher than the bed and no wider than a rut', () => {
  const flat = () => 0;
  const road = createTerrainPaths([{ points: [[-30, 0], [30, 0]], width: 2.4, depth: 0.3, falloff: 1.2, ruts: 0.35 }], flat);
  const bed = -0.3;
  assert.ok(road.height(0, 0) <= bed + 1e-9, 'the centre is no higher than the bed');
  const halfDepth = bed - 0.35 / 2;
  const widthBelow = (from, to) => {
    let width = 0;
    for (let offset = from; offset < to; offset += 0.005) width += road.height(0, offset) < halfDepth ? 0.005 : 0;
    return width;
  };
  const rutWidth = widthBelow(0.2, 1.2);
  const ridgeWidth = 1.08 - rutWidth;
  assert.ok(rutWidth > 0.3, `rut width ${rutWidth}`);
  assert.ok(ridgeWidth <= rutWidth * 1.25, `the ridge between the ruts is ${ridgeWidth} m against a ${rutWidth} m rut`);
});

test('the mask is 1 across the width, fades beside it and is 0 far away; a name picks one path', () => {
  const carved = createTerrainPaths([ROAD, { name: 'trail', points: [[0, 30], [30, 30]], width: 2, falloff: 2 }], hillHeight);
  for (const along of [0, 0.3, 0.7, 1]) {
    assert.equal(carved.maskAt('road', -40 + 40 * along, -10 + 20 * along), 1);
  }
  assert.equal(carved.maskAt('road', 100, 100), 0);
  assert.equal(carved.maskAt('road', 15, 30), 0, 'the trail is not in the road mask');
  assert.equal(carved.maskAt('trail', 15, 30), 1);
  assert.equal(carved.maskAt(undefined, 15, 30), 1, 'no name is the strongest of all paths');
  const fading = carved.maskAt('road', ...offsetFromCentre(4));
  assert.ok(fading > 0 && fading < 1, `fade ${fading}`);
  assert.deepEqual(carved.maskNames, ['road', 'trail']);
  assert.throws(() => carved.maskAt('river', 0, 0), /river.*road, trail/s);
});

test('a terrain carves the ground its mesh and heightAt report, and the mask image covers the path', () => {
  const record = { size: 100, resolution: 100, seed: 4, amplitude: 2, paths: [{ name: 'road', points: [[-45, 0], [45, 0]], width: 6, depth: 0.4, falloff: 4 }] };
  const plain = createRecipeTerrain({ ...record, paths: undefined });
  const carved = createRecipeTerrain(record);
  for (const x of [-30, -3, 10, 28]) {
    assert.ok(Math.abs(carved.heightAt(x, 0) - (plain.heightAt(x, 0) - 0.4)) < 0.15, `x ${x}: ${carved.heightAt(x, 0)} vs ${plain.heightAt(x, 0)}`);
    assert.ok(carved.heightAt(x, 0) < plain.heightAt(x, 0) - 0.2);
  }
  assert.equal(carved.heightAt(0, 40), plain.heightAt(0, 40));
  assert.equal(plain.pathMasks, null);
  assert.deepEqual(carved.pathMasks.names, ['road']);
  assert.equal(carved.pathMasks.at('road', 20, 1), 1);
  const image = carved.pathMasks.image('road', 100);
  assert.deepEqual(image.bounds, [-50, -50, 50, 50]);
  assert.equal(image.width * image.height * 4, image.data.length);
  const pixel = (x, z) => image.data[(Math.floor(z + 50) * 100 + Math.floor(x + 50)) * 4];
  assert.equal(pixel(-20, 0), 255, 'the road is covered');
  assert.equal(pixel(20, -1), 255);
  assert.equal(pixel(0, 30), 0, 'the hills are not');
  assert.throws(() => carved.pathMasks.image('road', 1), /resolution.*from 2 to 2048/s);
});

test('the same seed and points give the same heights byte for byte, and an empty list leaves the ground alone', () => {
  const record = { type: 'terrain', size: 120, resolution: 60, seed: 11, amplitude: 5, paths: [ROAD, { points: [[0, -50], [10, 50]], width: 4, ruts: 0.1, crown: 0.1, shoulder: 0.1 }] };
  const first = positionHash(generateTerrainGeometry(record, MAX_VERTICES));
  assert.equal(positionHash(generateTerrainGeometry(structuredClone(record), MAX_VERTICES)), first);
  const without = positionHash(generateTerrainGeometry({ ...record, paths: undefined }, MAX_VERTICES));
  assert.notEqual(first, without);
  assert.equal(positionHash(generateTerrainGeometry({ ...record, paths: [] }, MAX_VERTICES)), without);
  const direct = createTerrain({ size: 120, chunks: 1, levels: 1, resolution: 60, seed: 11, height: { amplitude: 5, featureSize: 30, warp: 0, mountainMask: () => 0 }, paths: record.paths });
  assert.equal(positionHash(generateTerrainGeometry(record, MAX_VERTICES)), positionHash(direct.parts[0].geometry));
});

test('chunked terrain carves the same ground as a single chunk', () => {
  const paths = [{ points: [[-90, 20], [90, -20]], width: 8, depth: 1 }];
  const single = createRecipeTerrain({ size: 200, resolution: 64, seed: 5, amplitude: 6, paths });
  const chunked = createRecipeTerrain({ size: 200, resolution: 16, chunks: 4, levels: 1, seed: 5, amplitude: 6, paths });
  assert.equal(chunked.heightAt(12, -4), single.heightAt(12, -4));
});

test('path fields name what to pass when they are wrong', () => {
  const points = [[0, 0], [5, 5]];
  const cases = [
    [{ paths: 'road' }, /terrain\.paths.*list of at most 16/s],
    [{ paths: Array(17).fill({ points }) }, /terrain\.paths.*at most 16/s],
    [{ paths: [null] }, /terrain\.paths\[0\].*such as/s],
    [{ paths: [{}] }, /paths\[0\]\.points.*2 to 256 points/s],
    [{ paths: [{ points: [[0, 0]] }] }, /points.*2 to 256/s],
    [{ paths: [{ points: Array(257).fill([0, 0]) }] }, /257 points.*2 to 256/s],
    [{ paths: [{ points: [[0, 0], [1]] }] }, /points\[1\].*\[x, z\]/s],
    [{ paths: [{ points: [[0, 0], [NaN, 1]] }] }, /points\[1\].*\[x, z\]/s],
    [{ paths: [{ points, width: 0 }] }, /width.*from 0\.1 to 200/s],
    [{ paths: [{ points, depth: 21 }] }, /depth.*from 0 to 20/s],
    [{ paths: [{ points, falloff: -1 }] }, /falloff.*from 0 to 200/s],
    [{ paths: [{ points, ruts: 3 }] }, /ruts.*from 0 to 2/s],
    [{ paths: [{ points, crown: 'high' }] }, /crown.*from 0 to 2/s],
    [{ paths: [{ points, shoulder: 5 }] }, /shoulder.*from 0 to 2/s],
    [{ paths: [{ points, colour: 1 }] }, /colour.*one of the path fields/s],
    [{ paths: [{ points, name: '' }] }, /name.*1 to 64/s],
    [{ paths: [{ points, name: 'a' }, { points, name: 'a' }] }, /paths\[1\]\.name.*no other path/s],
  ];
  for (const [change, message] of cases) {
    assert.throws(() => terrainVertexEstimate({ type: 'terrain', ...change }), message, JSON.stringify(change).slice(0, 80));
  }
  assert.deepEqual(TERRAIN_PATH_LIMITS.points, [2, 256]);
  assert.equal(normalizeTerrainPaths([{ points, width: 5 }])[0].falloff, 5, 'falloff defaults to the width');
});

test('a scene with a path draws the carved ground and rejects bad paths at the boundary', () => {
  const recipe = paths => ({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', size: 60, resolution: 30, seed: 2, amplitude: 3, ...(paths ? { paths } : {}) }],
    materials: [{ id: 'grass', color: [0.3, 0.5, 0.2] }],
    nodes: [{ id: 'hills', geometry: 'ground', material: 'grass' }],
    camera: { eye: [0, 20, 40], target: [0, 0, 0] },
  });
  const roadPaths = [{ points: [[-30, 0], [30, 0]], width: 6, depth: 0.5 }];
  const plain = createAgentScene(recipe(undefined));
  const carved = createAgentScene(recipe(roadPaths));
  assert.notEqual(positionHash(carved.parts[0].geometry), positionHash(plain.parts[0].geometry));
  assert.throws(() => createAgentScene(recipe([{ points: [[0, 0]] }])), /paths\[0\]\.points/);
});

test('scene_create accepts terrain paths through the tool schema', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createAgentRuntime } = await import('../scripts/agent-runtime.mjs');
  const { createAgentMcpServer } = await import('../scripts/mcp-server.mjs');
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192 });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'terrain-paths-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const recipe = {
      format: 'crucible.scene', schemaVersion: 1,
      geometries: [{ id: 'ground', type: 'terrain', size: 100, resolution: 32, paths: [{ points: [[-40, 0], [40, 5]], width: 4, depth: 0.3, ruts: 0.05 }] }],
      materials: [{ id: 'earth', color: [0.4, 0.4, 0.3] }],
      nodes: [{ id: 'land', geometry: 'ground', material: 'earth' }],
      camera: { eye: [0, 30, 60], target: [0, 0, 0] },
    };
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  } finally {
    await client.close();
    await mcp.close();
    await runtime.close();
  }
});

test('smoothing bends the centre line through the points, and smooth false keeps straight segments', () => {
  const corner = [[-30, 0], [0, 0], [0, 30]];
  const smooth = createTerrainPaths([{ points: corner, width: 4 }], () => 0);
  const straight = createTerrainPaths([{ points: corner, width: 4, smooth: false }], () => 0);
  assert.equal(smooth.maskAt(undefined, -30, 0), 1);
  assert.equal(smooth.maskAt(undefined, 0, 0), 1, 'the curve passes through a point');
  assert.notDeepEqual(
    Array.from({ length: 20 }, (_, index) => smooth.maskAt(undefined, -8 + index * 0.4, 1.7)),
    Array.from({ length: 20 }, (_, index) => straight.maskAt(undefined, -8 + index * 0.4, 1.7)),
    'the smoothed bend differs from the polyline',
  );
  assert.throws(() => normalizeTerrainPaths([{ points: corner, smooth: 'yes' }]), /smooth.*true or false/s);
});

test('a long smoothed path samples quickly through the segment grid', () => {
  const points = Array.from({ length: 256 }, (_, index) => [-900 + index * 7, 200 * Math.sin(index / 9)]);
  const carved = createTerrainPaths([{ points, width: 6, falloff: 4 }], () => 0);
  const started = performance.now();
  let covered = 0;
  for (let row = 0; row < 200; row++) {
    for (let column = 0; column < 200; column++) covered += carved.maskAt(undefined, -900 + column * 9, -250 + row * 2.5) > 0 ? 1 : 0;
  }
  assert.ok(covered > 100);
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms for 40000 samples`);
});
