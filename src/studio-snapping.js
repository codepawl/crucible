// Snapping in Studio is a state, as in Blender: a magnet toggle, a target (what to snap to) and Ctrl to flip it for one
// transform. This file holds the pure parts. The controller feeds it world-space numbers, so a node move, a key-driven
// move and an edit-mode element move all snap the same way.

export const SNAP_TARGETS = Object.freeze([
  Object.freeze({ id: 'increment', label: 'Increment', icon: 'grid' }),
  Object.freeze({ id: 'vertex', label: 'Vertex', icon: 'meshVertex' }),
  Object.freeze({ id: 'face', label: 'Face', icon: 'meshFace' }),
]);

export const SNAP_TARGET_IDS = Object.freeze(SNAP_TARGETS.map(target => target.id));

/** A scale drag lands on multiples of this factor of the size it started from. */
export const SCALE_SNAP_STEP = 0.1;

/** A vertex target catches the pointer inside this many pixels. */
export const VERTEX_SNAP_RADIUS_PIXELS = 12;

const SAME_SPOT_PIXELS = 2;

/** The most vertices one search projects in all, taken evenly from each searched part, so a heavy scene stays responsive. */
export const VERTEX_SNAP_MAX_VERTICES = 20000;

/** The most parts one search searches: the ones whose centre lies nearest the pointer on screen. */
export const VERTEX_SNAP_MAX_PARTS = 48;

/** The most parts one search ranks by distance to the pointer, picked evenly from the scene; the rest are not looked at. */
export const VERTEX_SNAP_MAX_RANKED_PARTS = 512;

/** Each ranked part has its centre guessed from this many of its vertices. */
const CENTRE_SAMPLE_VERTICES = 8;

/** The most vertices of the moved object, over all its parts, that are tried for the one that lands on the target. */
export const OWN_VERTEX_LIMIT = 512;

// Up to `wanted` indices from 0 to count - 1, spread evenly: all of them when there are no more than wanted.
function evenIndices(count, wanted) {
  if (count <= wanted) {
    return Array.from({ length: count }, (_, index) => index);
  }
  return Array.from({ length: wanted }, (_, step) => Math.floor((step * count) / wanted));
}

/** Snapping is on when the toggle says so, flipped while Ctrl is held. */
export function snapIsActive(enabled, ctrlHeld) {
  return Boolean(enabled) !== Boolean(ctrlHeld);
}

export function snapToStep(value, step) {
  return Math.round(value / step) * step;
}

export function snapDegrees(degrees, stepDegrees) {
  return snapToStep(degrees, stepDegrees);
}

/** A scale factor on the step, never below one step, so a snapped scale cannot collapse an object to nothing. */
export function snapScaleFactor(factor, step = SCALE_SNAP_STEP) {
  return Math.max(step, snapToStep(factor, step));
}

function transformedPoint(matrix, positions, vertex) {
  const x = positions[vertex * 3];
  const y = positions[vertex * 3 + 1];
  const z = positions[vertex * 3 + 2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function usableParts(parts) {
  return parts.filter(part => part.matrix && part.geometry?.positions?.length >= 3);
}

function partCentre(part) {
  const positions = part.geometry.positions;
  const sum = [0, 0, 0];
  const sampled = evenIndices(positions.length / 3, CENTRE_SAMPLE_VERTICES);
  for (const vertex of sampled) {
    const point = transformedPoint(part.matrix, positions, vertex);
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  return sum.map(component => component / sampled.length);
}

// The nearer to the pointer wins; two within a pixel or two of each other on screen go to the one nearer the camera,
// so a vertex in front is taken over one hidden behind it on the same line of sight. There is no occlusion test beyond that.
function isBetterCandidate(distance, depth, best) {
  if (Math.abs(distance - best.distance) <= SAME_SPOT_PIXELS) {
    return depth < best.depth;
  }
  return distance < best.distance;
}

/**
 * The world vertex of `parts` nearest the pointer on screen, within `radiusPixels`, or null. `project` maps a world point
 * to `{ x, y, depth }` pixels, or to null when it is behind the camera. At most `maxParts` parts are searched (those whose centre
 * lies nearest the pointer) and at most `maxVertices` vertices are projected, taken evenly from each part.
 */
export function findVertexUnderPointer({
  parts,
  project,
  pointer,
  radiusPixels = VERTEX_SNAP_RADIUS_PIXELS,
  maxVertices = VERTEX_SNAP_MAX_VERTICES,
  maxParts = VERTEX_SNAP_MAX_PARTS,
  maxRankedParts = VERTEX_SNAP_MAX_RANKED_PARTS,
}) {
  const usable = usableParts(parts);
  const ranked = evenIndices(usable.length, maxRankedParts)
    .map(index => usable[index])
    .map(part => {
      const screen = project(partCentre(part));
      return { part, distance: screen ? Math.hypot(screen.x - pointer.x, screen.y - pointer.y) : Infinity };
    })
    .filter(entry => Number.isFinite(entry.distance))
    .sort((first, second) => first.distance - second.distance)
    .slice(0, maxParts);
  const verticesPerPart = Math.max(1, Math.floor(maxVertices / Math.max(1, ranked.length)));
  let best = null;
  for (const { part } of ranked) {
    const positions = part.geometry.positions;
    for (const vertex of evenIndices(positions.length / 3, verticesPerPart)) {
      const world = transformedPoint(part.matrix, positions, vertex);
      const screen = project(world);
      if (!screen) {
        continue;
      }
      const distance = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
      const depth = screen.depth ?? 0;
      if (distance <= radiusPixels && (!best || isBetterCandidate(distance, depth, best))) {
        best = { point: world, distance, depth };
      }
    }
  }
  return best;
}

/** Up to `limit` world points of `parts`' vertices, taken evenly: the moved object's own candidates for the one that lands. */
export function sampleVertices(parts, limit = OWN_VERTEX_LIMIT) {
  const usable = usableParts(parts);
  const chosenParts = evenIndices(usable.length, limit).map(index => usable[index]);
  const verticesPerPart = Math.max(1, Math.floor(limit / Math.max(1, chosenParts.length)));
  const points = [];
  for (const part of chosenParts) {
    for (const vertex of evenIndices(part.geometry.positions.length / 3, verticesPerPart)) {
      points.push(transformedPoint(part.matrix, part.geometry.positions, vertex));
    }
  }
  return points;
}

/**
 * The move that puts the moved object's vertex nearest `target` onto it. `ownPoints` are the object's vertices where the
 * drag began and `offset` is the free move so far; the result is the whole move from the start, or null without vertices.
 */
export function moveToLandVertex(ownPoints, offset, target) {
  let bestPoint = null;
  let bestDistance = Infinity;
  for (const point of ownPoints) {
    const distance = Math.hypot(point[0] + offset[0] - target[0], point[1] + offset[1] - target[1], point[2] + offset[2] - target[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = point;
    }
  }
  return bestPoint ? [target[0] - bestPoint[0], target[1] - bestPoint[1], target[2] - bestPoint[2]] : null;
}
