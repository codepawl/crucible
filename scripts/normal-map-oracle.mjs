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
        const world = normalize([0, 1, 2].map(axis => local[0] * frame.tangent[axis] + local[1] * frame.bitangent[axis] + local[2] * frame.normal[axis]));
        pixels.set([...world.map(value => value * 0.5 + 0.5), 1], (row * size + column) * 4);
      }
    }
  } finally {
    index.dispose();
  }
  return pixels;
}
