import { CLOSED_ROOM_SHARE, partMatrixLookup } from './closed-room.js';
import { fittedClosedRoomShare, fittedRoomHasWalls } from './fitted-closed-room.js';
import { drainSteps } from './flush-search-runner.js';
import { buildWorldSteps, cosineDirection, radicalInverse, sceneScale } from './light-bake.js';
import { worldBounds } from './probe-trace.js';
import { createTracer } from './ray-query.js';
import { partDiffuseAlbedo } from './ground-bounce.js';
import { buildOccupancyGrid, createSkyProxy, geometrySkyVisibility } from './sky-voxel-proxy.js';

// The sunlit patches' lights (src/sun-bounce.js) load with the floor sky trace: both are for a closed room a sun lights.
export { withSunBounce } from './sun-bounce.js';

// Sky visibility traced from the texels of the floor itself. A floor part is cut into small triangles, every vertex shoots
// cosine-weighted rays up into the scene's other parts, and the share that escapes goes into the geometry's `skyVisibility`,
// which the shader already multiplies into the light the world gives that surface. A narrow street or a hall then darkens
// where its walls and roofs hide the sky, and open ground stays as it was. It adds no shader code and nothing to the core
// entry; the cost is one trace when the parts are prepared, not per frame.

export const FLOOR_SKY_RAYS = 64;
export const FLOOR_SKY_MAXIMUM_TEXELS = 24_000;
export const FLOOR_SKY_MAXIMUM_SECONDS = 20;
// A total ray budget besides the clock: dense props are traced vertex by vertex, and about two seconds of rays is the most a scene may ask for.
export const FLOOR_SKY_MAXIMUM_RAYS = 6_000_000;
// Both faces and the edges of every slab are traced when the whole room is, so its cut is coarser than a floor's: about a quarter of the vertices for the same area.
const ROOM_SURFACE_EDGE_SCALE = 2.8;
export const FLOOR_SKY_STRENGTH = 1;
// How much of the sky the grid hides on every surface of an open scene (#2771).
export const OPEN_SCENE_GRID_STRENGTH = 1;
// With onlyClosedRooms the default is lower: a hall also gets light that comes back from its walls and sunlit floor, which a sky trace does not hold.
export const FLOOR_SKY_ROOM_STRENGTH = 0.2;
// A closed room's walls, ceiling and props are traced too (#1334): the raster gave every one of them the whole sky, so a sealed room came out bright.
export const ROOM_SURFACE_SKY_STRENGTH = 1;
// Upper bound on the interior fill: a room cannot bounce back more of the sky than it lets in.
export const INTERIOR_FILL_MAXIMUM = 0.5;
// Fitted against the path tracer on the window room (bench/reference/interior-exposure.mjs): the bounce series alone leaves the raster below the tracer.
export const INTERIOR_FILL_GAIN = 4;

/**
 * The share of the open sky's light that a closed room's surfaces get back from each other (#1334). `openShare` is the mean share of
 * cosine rays from the room's surfaces that escape (a window is a small share), `meanAlbedo` the area-weighted diffuse albedo of the
 * room. Light that enters bounces: the first bounce keeps albedo x openShare of it and each later bounce keeps albedo x
 * (1 - openShare), a geometric series. A sealed room (nothing escapes) gets 0.
 */
export function interiorSkyFill(openShare, meanAlbedo) {
  if (!(openShare > 0) || !(meanAlbedo > 0)) return 0;
  const albedo = Math.min(meanAlbedo, 0.95);
  const open = Math.min(openShare, 1);
  return Math.min(INTERIOR_FILL_MAXIMUM, (INTERIOR_FILL_GAIN * albedo * open) / (1 - albedo * (1 - open)));
}

// The hue of the daylit ambient light that the shader's sky term gives a surface (blue-white). The fill is bounced light, so it has
// the room's albedo hue, and dividing that by this hue makes the shader's blue ambient come out as the bounce colour. Fitted on the window room.
export const INTERIOR_SKY_HUE = Object.freeze([0.82, 1, 1.75]);
// How much of the fill a point loses where its rays meet a surface close by (a corner or a wall/floor junction): the fill is spread over the points so its room-wide mean stays the same.
export const INTERIOR_CORNER_FALLOFF = 0.4;
// "Close by" is this share of the room's smallest span.
export const INTERIOR_NEAR_SPAN_SHARE = 0.15;

const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];

/**
 * The colour factor that gives the fill the hue of the light a room bounces: the area-weighted mean albedo of its surfaces over the
 * daylight hue, scaled to the same luminance so the tint moves hue only, never the level. Neutral albedo gives a factor that undoes
 * the blue of the sky term.
 */
export function interiorFillTint(meanAlbedo) {
  const raw = meanAlbedo.map((value, channel) => Math.max(value, 0.01) / INTERIOR_SKY_HUE[channel]);
  const luminance = raw.reduce((total, value, channel) => total + value * LUMINANCE_WEIGHTS[channel], 0);
  return raw.map(value => value / luminance);
}

/** How strongly a point is lit by the fill relative to the room mean: 1 in the open, lower the more of its rays meet a surface close by. */
export function interiorCornerWeight(nearShare) {
  return Math.max(0, 1 - INTERIOR_CORNER_FALLOFF * nearShare);
}

// A traced point sees the room from inside when at most this share of its rays escape; the outer face of a wall (about half, the ground hides the rest) and the lawn see the sky and are not part of the room.
const INTERIOR_MAXIMUM_ESCAPE = 0.25;

function isInteriorVertex(escapedShare) {
  return escapedShare <= INTERIOR_MAXIMUM_ESCAPE;
}

/**
 * The fill for the traced parts of a closed room: `openShare` is what the room opens to the sky (1 minus the closed-room ray share); the mean albedo is taken over the points that see
 * the room from inside (the cut gives every part about the same area per point), and only those points get the fill.
 * The fill is scaled by `interiorCornerWeight` (less in corners and at junctions) and tinted by `interiorFillTint` through the vertex
 * colour, in proportion to the share of the point's light that is fill and not at all where the sun reaches the point.
 * Each traced part is `{ skyVisibility, escapedShares, nearShares, sunlit, colors, tracedVertices, albedo }`; their `skyVisibility` and `colors` are changed in place.
 */
function applyInteriorFill(tracedParts, openShare) {
  let count = 0;
  const albedoTotal = [0, 0, 0];
  for (const { escapedShares, tracedVertices, albedo, levelOfPart = false } of tracedParts) {
    if (levelOfPart) continue;
    for (const vertex of tracedVertices) {
      if (!isInteriorVertex(escapedShares[vertex])) continue;
      count++;
      for (let channel = 0; channel < 3; channel++) albedoTotal[channel] += albedo[channel];
    }
  }
  if (count === 0) return 0;
  const meanAlbedo = albedoTotal.map(total => total / count);
  const fill = interiorSkyFill(openShare, (meanAlbedo[0] + meanAlbedo[1] + meanAlbedo[2]) / 3);
  const tint = interiorFillTint(meanAlbedo);
  for (const { skyVisibility, escapedShares, nearShares, sunlit, colors, tracedVertices } of tracedParts) {
    for (const vertex of tracedVertices) {
      if (!isInteriorVertex(escapedShares[vertex])) continue;
      const pointFill = fill * interiorCornerWeight(nearShares[vertex]);
      const lifted = Math.min(1, skyVisibility[vertex] + pointFill);
      const fillShare = sunlit[vertex] || lifted === 0 ? 0 : (lifted - skyVisibility[vertex]) / lifted;
      skyVisibility[vertex] = lifted;
      for (let channel = 0; channel < 3; channel++) colors[vertex * 3 + channel] *= 1 + fillShare * (tint[channel] - 1);
    }
  }
  return fill;
}

const FLOOR_THINNESS = 0.1;
const FLOOR_MINIMUM_FOOTPRINT_SHARE = 0.02;
const UPWARD_NORMAL = 0.7;
const FLOOR_MINIMUM_UPWARD_SHARE = 0.3;
const WELD_SCALE = 1e5;
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke', 'floor', 'water', 'foliage', 'grass', 'terrain']);
const FIXED_ROTATION = 0.37;

function sceneBoundsOf(boundsList) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
    }
  }
  return { minimum, maximum };
}

function hasPlainMesh(part) {
  const { geometry } = part;
  const rigid = !part.skin && !part.morph && !part.crowd && !geometry.morphTargets && !geometry.skinIndices && !geometry.crowdJoints;
  const carriesLight = geometry.skyVisibility || geometry.lightUvs || part.material?.lightMap;
  return rigid && !carriesLight && Boolean(geometry.normals) && geometry.indices.length > 0;
}

function isFloorMaterial(material) {
  return !material || (!['blend', 'add', 'mask'].includes(material.alphaMode) && !(material.transmission > 0) && !EXCLUDED_TAGS.has(material.tag));
}

// The share of a part's triangle area whose world normal points up: a slab with a roof and a floor side counts half.
function upwardAreaShare(part) {
  const { positions, indices } = part.geometry;
  let upward = 0;
  let total = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const triangle = [indices[corner], indices[corner + 1], indices[corner + 2]];
    const [first, second, third] = triangle.map(vertex => transformPoint(part.matrix, positions, vertex));
    const edgeOne = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
    const edgeTwo = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
    const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const doubleArea = Math.hypot(...normal);
    total += doubleArea;
    if (doubleArea > 0 && normal[1] / doubleArea >= UPWARD_NORMAL) upward += doubleArea;
  }
  return total > 0 ? upward / total : 0;
}

// The world area of a part's triangles, to size the cut of every surface of a room.
function worldSurfaceArea(part) {
  const { positions, indices } = part.geometry;
  let doubleArea = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(slot => transformPoint(part.matrix, positions, indices[corner + slot]));
    const edgeOne = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
    const edgeTwo = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
    doubleArea += Math.hypot(edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]);
  }
  return doubleArea / 2;
}

function transformPoint(matrix, positions, vertex) {
  const x = positions[vertex * 3];
  const y = positions[vertex * 3 + 1];
  const z = positions[vertex * 3 + 2];
  return [0, 1, 2].map(axis => matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis]);
}

/** Which parts are floors: thin, wide, opaque and plain, with a good share of their area facing up. Returns the indices. */
export function findFloorParts(parts) {
  const boundsList = parts.map(part => worldBounds(part));
  const scene = sceneBoundsOf(boundsList);
  const sceneFootprint = (scene.maximum[0] - scene.minimum[0]) * (scene.maximum[2] - scene.minimum[2]);
  const floors = [];
  parts.forEach((part, index) => {
    const bounds = boundsList[index];
    const widthX = bounds.maximum[0] - bounds.minimum[0];
    const widthZ = bounds.maximum[2] - bounds.minimum[2];
    const height = bounds.maximum[1] - bounds.minimum[1];
    const isThin = height <= FLOOR_THINNESS * Math.max(widthX, widthZ);
    const isWide = widthX * widthZ >= FLOOR_MINIMUM_FOOTPRINT_SHARE * sceneFootprint;
    if (isThin && isWide && isFloorMaterial(part.material) && hasPlainMesh(part) && upwardAreaShare(part) >= FLOOR_MINIMUM_UPWARD_SHARE) floors.push(index);
  });
  return floors;
}

function transformDirection(matrix, x, y, z, out) {
  for (let axis = 0; axis < 3; axis++) out[axis] = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z;
  return out;
}

function worldEdgeLength(matrix, positions, first, second) {
  const edge = transformDirection(matrix, positions[second * 3] - positions[first * 3], positions[second * 3 + 1] - positions[first * 3 + 1], positions[second * 3 + 2] - positions[first * 3 + 2], [0, 0, 0]);
  return Math.hypot(edge[0], edge[1], edge[2]);
}

// The part's mesh as growing arrays, with vertices shared by position, normal, UV and colour so the cut stays connected.
function createMeshBuilder(geometry) {
  const hasUvs = Boolean(geometry.uvs);
  const hasColors = Boolean(geometry.colors);
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const welded = new Map();
  function addVertex(position, normal, uv, color) {
    const key = [...position, ...normal, ...(uv ?? []), ...(color ?? [])].map(value => Math.round(value * WELD_SCALE)).join(',');
    if (!welded.has(key)) {
      welded.set(key, positions.length / 3);
      positions.push(...position);
      normals.push(...normal);
      if (hasUvs) uvs.push(...uv);
      if (hasColors) colors.push(...color);
    }
    return welded.get(key);
  }
  function readVertex(index) {
    return {
      position: [geometry.positions[index * 3], geometry.positions[index * 3 + 1], geometry.positions[index * 3 + 2]],
      normal: [geometry.normals[index * 3], geometry.normals[index * 3 + 1], geometry.normals[index * 3 + 2]],
      uv: hasUvs ? [geometry.uvs[index * 2], geometry.uvs[index * 2 + 1]] : null,
      color: hasColors ? [geometry.colors[index * 3], geometry.colors[index * 3 + 1], geometry.colors[index * 3 + 2]] : null,
    };
  }
  function midpoint(first, second) {
    const average = (left, right) => (left && right ? left.map((value, slot) => (value + right[slot]) / 2) : null);
    const normal = average(first.normal, second.normal);
    const length = Math.hypot(...normal) || 1;
    return { position: average(first.position, second.position), normal: normal.map(value => value / length), uv: average(first.uv, second.uv), color: average(first.color, second.color) };
  }
  return { positions, normals, uvs, colors, addVertex, readVertex, midpoint, hasUvs, hasColors };
}

function worldNormalOf(matrix, positions, corners) {
  const [first, second, third] = corners.map(corner => [positions[corner * 3], positions[corner * 3 + 1], positions[corner * 3 + 2]]);
  const edgeOne = transformDirection(matrix, second[0] - first[0], second[1] - first[1], second[2] - first[2], [0, 0, 0]);
  const edgeTwo = transformDirection(matrix, third[0] - first[0], third[1] - first[1], third[2] - first[2], [0, 0, 0]);
  const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
  const length = Math.hypot(...normal) || 1;
  return normal.map(value => value / length);
}

// Vertices, triangles or cut pieces the cut goes through between two checkpoints of a trace run in slices (#3052).
const CUT_ITEMS_PER_CHECKPOINT = 1000;

/**
 * Cuts the upward-facing triangles of a geometry (every triangle with `onlyUpward` false), by their longest edge while a world edge is longer than `maximumEdge`,
 * and leaves the others as they are. Returns the new arrays and which vertices belong to a cut triangle.
 */
function* cutGeometrySteps(geometry, matrix, maximumEdge, onlyUpward, checkpoint) {
  let itemsSinceCheckpoint = 0;
  const builder = createMeshBuilder(geometry);
  const indices = [];
  const tracedVertices = new Set();
  const midpoints = new Map();
  const sourceIndex = vertexData => builder.addVertex(vertexData.position, vertexData.normal, vertexData.uv, vertexData.color);
  const inputVertices = [];
  for (let index = 0; index < geometry.positions.length / 3; index++) {
    inputVertices.push(builder.readVertex(index));
    if (++itemsSinceCheckpoint === CUT_ITEMS_PER_CHECKPOINT) {
      itemsSinceCheckpoint = 0;
      yield* checkpoint();
    }
  }
  const cutWork = [];
  for (let corner = 0; corner < geometry.indices.length; corner += 3) {
    if (++itemsSinceCheckpoint === CUT_ITEMS_PER_CHECKPOINT) {
      itemsSinceCheckpoint = 0;
      yield* checkpoint();
    }
    const triangle = [0, 1, 2].map(slot => geometry.indices[corner + slot]);
    const normal = worldNormalOf(matrix, geometry.positions, triangle);
    if (!onlyUpward || normal[1] >= UPWARD_NORMAL) {
      cutWork.push(triangle.map(vertexIndex => inputVertices[vertexIndex]));
    } else {
      indices.push(...triangle.map(vertexIndex => sourceIndex(inputVertices[vertexIndex])));
    }
  }
  const lengthBetween = (first, second) => worldEdgeLength(matrix, [...first.position, ...second.position], 0, 1);
  while (cutWork.length > 0) {
    if (++itemsSinceCheckpoint === CUT_ITEMS_PER_CHECKPOINT) {
      itemsSinceCheckpoint = 0;
      yield* checkpoint();
    }
    const corners = cutWork.pop();
    const edgeLengths = [lengthBetween(corners[0], corners[1]), lengthBetween(corners[1], corners[2]), lengthBetween(corners[2], corners[0])];
    const longest = edgeLengths.indexOf(Math.max(...edgeLengths));
    if (edgeLengths[longest] <= maximumEdge) {
      const added = corners.map(sourceIndex);
      indices.push(...added);
      added.forEach(vertex => tracedVertices.add(vertex));
      continue;
    }
    const first = corners[longest];
    const second = corners[(longest + 1) % 3];
    const opposite = corners[(longest + 2) % 3];
    const key = [first, second].map(vertexData => sourceIndex(vertexData)).sort((left, right) => left - right).join('|');
    if (!midpoints.has(key)) midpoints.set(key, builder.midpoint(first, second));
    const middle = midpoints.get(key);
    cutWork.push([first, middle, opposite], [middle, second, opposite]);
  }
  return { builder, indices, tracedVertices };
}

// A trace of the surfaces near a point stops at this distance: `INTERIOR_NEAR_SPAN_SHARE` of the smallest span of the parts.
function nearDistanceOf(parts, partIndices) {
  const { minimum, maximum } = sceneBoundsOf(partIndices.map(index => worldBounds(parts[index])));
  return INTERIOR_NEAR_SPAN_SHARE * Math.min(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]);
}

// True when the sun reaches the point: its light keeps the colour it has, so the fill's tint leaves the point alone.
function seesSun(tracer, point, normal, offset, sunDirection) {
  if (normal[0] * sunDirection[0] + normal[1] * sunDirection[1] + normal[2] * sunDirection[2] <= 0) return false;
  return tracer.trace(point[0] + normal[0] * offset, point[1] + normal[1] * offset, point[2] + normal[2] * offset, sunDirection[0], sunDirection[1], sunDirection[2], Infinity, true).nearestTriangle < 0;
}

// Directions that no wall or floor lines up with, so a point on a face is never tested along that face.
const BURIAL_DIRECTIONS = [[0.3713, 0.8123, 0.4521], [-0.6431, 0.2917, 0.7102]].map(raw => {
  const length = Math.hypot(...raw);
  return raw.map(value => value / length);
});

function triangleSeenFromBehind(world, triangle, direction) {
  const [first, second, third] = [0, 1, 2].map(slot => world.indices[triangle * 3 + slot] * 3);
  const { positions } = world;
  const edgeOne = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
  const edgeTwo = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
  const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
  return normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0;
}

/**
 * True when the point lies inside a solid: along one of a few fixed directions, or its opposite, the first surface met is seen from
 * behind. Touching boxes share their faces, so one direction can stop at the neighbour's face from outside; any direction that
 * leaves through the back of a surface is enough. A wall's end or a floor's rim that runs into the wall beside it is buried this way,
 * and its traced value is meaningless: the triangles around it are large, so it would smear a bright share onto the visible face (#2166).
 */
function isBuried(tracer, world, point) {
  for (const base of BURIAL_DIRECTIONS) {
    for (const sign of [1, -1]) {
      const direction = base.map(value => value * sign);
      const hit = tracer.trace(point[0], point[1], point[2], direction[0], direction[1], direction[2], Infinity, false);
      if (hit.nearestTriangle >= 0 && triangleSeenFromBehind(world, hit.nearestTriangle, direction)) return true;
    }
  }
  return false;
}

// The mean of the triangle centres around each vertex, in the part's own space: a vertex on the rim of a face moves toward its own face from there.
function incidentCentres(positions, indices, vertexCount) {
  const sums = new Float64Array(vertexCount * 3);
  const counts = new Uint32Array(vertexCount);
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const centre = (positions[indices[corner] * 3 + axis] + positions[indices[corner + 1] * 3 + axis] + positions[indices[corner + 2] * 3 + axis]) / 3;
      for (let slot = 0; slot < 3; slot++) sums[indices[corner + slot] * 3 + axis] += centre;
    }
    for (let slot = 0; slot < 3; slot++) counts[indices[corner + slot]]++;
  }
  return { sums, counts };
}

// The vertex moved a little off its face and toward the middle of its own triangles, so a vertex exactly on another part's face is tested inside that part.
function isBuriedInside(tracer, world, point, worldNormal, offset, centres, vertex, matrix) {
  const count = centres.counts[vertex] || 1;
  const local = [0, 1, 2].map(axis => centres.sums[vertex * 3 + axis] / count);
  const middle = [0, 1, 2].map(axis => matrix[axis] * local[0] + matrix[4 + axis] * local[1] + matrix[8 + axis] * local[2] + matrix[12 + axis]);
  const toMiddle = [0, 1, 2].map(axis => middle[axis] - point[axis]);
  const length = Math.hypot(...toMiddle) || 1;
  const probe = [0, 1, 2].map(axis => point[axis] + worldNormal[axis] * offset + (toMiddle[axis] / length) * offset * 2);
  return isBuried(tracer, world, probe);
}

function fixedSamples(sampleCount) {
  return Array.from({ length: sampleCount }, (unused, sample) => [(sample + 0.5) / sampleCount, (radicalInverse(sample) + FIXED_ROTATION) % 1]);
}

// A geometry with sky visibility and, for a closed room, a colour per vertex (white where it had none) for the fill's tint.
function geometryWithSky(geometry, skyVisibility, needsColors) {
  const next = { ...geometry, skyVisibility };
  if (needsColors) next.colors = geometry.colors ? new Float32Array(geometry.colors) : new Float32Array(skyVisibility.length * 3).fill(1);
  return next;
}

function allVertices(count) {
  return Array.from({ length: count }, (unused, index) => index);
}

// What the room opens to the sky, measured: the mean share of the grid's cosine rays that escape, over the points of every part (#2771).
// The triangle trace passes 1 minus the closed-room ray share, fitted on a window room; a scanned room with large windows reads as
// closed there (Classroom: 0.02) and its fill came out a fifth of what its walls bounce back.
function measuredOpenShare(tracedParts) {
  let total = 0;
  let count = 0;
  for (const { escapedShares, levelOfPart = false } of tracedParts) {
    if (levelOfPart) continue;
    for (let vertex = 0; vertex < escapedShares.length; vertex++) total += escapedShares[vertex];
    count += escapedShares.length;
  }
  return count ? total / count : 0;
}

/**
 * The sky trace through the occupancy grid of src/sky-voxel-proxy.js, for a scene the triangle trace cannot take: more
 * triangles than the bake allows or more rays than the budget (#2771). The meshes are not cut; every vertex of the traced
 * parts, and of each level of their `lods`, reads the grid's value for its cell and normal, so the cost follows the scene's
 * size and not its triangle count. `report.method` is 'proxy' and `report.fallbackReason` says why the triangle trace was
 * left. Buried points and the sunlit test are not available here: every interior point takes the fill.
 */
function applyProxySkyVisibility({ parts, occluders, floorIndices, everySurface, everyPart = false, strength, roomShare, started }, fallbackReason) {
  const grid = buildOccupancyGrid(occluders);
  const proxy = createSkyProxy(grid);
  const tracedIndices = everyPart ? parts.map((part, index) => index).filter(index => isFloorMaterial(parts[index].material) && hasPlainMesh(parts[index])) : everySurface ? parts.map((part, index) => index).filter(index => floorIndices.includes(index) || (isFloorMaterial(parts[index].material) && hasPlainMesh(parts[index]))) : floorIndices;
  const nextParts = parts.slice();
  const floors = [];
  const tracedParts = [];
  const finish = reason => ({ parts, report: { floors: [], texels: 0, rays: proxy.rays, seconds: (performance.now() - started) / 1000, method: 'proxy', fallbackReason, reason } });
  for (const index of tracedIndices) {
    const part = parts[index];
    const albedo = partDiffuseAlbedo(part.material ?? {});
    const levels = part.lods ?? [{ geometry: part.geometry }];
    const nextLevels = [];
    for (const [levelIndex, level] of levels.entries()) {
      const escaped = geometrySkyVisibility(proxy, level.geometry, part.matrix, 1);
      if (escaped === null) return finish('sky proxy budget spent');
      const skyVisibility = escaped.map(share => 1 - strength * (1 - share));
      const geometry = Object.freeze(geometryWithSky(level.geometry, skyVisibility, everySurface));
      nextLevels.push({ ...level, geometry });
      const vertexCount = skyVisibility.length;
      const floor = levelIndex === 0 ? { name: part.name, texels: vertexCount, triangles: level.geometry.indices.length / 3, meanVisibility: 1 } : null;
      if (floor) floors.push(floor);
      tracedParts.push({ floor, skyVisibility, escapedShares: escaped, nearShares: new Float32Array(vertexCount), sunlit: new Uint8Array(vertexCount), colors: geometry.colors, tracedVertices: allVertices(vertexCount), albedo, levelOfPart: levelIndex > 0 });
    }
    const [levelZero] = nextLevels;
    nextParts[index] = Object.freeze(part.lods ? { ...part, geometry: levelZero.geometry, lods: nextLevels } : { ...part, geometry: levelZero.geometry });
  }
  const interiorFill = everySurface ? applyInteriorFill(tracedParts, measuredOpenShare(tracedParts)) : 0;
  for (const { floor, skyVisibility } of tracedParts) {
    if (!floor) continue;
    let sum = 0;
    for (const value of skyVisibility) sum += value;
    floor.meanVisibility = skyVisibility.length ? sum / skyVisibility.length : 1;
  }
  const texels = floors.reduce((total, floor) => total + floor.texels, 0);
  const meanVisibility = texels ? floors.reduce((total, floor) => total + floor.meanVisibility * floor.texels, 0) / texels : 1;
  return { parts: Object.freeze(nextParts), report: { floors, texels, meanVisibility, interiorFill, rays: proxy.rays, seconds: (performance.now() - started) / 1000, method: 'proxy', fallbackReason, cellSize: grid.cellSize, reason: null } };
}

/**
 * Returns `{ parts, report }`: the parts with their floors cut into texels and given `geometry.skyVisibility`, traced by
 * `raysPerTexel` cosine-weighted rays against every other opaque part. `strength` 1 uses the traced share as it is, 0.5 only
 * half of what it hides. A closed room (the closed-room ray test) comes back unchanged unless `includeClosedRooms` is set. The parts come back unchanged (and `report.reason` says why) when the scene has no floor
 * or the trace passes `maxSeconds`. A scene larger than the bake's triangle limit, or one that needs more than `maximumRays`,
 * comes back unchanged with `report.fallbackReason` saying which limit it met, or with `largeScenes: 'proxy'` is traced
 * through the occupancy grid instead (`report.method` 'proxy'). It reads no clock to decide anything else, and
 * the rays are a fixed set, so the same scene gives the same bytes.
 */
export function applyFloorSkyVisibility(parts, options = {}) {
  return drainSteps(applyFloorSkyVisibilitySteps(parts, options));
}

// Vertices traced between two checkpoints of a trace run in slices (#3052): a vertex is a few hundred rays.
const VERTICES_PER_CHECKPOINT = 4;

/** applyFloorSkyVisibility as steps (#3052): the same answer, with a checkpoint every few vertices. The time limit does not count the pauses between slices. */
export function* applyFloorSkyVisibilitySteps(parts, { raysPerTexel = FLOOR_SKY_RAYS, maximumTexels = FLOOR_SKY_MAXIMUM_TEXELS, maxSeconds = FLOOR_SKY_MAXIMUM_SECONDS, maximumRays = FLOOR_SKY_MAXIMUM_RAYS, strength: requestedStrength, includeClosedRooms = false, onlyClosedRooms = false, surfaces = 'floors', sunDirection = null, largeScenes = 'skip', openScenes = 'skip' } = {}) {
  if (openScenes !== 'skip' && openScenes !== 'proxy') throw new RangeError(`openScenes must be 'skip' or 'proxy', got ${openScenes}`);
  if (largeScenes !== 'skip' && largeScenes !== 'proxy') throw new RangeError(`largeScenes must be 'skip' or 'proxy', got ${largeScenes}`);
  let started = performance.now();
  function* checkpoint() {
    const pausedAt = performance.now();
    yield;
    started += performance.now() - pausedAt;
  }
  const unchanged = (reason, fallbackReason = null) => ({ parts, report: { floors: [], texels: 0, rays: 0, seconds: (performance.now() - started) / 1000, method: null, fallbackReason, reason } });
  // A scene the triangle trace cannot take is left as it is ('skip', the default: the grid alone darkened the classroom against Cycles, #2771) or traced through the grid ('proxy').
  const tooLarge = (reason, detail) => (largeScenes === 'proxy' ? applyProxySkyVisibility(proxyInput, detail) : unchanged(reason, detail));
  let proxyInput = null;
  const floorIndices = findFloorParts(parts);
  if (floorIndices.length === 0) return unchanged('no floor');
  yield* checkpoint();
  // Every opaque part blocks sky, floors included: a floor above another one (a gallery, a bridge) hides it, and a floor never
  // blocks its own texels because the rays leave from its top face.
  const occluders = parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode));
  if (occluders.length < 2) return unchanged('nothing above the floor');
  // A closed room has no sky to see: its walls and lamps give the light, and the shader's room term already handles it.
  // The fitted test leaves out a lawn beside the room and heavy props, as the sun bounce does.
  yield* checkpoint();
  const roomShare = fittedClosedRoomShare(parts, partMatrixLookup(parts));
  yield* checkpoint();
  const closedRoom = roomShare !== null && roomShare >= CLOSED_ROOM_SHARE;
  if (closedRoom && !includeClosedRooms && !onlyClosedRooms) return unchanged('closed room');
  // Open ground gets light back from sunlit facades and streets that a sky trace does not hold, so it comes out too dark.
  if (onlyClosedRooms && !closedRoom) {
    if (openScenes === 'skip') return unchanged('open scene');
    return applyProxySkyVisibility({ parts, occluders, floorIndices, everySurface: false, everyPart: true, strength: requestedStrength ?? OPEN_SCENE_GRID_STRENGTH, roomShare, started }, 'open scene');
  }
  // The walls, ceiling and props are traced as well only in a room that has walls all round: a roof on columns reads as closed to the ray test above, but its floor keeps the light it had.
  const everySurface = surfaces === 'all' && closedRoom && fittedRoomHasWalls(parts, partMatrixLookup(parts));
  yield* checkpoint();
  const strength = requestedStrength ?? (onlyClosedRooms ? (everySurface ? ROOM_SURFACE_SKY_STRENGTH : FLOOR_SKY_ROOM_STRENGTH) : FLOOR_SKY_STRENGTH);
  // With every surface, every face of every part is cut (a ceiling slab counts as a floor, so its room side needs the cut too).
  const cutPartIndices = everySurface ? parts.map((part, index) => index).filter(index => floorIndices.includes(index) || (isFloorMaterial(parts[index].material) && hasPlainMesh(parts[index]))) : floorIndices;
  proxyInput = { parts, occluders, floorIndices, everySurface, strength, roomShare, started };
  let world;
  try {
    world = yield* buildWorldSteps(occluders);
  } catch (error) {
    // Only the bake's size limit sends the scene to the grid; any other error is a bug and must surface (#2771).
    if (!(error instanceof RangeError)) throw error;
    return tooLarge('too many triangles', error.message);
  }
  const footprint = cutPartIndices.reduce((total, index) => {
    if (everySurface) return total + worldSurfaceArea(parts[index]);
    const bounds = worldBounds(parts[index]);
    return total + (bounds.maximum[0] - bounds.minimum[0]) * (bounds.maximum[2] - bounds.minimum[2]);
  }, 0);
  const maximumEdge = Math.sqrt(footprint / maximumTexels) * (everySurface ? ROOM_SURFACE_EDGE_SCALE : 1.4);
  const tracer = createTracer(world);
  const offset = sceneScale(world.positions) * 1e-4;
  const samples = fixedSamples(raysPerTexel);
  const direction = [0, 0, 0];
  const worldNormal = [0, 0, 0];
  const nearDistance = everySurface ? nearDistanceOf(parts, cutPartIndices) : 0;
  const floors = [];
  let totalRays = 0;
  const tracedParts = [];
  const nextParts = parts.slice();
  for (const index of cutPartIndices) {
    const part = parts[index];
    const { geometry, matrix } = part;
    const { builder, indices, tracedVertices } = yield* cutGeometrySteps(geometry, matrix, maximumEdge, !everySurface, checkpoint);
    if (totalRays + tracedVertices.size * raysPerTexel > maximumRays) return tooLarge('too many rays', `more than ${maximumRays} rays for ${cutPartIndices.length} parts`);
    const vertexCount = builder.positions.length / 3;
    const skyVisibility = new Float32Array(vertexCount).fill(1);
    const escapedShares = new Float32Array(vertexCount);
    const nearShares = new Float32Array(vertexCount);
    const sunlit = new Uint8Array(vertexCount);
    const centres = everySurface ? incidentCentres(builder.positions, indices, vertexCount) : null;
    let verticesSinceCheckpoint = 0;
    for (const vertex of tracedVertices) {
      if (performance.now() - started > maxSeconds * 1000) return unchanged('passed maxSeconds');
      if (++verticesSinceCheckpoint === VERTICES_PER_CHECKPOINT) {
        verticesSinceCheckpoint = 0;
        yield* checkpoint();
      }
      const local = builder.positions.slice(vertex * 3, vertex * 3 + 3);
      const point = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) point[axis] = matrix[axis] * local[0] + matrix[4 + axis] * local[1] + matrix[8 + axis] * local[2] + matrix[12 + axis];
      transformDirection(matrix, builder.normals[vertex * 3], builder.normals[vertex * 3 + 1], builder.normals[vertex * 3 + 2], worldNormal);
      const length = Math.hypot(...worldNormal) || 1;
      worldNormal[0] /= length;
      worldNormal[1] /= length;
      worldNormal[2] /= length;
      if (centres && isBuriedInside(tracer, world, point, worldNormal, offset, centres, vertex, matrix)) {
        skyVisibility[vertex] = 1 - strength;
        continue;
      }
      let escaped = 0;
      let near = 0;
      for (const [firstUnit, secondUnit] of samples) {
        cosineDirection(worldNormal, firstUnit, secondUnit, direction);
        const hit = tracer.trace(point[0] + worldNormal[0] * offset, point[1] + worldNormal[1] * offset, point[2] + worldNormal[2] * offset, direction[0], direction[1], direction[2], Infinity, true);
        if (hit.nearestTriangle < 0) escaped++;
        else if (everySurface && tracer.trace(point[0] + worldNormal[0] * offset, point[1] + worldNormal[1] * offset, point[2] + worldNormal[2] * offset, direction[0], direction[1], direction[2], nearDistance, true).nearestTriangle >= 0) near++;
      }
      nearShares[vertex] = near / raysPerTexel;
      if (everySurface && sunDirection && isInteriorVertex(escaped / raysPerTexel)) sunlit[vertex] = seesSun(tracer, point, worldNormal, offset, sunDirection) ? 1 : 0;
      skyVisibility[vertex] = 1 - strength * (1 - escaped / raysPerTexel);
      escapedShares[vertex] = escaped / raysPerTexel;
      totalRays += raysPerTexel;
    }
    const cutGeometryResult = {
      ...geometry,
      positions: new Float32Array(builder.positions),
      normals: new Float32Array(builder.normals),
      indices: new Uint32Array(indices),
      skyVisibility,
    };
    if (builder.hasUvs) cutGeometryResult.uvs = new Float32Array(builder.uvs);
    if (builder.hasColors) cutGeometryResult.colors = new Float32Array(builder.colors);
    // The fill tints the colour of a closed room's points, so every part of one carries a colour (white where it had none).
    if (everySurface && !builder.hasColors) cutGeometryResult.colors = new Float32Array(vertexCount * 3).fill(1);
    nextParts[index] = Object.freeze({ ...part, geometry: Object.freeze(cutGeometryResult) });
    const floor = { name: part.name, texels: tracedVertices.size, triangles: indices.length / 3, meanVisibility: 1 };
    floors.push(floor);
    const albedo = partDiffuseAlbedo(part.material ?? {});
    tracedParts.push({ floor, skyVisibility, escapedShares, nearShares, sunlit, colors: cutGeometryResult.colors, tracedVertices, albedo });
    yield* checkpoint();
  }
  // A closed room also gets the sky light its surfaces bounce on to each other (#1334): without it every point the window cannot see is as dark as a sealed room.
  const interiorFill = everySurface ? applyInteriorFill(tracedParts, 1 - roomShare) : 0;
  for (const { floor, skyVisibility, tracedVertices } of tracedParts) {
    let sharedSum = 0;
    for (const vertex of tracedVertices) sharedSum += skyVisibility[vertex];
    floor.meanVisibility = tracedVertices.size ? sharedSum / tracedVertices.size : 1;
  }
  const texels = floors.reduce((total, floor) => total + floor.texels, 0);
  const meanVisibility = texels ? floors.reduce((total, floor) => total + floor.meanVisibility * floor.texels, 0) / texels : 1;
  return { parts: Object.freeze(nextParts), report: { floors, texels, meanVisibility, interiorFill, rays: totalRays, seconds: (performance.now() - started) / 1000, method: 'triangles', fallbackReason: null, reason: null } };
}

/** True when the environment has a sun: a key light with a colour and intensity above zero. A recipe that sets neither has the default sun. */
export function environmentHasSun(environment) {
  const keyColor = environment?.keyColor ?? [1, 1, 1];
  return (environment?.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]) > 0;
}

function unitSunDirection(environment) {
  const direction = environment?.lightDirection;
  if (!direction) return null;
  const length = Math.hypot(...direction);
  return length > 0 ? direction.map(component => component / length) : null;
}

/**
 * The default for a scene: a closed room a sun lights gets the sky trace at `FLOOR_SKY_ROOM_STRENGTH`, and every other scene (open ground,
 * a room lit by lamps alone) comes back unchanged, because the trace made those worse against Cycles. `environment.floorSkyTrace: false`
 * turns it off. The recipe path (`createAgentScene`) and the reference harness both call this, so they draw the same frame.
 */
export function applyDefaultFloorSky(parts, environment, options = {}) {
  return drainSteps(applyDefaultFloorSkySteps(parts, environment, options));
}

/** applyDefaultFloorSky as steps (#3052). */
export function* applyDefaultFloorSkySteps(parts, environment, options = {}) {
  if (environment?.floorSkyTrace === false || !environmentHasSun(environment)) return { parts, report: null };
  return yield* applyFloorSkyVisibilitySteps(parts, { onlyClosedRooms: true, surfaces: 'all', sunDirection: unitSunDirection(environment), ...options });
}

// Kept per parts list and per what the default reads from the environment (the sun's strength and direction), not per
// environment object: an edit that never touches the environment still hands the scene a new copy of it (#2806).
const DEFAULT_RESULTS_PER_PARTS = 8;
const defaultResults = new WeakMap();

function skyInputsKey(environment) {
  return JSON.stringify([environmentHasSun(environment), unitSunDirection(environment)]);
}

// A retained part keeps the matrix it was drawn with until the commit writes the new pose into it, so a moved node is still
// where it was while its scene is staged. The room test and the sky rays need it where it is going (#3064).
function partsAtMatrices(parts, worldMatrixOf) {
  const matrices = parts.map(part => Float32Array.from(worldMatrixOf(part.name)));
  const moved = parts.some((part, index) => matrices[index].some((value, element) => value !== part.matrix[element]));
  const views = moved ? parts.map((part, index) => ({ ...part, matrix: matrices[index] })) : parts;
  return { views, matrices };
}

function sameMatrices(first, second) {
  return first.length === second.length && first.every((matrix, index) => matrix.every((value, element) => value === second[index][element]));
}

// Hands each part of the result back its own matrix array, which the commit keeps writing the pose into.
function withOwnMatrices(resultParts, views, parts) {
  const ownerOfName = new Map(parts.map(part => [part.name, part]));
  const indexOfView = new Map(views.map((view, index) => [view, index]));
  return resultParts.map(result => {
    if (indexOfView.has(result)) return parts[indexOfView.get(result)];
    const owner = ownerOfName.get(result.name);
    return owner && result.matrix !== owner.matrix ? Object.freeze({ ...result, matrix: owner.matrix }) : result;
  });
}

/** The recipe path's call: the default for these parts, this environment and the matrices they are drawn at, kept until one is replaced. */
export function stageFloorSky(environment, parts, worldMatrixOf) {
  return drainSteps(stageFloorSkySteps(environment, parts, worldMatrixOf));
}

/** stageFloorSky as steps (#3052): a settling bake runs it in slices ahead of the scene's own call, which then finds the kept result. */
export function* stageFloorSkySteps(environment, parts, worldMatrixOf) {
  if (environment.floorSkyTrace === false) return parts;
  const { views, matrices } = partsAtMatrices(parts, worldMatrixOf);
  let bySun = defaultResults.get(parts);
  if (!bySun) {
    bySun = new Map();
    defaultResults.set(parts, bySun);
  }
  const sunKey = skyInputsKey(environment);
  const kept = bySun.get(sunKey);
  if (kept && sameMatrices(kept.matrices, matrices)) return kept.result;
  const traced = (yield* applyDefaultFloorSkySteps(views, environment)).parts;
  const result = traced === views ? parts : Object.freeze(withOwnMatrices(traced, views, parts));
  if (bySun.size >= DEFAULT_RESULTS_PER_PARTS) bySun.delete(bySun.keys().next().value);
  bySun.set(sunKey, { matrices, result });
  return result;
}
