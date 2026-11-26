import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

test('scene_export_recipe through the runtime strips derived gradient sky radiance so scene_create accepts it', async (context) => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192 });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'export-gradient-sky-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close?.();
  });

  const baseRecipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'matte', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'box', geometry: 'box', material: 'matte', translation: [0, 0.5, 0] }],
  };
  for (const stops of [
    [{ at: 0, color: '#f48a4a' }, { at: 1, color: '#2a3550' }],
    [{ at: 0, color: '#ffffff' }, { at: 1, color: '#ffffff' }],
  ]) {
    const initial = { ...baseRecipe, environment: { setup: 'sunset', world: true, sky: { type: 'gradient', stops } } };
    const created = await client.callTool({ name: 'scene_create', arguments: { recipe: initial } }, { timeout: 120000 });
    assert.equal(created.isError, undefined, created.content?.find(item => item.type === 'text')?.text);
    const exported = await client.callTool({ name: 'scene_export_recipe', arguments: {} }, { timeout: 120000 });
    assert.equal(exported.isError, undefined, exported.content?.find(item => item.type === 'text')?.text);
    const roundTripRecipe = exported.structuredContent.recipe;
    assert.equal(roundTripRecipe.environment.skyTop, undefined);
    assert.equal(roundTripRecipe.environment.skyBottom, undefined);
    assert.equal(roundTripRecipe.environment.fogColor, undefined);
    assert.deepEqual(roundTripRecipe.environment.sky, { type: 'gradient', stops });
    const recreated = await client.callTool({ name: 'scene_create', arguments: { recipe: roundTripRecipe } }, { timeout: 120000 });
    assert.equal(recreated.isError, undefined, recreated.content?.find(item => item.type === 'text')?.text);
  }
});
