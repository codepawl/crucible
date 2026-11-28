import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { checkToolSchemas } from '../scripts/check-tool-schemas.mjs';
import { detectSchemaCompatProfile, normalizeToolsList } from '../scripts/mcp-schema-compat.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

async function connectClient({ clientName, schemaCompat = 'auto' }) {
  let scene;
  const server = createAgentMcpServer(
    {
      async close() {},
      async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
      async create({ recipe }) {
        scene = createAgentScene(recipe);
        return { sessionId: 'test-session', revision: scene.revision, inspection: scene.inspect(), render: { backend: 'fake' } };
      },
    },
    { schemaCompat },
  );
  const client = new Client({ name: clientName, version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

test('detectSchemaCompatProfile maps Gemini, Antigravity, OpenAI, and keeps others off', () => {
  assert.equal(detectSchemaCompatProfile('gemini-cli'), 'gemini');
  assert.equal(detectSchemaCompatProfile('antigravity'), 'gemini');
  assert.equal(detectSchemaCompatProfile('openai-mcp'), 'openai-strict');
  assert.equal(detectSchemaCompatProfile('claude-code'), 'off');
  assert.equal(detectSchemaCompatProfile(undefined), 'off');
});

test('normalizeToolsList gemini profile yields zero portable and zero gemini-subset findings across all 25 tools', async () => {
  const { server, client } = await connectClient({ clientName: 'gemini-cli' });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 26);
    const findings = checkToolSchemas(tools);
    const portable = findings.filter(item => item.profile === 'portable');
    const gemini = findings.filter(item => item.profile === 'gemini-subset');
    assert.deepEqual(portable, [], `Expected 0 portable findings, got: ${JSON.stringify(portable)}`);
    assert.deepEqual(gemini, [], `Expected 0 gemini-subset findings, got: ${JSON.stringify(gemini)}`);

    // Runtime Zod validation remains strict even after schema normalization.
    const invalidResult = await client.callTool({ name: 'scene_create', arguments: { recipe: { bogus: true } } });
    assert.equal(invalidResult.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('normalizeToolsList openai-strict profile removes unsupported OpenAI keywords cleanly', async () => {
  const { server, client } = await connectClient({ clientName: 'chatgpt-client' });
  try {
    const { tools } = await client.listTools();
    const findings = checkToolSchemas(tools);
    const portable = findings.filter(item => item.profile === 'portable');
    const openAi = findings.filter(item => item.profile === 'openai-strict');
    assert.deepEqual(portable, []);
    // Exclude depth/count metrics that depend on inline union depth if any; ensure zero structural/keyword violations.
    const keywordOrRequiredErrors = openAi.filter(item => !['nesting-depth', 'property-count', 'enum-count'].includes(item.rule));
    assert.deepEqual(keywordOrRequiredErrors, [], `Unexpected openai-strict findings: ${JSON.stringify(keywordOrRequiredErrors)}`);
  } finally {
    await client.close();
    await server.close();
  }
});

test('auto schemaCompat leaves non-Gemini/non-OpenAI clients byte-identical to off', async () => {
  const first = await connectClient({ clientName: 'claude-code', schemaCompat: 'auto' });
  const second = await connectClient({ clientName: 'claude-code', schemaCompat: 'off' });
  try {
    const listedAuto = (await first.client.listTools()).tools;
    const listedOff = (await second.client.listTools()).tools;
    assert.deepEqual(listedAuto, listedOff);
    assert.deepEqual(normalizeToolsList(listedOff, 'off'), listedOff);
  } finally {
    await first.client.close();
    await first.server.close();
    await second.client.close();
    await second.server.close();
  }
});
