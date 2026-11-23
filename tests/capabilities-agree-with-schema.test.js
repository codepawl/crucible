import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES, createAgentScene } from '../src/agent-scene.js';
import { MATERIAL_PATTERN_TYPES } from '../src/agent-scene-capabilities.js';
import { MESH_EDIT_OPERATIONS, STACK_OPERATIONS } from '../src/mesh-operations.js';

// Issue 2206: scene_capabilities listed alphaMode add before the validator took it, described pattern colors as 2 to 3 for every
// type, and left the modifier ops (ocean, wave) out of the meshEdit and meshStack topics. These tests keep the lists and the validator together.

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'capabilities-agree-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function topic(client, name) {
  const result = await client.callTool({ name: 'scene_capabilities', arguments: { topic: name } });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

function recipeWithMaterial(material) {
  return { format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5], ...material }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }] };
}

test('every alphaMode that scene_capabilities lists is accepted by the validator', () => {
  const listed = AGENT_SCENE_CAPABILITIES.alphaModes;
  assert.ok(listed.includes('add'));
  for (const alphaMode of listed) {
    assert.doesNotThrow(() => createAgentScene(recipeWithMaterial({ alphaMode })), `alphaMode ${alphaMode}`);
  }
  assert.throws(() => createAgentScene(recipeWithMaterial({ alphaMode: 'multiply' })), /opaque, blend, add/);
});

test('the material schema topic takes the alphaModes scene_capabilities lists', async context => {
  const client = await connectClient(context);
  const answer = JSON.stringify(await topic(client, 'schemas.materialFields'));
  const listed = AGENT_SCENE_CAPABILITIES.alphaModes.map(mode => '"' + mode + '"').join('|');
  assert.ok(answer.includes(listed.replaceAll('"', '\\"')), 'alphaMode enum in the material fields: ' + listed);
});

test('pattern colors: two colours for every type, a third only for bricks, and the error says so', () => {
  const twoColors = [[0.1, 0.1, 0.1], [0.6, 0.6, 0.6]];
  const threeColors = [...twoColors, [0.3, 0.3, 0.3]];
  for (const type of MATERIAL_PATTERN_TYPES) {
    assert.doesNotThrow(() => createAgentScene(recipeWithMaterial({ pattern: { type, colors: twoColors } })), `${type} with two colours`);
    if (type === 'bricks') {
      assert.doesNotThrow(() => createAgentScene(recipeWithMaterial({ pattern: { type, colors: threeColors } })));
    } else {
      assert.throws(() => createAgentScene(recipeWithMaterial({ pattern: { type, colors: threeColors } })), new RegExp(`${type} takes no third, only bricks does`), type);
    }
  }
});

test('the pattern colors description says only bricks takes a third colour', async context => {
  const client = await connectClient(context);
  const answer = JSON.stringify(await topic(client, 'pattern'));
  assert.match(answer, /Only bricks accepts a third/);
});

test('meshEdit and meshStack topics reach every op their tools accept, modifier ops through modifierOps', async context => {
  const client = await connectClient(context);
  const expected = { meshEdit: Object.keys(MESH_EDIT_OPERATIONS), meshStack: STACK_OPERATIONS };
  for (const [name, operations] of Object.entries(expected)) {
    const answer = await topic(client, name);
    const reachable = new Set([...Object.keys(answer.fields.branches ?? {}), ...(answer.fields.modifierOps ?? answer.modifierOps ?? [])]);
    const missing = operations.filter(operation => !reachable.has(operation));
    assert.deepEqual(missing, [], `${name} does not reach ${missing.join(', ')}`);
    assert.ok(reachable.has('ocean') && reachable.has('wave'), `${name} reaches ocean and wave`);
  }
});

test('a modifier op looked up as a meshEdit branch points to meshModifiers', async context => {
  const client = await connectClient(context);
  const result = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'meshEdit.ocean' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /meshModifiers\.ocean/);
  const modifier = await topic(client, 'meshModifiers.ocean');
  assert.match(modifier.value, /seeded sea/);
});

test('particle stop is described as an absolute time in scene_capabilities', async context => {
  const client = await connectClient(context);
  const answer = await topic(client, 'particles');
  assert.match(JSON.stringify(answer), /stop \(an absolute time in seconds/);
  assert.doesNotMatch(JSON.stringify(answer), /stop \(seconds, after start/);
});


test('a rejected particle stop says it is an absolute scene time, not a duration after start', () => {
  const recipe = { format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'dot', type: 'box' }], materials: [{ id: 'paint', color: [1, 1, 1] }],
    nodes: [{ id: 'spark', geometry: 'dot', material: 'paint' }],
    particles: { systems: [{ node: 'spark', count: 4, rate: 2, lifetime: 0.5, speed: [1, 2], size: 1, start: 1.5, stop: 0.2 }] } };
  assert.throws(() => createAgentScene(recipe), /\.stop: got 0\.2; expected an absolute scene time in seconds, above start \(1\.5\), such as 3\.5 \(stop is not a duration after start\)/);
});

test('the effects and ambientOcclusion topics both give the ambient occlusion default the code uses (0, off)', async context => {
  const client = await connectClient(context);
  assert.equal(AGENT_SCENE_CAPABILITIES.ambientOcclusion.default, 0);
  const ambientOcclusionTopic = await topic(client, 'ambientOcclusion');
  assert.equal(ambientOcclusionTopic.value.default, 0);
  const effectsText = JSON.stringify(await topic(client, 'effects'));
  assert.match(effectsText, /Default 0 \(off\) when unset/);
  assert.doesNotMatch(effectsText, /0\.7/);
});
