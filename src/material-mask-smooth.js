// Smoothing of a baked surface mask. A coarse terrain mesh gives a slope that is linear inside each triangle, so a
// threshold on it (a snow edge) bends at every triangle edge and the shading shows flat facets. The bake blurs the
// covered texels with a Gaussian whose reach is a fixed share of the map, weighted by how close each neighbour's value is
// to the centre's (a bilateral filter), so a gentle ramp is rounded while a jump the mesh means (a cliff top, a cube
// edge) is left alone. The mesh and its triangle count are not touched; the cost is one window pass over the covered
// texels, and the answer depends only on the map.

// How far apart two values may be (of 255) before a neighbour counts for little: a jump of 80 weighs 0.6, a cube edge (255) 0.006.
const RANGE_SIGMA = 80;
// The Gaussian reaches this share of the map (4 texels at 1024), up to a cap so a large map costs a bounded window.
const SIGMA_SHARE = 4 / 1024;
const MAX_SIGMA = 4;

// A face steeper than this (0 flat, 1 vertical; 72 degrees) is never lightened by the smoothing: no snow stays on it, so the
// blur must not give it any.
export const STEEP_FACE_SLOPE = 0.8;

function gaussianWeights(sigma) {
  const radius = Math.max(1, Math.ceil(2 * sigma));
  const side = 2 * radius + 1;
  const weights = new Float32Array(side * side);
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      weights[(offsetY + radius) * side + offsetX + radius] = Math.exp(-(offsetX * offsetX + offsetY * offsetY) / (2 * sigma * sigma));
    }
  }
  return { radius, side, weights };
}

// The weight of a neighbour whose value differs by 0 to 255 from the centre.
const RANGE_WEIGHTS = Float32Array.from({ length: 256 }, (_, difference) => Math.exp(-(difference * difference) / (2 * RANGE_SIGMA * RANGE_SIGMA)));

/**
 * Blur the covered texels of a mask map in place. `steepFaces` (optional, one byte per texel) marks texels on a steep face,
 * which keep at least their own value. Uncovered texels are neither read nor written.
 */
export function smoothMaskTexels(texels, covered, resolution, steepFaces) {
  const { radius, side, weights } = gaussianWeights(Math.min(MAX_SIGMA, resolution * SIGMA_SHARE));
  const source = Uint8Array.from(texels);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const center = y * resolution + x;
      if (!covered[center]) continue;
      const centerValue = source[center];
      let sum = 0;
      let total = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY++) {
        const row = y + offsetY;
        if (row < 0 || row >= resolution) continue;
        for (let offsetX = -radius; offsetX <= radius; offsetX++) {
          const column = x + offsetX;
          if (column < 0 || column >= resolution) continue;
          const neighbour = row * resolution + column;
          if (!covered[neighbour]) continue;
          const difference = source[neighbour] - centerValue;
          const weight = weights[(offsetY + radius) * side + offsetX + radius] * RANGE_WEIGHTS[Math.abs(difference)];
          sum += weight * source[neighbour];
          total += weight;
        }
      }
      const blurred = Math.round(sum / total);
      texels[center] = steepFaces && steepFaces[center] ? Math.max(blurred, centerValue) : blurred;
    }
  }
}
