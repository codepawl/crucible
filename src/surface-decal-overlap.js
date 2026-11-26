// Projects 3D mesh bounds and wires onto a board or wall quad, then flags any 2D decal or border frame that
// enters another item or its clearance zone. Pure spatial geometry; nothing is drawn or indexed on the GPU.

const MAX_PARTS = 16_384;
const MAX_DECALS = 16_384;
const MAX_WIRES = 16_384;
const MAX_WIRE_POINTS = 262_144;
const DEFAULT_MAX_OVERLAPS = 4096;
const MAX_ALLOWED_OVERLAPS = 65_536;
const ORTHOGONALITY_TOLERANCE = 1e-4;
const MINIMUM_AXIS_LENGTH = 1e-9;

const EXPLICIT_QUAD_KEYS = new Set(['origin', 'uAxis', 'vAxis', 'normal', 'coordinateSpace']);
const XZ_QUAD_KEYS = new Set(['min', 'max', 'y', 'normal', 'coordinateSpace']);
const EXPLICIT_COORDINATE_SPACES = new Set(['uv', 'metres', 'meters', 'world']);
const XZ_COORDINATE_SPACES = new Set(['uv', 'world', 'xz', 'metres', 'meters']);
const OPTION_KEYS = new Set(['clearance', 'ignore', 'wires', 'checkBorder', 'checkDecals', 'heightRange', 'maxOverlaps']);
const WIRE_KEYS = new Set(['id', 'points', 'radius', 'width']);
const DECAL_KEYS = new Set(['id', 'bounds', 'hollow', 'strokeWidth']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function assertAllowedKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Unsupported ${label} option "${key}". Allowed keys: ${[...allowed].join(', ')}.`);
    }
  }
}

function assertVector(value, length, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) {
    throw new TypeError(`${label} must be a ${length}-component finite vector.`);
  }
  const copy = new Array(length);
  for (let index = 0; index < length; index++) {
    const component = value[index];
    if (!Number.isFinite(component)) {
      throw new TypeError(`${label}[${index}] must be a finite number, got ${component}.`);
    }
    copy[index] = component;
  }
  return copy;
}

function assertNonNegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number of metres, got ${value}.`);
  }
  return value;
}

function dot3(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross3(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize3(vector, label) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > MINIMUM_AXIS_LENGTH)) {
    throw new RangeError(`${label} cannot have zero length.`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function parseSurfaceQuad(surfaceQuad) {
  if (!isPlainObject(surfaceQuad)) {
    throw new TypeError('surfaceQuad must be an object describing { origin, uAxis, vAxis } or { min, max, y? }.');
  }
  const hasExplicitAxes = surfaceQuad.origin !== undefined || surfaceQuad.uAxis !== undefined || surfaceQuad.vAxis !== undefined;
  const hasXzBounds = surfaceQuad.min !== undefined || surfaceQuad.max !== undefined;
  if (hasExplicitAxes && hasXzBounds) {
    throw new TypeError('surfaceQuad cannot mix { origin, uAxis, vAxis } with { min, max }. Pass one form or the other.');
  }
  if (hasExplicitAxes) {
    assertAllowedKeys(surfaceQuad, EXPLICIT_QUAD_KEYS, 'surfaceQuad');
    const origin = assertVector(surfaceQuad.origin, 3, 'surfaceQuad.origin');
    const uAxis = assertVector(surfaceQuad.uAxis, 3, 'surfaceQuad.uAxis');
    const vAxis = assertVector(surfaceQuad.vAxis, 3, 'surfaceQuad.vAxis');
    const width = Math.hypot(uAxis[0], uAxis[1], uAxis[2]);
    const height = Math.hypot(vAxis[0], vAxis[1], vAxis[2]);
    if (!(width > MINIMUM_AXIS_LENGTH) || !(height > MINIMUM_AXIS_LENGTH)) {
      throw new RangeError('surfaceQuad uAxis and vAxis must both have non-zero length.');
    }
    const uUnit = [uAxis[0] / width, uAxis[1] / width, uAxis[2] / width];
    const vUnit = [vAxis[0] / height, vAxis[1] / height, vAxis[2] / height];
    if (Math.abs(dot3(uUnit, vUnit)) > ORTHOGONALITY_TOLERANCE) {
      throw new RangeError('surfaceQuad uAxis and vAxis must be orthogonal.');
    }
    const normal = surfaceQuad.normal !== undefined
      ? normalize3(assertVector(surfaceQuad.normal, 3, 'surfaceQuad.normal'), 'surfaceQuad.normal')
      : normalize3(cross3(uUnit, vUnit), 'surfaceQuad cross(uAxis, vAxis)');
    const coordinateSpace = surfaceQuad.coordinateSpace ?? 'uv';
    if (typeof coordinateSpace !== 'string' || !EXPLICIT_COORDINATE_SPACES.has(coordinateSpace)) {
      throw new TypeError(`surfaceQuad.coordinateSpace must be one of ${[...EXPLICIT_COORDINATE_SPACES].join(', ')}, got ${coordinateSpace}.`);
    }
    return { origin, uUnit, vUnit, normal, width, height, coordinateSpace, isXzShorthand: false };
  }
  if (hasXzBounds) {
    assertAllowedKeys(surfaceQuad, XZ_QUAD_KEYS, 'surfaceQuad');
    const min = assertVector(surfaceQuad.min, 2, 'surfaceQuad.min');
    const max = assertVector(surfaceQuad.max, 2, 'surfaceQuad.max');
    if (!(max[0] > min[0]) || !(max[1] > min[1])) {
      throw new RangeError('surfaceQuad.max must be strictly greater than surfaceQuad.min on both axes.');
    }
    const y = surfaceQuad.y ?? 0;
    if (!Number.isFinite(y)) {
      throw new TypeError(`surfaceQuad.y must be a finite number, got ${y}.`);
    }
    const normal = surfaceQuad.normal !== undefined
      ? normalize3(assertVector(surfaceQuad.normal, 3, 'surfaceQuad.normal'), 'surfaceQuad.normal')
      : [0, 1, 0];
    const coordinateSpace = surfaceQuad.coordinateSpace ?? 'uv';
    if (typeof coordinateSpace !== 'string' || !XZ_COORDINATE_SPACES.has(coordinateSpace)) {
      throw new TypeError(`surfaceQuad.coordinateSpace must be one of ${[...XZ_COORDINATE_SPACES].join(', ')}, got ${coordinateSpace}.`);
    }
    return {
      origin: [min[0], y, min[1]],
      uUnit: [1, 0, 0],
      vUnit: [0, 0, 1],
      normal,
      width: max[0] - min[0],
      height: max[1] - min[1],
      coordinateSpace,
      isXzShorthand: true,
    };
  }
  throw new TypeError('surfaceQuad requires either { origin, uAxis, vAxis } or { min, max }.');
}

function toSurfaceMetres(first, second, frame) {
  if (frame.coordinateSpace === 'uv') {
    return [first * frame.width, second * frame.height];
  }
  if (frame.isXzShorthand && (frame.coordinateSpace === 'world' || frame.coordinateSpace === 'xz')) {
    return [first - frame.origin[0], second - frame.origin[2]];
  }
  return [first, second];
}

function projectPointToFrame(x, y, z, frame) {
  const dx = x - frame.origin[0];
  const dy = y - frame.origin[1];
  const dz = z - frame.origin[2];
  return [
    dx * frame.uUnit[0] + dy * frame.uUnit[1] + dz * frame.uUnit[2],
    dx * frame.vUnit[0] + dy * frame.vUnit[1] + dz * frame.vUnit[2],
    dx * frame.normal[0] + dy * frame.normal[1] + dz * frame.normal[2],
  ];
}

function buildIgnoreMatcher(ignore) {
  if (ignore === undefined || ignore === null) {
    return () => false;
  }
  if (typeof ignore === 'function') {
    return ignore;
  }
  if (ignore instanceof Set) {
    return id => ignore.has(id);
  }
  if (Array.isArray(ignore)) {
    const names = new Set();
    for (let index = 0; index < ignore.length; index++) {
      if (typeof ignore[index] !== 'string') {
        throw new TypeError(`options.ignore[${index}] must be a string id.`);
      }
      names.add(ignore[index]);
    }
    return id => names.has(id);
  }
  throw new TypeError('options.ignore must be an Array of ids, a Set of ids, or a predicate function(id, kind, item).');
}

function parseOptions(options) {
  if (options === undefined) {
    return parseOptions({});
  }
  if (!isPlainObject(options)) {
    throw new TypeError('options must be a plain object when provided.');
  }
  assertAllowedKeys(options, OPTION_KEYS, 'findSurfaceDecalOverlaps');
  const clearance = options.clearance === undefined ? 0 : assertNonNegativeFinite(options.clearance, 'options.clearance');
  const checkBorder = options.checkBorder ?? true;
  if (typeof checkBorder !== 'boolean') {
    throw new TypeError(`options.checkBorder must be a boolean, got ${checkBorder}.`);
  }
  const checkDecals = options.checkDecals ?? true;
  if (typeof checkDecals !== 'boolean') {
    throw new TypeError(`options.checkDecals must be a boolean, got ${checkDecals}.`);
  }
  let heightRange = null;
  if (options.heightRange !== undefined && options.heightRange !== null) {
    const range = assertVector(options.heightRange, 2, 'options.heightRange');
    if (range[0] > range[1]) {
      throw new RangeError(`options.heightRange[0] (${range[0]}) must be <= options.heightRange[1] (${range[1]}).`);
    }
    heightRange = range;
  }
  const maxOverlaps = options.maxOverlaps ?? DEFAULT_MAX_OVERLAPS;
  if (!Number.isInteger(maxOverlaps) || maxOverlaps < 1 || maxOverlaps > MAX_ALLOWED_OVERLAPS) {
    throw new RangeError(`options.maxOverlaps must be an integer between 1 and ${MAX_ALLOWED_OVERLAPS}, got ${maxOverlaps}.`);
  }
  const wires = options.wires ?? [];
  if (!Array.isArray(wires)) {
    throw new TypeError('options.wires must be an Array of { id, points, radius? | width? }.');
  }
  if (wires.length > MAX_WIRES) {
    throw new RangeError(`options.wires exceeds maximum supported count of ${MAX_WIRES}.`);
  }
  const isIgnored = buildIgnoreMatcher(options.ignore);
  return { clearance, checkBorder, checkDecals, heightRange, maxOverlaps, wires, isIgnored };
}

function partWorldBounds(part, index) {
  if (part.bounds !== undefined) {
    const bounds = assertVector(part.bounds, 6, `parts[${index}].bounds`);
    if (bounds[0] > bounds[3] || bounds[1] > bounds[4] || bounds[2] > bounds[5]) {
      throw new RangeError(`parts[${index}].bounds min corner must not exceed max corner.`);
    }
    return bounds;
  }
  const positions = part.geometry?.positions;
  if (!positions || positions.length < 3) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const matrix = part.matrix;
  if (matrix === undefined || matrix === null) {
    return [minX, minY, minZ, maxX, maxY, maxZ];
  }
  if ((!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) || matrix.length < 16) {
    throw new TypeError(`parts[${index}].matrix must have at least 16 numbers.`);
  }
  const world = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? maxX : minX;
    const y = corner & 2 ? maxY : minY;
    const z = corner & 4 ? maxZ : minZ;
    const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) {
      return null;
    }
    if (worldX < world[0]) world[0] = worldX;
    if (worldY < world[1]) world[1] = worldY;
    if (worldZ < world[2]) world[2] = worldZ;
    if (worldX > world[3]) world[3] = worldX;
    if (worldY > world[4]) world[4] = worldY;
    if (worldZ > world[5]) world[5] = worldZ;
  }
  return world;
}

function projectParts(parts, frame, heightRange, isIgnored) {
  if (!Array.isArray(parts)) {
    throw new TypeError('parts must be an Array of scene parts.');
  }
  if (parts.length > MAX_PARTS) {
    throw new RangeError(`parts exceeds maximum supported count of ${MAX_PARTS}.`);
  }
  const projected = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!isPlainObject(part)) {
      throw new TypeError(`parts[${index}] must be an object.`);
    }
    const id = part.id !== undefined ? String(part.id) : (part.name !== undefined ? String(part.name) : `part-${index}`);
    if (isIgnored(id, 'part', part)) {
      continue;
    }
    const bounds = partWorldBounds(part, index);
    if (!bounds) {
      continue;
    }
    let sMin = Infinity;
    let tMin = Infinity;
    let hMin = Infinity;
    let sMax = -Infinity;
    let tMax = -Infinity;
    let hMax = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? bounds[3] : bounds[0];
      const y = corner & 2 ? bounds[4] : bounds[1];
      const z = corner & 4 ? bounds[5] : bounds[2];
      const [surfaceU, surfaceV, surfaceHeight] = projectPointToFrame(x, y, z, frame);
      if (surfaceU < sMin) sMin = surfaceU;
      if (surfaceV < tMin) tMin = surfaceV;
      if (surfaceHeight < hMin) hMin = surfaceHeight;
      if (surfaceU > sMax) sMax = surfaceU;
      if (surfaceV > tMax) tMax = surfaceV;
      if (surfaceHeight > hMax) hMax = surfaceHeight;
    }
    if (heightRange && (hMax < heightRange[0] || hMin > heightRange[1])) {
      continue;
    }
    projected.push({ id, sMin, tMin, sMax, tMax });
  }
  return projected;
}

function parseWires(wires, frame, heightRange, isIgnored) {
  const parsed = [];
  let totalPoints = 0;
  for (let wireIndex = 0; wireIndex < wires.length; wireIndex++) {
    const wire = wires[wireIndex];
    if (!isPlainObject(wire)) {
      throw new TypeError(`options.wires[${wireIndex}] must be an object.`);
    }
    assertAllowedKeys(wire, WIRE_KEYS, `options.wires[${wireIndex}]`);
    if (typeof wire.id !== 'string' || wire.id.length === 0) {
      throw new TypeError(`options.wires[${wireIndex}].id must be a non-empty string.`);
    }
    if (!Array.isArray(wire.points) || wire.points.length < 2) {
      throw new TypeError(`options.wires[${wireIndex}].points must be an Array with at least 2 points.`);
    }
    totalPoints += wire.points.length;
    if (totalPoints > MAX_WIRE_POINTS) {
      throw new RangeError(`Total wire point count exceeds maximum supported limit of ${MAX_WIRE_POINTS}.`);
    }
    if (wire.radius !== undefined && wire.width !== undefined) {
      throw new TypeError(`options.wires[${wireIndex}] cannot specify both radius and width.`);
    }
    let halfWidth = 0;
    if (wire.radius !== undefined) {
      halfWidth = assertNonNegativeFinite(wire.radius, `options.wires[${wireIndex}].radius`);
    } else if (wire.width !== undefined) {
      halfWidth = assertNonNegativeFinite(wire.width, `options.wires[${wireIndex}].width`) / 2;
    }
    const mappedPoints = new Array(wire.points.length);
    for (let pointIndex = 0; pointIndex < wire.points.length; pointIndex++) {
      const point = wire.points[pointIndex];
      if ((!Array.isArray(point) && !ArrayBuffer.isView(point)) || (point.length !== 2 && point.length !== 3)) {
        throw new TypeError(`options.wires[${wireIndex}].points[${pointIndex}] must be [u, v] or [x, y, z].`);
      }
      if (point.length === 2) {
        const vector = assertVector(point, 2, `options.wires[${wireIndex}].points[${pointIndex}]`);
        const [surfaceU, surfaceV] = toSurfaceMetres(vector[0], vector[1], frame);
        mappedPoints[pointIndex] = { s: surfaceU, t: surfaceV, h: 0, hasHeight: false };
      } else {
        const vector = assertVector(point, 3, `options.wires[${wireIndex}].points[${pointIndex}]`);
        const [surfaceU, surfaceV, surfaceHeight] = projectPointToFrame(vector[0], vector[1], vector[2], frame);
        mappedPoints[pointIndex] = { s: surfaceU, t: surfaceV, h: surfaceHeight, hasHeight: true };
      }
    }
    if (isIgnored(wire.id, 'wire', wire)) {
      continue;
    }
    const segments = [];
    for (let pointIndex = 0; pointIndex + 1 < mappedPoints.length; pointIndex++) {
      const first = mappedPoints[pointIndex];
      const second = mappedPoints[pointIndex + 1];
      if (heightRange && first.hasHeight && second.hasHeight) {
        const segHMin = Math.min(first.h, second.h) - halfWidth;
        const segHMax = Math.max(first.h, second.h) + halfWidth;
        if (segHMax < heightRange[0] || segHMin > heightRange[1]) {
          continue;
        }
      }
      segments.push([first.s, first.t, second.s, second.t]);
    }
    if (segments.length > 0) {
      parsed.push({ id: wire.id, halfWidth, segments });
    }
  }
  return parsed;
}

function parseDecalBounds(bounds, decalIndex, frame) {
  let firstPair;
  let secondPair;
  if (Array.isArray(bounds) || ArrayBuffer.isView(bounds)) {
    const flat = assertVector(bounds, 4, `decals[${decalIndex}].bounds`);
    firstPair = [flat[0], flat[1]];
    secondPair = [flat[2], flat[3]];
  } else if (isPlainObject(bounds) && bounds.min !== undefined && bounds.max !== undefined) {
    firstPair = assertVector(bounds.min, 2, `decals[${decalIndex}].bounds.min`);
    secondPair = assertVector(bounds.max, 2, `decals[${decalIndex}].bounds.max`);
  } else {
    throw new TypeError(`decals[${decalIndex}].bounds must be [minU, minV, maxU, maxV] or { min: [u, v], max: [u, v] }.`);
  }
  if (firstPair[0] > secondPair[0] || firstPair[1] > secondPair[1]) {
    throw new RangeError(`decals[${decalIndex}].bounds minimum must not exceed maximum.`);
  }
  const start = toSurfaceMetres(firstPair[0], firstPair[1], frame);
  const end = toSurfaceMetres(secondPair[0], secondPair[1], frame);
  return {
    sMin: Math.min(start[0], end[0]),
    tMin: Math.min(start[1], end[1]),
    sMax: Math.max(start[0], end[0]),
    tMax: Math.max(start[1], end[1]),
  };
}

function parseDecals(decals, frame, isIgnored) {
  if (!Array.isArray(decals)) {
    throw new TypeError('decals must be an Array of { id, bounds, hollow?, strokeWidth? }.');
  }
  if (decals.length > MAX_DECALS) {
    throw new RangeError(`decals exceeds maximum supported count of ${MAX_DECALS}.`);
  }
  const parsed = [];
  for (let index = 0; index < decals.length; index++) {
    const decal = decals[index];
    if (!isPlainObject(decal)) {
      throw new TypeError(`decals[${index}] must be an object.`);
    }
    assertAllowedKeys(decal, DECAL_KEYS, `decals[${index}]`);
    if (typeof decal.id !== 'string' || decal.id.length === 0) {
      throw new TypeError(`decals[${index}].id must be a non-empty string.`);
    }
    const hollow = decal.hollow ?? false;
    if (typeof hollow !== 'boolean') {
      throw new TypeError(`decals[${index}].hollow must be a boolean, got ${hollow}.`);
    }
    const strokeWidth = decal.strokeWidth === undefined
      ? 0
      : assertNonNegativeFinite(decal.strokeWidth, `decals[${index}].strokeWidth`);
    const rect = parseDecalBounds(decal.bounds, index, frame);
    if (isIgnored(decal.id, 'decal', decal)) {
      continue;
    }
    const edges = hollow
      ? [
        [rect.sMin, rect.tMin, rect.sMax, rect.tMin],
        [rect.sMax, rect.tMin, rect.sMax, rect.tMax],
        [rect.sMax, rect.tMax, rect.sMin, rect.tMax],
        [rect.sMin, rect.tMax, rect.sMin, rect.tMin],
      ]
      : null;
    parsed.push({
      id: decal.id,
      ...rect,
      hollow,
      halfStroke: strokeWidth / 2,
      edges,
    });
  }
  return parsed;
}

function boxToBoxSignedGap(first, second) {
  const deltaS = Math.max(first.sMin - second.sMax, second.sMin - first.sMax);
  const deltaT = Math.max(first.tMin - second.tMax, second.tMin - first.tMax);
  if (deltaS > 0 || deltaT > 0) {
    return Math.hypot(Math.max(deltaS, 0), Math.max(deltaT, 0));
  }
  return Math.max(deltaS, deltaT);
}

function pointToBoxDistance(pointU, pointV, box) {
  const clampedU = Math.max(box.sMin, Math.min(pointU, box.sMax));
  const clampedV = Math.max(box.tMin, Math.min(pointV, box.tMax));
  return Math.hypot(pointU - clampedU, pointV - clampedV);
}

function pointToSegmentDistance(pointS, pointT, startS, startT, endS, endT) {
  const ds = endS - startS;
  const dt = endT - startT;
  const lengthSquared = ds * ds + dt * dt;
  if (lengthSquared === 0) {
    return Math.hypot(pointS - startS, pointT - startT);
  }
  const fraction = Math.max(0, Math.min(1, ((pointS - startS) * ds + (pointT - startT) * dt) / lengthSquared));
  return Math.hypot(pointS - (startS + fraction * ds), pointT - (startT + fraction * dt));
}

function deepestBoxPenetration(startS, startT, deltaS, deltaT, tEnter, tExit, box) {
  // Distance to the nearest rectangle side along the segment is piecewise linear concave, so its maximum lies
  // at the clipped endpoints, midpoint, or where two wall-distance functions intersect.
  const candidates = [tEnter, tExit, (tEnter + tExit) * 0.5];
  const centerS = (box.sMin + box.sMax) * 0.5;
  const centerT = (box.tMin + box.tMax) * 0.5;
  if (Math.abs(deltaS) > 1e-12) candidates.push((centerS - startS) / deltaS);
  if (Math.abs(deltaT) > 1e-12) candidates.push((centerT - startT) / deltaT);
  const diffs = [
    [deltaS - deltaT, (box.sMin - box.tMin) - (startS - startT)],
    [deltaS + deltaT, (box.sMin + box.tMax) - (startS + startT)],
    [-deltaS - deltaT, (-box.sMax - box.tMin) - (-startS - startT)],
    [-deltaS + deltaT, (-box.sMax + box.tMax) - (-startS + startT)],
  ];
  for (const [slope, offset] of diffs) {
    if (Math.abs(slope) > 1e-12) candidates.push(offset / slope);
  }
  let maximumDepth = 0;
  for (const parameter of candidates) {
    const clamped = Math.max(tEnter, Math.min(tExit, parameter));
    const ps = startS + deltaS * clamped;
    const pt = startT + deltaT * clamped;
    const depth = Math.min(ps - box.sMin, box.sMax - ps, pt - box.tMin, box.tMax - pt);
    if (depth > maximumDepth) {
      maximumDepth = depth;
    }
  }
  return maximumDepth;
}

function segmentToBoxSignedGap(startS, startT, endS, endT, box, halfWidth) {
  const deltaS = endS - startS;
  const deltaT = endT - startT;
  let tEnter = 0;
  let tExit = 1;
  let clippedOut = false;
  const slabs = [
    [-deltaS, startS - box.sMin],
    [deltaS, box.sMax - startS],
    [-deltaT, startT - box.tMin],
    [deltaT, box.tMax - startT],
  ];
  for (const [directionTerm, boundaryMargin] of slabs) {
    if (directionTerm === 0) {
      if (boundaryMargin < 0) {
        clippedOut = true;
        break;
      }
    } else {
      const ratio = boundaryMargin / directionTerm;
      if (directionTerm < 0) {
        if (ratio > tExit) {
          clippedOut = true;
          break;
        }
        if (ratio > tEnter) tEnter = ratio;
      } else {
        if (ratio < tEnter) {
          clippedOut = true;
          break;
        }
        if (ratio < tExit) tExit = ratio;
      }
    }
  }
  if (!clippedOut && tEnter <= tExit) {
    const maxDepth = deepestBoxPenetration(startS, startT, deltaS, deltaT, tEnter, tExit, box);
    return -maxDepth - halfWidth;
  }
  let minDistance = Math.min(
    pointToBoxDistance(startS, startT, box),
    pointToBoxDistance(endS, endT, box),
    pointToSegmentDistance(box.sMin, box.tMin, startS, startT, endS, endT),
    pointToSegmentDistance(box.sMax, box.tMin, startS, startT, endS, endT),
    pointToSegmentDistance(box.sMin, box.tMax, startS, startT, endS, endT),
    pointToSegmentDistance(box.sMax, box.tMax, startS, startT, endS, endT),
  );
  return minDistance - halfWidth;
}

function cross2d(originS, originT, pointAS, pointAT, pointBS, pointBT) {
  return (pointAS - originS) * (pointBT - originT) - (pointAT - originT) * (pointBS - originS);
}

function onCollinearSegment(pointS, pointT, startS, startT, endS, endT) {
  return pointS >= Math.min(startS, endS) - 1e-12
    && pointS <= Math.max(startS, endS) + 1e-12
    && pointT >= Math.min(startT, endT) - 1e-12
    && pointT <= Math.max(startT, endT) + 1e-12;
}

function segmentsIntersect2d(a0s, a0t, a1s, a1t, b0s, b0t, b1s, b1t) {
  const d1 = cross2d(b0s, b0t, b1s, b1t, a0s, a0t);
  const d2 = cross2d(b0s, b0t, b1s, b1t, a1s, a1t);
  const d3 = cross2d(a0s, a0t, a1s, a1t, b0s, b0t);
  const d4 = cross2d(a0s, a0t, a1s, a1t, b1s, b1t);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (Math.abs(d1) <= 1e-12 && onCollinearSegment(a0s, a0t, b0s, b0t, b1s, b1t)) return true;
  if (Math.abs(d2) <= 1e-12 && onCollinearSegment(a1s, a1t, b0s, b0t, b1s, b1t)) return true;
  if (Math.abs(d3) <= 1e-12 && onCollinearSegment(b0s, b0t, a0s, a0t, a1s, a1t)) return true;
  if (Math.abs(d4) <= 1e-12 && onCollinearSegment(b1s, b1t, a0s, a0t, a1s, a1t)) return true;
  return false;
}

function segmentToSegmentDistance(a0s, a0t, a1s, a1t, b0s, b0t, b1s, b1t) {
  if (segmentsIntersect2d(a0s, a0t, a1s, a1t, b0s, b0t, b1s, b1t)) {
    return { intersects: true, distance: 0 };
  }
  const distance = Math.min(
    pointToSegmentDistance(a0s, a0t, b0s, b0t, b1s, b1t),
    pointToSegmentDistance(a1s, a1t, b0s, b0t, b1s, b1t),
    pointToSegmentDistance(b0s, b0t, a0s, a0t, a1s, a1t),
    pointToSegmentDistance(b1s, b1t, a0s, a0t, a1s, a1t),
  );
  return { intersects: false, distance };
}

function minimumWireToBoxGap(wire, box) {
  let minimumGap = Infinity;
  for (const [startS, startT, endS, endT] of wire.segments) {
    const gap = segmentToBoxSignedGap(startS, startT, endS, endT, box, wire.halfWidth);
    if (gap < minimumGap) {
      minimumGap = gap;
    }
  }
  return minimumGap;
}

function minimumEdgesToBoxGap(edges, box, halfStroke) {
  let minimumGap = Infinity;
  for (const [startS, startT, endS, endT] of edges) {
    const gap = segmentToBoxSignedGap(startS, startT, endS, endT, box, halfStroke);
    if (gap < minimumGap) {
      minimumGap = gap;
    }
  }
  return minimumGap;
}

function minimumSegmentGroupsGap(firstSegments, firstHalfWidth, secondSegments, secondHalfWidth) {
  let minimumGap = Infinity;
  let anyIntersects = false;
  const padding = firstHalfWidth + secondHalfWidth;
  for (const [a0s, a0t, a1s, a1t] of firstSegments) {
    for (const [b0s, b0t, b1s, b1t] of secondSegments) {
      const result = segmentToSegmentDistance(a0s, a0t, a1s, a1t, b0s, b0t, b1s, b1t);
      if (result.intersects) {
        anyIntersects = true;
      }
      const gap = result.distance - padding;
      if (gap < minimumGap) {
        minimumGap = gap;
      }
    }
  }
  return { gap: minimumGap, intersects: anyIntersects };
}

function compareTextOrder(first, second) {
  return first < second ? -1 : (first > second ? 1 : 0);
}

/**
 * Projects 3D mesh parts and optional 2D/3D polyline wires onto a flat surface quad, then reports every 2D
 * decal or border frame that enters a part, wire, quad border, or sibling decal within `clearance` metres.
 */
export function findSurfaceDecalOverlaps(parts, surfaceQuad, decals, options = {}) {
  const frame = parseSurfaceQuad(surfaceQuad);
  const settings = parseOptions(options);
  const projectedParts = projectParts(parts, frame, settings.heightRange, settings.isIgnored);
  const parsedWires = parseWires(settings.wires, frame, settings.heightRange, settings.isIgnored);
  const parsedDecals = parseDecals(decals, frame, settings.isIgnored);
  const borderIgnored = settings.isIgnored('border', 'border', null);
  const overlaps = [];

  for (let decalIndex = 0; decalIndex < parsedDecals.length; decalIndex++) {
    const decal = parsedDecals[decalIndex];
    if (settings.checkBorder && !borderIgnored) {
      const borderMargin = Math.min(decal.sMin, frame.width - decal.sMax, decal.tMin, frame.height - decal.tMax);
      const borderGap = decal.hollow ? borderMargin - decal.halfStroke : borderMargin;
      if (borderGap < settings.clearance) {
        overlaps.push({ decalId: decal.id, targetId: 'border', kind: 'border', clearanceGap: borderGap });
      }
    }
    for (const part of projectedParts) {
      const partGap = decal.hollow
        ? minimumEdgesToBoxGap(decal.edges, part, decal.halfStroke)
        : boxToBoxSignedGap(decal, part);
      if (partGap < settings.clearance) {
        overlaps.push({ decalId: decal.id, targetId: part.id, kind: 'part', clearanceGap: partGap });
      }
    }
    for (const wire of parsedWires) {
      if (decal.hollow) {
        const result = minimumSegmentGroupsGap(decal.edges, decal.halfStroke, wire.segments, wire.halfWidth);
        if (result.gap < settings.clearance || (result.intersects && result.gap <= settings.clearance)) {
          overlaps.push({ decalId: decal.id, targetId: wire.id, kind: 'wire', clearanceGap: result.gap });
        }
      } else {
        const wireGap = minimumWireToBoxGap(wire, decal);
        if (wireGap < settings.clearance) {
          overlaps.push({ decalId: decal.id, targetId: wire.id, kind: 'wire', clearanceGap: wireGap });
        }
      }
    }
    if (settings.checkDecals) {
      for (let siblingIndex = decalIndex + 1; siblingIndex < parsedDecals.length; siblingIndex++) {
        const sibling = parsedDecals[siblingIndex];
        let gap;
        let hit = false;
        if (!decal.hollow && !sibling.hollow) {
          gap = boxToBoxSignedGap(decal, sibling);
        } else if (decal.hollow && !sibling.hollow) {
          gap = minimumEdgesToBoxGap(decal.edges, sibling, decal.halfStroke);
        } else if (!decal.hollow && sibling.hollow) {
          gap = minimumEdgesToBoxGap(sibling.edges, decal, sibling.halfStroke);
        } else {
          const result = minimumSegmentGroupsGap(decal.edges, decal.halfStroke, sibling.edges, sibling.halfStroke);
          gap = result.gap;
          hit = result.intersects;
        }
        if (gap < settings.clearance || (hit && gap <= settings.clearance)) {
          const firstIsDecal = compareTextOrder(decal.id, sibling.id) <= 0;
          overlaps.push({
            decalId: firstIsDecal ? decal.id : sibling.id,
            targetId: firstIsDecal ? sibling.id : decal.id,
            kind: 'decal',
            clearanceGap: gap,
          });
        }
      }
    }
  }

  overlaps.sort((first, second) =>
    (first.clearanceGap - second.clearanceGap)
    || compareTextOrder(first.decalId, second.decalId)
    || compareTextOrder(first.kind, second.kind)
    || compareTextOrder(first.targetId, second.targetId)
  );
  return overlaps.length > settings.maxOverlaps ? overlaps.slice(0, settings.maxOverlaps) : overlaps;
}
