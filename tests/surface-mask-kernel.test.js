import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWithKernels, forEachDeferring, kernelStats, resetKernelStats } from '../src/kernel-offload.js';
import { answerKernelRequest } from '../src/kernel-registry.js';
import { surfaceMap } from '../src/material-surface-map.js';
import { MASK_RESOLUTION, WORLD_MATRIX, allMasks, digestOfMaps, maskCases, terrainChunkGeometries } from './support/surface-mask-fixture.mjs';

// The digest of every slope, normalY and height map of the fixture terrain, in object and world space, as the bake
// produced it on the main thread before it moved to a kernel.
const DIGEST_BEFORE_THE_KERNEL = '42387af5211211ca98aff9416ab3f1570bf6203027f240eeed2a84bc719281ee';

/** A worker that answers like the real one: the request and the answer both cross a structured clone. */
function createAnsweringWorker(log) {
  const worker = {
    postMessage(message) {
      log.push(message);
      const { response } = answerKernelRequest(structuredClone(message));
      setTimeout(() => worker.onmessage({ data: structuredClone(response) }), 0);
    },
    terminate() {},
  };
  return worker;
}

function bakeInSession(geometries, log) {
  return buildWithKernels(() => {
    const maps = [];
    const jobs = geometries.flatMap(geometry => maskCases().map(settings => ({ geometry, settings })));
    forEachDeferring(jobs, ({ geometry, settings }) => maps.push(surfaceMap(geometry, settings, MASK_RESOLUTION, 'terrain', WORLD_MATRIX)));
    return maps;
  }, { createWorker: () => createAnsweringWorker(log), available: true, maximumWorkers: 2 });
}

test('without a kernel session the masks keep the bytes the main-thread bake gave', () => {
  assert.equal(digestOfMaps(allMasks(terrainChunkGeometries(), surfaceMap)), DIGEST_BEFORE_THE_KERNEL);
});

test('the surfaceMask kernel answers with the bytes of the inline bake, for slope, normalY and height in both spaces', async () => {
  const inline = allMasks(terrainChunkGeometries(), surfaceMap);
  const log = [];
  const geometries = terrainChunkGeometries();
  const fromWorker = await bakeInSession(geometries, log);
  assert.equal(fromWorker.length, inline.length);
  assert.ok(log.length >= geometries.length * maskCases().length, `every mask goes to the worker, one task each, got ${log.length}`);
  assert.ok(log.every(message => message.name === 'surfaceMask'));
  fromWorker.forEach((map, index) => {
    assert.equal(map.width, inline[index].width);
    assert.deepEqual(Buffer.from(map.data), Buffer.from(inline[index].data), `map ${index} differs from the inline bake`);
  });
  assert.equal(digestOfMaps(fromWorker), DIGEST_BEFORE_THE_KERNEL);
});

test('every chunk is asked for in the first pass, not one pass per chunk', async () => {
  resetKernelStats();
  const log = [];
  await bakeInSession(terrainChunkGeometries(), log);
  assert.equal(kernelStats().passes, 2, 'one pass finds every missing mask, the second reads them');
});

test('a cached mask is not baked again, in a session or out of it', async () => {
  const geometries = terrainChunkGeometries();
  const log = [];
  const first = await bakeInSession(geometries, log);
  const tasksAfterFirstBake = log.length;
  const second = await bakeInSession(geometries, log);
  assert.equal(log.length, tasksAfterFirstBake, 'the second build asked the worker for nothing');
  second.forEach((map, index) => assert.equal(map, first[index], 'the very same map object comes back'));
  assert.equal(surfaceMap(geometries[0], { output: 'slope', space: 'object' }, MASK_RESOLUTION, 'terrain'), first[0]);
});

test('a mesh without UVs fails before any task is sent', async () => {
  const log = [];
  const geometry = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  await assert.rejects(
    buildWithKernels(() => surfaceMap(geometry, { output: 'slope', space: 'object' }, 8, 'rock'), { createWorker: () => createAnsweringWorker(log), available: true }),
    /node rock has none/,
  );
  assert.equal(log.length, 0);
});

function terrainLikeRecipe() {
  const blockGeometry = (id, size) => ({ id, type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 1, size }, edits: [{ op: 'uv_project', mode: 'cube' }] });
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [blockGeometry('block-a', [1, 1, 1]), blockGeometry('block-b', [2, 1, 1]), blockGeometry('block-c', [1, 3, 1])],
    materials: [{ id: 'snowy', pattern: { type: 'graph', mapping: 'uv', resolution: 256, graph: { color: { mul: [[1, 1, 1], { surface: { output: 'slope' } }] } } } }],
    nodes: ['a', 'b', 'c'].map((letter, index) => ({ id: `block-${letter}`, geometry: `block-${letter}`, material: 'snowy', translation: [index * 4, 0, 0] })),
  };
}

test('a scene built in a session bakes the masks of all its parts in one pass and keeps the textures', async () => {
  const { createAgentScene, loadAgentSceneModules } = await import('../src/agent-scene.js');
  await loadAgentSceneModules(terrainLikeRecipe());
  const textureBytes = parts => parts.map(part => Buffer.from(part.material.map.image.data).toString('base64')).join('|');
  const log = [];
  resetKernelStats();
  let built;
  const sessionBytes = await buildWithKernels(() => {
    built ??= createAgentScene(terrainLikeRecipe());
    forEachDeferring(built.parts, part => void part.material.map);
    return textureBytes(built.parts);
  }, { createWorker: () => createAnsweringWorker(log), available: true, maximumWorkers: 2 });
  assert.equal(sessionBytes, textureBytes(createAgentScene(terrainLikeRecipe()).parts), 'the inline build gives the same texture bytes');
  assert.equal(log.filter(message => message.name === 'surfaceMask').length, 3, 'one mask task per chunk');
  assert.equal(kernelStats().passes, 3, 'one pass for the masks, one for the pattern bakes, one to read them');
});
