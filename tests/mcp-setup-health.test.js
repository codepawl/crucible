import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { assessMcpSetupHealth, setupHealthNoticeText } from '../src/mcp-setup-health.js';

const EIGHT_GIB = 8 * 1024 * 1024 * 1024;

test('assessMcpSetupHealth reports structured warnings when setup is degraded and stays quiet when healthy', () => {
  const healthy = assessMcpSetupHealth({
    backend: 'gpu',
    memory: 512,
    totalMemoryBytes: EIGHT_GIB,
    assetsConfigured: true,
    jobsConfigured: true,
    nativeCookAvailable: true,
  });
  assert.equal(healthy.status, 'ok');
  assert.deepEqual(healthy.warnings, []);
  assert.equal(setupHealthNoticeText(healthy), '');

  const degraded = assessMcpSetupHealth({
    backend: 'cpu',
    memory: 192,
    totalMemoryBytes: EIGHT_GIB,
    assetsConfigured: false,
    jobsConfigured: false,
    skillSyncMismatch: '0.22.0',
  });
  assert.equal(degraded.status, 'degraded');
  const codes = degraded.warnings.map(warning => warning.code);
  assert.deepEqual(codes, ['CPU_BACKEND', 'LOW_MEMORY', 'ASSETS_UNCONFIGURED', 'JOBS_UNCONFIGURED', 'SKILLS_OUT_OF_SYNC']);
  for (const warning of degraded.warnings) {
    assert.equal(typeof warning.impact, 'string');
    assert.equal(typeof warning.fix, 'string');
    assert.ok(warning.impact.length > 0 && warning.fix.length > 0);
  }
  assert.match(setupHealthNoticeText(degraded), /CPU_BACKEND/);
});

test('scene_capabilities emits one-shot setupWarnings when degraded and serves topic setupHealth', async () => {
  const health = assessMcpSetupHealth({
    backend: 'gpu',
    memory: 192,
    totalMemoryBytes: EIGHT_GIB,
    assetsConfigured: false,
    jobsConfigured: false,
  });
  const server = createAgentMcpServer(
    {
      async close() {},
      setupHealth() { return health; },
      async capabilities() {
        return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: '0.22.0', setupHealth: health };
      },
    },
    { setupHealth: () => health },
  );
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.match(client.getInstructions(), /Setup health is degraded \(LOW_MEMORY, ASSETS_UNCONFIGURED, JOBS_UNCONFIGURED\)/);
    const first = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
    assert.ok(Array.isArray(first.setupWarnings));
    assert.equal(first.setupWarnings.length, 3);

    const second = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
    assert.equal('setupWarnings' in second, false);

    const topicAnswer = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'setupHealth' } })).structuredContent;
    assert.equal(topicAnswer.topic, 'setupHealth');
    assert.equal(topicAnswer.value.status, 'degraded');
    assert.equal(topicAnswer.value.warnings.length, 3);
  } finally {
    await client.close();
    await server.close();
  }
});

test('healthy runtime omits setupWarnings from scene_capabilities and instructions', async () => {
  const healthy = assessMcpSetupHealth({ backend: 'gpu', memory: 512, totalMemoryBytes: EIGHT_GIB });
  const server = createAgentMcpServer({
    async close() {},
    setupHealth: () => healthy,
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: '0.22.0', setupHealth: healthy }; },
  });
  const client = new Client({ name: 'claude-code', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.doesNotMatch(client.getInstructions(), /Setup health is degraded/);
    const result = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
    assert.equal('setupWarnings' in result, false);
  } finally {
    await client.close();
    await server.close();
  }
});
