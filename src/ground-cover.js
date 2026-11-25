// Grass on named surfaces of a GLB scene file: `environment.groundCover` in scene.json lists entries, each growing the
// seeded grass of src/grass.js over the upward faces of the parts it names. Blades skip any spot where another part
// stands within the blade length above the surface (a path, a slab laid on the lawn).

import { createGrass, GRASS_PRESETS } from './grass.js';

export const GROUND_COVER_LIMITS = Object.freeze({ maxEntries: 8, maxBlades: 2_000_000, maxSurfaceTriangles: 1_000_000 });

const ENTRY_FIELDS = ['surfaces', 'preset', 'density', 'length', 'color', 'wind', 'seed'];
const UPWARD_NORMAL = 0.3;
const SLAB_SKIN = 0.01;
const EDGE_MARGIN = 0.04;
const CELLS_PER_SIDE = 128;
// The farthest level of detail keeps this share of the blades, so no field can have fewer than area * density * this.
const FARTHEST_KEEP = 0.12;

function groundCoverError(path, got, expected) {
  return new TypeError(`environment.groundCover${path} is ${got}; pass ${expected}.`);
}

function requireRange(path, value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw groundCoverError(path, JSON.stringify(value), `a number from ${minimum} to ${maximum}`);
  }
}

function normalizeEntry(entry, index) {
  const path = `[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw groundCoverError(path, JSON.stringify(entry), 'an object such as { "surfaces": "Lawn", "length": 0.1 }');
  const unknown = Object.keys(entry).filter(field => !ENTRY_FIELDS.includes(field));
  if (unknown.length) throw groundCoverError(`${path}.${unknown[0]}`, 'not a field', `one of ${ENTRY_FIELDS.join(', ')}`);
  const surfaces = typeof entry.surfaces === 'string' ? [entry.surfaces] : entry.surfaces;
  if (!Array.isArray(surfaces) || !surfaces.length || !surfaces.every(name => typeof name === 'string' && name)) {
    throw groundCoverError(`${path}.surfaces`, JSON.stringify(entry.surfaces), 'a node or material name, or a list of them');
  }
  const preset = entry.preset ?? 'lawn';
  if (!GRASS_PRESETS[preset]) throw groundCoverError(`${path}.preset`, JSON.stringify(preset), `one of ${Object.keys(GRASS_PRESETS).join(', ')}`);
  if (entry.density !== undefined) requireRange(`${path}.density`, entry.density, 1, 5000);
  if (entry.length !== undefined) requireRange(`${path}.length`, entry.length, 0.01, 2);
  if (entry.wind !== undefined) requireRange(`${path}.wind`, entry.wind, 0, 1);
  if (entry.seed !== undefined) requireRange(`${path}.seed`, entry.seed, 0, 2 ** 31 - 1);
  const color = entry.color ?? 'preset';
  const isColour = Array.isArray(color) && color.length === 3 && color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1);
  if (color !== 'preset' && color !== 'surface' && !isColour) {
    throw groundCoverError(`${path}.color`, JSON.stringify(color), '"preset", "surface" (the surface material colour) or three linear RGB numbers from 0 to 1');
  }
  const windScale = entry.wind ?? 1;
  return { surfaces, preset, density: entry.density, length: entry.length, color, wind: entry.wind ?? 1, windScale, seed: entry.seed ?? 1 };
}

/** Checks `environment.groundCover` and returns its entries with defaults filled in; no field means no grass. */
export function normalizeGroundCover(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GROUND_COVER_LIMITS.maxEntries) {
    throw groundCoverError('', JSON.stringify(value)?.slice(0, 60), `a list of at most ${GROUND_COVER_LIMITS.maxEntries} entries`);
  }
  return value.map(normalizeEntry);
}

function worldTriangles(part) {
  const { positions, indices } = part.geometry;
  const matrix = part.matrix;
  const world = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    const x = positions[vertex];
    const y = positions[vertex + 1];
    const z = positions[vertex + 2];
    world[vertex] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    world[vertex + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    world[vertex + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  const triangles = [];
  const corners = indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, index) => index);
  for (let corner = 0; corner + 2 < corners.length; corner += 3) {
    const first = corners[corner] * 3;
    const second = corners[corner + 1] * 3;
    const third = corners[corner + 2] * 3;
    triangles.push([world[first], world[first + 1], world[first + 2], world[second], world[second + 1], world[second + 2], world[third], world[third + 1], world[third + 2]]);
  }
  return triangles;
}

// Height of a triangle's plane at (x, z), or null when (x, z) is outside it or the triangle stands edge-on.
function heightInTriangle(triangle, x, z) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangle;
  const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(determinant) < 1e-12) return null;
  const weightA = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / determinant;
  const weightB = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / determinant;
  const weightC = 1 - weightA - weightB;
  if (weightA < 0 || weightB < 0 || weightC < 0) return null;
  return weightA * ay + weightB * by + weightC * cy;
}

/** Triangles bucketed on a square grid over x and z, so a height query reads a few triangles instead of all of them. */
function createTriangleGrid(triangles, area) {
  const cellSize = Math.max(area.maxX - area.minX, area.maxZ - area.minZ) / CELLS_PER_SIDE || 1;
  const buckets = new Map();
  const keyOf = (column, row) => column * 65536 + row;
  const cellOf = (value, origin) => Math.floor((value - origin) / cellSize);
  for (const triangle of triangles) {
    const xs = [triangle[0], triangle[3], triangle[6]];
    const zs = [triangle[2], triangle[5], triangle[8]];
    for (let column = cellOf(Math.min(...xs), area.minX); column <= cellOf(Math.max(...xs), area.minX); column++) {
      for (let row = cellOf(Math.min(...zs), area.minZ); row <= cellOf(Math.max(...zs), area.minZ); row++) {
        const key = keyOf(column, row);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(triangle);
      }
    }
  }
  return { at: (x, z) => buckets.get(keyOf(cellOf(x, area.minX), cellOf(z, area.minZ))) ?? [] };
}

// A face whose normal points up; vertical walls and undersides do not carry grass.
function isUpward([ax, ay, az, bx, by, bz, cx, cy, cz]) {
  const edgeX = [bx - ax, by - ay, bz - az];
  const edgeY = [cx - ax, cy - ay, cz - az];
  const normal = [edgeX[1] * edgeY[2] - edgeX[2] * edgeY[1], edgeX[2] * edgeY[0] - edgeX[0] * edgeY[2], edgeX[0] * edgeY[1] - edgeX[1] * edgeY[0]];
  const length = Math.hypot(...normal);
  return length > 0 && normal[1] / length > UPWARD_NORMAL;
}

function matchingParts(parts, names) {
  const wanted = new Set(names);
  return parts.filter(part => wanted.has(part.name) || wanted.has(part.label) || wanted.has(part.material?.name));
}

function areaOf(triangles) {
  const area = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const triangle of triangles) {
    for (const corner of [0, 3, 6]) {
      area.minX = Math.min(area.minX, triangle[corner]);
      area.maxX = Math.max(area.maxX, triangle[corner]);
      area.minZ = Math.min(area.minZ, triangle[corner + 2]);
      area.maxZ = Math.max(area.maxZ, triangle[corner + 2]);
    }
  }
  return area;
}

function surfaceColours(entry, surfaceParts) {
  if (entry.color === 'preset') return {};
  const tip = entry.color === 'surface' ? surfaceParts[0].material.color : entry.color;
  return { tip, base: tip.map(channel => channel * 0.2), dry: tip.map(channel => Math.min(1, channel * 1.6 + 0.04)) };
}

// The fewest blades a field can have, so a field past the budget is refused before any tile is grown.
function fewestBlades(area, density) {
  return (area.maxX - area.minX) * (area.maxZ - area.minZ) * density * FARTHEST_KEEP;
}

function findSurface(entry, index, parts) {
  const surfaceParts = matchingParts(parts, entry.surfaces);
  if (!surfaceParts.length) {
    const known = [...new Set(parts.flatMap(part => [part.name, part.material?.name]).filter(Boolean))].slice(0, 12);
    throw groundCoverError(`[${index}].surfaces`, JSON.stringify(entry.surfaces), `names of nodes or materials in the GLB; it has ${known.join(', ') || 'no named parts'}`);
  }
  const surfaceTriangles = surfaceParts.flatMap(worldTriangles).filter(isUpward);
  if (!surfaceTriangles.length || surfaceTriangles.length > GROUND_COVER_LIMITS.maxSurfaceTriangles) {
    throw groundCoverError(`[${index}].surfaces`, `${surfaceTriangles.length} upward triangles`, `surfaces with 1 to ${GROUND_COVER_LIMITS.maxSurfaceTriangles} upward triangles`);
  }
  return { surfaceParts, surfaceTriangles, area: areaOf(surfaceTriangles) };
}

function growEntry(entry, surface, parts, eye) {
  const { surfaceParts, surfaceTriangles, area } = surface;
  const surfaceSet = new Set(surfaceParts);
  const surfaceGrid = createTriangleGrid(surfaceTriangles, area);
  const standing = createTriangleGrid(parts.filter(part => !surfaceSet.has(part) && part.material?.tag !== 'grass').flatMap(worldTriangles), area);
  const surfaceHeight = (x, z) => {
    let top = null;
    for (const triangle of surfaceGrid.at(x, z)) {
      const height = heightInTriangle(triangle, x, z);
      if (height !== null && (top === null || height > top)) top = height;
    }
    return top;
  };
  const preset = GRASS_PRESETS[entry.preset];
  const length = entry.length ?? preset.height[1];
  const covered = (x, z, ground) => standing.at(x, z).some(triangle => {
    const height = heightInTriangle(triangle, x, z);
    return height !== null && height > ground - SLAB_SKIN && height < ground + length;
  });
  const mask = (x, z) => {
    const ground = surfaceHeight(x, z);
    if (ground === null) return 0;
    const probes = [[0, 0], [EDGE_MARGIN, 0], [-EDGE_MARGIN, 0], [0, EDGE_MARGIN], [0, -EDGE_MARGIN]];
    return probes.some(([offsetX, offsetZ]) => covered(x + offsetX, z + offsetZ, ground)) ? 0 : 1;
  };
  const grass = createGrass({
    preset: entry.preset, area, seed: entry.seed, density: entry.density, eye,
    height: [length * 0.6, length], cullDistance: Infinity, windScale: entry.windScale,
    terrainHeight: (x, z) => surfaceHeight(x, z) ?? 0, mask,
    ...surfaceColours(entry, surfaceParts),
  });
  return grass.parts;
}

/**
 * Grass parts for the entries of `environment.groundCover`, grown over the named surfaces of `parts` and placed to join them.
 * The field is seeded and built once for `eye` (default: above the middle of the first surface), so every frame of a shot and
 * every rerender draws the same blades. Throws before the first frame when a name matches nothing or the blades would pass
 * the budget.
 */
export function groundCoverParts(parts, entries, eye) {
  const surfaces = entries.map((entry, index) => findSurface(entry, index, parts));
  const fewest = surfaces.reduce((total, surface, index) => total + fewestBlades(surface.area, entries[index].density ?? GRASS_PRESETS[entries[index].preset].density), 0);
  requireBladeBudget(fewest);
  const grown = entries.flatMap((entry, index) => growEntry(entry, surfaces[index], parts, eye));
  requireBladeBudget(grown.reduce((total, part) => total + part.bladeCount, 0));
  return grown;
}

function requireBladeBudget(blades) {
  if (blades > GROUND_COVER_LIMITS.maxBlades) {
    throw groundCoverError('', `${Math.round(blades)} blades in all entries`, `at most ${GROUND_COVER_LIMITS.maxBlades} blades: lower density or name smaller surfaces`);
  }
}
