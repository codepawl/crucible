import { invalidField } from './field-error.js';

// The weights of one vertex group drawn into UV space, so a material graph can read them as a texture. Every triangle is
// filled at its UVs with the barycentric blend of its three vertex weights, then the filled texels spread a few texels
// outward so bilinear reads next to a UV island edge do not blend with empty texels. Row 0 is v = 0, as in a baked graph.

const DILATION_PASSES = 4;
const INSIDE_TOLERANCE = 1e-6;

function groupWeights(geometry, name, nodeId) {
  if (!geometry.uvs) {
    throw invalidField('vertexGroup', name, `a mesh with UVs (node ${nodeId} has none); add UVs with a uv mesh edit, or use box mapping and material.wear for per-pixel wear`);
  }
  const weights = geometry.vertexGroups?.[name];
  if (!weights) {
    const known = Object.keys(geometry.vertexGroups ?? {});
    throw invalidField('vertexGroup', name, `a vertex group of the mesh of node ${nodeId} (known groups: ${known.join(', ') || 'none'}); make one with a vertex_group mesh edit`);
  }
  return weights;
}

function fillTriangle(texels, covered, resolution, uvs, weights, corners) {
  const points = corners.map(corner => [uvs[corner * 2] * resolution, uvs[corner * 2 + 1] * resolution]);
  const [[ax, ay], [bx, by], [cx, cy]] = points;
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < INSIDE_TOLERANCE) return;
  const firstColumn = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1));
  const lastColumn = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
  const firstRow = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1));
  const lastRow = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const pointX = column + 0.5;
      const pointY = row + 0.5;
      const weightB = ((pointX - ax) * (cy - ay) - (cx - ax) * (pointY - ay)) / area;
      const weightC = ((bx - ax) * (pointY - ay) - (pointX - ax) * (by - ay)) / area;
      const weightA = 1 - weightB - weightC;
      if (weightA < -INSIDE_TOLERANCE || weightB < -INSIDE_TOLERANCE || weightC < -INSIDE_TOLERANCE) continue;
      const value = weightA * weights[corners[0]] + weightB * weights[corners[1]] + weightC * weights[corners[2]];
      const pixel = row * resolution + column;
      texels[pixel] = Math.min(255, Math.max(0, Math.round(value * 255)));
      covered[pixel] = 1;
    }
  }
}

export function dilateTexels(texels, covered, resolution) {
  for (let pass = 0; pass < DILATION_PASSES; pass++) {
    const spread = [];
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const pixel = row * resolution + column;
        if (covered[pixel]) continue;
        let sum = 0;
        let count = 0;
        for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
            const neighbourRow = row + rowOffset;
            const neighbourColumn = column + columnOffset;
            if (neighbourRow < 0 || neighbourColumn < 0 || neighbourRow >= resolution || neighbourColumn >= resolution) continue;
            const neighbour = neighbourRow * resolution + neighbourColumn;
            if (!covered[neighbour]) continue;
            sum += texels[neighbour];
            count++;
          }
        }
        if (count > 0) spread.push([pixel, Math.round(sum / count)]);
      }
    }
    for (const [pixel, value] of spread) {
      texels[pixel] = value;
      covered[pixel] = 1;
    }
  }
}

const mapsByGeometry = new WeakMap();

/**
 * One group of a render geometry as `{ width, height, data }` RGBA bytes with the weight (0 to 255) in the red channel.
 * Cached per geometry, group and resolution, so a part keeps the same map between rebuilds. Throws, with what to pass
 * instead, when the mesh has no UVs or no such group.
 */
export function vertexGroupMap(geometry, name, resolution, nodeId) {
  const weights = groupWeights(geometry, name, nodeId);
  let maps = mapsByGeometry.get(geometry);
  if (!maps) {
    maps = new Map();
    mapsByGeometry.set(geometry, maps);
  }
  const key = `${name}|${resolution}`;
  const remembered = maps.get(key);
  if (remembered) return remembered;
  const texels = new Uint8Array(resolution * resolution);
  const covered = new Uint8Array(resolution * resolution);
  const { indices, uvs } = geometry;
  const cornerCount = indices ? indices.length : weights.length;
  for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
    const corners = indices ? [indices[corner], indices[corner + 1], indices[corner + 2]] : [corner, corner + 1, corner + 2];
    fillTriangle(texels, covered, resolution, uvs, weights, corners);
  }
  dilateTexels(texels, covered, resolution);
  const data = new Uint8ClampedArray(resolution * resolution * 4);
  for (let pixel = 0; pixel < texels.length; pixel++) {
    data[pixel * 4] = texels[pixel];
    data[pixel * 4 + 3] = 255;
  }
  const map = Object.freeze({ width: resolution, height: resolution, data });
  maps.set(key, map);
  return map;
}
