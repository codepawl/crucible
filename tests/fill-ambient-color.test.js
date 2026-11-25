import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { decodePngPixels } from './support/png-pixels.mjs';
import { normalizeAgentLook } from '../src/agent-look.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { DEFAULT_FILL_COLORS } from '../src/ambient-light.js';
import { everyCasterOutsideShadowView, frameDiagnostics } from '../src/frame-diagnostics.js';
import { mat4 } from 'gl-matrix';
import { resolveShadowLight, writeShadowLightMatrix } from '../src/shadow-light.js';

// #3284: a flat ambient colour in place of the HDRI diffuse light, fill light colours, and the studio shadow view that misses a far set.

function environmentFor(fields) {
  return normalizeAgentLook({ environment: fields }).environment;
}

function lightingFor(fields) {
  return updateLightingState(createLightingState(), environmentFor(fields));
}

test('a recipe without fillColor or ambientMix keeps the old fill colours and diffuse light', () => {
  const environment = environmentFor({});
  assert.equal(environment.fillColor, undefined);
  assert.equal(environment.ambientMix, undefined);
  const lighting = lightingFor({});
  assert.deepEqual(Array.from(lighting.fillColors), [...DEFAULT_FILL_COLORS[0], 0, ...DEFAULT_FILL_COLORS[1], 0].map(Math.fround));
  assert.equal(lighting.ambientMix, 0);
  assert.deepEqual(Array.from(lighting.ambientGroundDelta), [0, 0, 0]);
});

test('fillColor takes one colour for both fill lights or one per light', () => {
  assert.deepEqual(Array.from(lightingFor({ fillColor: [0.5, 0.5, 0.5] }).fillColors), [0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0]);
  assert.deepEqual(Array.from(lightingFor({ fillColor: [[1, 0, 0], [0, 0, 1]] }).fillColors), [1, 0, 0, 0, 0, 0, 1, 0]);
});

test('ambientColor takes sky and ground, and ambientMix blends from the HDRI toward it', () => {
  const lighting = lightingFor({ ambientColor: { sky: [0.5, 0.5, 0.5], ground: [0.25, 0.25, 0.5] }, ambientMix: 0.75 });
  assert.deepEqual(Array.from(lighting.ambientColor), [0.5, 0.5, 0.5]);
  assert.deepEqual(Array.from(lighting.ambientGroundDelta), [-0.25, -0.25, 0]);
  assert.equal(lighting.ambientMix, 0.75);
});

test('fillColor, ambientColor and ambientMix errors say what to pass', () => {
  assert.throws(() => environmentFor({ fillColor: [1, 2] }), /environment\.fillColor must be one colour \[r, g, b\].*or two colours/);
  assert.throws(() => environmentFor({ fillColor: [[1, 1, 1], [0, 0, 101]] }), /environment\.fillColor\[1\]\[2\]/);
  assert.throws(() => environmentFor({ ambientColor: { sky: [1, 1, 1] } }), /needs exactly "sky" and "ground"/);
  assert.throws(() => environmentFor({ ambientColor: [0.5, 0.5, 0.5], ambientMix: 1.5 }), /environment\.ambientMix must be a number from 0 to 1/);
  assert.throws(() => environmentFor({ ambientMix: 1 }), /needs environment\.ambientColor: pass \[r, g, b\]/);
});

test('the studio shadow view reports a set whose casters all lie outside the shadow box, and names shadowBounds', () => {
  const overheadSun = [0.05, 1, 0.05];
  const view = resolveShadowLight(false, overheadSun);
  const matrix = writeShadowLightMatrix(mat4.create(), view);
  const near = { minimum: [-1, 0, -1], maximum: [1, 2, 1] };
  const far = { minimum: [20, 0, 20], maximum: [22, 2, 22] };
  const straightAbove = { minimum: [-0.5, 6.5, -0.5], maximum: [0.5, 7.5, 0.5] };
  assert.equal(everyCasterOutsideShadowView([far], matrix), true);
  assert.equal(everyCasterOutsideShadowView([far, near], matrix), false, 'one caster inside keeps some shadow');
  assert.equal(everyCasterOutsideShadowView([straightAbove], matrix), false, 'a caster straight above the target is inside the box of an overhead sun');
  assert.equal(everyCasterOutsideShadowView([], matrix), false);
  const problems = frameDiagnostics({ world: false, depth: false, effects: {}, shadowViewMissesCasters: view });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'shadow-view-misses-casters');
  assert.match(problems[0].fix, /renderer\.shadowBounds/);
  assert.equal(frameDiagnostics({ world: false, depth: false, effects: {} }).length, 0);
});

const SIZE = 96;
const BLUE_SKY = { type: 'gradient', stops: [{ at: 0, color: '#6f9be8' }, { at: 1, color: '#2f63d6' }] };
const GREY_SKY = { type: 'gradient', stops: [{ at: 0, color: '#9a9a9a' }, { at: 1, color: '#9a9a9a' }] };

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-fill-ambient-'));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'fill-ambient-test', version: '1' });
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

// A white matte plate in shade: no key light, no fill, so only the ambient light reaches it.
async function plateFrame(client, environment) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'plate', color: [1, 1, 1], roughness: 1 }],
    nodes: [{ id: 'plate', geometry: 'box', material: 'plate', translation: [0, -0.5, 0], scale: [40, 1, 40] }],
    camera: { eye: [0, 6, 0.01], target: [0, 0, 0], fov: 40 },
    environment: { ground: false, keyIntensity: 0, fillIntensity: 0, ...environment },
  };
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const look = await client.callTool({ name: 'scene_look', arguments: { sessionId: created.structuredContent.sessionId, width: SIZE, height: SIZE } }, { timeout: 120000 });
  assert.equal(look.isError, undefined, look.content?.[0]?.text);
  const image = look.content.find(item => item.type === 'image');
  await client.callTool({ name: 'scene_dispose', arguments: { sessionId: created.structuredContent.sessionId } });
  const picture = decodePngPixels(Buffer.from(image.data, 'base64'));
  const offset = ((SIZE / 2) * picture.width + SIZE / 2) * picture.channels;
  return Array.from(picture.data.subarray(offset, offset + 3));
}

test('a near-grey ambientColor at ambientMix 1 makes a plate in shade grey under a blue sky, within 5/255 of a neutral-sky reference', { timeout: 300000 }, async context => {
  const client = await startServer(context);
  const grey = { ambientColor: [0.64, 0.63, 0.68], ambientMix: 1 };
  const blue = await plateFrame(client, { sky: BLUE_SKY });
  const bluePlate = await plateFrame(client, { sky: BLUE_SKY, ...grey });
  const reference = await plateFrame(client, { sky: GREY_SKY, ...grey });
  console.log('blue sky only', blue, 'blue sky + grey ambient', bluePlate, 'neutral sky + grey ambient', reference);
  assert.ok(blue[2] - blue[0] > 15, `the control: without ambientMix the blue sky tints the plate (${blue})`);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(bluePlate[channel] - reference[channel]) <= 5, `channel ${channel}: ${bluePlate[channel]} against reference ${reference[channel]}`);
  }
  assert.ok(Math.abs(bluePlate[2] - bluePlate[0]) <= 12, `the plate is near grey: ${bluePlate}`);
});
