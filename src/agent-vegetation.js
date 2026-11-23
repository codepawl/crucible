import { mat4 } from 'gl-matrix';
import { leafTextureDescriptor } from './vegetation-textures.js';
import { SPECIES, TREE_PRESETS, createTree, scatterVegetation, levelForDistance } from './vegetation.js';
import { checkTreeGrowth } from './vegetation-presets.js';
import { createImage } from './material-texture-kit.js';
import { createTextureMaps } from './agent-texture-set.js';
import { createRecipeTerrain } from './agent-terrain.js';
import { invalidField } from './field-error.js';

// Recipe vegetation: a group node with a `vegetation` field grows one tree, or scatters trees over a terrain node. The
// result reuses the placed-asset channel of agent-scene.js: generated geometries (type "asset"), materials (assetSource)
// and part nodes (assetPart), so exports and edits already skip them. Everything is a pure function of the recipe: the
// same seed grows the same trees, and levels of detail come from the recipe camera, never from the frame being drawn.

export const VEGETATION_LIMITS = Object.freeze({
  maxInstances: 1000, maxVariants: 4, maxExclusions: 32, maxCandidates: 4000, maxCachedSets: 4,
});
const SCATTER_SPECIES = [...Object.keys(SPECIES), 'grass', 'flowers'];
const VEGETATION_FIELDS = ['species', 'preset', 'tree', 'mix', 'seed', 'height', 'leaves', 'season', 'cullDistance', 'distanceScale', 'scatter', 'scans'];
// Scanned bark and leaf cards per species, as catalog image IDs. The MCP server fills them from the vegetation-scans pack.
const SCAN_PART_FIELDS = Object.freeze({ bark: ['colorMap', 'normalMap', 'roughnessMap'], leaves: ['colorMap', 'normalMap', 'crownMap'] });
const CATALOG_IMAGE_ID = /^[a-f0-9]{64}$/;
const CLAMP_TO_EDGE = 33071;
const SCATTER_FIELDS = ['ground', 'density', 'slopeLimit', 'area', 'exclude', 'variants', 'scale'];
const EXCLUSION_FIELDS = ['center', 'radius', 'min', 'max', 'node'];
const GROUND_EDGE_MARGIN = 0.5;
const SEASON_TARGETS = Object.freeze([[0.35, [196, 150, 40]], [0.6, [186, 84, 26]], [0.85, [112, 66, 34]]]);
const GRASS_CARD_COLOR = [80, 128, 40];
const BARE_SEASON = 0.9;
const DECIDUOUS_SPECIES = new Set(['broadleaf', 'birch', 'bush']);

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

function normalizeExclusion(value, path) {
  knownKeys(value, EXCLUSION_FIELDS, path);
  if (value.min !== undefined || value.max !== undefined) {
    if (value.center !== undefined || value.radius !== undefined || value.node !== undefined) {
      throw invalidField(path, value, 'either the box form "min", "max" or the circle form "center", "radius", not both');
    }
    const min = planePoint(value.min, `${path}.min`);
    const max = planePoint(value.max, `${path}.max`);
    if (max[0] <= min[0] || max[1] <= min[1]) throw invalidField(`${path}.max`, max, `[x, z] above min ${JSON.stringify(min)} on both axes`);
    return { min, max };
  }
  const radius = numberWithin(value.radius, 0.01, 2000, `${path}.radius`);
  if (value.node !== undefined) {
    if (typeof value.node !== 'string' || !value.node) throw invalidField(`${path}.node`, value.node, 'a node ID, such as "pond"', TypeError);
    return { node: value.node, radius };
  }
  return { center: planePoint(value.center, `${path}.center`), radius };
}

function normalizeScatter(value, path) {
  knownKeys(value, SCATTER_FIELDS, path);
  if (typeof value.ground !== 'string' || !value.ground) throw invalidField(`${path}.ground`, value.ground, 'the ID of a terrain node, such as "ground"', TypeError);
  const result = {
    ground: value.ground,
    density: numberWithin(value.density ?? 0.012, 0.0001, 4, `${path}.density`),
    slopeLimit: numberWithin(value.slopeLimit ?? 32, 0, 90, `${path}.slopeLimit`),
    variants: numberWithin(value.variants ?? 3, 1, VEGETATION_LIMITS.maxVariants, `${path}.variants`),
    exclude: [],
  };
  if (!Number.isInteger(result.variants)) throw invalidField(`${path}.variants`, result.variants, `a whole number from 1 to ${VEGETATION_LIMITS.maxVariants}, such as 3`);
  if (value.exclude !== undefined) {
    if (!Array.isArray(value.exclude) || value.exclude.length > VEGETATION_LIMITS.maxExclusions) {
      throw invalidField(`${path}.exclude`, Array.isArray(value.exclude) ? `${value.exclude.length} areas` : value.exclude, `a list of at most ${VEGETATION_LIMITS.maxExclusions} areas, such as [{ "center": [0, 0], "radius": 5 }]`);
    }
    result.exclude = value.exclude.map((entry, index) => normalizeExclusion(entry, `${path}.exclude[${index}]`));
  }
  if (value.area !== undefined) {
    knownKeys(value.area, ['min', 'max'], `${path}.area`);
    result.area = { min: planePoint(value.area.min, `${path}.area.min`), max: planePoint(value.area.max, `${path}.area.max`) };
    if (result.area.max[0] <= result.area.min[0] || result.area.max[1] <= result.area.min[1]) {
      throw invalidField(`${path}.area.max`, result.area.max, `[x, z] above min ${JSON.stringify(result.area.min)} on both axes`);
    }
  }
  if (value.scale !== undefined) {
    if (!Array.isArray(value.scale) || value.scale.length !== 2) throw invalidField(`${path}.scale`, value.scale, '[min, max], such as [0.8, 1.2]', TypeError);
    result.scale = [numberWithin(value.scale[0], 0.1, 10, `${path}.scale[0]`), numberWithin(value.scale[1], 0.1, 10, `${path}.scale[1]`)];
    if (result.scale[1] < result.scale[0]) throw invalidField(`${path}.scale`, value.scale, '[min, max] with max not below min, such as [0.8, 1.2]');
  }
  return result;
}

/** Validate environment.wind: strength 0 to 4 (0.3) and direction in degrees (0 toward +x, 90 toward +z). */
export function normalizeWind(value) {
  knownKeys(value, ['strength', 'direction'], 'environment.wind');
  return {
    strength: numberWithin(value.strength ?? 0.3, 0, 4, 'environment.wind.strength'),
    direction: numberWithin(value.direction ?? 0, -360, 360, 'environment.wind.direction'),
  };
}

// The placed-asset runtime with the vegetation maps added to it, and the report for scene_inspect.
function mergedRuntime(placed, vegetation) {
  return {
    ...placed,
    vegetation: vegetation.report,
    geometryParts: new Map([...placed.geometryParts, ...vegetation.geometryParts]),
    materialOutputs: new Map([...placed.materialOutputs, ...vegetation.materialOutputs]),
    partExtras: new Map([...placed.partExtras, ...vegetation.partExtras]),
  };
}

// Growth overrides of one tree species or preset, checked against the ranges of vegetation-presets.js.
function normalizeTreeGrowth(tree, vegetation) {
  if (vegetation.mix) throw invalidField('vegetation.tree', tree, 'nothing with mix; tree tunes one species or preset, so give species or preset instead of mix', TypeError);
  const named = TREE_PRESETS[vegetation.preset];
  const species = named ? named.species : vegetation.species;
  if (!SPECIES[species]) throw invalidField('vegetation.tree', tree, `nothing for ${species}; tree tunes the tree species ${Object.keys(SPECIES).join(', ')}`, TypeError);
  const levels = named?.tree.levels ?? SPECIES[species].levels.length - 1;
  return checkTreeGrowth(tree, levels, (path, value, expected) => {
    throw invalidField(`vegetation.${path}`, value, expected);
  });
}

/** Validate the `vegetation` field of a node (`node` is the whole node, which must be a group). Returns the canonical form kept in the recipe. */
export function normalizeVegetation(value, node) {
  const conflict = node && ['geometry', 'skin', 'asset'].find(field => node[field] !== undefined);
  if (conflict) {
    throw invalidField(conflict, node[conflict], 'nothing, because a node that grows vegetation is a group; drop geometry, material, skin and asset', TypeError);
  }
  knownKeys(value, VEGETATION_FIELDS, 'vegetation');
  const result = {};
  const kinds = ['species', 'preset', 'mix'].filter(field => value[field] !== undefined);
  if (kinds.length !== 1) {
    throw invalidField(`vegetation.${kinds[0] ?? 'species'}`, value[kinds[0] ?? 'species'], 'exactly one of species (one tree, such as "broadleaf"), preset (a named tree, such as "oak") or mix (a scatter, such as { "broadleaf": 3, "bush": 1 })', TypeError);
  }
  if (value.preset !== undefined) {
    if (!TREE_PRESETS[value.preset]) throw invalidField('vegetation.preset', value.preset, `one of ${Object.keys(TREE_PRESETS).join(', ')}`);
    result.preset = value.preset;
  } else if (value.species !== undefined) {
    if (!SCATTER_SPECIES.includes(value.species) || (!value.scatter && !SPECIES[value.species])) {
      throw invalidField('vegetation.species', value.species, `one of ${(value.scatter ? SCATTER_SPECIES : Object.keys(SPECIES)).join(', ')}`);
    }
    result.species = value.species;
  } else {
    if (!value.scatter) throw invalidField('vegetation.scatter', value.scatter, 'a scatter, such as { "ground": "ground" }, because mix needs one; a single tree takes species', TypeError);
    if (!value.mix || typeof value.mix !== 'object' || Array.isArray(value.mix)) throw invalidField('vegetation.mix', value.mix, 'an object that maps species to weights, such as { "broadleaf": 3, "bush": 1 }', TypeError);
    result.mix = {};
    for (const [name, weight] of Object.entries(value.mix)) {
      if (!SCATTER_SPECIES.includes(name)) throw invalidField('vegetation.mix', name, `species names among ${SCATTER_SPECIES.join(', ')}`);
      result.mix[name] = numberWithin(weight, 0, 100, `vegetation.mix.${name}`);
    }
    if (!Object.values(result.mix).some(weight => weight > 0)) throw invalidField('vegetation.mix', value.mix, 'at least one positive weight, such as { "broadleaf": 1 }');
  }
  if (value.tree !== undefined) result.tree = normalizeTreeGrowth(value.tree, result);
  result.seed = numberWithin(value.seed ?? 1, -2147483648, 2147483647, 'vegetation.seed');
  if (value.height !== undefined) result.height = numberWithin(value.height, 0.2, 80, 'vegetation.height');
  result.leaves = value.leaves ?? 'cards';
  if (result.leaves !== 'cards' && result.leaves !== 'mesh') throw invalidField('vegetation.leaves', result.leaves, '"cards" or "mesh"');
  result.season = numberWithin(value.season ?? 0, 0, 1, 'vegetation.season');
  if (value.cullDistance !== undefined) result.cullDistance = numberWithin(value.cullDistance, 1, 100_000, 'vegetation.cullDistance');
  result.distanceScale = numberWithin(value.distanceScale ?? 1, 0.1, 10, 'vegetation.distanceScale');
  if (value.scatter !== undefined) result.scatter = normalizeScatter(value.scatter, 'vegetation.scatter');
  if (value.scans !== undefined) result.scans = normalizeScans(value.scans);
  return result;
}

function normalizeScanPart(value, part, path) {
  knownKeys(value, SCAN_PART_FIELDS[part], path);
  if (value.colorMap === undefined) throw invalidField(`${path}.colorMap`, value.colorMap, 'the catalog image ID of the colour map; the other maps are optional', TypeError);
  const result = {};
  for (const [field, id] of Object.entries(value)) {
    if (typeof id !== 'string' || !CATALOG_IMAGE_ID.test(id.toLowerCase())) {
      throw invalidField(`${path}.${field}`, id, 'the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists the vegetation-scans pack images', TypeError);
    }
    result[field] = id.toLowerCase();
  }
  return result;
}

// `scans: {}` keeps every tree procedural even when the pack is installed, because the server only fills a node that has no scans.
function normalizeScans(value) {
  knownKeys(value, Object.keys(SPECIES), 'vegetation.scans');
  const result = {};
  for (const [species, entry] of Object.entries(value)) {
    knownKeys(entry, Object.keys(SCAN_PART_FIELDS), `vegetation.scans.${species}`);
    result[species] = {};
    for (const part of Object.keys(entry)) result[species][part] = normalizeScanPart(entry[part], part, `vegetation.scans.${species}.${part}`);
  }
  return result;
}

function leafDescriptor(frame) {
  return { image: createImage(frame.data, frame.width, frame.height), colorSpace: 'srgb', wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE };
}

/**
 * The `barkTextures` and `leafTextures` createTree takes, from the decoded catalog images of `scans`. `leafFrames` maps each leaf
 * colour descriptor to its decoded pixels, so a season can recolour the scan instead of swapping in the procedural sprite.
 */
function scanTextures(scans, pool, nodeId) {
  const barkTextures = {};
  const leafTextures = {};
  const leafFrames = new Map();
  for (const [species, entry] of Object.entries(scans ?? {})) {
    if (entry.bark) {
      const maps = createTextureMaps(`${nodeId} vegetation.scans.${species}.bark`, entry.bark, pool);
      barkTextures[species] = { color: maps.map, ...(maps.normalMap && { normal: maps.normalMap }), ...(maps.metallicRoughnessMap && { roughness: maps.metallicRoughnessMap }) };
    }
    if (entry.leaves) {
      const frameOf = field => {
        const frame = pool?.get(entry.leaves[field]);
        if (!frame) throw new Error(`Node ${nodeId}: vegetation.scans.${species}.leaves.${field} image ${entry.leaves[field].slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`);
        return frame;
      };
      const set = { color: leafDescriptor(frameOf('colorMap')) };
      leafFrames.set(set.color, frameOf('colorMap'));
      if (entry.leaves.normalMap) set.normal = { ...leafDescriptor(frameOf('normalMap')), colorSpace: 'linear' };
      if (entry.leaves.crownMap) {
        set.crown = leafDescriptor(frameOf('crownMap'));
        leafFrames.set(set.crown, frameOf('crownMap'));
      }
      leafTextures[species] = set;
    }
  }
  return { barkTextures, leafTextures, leafFrames };
}

// A scanned card keeps its own detail through the seasons: each channel is scaled by how far the season colour sits from the species colour.
function recoloredLeafDescriptor(descriptor, frame, base, target) {
  const ratios = target.map((channel, axis) => channel / Math.max(1, base[axis]));
  const data = new Uint8ClampedArray(frame.data);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = data[offset] * ratios[0];
    data[offset + 1] = data[offset + 1] * ratios[1];
    data[offset + 2] = data[offset + 2] * ratios[2];
  }
  return { ...descriptor, image: createImage(data, frame.width, frame.height) };
}

/** A leaf colour (0 to 255 sRGB) for a season: summer keeps the species colour, then 0.35 gold, 0.6 orange and 0.85 brown. */
export function seasonLeafColor(base, season) {
  const stops = [[0, base], ...SEASON_TARGETS];
  if (season >= stops[stops.length - 1][0]) return [...stops[stops.length - 1][1]];
  let index = 0;
  while (season > stops[index + 1][0]) index++;
  const [startSeason, startColor] = stops[index];
  const [endSeason, endColor] = stops[index + 1];
  const fraction = (season - startSeason) / (endSeason - startSeason);
  return startColor.map((channel, axis) => Math.round(channel + (endColor[axis] - channel) * fraction));
}

// Cards recolour their procedural leaf sprite, because a colour factor cannot turn a green leaf orange; mesh leaves and grass blades recolour the material.
function seasonalMaterial(material, variant, species, season, leafFrames) {
  const scannedFrame = leafFrames?.get(material.map);
  if (scannedFrame) {
    const base = SPECIES[species].leaf.color;
    return { ...material, map: recoloredLeafDescriptor(material.map, scannedFrame, base, seasonLeafColor(base, season)) };
  }
  if (material.map) {
    const preset = SPECIES[species];
    const kind = species === 'grass' ? 'grass' : material === variant.materials.crown ? 'clump' : preset.leaf.texture;
    const base = species === 'grass' ? GRASS_CARD_COLOR : preset.leaf.color;
    return { ...material, map: leafTextureDescriptor(kind, seasonLeafColor(base, season)) };
  }
  const base = material.color.map(channel => channel ** (1 / 2.2) * 255);
  return { ...material, color: seasonLeafColor(base, season).map(channel => (channel / 255) ** 2.2) };
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

function groundTerrain(recipe, scatter) {
  const ground = recipe.nodes.find(node => node.id === scatter.ground);
  const definition = ground && recipe.geometries.find(geometry => geometry.id === ground.geometry);
  if (definition?.type !== 'terrain') {
    throw invalidField('vegetation.scatter.ground', scatter.ground, 'the ID of a node that draws a terrain geometry, such as "ground"; give the group node the same transform as the ground');
  }
  return { definition, terrain: createRecipeTerrain(definition) };
}

function scatterArea(scatter, definition) {
  const half = (definition.size ?? 40) / 2 - GROUND_EDGE_MARGIN;
  const area = scatter.area ?? { min: [-half, -half], max: [half, half] };
  const clamped = {
    minX: Math.max(area.min[0], -half), maxX: Math.min(area.max[0], half),
    minZ: Math.max(area.min[1], -half), maxZ: Math.min(area.max[1], half),
  };
  if (clamped.maxX <= clamped.minX || clamped.maxZ <= clamped.minZ) {
    throw invalidField(scatter.area ? 'vegetation.scatter.area' : 'vegetation.scatter.ground', scatter.area ?? scatter.ground, `an area that overlaps the ground, which spans ${-half} to ${half} on x and z`);
  }
  return clamped;
}

// The [x, z] of a node in the ground's own space, which is where the scatter area and exclusions are measured.
function planePositionInGround(recipe, scatter, nodeId) {
  const target = recipe.nodes.find(node => node.id === nodeId);
  const ground = recipe.nodes.find(node => node.id === scatter.ground);
  const inGround = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), nodeWorldMatrix(recipe.nodes, ground)), nodeWorldMatrix(recipe.nodes, target));
  return [inGround[12], inGround[14]];
}

function exclusionTest(recipe, scatter, terrain) {
  const areas = scatter.exclude.map((entry, index) => {
    if (entry.min) return (x, z) => x >= entry.min[0] && x <= entry.max[0] && z >= entry.min[1] && z <= entry.max[1];
    let center = entry.center;
    if (entry.node) {
      const target = recipe.nodes.find(node => node.id === entry.node);
      if (!target) throw invalidField(`vegetation.scatter.exclude[${index}].node`, entry.node, 'the ID of a node in the recipe, such as "pond"');
      center = planePositionInGround(recipe, scatter, entry.node);
    }
    return (x, z) => Math.hypot(x - center[0], z - center[1]) <= entry.radius;
  });
  return (x, z) => terrain.isHole(x, z) || areas.some(test => test(x, z));
}

/** The options `scatterVegetation` gets for a scatter node: the same call an addon user makes, so both give the same instances. */
export function scatterOptionsFor(recipe, vegetation) {
  const { scatter } = vegetation;
  const { definition, terrain } = groundTerrain(recipe, scatter);
  const area = scatterArea(scatter, definition);
  const candidates = (area.maxX - area.minX) * (area.maxZ - area.minZ) * scatter.density;
  if (candidates > VEGETATION_LIMITS.maxCandidates) {
    throw invalidField('vegetation.scatter.density', scatter.density, `a density that tries at most ${VEGETATION_LIMITS.maxCandidates} trees over the area (this tries about ${Math.round(candidates)}); lower it or give a smaller area`);
  }
  return {
    area, density: scatter.density, terrainHeight: terrain.heightAt, slopeLimit: scatter.slopeLimit,
    exclusion: exclusionTest(recipe, scatter, terrain), seed: vegetation.seed, mix: vegetation.mix ?? { [vegetation.species]: 1 },
    variants: scatter.variants, leaves: vegetation.leaves, ...(scatter.scale ? { scale: scatter.scale } : {}),
    ...(vegetation.preset ? { mix: { [TREE_PRESETS[vegetation.preset].species]: 1 } } : {}), ...growthOptions(vegetation),
  };
}

// The preset and growth overrides createTree and scatterVegetation take, or nothing for a plain species.
function growthOptions(vegetation) {
  const growth = {
    ...(vegetation.preset ? { preset: vegetation.preset } : {}),
    ...(vegetation.tree ? { tree: vegetation.tree } : {}),
  };
  return Object.keys(growth).length ? { growth } : {};
}

function grow(recipe, vegetation, pool, nodeId) {
  const { barkTextures, leafTextures, leafFrames } = scanTextures(vegetation.scans, pool, nodeId);
  if (!vegetation.scatter) {
    const growth = growthOptions(vegetation).growth ?? {};
    const tree = createTree({ species: vegetation.species, ...growth, leaves: vegetation.leaves, barkTextures, leafTextures, ...(vegetation.height ? { height: vegetation.height } : {}) }, vegetation.seed);
    return { variants: [tree], instances: [{ variant: tree, matrix: mat4.create(), species: tree.species }], leafFrames };
  }
  const scattered = scatterVegetation({ ...scatterOptionsFor(recipe, vegetation), barkTextures, leafTextures });
  if (scattered.instances.length > VEGETATION_LIMITS.maxInstances) {
    throw invalidField('vegetation.scatter.density', vegetation.scatter.density, `a density that places at most ${VEGETATION_LIMITS.maxInstances} instances (this placed ${scattered.instances.length}); lower it or give a smaller area`);
  }
  return { variants: Object.values(scattered.variants).flat(), instances: scattered.instances, leafFrames };
}

// Where a named exclusion stands in the ground's space, or null while the node or the ground is missing (growing reports that).
function namedPlanePosition(recipe, scatter, nodeId) {
  const hasNode = id => recipe.nodes.some(node => node.id === id);
  return hasNode(nodeId) && hasNode(scatter.ground) ? planePositionInGround(recipe, scatter, nodeId) : null;
}

function cacheKey(recipe, node) {
  const { vegetation } = node;
  const ground = vegetation.scatter ? recipe.geometries.find(geometry => geometry.id === recipe.nodes.find(candidate => candidate.id === vegetation.scatter.ground)?.geometry) : null;
  const named = vegetation.scatter?.exclude.filter(entry => entry.node).map(entry => namedPlanePosition(recipe, vegetation.scatter, entry.node));
  const { season, cullDistance, distanceScale, ...growth } = vegetation;
  return JSON.stringify([growth, ground, named]);
}

function materialJson(material) {
  return {
    tag: material.tag ?? 'surface', color: [...material.color], metallic: material.metallic ?? 0, roughness: material.roughness ?? 0.5,
    emission: material.emission ?? 0, opacity: 1, alphaMode: material.alphaMode ?? 'opaque',
    doubleSided: Boolean(material.doubleSided),
  };
}

/**
 * Generate the geometries, materials and part nodes of every vegetation node into a normalized recipe, in place.
 * `cache` (the scene's asset output map) holds grown trees across edits, so a camera or season edit does not grow them again.
 * Returns the runtime maps the scene merges with the placed-asset ones, and a report for scene_inspect. `pool` holds the decoded
 * catalog images that `vegetation.scans` names.
 */
export function expandVegetation(recipe, limits, cache, placedRuntime, pool) {
  cache.serial ??= 0;
  const planted = recipe.nodes.filter(node => node.vegetation);
  const runtime = { geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map(), report: [] };
  const generatedNodes = [];
  const geometryIds = new Set();
  const eye = recipe.camera?.eye ?? [0, 0, 0];
  for (const node of planted) {
    const { vegetation } = node;
    const key = `vegetation:${cacheKey(recipe, node)}`;
    if (!cache.has(key)) {
      // The scene shares this map with its placed assets, so only grown sets are evicted.
      const grownKeys = [...cache.keys()].filter(candidate => candidate.startsWith('vegetation:'));
      if (grownKeys.length >= VEGETATION_LIMITS.maxCachedSets) cache.delete(grownKeys[0]);
      cache.set(key, { serial: ++cache.serial, grown: grow(recipe, vegetation, pool, node.id), outputs: new Map() });
    }
    const entry = cache.get(key);
    const bare = vegetation.season >= BARE_SEASON;
    const world = nodeWorldMatrix(recipe.nodes, node);
    const variantIds = new Map(entry.grown.variants.map((variant, index) => [variant, index]));
    const materialIds = new Map();
    const bySpecies = {};
    let triangles = 0;
    let culled = 0;
    entry.grown.instances.forEach((instance, instanceIndex) => {
      const position = [instance.matrix[12], instance.matrix[13], instance.matrix[14]];
      const worldPosition = [
        world[0] * position[0] + world[4] * position[1] + world[8] * position[2] + world[12],
        world[1] * position[0] + world[5] * position[1] + world[9] * position[2] + world[13],
        world[2] * position[0] + world[6] * position[1] + world[10] * position[2] + world[14],
      ];
      const distance = Math.hypot(eye[0] - worldPosition[0], eye[1] - worldPosition[1], eye[2] - worldPosition[2]);
      const level = levelForDistance(distance, instance.variant, { distanceScale: vegetation.distanceScale, cullDistance: vegetation.cullDistance });
      const counts = bySpecies[instance.species] ??= { instances: 0, levels: [] };
      counts.instances++;
      if (level < 0) {
        culled++;
        return;
      }
      counts.levels[level] = (counts.levels[level] ?? 0) + 1;
      const leafless = bare && DECIDUOUS_SPECIES.has(instance.species);
      const seasonal = DECIDUOUS_SPECIES.has(instance.species) || instance.species === 'grass';
      // A bare broadleaf draws its twigged bark instead of the level's parts (#2826); other bare species drop their leaves.
      const twigged = leafless && typeof instance.variant.bareParts === 'function';
      const levelParts = twigged ? instance.variant.bareParts(level) : instance.variant.levels[level].parts;
      levelParts.forEach((part, partIndex) => {
        if (leafless && part.tintable) return;
        const geometryId = `vegetation:${entry.serial}:${variantIds.get(instance.variant)}:${level}:${partIndex}${twigged ? ':bare' : ''}`;
        if (!geometryIds.has(geometryId)) {
          geometryIds.add(geometryId);
          recipe.geometries.push({ id: geometryId, type: 'asset', vegetation: entry.serial });
          runtime.geometryParts.set(geometryId, part.geometry);
        }
        const tinted = part.tintable && seasonal && vegetation.season > 0;
        if (!materialIds.has(part.material)) materialIds.set(part.material, materialIds.size);
        const materialId = `vegetation:${entry.serial}:${variantIds.get(instance.variant)}:${materialIds.get(part.material)}:${tinted ? `s${vegetation.season}` : 'plain'}`;
        if (!runtime.materialOutputs.has(materialId)) {
          if (!entry.outputs.has(materialId)) {
            entry.outputs.set(materialId, Object.freeze(tinted ? seasonalMaterial(part.material, instance.variant, instance.species, vegetation.season, entry.grown.leafFrames) : { ...part.material }));
          }
          runtime.materialOutputs.set(materialId, entry.outputs.get(materialId));
          recipe.materials.push({ id: materialId, ...materialJson(entry.outputs.get(materialId)), assetSource: true });
        }
        const partNodeId = `${node.id}/${instanceIndex}/${part.role}`;
        generatedNodes.push({
          id: partNodeId, parent: node.id, label: `${instance.species} ${part.role}`,
          translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
          geometry: geometryId, material: materialId, assetPart: { placement: node.id, index: instanceIndex, matrix: Array.from(instance.matrix) },
        });
        // `group` makes the growing node, not each generated part, the node that per-node lines and object IDs name.
        runtime.partExtras.set(partNodeId, { group: node.id, ...(part.shadowLods ? { shadowLods: part.shadowLods } : {}) });
        triangles += part.geometry.indices.length / 3;
      });
    });
    runtime.report.push({
      node: node.id, mode: vegetation.scatter ? 'scatter' : 'tree', instances: entry.grown.instances.length, culled,
      season: vegetation.season, bare, triangles,
      species: Object.fromEntries(Object.entries(bySpecies).map(([name, counts]) => [name, { instances: counts.instances, levels: Array.from(counts.levels, count => count ?? 0) }])),
    });
  }
  if (recipe.nodes.length + generatedNodes.length > limits.maxNodes) {
    throw invalidField('vegetation.scatter.density', `${generatedNodes.length} generated part nodes`, `a density that keeps authored plus generated nodes (${recipe.nodes.length} authored) within maxNodes ${limits.maxNodes}; lower it or cull far trees with cullDistance`);
  }
  recipe.nodes.push(...generatedNodes);
  return mergedRuntime(placedRuntime, runtime);
}
