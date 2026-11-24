import { createMeshQueryIndex, withoutDegenerateTriangles } from '../src/mesh-query.js';
import { barycentricWeights, texelFrame } from './normal-map-bake.mjs';

// The normal pass the baked map should produce, computed on the CPU from the spec: each pixel's camera ray is cast at the
// low-poly mesh, the map is read at the UV of the hit point (nearest texel, row y at v = (y + 0.5) / height) and its
// tangent-space vector is turned into a world normal with the interpolated normal, TANGENT xyz and handedness.
// It shares no code with the renderer's shader, so it separates a wrong tangent frame in the renderer from the error the
// low-poly geometry has anyway (a pixel's ray meets a different surface point on the low mesh than on the high one).
// Returns an RGBA float array like a normal pass: n * 0.5 + 0.5, zero where the ray misses, rows from the bottom up.

function cameraRays({ eye, target, up, fov }, size) {
  const forward = normalize(target.map((value, axis) => value - eye[axis]));
  const right = normalize(cross(forward, up));
  const trueUp = cross(right, forward);
  const reach = Math.tan(fov * Math.PI / 360);
  return (column, rowFromBottom) => {
    const x = ((column + 0.5) / size * 2 - 1) * reach;
    const y = ((rowFromBottom + 0.5) / size * 2 - 1) * reach;
    return normalize(forward.map((value, axis) => value + right[axis] * x + trueUp[axis] * y));
  };
}

const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
const normalize = vector => vector.map(value => value / Math.hypot(...vector));
const cross = (left, right) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
const readVector = (array, index, width) => Array.from(array.subarray(index * width, index * width + width));

function mapVector(map, uv) {
  const column = Math.min(map.width - 1, Math.max(0, Math.floor(uv[0] * map.width)));
  const row = Math.min(map.height - 1, Math.max(0, Math.floor(uv[1] * map.height)));
  return [0, 1, 2].map(channel => map.data[(row * map.width + column) * 4 + channel] / 255 * 2 - 1);
}

export function oraclePass(low, map, camera, size, maximumDistance) {
  const clean = withoutDegenerateTriangles({ positions: low.positions, indices: low.indices });
  const index = createMeshQueryIndex({ positions: new Float32Array(clean.positions), indices: clean.indices });
  const rayThrough = cameraRays(camera, size);
  const pixels = new Float32Array(size * size * 4);
  const texelOfPixel = new Int32Array(size * size).fill(-1);
  const texelMargin = new Float32Array(size * size);
  const reflectsAboveSurface = new Uint8Array(size * size);
  try {
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const direction = rayThrough(column, row);
        const hit = index.firstHit(camera.eye, direction, maximumDistance);
        if (!hit) continue;
        const corners = [clean.indices[hit.triangle * 3], clean.indices[hit.triangle * 3 + 1], clean.indices[hit.triangle * 3 + 2]];
        const point = camera.eye.map((value, axis) => value + direction[axis] * hit.distance);
        const weights = barycentricWeights(point, ...corners.map(vertex => readVector(low.positions, vertex, 3)));
        const frame = weights && texelFrame(low, corners, weights);
        if (!frame) continue;
        const uv = [0, 1].map(axis => corners.reduce((total, vertex, corner) => total + weights[corner] * low.uvs[vertex * 2 + axis], 0));
        const local = mapVector(map, uv);
        texelOfPixel[row * size + column] = texelAt(map, uv);
        texelMargin[row * size + column] = marginToTexelEdge(map, uv);
        const world = normalize([0, 1, 2].map(axis => local[0] * frame.tangent[axis] + local[1] * frame.bitangent[axis] + local[2] * frame.normal[axis]));
        reflectsAboveSurface[row * size + column] = normalReflectsAboveSurface(world, frame.normal, direction.map(value => -value)) ? 1 : 0;
        pixels.set([...world.map(value => value * 0.5 + 0.5), 1], (row * size + column) * 4);
      }
    }
  } finally {
    index.dispose();
  }
  return { pixels, texelOfPixel, texelMargin, reflectsAboveSurface };
}

/**
 * Whether the view direction reflected about `normal` stays above the surface of `geometricNormal`. The renderer bends a
 * mapped normal for which it does not (a normal facing away from the viewer or tilted below the surface) toward the
 * geometric one, so such a pixel differs from a plain tangent-space decode by design and is left out of the comparison.
 */
export function normalReflectsAboveSurface(normal, geometricNormal, viewDirection) {
  const height = dot(normal, geometricNormal);
  if (height < 0) return false;
  const along = 2 * dot(normal, viewDirection);
  const reflected = normal.map((value, axis) => along * value - viewDirection[axis]);
  const threshold = Math.min(0.9 * dot(geometricNormal, viewDirection), 0.01);
  return dot(geometricNormal, reflected) >= threshold;
}

/** How far, in texels, the sample position is from the nearest texel edge in either direction (0 to 0.5). */
function marginToTexelEdge(map, uv) {
  const fractions = [uv[0] * map.width, uv[1] * map.height].map(position => position - Math.floor(position));
  return Math.min(...fractions.map(fraction => Math.min(fraction, 1 - fraction)));
}

function texelAt(map, uv) {
  const column = Math.min(map.width - 1, Math.max(0, Math.floor(uv[0] * map.width)));
  const row = Math.min(map.height - 1, Math.max(0, Math.floor(uv[1] * map.height)));
  return row * map.width + column;
}

/**
 * 1 for the pixels whose map texel has `radius` texels of covered map around it in every direction, so a pixel that reads
 * padding, an island border or a seam within a few texels is left out. `texelOfPixel` is the second value of oraclePass;
 * `coverage` and `resolution` come from the bake. A pixel the ray missed stays 0.
 */
export function pixelsAwayFromIslandBorders(texelOfPixel, coverage, resolution, radius) {
  const away = new Uint8Array(texelOfPixel.length);
  for (let pixel = 0; pixel < texelOfPixel.length; pixel++) {
    const texel = texelOfPixel[pixel];
    if (texel < 0) continue;
    const column = texel % resolution;
    const row = Math.floor(texel / resolution);
    let allCovered = 1;
    for (let rowOffset = -radius; rowOffset <= radius && allCovered; rowOffset++) {
      for (let columnOffset = -radius; columnOffset <= radius; columnOffset++) {
        const neighbourRow = row + rowOffset;
        const neighbourColumn = column + columnOffset;
        const inside = neighbourRow >= 0 && neighbourRow < resolution && neighbourColumn >= 0 && neighbourColumn < resolution;
        if (!inside || !coverage[neighbourRow * resolution + neighbourColumn]) {
          allCovered = 0;
          break;
        }
      }
    }
    away[pixel] = allCovered;
  }
  return away;
}
