// A thickness for transmissive glTF meshes that carry no KHR_materials_volume. The extension's default thickness is 0, a thin-walled
// surface that does not bend light; but a closed glass shell (a bottle, a lens, a ball) has an inside, and a curved cap that stands for
// a lens (a cornea) has a bulge, so the loader derives a thickness from the mesh. An explicit thickness, 0 included, always wins, and a
// flat or near-flat open sheet (a pane, a window card) stays thin-walled.

/** An open mesh counts as a bulging cap, not a flat sheet, when its smallest extent is at least this share of its largest. */
export const MINIMUM_CAP_BULGE = 0.1;
/** The glass behind an open cap reaches about one cap radius (half its largest extent) before the next surface: a cornea over its chamber. */
export const OPEN_CAP_DEPTH_PER_EXTENT = 0.5;
/** The closed-surface test welds every triangle edge; above this many triangles the mesh is treated as open and stays as authored. */
export const MAXIMUM_CLOSED_TEST_TRIANGLES = 200000;

const WELD_PRECISION = 1e4;

/** True when every edge of the triangle list is shared by exactly two triangles, after welding vertices that share a position. */
export function isClosedSurface(positions, indices) {
  const triangleCount = indices.length / 3;
  if (triangleCount === 0 || triangleCount > MAXIMUM_CLOSED_TEST_TRIANGLES) return false;
  const weldedIds = new Map();
  const weld = vertexIndex => {
    const key = `${Math.round(positions[vertexIndex * 3] * WELD_PRECISION)},${Math.round(positions[vertexIndex * 3 + 1] * WELD_PRECISION)},${Math.round(positions[vertexIndex * 3 + 2] * WELD_PRECISION)}`;
    if (!weldedIds.has(key)) weldedIds.set(key, weldedIds.size);
    return weldedIds.get(key);
  };
  const edgeUses = new Map();
  for (let corner = 0; corner < indices.length; corner += 3) {
    const ids = [weld(indices[corner]), weld(indices[corner + 1]), weld(indices[corner + 2])];
    for (let edge = 0; edge < 3; edge++) {
      const from = ids[edge];
      const to = ids[(edge + 1) % 3];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  for (const uses of edgeUses.values()) if (uses !== 2) return false;
  return true;
}

/** The extents of the positions along each axis of the mesh, in the mesh's own units. */
export function meshExtents(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
    }
  }
  return [0, 1, 2].map(axis => maximum[axis] - minimum[axis]);
}

/**
 * The thickness to give a transmissive mesh with no KHR_materials_volume, in the mesh's own units like thicknessFactor (the renderer
 * scales it by the placement), or 0 when it stays thin-walled.
 * A closed surface takes its smallest extent (a ball: its diameter; a pane box: its depth). An open surface that bulges takes a share of its
 * largest extent, because the glass continues behind it; an open sheet that does not bulge stays thin-walled.
 */
export function derivedGlassThickness(positions, indices) {
  const extents = meshExtents(positions);
  const smallest = Math.min(...extents);
  const largest = Math.max(...extents);
  if (!(smallest > 0) || !Number.isFinite(largest)) return 0;
  if (isClosedSurface(positions, indices)) return smallest;
  return smallest / largest >= MINIMUM_CAP_BULGE ? largest * OPEN_CAP_DEPTH_PER_EXTENT : 0;
}

/**
 * The material a mesh draws with: the shared one, or a copy that carries the derived thickness when the file gave the material none.
 * `cache` keeps one copy per material and thickness, so meshes of one size still batch together.
 */
export function materialWithDerivedThickness(material, definition, geometry, cache) {
  const hasVolume = definition?.extensions?.KHR_materials_volume !== undefined;
  if (!(material.transmission > 0) || hasVolume || !geometry.indices) return material;
  const thickness = derivedGlassThickness(geometry.positions, geometry.indices);
  if (thickness === 0) return material;
  // An open cap has no back face: the glass continues behind it until the next surface, so the ray bends once and is not bent back out.
  const mediumContinues = !isClosedSurface(geometry.positions, geometry.indices);
  const key = `${Math.round(thickness * 1e6)}:${mediumContinues}`;
  if (!cache.has(material)) cache.set(material, new Map());
  const copies = cache.get(material);
  if (!copies.has(key)) copies.set(key, { ...material, thickness, mediumContinues });
  return copies.get(key);
}
