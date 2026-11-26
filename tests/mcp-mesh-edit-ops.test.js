import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { MESH_EDIT_OPERATIONS } from '../src/mesh-operations.js';

// The mesh_edit tool takes the ops the recipe path takes (#2126): both lists come from MESH_EDIT_OPERATIONS, scene_capabilities
// meshEdits reports it, and the `operations` topic lists only types scene_apply accepts.

const SESSION_ID = '3f1c2a64-9d7e-4b1a-8c55-2a6f0e9d1b77';

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
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { sessionId: SESSION_ID, revision: scene.revision, render: { backend: 'fake' } };
    },
    async close() {},
    activeSessionId() { return scene ? SESSION_ID : null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'mesh-edit-ops-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// Each case is a mesh before the op (prelude edits in the recipe) and the op itself. delete_loose has no recipe prelude that leaves a loose
// vertex, so it must reach the engine and fail there with the engine's own error, the same as in a recipe.
const OP_CASES = {
  split_edges: { prelude: [], edit: { op: 'split_edges', edges: { all: true } } },
  flatten: { prelude: [{ op: 'translate', select: { tag: 'top' }, offset: [0, 0.3, 0.1] }], edit: { op: 'flatten', verts: { all: true }, normal: [0, 1, 0] } },
  circularize: { prelude: [{ op: 'loop_cut', name: 'ring', edges: { along: [0, 1, 0] } }], edit: { op: 'circularize', verts: { inside: { min: [-1, -0.01, -1], max: [1, 0.01, 1] } } } },
  unsubdivide: { prelude: [{ op: 'subdivide', levels: 1 }], edit: { op: 'unsubdivide' } },
  merge_verts: { prelude: [], edit: { op: 'merge_verts', vertices: [0, 1], at: 'center' } },
  make_face: { prelude: [{ op: 'delete', select: { tag: 'top' } }], edit: { op: 'make_face', vertices: [1, 3, 5, 7] } },
  delete_loose: { prelude: [], edit: { op: 'delete_loose' }, engineError: /no loose vertex/ },
  transform_selection: { prelude: [], edit: { op: 'transform_selection', select: { tag: 'top' }, rotation: { axis: [0, 0, 1], angle: 0.5 }, scale: [1, 2, 1], falloff: { radius: 2, curve: 'linear' } } },
};

function recipeMeshReport(edits) {
  return createAgentScene(meshRecipe(edits)).inspectMeshes({ geometries: ['m'] }).meshes[0];
}

for (const [name, { prelude, edit, engineError }] of Object.entries(OP_CASES)) {
  test(`mesh_edit runs ${name} like a recipe geometry edit`, async context => {
    const client = await connect(context);
    await client.callTool({ name: 'scene_create', arguments: { recipe: meshRecipe(prelude) } });
    const result = await client.callTool({ name: 'mesh_edit', arguments: { sessionId: SESSION_ID, expectedRevision: 0, geometry: 'm', edits: [edit] } });
    if (engineError) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, engineError);
      assert.throws(() => recipeMeshReport([...prelude, edit]), engineError);
      return;
    }
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const fromRecipe = recipeMeshReport([...prelude, edit]);
    const reported = result.structuredContent.mesh;
    assert.equal(reported.edits.length, prelude.length + 1, 'the new edit ran after the prelude');
    assert.deepEqual(reported.edits.at(-1), fromRecipe.edits.at(-1));
    assert.deepEqual(reported.counts, fromRecipe.counts);
    assert.deepEqual(reported.bounds, fromRecipe.bounds);
    assert.ok(Object.keys(reported.edits.at(-1)).length > 0, `${name} reports what it did`);
  });
}

test('the mesh_edit op list is MESH_EDIT_OPERATIONS, the list scene_capabilities meshEdits reports', async context => {
  const client = await connect(context);
  const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'mesh_edit');
  const toolOperations = tool.inputSchema.properties.edits.items.properties.op.enum;
  assert.deepEqual([...toolOperations].sort(), Object.keys(MESH_EDIT_OPERATIONS).sort());
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.meshEdits.operations].sort(), [...toolOperations].sort());
});

test('every type the operations topic lists is accepted by scene_apply', async context => {
  const client = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: meshRecipe([]) } });
  for (const type of AGENT_SCENE_CAPABILITIES.operations) {
    let message = '';
    try {
      const result = await client.callTool({ name: 'scene_apply', arguments: { sessionId: SESSION_ID, expectedRevision: 0, operations: [{ type }] } });
      message = result.isError ? result.content[0].text : '';
    } catch (error) {
      message = error.message;
    }
    assert.doesNotMatch(message, /Invalid discriminator|invalid_union/i, `scene_apply refuses the listed type ${type}`);
  }
  for (const type of ['edit-mesh', 'set-mesh-stack']) assert.ok(!AGENT_SCENE_CAPABILITIES.operations.includes(type), `${type} is the mesh_edit or mesh_stack tool, not a scene_apply type`);
});
