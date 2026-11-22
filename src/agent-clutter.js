import { mat4 } from 'gl-matrix';
import { createClutter, CLUTTER_PRESETS } from './clutter.js';
import { createRecipeTerrain } from './agent-terrain.js';
import { invalidField } from './field-error.js';

// Recipe clutter: a group node with a `clutter` field scatters pebbles, rocks, twigs and fallen leaves over a terrain node
// or a flat area. It calls `createClutter` from the clutter addon with the terrain's own `heightAt`, so the recipe path and
// an addon user get the same stones for the same options. Like vegetation, the result travels the placed-asset channel of
// agent-scene.js (generated geometries of type "asset", materials flagged assetSource and part nodes with assetPart), so
// exports and edits skip it. Levels of detail come from the recipe camera at each edit, never from the frame being drawn.

export const CLUTTER_LIMITS = Object.freeze({
  maxLayers: 4, maxExclusions: 32, maxMaskShapes: 8, maxArea: 40000, maxItems: 120000, maxCachedSets: 8,
});
const LAYER_FIELDS = ['preset', 'terrain', 'area', 'density', 'seed', 'mask', 'exclude', 'slopeLimit', 'cullDistance'];
const SHAPE_FIELDS = ['center', 'radius', 'min', 'max', 'feather'];
const EXCLUSION_FIELDS = ['center', 'radius', 'min', 'max', 'node'];
const ITEM_KINDS = ['pebbles', 'rocks', 'twigs', 'leaves'];
const GROUND_EDGE_MARGIN = 0.5;
const DEFAULT_GROUND_SIZE = 40;
const SLOPE_STEP = 0.25;
const PART_NAME = /^Clutter (pebbles|rocks|litter) (\d+),(\d+)$/;

function knownKeys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
  }
}

function numberWithin(value, minimum, maximum, path) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

function planePoint(value, path) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(component => !Number.isFinite(component))) {
    throw invalidField(path, value, '[x, z] in metres, such as [0, 0]', TypeError);
  }
  return [...value];
}

function boxCorners(value, path) {
  const min = planePoint(value.min, `${path}.min`);
  const max = planePoint(value.max, `${path}.max`);
  if (max[0] <= min[0] || max[1] <= min[1]) throw invalidField(`${path}.max`, max, `[x, z] above min ${JSON.stringify(min)} on both axes`);
  return { min, max };
}

function normalizeMaskShape(value, path) {
  knownKeys(value, SHAPE_FIELDS, path);
  const result = value.min !== undefined || value.max !== undefined
    ? boxCorners(value, path)
    : { center: planePoint(value.center, `${path}.center`), radius: numberWithin(value.radius, 0.01, 2000, `${path}.radius`) };
  if (result.min && (value.center !== undefined || value.radius !== undefined)) {
    throw invalidField(path, value, 'either the box form "min", "max" or the circle form "center", "radius", not both');
  }
  result.feather = numberWithin(value.feather ?? 0, 0, 1000, `${path}.feather`);
  return result;
}

function normalizeExclusion(value, path) {
  knownKeys(value, EXCLUSION_FIELDS, path);
  if (value.min !== undefined || value.max !== undefined) {
    if (value.center !== undefined || value.radius !== undefined || value.node !== undefined) {
      throw invalidField(path, value, 'either the box form "min", "max" or the circle form "center", "radius", not both');
    }
    return boxCorners(value, path);
  }
  const radius = numberWithin(value.radius, 0.01, 2000, `${path}.radius`);
  if (value.node !== undefined) {
    if (typeof value.node !== 'string' || !value.node) throw invalidField(`${path}.node`, value.node, 'a node ID, such as "pond"', TypeError);
    return { node: value.node, radius };
  }
  return { center: planePoint(value.center, `${path}.center`), radius };
}

function normalizeList(value, maximum, path, example, normalizeEntry) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidField(path, Array.isArray(value) ? `${value.length} entries` : value, `a list of at most ${maximum} entries, such as ${example}`);
  }
  return value.map((entry, index) => normalizeEntry(entry, `${path}[${index}]`));
}

function normalizeLayer(value, path) {
  knownKeys(value, LAYER_FIELDS, path);
  if (value.terrain === undefined && value.area === undefined) {
    throw invalidField(`${path}.terrain`, value.terrain, 'the ID of a terrain node, such as "ground", or an area { "min": [-5, -5], "max": [5, 5] } for flat ground');
  }
  const preset = value.preset ?? 'meadow';
  if (!CLUTTER_PRESETS[preset]) throw invalidField(`${path}.preset`, preset, `one of ${Object.keys(CLUTTER_PRESETS).join(', ')}`);
  const result = {
    preset,
    density: numberWithin(value.density ?? 1, 0.01, 4, `${path}.density`),
    seed: numberWithin(value.seed ?? 1, -2147483648, 2147483647, `${path}.seed`),
    slopeLimit: numberWithin(value.slopeLimit ?? 40, 0, 90, `${path}.slopeLimit`),
    cullDistance: numberWithin(value.cullDistance ?? 40, 5, 100, `${path}.cullDistance`),
    mask: value.mask === undefined ? [] : normalizeList(value.mask, CLUTTER_LIMITS.maxMaskShapes, `${path}.mask`, '[{ "center": [0, 0], "radius": 6, "feather": 2 }]', normalizeMaskShape),
    exclude: value.exclude === undefined ? [] : normalizeList(value.exclude, CLUTTER_LIMITS.maxExclusions, `${path}.exclude`, '[{ "center": [0, 0], "radius": 5 }]', normalizeExclusion),
  };
  if (value.terrain !== undefined) {
    if (typeof value.terrain !== 'string' || !value.terrain) throw invalidField(`${path}.terrain`, value.terrain, 'the ID of a terrain node, such as "ground"', TypeError);
    result.terrain = value.terrain;
  }
  if (value.area !== undefined) {
    knownKeys(value.area, ['min', 'max'], `${path}.area`);
    result.area = boxCorners(value.area, `${path}.area`);
  }
  return result;
}

/** Validate the `clutter` field of a node (`node` is the whole node, which must be a group). Returns the canonical list kept in the recipe. */
export function normalizeClutter(value, node) {
  const conflict = node && ['geometry', 'skin', 'asset', 'vegetation'].find(field => node[field] !== undefined);
  if (conflict) {
    throw invalidField(conflict, node[conflict], 'nothing, because a node that scatters clutter is a group; drop geometry, material, skin, asset and vegetation', TypeError);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > CLUTTER_LIMITS.maxLayers) {
    throw invalidField('clutter', Array.isArray(value) ? `${value.length} layers` : value, `a list of 1 to ${CLUTTER_LIMITS.maxLayers} layers, such as [{ "preset": "forest", "terrain": "ground" }]`, TypeError);
  }
  return value.map((layer, index) => normalizeLayer(layer, `clutter[${index}]`));
}

function nodeWorldMatrix(nodes, node) {
  const byId = new Map(nodes.map(candidate => [candidate.id, candidate]));
  let matrix = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
  let parent = node.parent === null ? null : byId.get(node.parent);
  for (let depth = 0; parent && depth < 256; depth++) {
    const local = mat4.fromRotationTranslationScale(mat4.create(), parent.rotation, parent.translation, parent.scale);
    matrix = mat4.multiply(mat4.create(), local, matrix);
    parent = parent.parent === null ? null : byId.get(parent.parent);
  }
  return matrix;
}

function groundOf(recipe, layer, path) {
  if (layer.terrain === undefined) return null;
  const ground = recipe.nodes.find(node => node.id === layer.terrain);
  const definition = ground && recipe.geometries.find(geometry => geometry.id === ground.geometry);
  if (definition?.type !== 'terrain') {
    throw invalidField(`${path}.terrain`, layer.terrain, 'the ID of a node that draws a terrain geometry, such as "ground"; give the group node the same transform as the ground');
  }
  return { definition, terrain: createRecipeTerrain(definition) };
}

function layerArea(layer, ground, path) {
  const half = ground ? (ground.definition.size ?? DEFAULT_GROUND_SIZE) / 2 - GROUND_EDGE_MARGIN : Infinity;
  const area = layer.area ?? { min: [-half, -half], max: [half, half] };
  const clamped = {
    minX: Math.max(area.min[0], -half), maxX: Math.min(area.max[0], half),
    minZ: Math.max(area.min[1], -half), maxZ: Math.min(area.max[1], half),
  };
  if (clamped.maxX <= clamped.minX || clamped.maxZ <= clamped.minZ) {
    throw invalidField(`${path}.area`, layer.area, `an area that overlaps the ground, which spans ${-half} to ${half} on x and z`);
  }
  return clamped;
}

function checkBudget(layer, area, path) {
  const size = (area.maxX - area.minX) * (area.maxZ - area.minZ);
  if (size > CLUTTER_LIMITS.maxArea) {
    throw invalidField(`${path}.area`, `${Math.round(size)} square metres`, `an area of at most ${CLUTTER_LIMITS.maxArea} square metres, such as 100 by 100 metres; split a larger floor into several layers`);
  }
  const rate = ITEM_KINDS.reduce((total, kind) => total + CLUTTER_PRESETS[layer.preset][kind], 0) * layer.density;
  const reach = Math.min(size, Math.PI * layer.cullDistance ** 2);
  if (rate * reach > CLUTTER_LIMITS.maxItems) {
    throw invalidField(`${path}.density`, layer.density, `a density that keeps the items within cullDistance under ${CLUTTER_LIMITS.maxItems} (this plans about ${Math.round(rate * reach)}); lower density or cullDistance, or give a smaller area`);
  }
}

// The [x, z] of a node in the group's own space, which is where the area, mask and exclusions are measured.
function planePositionInGroup(recipe, groupNode, nodeId) {
  const target = recipe.nodes.find(node => node.id === nodeId);
  const inGroup = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), nodeWorldMatrix(recipe.nodes, groupNode)), nodeWorldMatrix(recipe.nodes, target));
  return [inGroup[12], inGroup[14]];
}

function distanceOutsideBox(x, z, box) {
  return Math.hypot(Math.max(box.min[0] - x, 0, x - box.max[0]), Math.max(box.min[1] - z, 0, z - box.max[1]));
}

function maskCoverage(shapes) {
  if (shapes.length === 0) return () => 1;
  return (x, z) => {
    let best = 0;
    for (const shape of shapes) {
      const outside = shape.min ? distanceOutsideBox(x, z, shape) : Math.max(Math.hypot(x - shape.center[0], z - shape.center[1]) - shape.radius, 0);
      const coverage = outside === 0 ? 1 : shape.feather > 0 ? Math.max(1 - outside / shape.feather, 0) : 0;
      best = Math.max(best, coverage);
    }
    return best;
  };
}

function exclusionTest(recipe, groupNode, layer, path) {
  const areas = layer.exclude.map((entry, index) => {
    if (entry.min) return (x, z) => x >= entry.min[0] && x <= entry.max[0] && z >= entry.min[1] && z <= entry.max[1];
    let center = entry.center;
    if (entry.node) {
      if (!recipe.nodes.some(node => node.id === entry.node)) throw invalidField(`${path}.exclude[${index}].node`, entry.node, 'the ID of a node in the recipe, such as "pond"');
      center = planePositionInGroup(recipe, groupNode, entry.node);
    }
    return (x, z) => Math.hypot(x - center[0], z - center[1]) <= entry.radius;
  });
  return (x, z) => areas.some(test => test(x, z));
}

function steepness(terrainHeight, x, z) {
  const slopeX = terrainHeight(x + SLOPE_STEP, z) - terrainHeight(x - SLOPE_STEP, z);
  const slopeZ = terrainHeight(x, z + SLOPE_STEP) - terrainHeight(x, z - SLOPE_STEP);
  return Math.atan(Math.hypot(slopeX, slopeZ) / (2 * SLOPE_STEP)) * 180 / Math.PI;
}

/** The options `createClutter` gets for one layer: the same call an addon user makes, so both give the same stones. */
export function clutterOptionsFor(recipe, groupNode, layer, path = 'clutter[0]') {
  const ground = groundOf(recipe, layer, path);
  const area = layerArea(layer, ground, path);
  checkBudget(layer, area, path);
  const terrainHeight = ground ? ground.terrain.heightAt : () => 0;
  const covered = maskCoverage(layer.mask);
  const excluded = exclusionTest(recipe, groupNode, layer, path);
  const mask = (x, z) => {
    if (excluded(x, z) || (ground && ground.terrain.isHole(x, z))) return 0;
    if (ground && steepness(terrainHeight, x, z) > layer.slopeLimit) return 0;
    return covered(x, z);
  };
  const preset = CLUTTER_PRESETS[layer.preset];
  const densities = Object.fromEntries(ITEM_KINDS.map(kind => [kind, preset[kind] * layer.density]));
  return { preset: layer.preset, area, terrainHeight, mask, seed: layer.seed, cullDistance: layer.cullDistance, ...densities };
}

function eyeInGroup(recipe, groupNode) {
  const eye = recipe.camera?.eye ?? [0, 0, 0];
  const inverse = mat4.invert(mat4.create(), nodeWorldMatrix(recipe.nodes, groupNode));
  return [
    inverse[0] * eye[0] + inverse[4] * eye[1] + inverse[8] * eye[2] + inverse[12],
    inverse[1] * eye[0] + inverse[5] * eye[1] + inverse[9] * eye[2] + inverse[13],
    inverse[2] * eye[0] + inverse[6] * eye[1] + inverse[10] * eye[2] + inverse[14],
  ];
}

function groundDefinition(recipe, layer) {
  const ground = recipe.nodes.find(node => node.id === layer.terrain);
  return recipe.geometries.find(geometry => geometry.id === ground?.geometry) ?? null;
}

// What a scatter depends on besides the camera: the layer, its ground record and where named exclusions stand.
function cacheKey(recipe, groupNode, layer, eye) {
  const named = layer.exclude.filter(entry => entry.node && recipe.nodes.some(node => node.id === entry.node)).map(entry => planePositionInGroup(recipe, groupNode, entry.node));
  return `clutter:${JSON.stringify([layer, groundDefinition(recipe, layer), named, eye])}`;
}

function materialJson(material) {
  return {
    tag: 'surface', color: [...material.color], metallic: material.metallic ?? 0, roughness: material.roughness ?? 0.5,
    emission: material.emission ?? 0, opacity: 1, alphaMode: 'opaque', doubleSided: Boolean(material.doubleSided),
  };
}

function growLayer(recipe, groupNode, layer, path, eye, cache) {
  const key = cacheKey(recipe, groupNode, layer, eye);
  if (!cache.has(key)) {
    // The scene shares this map with its placed assets, so only grown sets are evicted.
    const grownKeys = [...cache.keys()].filter(candidate => candidate.startsWith('clutter:'));
    if (grownKeys.length >= CLUTTER_LIMITS.maxCachedSets) cache.delete(grownKeys[0]);
    const clutter = createClutter({ ...clutterOptionsFor(recipe, groupNode, layer, path), eye });
    cache.set(key, { serial: ++cache.serial, clutter, geometryIds: new Map(), outputs: new Map() });
  }
  return cache.get(key);
}

// Add the generated geometry, material and part node of one clutter tile part to the recipe and the runtime maps.
// Ids are stable per cached set, but each stage starts from a fresh recipe, so the runtime maps say what is already added.
function addPart(recipe, runtime, generatedNodes, entry, groupNode, layerIndex, part) {
  const [, kind, column, row] = PART_NAME.exec(part.name);
  if (!entry.geometryIds.has(part.geometry)) entry.geometryIds.set(part.geometry, `clutter:${entry.serial}:${entry.geometryIds.size}`);
  const geometryId = entry.geometryIds.get(part.geometry);
  if (!runtime.geometryParts.has(geometryId)) {
    recipe.geometries.push({ id: geometryId, type: 'asset', clutter: entry.serial });
    runtime.geometryParts.set(geometryId, part.geometry);
  }
  const materialId = `clutter:${entry.serial}:${kind}`;
  if (!entry.outputs.has(materialId)) entry.outputs.set(materialId, Object.freeze({ ...part.material }));
  if (!runtime.materialOutputs.has(materialId)) {
    runtime.materialOutputs.set(materialId, entry.outputs.get(materialId));
    recipe.materials.push({ id: materialId, ...materialJson(entry.outputs.get(materialId)), assetSource: true });
  }
  const partNodeId = `${groupNode.id}/${layerIndex}/${kind}-${column}-${row}`;
  generatedNodes.push({
    id: partNodeId, parent: groupNode.id, label: `clutter ${kind}`,
    translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    geometry: geometryId, material: materialId,
    assetPart: { placement: groupNode.id, index: Number(column) * 4096 + Number(row), matrix: Array.from(part.matrix) },
  });
  runtime.partExtras.set(partNodeId, { group: groupNode.id, castShadow: part.castShadow === true });
}

function layerReport(entry, groupNode, layerIndex, layer) {
  const stats = entry.clutter.stats();
  return {
    node: groupNode.id, layer: layerIndex, preset: layer.preset, items: stats.items, tiles: stats.visibleTiles, levels: stats.levelCounts,
    triangles: stats.triangles, geometryBytes: stats.geometryBytes,
  };
}

/**
 * Generate the geometries, materials and part nodes of every clutter node into a normalized recipe, in place.
 * `cache` (the scene's asset output map) keeps built tiles across edits, so a material or node edit does not scatter again.
 * Returns the placed runtime with the clutter maps added, and a report for scene_inspect.
 */
export function expandClutter(recipe, limits, cache, placedRuntime) {
  cache.serial ??= 0;
  const runtime = { geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map(), report: [] };
  const generatedNodes = [];
  const scattering = recipe.nodes.filter(node => node.clutter);
  const layerCount = scattering.reduce((total, node) => total + node.clutter.length, 0);
  if (layerCount > CLUTTER_LIMITS.maxLayers) {
    throw invalidField('clutter', `${layerCount} layers across ${scattering.length} nodes`, `at most ${CLUTTER_LIMITS.maxLayers} layers in the whole recipe; merge layers or drop a node's clutter`);
  }
  for (const groupNode of scattering) {
    const eye = eyeInGroup(recipe, groupNode);
    groupNode.clutter.forEach((layer, layerIndex) => {
      const entry = growLayer(recipe, groupNode, layer, `clutter[${layerIndex}]`, eye, cache);
      for (const part of entry.clutter.parts) addPart(recipe, runtime, generatedNodes, entry, groupNode, layerIndex, part);
      runtime.report.push(layerReport(entry, groupNode, layerIndex, layer));
    });
  }
  if (recipe.nodes.length + generatedNodes.length > limits.maxNodes) {
    throw invalidField('clutter[].cullDistance', `${generatedNodes.length} generated part nodes`, `a cullDistance that keeps authored plus generated nodes (${recipe.nodes.length} authored) within maxNodes ${limits.maxNodes}; lower cullDistance or give a smaller area`);
  }
  recipe.nodes.push(...generatedNodes);
  return {
    ...placedRuntime,
    clutter: runtime.report,
    geometryParts: new Map([...placedRuntime.geometryParts, ...runtime.geometryParts]),
    materialOutputs: new Map([...placedRuntime.materialOutputs, ...runtime.materialOutputs]),
    partExtras: new Map([...placedRuntime.partExtras, ...runtime.partExtras]),
  };
}
