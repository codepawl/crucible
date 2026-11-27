import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { createFragmentShader } from '../src/shaders.js';
import { layerTextureSupport } from '../src/shader-registry.js';
import { MaterialSnapshot } from '../src/material-snapshot.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import {
  TOON_RIM_DEFAULTS,
  TOON_RIM_LIMITS,
  TOON_BASE_DEFAULTS,
  TOON_BASE_LIMITS,
  normalizeToonRim,
  normalizeToonBase,
  toonRimFactor,
  toonBaseFactor,
  evaluateToonRim,
  evaluateToonBase,
} from '../src/toon-shader.js';

function recipeWithMaterial(material) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'cloud', ...material }],
    nodes: [{ id: 'puff', geometry: 'box', material: 'cloud' }],
  };
}

test('toonRim and toonBase fill defaults, freeze the result, and expose limits', () => {
  const rim = normalizeToonRim({});
  assert.deepEqual(rim, { color: [1, 1, 1], strength: 1, power: 3 });
  assert.ok(Object.isFrozen(rim) && Object.isFrozen(rim.color));
  assert.equal(normalizeToonRim(rim), rim);

  const base = normalizeToonBase({});
  assert.deepEqual(base, { color: [0.65, 0.82, 1], strength: 0.5 });
  assert.ok(Object.isFrozen(base) && Object.isFrozen(base.color));
  assert.equal(normalizeToonBase(base), base);

  assert.deepEqual(TOON_RIM_DEFAULTS.color, [1, 1, 1]);
  assert.deepEqual(TOON_RIM_LIMITS.power, [0.5, 12]);
  assert.deepEqual(TOON_BASE_DEFAULTS.color, [0.65, 0.82, 1]);
  assert.deepEqual(TOON_BASE_LIMITS.strength, [0, 2]);
});

test('toonRim and toonBase reject bad types, unknown keys, missing toon steps, and out-of-range values', () => {
  assert.throws(() => normalizeToonRim({}, 0), { name: 'RangeError', message: /toonRim.*toon above 0/ });
  assert.throws(() => normalizeToonBase({}, 0), { name: 'RangeError', message: /toonBase.*toon above 0/ });
  assert.throws(() => normalizeToonRim([], 6), { name: 'TypeError', message: /toonRim: got \[\]; expected an object/ });
  assert.throws(() => normalizeToonBase(null, 6), { name: 'TypeError', message: /toonBase: got null; expected an object/ });
  assert.throws(() => normalizeToonRim({ width: 1 }, 6), { name: 'TypeError', message: /toonRim\.width:.*one of the fields color, strength, power; remove width/ });
  assert.throws(() => normalizeToonBase({ power: 2 }, 6), { name: 'TypeError', message: /toonBase\.power:.*one of the fields color, strength; remove power/ });
  assert.throws(() => normalizeToonRim({ color: [1, 1] }, 6), { name: 'TypeError', message: /toonRim\.color:.*three linear RGB numbers/ });
  assert.throws(() => normalizeToonRim({ color: [1, 'a', 1] }, 6), { name: 'TypeError', message: /toonRim\.color\[1\]:.*finite number/ });
  assert.throws(() => normalizeToonRim({ color: [1, 5, 1] }, 6), { name: 'RangeError', message: /toonRim\.color\[1\]:.*from 0 to 4/ });
  assert.throws(() => normalizeToonBase({ color: [-0.1, 0.5, 1] }, 6), { name: 'RangeError', message: /toonBase\.color\[0\]:.*from 0 to 4/ });
  assert.throws(() => normalizeToonRim({ strength: 'bright' }, 6), { name: 'TypeError', message: /toonRim\.strength:.*finite number/ });
  assert.throws(() => normalizeToonRim({ strength: 4.5 }, 6), { name: 'RangeError', message: /toonRim\.strength:.*from 0 to 4/ });
  assert.throws(() => normalizeToonBase({ strength: 2.5 }, 6), { name: 'RangeError', message: /toonBase\.strength:.*from 0 to 2/ });
  assert.throws(() => normalizeToonRim({ power: NaN }, 6), { name: 'TypeError', message: /toonRim\.power:.*finite number/ });
  assert.throws(() => normalizeToonRim({ power: 0.25 }, 6), { name: 'RangeError', message: /toonRim\.power:.*from 0\.5 to 12/ });
  assert.throws(() => normalizeToonRim({ power: 13 }, 6), { name: 'RangeError', message: /toonRim\.power:.*from 0\.5 to 12/ });
});

test('recipes and set-material normalize toonRim and toonBase, load lineArt on demand, and clear with null', () => {
  assert.ok(agentSceneModulesNeeded(recipeWithMaterial({ toonRim: { strength: 1.5 } })).includes('lineArt'));
  assert.ok(agentSceneModulesNeeded(recipeWithMaterial({ toonBase: { strength: 0.4 } })).includes('lineArt'));

  const scene = createAgentScene(recipeWithMaterial({
    toon: 4,
    toonRim: { color: [1, 0.95, 0.9], strength: 2, power: 4 },
    toonBase: { color: [0.5, 0.7, 0.9], strength: 0.6 },
  }));
  assert.deepEqual(scene.parts[0].material.toonRim, { color: [1, 0.95, 0.9], strength: 2, power: 4 });
  assert.deepEqual(scene.parts[0].material.toonBase, { color: [0.5, 0.7, 0.9], strength: 0.6 });

  assert.throws(() => createAgentScene(recipeWithMaterial({ toonRim: { strength: 1 } })), /toonRim.*toon above 0/);
  assert.throws(() => createAgentScene(recipeWithMaterial({ toonBase: { strength: 0.5 } })), /toonBase.*toon above 0/);

  scene.apply([{
    type: 'set-material',
    id: 'cloud',
    toonRim: { strength: 1.2 },
    toonBase: null,
  }], { expectedRevision: 0 });
  assert.deepEqual(scene.parts[0].material.toonRim, { color: [1, 1, 1], strength: 1.2, power: 3 });
  assert.equal(scene.parts[0].material.toonBase, undefined);
});

test('plain shaders carry no toonRim or toonBase GLSL while toon shaders splice them cleanly into worldLight', () => {
  const plainShader = createFragmentShader([]);
  assert.doesNotMatch(plainShader, /materialToonRim|materialToonBase/);

  const toonShader = createFragmentShader(['toon']);
  assert.match(toonShader, /uniform vec4 materialToonRim;/);
  assert.match(toonShader, /uniform float materialToonRimPower;/);
  assert.match(toonShader, /uniform vec4 materialToonBase;/);
  assert.match(toonShader, /smoothstep\(-0\.15, 0\.55, dot\(normal, toonSunDirection\)\)/);
  assert.match(toonShader, /pow\(max\(1\.0 - max\(dot\(normal, viewDirection\), 0\.0\), 0\.0\), materialToonRimPower\)/);
  assert.match(toonShader, /smoothstep\(0\.1, 0\.75, -normalize\(worldNormal\)\.y\)/);
  const worldLightIndex = toonShader.indexOf('if (materialToonRim.a > 0.0)');
  const fogIndex = toonShader.indexOf('float fog = 1.0 - exp(');
  assert.ok(worldLightIndex > 0 && fogIndex > worldLightIndex, 'toonRim and toonBase run before fog');
});

test('layerTextureSupport.bind uploads toonRim and toonBase uniforms per batch and resets them when absent', () => {
  const calls = [];
  const renderer = {
    program: 'main',
    uniforms: {},
    shaderFeatures: new Set(['toon']),
    context: {
      getUniformLocation: (program, name) => name,
      uniform1f: (name, value) => calls.push(['1f', name, value]),
      uniform3fv: (name, values) => calls.push(['3fv', name, Array.from(values)]),
      uniform4f: (name, red, green, blue, alpha) => calls.push(['4f', name, red, green, blue, alpha]),
    },
  };
  const layerState = new Array(32).fill(0);
  layerState[30] = '';

  layerTextureSupport.bind(renderer, [], layerState, {
    parts: [{
      material: {
        toon: 6,
        toonRim: { color: [1, 0.9, 0.8], strength: 2.2, power: 4.5 },
        toonBase: { color: [0.4, 0.6, 0.85], strength: 0.7 },
      },
    }],
  });
  assert.deepEqual(calls.slice(2), [
    ['4f', 'materialToonRim', 1, 0.9, 0.8, 2.2],
    ['1f', 'materialToonRimPower', 4.5],
    ['4f', 'materialToonBase', 0.4, 0.6, 0.85, 0.7],
  ]);

  calls.length = 0;
  layerTextureSupport.bind(renderer, [], layerState, { parts: [{ material: { toon: 6 } }] });
  assert.deepEqual(calls.slice(2), [
    ['4f', 'materialToonRim', 0, 0, 0, 0],
    ['1f', 'materialToonRimPower', TOON_RIM_DEFAULTS.power],
    ['4f', 'materialToonBase', 0, 0, 0, 0],
  ]);
});

test('CPU reference math matches the sun-gated Fresnel rim and downward normal base curves', () => {
  assert.equal(toonRimFactor([0, 0, 1], [0, 0, 1], [0, 0, 1], 3), 0);
  assert.equal(toonRimFactor([1, 0, 0], [0, 0, 1], [1, 0, 0], 3), 1);
  assert.equal(toonRimFactor([1, 0, 0], [0, 0, 1], [-1, 0, 0], 3), 0);

  const grazingSun = toonRimFactor([1, 0, 0], [0, 0, 1], [0.2, 0, Math.sqrt(0.96)], 2);
  const expectedUnit = (0.2 - (-0.15)) / (0.55 - (-0.15));
  const expectedGate = expectedUnit * expectedUnit * (3 - 2 * expectedUnit);
  assert.ok(Math.abs(grazingSun - expectedGate) < 1e-12);

  const midRim = toonRimFactor([0.5, 0, Math.sqrt(0.75)], [0, 0, 1], [1, 0, 0], 2);
  assert.ok(Math.abs(midRim - 0.25 * (1 - 0)) < 0.3 && midRim > 0);

  assert.equal(toonBaseFactor(1), 0);
  assert.equal(toonBaseFactor(0), 0);
  assert.equal(toonBaseFactor(-0.1), 0);
  assert.ok(Math.abs(toonBaseFactor(-0.425) - 0.5) < 1e-12);
  assert.equal(toonBaseFactor(-0.75), 1);
  assert.equal(toonBaseFactor(-1), 1);

  assert.deepEqual(evaluateToonRim([1, 0, 0], [0, 0, 1], [1, 0, 0], { color: [1, 0.5, 0.25], strength: 2, power: 3 }), [2, 1, 0.5]);
  assert.deepEqual(evaluateToonRim([1, 0, 0], [0, 0, 1], [1, 0, 0], { strength: 0 }), [0, 0, 0]);
  const baseGlow = evaluateToonBase(-1, { color: [0.5, 0.75, 1], strength: 0.4 });
  [0.2, 0.3, 0.4].forEach((expected, index) => assert.ok(Math.abs(baseGlow[index] - expected) < 1e-12));
  assert.deepEqual(evaluateToonBase(0.2, { color: [0.5, 0.75, 1], strength: 0.4 }), [0, 0, 0]);
});

test('cumulus-towers recipe enables toonRim and toonBase with positive sun-side edge and underside lift', () => {
  const recipe = JSON.parse(readFileSync(new URL('../public/recipes/cumulus-towers.json', import.meta.url), 'utf8'));
  const cumulus = recipe.materials.find(material => material.id === 'cumulus');
  assert.ok(cumulus.toonRim && cumulus.toonRim.strength > 0);
  assert.ok(cumulus.toonBase && cumulus.toonBase.strength > 0);
  const rimNormalized = normalizeToonRim(cumulus.toonRim, cumulus.toon);
  const baseNormalized = normalizeToonBase(cumulus.toonBase, cumulus.toon);
  assert.ok(rimNormalized.strength >= 0.5 && rimNormalized.strength <= 4);
  assert.ok(baseNormalized.strength >= 0.1 && baseNormalized.strength <= 2);

  const edgeBoost = evaluateToonRim([0.8, 0.5, 0.33], [0, 0, 1], [0.5, 0.47, 0.72], rimNormalized);
  assert.ok(edgeBoost[0] > 0.2 && edgeBoost[1] > 0.2 && edgeBoost[2] > 0.2);
  const undersideBoost = evaluateToonBase(-1, baseNormalized);
  assert.ok(undersideBoost[2] > undersideBoost[0] && undersideBoost[2] > 0.1);
});

test('MaterialSnapshot skips snapshotting toonRim and toonBase, and MCP schemas accept and clear them', async () => {
  assert.equal(MaterialSnapshot.of({ color: [1, 1, 1], toonRim: { strength: 1 } }), null);
  assert.equal(MaterialSnapshot.of({ color: [1, 1, 1], toonBase: { strength: 0.5 } }), null);

  const server = createAgentMcpServer({
    async close() {},
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle' }; },
    activeSessionId() { return '00000000-0000-4000-8000-000000000001'; },
    async create({ recipe }) { return { sessionId: '00000000-0000-4000-8000-000000000001', materials: recipe.materials?.length ?? 0 }; },
    async apply({ operations }) { return { ok: true, count: operations.length }; },
  });
  const client = new Client({ name: 'toon-rim-base-mcp-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const created = await client.callTool({
      name: 'scene_create',
      arguments: {
        recipe: {
          format: 'crucible.scene',
          schemaVersion: 1,
          materials: [{ id: 'cloud', toon: 6, toonRim: { color: [1.5, 1.4, 1.3], strength: 3.5, power: 3.6 }, toonBase: { color: [0.8, 0.95, 1.1], strength: 0.8 } }],
          nodes: [],
        },
      },
    });
    assert.equal(created.isError, undefined, JSON.stringify(created));

    const updated = await client.callTool({
      name: 'scene_apply',
      arguments: { expectedRevision: 0, operations: [{ type: 'set-material', id: 'cloud', toonRim: { strength: 2 }, toonBase: null }] },
    });
    assert.equal(updated.isError, undefined, JSON.stringify(updated));

    const rejected = await client.callTool({
      name: 'scene_create',
      arguments: { recipe: { format: 'crucible.scene', schemaVersion: 1, materials: [{ id: 'cloud', toon: 6, toonRim: { width: 1 } }], nodes: [] } },
    });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
