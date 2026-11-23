import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { FOLDED_APPLY_OPERATION_NOTES, FOLDED_APPLY_OPERATION_TYPES } from '../src/apply-operation-notes.js';

// Issue 3047: rarely used scene_apply operations share one schema branch, so their fields are checked by the backend
// and listed in scene_capabilities applyOperations instead of in every turn's tool schema.

async function connectedClient(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'folded-operations-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function wallRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }],
    materials: [{ id: 'brick', color: [0.6, 0.3, 0.2] }, { id: 'spare', color: [1, 1, 1] }],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'brick', translation: [0, -0.25, 0], scale: [8, 0.5, 8] },
      { id: 'wall', geometry: 'slab', material: 'brick', translation: [0, 1, 0], scale: [3, 2, 0.4] },
    ],
  };
}

// The MCP layer in front of a real agent scene, so the test sees what an agent sees: the backend's own errors.
function sceneRuntime() {
  const scene = createAgentScene(wallRecipe());
  return {
    scene,
    activeSessionId: () => null,
    async close() {},
    async capabilities() { return { scene: {} }; },
    async apply({ operations, expectedRevision }) { return scene.apply(operations, { expectedRevision }); },
  };
}

async function applyText(client, operations) {
  const result = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations } });
  return { isError: result.isError === true, text: result.content?.[0]?.text ?? '' };
}

test('scene_apply lists the folded operations as one branch that names the capabilities topic', async context => {
  const client = await connectedClient(context, sceneRuntime());
  const { tools } = await client.listTools();
  const branches = tools.find(tool => tool.name === 'scene_apply').inputSchema.properties.operations.items.oneOf;
  const folded = branches.filter(branch => branch.properties.type.enum?.includes('set-shadow'));
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].properties.type.enum, [...FOLDED_APPLY_OPERATION_TYPES]);
  assert.match(folded[0].description, /scene_capabilities applyOperations/);
  const typedNames = branches.map(branch => branch.properties.type.const).filter(Boolean);
  for (const type of FOLDED_APPLY_OPERATION_TYPES) assert.ok(!typedNames.includes(type), `${type} is still typed on its own`);
});

test('a folded operation reaches the backend and applies', async context => {
  const runtime = sceneRuntime();
  const client = await connectedClient(context, runtime);
  const answer = await applyText(client, [{ type: 'remove-material', id: 'spare' }]);
  assert.equal(answer.isError, false, answer.text);
  assert.deepEqual(runtime.scene.exportRecipe().materials.map(material => material.id), ['brick']);
});

test('the backend still rejects bad fields of a folded operation and names the fix', async context => {
  const client = await connectedClient(context, sceneRuntime());
  const cases = [
    [{ type: 'fracture-node', node: 'wall', cells: 500, strength: 1, seed: 1 }, /cells: got 500; expected a whole number of pieces from 2 to 64/],
    [{ type: 'fracture-node', node: 'wall', cell: 8, strength: 1, seed: 1 }, /Unknown or unsupported operation field: cell\. Allowed fields: type, node, cells/],
    [{ type: 'bake-motion', nodes: Array.from({ length: 40 }, (_, index) => `part${index}`) }, /nodes: got "40 IDs"; expected a list of 1 to 32 node IDs/],
    [{ type: 'set-game', gam: {} }, /operation\.gam: got \{\}; expected one of the fields type, game; remove gam/],
    [{ type: 'set-shadow', shadow: { resolutoin: 2048 } }, /shadow\.resolutoin: got 2048; expected one of the fields target, extent/],
    [{ type: 'remove-material', ids: 'brick' }, /operation\.ids: got "brick"; expected one of the fields type, id; remove ids/],
  ];
  for (const [operation, expected] of cases) {
    const answer = await applyText(client, [operation]);
    assert.equal(answer.isError, true, `${operation.type} was accepted`);
    assert.match(answer.text, expected);
  }
});

test('a type outside every branch still fails at the schema', async context => {
  const client = await connectedClient(context, sceneRuntime());
  const answer = await applyText(client, [{ type: 'set-teleporter' }]);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Input validation error/);
});

test('applyOperations answers every folded type, and every topic it points to exists', async context => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  context.after(() => runtime.close());
  const client = await connectedClient(context, runtime);
  const topics = (await runtime.capabilities()).scene;
  assert.deepEqual(topics.applyOperations, FOLDED_APPLY_OPERATION_NOTES);
  for (const [type, note] of Object.entries(FOLDED_APPLY_OPERATION_NOTES)) {
    const answer = await client.callTool({ name: 'scene_capabilities', arguments: { topic: `applyOperations.${type}` } });
    assert.notEqual(answer.isError, true, answer.content?.[0]?.text);
    assert.match(JSON.stringify(answer.structuredContent), new RegExp(note.slice(0, 12).replace(/[[\]{}().*+?^$|\\]/g, '\\$&')));
    const pointed = note.match(/More: topic (\w+)/)?.[1];
    if (!pointed) continue;
    const pointedAnswer = await client.callTool({ name: 'scene_capabilities', arguments: { topic: pointed } });
    assert.notEqual(pointedAnswer.isError, true, `${type} points at topic ${pointed}: ${pointedAnswer.content?.[0]?.text}`);
  }
});
