// The plan side of a recipe floorPlan: validates the input, splits walls where others meet them, finds the mitred corner at
// every joint and traces the closed loops that become floor and ceiling. Everything here is flat 2D maths on [x, z] points
// in metres; the builder in agent-floor-plan.js lifts it into 3D.

import { invalidField } from './field-error.js';

export const FLOOR_PLAN_LIMITS = Object.freeze({
  maximumWalls: 256,
  maximumOpenings: 256,
  maximumPieces: 1024,
  coordinate: 10000,
  height: [0.5, 20],
  defaultHeight: 2.7,
  thickness: [0.02, 2],
  defaultThickness: 0.2,
  minimumWallLength: 0.1,
  minimumLintel: 0.01,
  minimumOpeningSize: 0.2,
  minimumGap: 0.01,
  minimumJointDegrees: 15,
});
export const FLOOR_PLAN_PARTS = Object.freeze(['all', 'walls', 'floor', 'ceiling', 'doors', 'windows', 'glass']);
export const OPENING_KINDS = Object.freeze(['door', 'window']);
const OPENING_DEFAULTS = Object.freeze({
  door: { width: 0.9, height: 2.1, sill: 0 },
  window: { width: 1.2, height: 1.2, sill: 0.9 },
});
const POINT_TOLERANCE = 1e-6;
const FULL_TURN = Math.PI * 2;

function plainRecord(value, path, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, `an object with ${allowedKeys.join(', ')}`, TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use ${allowedKeys.join(', ')}`, TypeError);
  }
  return value;
}

function numberWithin(value, path, [minimum, maximum], example) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${example}`);
  }
  return value;
}

function planPoint(value, path) {
  const limit = FLOOR_PLAN_LIMITS.coordinate;
  if (!Array.isArray(value) || value.length !== 2 || !value.every(component => Number.isFinite(component) && Math.abs(component) <= limit)) {
    throw invalidField(path, value, `[x, z] in metres, each from -${limit} to ${limit}, such as [0, 4]`);
  }
  return [value[0], value[1]];
}

function listOf(value, path, maximum, example) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidField(path, Array.isArray(value) ? `${value.length} entries` : value, `a list of at most ${maximum}, such as ${example}`);
  }
  return value;
}

function resolveWall(wall, index, defaultThickness) {
  const path = `floorPlan.walls[${index}]`;
  plainRecord(wall, path, ['from', 'to', 'thickness']);
  const from = planPoint(wall.from, `${path}.from`);
  const to = planPoint(wall.to, `${path}.to`);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length < FLOOR_PLAN_LIMITS.minimumWallLength) {
    throw invalidField(`${path}.to`, wall.to, `a point at least ${FLOOR_PLAN_LIMITS.minimumWallLength} m from from ${JSON.stringify(from)}`);
  }
  const thickness = numberWithin(wall.thickness ?? defaultThickness, `${path}.thickness`, FLOOR_PLAN_LIMITS.thickness, FLOOR_PLAN_LIMITS.defaultThickness);
  return { from, to, thickness, length };
}

function resolveOpening(opening, index, walls, height) {
  const path = `floorPlan.openings[${index}]`;
  plainRecord(opening, path, ['wall', 'offset', 'width', 'height', 'sill', 'kind']);
  if (!Number.isInteger(opening.wall) || opening.wall < 0 || opening.wall >= walls.length) {
    throw invalidField(`${path}.wall`, opening.wall, `the index of a wall, 0 to ${walls.length - 1}`);
  }
  const kind = opening.kind ?? (opening.sill === undefined || opening.sill === 0 ? 'door' : 'window');
  if (!OPENING_KINDS.includes(kind)) throw invalidField(`${path}.kind`, opening.kind, `one of ${OPENING_KINDS.join(', ')}`);
  const defaults = OPENING_DEFAULTS[kind];
  const wall = walls[opening.wall];
  const width = numberWithin(opening.width ?? defaults.width, `${path}.width`, [FLOOR_PLAN_LIMITS.minimumOpeningSize, wall.length], defaults.width);
  const openingHeight = numberWithin(opening.height ?? defaults.height, `${path}.height`, [FLOOR_PLAN_LIMITS.minimumOpeningSize, height], defaults.height);
  const sill = opening.sill ?? defaults.sill;
  if (!Number.isFinite(sill) || sill < 0 || (sill > 0 && sill < 0.01)) {
    throw invalidField(`${path}.sill`, opening.sill, `0 for a door at floor level, or a height of at least 0.01 m, such as ${OPENING_DEFAULTS.window.sill}`);
  }
  const highestTop = height - FLOOR_PLAN_LIMITS.minimumLintel;
  if (sill + openingHeight > highestTop + 1e-9) {
    throw invalidField(`${path}.height`, openingHeight, `a height so that sill (${sill}) + height stays at least ${FLOOR_PLAN_LIMITS.minimumLintel} m under the wall height ${height}, at most ${Math.max(0, highestTop - sill)}`);
  }
  const offset = opening.offset;
  const lastOffset = wall.length - width;
  if (!Number.isFinite(offset) || offset < 0 || offset > lastOffset + 1e-9) {
    throw invalidField(`${path}.offset`, offset, `the distance in metres from the wall start (from) to the opening start, from 0 to ${lastOffset} so that offset + width (${width}) stays inside wall ${opening.wall}, which is ${wall.length} m long`);
  }
  return { index, wall: opening.wall, kind, offset, width, height: openingHeight, sill };
}

function checkOpeningsApart(openings) {
  const sorted = [...openings].sort((first, second) => first.wall - second.wall || first.offset - second.offset);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.wall === current.wall && current.offset < previous.offset + previous.width + FLOOR_PLAN_LIMITS.minimumGap) {
      throw invalidField(`floorPlan.openings[${current.index}].offset`, current.offset, `an offset of at least ${previous.offset + previous.width + FLOOR_PLAN_LIMITS.minimumGap} so it clears opening ${previous.index} on wall ${current.wall} (openings need ${FLOOR_PLAN_LIMITS.minimumGap} m between them)`);
    }
  }
}

/** Checks a recipe floorPlan record and returns its numbers with every default filled in. */
export function resolveFloorPlan(value) {
  const height = numberWithin(value.height ?? FLOOR_PLAN_LIMITS.defaultHeight, 'floorPlan.height', FLOOR_PLAN_LIMITS.height, FLOOR_PLAN_LIMITS.defaultHeight);
  const defaultThickness = numberWithin(value.thickness ?? FLOOR_PLAN_LIMITS.defaultThickness, 'floorPlan.thickness', FLOOR_PLAN_LIMITS.thickness, FLOOR_PLAN_LIMITS.defaultThickness);
  const part = value.part ?? 'all';
  if (!FLOOR_PLAN_PARTS.includes(part)) throw invalidField('floorPlan.part', value.part, `one of ${FLOOR_PLAN_PARTS.join(', ')}`);
  const wallList = listOf(value.walls, 'floorPlan.walls', FLOOR_PLAN_LIMITS.maximumWalls, '[{ "from": [0, 0], "to": [4, 0] }]');
  if (wallList.length === 0) throw invalidField('floorPlan.walls', value.walls, 'a list of 1 to 256 walls, such as [{ "from": [0, 0], "to": [4, 0] }]');
  const walls = wallList.map((wall, index) => resolveWall(wall, index, defaultThickness));
  const openingList = listOf(value.openings ?? [], 'floorPlan.openings', FLOOR_PLAN_LIMITS.maximumOpenings, '[{ "wall": 0, "offset": 1, "kind": "door" }]');
  const openings = openingList.map((opening, index) => resolveOpening(opening, index, walls, height));
  checkOpeningsApart(openings);
  return { height, part, walls, openings };
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1]];
}

function crossProduct(first, second) {
  return first[0] * second[1] - first[1] * second[0];
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1];
}

function leftNormal(direction) {
  return [-direction[1], direction[0]];
}

function wallDirection(wall) {
  return [(wall.to[0] - wall.from[0]) / wall.length, (wall.to[1] - wall.from[1]) / wall.length];
}

// Where wall `first` has to be cut so that `second` ends on it or crosses it: the distance from first.from, and the point.
function splitAgainst(first, second, firstIndex, secondIndex) {
  const firstAxis = subtract(first.to, first.from);
  const secondAxis = subtract(second.to, second.from);
  const denominator = crossProduct(firstAxis, secondAxis);
  const offset = subtract(second.from, first.from);
  if (Math.abs(denominator) < 1e-12 * first.length * second.length) {
    const direction = wallDirection(first);
    const sideways = Math.abs(crossProduct(offset, direction));
    if (sideways > POINT_TOLERANCE) return [];
    const start = dotProduct(offset, direction);
    const end = dotProduct(subtract(second.to, first.from), direction);
    const overlap = Math.min(first.length, Math.max(start, end)) - Math.max(0, Math.min(start, end));
    if (overlap > POINT_TOLERANCE) {
      throw invalidField('floorPlan.walls', `walls ${firstIndex} and ${secondIndex}`, `walls that do not run on top of each other: they overlap for ${overlap.toFixed(3)} m; shorten one or join them end to end`);
    }
    return [];
  }
  const along = crossProduct(offset, secondAxis) / denominator;
  const across = crossProduct(offset, firstAxis) / denominator;
  const firstTolerance = POINT_TOLERANCE / first.length;
  const secondTolerance = POINT_TOLERANCE / second.length;
  const interior = along > firstTolerance && along < 1 - firstTolerance;
  const touches = across > -secondTolerance && across < 1 + secondTolerance;
  if (!interior || !touches) return [];
  const nearSecondStart = across < secondTolerance;
  const nearSecondEnd = across > 1 - secondTolerance;
  const point = nearSecondStart ? second.from : nearSecondEnd ? second.to : [first.from[0] + firstAxis[0] * along, first.from[1] + firstAxis[1] * along];
  return [{ distance: along * first.length, point }];
}

function splitPointsOf(walls, wallIndex) {
  const wall = walls[wallIndex];
  const cuts = [{ distance: 0, point: wall.from }, { distance: wall.length, point: wall.to }];
  walls.forEach((other, otherIndex) => {
    if (otherIndex !== wallIndex) cuts.push(...splitAgainst(wall, other, wallIndex, otherIndex));
  });
  cuts.sort((first, second) => first.distance - second.distance);
  return cuts.filter((cut, index) => index === 0 || cut.distance - cuts[index - 1].distance > POINT_TOLERANCE);
}

/** Cuts each wall where another wall ends on it or crosses it, so every joint is a shared end point of its pieces. */
export function splitIntoPieces(walls) {
  const pieces = [];
  walls.forEach((wall, wallIndex) => {
    const cuts = splitPointsOf(walls, wallIndex);
    for (let index = 0; index < cuts.length - 1; index++) {
      pieces.push({ wallIndex, from: cuts[index].point, to: cuts[index + 1].point, startOffset: cuts[index].distance, endOffset: cuts[index + 1].distance, thickness: wall.thickness });
    }
    if (pieces.length > FLOOR_PLAN_LIMITS.maximumPieces) {
      throw invalidField('floorPlan.walls', `${pieces.length} wall pieces after joints`, `walls that meet in at most ${FLOOR_PLAN_LIMITS.maximumPieces} pieces in total; remove crossings`);
    }
  });
  return pieces;
}

function nodeAt(nodes, point) {
  const found = nodes.findIndex(node => Math.hypot(node.point[0] - point[0], node.point[1] - point[1]) <= POINT_TOLERANCE);
  if (found >= 0) return found;
  nodes.push({ point, ends: [] });
  return nodes.length - 1;
}

function ccwGap(first, second) {
  return ((second.angle - first.angle) % FULL_TURN + FULL_TURN) % FULL_TURN;
}

function checkJointAngle(node, first, second, gap) {
  const degrees = gap * 180 / Math.PI;
  if (degrees < FLOOR_PLAN_LIMITS.minimumJointDegrees) {
    throw invalidField('floorPlan.walls', `walls ${first.piece.wallIndex} and ${second.piece.wallIndex} at ${JSON.stringify(node.point)}`, `walls that meet at least ${FLOOR_PLAN_LIMITS.minimumJointDegrees} degrees apart; they meet at ${degrees.toFixed(1)} degrees, so move one end or drop one wall`);
  }
}

// The point where the counter-clockwise side of `first` meets the clockwise side of `second`, which follows it around the joint.
function mitrePoint(node, first, second) {
  const firstNormal = leftNormal(first.direction);
  const secondNormal = leftNormal(second.direction);
  const target = [-(second.halfThickness * secondNormal[0] + first.halfThickness * firstNormal[0]), -(second.halfThickness * secondNormal[1] + first.halfThickness * firstNormal[1])];
  const along = crossProduct(target, second.direction) / crossProduct(first.direction, second.direction);
  return [
    node.point[0] + first.halfThickness * firstNormal[0] + along * first.direction[0],
    node.point[1] + first.halfThickness * firstNormal[1] + along * first.direction[1],
  ];
}

function sideOffset(node, end, sign) {
  const normal = leftNormal(end.direction);
  return [node.point[0] + sign * end.halfThickness * normal[0], node.point[1] + sign * end.halfThickness * normal[1]];
}

function findCorners(node) {
  const { ends } = node;
  ends.forEach((first, index) => {
    const second = ends[(index + 1) % ends.length];
    const gap = ends.length === 1 ? FULL_TURN : ccwGap(first, second);
    if (ends.length > 1) checkJointAngle(node, first, second, gap);
    const straight = ends.length === 1 || Math.abs(Math.sin(gap)) < 1e-4;
    if (straight) {
      first.left = sideOffset(node, first, 1);
      second.right = sideOffset(node, second, -1);
    } else {
      const corner = mitrePoint(node, first, second);
      first.left = corner;
      second.right = corner;
    }
  });
}

function attachEnds(nodes, pieces) {
  pieces.forEach(piece => {
    piece.fromNode = nodeAt(nodes, piece.from);
    piece.toNode = nodeAt(nodes, piece.to);
    piece.origin = nodes[piece.fromNode].point;
  });
  pieces.forEach((piece, index) => {
    for (const atStart of [true, false]) {
      const node = nodes[atStart ? piece.fromNode : piece.toNode];
      const target = nodes[atStart ? piece.toNode : piece.fromNode].point;
      const direction = subtract(target, node.point);
      const length = Math.hypot(direction[0], direction[1]);
      const end = { piece, index, atStart, direction: [direction[0] / length, direction[1] / length], halfThickness: piece.thickness / 2 };
      end.angle = Math.atan2(end.direction[1], end.direction[0]);
      node.ends.push(end);
      piece[atStart ? 'startEnd' : 'finishEnd'] = end;
    }
  });
  nodes.forEach(node => node.ends.sort((first, second) => first.angle - second.angle));
}

// The straight stretch of each side between its two mitred ends, measured along the piece from its start point.
function measurePiece(piece, wallIndexLabel) {
  const origin = piece.origin;
  const { startEnd, finishEnd } = piece;
  const along = point => dotProduct(subtract(point, origin), startEnd.direction);
  piece.left = { start: along(startEnd.left), end: along(finishEnd.right) };
  piece.right = { start: along(startEnd.right), end: along(finishEnd.left) };
  const shortest = Math.min(piece.left.end - piece.left.start, piece.right.end - piece.right.start);
  if (shortest < FLOOR_PLAN_LIMITS.minimumGap) {
    throw invalidField('floorPlan.walls', `wall ${wallIndexLabel}`, `a wall long enough for the corners at both ends: its joints use up its length, so lengthen it or thin the walls that meet it`);
  }
  piece.straight = [Math.max(piece.left.start, piece.right.start), Math.min(piece.left.end, piece.right.end)];
  piece.direction = startEnd.direction;
  piece.normal = leftNormal(startEnd.direction);
}

/** Splits the walls, finds every mitred corner and measures each piece. Returns { pieces, nodes }. */
export function layoutWalls(walls) {
  const pieces = splitIntoPieces(walls);
  const nodes = [];
  attachEnds(nodes, pieces);
  nodes.forEach(findCorners);
  pieces.forEach(piece => measurePiece(piece, piece.wallIndex));
  return { pieces, nodes };
}

/** Gives each opening to the wall piece that holds it whole, and checks it clears the mitred ends of that piece. */
export function placeOpenings(openings, layout) {
  return openings.map(opening => {
    const holder = layout.pieces.find(piece => piece.wallIndex === opening.wall
      && opening.offset >= piece.startOffset - POINT_TOLERANCE && opening.offset + opening.width <= piece.endOffset + POINT_TOLERANCE);
    const path = `floorPlan.openings[${opening.index}].offset`;
    if (!holder) {
      throw invalidField(path, opening.offset, `an opening that sits between two joints of wall ${opening.wall}, not across one; move it clear of the joint where another wall meets this wall`);
    }
    const start = opening.offset - holder.startOffset;
    const [straightStart, straightEnd] = holder.straight;
    if (start < straightStart - POINT_TOLERANCE || start + opening.width > straightEnd + POINT_TOLERANCE) {
      throw invalidField(path, opening.offset, `an opening clear of the mitred corner: its jambs must sit between ${(holder.startOffset + straightStart).toFixed(3)} m and ${(holder.startOffset + straightEnd).toFixed(3)} m along wall ${opening.wall}`);
    }
    return { ...opening, piece: holder, start, end: start + opening.width };
  });
}

function dropRepeats(points) {
  const kept = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]) > POINT_TOLERANCE;
  });
  return kept;
}

function polygonArea(points) {
  return points.reduce((total, point, index) => total + crossProduct(point, points[(index + 1) % points.length]), 0) / 2;
}

/** The inside outline of every closed room: the corner points of the walls that face it, counter-clockwise in [x, z]. */
export function traceRooms(layout) {
  const { pieces, nodes } = layout;
  const visited = new Set();
  const rooms = [];
  const keyOf = (pieceIndex, forward) => `${pieceIndex}:${forward}`;
  pieces.forEach((startPiece, startIndex) => {
    for (const startForward of [true, false]) {
      if (visited.has(keyOf(startIndex, startForward))) continue;
      const outline = [];
      let pieceIndex = startIndex;
      let forward = startForward;
      let steps = 0;
      while (!visited.has(keyOf(pieceIndex, forward)) && steps++ <= pieces.length * 2) {
        visited.add(keyOf(pieceIndex, forward));
        const piece = pieces[pieceIndex];
        const node = nodes[forward ? piece.toNode : piece.fromNode];
        const arriving = node.ends.findIndex(end => end.piece === piece && end.atStart === !forward);
        const leaving = node.ends[(arriving + node.ends.length - 1) % node.ends.length];
        outline.push(node.ends[arriving].right, leaving.left);
        pieceIndex = leaving.index;
        forward = leaving.atStart;
      }
      const points = dropRepeats(outline);
      if (points.length >= 3 && polygonArea(points) > POINT_TOLERANCE) rooms.push(points);
    }
  });
  return rooms;
}
