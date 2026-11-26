import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { resolveEffects } from '../src/effects.js';
import { createPostFragment, KEEP_HUE_STEP, POST_STEPS } from '../src/post.js';
import '../src/auto-exposure.js';
import '../src/bloom-keep-hue.js';
import '../src/linear-output-shader.js';
import { decodePngPixels } from './support/png-pixels.mjs';

// Bloom keeps the hue of an emissive part when asked (#3326): a bright red or blue cube on a grey wall keeps a saturated face and a halo of its own colour, and a scene that does not ask draws as before.

test('keepHue is absent from resolved bloom unless it is true, so a scene that does not ask resolves as before', () => {
  assert.deepEqual(Object.keys(resolveEffects({ bloom: { strength: 0.5 } }).bloom), ['strength', 'threshold', 'radius']);
  assert.deepEqual(Object.keys(resolveEffects({ bloom: { strength: 0.5, keepHue: false } }).bloom), ['strength', 'threshold', 'radius']);
  assert.equal(resolveEffects({ bloom: { strength: 0.5, keepHue: true } }).bloom.keepHue, true);
});

test('keepHue rejects anything but true or false and says what to pass', () => {
  assert.throws(() => resolveEffects({ bloom: { strength: 0.5, keepHue: 1 } }), /Bloom keepHue must be true or false, got 1\./);
});

test('keepHue builds together with auto exposure and linear output, and the exposure scales the emissive peak', () => {
  const steps = [...POST_STEPS, KEEP_HUE_STEP, 'autoExposure'];
  const source = createPostFragment(steps);
  assert.match(source, /uniform float autoExposureScale;/);
  assert.match(source, /uniform float bloomKeepHue;/);
  assert.match(source, /float sourcePeak = max\(color\.r, max\(color\.g, color\.b\)\) \* autoExposureScale;/);
  assert.doesNotThrow(() => createPostFragment([...steps, 'linearOutput']));
  assert.match(createPostFragment([...POST_STEPS, KEEP_HUE_STEP]), /float sourcePeak = max\(color\.r, max\(color\.g, color\.b\)\);/);
});

test('only the keepHue program holds the keepHue code, every other post program keeps its source', () => {
  assert.doesNotMatch(createPostFragment(POST_STEPS), /bloomKeepHue/);
  assert.doesNotMatch(createPostFragment([...POST_STEPS, 'autoExposure']), /bloomKeepHue/);
  assert.match(createPostFragment([...POST_STEPS, KEEP_HUE_STEP]), /uniform float bloomKeepHue;/);
});

const WIDTH = 1080;
const HEIGHT = 1920;
const NAMES = ['red', 'blue', 'white'];
const SOURCE_HUES = [0, 240, null];
const directories = [];
const sessions = new Map();
async function server() {
  if (sessions.has('server')) return sessions.get('server');
  const directory = await mkdtemp(join(tmpdir(), 'crucible-bloom-keep-hue-'));
  directories.push(directory);
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 512, jobs: join(directory, 'jobs') });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'bloom-keep-hue-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const entry = { client, close: async () => { await client.close(); await mcp.close(); await runtime.close(); } };
  sessions.set('server', entry);
  return entry;
}
after(async () => {
  if (sessions.has('server')) await sessions.get('server').close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 300000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

const emissiveMaterials = () => [[1, 0, 0], [0, 0, 1], [1, 1, 1]].map((emissiveColor, index) => ({ id: NAMES[index], color: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5, emission: 8, emissiveColor }));

// The #3326 scene: a red, a blue and a white emissive cube on a mid-grey wall at exposure 1. The base is a lit grey, which is the light on a neon face besides the glow that turned it pastel.
async function renderCubes(bloom, materials = emissiveMaterials()) {
  const { client } = await server();
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [
      { id: 'wall', color: [0.2, 0.2, 0.2], metallic: 0, roughness: 0.9 },
      ...materials,
    ],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'wall', translation: [0, 0, -0.6], scale: [12, 14, 0.1] },
      ...NAMES.map((name, index) => ({ id: name, geometry: 'box', material: name, translation: [index - 1, 0, 0], scale: [0.5, 0.5, 0.5] })),
    ],
    camera: { eye: [0, 0, 30], target: [0, 0, 0], fov: 11.3 },
    environment: { world: false, keyIntensity: 0, ambientIntensity: 0.65, ambientColor: [1, 1, 1], skyTop: [0.5, 0.5, 0.5], skyBottom: [0.5, 0.5, 0.5] },
    effects: bloom ? { exposure: 1, bloom } : { exposure: 1 },
  };
  const created = await call(client, 'scene_create', { recipe });
  const submitted = await call(client, 'scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'image', width: WIDTH, height: HEIGHT } });
  for (let attempt = 0; attempt < 3000; attempt++) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  return decodePngPixels(await readFile(result.artifacts[0].path));
}

function pixelAt(image, column, row) {
  const offset = (row * image.width + column) * image.channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function saturationOf([red, green, blue]) {
  const peak = Math.max(red, green, blue);
  return peak === 0 ? 0 : (peak - Math.min(red, green, blue)) / peak;
}

const lumaOf = ([red, green, blue]) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;

function hueOf([red, green, blue]) {
  const peak = Math.max(red, green, blue);
  const spread = peak - Math.min(red, green, blue);
  if (spread === 0) return 0;
  const sector = peak === red ? ((green - blue) / spread + 6) % 6 : peak === green ? (blue - red) / spread + 2 : (red - green) / spread + 4;
  return sector * 60;
}

const hueDistance = (first, second) => Math.min(Math.abs(first - second) % 360, 360 - (Math.abs(first - second) % 360));

// The box of each cube in the bloom-off picture: the pixels that differ from the wall, split into three column bands.
function cubeBoxes(off) {
  const wall = pixelAt(off, 20, 20);
  return NAMES.map((name, index) => {
    const box = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
    for (let row = 0; row < HEIGHT; row++) {
      for (let column = index * 360; column < (index + 1) * 360; column++) {
        const pixel = pixelAt(off, column, row);
        if (Math.abs(lumaOf(pixel) - lumaOf(wall)) > 25 || Math.abs(pixel[0] - wall[0]) + Math.abs(pixel[2] - wall[2]) > 90) {
          box.left = Math.min(box.left, column);
          box.right = Math.max(box.right, column);
          box.top = Math.min(box.top, row);
          box.bottom = Math.max(box.bottom, row);
        }
      }
    }
    return box;
  });
}

function averageOf(pixels) {
  return pixels.reduce((sum, pixel) => sum.map((value, channel) => value + pixel[channel] / pixels.length), [0, 0, 0]);
}

// The #3326 numbers of one cube: the ring 8 px outside the box (rise in luma), the mean face saturation, the wall 200 px above the box (rise) and the hue of the light bloom added to the ring.
function measureCube(off, on, box) {
  const ringOn = [];
  const ringOff = [];
  const face = [];
  for (let row = box.top - 8; row <= box.bottom + 8; row++) {
    for (let column = box.left - 8; column <= box.right + 8; column++) {
      const inside = column >= box.left && column <= box.right && row >= box.top && row <= box.bottom;
      const onRing = !inside && (column < box.left - 7 || column > box.right + 7 || row < box.top - 7 || row > box.bottom + 7);
      if (onRing) {
        ringOn.push(pixelAt(on, column, row));
        ringOff.push(pixelAt(off, column, row));
      }
      if (inside) face.push(pixelAt(on, column, row));
    }
  }
  const middle = (box.left + box.right) >> 1;
  const farOn = [];
  const farOff = [];
  for (let column = middle - 20; column <= middle + 20; column++) {
    farOn.push(pixelAt(on, column, box.top - 200));
    farOff.push(pixelAt(off, column, box.top - 200));
  }
  const meanOff = averageOf(ringOff);
  const added = averageOf(ringOn).map((value, channel) => Math.max(0, value - meanOff[channel]));
  return {
    ringRise: lumaOf(averageOf(ringOn)) - lumaOf(meanOff),
    faceSaturation: face.reduce((sum, pixel) => sum + saturationOf(pixel), 0) / face.length,
    wallRise: lumaOf(averageOf(farOn)) - lumaOf(averageOf(farOff)),
    addedHue: hueOf(added),
  };
}

test('bloom with keepHue meets the #3326 targets on a red, a blue and a white cube, which plain bloom misses on face saturation', { timeout: 900000 }, async () => {
  const bloom = { strength: 1, threshold: 1, radius: 16 };
  const off = await renderCubes(null);
  const boxes = cubeBoxes(off);
  const plain = await renderCubes(bloom);
  const keeping = await renderCubes({ ...bloom, keepHue: true });
  NAMES.forEach((name, index) => {
    const before = measureCube(off, plain, boxes[index]);
    const after = measureCube(off, keeping, boxes[index]);
    assert.ok(after.ringRise >= 30, `${name} ring rises at least 30 levels, got ${after.ringRise}`);
    assert.ok(after.wallRise <= 10, `${name} wall 200 px away rises at most 10, got ${after.wallRise}`);
    if (SOURCE_HUES[index] === null) {
      assert.ok(after.faceSaturation < 0.1, `the white face stays white, got ${after.faceSaturation}`);
      return;
    }
    assert.ok(before.faceSaturation < 0.3, `${name} plain bloom leaves a pastel face, saturation ${before.faceSaturation}`);
    assert.ok(after.faceSaturation >= 0.5, `${name} keepHue keeps the face saturated, got ${after.faceSaturation}`);
    assert.ok(hueDistance(after.addedHue, SOURCE_HUES[index]) <= 15, `${name} halo hue ${after.addedHue} is within 15 degrees of ${SOURCE_HUES[index]}`);
  });
});

test('keepHue false draws the same pixels as no keepHue, and keepHue with bloom off changes nothing', { timeout: 900000 }, async () => {
  const plain = await renderCubes({ strength: 0.5, threshold: 1, radius: 4 });
  const explicitFalse = await renderCubes({ strength: 0.5, threshold: 1, radius: 4, keepHue: false });
  assert.deepEqual(explicitFalse.data, plain.data);
  const offPlain = await renderCubes({ strength: 0 });
  const offKeeping = await renderCubes({ strength: 0, keepHue: true });
  assert.deepEqual(offKeeping.data, offPlain.data);
});

test('neon preset with keepHue meets the #3326 targets at exposure 1 without scene-wide exposure changes', { timeout: 900000 }, async () => {
  const neonColors = [[0.9, 0.15, 0.1], [0.1, 0.35, 1], [1, 1, 1]];
  const expectedHues = [hueOf(neonColors[0]), hueOf(neonColors[1]), null];
  const neonMaterials = neonColors.map((color, index) => ({ id: NAMES[index], preset: 'neon', color }));
  const bloom = { strength: 1, threshold: 1, radius: 16 };
  const off = await renderCubes(null, neonMaterials);
  const boxes = cubeBoxes(off);
  const plain = await renderCubes(bloom, neonMaterials);
  const keeping = await renderCubes({ ...bloom, keepHue: true }, neonMaterials);
  NAMES.forEach((name, index) => {
    const before = measureCube(off, plain, boxes[index]);
    const after = measureCube(off, keeping, boxes[index]);
    assert.ok(after.ringRise >= 30, `${name} neon ring rises at least 30 levels, got ${after.ringRise}`);
    assert.ok(after.wallRise <= 10, `${name} neon wall 200 px away rises at most 10, got ${after.wallRise}`);
    if (expectedHues[index] === null) {
      assert.ok(after.faceSaturation < 0.1, `the white neon face stays white, got ${after.faceSaturation}`);
      return;
    }
    assert.ok(before.faceSaturation < 0.2, `${name} plain bloom washes neon face pastel, saturation ${before.faceSaturation}`);
    assert.ok(after.faceSaturation >= 0.5, `${name} keepHue keeps neon face saturated, got ${after.faceSaturation}`);
    assert.ok(hueDistance(after.addedHue, expectedHues[index]) <= 15, `${name} neon halo hue ${after.addedHue} is within 15 degrees of ${expectedHues[index]}`);
  });
});
