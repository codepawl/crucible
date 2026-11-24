// Geometries whose position arrays are rewritten in place (cloth samples). Anything that caches a measurement of a
// geometry's positions must skip these, because the array identity stays the same while its values change.
const liveGeometries = new WeakSet();
const reindexedGeometries = new WeakSet();

/** `reindexed` marks a geometry whose triangle indices are rewritten too (a sea: the diagonal of each quad follows the waves). */
export function markLiveGeometry(geometry, { reindexed = false } = {}) {
  liveGeometries.add(geometry);
  if (reindexed) reindexedGeometries.add(geometry);
  return geometry;
}

/** Takes the mark back off a geometry whose values are final again (a cancelled preview wrote the original values back). */
export function unmarkLiveGeometry(geometry) {
  liveGeometries.delete(geometry);
  reindexedGeometries.delete(geometry);
}

export function isLiveGeometry(geometry) {
  return liveGeometries.has(geometry);
}

export function isReindexedGeometry(geometry) {
  return reindexedGeometries.has(geometry);
}
