// What the surface mask bake costs the main thread with and without a kernel worker (#3424).
//
//   node bench/surface-mask-offload.mjs [--runs 5] [--chunks 8] [--resolution 512]
//
// Node has no Worker, so the worker is simulated on the same thread: the time a mask kernel spends inside
// `answerKernelRequest` is taken off the total, and what is left (hashing the input, cloning the request and the answer,
// reading the results back) is what the page pays while the real worker runs. It is the main-thread share, not a browser
// frame time; a browser number needs a browser run.

import { performance } from 'node:perf_hooks';
import { buildWithKernels, forEachDeferring } from '../src/kernel-offload.js';
import { answerKernelRequest } from '../src/kernel-registry.js';
import { surfaceMap } from '../src/material-surface-map.js';
import { createTerrain } from '../src/terrain.js';

function readOption(name, fallback, maximum = 64) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError(`--${name} needs a whole number from 1 to ${maximum}, got ${value}.`);
  return value;
}

const runs = readOption('runs', 5);
const chunks = readOption('chunks', 8);
const resolution = readOption('resolution', 512, 2048);
const SETTINGS = { output: 'slope', space: 'object' };

function freshChunks() {
  const terrain = createTerrain({ size: 1024, chunks, resolution: 48, levels: 3, height: { amplitude: 20, mountainAmplitude: 60, featureSize: 200 }, seed: 7 });
  return terrain.parts.map(part => ({ ...part.geometry })).filter(geometry => geometry.uvs);
}

function measureInline() {
  const geometries = freshChunks();
  const start = performance.now();
  for (const geometry of geometries) surfaceMap(geometry, SETTINGS, resolution, 'terrain');
  return { milliseconds: performance.now() - start, chunks: geometries.length };
}

async function measureOffloaded() {
  const geometries = freshChunks();
  let insideKernel = 0;
  const worker = {
    postMessage(message) {
      const request = structuredClone(message);
      const startedAt = performance.now();
      const { response, transfer } = answerKernelRequest(request);
      insideKernel += performance.now() - startedAt;
      // The real worker hands its result buffers over instead of copying them.
      const answer = structuredClone(response, { transfer });
      queueMicrotask(() => worker.onmessage({ data: answer }));
    },
    terminate() {},
  };
  const start = performance.now();
  await buildWithKernels(() => forEachDeferring(geometries, geometry => surfaceMap(geometry, SETTINGS, resolution, 'terrain')), { createWorker: () => worker, available: true, maximumWorkers: 1 });
  return { milliseconds: performance.now() - start - insideKernel, kernelMilliseconds: insideKernel };
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

measureInline();
await measureOffloaded();
const inline = [];
const offloaded = [];
const kernel = [];
for (let run = 0; run < runs; run++) {
  inline.push(measureInline().milliseconds);
  const result = await measureOffloaded();
  offloaded.push(result.milliseconds);
  kernel.push(result.kernelMilliseconds);
}
console.log(`${chunks * chunks}-chunk terrain, slope mask at ${resolution} px, median of ${runs} runs`);
console.log(`inline bake, main thread: ${median(inline).toFixed(1)} ms`);
console.log(`kernel session, main thread (simulated worker): ${median(offloaded).toFixed(1)} ms`);
console.log(`kernel work moved to the worker: ${median(kernel).toFixed(1)} ms`);
