// Recipe floorPlan: walls with cut openings, a floor and a ceiling over every closed room, and door and window presets
// in the openings, built as one mesh from a flat plan. It loads on demand with the recipes that contain a floorPlan
// geometry, so the scene entry does not carry it. The plan maths is in floor-plan-layout.js.
//
// Plan points are [x, z] in metres and the floor is y = 0. `part` picks one piece (walls, floor, ceiling, doors, windows
// or glass) so each can take its own material from several geometries that share the same plan.

import { invalidField } from './field-error.js';
import { createMeshBuilder, triangulatePolygon } from './floor-plan-mesh.js';
import { FLOOR_PLAN_LIMITS, layoutWalls, placeOpenings, resolveFloorPlan, splitIntoPieces, traceRooms } from './floor-plan-layout.js';

export { FLOOR_PLAN_LIMITS };

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const FRAME_WIDTH = 0.06;
const FRAME_RECESS = 0.02;
const DOOR_LEAF_THICKNESS = 0.04;
const DOOR_LEAF_LIFT = 0.01;
const GLASS_THICKNESS = 0.01;
const VERTICES_PER_PIECE = 100;
const VERTICES_PER_OPENING = 300;
const SAME_POINT = 1e-9;

/** An upper bound on the vertices of a floorPlan record, after checking the whole record. */
export function floorPlanVertexEstimate(value) {
  const plan = resolveFloorPlan(value);
  return splitIntoPieces(plan.walls).length * VERTICES_PER_PIECE + plan.openings.length * VERTICES_PER_OPENING;
}

// The frame of one wall piece: `at` turns a distance along the piece, a distance to its left and a height into a 3D point.
function pieceFrame(piece) {
  const [originX, originZ] = piece.origin;
  const [directionX, directionZ] = piece.direction;
  const [normalX, normalZ] = piece.normal;
  return {
    at: (along, sideways, height) => [originX + directionX * along + normalX * sideways, height, originZ + directionZ * along + normalZ * sideways],
    along: point => (point[0] - originX) * directionX + (point[2] - originZ) * directionZ,
    forward: [directionX, 0, directionZ],
    left: [normalX, 0, normalZ],
    halfThickness: piece.thickness / 2,
  };
}

function negate(vector) {
  return vector.map(component => -component);
}

function addBox(builder, frame, [alongLow, alongHigh], [sideLow, sideHigh], [heightLow, heightHigh]) {
  const at = frame.at;
  const faces = [
    [[alongLow, sideLow, heightLow], [alongLow, sideHigh, heightLow], [alongLow, sideHigh, heightHigh], [alongLow, sideLow, heightHigh], negate(frame.forward)],
    [[alongHigh, sideLow, heightLow], [alongHigh, sideHigh, heightLow], [alongHigh, sideHigh, heightHigh], [alongHigh, sideLow, heightHigh], frame.forward],
    [[alongLow, sideLow, heightLow], [alongHigh, sideLow, heightLow], [alongHigh, sideLow, heightHigh], [alongLow, sideLow, heightHigh], negate(frame.left)],
    [[alongLow, sideHigh, heightLow], [alongHigh, sideHigh, heightLow], [alongHigh, sideHigh, heightHigh], [alongLow, sideHigh, heightHigh], frame.left],
    [[alongLow, sideLow, heightLow], [alongHigh, sideLow, heightLow], [alongHigh, sideHigh, heightLow], [alongLow, sideHigh, heightLow], DOWN],
    [[alongLow, sideLow, heightHigh], [alongHigh, sideLow, heightHigh], [alongHigh, sideHigh, heightHigh], [alongLow, sideHigh, heightHigh], UP],
  ];
  for (const [first, second, third, fourth, outward] of faces) {
    builder.addQuad(at(...first), at(...second), at(...third), at(...fourth), outward);
  }
}

function openingsOf(placed, piece) {
  return placed.filter(opening => opening.piece === piece).sort((first, second) => first.start - second.start);
}

// One face of a wall: columns between the openings, and the wall under and over each opening. Every column is a strip whose
// edges carry the sill and lintel heights of the openings beside it, so no vertex lies along another face's edge.
function addSideFace(builder, frame, side, sideways, height, openings, outward) {
  const edge = (along, breaks) => [0, ...breaks, height].map(level => frame.at(along, sideways, level));
  const breaksOf = opening => (opening ? [opening.sill, opening.sill + opening.height].filter(level => level > 0) : []);
  const addColumn = (from, to, leftOpening, rightOpening) => {
    if (to - from > SAME_POINT) builder.addStrip(edge(from, breaksOf(leftOpening)), edge(to, breaksOf(rightOpening)), point => point[1], outward);
  };
  let cursor = side.start;
  let previous = null;
  for (const opening of openings) {
    addColumn(cursor, opening.start, previous, opening);
    if (opening.sill > 0) builder.addQuad(frame.at(opening.start, sideways, 0), frame.at(opening.end, sideways, 0), frame.at(opening.end, sideways, opening.sill), frame.at(opening.start, sideways, opening.sill), outward);
    const top = opening.sill + opening.height;
    builder.addQuad(frame.at(opening.start, sideways, top), frame.at(opening.end, sideways, top), frame.at(opening.end, sideways, height), frame.at(opening.start, sideways, height), outward);
    cursor = opening.end;
    previous = opening;
  }
  addColumn(cursor, side.end, previous, null);
}

function addReveals(builder, frame, opening) {
  const half = frame.halfThickness;
  const top = opening.sill + opening.height;
  const jamb = (along, outward) => builder.addQuad(frame.at(along, -half, opening.sill), frame.at(along, half, opening.sill), frame.at(along, half, top), frame.at(along, -half, top), outward);
  jamb(opening.start, frame.forward);
  jamb(opening.end, negate(frame.forward));
  builder.addQuad(frame.at(opening.start, -half, top), frame.at(opening.end, -half, top), frame.at(opening.end, half, top), frame.at(opening.start, half, top), DOWN);
  if (opening.sill > 0) {
    builder.addQuad(frame.at(opening.start, -half, opening.sill), frame.at(opening.end, -half, opening.sill), frame.at(opening.end, half, opening.sill), frame.at(opening.start, half, opening.sill), UP);
  }
}

// The top of a wall piece: a strip along its two sides, cut at the edges of every opening so it meets the faces below it.
function addWallTop(builder, frame, piece, height, openings) {
  const cuts = openings.flatMap(opening => [opening.start, opening.end]);
  const polyline = (side, sideways) => [side.start, ...cuts, side.end].map(along => frame.at(along, sideways, height));
  builder.addStrip(polyline(piece.right, -frame.halfThickness), polyline(piece.left, frame.halfThickness), frame.along, UP);
}

function addWall(builder, piece, height, placed) {
  const frame = pieceFrame(piece);
  const openings = openingsOf(placed, piece);
  addWallTop(builder, frame, piece, height, openings);
  addSideFace(builder, frame, piece.left, frame.halfThickness, height, openings, frame.left);
  addSideFace(builder, frame, piece.right, -frame.halfThickness, height, openings, negate(frame.left));
  openings.forEach(opening => addReveals(builder, frame, opening));
}

function distinctRing(points) {
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 1e-6;
  });
}

function liftedPoint(point, height) {
  return [point[0], height, point[1]];
}

// Where walls meet: a cap over the middle of a joint of three or more walls, and a vertical step where thicker and thinner
// walls leave a face uncovered.
function addJoint(builder, node, height) {
  const { ends } = node;
  const ring = distinctRing(ends.flatMap(end => [end.right, end.left]));
  if (ring.length >= 3) {
    for (const [first, second, third] of triangulatePolygon(ring)) {
      builder.addTriangle(liftedPoint(ring[first], height), liftedPoint(ring[second], height), liftedPoint(ring[third], height), UP);
    }
  }
  ends.forEach((end, index) => {
    const next = ends[(index + 1) % ends.length];
    if (Math.hypot(end.left[0] - next.right[0], end.left[1] - next.right[1]) <= 1e-6) return;
    const gap = ends.length === 1 ? Math.PI * 2 : ((next.angle - end.angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const middle = end.angle + gap / 2;
    builder.addQuad(liftedPoint(end.left, 0), liftedPoint(next.right, 0), liftedPoint(next.right, height), liftedPoint(end.left, height), [Math.cos(middle), 0, Math.sin(middle)]);
  });
}

function addRoomSurface(builder, room, height, outward) {
  for (const [first, second, third] of triangulatePolygon(room)) {
    builder.addTriangle(liftedPoint(room[first], height), liftedPoint(room[second], height), liftedPoint(room[third], height), outward);
  }
}

// Floor under a doorway, so the floor carries on across the thickness of the wall between two rooms.
function addThreshold(builder, opening) {
  const frame = pieceFrame(opening.piece);
  const half = frame.halfThickness;
  builder.addQuad(frame.at(opening.start, -half, 0), frame.at(opening.end, -half, 0), frame.at(opening.end, half, 0), frame.at(opening.start, half, 0), UP);
}

function addDoor(builder, opening) {
  const frame = pieceFrame(opening.piece);
  const depth = Math.max(opening.piece.thickness - 2 * FRAME_RECESS, opening.piece.thickness / 2) / 2;
  const post = Math.min(FRAME_WIDTH, opening.width / 4, opening.height / 4);
  const top = opening.sill + opening.height;
  const sideways = [-depth, depth];
  addBox(builder, frame, [opening.start, opening.start + post], sideways, [opening.sill, top]);
  addBox(builder, frame, [opening.end - post, opening.end], sideways, [opening.sill, top]);
  addBox(builder, frame, [opening.start + post, opening.end - post], sideways, [top - post, top]);
  addBox(builder, frame, [opening.start + post, opening.end - post], [-DOOR_LEAF_THICKNESS / 2, DOOR_LEAF_THICKNESS / 2], [opening.sill + DOOR_LEAF_LIFT, top - post]);
}

function addWindowFrame(builder, opening) {
  const frame = pieceFrame(opening.piece);
  const depth = Math.max(opening.piece.thickness - 2 * FRAME_RECESS, opening.piece.thickness / 2) / 2;
  const post = Math.min(FRAME_WIDTH, opening.width / 4, opening.height / 4);
  const top = opening.sill + opening.height;
  const sideways = [-depth, depth];
  addBox(builder, frame, [opening.start, opening.start + post], sideways, [opening.sill, top]);
  addBox(builder, frame, [opening.end - post, opening.end], sideways, [opening.sill, top]);
  addBox(builder, frame, [opening.start + post, opening.end - post], sideways, [opening.sill, opening.sill + post]);
  addBox(builder, frame, [opening.start + post, opening.end - post], sideways, [top - post, top]);
}

function addGlass(builder, opening) {
  const frame = pieceFrame(opening.piece);
  const post = Math.min(FRAME_WIDTH, opening.width / 4, opening.height / 4);
  const top = opening.sill + opening.height;
  addBox(builder, frame, [opening.start + post, opening.end - post], [-GLASS_THICKNESS / 2, GLASS_THICKNESS / 2], [opening.sill + post, top - post]);
}

/** The mesh of a recipe floorPlan record, as { positions, normals, uvs, indices }. */
export function generateFloorPlanGeometry(value, maxVertices) {
  const plan = resolveFloorPlan(value);
  const layout = layoutWalls(plan.walls);
  const placed = placeOpenings(plan.openings, layout);
  const builder = createMeshBuilder();
  const wants = part => plan.part === 'all' || plan.part === part;
  if (wants('walls')) {
    layout.pieces.forEach(piece => addWall(builder, piece, plan.height, placed));
    layout.nodes.forEach(node => addJoint(builder, node, plan.height));
  }
  const rooms = wants('floor') || wants('ceiling') ? traceRooms(layout) : [];
  if (wants('floor')) {
    rooms.forEach(room => addRoomSurface(builder, room, 0, UP));
    placed.filter(opening => opening.sill === 0).forEach(opening => addThreshold(builder, opening));
  }
  if (wants('ceiling')) rooms.forEach(room => addRoomSurface(builder, room, plan.height, DOWN));
  if (wants('doors')) placed.filter(opening => opening.kind === 'door').forEach(opening => addDoor(builder, opening));
  if (wants('windows')) placed.filter(opening => opening.kind === 'window').forEach(opening => addWindowFrame(builder, opening));
  if (wants('glass')) placed.filter(opening => opening.kind === 'window').forEach(opening => addGlass(builder, opening));
  if (builder.vertexCount() === 0) {
    throw invalidField('floorPlan.part', plan.part, `a part this plan has: ${plan.part === 'floor' || plan.part === 'ceiling' ? 'floor and ceiling need walls that close into a room' : `no ${plan.part === 'doors' ? 'door' : 'window'} openings exist, so add one to openings`}`);
  }
  if (builder.vertexCount() > maxVertices) {
    throw invalidField('floorPlan', `${builder.vertexCount()} vertices`, `a plan that builds at most ${maxVertices} vertices; use fewer walls or openings`);
  }
  return builder.finish();
}
