import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mat4 } from 'gl-matrix';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { decodePngPixels } from './support/png-pixels.mjs';

// Real pixels from the preview on the cpu backend: what ambientColor and sunRays do to a frame, not what their shader text says (#3235).

const SIZE = 192;
const EYE = [0, 2.5, 7];
const TARGET = [0, 0.8, 0];
const FIELD_OF_VIEW = 50;

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-environment-pixels-'));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'environment-pixels-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close?.();
  });
  return client;
}

async function frameOf(client, environment, effects = {}, pillarColor = [0.8, 0.8, 0.8], extra = { geometries: [], materials: [], nodes: [] }) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, ...extra.geometries],
    materials: [{ id: 'ground', color: [0.8, 0.8, 0.8] }, { id: 'pillar', color: pillarColor }, ...extra.materials],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'ground', translation: [0, -0.1, 0], scale: [14, 0.2, 14] },
      { id: 'pillar', geometry: 'box', material: 'pillar', translation: [0, 1, 0], scale: [1, 2, 1] },
      ...extra.nodes,
    ],
    camera: { eye: EYE, target: TARGET, fov: FIELD_OF_VIEW },
    environment: { ground: false, ...environment },
    effects,
  };
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const look = await client.callTool({ name: 'scene_look', arguments: { sessionId: created.structuredContent.sessionId, width: SIZE, height: SIZE } }, { timeout: 120000 });
  assert.equal(look.isError, undefined, look.content?.[0]?.text);
  const image = look.content.find(item => item.type === 'image');
  await client.callTool({ name: 'scene_dispose', arguments: { sessionId: created.structuredContent.sessionId } });
  return decodePngPixels(Buffer.from(image.data, 'base64'));
}

function pixelOf(point) {
  const projection = mat4.perspective(mat4.create(), FIELD_OF_VIEW * Math.PI / 180, 1, 0.1, 500);
  const matrix = mat4.multiply(mat4.create(), projection, mat4.lookAt(mat4.create(), EYE, TARGET, [0, 1, 0]));
  const clip = [0, 1, 3].map(row => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12]);
  return [Math.round((clip[0] / clip[2] * 0.5 + 0.5) * SIZE), Math.round((1 - (clip[1] / clip[2] * 0.5 + 0.5)) * SIZE)];
}

function meanColor(picture, [x, y], radius = 3) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let row = y - radius; row <= y + radius; row++) {
    for (let column = x - radius; column <= x + radius; column++) {
      const offset = (row * picture.width + column) * picture.channels;
      for (let channel = 0; channel < 3; channel++) sum[channel] += picture.data[offset + channel] / 255;
      count++;
    }
  }
  return sum.map(value => value / count);
}

const SUN_BEHIND_CAMERA_RIGHT = [0.5, 0.8, 0.3];
const SHADOW_POINT = [-1.6, 0, -0.9];
const LIT_POINT = [2.5, 0, 1.5];

test('ambientColor tints the shadow of a pillar and leaves the sunlit floor as it was', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const sun = { setup: 'daylight', lightDirection: SUN_BEHIND_CAMERA_RIGHT };
  const plain = await frameOf(client, sun);
  const filled = await frameOf(client, { ...sun, ambientColor: [0.9, 0.1, 0.1] });
  const litBefore = meanColor(plain, pixelOf(LIT_POINT));
  const litAfter = meanColor(filled, pixelOf(LIT_POINT));
  const shadowBefore = meanColor(plain, pixelOf(SHADOW_POINT));
  const shadowAfter = meanColor(filled, pixelOf(SHADOW_POINT));
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(litAfter[channel] - litBefore[channel]) < 0.01, `sunlit floor channel ${channel} moved from ${litBefore[channel]} to ${litAfter[channel]}`);
  }
  assert.ok(shadowBefore[0] < litBefore[0] - 0.05, 'the test point is in shadow');
  assert.ok(shadowAfter[0] - shadowBefore[0] > 0.08, `the shadow takes the red fill: ${shadowBefore[0]} to ${shadowAfter[0]}`);
  assert.ok(shadowAfter[0] - shadowAfter[2] > shadowBefore[0] - shadowBefore[2] + 0.08, 'the shadow turns red, not just brighter');
});

test('sunRays only add light, brightest at the sun, and nothing for a sun behind the camera', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const towardSun = [0.0, 0.12, -1];
  const sun = { setup: 'daylight', lightDirection: towardSun, keyIntensity: 1.4 };
  const plain = await frameOf(client, sun);
  const rays = await frameOf(client, sun, { sunRays: { intensity: 1.5, spread: 0.8 } });
  let darker = 0;
  let addedTotal = 0;
  const added = new Float64Array(SIZE * SIZE);
  for (let pixel = 0; pixel < SIZE * SIZE; pixel++) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) difference += (rays.data[pixel * rays.channels + channel] - plain.data[pixel * plain.channels + channel]) / 255;
    added[pixel] = difference;
    addedTotal += Math.max(difference, 0);
    if (difference < -0.012) darker++;
  }
  assert.equal(darker, 0, 'the rays never darken a pixel, so there is no dark halo');
  assert.ok(addedTotal > 5, `the rays add light to the frame (${addedTotal})`);
  const sunPixel = pixelOf([EYE[0] + towardSun[0] * 1e4, EYE[1] + towardSun[1] * 1e4, EYE[2] + towardSun[2] * 1e4]);
  const around = (center, radius) => {
    let sum = 0;
    for (let row = center[1] - radius; row <= center[1] + radius; row++) {
      for (let column = center[0] - radius; column <= center[0] + radius; column++) sum += added[row * SIZE + column];
    }
    return sum;
  };
  const awayFromSun = [SIZE - sunPixel[0], Math.min(SIZE - 8, SIZE - sunPixel[1] + 60)];
  assert.ok(around(sunPixel, 6) > 3 * Math.max(around(awayFromSun, 6), 0.01), 'the glow is centred on the sun\'s projected position, not elsewhere');
  const behind = { setup: 'daylight', lightDirection: [0.0, 0.12, 1], keyIntensity: 1.4 };
  const behindPlain = await frameOf(client, behind);
  const behindRays = await frameOf(client, behind, { sunRays: { intensity: 1.5, spread: 0.8 } });
  assert.deepEqual(Array.from(behindRays.data), Array.from(behindPlain.data), 'a sun behind the camera leaves the frame byte for byte');
});

test('saturation keeps a leaf green off the clip while it adds chroma', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const leaf = [0.12, 0.45, 0.14];
  const environment = { setup: 'daylight', lightDirection: SUN_BEHIND_CAMERA_RIGHT };
  const plain = await frameOf(client, environment, {}, leaf);
  const graded = await frameOf(client, environment, { colorCorrection: { saturation: 0.6 } }, leaf);
  const faceCentre = pixelOf([0, 1, 0.5]);
  const [redBefore, greenBefore, blueBefore] = meanColor(plain, faceCentre);
  const [redAfter, greenAfter, blueAfter] = meanColor(graded, faceCentre);
  const chroma = (red, green, blue) => Math.max(red, green, blue) - Math.min(red, green, blue);
  assert.ok(chroma(redAfter, greenAfter, blueAfter) > chroma(redBefore, greenBefore, blueBefore) + 0.02, 'saturation adds chroma');
  assert.ok(Math.min(redAfter, blueAfter) > 0.03, `the lowest channel does not clip to black (${Math.min(redAfter, blueAfter)})`);
  assert.ok(Math.min(redAfter, blueAfter) > 0.5 * Math.min(redBefore, blueBefore), 'the lowest channel keeps at least half of its level');
});

test('a face the sun reaches at a grazing angle takes no ambientColor fill', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const sun = { setup: 'daylight', lightDirection: SUN_BEHIND_CAMERA_RIGHT };
  const plain = await frameOf(client, sun);
  const filled = await frameOf(client, { ...sun, ambientColor: [0.9, 0.55, 0.3] });
  // the pillar's front face has the normal [0, 0, 1], so the sun reaches it with N.L of about 0.3
  const before = meanColor(plain, pixelOf([0, 1, 0.5]));
  const after = meanColor(filled, pixelOf([0, 1, 0.5]));
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(after[channel] - before[channel]) < 0.012, `sunlit face channel ${channel} moved from ${before[channel]} to ${after[channel]}`);
  }
});

test('crowns in front of the sun keep sunRays additive and leave no dark ring around them', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const towardSun = [0.0, 0.12, -1];
  const sun = { setup: 'daylight', lightDirection: towardSun, keyIntensity: 1.4 };
  const distance = 10;
  const crown = {
    geometries: [{ id: 'ball', type: 'sphere' }],
    materials: [{ id: 'leaf', color: [0.1, 0.6, 0.2] }],
    nodes: [{ id: 'crown', geometry: 'ball', material: 'leaf', translation: EYE.map((value, axis) => value + towardSun[axis] * distance), scale: [3, 3, 3] }],
  };
  const plain = await frameOf(client, sun, {}, [0.8, 0.8, 0.8], crown);
  const rays = await frameOf(client, sun, { sunRays: { intensity: 1.5, spread: 0.8 } }, [0.8, 0.8, 0.8], crown);
  const channelCount = plain.channels;
  const isCrown = pixel => (plain.data[pixel * channelCount + 1] - plain.data[pixel * channelCount]) / 255 > 0.08;
  const skyColour = [0, 1, 2].map(channel => plain.data[channel]);
  const isSky = pixel => [0, 1, 2].every(channel => Math.abs(plain.data[pixel * channelCount + channel] - skyColour[channel]) < 8);
  const distanceToCrown = new Float64Array(SIZE * SIZE).fill(Infinity);
  const crownPixels = [];
  for (let pixel = 0; pixel < SIZE * SIZE; pixel++) if (isCrown(pixel)) crownPixels.push(pixel);
  assert.ok(crownPixels.length > 800, `the crown covers the sun (${crownPixels.length} pixels)`);
  let darker = 0;
  let ringSum = 0;
  let ringCount = 0;
  let farSum = 0;
  let farCount = 0;
  for (let pixel = 0; pixel < SIZE * SIZE; pixel++) {
    let added = 0;
    for (let channel = 0; channel < 3; channel++) added += (rays.data[pixel * channelCount + channel] - plain.data[pixel * channelCount + channel]) / 255;
    if (added < -0.012) darker++;
    if (!isSky(pixel)) continue;
    const row = Math.floor(pixel / SIZE);
    const column = pixel % SIZE;
    let nearest = Infinity;
    for (const crownPixel of crownPixels) {
      nearest = Math.min(nearest, Math.hypot(row - Math.floor(crownPixel / SIZE), column - crownPixel % SIZE));
    }
    distanceToCrown[pixel] = nearest;
    if (nearest <= 4) { ringSum += added; ringCount++; }
    if (nearest > 15) { farSum += added; farCount++; }
  }
  assert.equal(darker, 0, 'the rays never darken a pixel, with the crown in front of the sun too');
  assert.ok(ringCount > 100 && farCount > 100, `ring ${ringCount} and far ${farCount} sky pixels to compare`);
  const ring = ringSum / ringCount;
  const far = farSum / farCount;
  assert.ok(far > 0.02, `the far sky takes the glow (${far})`);
  assert.ok(ring > 0.7 * far, `the sky next to the crown gets as much glow as the sky away from it, so no dark ring: ${ring} against ${far}`);
});
