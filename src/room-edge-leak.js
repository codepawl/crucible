// Walls built from beveled boxes leave open grooves at their joins (#2291): the default box rounds its edges by 0.08, so two boxes that
// meet at a corner leave a channel along it. The channel is real geometry, so the sun, the sky and the room's own bake all shine
// through it and a closed room glows at its corners and along its edges, with or without lamps.
import { diagnostic } from './agent-diagnostics.js';
import { roomJoinedBoxNodeIds } from './room-box-joins.js';

const DEFAULT_BOX_BEVEL = 0.08;
const TOUCH_TOLERANCE = 1e-3;
// A room has at least four joins (four walls); fewer touching pairs are props standing on a floor.
const MINIMUM_TOUCHING_PAIRS = 4;
const NAMED_NODES = 4;

function beveledBoxIds(recipe) {
  const ids = new Set();
  for (const geometry of recipe.geometries ?? []) {
    if (geometry.type === 'box' && (geometry.bevel ?? DEFAULT_BOX_BEVEL) > 0) ids.add(geometry.id);
  }
  return ids;
}

const IDENTITY_ROTATION = [0, 0, 0, 1];

function isRotated(rotation) {
  return Boolean(rotation) && rotation.some((value, index) => Math.abs(value - IDENTITY_ROTATION[index]) > 1e-6);
}

// Bounds of a plain box node (translation and scale only); a rotated or parented node is left out because its bounds are not a box.
function plainBoxBounds(node) {
  if (isRotated(node.rotation) || node.parent || !node.scale || !node.translation) return null;
  const half = [0, 1, 2].map(axis => Math.abs(node.scale[axis]) / 2);
  return {
    minimum: [0, 1, 2].map(axis => node.translation[axis] - half[axis]),
    maximum: [0, 1, 2].map(axis => node.translation[axis] + half[axis]),
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

/** The IDs of beveled box nodes that touch another beveled box and are still drawn rounded (a room's joined boxes are drawn sharp, #2298 and #3433), or an empty list when fewer than four pairs touch. */
export function beveledJoinNodes(recipe) {
  const ids = beveledBoxIds(recipe);
  const boxes = (recipe.nodes ?? [])
    .filter(node => ids.has(node.geometry))
    .map(node => ({ id: node.id, bounds: plainBoxBounds(node) }))
    .filter(box => box.bounds);
  const joined = new Set();
  let pairs = 0;
  for (let first = 0; first < boxes.length; first++) {
    for (let second = first + 1; second < boxes.length; second++) {
      if (!boxesTouch(boxes[first].bounds, boxes[second].bounds)) continue;
      pairs++;
      joined.add(boxes[first].id);
      joined.add(boxes[second].id);
    }
  }
  if (pairs < MINIMUM_TOUCHING_PAIRS) return [];
  const drawnSharp = roomJoinedBoxNodeIds(recipe);
  return [...joined].filter(id => !drawnSharp.has(id));
}

/** A diagnostic for a closed room whose walls are beveled boxes that meet, or null. The caller has already found the scene to be a closed room. */
export function roomEdgeLeakDiagnostic(recipe) {
  const nodes = beveledJoinNodes(recipe);
  if (nodes.length === 0) return null;
  const named = nodes.slice(0, NAMED_NODES).join(', ');
  return diagnostic('room-edge-leak', 'warning', nodes[0],
    `${nodes.length} beveled box nodes meet at their edges (${named}${nodes.length > NAMED_NODES ? ', ...' : ''}). The default box bevel rounds each edge by ${DEFAULT_BOX_BEVEL}, so every join leaves a groove that opens to the outside: light shines in at the corners and edges of this closed room, lamps or not.`,
    'Give the wall geometry "bevel": 0 (scene_apply add-geometry or set-geometry) so the walls meet flat, or build the room as one mesh.');
}
