import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// #3262: the mesh_edit tool and a recipe geometry take { verts } and { edges } on translate and transform_selection,
// and { "edges": [[a, b]] } on every edge rule.

const SESSION_ID = '3f1c2a64-9d7e-4b1a-8c55-2a6f0e9d1b78';

function meshRecipe(edits) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'm', type: 'mesh', base: { type: 'box', bevel: 0 }, edits }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: 'n', geometry: 'm', material: 'blue' }],
  };
}

async function connect(context) {
  let scene;
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { sessionId: SESSION_ID, revision: scene.revision, render: { backend: 'fake' } };
    },
    async editMesh({ expectedRevision, geometry, edits, replace }) {
      scene.apply([{ type: 'edit-mesh', geometry, edits, ...(replace === undefined ? {} : { replace }) }], { expectedRevision });
      return { sessionId: SESSION_ID, revision: scene.revision, mesh: scene.inspectMeshes({ geometries: [geometry] }).meshes[0] };
    },
    async close() {},
    activeSessionId() { return scene ? SESSION_ID : null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'mesh-element-move-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function editThroughTool(client, edit) {
  await client.callTool({ name: 'scene_create', arguments: { recipe: meshRecipe([]) } });
  return client.callTool({ name: 'mesh_edit', arguments: { sessionId: SESSION_ID, expectedRevision: 0, geometry: 'm', edits: [edit] } });
}

const ACCEPTED = [
  { op: 'translate', verts: { vertices: [0, 1] }, offset: [0, 0.5, 0] },
  { op: 'translate', edges: { edges: [[0, 1], [1, 3]] }, offset: [0, 0.5, 0], falloff: { radius: 1, connected: true } },
  { op: 'transform_selection', verts: { vertices: [0] }, scale: 2 },
  { op: 'transform_selection', edges: { edges: [[0, 1]] }, rotation: { axis: [0, 1, 0], angle: 0.5 } },
  { op: 'bevel', edges: { edges: [[0, 1]] }, width: 0.1 },
];

for (const edit of ACCEPTED) {
  test(`mesh_edit accepts ${edit.op} with ${edit.verts ? 'verts' : 'an edge pair rule'} and the recipe path reports the same edit`, async context => {
    const client = await connect(context);
    const result = await editThroughTool(client, edit);
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const fromRecipe = createAgentScene(meshRecipe([edit])).inspectMeshes({ geometries: ['m'] }).meshes[0];
    assert.deepEqual(result.structuredContent.mesh.edits.at(-1), fromRecipe.edits.at(-1));
    assert.deepEqual(result.structuredContent.mesh.bounds, fromRecipe.bounds);
  });
}

test('mesh_edit rejects an unknown field on a move and a selection of the wrong shape', async context => {
  const client = await connect(context);
  const unknownField = await editThroughTool(client, { op: 'translate', vertices: [0], offset: [0, 1, 0] });
  assert.equal(unknownField.isError, true);
  const wrongShape = await editThroughTool(client, { op: 'translate', verts: [0, 1], offset: [0, 1, 0] });
  assert.equal(wrongShape.isError, true);
});

test('mesh_edit reports two selections on one move in the engine message', async context => {
  const client = await connect(context);
  const result = await editThroughTool(client, { op: 'translate', select: { all: true }, edges: { edges: [[0, 1]] }, offset: [0, 1, 0] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exactly one of select \(faces\), verts \(vertices\) or edges/);
});

test('the edge rule description names the vertex pair form, so scene_capabilities meshEdit shows it', async context => {
  const client = await connect(context);
  const answer = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'meshEdit' } });
  assert.ok(answer.structuredContent.fields.rules.edgeRule.includes('{"edges":[[a,b],...]} (vertex pairs)'));
  assert.match(answer.structuredContent.fields.branches.translate.args, /verts\?:vertexRule, edges\?:edgeRule/);
});
