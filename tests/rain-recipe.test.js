import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { RAIN_DEFAULTS, resolveRain } from '../src/rain.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { previewHarness } from './support/preview-harness.mjs';

const STREET_RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'road-box', type: 'box' }],
  materials: [{ id: 'asphalt', color: [0.2, 0.2, 0.22], roughness: 0.85 }],
  nodes: [{ id: 'road', geometry: 'road-box', material: 'asphalt', translation: [0, -0.05, 0], scale: [10, 0.1, 40] }],
  camera: { eye: [0, 2, 10], target: [0, 1, -10] },
};

test('recipe markers load the rain module on demand and leave dry scenes unloaded', async () => {
  assert.ok(!agentSceneModulesNeeded(STREET_RECIPE).includes('rain'));
  const rainyRecipe = { ...STREET_RECIPE, environment: { rain: { intensity: 0.8, density: 2800 } } };
  assert.ok(agentSceneModulesNeeded(rainyRecipe).includes('rain'));

  await loadAgentSceneModules(rainyRecipe);
  const scene = createAgentScene(rainyRecipe);
  assert.equal(scene.environment.rain.intensity, 0.8);
  assert.equal(scene.environment.rain.density, 2800);
  assert.equal(scene.environment.rain.speed, RAIN_DEFAULTS.speed);

  const exported = scene.exportRecipe();
  assert.equal(exported.environment.rain.intensity, 0.8);
  assert.equal(createAgentScene(STREET_RECIPE).environment.rain, undefined);
});

test('set-environment updates and clears environment.rain and rejects invalid rain fields', async () => {
  const recipe = { ...STREET_RECIPE, environment: { rain: {} } };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  assert.equal(scene.environment.rain.intensity, RAIN_DEFAULTS.intensity);

  scene.apply([{ type: 'set-environment', environment: { rain: { intensity: 0.9, splashes: false } } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.rain.intensity, 0.9);
  assert.equal(scene.environment.rain.splashes, false);

  assert.throws(
    () => scene.apply([{ type: 'set-environment', environment: { rain: { intensity: 2 } } }], { expectedRevision: scene.revision }),
    /rain\.intensity/,
  );

  scene.apply([{ type: 'set-environment', environment: { rain: null } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.rain, undefined);
});

test('rain.wetness pairs with environment.puddles to flag wet ground mirror parts', async () => {
  const recipe = {
    ...STREET_RECIPE,
    environment: { rain: { intensity: 0.75, wetness: 0.8 }, puddles: { coverage: 0.6 } },
  };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  const roadPart = scene.parts.find(part => part.name === 'road');
  assert.equal(roadPart.material.waterReflection, true);
});

test('scene_capabilities and path tracer metadata handle environment.rain', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.rain.field, 'environment.rain');
  assert.equal(AGENT_SCENE_CAPABILITIES.rain.note, 'docs/rain.md');
  for (const field of ['intensity', 'intensityCurve', 'density', 'splashes', 'wetness', 'seed']) {
    assert.ok(AGENT_SCENE_CAPABILITIES.rain.fields.includes(field), `${field} documented in capabilities`);
  }

  const parts = [{ name: 'road', geometry: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint16Array([0, 1, 2]) }, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { color: [0.2, 0.2, 0.2], roughness: 0.8 } }];
  const environment = { rain: resolveRain({ intensity: 0.7 }) };
  assert.doesNotThrow(() => buildTraceScene(parts, environment));
  const ignored = describeIgnoredFeatures(parts, environment);
  assert.ok(ignored.some(note => /environment\.rain is ignored/.test(note)));
});

test('MCP schema accepts environment.rain and null clearing and exposes rain capability outline', async () => {
  const created = [];
  const applied = [];
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const runtime = {
    activeSessionId: () => sessionId,
    async close() {},
    async capabilities() { return { scene: { rain: AGENT_SCENE_CAPABILITIES.rain }, phase: 'idle' }; },
    async create(argumentsValue) {
      created.push(argumentsValue);
      return { sessionId, revision: 0 };
    },
    async apply(argumentsValue) {
      applied.push(argumentsValue);
      return { sessionId, revision: 1 };
    },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-rain-mcp-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const topic = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'environment.rain' } })).structuredContent;
  assert.ok(topic.fields.oneOf[0]['intensity?']);
  assert.ok(topic.fields.oneOf[0]['intensityCurve?']);

  const createResult = await client.callTool({
    name: 'scene_create',
    arguments: { recipe: { ...STREET_RECIPE, environment: { rain: { intensity: 0.8, density: 2000, wetness: 0.7 } } } },
  });
  assert.equal(createResult.isError, undefined);
  assert.equal(created[0].recipe.environment.rain.density, 2000);

  const clearResult = await client.callTool({
    name: 'scene_apply',
    arguments: { sessionId, expectedRevision: 0, operations: [{ type: 'set-environment', environment: { rain: null } }] },
  });
  assert.equal(clearResult.isError, undefined);
  assert.equal(applied[0].operations[0].environment.rain, null);

  const invalidResult = await client.callTool({
    name: 'scene_create',
    arguments: { recipe: { ...STREET_RECIPE, environment: { rain: { density: 10 } } } },
  });
  assert.equal(invalidResult.isError, true);

  await client.close();
  await server.close();
});

test('preview and render-job frames install rain and evaluate intensityCurve and wetness by rendererTime', async () => {
  const harness = previewHarness();
  const sessionId = 'rain-preview';
  await harness.preview.create({
    sessionId,
    backend: 'cpu',
    memoryBudgetMiB: 192,
    recipe: {
      ...STREET_RECIPE,
      environment: {
        rain: {
          density: 1200,
          wetness: 0.8,
          intensityCurve: [
            { time: 0, value: 0.25 },
            { time: 2, value: 1.0 },
          ],
        },
      },
    },
  });

  harness.preview.frame({ sessionId, rendererTime: 1 });
  assert.ok(Math.abs(harness.renders.at(-1).camera.environment.wetness - 0.8 * 0.625) < 1e-6);

  harness.preview.frame({ sessionId, rendererTime: 2 });
  assert.ok(Math.abs(harness.renders.at(-1).camera.environment.wetness - 0.8) < 1e-6);

  // Backward seek produces the exact same frame wetness.
  harness.preview.frame({ sessionId, rendererTime: 1 });
  assert.ok(Math.abs(harness.renders.at(-1).camera.environment.wetness - 0.8 * 0.625) < 1e-6);
});
