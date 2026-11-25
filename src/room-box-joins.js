// Boxes that touch leave an open groove along their join when their edges are rounded (#2298): the sun, the sky and the room's own
// bake shine through it, so a closed room built from default boxes glows along every edge. A room has at least four joins (four
// walls) and a thin slab on every side; boxes that only stand on a floor or a counter keep their rounded edges.

export const MINIMUM_TOUCHING_BOX_PAIRS = 4;
// Pairs are compared one by one, so a scene with more rounded boxes than this keeps their rounded edges.
export const MAXIMUM_JOINED_BOX_NODES = 1500;
const TOUCH_TOLERANCE = 1e-3;
const IDENTITY_ROTATION = [0, 0, 0, 1];
const ORIGIN = [0, 0, 0];
const UNIT_SCALE = [1, 1, 1];

function isRotated(rotation) {
  return Boolean(rotation) && rotation.some((value, index) => Math.abs(value - IDENTITY_ROTATION[index]) > 1e-6);
}

function roundedBoxGeometryIds(recipe) {
  const ids = new Set();
  for (const geometry of recipe.geometries ?? []) {
    if (geometry.type === 'box' && (geometry.bevel ?? 0.08) > 0) ids.add(geometry.id);
  }
  return ids;
}

// Bounds of a plain box node (translation and scale only); a rotated or parented node has no box bounds, so it is left out.
function plainBoxBounds(node) {
  if (isRotated(node.rotation) || node.parent) return null;
  const translation = node.translation ?? ORIGIN;
  const scale = node.scale ?? UNIT_SCALE;
  const half = scale.map(extent => Math.abs(extent) / 2);
  return {
    minimum: translation.map((value, axis) => value - half[axis]),
    maximum: translation.map((value, axis) => value + half[axis]),
  };
}

// Two boxes touch when they overlap or meet on every axis.
function boxesTouch(first, second) {
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(first.minimum[axis] - second.maximum[axis], second.minimum[axis] - first.maximum[axis]);
    if (gap > TOUCH_TOLERANCE) return false;
  }
  return true;
}
// A slab is thin along an axis when it is at most this share of the joined boxes' extent there; a wall is, a tree or a table top is not.
const THIN_SHARE = 0.25;

function joinedExtent(boxes) {
  return {
    minimum: [0, 1, 2].map(axis => Math.min(...boxes.map(box => box.bounds.minimum[axis]))),
    maximum: [0, 1, 2].map(axis => Math.max(...boxes.map(box => box.bounds.maximum[axis]))),
  };
}

// A room has a thin slab on its sides, at the outside of the joined boxes (no further in than its own thickness, so a ceiling that overhangs its walls still counts) and spanning most of
// that face: six for a closed room, five for a set open on one side (a stage or a TV-style set, #3433). A floor with trees on it has no walls, and a counter with a few boxes on it has no
// ceiling, so neither is treated as a room; a table (a top and four legs), a pergola (a floor and four posts) and a bookcase (two sides, a top, a bottom and a back) are not either:
// their legs and posts span no face, and a set open on one side is a room only when a person fits in it on every axis.
export const MINIMUM_ENCLOSED_SIDES = 5;
const CLOSED_ROOM_SIDES = 6;
// A slab spans a face when it covers at least this share of the joined boxes' extent on both other axes.
const SPAN_SHARE = 0.6;
// The smallest extent, on every axis, of a set open on one side that is drawn sharp (metres).
export const MINIMUM_OPEN_SET_SPAN = 1.5;

const thicknessOf = (box, axis) => box.bounds.maximum[axis] - box.bounds.minimum[axis];

function spansFace(box, axis, extent) {
  return [0, 1, 2].every(other => other === axis || thicknessOf(box, other) >= SPAN_SHARE * (extent.maximum[other] - extent.minimum[other]));
}

function countEnclosedSides(boxes, extent) {
  let enclosedSides = 0;
  for (let axis = 0; axis < 3; axis++) {
    const thickLimit = THIN_SHARE * (extent.maximum[axis] - extent.minimum[axis]);
    const thinAlongAxis = boxes.filter(box => thicknessOf(box, axis) <= thickLimit && spansFace(box, axis, extent));
    if (thinAlongAxis.some(box => box.bounds.minimum[axis] - extent.minimum[axis] <= thicknessOf(box, axis) + TOUCH_TOLERANCE)) enclosedSides++;
    if (thinAlongAxis.some(box => extent.maximum[axis] - box.bounds.maximum[axis] <= thicknessOf(box, axis) + TOUCH_TOLERANCE)) enclosedSides++;
  }
  return enclosedSides;
}

/**
 * The IDs of nodes with rounded box geometry that touch another such node, when at least four pairs touch and the joined boxes
 * close a room on at least five of its six sides; otherwise an empty set. The engine draws these nodes with sharp edges so the joins stay closed.
 */
export function roomJoinedBoxNodeIds(recipe) {
  const roundedIds = roundedBoxGeometryIds(recipe);
  const boxes = (recipe.nodes ?? [])
    .filter(node => roundedIds.has(node.geometry))
    .map(node => ({ id: node.id, bounds: plainBoxBounds(node) }))
    .filter(box => box.bounds);
  if (boxes.length > MAXIMUM_JOINED_BOX_NODES) return new Set();
  const joined = new Set();
  let touchingPairs = 0;
  for (let first = 0; first < boxes.length; first++) {
    for (let second = first + 1; second < boxes.length; second++) {
      if (!boxesTouch(boxes[first].bounds, boxes[second].bounds)) continue;
      touchingPairs++;
      joined.add(boxes[first].id);
      joined.add(boxes[second].id);
    }
  }
  if (touchingPairs < MINIMUM_TOUCHING_BOX_PAIRS) return new Set();
  const joinedBoxes = boxes.filter(box => joined.has(box.id));
  const extent = joinedExtent(joinedBoxes);
  const enclosedSides = countEnclosedSides(joinedBoxes, extent);
  if (enclosedSides >= CLOSED_ROOM_SIDES) return joined;
  const fitsAPerson = [0, 1, 2].every(axis => extent.maximum[axis] - extent.minimum[axis] >= MINIMUM_OPEN_SET_SPAN);
  return enclosedSides >= MINIMUM_ENCLOSED_SIDES && fitsAPerson ? joined : new Set();
}
