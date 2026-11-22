// Which ground cells a terrain's holes remove. A cell goes when its centre lies strictly inside a hole circle,
// the same rule the terrain mesh builder uses, so these answers match the mesh without building it.
export const TERRAIN_DEFAULT_SIZE = 40;
export const TERRAIN_DEFAULT_RESOLUTION = 64;

function cellCentre(index, cellSize, halfSize) {
  return -halfSize + (index + 0.5) * cellSize;
}

function insideAnyHole(holes, centreX, centreZ) {
  return holes.some(hole => Math.hypot(centreX - hole.center[0], centreZ - hole.center[1]) < hole.radius);
}

/** True when the holes remove every cell of a size by size ground cut into resolution by resolution cells. */
export function holesCoverWholeGround(holes, size, resolution) {
  if (!Array.isArray(holes) || holes.length === 0) return false;
  const cellSize = size / resolution;
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      if (!insideAnyHole(holes, cellCentre(column, cellSize, size / 2), cellCentre(row, cellSize, size / 2))) return false;
    }
  }
  return true;
}

function nearestCellIndex(coordinate, cellSize, halfSize, resolution) {
  const index = Math.round((coordinate + halfSize) / cellSize - 0.5);
  return Math.min(Math.max(index, 0), resolution - 1);
}

/** Distance from a hole's centre to the nearest cell centre: the hole removes a cell only with a radius above it. */
export function distanceToNearestCellCentre(hole, size, resolution) {
  const cellSize = size / resolution;
  const halfSize = size / 2;
  const nearestX = cellCentre(nearestCellIndex(hole.center[0], cellSize, halfSize, resolution), cellSize, halfSize);
  const nearestZ = cellCentre(nearestCellIndex(hole.center[1], cellSize, halfSize, resolution), cellSize, halfSize);
  return Math.hypot(hole.center[0] - nearestX, hole.center[1] - nearestZ);
}

/** Holes of a terrain record that remove no cell, each with the cell size and the smallest radius (to 3 decimals) that would remove one. */
export function holesRemovingNoCell(value) {
  const size = value.size ?? TERRAIN_DEFAULT_SIZE;
  // Chunks of resolution cells each lie side by side, so the ground has chunks * resolution cells across.
  const resolution = (value.resolution ?? TERRAIN_DEFAULT_RESOLUTION) * (value.chunks ?? 1);
  const cellSize = size / resolution;
  const missing = [];
  (value.holes ?? []).forEach((hole, index) => {
    const nearest = distanceToNearestCellCentre(hole, size, resolution);
    if (hole.radius > nearest) return;
    missing.push({ index, cellSize, smallestRadius: Math.floor(nearest * 1000 + 1) / 1000 });
  });
  return missing;
}
