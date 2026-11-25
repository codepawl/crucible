import { CLOSED_ROOM_MAXIMUM_TRIANGLES, CLOSED_ROOM_RAYS, CLOSED_ROOM_SHARE, fibonacciDirection, freeOrigin, hitsFrontFace, worldTriangles } from './closed-room.js';
import { localBounds } from './flush-search.js';
import { geometryNumber } from './flush-search-reuse.js';
import { isLiveGeometry } from './live-geometry.js';

// A closed-room test for rooms with a garden outside the window and heavy props inside. closedRoomShare (which the inspect
// diagnostic uses) shoots from the middle of the bounds, so a lawn beside the room moves the start out of it, and it gives up
// above CLOSED_ROOM_MAXIMUM_TRIANGLES. This one leaves out the heaviest parts and the parts far from the rest, then runs the
// same test; it lives in a module of its own so the core bundle does not carry it.

function triangleCountOf(part) {
  return part.geometry.indices.length / 3;
}

// The lightest parts that fit the triangle budget: walls and floors are a few triangles, a scanned prop is thousands.
function lightestParts(parts) {
  const kept = new Set();
  let total = 0;
  for (const part of [...parts].sort((first, second) => triangleCountOf(first) - triangleCountOf(second))) {
    total += triangleCountOf(part);
    if (total > CLOSED_ROOM_MAXIMUM_TRIANGLES) {
      break;
    }
    kept.add(part);
  }
  return parts.filter(part => kept.has(part));
}

// The middle of a part's local bounds, in world space.
function partCentre(part, matrix) {
  const local = localBounds(part.geometry);
  const middle = [0, 1, 2].map(axis => (local[axis] + local[3 + axis]) / 2);
  return [0, 1, 2].map(axis => matrix[axis] * middle[0] + matrix[4 + axis] * middle[1] + matrix[8 + axis] * middle[2] + matrix[12 + axis]);
}

// The parts whose centre lies within 1.5 times the widest spread of the middle 60 percent of the centres (20th to 80th
// percentile) from that spread, on every axis. A lawn or a hedge beside a room is farther out than that.
function partsNearTheRest(parts, worldMatrices) {
  const centres = parts.map(part => partCentre(part, worldMatrices.get(part) ?? worldMatrices.get(part.name)));
  const spreads = [0, 1, 2].map(axis => {
    const values = centres.map(centre => centre[axis]).sort((first, second) => first - second);
    return [values[Math.floor((values.length - 1) * 0.2)], values[Math.ceil((values.length - 1) * 0.8)]];
  });
  const margin = 1.5 * Math.max(...spreads.map(([low, high]) => high - low));
  return parts.filter((part, index) => spreads.every(([low, high], axis) => centres[index][axis] >= low - margin && centres[index][axis] <= high + margin));
}

const CLOSED_ROOM_WALL_RAYS = 36;
// A room has walls when this share of the level rays around the origin hit one; a canopy on columns hits a column now and then.
const CLOSED_ROOM_WALL_SHARE = 0.8;
// A set open on one side (three walls and a ceiling) has walls on three quarters of the ring: this lower share tells it from a canopy on columns (#3389).
export const OPEN_SIDED_ROOM_WALL_SHARE = 0.7;
// A ray only has to test a part whose box it crosses. Boxes grow by this share of the scene's extent plus its largest coordinate, so
// rounding in the triangle test never lets a hit land outside the box, and a flat wall quad (a box with no thickness) still has a volume.
const BOX_PADDING_SHARE = 1e-4;
// Parts with fewer triangles than this are cheaper to test directly than to box-test first.
const MINIMUM_TRIANGLES_FOR_BOX_TEST = 8;

function isOpaque(part) {
  return !['blend', 'add'].includes(part.material?.alphaMode);
}

// An edit changes a part or two and the room test runs again on all of them, so the world corners of a part are kept under its geometry and
// the exact bits of its matrix: the same geometry at the same matrix has the same corners. The memory is bounded by a triangle count and
// drops the part that was used longest ago. A live geometry (rewritten in place) is never kept.
const KEPT_CORNER_TRIANGLES = 300_000;
const keptCorners = new Map();
let keptTriangles = 0;

function matrixBitsKey(matrix) {
  if (!(matrix instanceof Float32Array)) return null;
  return Array.prototype.join.call(new Uint32Array(matrix.buffer, matrix.byteOffset, matrix.length), ',');
}

// The corners and bounds of one part, from worldTriangles itself so a kept part is the same bits as a fresh one.
function keptPartCorners(part, matrix) {
  const matrixKey = matrixBitsKey(matrix);
  if (matrixKey === null || isLiveGeometry(part.geometry)) return worldTriangles([part], new Map([[part, matrix]]));
  const key = `${geometryNumber(part.geometry)}|${matrixKey}`;
  const kept = keptCorners.get(key);
  if (kept) {
    keptCorners.delete(key);
    keptCorners.set(key, kept);
    return kept;
  }
  const computed = worldTriangles([part], new Map([[part, matrix]]));
  keptCorners.set(key, computed);
  keptTriangles += computed.triangleCount;
  while (keptTriangles > KEPT_CORNER_TRIANGLES && keptCorners.size > 1) {
    const [oldestKey, oldest] = keptCorners.entries().next().value;
    keptCorners.delete(oldestKey);
    keptTriangles -= oldest.triangleCount;
  }
  return computed;
}

// worldTriangles over the parts, put together from the kept corners of each. Null in the same cases: no triangles, or over the budget.
function keptWorldTriangles(parts, worldMatrices) {
  const triangleCount = parts.reduce((sum, part) => sum + part.geometry.indices.length / 3, 0);
  if (triangleCount === 0 || triangleCount > CLOSED_ROOM_MAXIMUM_TRIANGLES) return null;
  const corners = new Float64Array(triangleCount * 9);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const partBounds = [];
  let write = 0;
  for (const part of parts) {
    const matrix = worldMatrices.get(part) ?? worldMatrices.get(part.name);
    if (matrix === undefined) throw new Error(`No world matrix for part "${part.name}"; pass partMatrixLookup(parts) as worldMatrices.`);
    const kept = part.geometry.indices.length === 0 ? { corners: new Float64Array(0), minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity], triangleCount: 0 } : keptPartCorners(part, matrix);
    corners.set(kept.corners, write);
    write += kept.corners.length;
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], kept.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], kept.maximum[axis]);
    }
    partBounds.push({ minimum: kept.minimum, maximum: kept.maximum });
  }
  return { corners, triangleCount, partBounds, minimum, maximum };
}

/**
 * World triangles of the parts, built once: `entries` holds each part's triangle range and padded box, so a subset of the parts reuses
 * the same corner array. Null when worldTriangles gives none (no triangles, or over the triangle budget).
 */
function prepareScene(parts, worldMatrices) {
  const world = keptWorldTriangles(parts, worldMatrices);
  if (!world) {
    return null;
  }
  let largestCoordinate = 0;
  let largestExtent = 0;
  for (let axis = 0; axis < 3; axis++) {
    largestCoordinate = Math.max(largestCoordinate, Math.abs(world.minimum[axis]), Math.abs(world.maximum[axis]));
    largestExtent = Math.max(largestExtent, world.maximum[axis] - world.minimum[axis]);
  }
  const padding = BOX_PADDING_SHARE * (largestExtent + largestCoordinate);
  const entries = [];
  let firstTriangle = 0;
  parts.forEach((part, index) => {
    const triangleCount = part.geometry.indices.length / 3;
    const bounds = world.partBounds[index];
    entries.push({
      part,
      firstTriangle,
      triangleCount,
      bounds,
      boxMinimum: bounds.minimum.map(value => value - padding),
      boxMaximum: bounds.maximum.map(value => value + padding),
    });
    firstTriangle += triangleCount;
  });
  return { corners: world.corners, entries };
}

// The scene as closedRoomShare would see it with only these entries: the same bounds, from the per-part bounds (min and max do not depend on order).
function viewOf(corners, entries) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;
  for (const entry of entries) {
    triangleCount += entry.triangleCount;
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], entry.bounds.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], entry.bounds.maximum[axis]);
    }
  }
  const partBounds = entries.map(entry => entry.bounds);
  return { corners, entries, triangleCount, minimum, maximum, partBounds };
}

// Whether the half line from `origin` along `direction` crosses the box. An axis the ray does not move on needs the origin inside the slab; a NaN never rejects.
function rayCrossesBox(origin, direction, boxMinimum, boxMaximum) {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const step = direction[axis];
    if (step === 0) {
      if (origin[axis] < boxMinimum[axis] || origin[axis] > boxMaximum[axis]) {
        return false;
      }
      continue;
    }
    const entry = (boxMinimum[axis] - origin[axis]) / step;
    const exit = (boxMaximum[axis] - origin[axis]) / step;
    near = Math.max(near, Math.min(entry, exit));
    far = Math.min(far, Math.max(entry, exit));
  }
  return !(near > far);
}

function rayHitsFrontFace(view, origin, direction) {
  for (const entry of view.entries) {
    if (entry.triangleCount >= MINIMUM_TRIANGLES_FOR_BOX_TEST && !rayCrossesBox(origin, direction, entry.boxMinimum, entry.boxMaximum)) {
      continue;
    }
    const end = entry.firstTriangle + entry.triangleCount;
    for (let triangle = entry.firstTriangle; triangle < end; triangle++) {
      if (hitsFrontFace(view.corners, triangle * 9, origin, direction)) {
        return true;
      }
    }
  }
  return false;
}

// closedRoomShare on a prepared view, with the same origin and rays, so the same share.
function roomShareOf(view) {
  if (view.triangleCount === 0) {
    return null;
  }
  const origin = freeOrigin(view);
  if (!origin) {
    return null;
  }
  const direction = [0, 0, 0];
  let hits = 0;
  for (let ray = 0; ray < CLOSED_ROOM_RAYS; ray++) {
    fibonacciDirection(ray, CLOSED_ROOM_RAYS, direction);
    if (rayHitsFrontFace(view, origin, direction)) {
      hits++;
    }
  }
  return hits / CLOSED_ROOM_RAYS;
}

/**
 * Whether at least CLOSED_ROOM_WALL_SHARE of the level rays (a ring around the up axis at the origin's height) hit a part's inner face. A roof
 * over a floor on a few columns has a high closed-room share, because the rays up and down hit the roof and the floor, but few level rays hit
 * anything, so this tells a room with walls from a canopy or a colonnade. False when the view has no triangles or no free origin. Stops as soon
 * as the share cannot reach the threshold any more.
 */
function viewHasWalls(view, minimumShare) {
  if (view.triangleCount === 0) {
    return false;
  }
  const origin = freeOrigin(view);
  if (!origin) {
    return false;
  }
  const direction = [0, 0, 0];
  let hits = 0;
  for (let ray = 0; ray < CLOSED_ROOM_WALL_RAYS; ray++) {
    if ((hits + CLOSED_ROOM_WALL_RAYS - ray) / CLOSED_ROOM_WALL_RAYS < minimumShare) {
      return false;
    }
    const angle = ((ray + 0.5) / CLOSED_ROOM_WALL_RAYS) * Math.PI * 2;
    direction[0] = Math.cos(angle);
    direction[1] = 0;
    direction[2] = Math.sin(angle);
    if (rayHitsFrontFace(view, origin, direction)) {
      hits++;
    }
  }
  return hits / CLOSED_ROOM_WALL_RAYS >= minimumShare;
}

// The views of all the kept parts and of the ones near the rest; the second is the first itself when no part is left out.
function keptAndNearViews(parts, worldMatrices) {
  const kept = lightestParts(parts.filter(isOpaque));
  const scene = prepareScene(kept, worldMatrices);
  if (!scene) {
    return null;
  }
  const keptView = viewOf(scene.corners, scene.entries);
  const near = new Set(partsNearTheRest(kept, worldMatrices));
  const nearView = near.size === new Set(kept).size ? keptView : viewOf(scene.corners, scene.entries.filter(entry => near.has(entry.part)));
  return { keptView, nearView };
}

/**
 * The share of rays from the middle of the bounds that hit a part's inner face (closedRoomShare), or, when that is not a room,
 * the same test on the parts near the rest, if that is larger. The heaviest parts are left out when the scene has more than
 * CLOSED_ROOM_MAXIMUM_TRIANGLES triangles. Null when nothing is left to test. `worldMatrices` maps each part (or its name) to its world matrix.
 */
export function fittedClosedRoomShare(parts, worldMatrices) {
  const views = keptAndNearViews(parts, worldMatrices);
  if (!views) {
    return null;
  }
  const share = roomShareOf(views.keptView);
  if (share === null || share >= CLOSED_ROOM_SHARE) {
    return share;
  }
  if (views.nearView === views.keptView) {
    return share;
  }
  return Math.max(share, roomShareOf(views.nearView) ?? 0);
}

/**
 * Whether the scene has walls all round (at least CLOSED_ROOM_WALL_SHARE of the level rays hit one), tested on the same parts as fittedClosedRoomShare:
 * all of them, or the ones near the rest when a lawn beside the room moves the origin out of it. False when nothing can be tested.
 */
export function fittedRoomHasWalls(parts, worldMatrices, minimumShare = CLOSED_ROOM_WALL_SHARE) {
  const views = keptAndNearViews(parts, worldMatrices);
  if (!views) {
    return false;
  }
  return viewHasWalls(views.keptView, minimumShare) || (views.nearView !== views.keptView && viewHasWalls(views.nearView, minimumShare));
}
