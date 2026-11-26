import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createAgentScene } from '../src/agent-scene.js';
import { buildWithKernels, forEachDeferring, kernelStats, resetKernelStats } from '../src/kernel-offload.js';
import { compileMaterialGraph } from '../src/material-graph.js';

const WORKER_SCRIPT = new URL('./support/kernel-worker-thread.mjs', import.meta.url);
const MATERIAL_COUNT = 6;
const RESOLUTION = 1024;
// Preview deadline is 30 s (`DEFAULT_PREVIEW_DEADLINE_SECONDS` in scripts/preview-deadline.mjs).
const PREVIEW_BUDGET_MILLISECONDS = 30_000;

function createNodeKernelWorker() {
  const worker = new Worker(WORKER_SCRIPT);
  const adapter = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
  };
  worker.on('message', data => adapter.onmessage?.({ data }));
  worker.on('error', error => adapter.onerror?.(error));
  worker.on('messageerror', () => adapter.onmessageerror?.());
  return adapter;
}

function makeSnowLayerGraph(seed) {
  const slope = { surface: { output: 'slope', space: 'world' } };
  const height = { surface: { output: 'height', space: 'world', range: [0, 8] } };
  const macroNoise = { noise: { scale: 6, seed, octaves: 2 } };
  const fineNoise = { noise: { scale: 32, seed: seed + 100, octaves: 1 } };
  const sparkle = { whiteNoise: { scale: 64, seed: seed + 200 } };
  const snowMask = {
    smoothstep: [0.35, 0.55, {
      add: [
        { invert: slope },
        {
          add: [
            { mul: [{ sub: [macroNoise, 0.5] }, 0.3] },
            { add: [{ mul: [{ sub: [fineNoise, 0.5] }, 0.15] }, { mul: [height, 0.2] }] },
          ],
        },
      ],
    }],
  };
  return {
    color: {
      layer: {
        base: { mix: [[0.18, 0.16, 0.14], [0.32, 0.29, 0.25], macroNoise] },
        top: { mix: [[0.85, 0.9, 0.96], [1, 1, 1], { mul: [sparkle, 0.3] }] },
        mask: snowMask,
        edge: 0.5,
        softness: 0.1,
      },
    },
    roughness: {
      layer: {
        base: 0.92,
        top: { mix: [0.55, 0.15, { smoothstep: [0.92, 0.99, sparkle] }] },
        mask: snowMask,
        edge: 0.5,
        softness: 0.1,
      },
    },
    height: {
      layer: {
        base: macroNoise,
        top: { mul: [fineNoise, 0.2] },
        mask: snowMask,
        edge: 0.5,
        softness: 0.1,
      },
    },
  };
}

function makeSixMaterialRecipe() {
  const materials = [];
  const geometries = [];
  const nodes = [];
  for (let materialIndex = 0; materialIndex < MATERIAL_COUNT; materialIndex++) {
    const seed = 10 + materialIndex * 17;
    const graph = makeSnowLayerGraph(seed);
    assert.ok(compileMaterialGraph(graph).cost * RESOLUTION * RESOLUTION <= 60_000_000);
    materials.push({
      id: `snow_${materialIndex}`,
      pattern: { type: 'graph', resolution: RESOLUTION, mapping: 'uv', bump: 2, graph },
    });
    geometries.push({ id: `rock_${materialIndex}`, type: 'sphere', segments: 32, rings: 24 });
    nodes.push({
      id: `mesh_${materialIndex}`,
      geometry: `rock_${materialIndex}`,
      material: `snow_${materialIndex}`,
      translation: [(materialIndex % 3) * 4 - 4, 0, Math.floor(materialIndex / 3) * 4 - 2],
    });
  }
  return { format: 'crucible.scene', schemaVersion: 1, materials, geometries, nodes };
}

test('scene with 6 distinct 1024x1024 masked snow-layer materials builds in batched worker passes inside the preview budget (#3147)', async () => {
  const recipe = makeSixMaterialRecipe();
  resetKernelStats();
  let built;
  const startedAt = performance.now();
  const scene = await buildWithKernels(() => {
    built ??= createAgentScene(recipe);
    forEachDeferring(built.parts, part => {
      void part.material.map;
    });
    return built;
  }, { createWorker: createNodeKernelWorker, available: true, maximumWorkers: 4 });
  const elapsedMilliseconds = performance.now() - startedAt;
  const stats = kernelStats();
  assert.equal(scene.parts.length, MATERIAL_COUNT);
  assert.equal(stats.passes, 3, 'surface masks, pattern bakes, then final read');
  assert.equal(stats.worker, MATERIAL_COUNT * 3, '12 surface masks + 6 pattern bakes on workers');
  assert.deepEqual(stats.fallbacks, []);
  assert.ok(elapsedMilliseconds < PREVIEW_BUDGET_MILLISECONDS, `6x 1024^2 build took ${Math.round(elapsedMilliseconds)} ms`);
  for (const part of scene.parts) {
    assert.equal(part.material.map.image.width, RESOLUTION);
    assert.equal(part.material.normalMap.image.width, RESOLUTION);
    assert.equal(part.material.metallicRoughnessMap.image.width, RESOLUTION);
  }
});
