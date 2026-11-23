import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer, parseToolSelection, runMcpCli, SELECTABLE_TOOL_NAMES } from '../scripts/mcp-server.mjs';

async function connectedClient(context, serverOptions) {
  const runtime = { activeSessionId: () => null, async close() {}, async capabilities() { return { scene: {} }; } };
  const server = createAgentMcpServer(runtime, serverOptions);
  const client = new Client({ name: 'tool-selection-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function listedToolsAndInstructions(context, serverOptions) {
  const client = await connectedClient(context, serverOptions);
  const { tools } = await client.listTools();
  return { tools, instructions: client.getInstructions() };
}

test('without --tools the server lists every selectable tool, with the same schemas and instructions', async context => {
  const defaultList = await listedToolsAndInstructions(context, {});
  const undefinedList = await listedToolsAndInstructions(context, { tools: undefined });
  assert.deepEqual(defaultList.tools.map(tool => tool.name).sort(), [...SELECTABLE_TOOL_NAMES].sort());
  assert.deepEqual(undefinedList, defaultList);
  assert.ok(!defaultList.instructions.includes('This server lists only'));
});

test('a selection lists only those tools, unchanged, and names them in the instructions', async context => {
  const full = await listedToolsAndInstructions(context, {});
  const selection = ['scene_capabilities', 'scene_create', 'scene_look'];
  const subset = await listedToolsAndInstructions(context, { tools: selection });
  assert.deepEqual(subset.tools.map(tool => tool.name).sort(), [...selection].sort());
  for (const tool of subset.tools) {
    assert.deepEqual(tool, full.tools.find(fullTool => fullTool.name === tool.name));
  }
  assert.ok(subset.instructions.includes('This server lists only these tools: scene_capabilities, scene_create, scene_look.'));
});

test('a hidden tool cannot be called', async context => {
  const client = await connectedClient(context, { tools: ['scene_capabilities'] });
  await assert.rejects(() => client.callTool({ name: 'scene_create', arguments: { recipe: {} } }), /Tool scene_create not found/);
});

test('parseToolSelection trims, drops repeats and rejects unknown names or a list without scene_capabilities', () => {
  assert.equal(parseToolSelection(undefined), undefined);
  assert.deepEqual(parseToolSelection(' scene_capabilities , scene_create,scene_create'), ['scene_capabilities', 'scene_create']);
  assert.throws(() => parseToolSelection('scene_capabilities,scene_teleport'), /unknown tools: scene_teleport\. Pass a comma-separated list of: scene_capabilities/);
  assert.throws(() => parseToolSelection('scene_create,scene_look'), /must include scene_capabilities/);
  assert.throws(() => parseToolSelection('scene_capabilities,scene_ask_user_submit'), /unknown tools: scene_ask_user_submit/);
});

test('runMcpCli rejects a bad --tools value before serving', async () => {
  await assert.rejects(() => runMcpCli({ argumentsValue: ['--tools', 'scene_create'] }), /must include scene_capabilities/);
});
