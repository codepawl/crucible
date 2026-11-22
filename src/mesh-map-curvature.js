// Curvature per texel, measured in 3D so a UV seam does not hide a fold. Every covered texel has a point on the surface and
// the face normal of its triangle. A texel's curvature is the weighted mean, over the sample points within `radius` metres of
// it that sit across a fold, of how far the normal turns toward the direction of travel: (n_other - n) . d / |d|, with d the
// offset between the two points. It is positive over a convex fold, negative over a concave one and 0 on a flat surface. A
// bevel then reads as one band, because a texel in the middle of the bevel strip reaches the flat faces on both sides as long
// as `radius` covers half of the strip, where a comparison inside one UV island saw only the strip's own normal there.
//
// The weight of a neighbour falls smoothly from 1 at the texel to 0 at `radius`, so the value changes smoothly as the texel
// moves. The neighbours are sample points on a lattice of texels whose spacing, per triangle, gives the same distance in
// metres everywhere on the surface, however the UV map stretches it. That bounds the work at high resolution and keeps the
// result deterministic. A per-cell cap on the points gave a band edge that scalloped at the period of the grid cells (a cell
// holding many points was thinned more than its neighbour), and one lattice for the whole map left a thin, sparse face
// under-sampled next to a stretched one.

const SAMPLE_SPACING_SHARE = 0.3;
const MINIMUM_FACING = -0.5;
const FOLD_TURN = 0.02;
const FULL_SHARE = 0.04;
const GRID_CELLS_PER_AXIS = 1024;

function cellIndex(value, low, cellSize) {
  return Math.min(GRID_CELLS_PER_AXIS - 1, Math.max(0, Math.floor((value - low) / cellSize)));
}

function cellKeyOf(cellX, cellY, cellZ) {
  return cellX + GRID_CELLS_PER_AXIS * (cellY + GRID_CELLS_PER_AXIS * cellZ);
}

function gridKey(points, texel, lowCorner, cellSize) {
  return cellKeyOf(
    cellIndex(points[texel * 3], lowCorner[0], cellSize),
    cellIndex(points[texel * 3 + 1], lowCorner[1], cellSize),
    cellIndex(points[texel * 3 + 2], lowCorner[2], cellSize),
  );
}

function distanceBetweenTexels(points, first, second) {
  return Math.hypot(points[first * 3] - points[second * 3], points[first * 3 + 1] - points[second * 3 + 1], points[first * 3 + 2] - points[second * 3 + 2]);
}

// Per triangle, the mean 3D distance between a texel and its right and its lower neighbour inside the same triangle: how many
// metres one texel step covers along each map axis there. A UV map is not uniform, so this differs between triangles.
function texelSpacings(triangleOf, points, resolution) {
  const triangleCount = triangleOf.reduce((highest, triangle) => Math.max(highest, triangle), -1) + 1;
  const sums = new Float64Array(triangleCount * 2);
  const counts = new Float64Array(triangleCount * 2);
  for (let texel = 0; texel < triangleOf.length; texel++) {
    const triangle = triangleOf[texel];
    if (triangle < 0) continue;
    const column = texel % resolution;
    if (column + 1 < resolution && triangleOf[texel + 1] === triangle) {
      sums[triangle * 2] += distanceBetweenTexels(points, texel, texel + 1);
      counts[triangle * 2]++;
    }
    if (texel + resolution < triangleOf.length && triangleOf[texel + resolution] === triangle) {
      sums[triangle * 2 + 1] += distanceBetweenTexels(points, texel, texel + resolution);
      counts[triangle * 2 + 1]++;
    }
  }
  return { sums, counts };
}

// The sample points: on a lattice whose spacing in each triangle is as close to SAMPLE_SPACING_SHARE of the radius as the
// texels allow, so the points are spread evenly over the surface, however the UV map stretches it.
function buildGrid(triangleOf, points, lowCorner, cellSize) {
  const resolution = Math.round(Math.sqrt(triangleOf.length));
  const { sums, counts } = texelSpacings(triangleOf, points, resolution);
  const wantedSpacing = cellSize * SAMPLE_SPACING_SHARE;
  const stepOf = (triangle, axis) => {
    const count = counts[triangle * 2 + axis];
    if (count === 0) return 1;
    return Math.max(1, Math.floor(wantedSpacing / (sums[triangle * 2 + axis] / count)));
  };
  const cellOf = new Map();
  for (let texelY = 0; texelY < resolution; texelY++) {
    for (let texelX = 0; texelX < resolution; texelX++) {
      const texel = texelY * resolution + texelX;
      const triangle = triangleOf[texel];
      if (triangle < 0) continue;
      if (texelX % stepOf(triangle, 0) !== 0 || texelY % stepOf(triangle, 1) !== 0) continue;
      const key = gridKey(points, texel, lowCorner, cellSize);
      const members = cellOf.get(key);
      if (members) members.push(texel);
      else cellOf.set(key, [texel]);
    }
  }
  return cellOf;
}

// Every sample point in the 27 cells around a cell. Texels are visited in map order, so the next texel is almost always in
// the same cell: the last answer is kept and the 27 lookups are skipped.
function candidatesAround(cellX, cellY, cellZ, context) {
  const key = cellKeyOf(cellX, cellY, cellZ);
  if (context.lastKey === key) return context.lastCandidates;
  const candidates = [];
  for (let stepZ = -1; stepZ <= 1; stepZ++) {
    for (let stepY = -1; stepY <= 1; stepY++) {
      for (let stepX = -1; stepX <= 1; stepX++) {
        const members = context.grid.get(cellKeyOf(cellX + stepX, cellY + stepY, cellZ + stepZ));
        if (members) candidates.push(...members);
      }
    }
  }
  context.lastKey = key;
  context.lastCandidates = candidates;
  return candidates;
}

function curvatureOfTexel(texel, context) {
  const { triangleOf, points, normals, lowCorner, radius, gain } = context;
  const radiusSquared = radius * radius;
  const ownNormalOffset = triangleOf[texel] * 3;
  const ownX = points[texel * 3];
  const ownY = points[texel * 3 + 1];
  const ownZ = points[texel * 3 + 2];
  const cellX = cellIndex(ownX, lowCorner[0], radius);
  const cellY = cellIndex(ownY, lowCorner[1], radius);
  const cellZ = cellIndex(ownZ, lowCorner[2], radius);
  let foldSum = 0;
  let foldWeight = 0;
  let totalWeight = 0;
  for (const other of candidatesAround(cellX, cellY, cellZ, context)) {
    if (other === texel) continue;
    const deltaX = points[other * 3] - ownX;
    const deltaY = points[other * 3 + 1] - ownY;
    const deltaZ = points[other * 3 + 2] - ownZ;
    const squaredDistance = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (squaredDistance > radiusSquared || squaredDistance < 1e-24) continue;
    const distance = Math.sqrt(squaredDistance);

    const otherNormalOffset = triangleOf[other] * 3;
    const facing = normals[otherNormalOffset] * normals[ownNormalOffset] + normals[otherNormalOffset + 1] * normals[ownNormalOffset + 1] + normals[otherNormalOffset + 2] * normals[ownNormalOffset + 2];
    // The far side of a thin plate is not a neighbour on this surface.
    if (facing < MINIMUM_FACING) continue;
    const falloff = 1 - distance / radius;
    const weight = falloff * falloff;
    totalWeight += weight;
    const turnX = normals[otherNormalOffset] - normals[ownNormalOffset];
    const turnY = normals[otherNormalOffset + 1] - normals[ownNormalOffset + 1];
    const turnZ = normals[otherNormalOffset + 2] - normals[ownNormalOffset + 2];
    if (turnX * turnX + turnY * turnY + turnZ * turnZ < FOLD_TURN * FOLD_TURN) continue;
    foldSum += (weight * (turnX * deltaX + turnY * deltaY + turnZ * deltaZ)) / distance;
    foldWeight += weight;
  }
  if (foldWeight === 0) return 0.5;
  // The strength is the weighted mean turn of the neighbours that sit across a fold, not of all of them, so the middle of a
  // bevel strip (few neighbours across the fold) reads as strongly as its borders. It fades out only when under FULL_SHARE
  // of the neighbourhood is across a fold, which is the tail of the band beyond the reach.
  const presence = Math.min(1, foldWeight / totalWeight / FULL_SHARE);
  return 0.5 + 0.5 * Math.min(1, Math.max(-1, (gain * presence * foldSum) / foldWeight));
}

/**
 * Curvature 0 to 1 for each covered texel (0.5 flat, up on convex folds, down on concave ones) and 0 for the rest.
 * `surface` is { triangleOf, points } from the rasterizer, `normals` the face normals, `lowCorner` the bounding box corner
 * and `radius` the reach in metres, at least the bounding box diagonal over GRID_CELLS_PER_AXIS.
 */
export function surfaceCurvature(surface, normals, { lowCorner, radius, gain }) {
  const { triangleOf, points } = surface;
  const grid = buildGrid(triangleOf, points, lowCorner, radius);
  const context = { triangleOf, points, normals, grid, lowCorner, radius, gain };
  const values = new Float32Array(triangleOf.length);
  for (let texel = 0; texel < values.length; texel++) {
    if (triangleOf[texel] >= 0) values[texel] = curvatureOfTexel(texel, context);
  }
  return values;
}

export const CURVATURE_GRID_CELLS_PER_AXIS = GRID_CELLS_PER_AXIS;
