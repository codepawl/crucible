import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';
import { createAgentScene, loadPhysicsEngine, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Every json example in these docs that targets a recipe or scene_apply goes through the MCP input schema and then the
// backend (issue #1311), so a doc never shows an agent something the server refuses. The examples are fragments, so each
// one has a wrapper that supplies the nodes, geometries and materials it names. A new example fails the count test
// until it gets a wrapper here or a reason to be skipped.

await loadPhysicsEngine({ buoyancy: true });

const MATERIALS = ['paint', 'cloth', 'stone', 'rust', 'glow'].map((id, index) => ({ id, color: [0.3 + index * 0.1, 0.5, 0.6] }));

function boxNode(id, extra = {}) {
  return { id, geometry: 'cube', material: 'paint', ...extra };
}

function baseRecipe({ geometries = [], nodes = [boxNode('a')], ...extra } = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, ...geometries],
    materials: MATERIALS,
    nodes,
    ...extra,
  };
}

const floor = boxNode('floor', { scale: [10, 0.2, 10], translation: [0, -0.1, 0] });
const sea = { id: 'sea', type: 'mesh', base: { type: 'grid', segments: 8 }, stack: [{ op: 'ocean', windSpeed: 0.5, size: 50, seed: 4 }] };
const seaNode = { id: 'water', geometry: 'sea', material: 'paint', scale: [50, 50, 1], rotation: [-0.7071068, 0, 0, 0.7071068] };

// A recipe fragment that lists geometries and nodes adds them to the base scene; any other top-level field is kept.
function mergedRecipe(fragment, base = baseRecipe({ nodes: [] })) {
  return { ...base, ...fragment, geometries: [...base.geometries, ...(fragment.geometries ?? [])], nodes: [...base.nodes, ...(fragment.nodes ?? [])] };
}

function ragdollRecipe(physics) {
  const recipe = walkerRecipe();
  delete recipe.motion;
  recipe.geometries.push({ id: 'slab', type: 'box' });
  recipe.nodes.push({ id: 'floor', geometry: 'slab', material: 'cloth', translation: [0, -0.25, 0], scale: [8, 0.5, 8] });
  recipe.armatures[0].translation = [0, 1, 0];
  recipe.physics = physics;
  return recipe;
}

const create = recipe => ({ recipe });
const apply = (recipe, operations) => ({ recipe, operations });

// One entry per json block, in document order: a function from the parsed block to `{ recipe, operations? }`, or a skip reason.
const EXAMPLES = {
  'docs/agent-look.md': [
    block => apply(baseRecipe(), [block]),
    block => create(baseRecipe({ nodes: [boxNode('bomb', { translation: [0, 1, -16] })], ...block })),
  ],
  'docs/physics.md': [
    block => create(baseRecipe({
      // A revolute joint with limits starts with its anchors together, so the door and its frame share a centre.
      nodes: [boxNode('tray'), boxNode('ball-1', { translation: [0, 2, 0] }), boxNode('door', { translation: [4, 1, 0] }), boxNode('frame', { translation: [4, 1, 0] })],
      physics: { ...block.physics, bodies: [...block.physics.bodies, { node: 'door' }, { node: 'frame', type: 'fixed' }] },
    })),
    block => create(baseRecipe({ geometries: [sea], nodes: [seaNode, boxNode('crate', { translation: [0, 1, 0] }), boxNode('boat', { translation: [4, 1, 0] })], ...block })),
    block => create(baseRecipe({ geometries: [sea], nodes: [seaNode, boxNode('hull', { translation: [0, 1, 0] })],
      physics: { duration: 4, ocean: { geometry: 'sea' }, bodies: [block] } })),
    block => apply(baseRecipe({ nodes: [floor, boxNode('ball', { translation: [0, 1, 4] }), boxNode('wall', { translation: [0, 1, 0], scale: [3, 2, 0.3] })] }), block),
    block => create(ragdollRecipe(block.physics)),
    block => create(mergedRecipe(block)),
    block => apply(baseRecipe({ geometries: [{ id: 'block', type: 'box' }], nodes: [floor, boxNode('wall', { translation: [0, 1, -2], scale: [6, 2, 0.3] })] }), [block]),
    block => create(mergedRecipe(block)),
    // The spark system of #1758: unlit specks with type sparks and the explosion preset.
    block => create(mergedRecipe(block)),
  ],
  'docs/mesh.md': [
    'field expressions, not a recipe',
    // The Cracks example is a whole scene, so it goes to scene_create unchanged (#3245).
    block => create(block),
    block => create(baseRecipe({ geometries: [block], nodes: [boxNode('a', { geometry: block.id })] })),
    block => create(baseRecipe({ geometries: [block], nodes: [boxNode('a', { geometry: block.id })] })),
    'a mesh_inspect result, not an input',
  ],
};

async function withSchemaClient(use) {
  let scene;
  const runtime = {
    activeSessionId() { return scene ? 'docs' : null; },
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { sessionId: 'docs', revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { sessionId: 'docs', revision: scene.revision };
    },
    async close() {},
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-docs-recipe-examples-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callAccepted(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  assert.notEqual(result.isError, true, `${name} refused the example: ${text}`);
  return result.structuredContent;
}

// A block that starts with a bare `"physics": {` is one field of a recipe, so it is read inside braces.
function parseBlock(text) {
  const trimmed = text.trim();
  return JSON.parse(trimmed.startsWith('"') ? `{${trimmed}}` : trimmed);
}

for (const [path, wrappers] of Object.entries(EXAMPLES)) {
  const text = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]);

  test(`every json example in ${path} has a wrapper or a reason to skip it`, () => {
    assert.equal(blocks.length, wrappers.length, `${path} has ${blocks.length} json blocks; add a wrapper or a skip reason for each new one in this test`);
  });

  wrappers.forEach((wrapper, index) => {
    if (typeof wrapper === 'string') return;
    test(`${path} json example ${index + 1} passes the MCP schema and the backend`, async () => {
      const { recipe, operations } = wrapper(parseBlock(blocks[index]));
      await withSchemaClient(async client => {
        const created = await callAccepted(client, 'scene_create', { recipe });
        if (operations) await callAccepted(client, 'scene_apply', { expectedRevision: created.revision, operations });
      });
    });
  });
}
