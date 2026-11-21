// Proves ID mattes through the real MCP runtime: a render job with settings.mattes writes one gray PNG per matte, white exactly
// where the object ID pass shows the named part (and where the Cryptomatte pass shows the named material), and refuses an unknown name.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createScratchDirectory } from './scratch-directory.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await createScratchDirectory('crucible-mcp-mattes-');
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-mattes-proof', version: '1' });
const SIZE = 160;

async function call(name, argumentsValue = {}, timeout = 60000) {
  return client.callTool({ name, arguments: argumentsValue }, { timeout });
}

async function finished(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(100);
  }
  throw new Error('Job did not finish within 120 seconds.');
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

// Reads an 8-bit RGB or RGBA PNG, the only kind these jobs write.
function decodePng(bytes) {
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType: data[9] };
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 6: 4 }[header.colorType];
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let column = 0; column < stride; column++) {
      const value = raw[row * (stride + 1) + 1 + column];
      const left = column >= channels ? pixels[row * stride + column - channels] : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? pixels[(row - 1) * stride + column - channels] : 0;
      pixels[row * stride + column] = (value + [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]) & 255;
    }
  }
  return { channels, pixels, pixelCount: header.width * header.height };
}

function recipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 24, rings: 16 }],
    materials: [
      { id: 'red', color: [0.8, 0.1, 0.1], roughness: 0.6 },
      { id: 'glow', color: [0.1, 0.3, 0.9], emission: 2 },
      { id: 'foliage', color: [0.1, 0.6, 0.15], alphaMode: 'blend', opacity: 0.8 },
    ],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'red', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      { id: 'near-ball', geometry: 'sphere', material: 'glow', translation: [-0.6, 0.5, 1.5], scale: [1, 1, 1] },
      { id: 'far-block', geometry: 'box', material: 'red', translation: [1.4, 0.5, -3], scale: [1, 1, 1] },
      // A blended material (tree leaves exported as BLEND): its own ID in the ID passes, and the block behind it stays visible.
      { id: 'leaf-canopy', geometry: 'sphere', material: 'foliage', translation: [2.8, 0.9, -2], scale: [1.2, 1.2, 1.2] },
    ],
    environment: { ground: false },
    camera: { eye: [0, 1.6, 6], target: [0, 0.5, 0], fov: 40 },
  };
}

async function runJob(sessionId, settings) {
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  if (submitted.isError) return { error: submitted.content.find(item => item.type === 'text').text };
  const record = await finished(submitted.structuredContent.jobId);
  if (record.state === 'failed') return { error: record.reason };
  assert.equal(record.state, 'completed', record.reason);
  const result = (await call('scene_render_result', { jobId: submitted.structuredContent.jobId, response_format: 'detailed' })).structuredContent;
  const files = new Map();
  for (const artifact of result.artifacts) files.set(artifact.path.split(/[\\/]/).pop(), await readFile(artifact.path));
  await call('scene_render_release', { jobId: submitted.structuredContent.jobId });
  return { files, metrics: result.metrics ?? record.metrics };
}

function whitePixels(png) {
  let count = 0;
  for (let offset = 0; offset < png.pixels.length; offset += png.channels) if (png.pixels[offset] === 255) count++;
  return count;
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: recipe() }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const first = await runJob(sessionId, { kind: 'image', width: SIZE, height: SIZE, passes: ['objectId'],
    mattes: [{ object: 'near-ball' }, { object: 'far-block' }, { material: 'glow' }, { object: 'leaf-canopy' }, { material: 'foliage' }] });
  assert.equal(first.error, undefined, first.error);
  const { files, metrics } = first;
  assert.deepEqual([...files.keys()].sort(), ['render-matte-0.png', 'render-matte-1.png', 'render-matte-2.png', 'render-matte-3.png', 'render-matte-4.png', 'render-objectId.png', 'render.png']);
  const ids = decodePng(files.get('render-objectId.png'));
  const idOf = name => metrics.objectNames.indexOf(name) + 1;
  const expectedCoverage = name => {
    let count = 0;
    for (let offset = 0; offset < ids.pixels.length; offset += ids.channels) {
      if (ids.pixels[offset] + ids.pixels[offset + 1] * 256 + ids.pixels[offset + 2] * 65536 === idOf(name)) count++;
    }
    return count;
  };
  const ball = decodePng(files.get('render-matte-0.png'));
  const block = decodePng(files.get('render-matte-1.png'));
  const glow = decodePng(files.get('render-matte-2.png'));
  assert.ok(whitePixels(ball) > 200, 'the near ball must cover pixels');
  assert.equal(whitePixels(ball), expectedCoverage('near-ball'), 'object matte equals the object ID pass');
  assert.equal(whitePixels(block), expectedCoverage('far-block'));
  assert.deepEqual(glow.pixels, ball.pixels, 'the glow material is only on the near ball');
  const canopy = decodePng(files.get('render-matte-3.png'));
  const foliage = decodePng(files.get('render-matte-4.png'));
  assert.ok(whitePixels(canopy) > 200, 'a blended part must get its own ID, not black');
  assert.equal(whitePixels(canopy), expectedCoverage('leaf-canopy'), 'blended object matte equals the object ID pass');
  assert.deepEqual(foliage.pixels, canopy.pixels, 'the blended material matte covers the blended part');
  assert.ok(whitePixels(block) > 100, 'the block behind the canopy keeps its ID where the canopy is absent');
  assert.deepEqual(metrics.mattes.slice(0, 3).map(matte => matte.coveragePixels), [whitePixels(ball), whitePixels(block), whitePixels(glow)]);

  const refused = await runJob(sessionId, { kind: 'image', width: SIZE, height: SIZE, mattes: [{ object: 'chair' }] });
  assert.match(refused.error ?? "", /no part named "chair" in this scene. Pass one of: .*near-ball/);
  console.log(`pass mattes smoke passed on ${backend}: ball ${whitePixels(ball)} px, block ${whitePixels(block)} px of ${ball.pixelCount}`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
