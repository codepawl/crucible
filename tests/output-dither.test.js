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
import { isDitherActive, resolveEffects } from '../src/effects.js';
import { createPostFragment } from '../src/post.js';
import { CrucibleRenderer } from '../src/renderer.js';
import { decodePngPixels } from './support/png-pixels.mjs';

// Output dither (#3258): one 8-bit step of deterministic noise after tone mapping, so a smooth ramp rounds to alternating steps instead of flat bands.

test('dither is off unless a recipe sets it to true, and a scene that leaves it alone resolves as before', () => {
  assert.equal(isDitherActive(resolveEffects({})), false);
  assert.equal(isDitherActive(resolveEffects({ dither: false })), false);
  assert.equal(isDitherActive(resolveEffects({ dither: true })), true);
  assert.deepEqual(resolveEffects({ dither: false }), resolveEffects({}));
  assert.throws(() => resolveEffects({ dither: 1 }), /Dither must be true or false/);
});

test('the post steps of a frame hold the dither step only when dither is on, and only its program holds the noise', () => {
  const stepsOf = effects => CrucibleRenderer.prototype.postStepsOf.call({ transparent: false }, {}, resolveEffects(effects), { density: 0 }, false, null, false);
  assert.ok(!stepsOf({}).includes('dither'));
  assert.ok(stepsOf({ dither: true }).includes('dither'));
  assert.match(createPostFragment(['dither']), /outputColor\.rgb \+= outputDither\(gl_FragCoord\.xy, time\) \* alpha;/);
  assert.doesNotMatch(createPostFragment([]), /outputDither/);
  assert.doesNotMatch(createPostFragment(), /outputDither/, 'the program with every step is the one a frame draws while a variant builds, so it holds no dither');
});

const WIDTH = 192;
const HEIGHT = 108;
const directories = [];
const sessions = new Map();
async function server() {
  if (sessions.has('server')) return sessions.get('server');
  const directory = await mkdtemp(join(tmpdir(), 'crucible-output-dither-'));
  directories.push(directory);
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'output-dither-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  sessions.set('server', { client, close: async () => { await client.close(); await mcp.close(); await runtime.close(); } });
  return sessions.get('server');
}
after(async () => {
  if (sessions.has('server')) await sessions.get('server').close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

// A dark sky that climbs a few levels from top to bottom: the 8-bit frame holds it in a handful of wide flat bands.
async function renderDarkSky(effects) {
  const { client } = await server();
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    camera: { eye: [0, 0, 0], target: [0, 0.6, -1], fov: 50 },
    environment: { setup: 'daylight', world: true, skyTop: [0.01, 0.012, 0.03], skyBottom: [0.05, 0.06, 0.1], ground: false },
    ...(effects === undefined ? {} : { effects }),
  };
  const created = await call(client, 'scene_create', { recipe });
  const submitted = await call(client, 'scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'image', width: WIDTH, height: HEIGHT } });
  for (let attempt = 0; attempt < 900; attempt++) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  return decodePngPixels(await readFile(result.artifacts[0].path));
}

// The longest run of equal green values down one column of the dark part of the sky (the bottom rows hold the horizon glow), worst column of the frame.
function longestRun(pixels) {
  const darkRows = Math.floor(pixels.height * 0.6);
  let worst = 0;
  for (let column = 0; column < pixels.width; column++) {
    let run = 1;
    for (let row = 1; row < darkRows; row++) {
      const same = pixels.data[(row * pixels.width + column) * pixels.channels + 1] === pixels.data[((row - 1) * pixels.width + column) * pixels.channels + 1];
      run = same ? run + 1 : 1;
      worst = Math.max(worst, run);
    }
  }
  return worst;
}

function meanLevel(pixels) {
  let sum = 0;
  for (let index = 0; index < pixels.data.length; index += pixels.channels) sum += pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2];
  return sum / (pixels.width * pixels.height * 3);
}

test('dither shortens the flat runs of a dark gradient, keeps the mean, repeats byte for byte and off changes no pixel', { timeout: 240000 }, async () => {
  const plain = await renderDarkSky();
  const switchedOff = await renderDarkSky({ dither: false });
  assert.deepEqual(switchedOff.data, plain.data, 'dither: false must give the bytes of a scene that never mentions dither');
  const dithered = await renderDarkSky({ dither: true });
  const again = await renderDarkSky({ dither: true });
  assert.deepEqual(again.data, dithered.data, 'the same frame must give the same bytes');
  assert.notDeepEqual(dithered.data, plain.data, 'the test scene must change when dither is on, else the checks below prove nothing');
  const plainRun = longestRun(plain);
  const ditheredRun = longestRun(dithered);
  assert.ok(plainRun >= 20, `the plain gradient must band (longest run ${plainRun}), else the test scene is wrong`);
  assert.ok(ditheredRun * 2 <= plainRun, `the longest run of equal values must at least halve: ${plainRun} px without dither, ${ditheredRun} px with it`);
  assert.ok(Math.abs(meanLevel(dithered) - meanLevel(plain)) <= 0.1, 'dither moves no light: the mean level stays within 0.1 of a step');
  for (let index = 0; index < dithered.data.length; index++) {
    assert.ok(Math.abs(dithered.data[index] - plain.data[index]) <= 1, 'dither moves a value by one step at most');
  }
});
