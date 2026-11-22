// Recipe terrain: a seeded ground (hills, ridged mountains, a warped valley) with optional round holes, built with the terrain addon as one mesh.
// Paths carve roads and emit named masks (terrain-paths.js).
// It loads on demand with the recipes that contain a terrain geometry, so the scene entry does not carry it.
import './world-material-shader.js';
import { mat4 } from 'gl-matrix';
import { createTerrain, TERRAIN_GRID_LIMITS } from './terrain.js';
import { invalidField } from './field-error.js';
import { normalizeTerrainPaths } from './terrain-paths.js';
import { diagnostic } from './agent-diagnostics.js';
import { TERRAIN_DEFAULT_SIZE, TERRAIN_DEFAULT_RESOLUTION, holesCoverWholeGround, holesRemovingNoCell } from './terrain-hole-cells.js';

// A scene allows 250000 vertices by default, so a single chunk of 499 cells (250000 vertices) is the most the recipe can draw.
export const TERRAIN_LIMITS = Object.freeze({
  size: [1, 2000],
  resolution: [2, 499],
  amplitude: [0, 200],
  featureSize: [0.01, 10000],
  octaves: [1, 8],
  warp: [0, 1000],
  mountainAmplitude: [0, 500],
  mountainMask: [0, 1],
  chunks: [1, 64],
  levels: [1, 6],
  // The terrain library samples at most this many cells per side across all chunks (chunks * resolution).
  maximumCellsPerSide: TERRAIN_GRID_LIMITS.cellsPerSide,
  defaultSize: TERRAIN_DEFAULT_SIZE,
  defaultResolution: TERRAIN_DEFAULT_RESOLUTION,
  defaultAmplitude: 1,
  defaultChunks: 1,
  defaultLevels: 1,
  maximumHoles: 16,
  seed: [0, 0x7fffffff],
  defaultSeed: 1,
});

function numberWithin(value, fallback, [minimum, maximum], label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField(`terrain.${label}`, resolved, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

function integerWithin(value, fallback, [minimum, maximum], label) {
  const resolved = numberWithin(value, fallback, [minimum, maximum], label);
  if (!Number.isInteger(resolved)) throw invalidField(`terrain.${label}`, resolved, `a whole number, such as ${fallback}`);
  return resolved;
}

function terrainSeed(value) {
  const [minimum, maximum] = TERRAIN_LIMITS.seed;
  const resolved = value ?? TERRAIN_LIMITS.defaultSeed;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField('terrain.seed', resolved, `a whole number from ${minimum} to ${maximum}, such as ${TERRAIN_LIMITS.defaultSeed}`);
  }
  return resolved;
}

/** An optional field: undefined stays undefined so the terrain library keeps its own default for it. */
function optionalNumber(value, range, label, example) {
  return value === undefined ? undefined : numberWithin(value, example, range, label);
}

function checkShape(value, size, resolution) {
  const chunks = integerWithin(value.chunks, TERRAIN_LIMITS.defaultChunks, TERRAIN_LIMITS.chunks, 'chunks');
  const levels = integerWithin(value.levels, TERRAIN_LIMITS.defaultLevels, TERRAIN_LIMITS.levels, 'levels');
  const divisor = 2 ** (levels - 1);
  if (resolution % divisor !== 0) {
    throw invalidField('terrain.resolution', resolution, `a whole number divisible by ${divisor} (2 to the power levels - 1, levels is ${levels}), such as ${Math.ceil(resolution / divisor) * divisor}, or lower levels`);
  }
  if (chunks * resolution > TERRAIN_LIMITS.maximumCellsPerSide) {
    throw invalidField('terrain.chunks', chunks, `a count whose chunks * resolution (${resolution} cells per chunk) is at most ${TERRAIN_LIMITS.maximumCellsPerSide} cells per side, such as ${Math.floor(TERRAIN_LIMITS.maximumCellsPerSide / resolution)}; lower chunks or resolution`);
  }
  return { chunks, levels };
}

function checkMountains(value) {
  if (value.ridged !== undefined && typeof value.ridged !== 'boolean') {
    throw invalidField('terrain.ridged', value.ridged, 'true or false, such as true');
  }
  const mountainMask = optionalNumber(value.mountainMask, TERRAIN_LIMITS.mountainMask, 'mountainMask', 0.5);
  if (value.ridged === true && mountainMask !== undefined) {
    throw invalidField('terrain.mountainMask', mountainMask, 'nothing when ridged is true, because ridged mountains grow in the patches the terrain library picks; drop one of the two. mountainMask alone sets one share of ridged mountains over the whole ground');
  }
  return { ridged: value.ridged === true, mountainMask };
}

/** The checked fields of a terrain record, with the defaults of a record that sets none of the shape fields. */
function terrainSettings(value) {
  const resolution = integerWithin(value.resolution, TERRAIN_LIMITS.defaultResolution, TERRAIN_LIMITS.resolution, 'resolution');
  const size = numberWithin(value.size, TERRAIN_LIMITS.defaultSize, TERRAIN_LIMITS.size, 'size');
  const amplitude = numberWithin(value.amplitude, TERRAIN_LIMITS.defaultAmplitude, TERRAIN_LIMITS.amplitude, 'amplitude');
  const seed = terrainSeed(value.seed);
  const shape = checkShape(value, size, resolution);
  return {
    size, resolution, amplitude, seed, ...shape, ...checkMountains(value),
    featureSize: numberWithin(value.featureSize, size / 4, TERRAIN_LIMITS.featureSize, 'featureSize'),
    octaves: optionalNumber(integerOctaves(value.octaves), TERRAIN_LIMITS.octaves, 'octaves', 6),
    warp: numberWithin(value.warp, 0, TERRAIN_LIMITS.warp, 'warp'),
    mountainAmplitude: optionalNumber(value.mountainAmplitude, TERRAIN_LIMITS.mountainAmplitude, 'mountainAmplitude', 46),
  };
}

function integerOctaves(octaves) {
  if (octaves !== undefined && !Number.isInteger(octaves)) throw invalidField('terrain.octaves', octaves, 'a whole number from 1 to 8, such as 6');
  return octaves;
}

/** Vertex count of a terrain record at its finest level, checked against the recipe limits before any ground is built. */
export function terrainVertexEstimate(value) {
  const settings = terrainSettings(value);
  if (value.holes !== undefined && (!Array.isArray(value.holes) || value.holes.length > TERRAIN_LIMITS.maximumHoles)) {
    throw invalidField('terrain.holes', value.holes, `a list of at most ${TERRAIN_LIMITS.maximumHoles} circles, such as [{ "center": [0, 0], "radius": 2 }]`);
  }
  value.holes?.forEach(checkHole);
  normalizeTerrainPaths(value.paths);
  checkHolesLeaveGround(value.holes, settings.size, settings.resolution * settings.chunks);
  // Every chunk is its own mesh with its own border vertices.
  return settings.chunks * settings.chunks * (settings.resolution + 1) * (settings.resolution + 1);
}

/** Refuses holes that remove every cell: the terrain would have no surface and could not be exported. */
function checkHolesLeaveGround(holes, size, resolution) {
  if (!holesCoverWholeGround(holes, size, resolution)) return;
  throw invalidField('holes', holes, 'holes that leave some ground; these cover the whole terrain, so no surface would remain. Lower a radius or move a center');
}

function checkHole(hole, index) {
  const center = hole?.center;
  const validCenter = Array.isArray(center) && center.length === 2 && center.every(Number.isFinite);
  if (!validCenter) {
    throw invalidField(`terrain.holes[${index}].center`, center, 'a position [x, z] in metres, such as [0, 0]');
  }
  if (!Number.isFinite(hole.radius) || hole.radius <= 0) {
    throw invalidField(`terrain.holes[${index}].radius`, hole.radius, 'a positive number of metres, such as 2');
  }
}

/** Options of the library's noise height for a record. A field the record leaves out is left out here, so the library default applies. */
function noiseOptions(settings) {
  const options = { amplitude: settings.amplitude, featureSize: settings.featureSize, warp: settings.warp };
  if (settings.octaves !== undefined) options.octaves = settings.octaves;
  if (settings.mountainAmplitude !== undefined) options.mountainAmplitude = settings.mountainAmplitude;
  // Without ridged mountains the mask is 0 everywhere, which is the flat-hills ground every older record has.
  if (!settings.ridged) options.mountainMask = () => settings.mountainMask ?? 0;
  return options;
}

/** The terrain addon object of a terrain record: render parts plus heightAt, isHole and bounds. Vegetation scatters over the same ground. */
export function createRecipeTerrain(value, { lodDistance, eye } = {}) {
  const settings = terrainSettings(value);
  return createTerrain({
    size: settings.size,
    chunks: settings.chunks,
    levels: settings.levels,
    resolution: settings.resolution,
    seed: settings.seed,
    holes: value.holes,
    paths: value.paths,
    height: noiseOptions(settings),
    ...(lodDistance === undefined ? {} : { lodDistance }),
    ...(eye === undefined ? {} : { eye }),
  });
}

function isChunked(value) {
  return (value.chunks ?? 1) > 1 || (value.levels ?? 1) > 1;
}

// Chunks of one terrain as one mesh. Chunks hold their own border vertices, so their indices only move by the vertices before them.
function mergeChunkGeometries(chunkGeometries) {
  const vertexTotal = chunkGeometries.reduce((total, geometry) => total + geometry.positions.length / 3, 0);
  const indexTotal = chunkGeometries.reduce((total, geometry) => total + geometry.indices.length, 0);
  const merged = {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    skyVisibility: new Float32Array(vertexTotal),
    indices: new Uint32Array(indexTotal),
  };
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const geometry of chunkGeometries) {
    merged.positions.set(geometry.positions, vertexOffset * 3);
    merged.normals.set(geometry.normals, vertexOffset * 3);
    merged.uvs.set(geometry.uvs, vertexOffset * 2);
    merged.skyVisibility.set(geometry.skyVisibility, vertexOffset);
    geometry.indices.forEach((index, position) => { merged.indices[indexOffset + position] = index + vertexOffset; });
    vertexOffset += geometry.positions.length / 3;
    indexOffset += geometry.indices.length;
  }
  return merged;
}

const LOD_TERRAIN_CACHE_SIZE = 3;
const lodTerrains = new Map();
const mergedByTerrain = new WeakMap();

/** The chunked terrain of a record, kept between poses: its height grid is the costly part, and a camera move only changes which chunks use which level. */
function cachedTerrain(value, lodDistance) {
  const key = JSON.stringify([value.size, value.resolution, value.seed, value.amplitude, value.holes, value.paths, value.featureSize, value.octaves, value.warp, value.ridged, value.mountainAmplitude, value.mountainMask, value.chunks, value.levels, lodDistance ?? null]);
  let terrain = lodTerrains.get(key);
  if (!terrain) {
    terrain = createRecipeTerrain(value, { lodDistance });
    if (lodTerrains.size >= LOD_TERRAIN_CACHE_SIZE) lodTerrains.delete(lodTerrains.keys().next().value);
  } else {
    lodTerrains.delete(key);
  }
  lodTerrains.set(key, terrain);
  return terrain;
}

// The same mesh object while no chunk changed level, so the renderer sees no topology change between two poses that pick the same levels.
function mergedGeometryOf(terrain) {
  const chunkGeometries = terrain.parts.map(part => part.geometry);
  const previous = mergedByTerrain.get(terrain);
  if (previous && previous.chunkGeometries.every((geometry, index) => geometry === chunkGeometries[index])) return previous.merged;
  const merged = mergeChunkGeometries(chunkGeometries);
  mergedByTerrain.set(terrain, { chunkGeometries, merged });
  return merged;
}

/** Render geometry of a chunked terrain record for a camera at `localEye` (x, y, z in the terrain's own space): each chunk at the level its distance picks, edges stitched. */
export function terrainLodGeometry(value, localEye) {
  const terrain = cachedTerrain(value);
  terrain.update(localEye);
  return mergedGeometryOf(terrain);
}

/** Nodes of a recipe that draw a chunked terrain: their mesh depends on the camera, so every pose picks the level of each chunk again. */
export function terrainLodNodesOf(recipe) {
  const terrains = new Map(recipe.geometries.filter(geometry => geometry.type === 'terrain').map(geometry => [geometry.id, geometry]));
  return recipe.nodes.filter(node => terrains.has(node.geometry) && isChunked(terrains.get(node.geometry)))
    .map(node => ({ nodeId: node.id, materialId: node.material, definition: terrains.get(node.geometry) }));
}

/** The geometry each chunked terrain node draws for a camera at `worldEye`, with the eye taken into the node's own space (a moved or scaled ground sees the camera where it is). A material with wear gets its surface masks on the new geometry. */
export function terrainLodGeometries(lodNodes, graph, worldEye, wearOf, withSurfaceMasks) {
  const geometries = new Map();
  const [eyeX, eyeY, eyeZ] = worldEye;
  for (const { nodeId, materialId, definition } of lodNodes) {
    const inverse = mat4.invert(mat4.create(), graph.getNode(nodeId).worldMatrix);
    if (!inverse) continue;
    const localEye = [
      inverse[0] * eyeX + inverse[4] * eyeY + inverse[8] * eyeZ + inverse[12],
      inverse[1] * eyeX + inverse[5] * eyeY + inverse[9] * eyeZ + inverse[13],
      inverse[2] * eyeX + inverse[6] * eyeY + inverse[10] * eyeZ + inverse[14],
    ];
    const geometry = terrainLodGeometry(definition, localEye);
    const wear = wearOf(materialId);
    geometries.set(nodeId, wear ? withSurfaceMasks(geometry, wear, nodeId) : geometry);
  }
  return geometries;
}

/** True for a terrain record whose mesh changes with the camera: more than one chunk or more than one level. */
export function terrainUsesLod(value) {
  return isChunked(value);
}

function tooManyVerticesAdvice(value, vertices, maxVertices) {
  if (!isChunked(value)) return `a resolution whose ${vertices} vertices fit maxVertices ${maxVertices}; lower it`;
  return `a resolution (cells per chunk, with chunks ${value.chunks ?? 1}) whose ${vertices} vertices fit maxVertices ${maxVertices}; lower resolution or chunks`;
}

/** Render geometry of a terrain record: ground from -size / 2 to size / 2 on X and Z, hills of the given amplitude, holes cut out. A chunked record is built at its finest level; the scene swaps in the level for the camera at each pose. */
export function generateTerrainGeometry(value, maxVertices) {
  const vertices = terrainVertexEstimate(value);
  if (vertices > maxVertices) throw invalidField('terrain.resolution', value.resolution ?? TERRAIN_LIMITS.defaultResolution, tooManyVerticesAdvice(value, vertices, maxVertices));
  if (!isChunked(value)) return createRecipeTerrain(value).parts[0].geometry;
  // A level-0 distance past the whole ground keeps every chunk at the finest mesh.
  const finest = cachedTerrain(value, (value.size ?? TERRAIN_LIMITS.defaultSize) * 4);
  return mergedGeometryOf(finest);
}

/** Warnings for holes of a terrain record that remove no ground cell, so the terrain looks as if it had no hole. */
export function terrainHoleDiagnostics(geometry) {
  return holesRemovingNoCell(geometry).map(({ index, cellSize, smallestRadius }) => diagnostic('terrain-hole-removes-no-cell', 'warning',
    `${geometry.id}.holes[${index}]`,
    `Hole ${index} of terrain ${geometry.id} removes no ground cell, so it changes nothing: cells are ${cellSize} m wide and a hole removes a cell only when it reaches the cell's centre.`,
    `Raise radius above ${smallestRadius} (the smallest that removes a cell here), move center onto a cell centre, or raise the terrain resolution.`));
}
