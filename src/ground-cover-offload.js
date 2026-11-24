// Ground cover grown on a kernel worker (#3423). A meadow of about 960k blades takes over a second to build, which froze the
// page on every shot and every density edit. The grower is the same `groundCoverParts` that Node and MCP callers run inline, so
// a worker and the page return identical bytes for the same seed; this file only decides where it runs.

import { buildWithKernels, runKernel } from './kernel-offload.js';
import { groundCoverParts } from './ground-cover.js';

/**
 * The fields of each part that `groundCoverParts` reads, as plain data a worker can receive: names to match the surfaces, the
 * material name, tag and colour, the matrix and the triangles. Anything else a loaded part holds (textures, callbacks) stays home.
 */
export function snapshotGroundCoverParts(parts) {
  return parts.map(part => ({
    name: part.name,
    label: part.label,
    matrix: part.matrix,
    geometry: { positions: part.geometry.positions, indices: part.geometry.indices },
    material: part.material ? { name: part.material.name, tag: part.material.tag, color: part.material.color } : undefined,
  }));
}

/**
 * Grass parts for `entries` (from `normalizeGroundCover`) grown over `parts`, the same result as `groundCoverParts`. In a
 * browser the blades are built on a worker and the page stays free; without workers they are built here. `options` go to
 * `buildWithKernels` (`createWorker`, `signal`, `available`).
 */
export function growGroundCover(parts, entries, eye, options) {
  const snapshot = snapshotGroundCoverParts(parts);
  return buildWithKernels(() => runKernel('groundCover', [snapshot, entries, eye], groundCoverParts), options);
}
