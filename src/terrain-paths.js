// Terrain paths: spline roads, trails and riverbeds that carve the ground and emit a named mask.
// A path is a curve through [x, z] points (Catmull-Rom, or straight segments with smooth: false). The ground across its width is cut to the height of the centre line minus `depth`,
// the sides blend back into the hills over `falloff`, and each path answers a 0 to 1 mask that splat rules, clutter and vegetation can read.
import { invalidField } from './field-error.js';

export const TERRAIN_PATH_LIMITS = Object.freeze({
  maximumPaths: 16,
  points: [2, 256],
  width: [0.1, 200],
  depth: [0, 20],
  falloff: [0, 200],
  ruts: [0, 2],
  crown: [0, 2],
  shoulder: [0, 2],
  defaultWidth: 3,
  defaultDepth: 0.2,
  maskResolution: [2, 2048],
  defaultMaskResolution: 256,
});

const PATH_FIELDS = ['name', 'points', 'width', 'depth', 'falloff', 'ruts', 'crown', 'shoulder', 'smooth'];
const EXAMPLE_PATH = '{ "points": [[-20, 0], [0, 5], [20, 0]], "width": 3, "depth": 0.2 }';

function pathNumber(value, fallback, [minimum, maximum], label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField(label, resolved, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

function checkPoints(points, label) {
  const [minimum, maximum] = TERRAIN_PATH_LIMITS.points;
  if (!Array.isArray(points) || points.length < minimum || points.length > maximum) {
    throw invalidField(`${label}.points`, Array.isArray(points) ? `${points.length} points` : points, `a list of ${minimum} to ${maximum} points [x, z] in metres, such as [[-20, 0], [0, 5], [20, 0]]`);
  }
  points.forEach((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw invalidField(`${label}.points[${index}]`, point, 'a position [x, z] in metres, such as [0, 5]');
    }
  });
  return points.map(point => [point[0], point[1]]);
}

function checkSmooth(value, label) {
  if (value !== undefined && typeof value !== 'boolean') throw invalidField(`${label}.smooth`, value, 'true or false, such as true; false keeps straight segments between the points');
  return value !== false;
}

function checkPath(path, index) {
  const label = `terrain.paths[${index}]`;
  if (path === null || typeof path !== 'object' || Array.isArray(path)) {
    throw invalidField(label, path, `a path such as ${EXAMPLE_PATH}`);
  }
  for (const field of Object.keys(path)) {
    if (!PATH_FIELDS.includes(field)) throw invalidField(`${label}.${field}`, path[field], `one of the path fields: ${PATH_FIELDS.join(', ')}`);
  }
  const name = path.name ?? `path${index}`;
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
    throw invalidField(`${label}.name`, name, 'a text of 1 to 64 characters, such as "road"');
  }
  const width = pathNumber(path.width, TERRAIN_PATH_LIMITS.defaultWidth, TERRAIN_PATH_LIMITS.width, `${label}.width`);
  return {
    name,
    points: checkPoints(path.points, label),
    width,
    depth: pathNumber(path.depth, TERRAIN_PATH_LIMITS.defaultDepth, TERRAIN_PATH_LIMITS.depth, `${label}.depth`),
    // The sides blend back into the hills over as many metres as the road is wide, unless the path says otherwise.
    falloff: pathNumber(path.falloff, width, TERRAIN_PATH_LIMITS.falloff, `${label}.falloff`),
    ruts: pathNumber(path.ruts, 0, TERRAIN_PATH_LIMITS.ruts, `${label}.ruts`),
    crown: pathNumber(path.crown, 0, TERRAIN_PATH_LIMITS.crown, `${label}.crown`),
    shoulder: pathNumber(path.shoulder, 0, TERRAIN_PATH_LIMITS.shoulder, `${label}.shoulder`),
    smooth: checkSmooth(path.smooth, label),
  };
}

/** The checked paths of a terrain record with their defaults, or an empty list for none. Throws an error that names what to pass. */
export function normalizeTerrainPaths(paths) {
  if (paths === undefined) return [];
  const maximum = TERRAIN_PATH_LIMITS.maximumPaths;
  if (!Array.isArray(paths) || paths.length > maximum) {
    throw invalidField('terrain.paths', Array.isArray(paths) ? `${paths.length} paths` : paths, `a list of at most ${maximum} paths, such as [${EXAMPLE_PATH}]`);
  }
  const normalized = paths.map(checkPath);
  const names = new Set();
  normalized.forEach((path, index) => {
    if (names.has(path.name)) throw invalidField(`terrain.paths[${index}].name`, path.name, 'a name no other path uses, because each path emits a mask of that name');
    names.add(path.name);
  });
  return normalized;
}

function smoothstep(lower, upper, value) {
  const fraction = Math.min(1, Math.max(0, (value - lower) / (upper - lower)));
  return fraction * fraction * (3 - 2 * fraction);
}

function gaussian(distance, centre, spread) {
  const scaled = (distance - centre) / spread;
  return Math.exp(-0.5 * scaled * scaled);
}

// Each rut sits at RUT_CENTRE of the half width from the centre line and is RUT_SPREAD wide (one sigma); the two are chosen so the strip left between the ruts is about as wide as one rut.
const RUT_CENTRE = 0.45;
const RUT_SPREAD = 0.18;
const SMOOTH_STEP_DIVISOR = 4;
const MAXIMUM_CENTRE_SEGMENTS = 8192;
const GRID_CELLS_PER_SIDE = 64;

/** Catmull-Rom through the points, sampled every width / 4 metres (and bounded), so bends read as curves and not as kinks. */
function smoothedCentreLine(path) {
  const points = path.points;
  if (!path.smooth || points.length < 3) return points;
  const step = Math.max(path.width / SMOOTH_STEP_DIVISOR, 0.05);
  const budgetPerSegment = Math.max(1, Math.floor(MAXIMUM_CENTRE_SEGMENTS / (points.length - 1)));
  const result = [points[0]];
  for (let index = 0; index + 1 < points.length; index++) {
    const before = points[Math.max(0, index - 1)];
    const start = points[index];
    const end = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    const pieces = Math.min(budgetPerSegment, Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / step)));
    for (let piece = 1; piece <= pieces; piece++) {
      const fraction = piece / pieces;
      const squared = fraction * fraction;
      const cubed = squared * fraction;
      result.push([0, 1].map(axis => 0.5 * (2 * start[axis] + (end[axis] - before[axis]) * fraction
        + (2 * before[axis] - 5 * start[axis] + 4 * end[axis] - after[axis]) * squared
        + (3 * start[axis] - before[axis] - 3 * end[axis] + after[axis]) * cubed)));
    }
  }
  return result;
}

/** One path prepared for queries: its segments with their bounding boxes in a uniform grid, so a sample reads only the segments near it. */
function prepareSegments(path, reach) {
  const centreLine = smoothedCentreLine(path);
  const segments = [];
  let minimumX = Infinity;
  let minimumZ = Infinity;
  let maximumX = -Infinity;
  let maximumZ = -Infinity;
  for (let index = 0; index + 1 < centreLine.length; index++) {
    const [startX, startZ] = centreLine[index];
    const [endX, endZ] = centreLine[index + 1];
    const segment = {
      startX, startZ, deltaX: endX - startX, deltaZ: endZ - startZ,
      lowX: Math.min(startX, endX) - reach, highX: Math.max(startX, endX) + reach,
      lowZ: Math.min(startZ, endZ) - reach, highZ: Math.max(startZ, endZ) + reach,
    };
    segment.lengthSquared = segment.deltaX * segment.deltaX + segment.deltaZ * segment.deltaZ;
    minimumX = Math.min(minimumX, segment.lowX);
    maximumX = Math.max(maximumX, segment.highX);
    minimumZ = Math.min(minimumZ, segment.lowZ);
    maximumZ = Math.max(maximumZ, segment.highZ);
    segments.push(segment);
  }
  const cellSize = Math.max(reach, (maximumX - minimumX) / GRID_CELLS_PER_SIDE, (maximumZ - minimumZ) / GRID_CELLS_PER_SIDE);
  const columns = Math.floor((maximumX - minimumX) / cellSize) + 1;
  const rows = Math.floor((maximumZ - minimumZ) / cellSize) + 1;
  const cells = Array.from({ length: columns * rows }, () => []);
  for (const segment of segments) {
    const firstColumn = Math.floor((segment.lowX - minimumX) / cellSize);
    const lastColumn = Math.floor((segment.highX - minimumX) / cellSize);
    const firstRow = Math.floor((segment.lowZ - minimumZ) / cellSize);
    const lastRow = Math.floor((segment.highZ - minimumZ) / cellSize);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) cells[row * columns + column].push(segment);
    }
  }
  return { cells, columns, rows, cellSize, minimumX, minimumZ, maximumX, maximumZ };
}

/** The nearest point of the centre line to (x, z): { distance, footX, footZ }, or null when no segment is within reach. */
function nearestOnPath(prepared, reach, pointX, pointZ) {
  if (pointX < prepared.minimumX || pointX > prepared.maximumX || pointZ < prepared.minimumZ || pointZ > prepared.maximumZ) return null;
  const column = Math.min(prepared.columns - 1, Math.floor((pointX - prepared.minimumX) / prepared.cellSize));
  const row = Math.min(prepared.rows - 1, Math.floor((pointZ - prepared.minimumZ) / prepared.cellSize));
  let bestSquared = reach * reach;
  let found = null;
  for (const segment of prepared.cells[row * prepared.columns + column]) {
    if (pointX < segment.lowX || pointX > segment.highX || pointZ < segment.lowZ || pointZ > segment.highZ) continue;
    const along = segment.lengthSquared === 0 ? 0
      : Math.min(1, Math.max(0, ((pointX - segment.startX) * segment.deltaX + (pointZ - segment.startZ) * segment.deltaZ) / segment.lengthSquared));
    const footX = segment.startX + segment.deltaX * along;
    const footZ = segment.startZ + segment.deltaZ * along;
    const squared = (pointX - footX) ** 2 + (pointZ - footZ) ** 2;
    if (squared <= bestSquared) {
      bestSquared = squared;
      found = { distance: Math.sqrt(squared), footX, footZ };
    }
  }
  return found;
}

// The mask is 1 across the road and fades to 0 over half the falloff, so a splat rule or an exclusion stays near the road.
function maskFade(path) {
  return path.falloff / 2;
}

function maskValue(path, distance) {
  const halfWidth = path.width / 2;
  if (distance <= halfWidth) return 1;
  const fade = maskFade(path);
  return fade > 0 ? 1 - smoothstep(halfWidth, halfWidth + fade, distance) : 0;
}

/** Height of the carved ground at one distance from the centre line, given the height of the ground under the foot point. */
function carvedHeight(path, distance, currentHeight, footHeight) {
  const halfWidth = path.width / 2;
  const bed = footHeight - path.depth;
  const crown = path.crown * Math.max(0, 1 - (distance / halfWidth) ** 2);
  const rut = path.ruts * gaussian(distance, halfWidth * RUT_CENTRE, halfWidth * RUT_SPREAD);
  const surface = bed + crown - rut;
  const blend = path.falloff > 0 ? smoothstep(halfWidth, halfWidth + path.falloff, distance) : (distance > halfWidth ? 1 : 0);
  const blended = surface * (1 - blend) + currentHeight * blend;
  if (path.shoulder === 0 || path.falloff === 0) return blended;
  return blended + path.shoulder * gaussian(distance, halfWidth + path.falloff * 0.5, path.falloff * 0.2);
}

/**
 * Carves paths into a height function. Returns { height, maskNames, maskAt(name, x, z), maskImage(name, bounds, resolution) }.
 * height(x, z) is the base height with every path applied in order; maskAt without a name is the strongest of all paths.
 */
export function createTerrainPaths(paths, baseHeight) {
  const normalized = normalizeTerrainPaths(paths);
  const prepared = normalized.map(path => {
    const carveReach = path.width / 2 + path.falloff;
    const maskReach = path.width / 2 + maskFade(path);
    const reach = Math.max(carveReach, maskReach);
    return { path, reach, geometry: prepareSegments(path, reach) };
  });

  function height(pointX, pointZ) {
    let current = baseHeight(pointX, pointZ);
    for (const { path, reach, geometry } of prepared) {
      const nearest = nearestOnPath(geometry, reach, pointX, pointZ);
      if (nearest === null) continue;
      current = carvedHeight(path, nearest.distance, current, baseHeight(nearest.footX, nearest.footZ));
    }
    return current;
  }

  function maskOf({ path, reach, geometry }, pointX, pointZ) {
    const nearest = nearestOnPath(geometry, reach, pointX, pointZ);
    return nearest === null ? 0 : maskValue(path, nearest.distance);
  }

  function maskAt(name, pointX, pointZ) {
    if (name === undefined) return prepared.reduce((strongest, entry) => Math.max(strongest, maskOf(entry, pointX, pointZ)), 0);
    const entry = prepared.find(candidate => candidate.path.name === name);
    if (!entry) throw invalidField('terrain path mask name', name, `one of the path names: ${prepared.map(candidate => candidate.path.name).join(', ') || 'none, the terrain has no paths'}`);
    return maskOf(entry, pointX, pointZ);
  }

  /** RGBA pixels for a splat `maskMap`: the mask in red, row 0 at the smallest z. Pass the same box as `maskBounds`: [minimumX, minimumZ, maximumX, maximumZ]. */
  function maskImage(name, bounds, resolution = TERRAIN_PATH_LIMITS.defaultMaskResolution) {
    const [minimum, maximum] = TERRAIN_PATH_LIMITS.maskResolution;
    if (!Number.isInteger(resolution) || resolution < minimum || resolution > maximum) {
      throw invalidField('maskImage resolution', resolution, `a whole number from ${minimum} to ${maximum}, such as ${TERRAIN_PATH_LIMITS.defaultMaskResolution}`);
    }
    const [minimumX, minimumZ, maximumX, maximumZ] = bounds;
    const data = new Uint8Array(resolution * resolution * 4);
    for (let row = 0; row < resolution; row++) {
      const pointZ = minimumZ + ((row + 0.5) / resolution) * (maximumZ - minimumZ);
      for (let column = 0; column < resolution; column++) {
        const pointX = minimumX + ((column + 0.5) / resolution) * (maximumX - minimumX);
        const offset = (row * resolution + column) * 4;
        data[offset] = Math.round(maskAt(name, pointX, pointZ) * 255);
        data[offset + 3] = 255;
      }
    }
    return { width: resolution, height: resolution, data, bounds: [minimumX, minimumZ, maximumX, maximumZ] };
  }

  return { height, maskNames: normalized.map(path => path.name), maskAt, maskImage };
}
