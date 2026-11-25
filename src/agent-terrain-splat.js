// Recipe terrain splat ground material (`terrain.material`): validates layer scans and blending rules in recipes
// and maps them onto the four-layer splat shader (`splat.js` and `splat-shader.js`) with optional path mask packing.
import './splat-shader.js';
import { SPLAT_MAXIMUM_LAYERS, validateSplatMaterial } from './splat.js';
import { flipNormalGreen } from './agent-texture-set.js';
import { NORMAL_CONVENTIONS, TEXTURE_MAP_FIELDS } from './texture-set-fields.js';
import { createImage } from './material-texture-kit.js';
import { TERRAIN_PATH_LIMITS } from './terrain-paths.js';
import { invalidField } from './field-error.js';

const ASSET_ID = /^[a-f0-9]{64}$/;
const LAYER_MAP_FIELDS = ['colorMap', 'normalMap', 'roughnessMap', 'heightMap'];
const LAYER_FIELDS = ['name', 'tiling', 'scale', 'tint', 'normalStrength', 'triplanar', 'textureSet', 'normalConvention', ...TEXTURE_MAP_FIELDS];
const RULE_FIELDS = ['layer', 'slope', 'slopeSoftness', 'height', 'heightSoftness', 'mask', 'invertMask'];
const MATERIAL_FIELDS = [
  'layers', 'rules', 'heightBlend', 'heightInfluence', 'antiTiling', 'variation', 'edgeNoise',
  'parallax', 'triplanar', 'triplanarStart', 'triplanarEnd', 'cavity', 'textureSize', 'maskResolution', 'color',
];
const MASK_CHANNELS = ['r', 'g', 'b', 'a'];
const DEFAULT_TILING_METRES = 4;
const DEFAULT_PARALLAX_METRES = 0.03;
const SPLAT_CACHE_SIZE = 8;
const splatMaterialCache = new Map();

function knownKeys(value, allowed, label, example) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, example, TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `one of ${allowed.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

function finiteIn(value, fallback, [minimum, maximum], label, example = fallback) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField(label, resolved, `a number from ${minimum} to ${maximum}, such as ${example}`);
  }
  return resolved;
}

function positiveNumber(value, fallback, label, example = fallback) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) {
    throw invalidField(label, resolved, `a positive number of metres, such as ${example}`);
  }
  return resolved;
}

function nonNegativeNumber(value, fallback, label, example = fallback) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0) {
    throw invalidField(label, resolved, `a number of 0 or more, such as ${example}`);
  }
  return resolved;
}

function rangePair(pair, [lowest, highest], label, example) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    throw invalidField(label, pair, `a [minimum, maximum] pair such as ${example}`, TypeError);
  }
  const [minimum, maximum] = pair;
  if (typeof minimum !== 'number' || !Number.isFinite(minimum) || typeof maximum !== 'number' || !Number.isFinite(maximum)) {
    throw invalidField(label, pair, `two finite numbers such as ${example}`);
  }
  if (minimum > maximum) throw invalidField(label, pair, 'a pair whose minimum does not exceed its maximum');
  if (minimum < lowest || maximum > highest) throw invalidField(label, pair, `two numbers from ${lowest} to ${highest}, such as ${example}`);
  return [minimum, maximum];
}

function colorTriplet(value, fallback, [minimum, maximum], label, example) {
  const resolved = value ?? fallback;
  if (!Array.isArray(resolved) || resolved.length !== 3 || resolved.some(component => typeof component !== 'number' || !Number.isFinite(component) || component < minimum || component > maximum)) {
    throw invalidField(label, resolved, `three numbers from ${minimum} to ${maximum}, such as ${example}`, TypeError);
  }
  return [...resolved];
}

function booleanOrNumber(value, fallback, onTrue, [minimum, maximum], label, example) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value ? onTrue : 0;
  return finiteIn(value, fallback, [minimum, maximum], label, example);
}

function normalizeLayer(layer, index, defaultTriplanar, seenNames) {
  const label = `terrain.material.layers[${index}]`;
  knownKeys(layer, LAYER_FIELDS, label, 'an object such as { "colorMap": "<asset id>", "tiling": 4 }');
  if (layer.textureSet !== undefined) {
    throw invalidField(`${label}.textureSet`, layer.textureSet, 'a recipe with the maps already filled in: the MCP server swaps textureSet for the catalog image IDs of its maps, so a library caller passes colorMap, normalMap, roughnessMap and heightMap itself');
  }
  if (layer.tiling !== undefined && layer.scale !== undefined) {
    throw invalidField(`${label}.scale`, layer.scale, 'only one of tiling or scale (metres per texture tile)', TypeError);
  }
  let name;
  if (layer.name !== undefined) {
    if (typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 64) {
      throw invalidField(`${label}.name`, layer.name, 'a name of 1 to 64 characters, such as "grass"', TypeError);
    }
    if (seenNames.has(layer.name)) {
      throw invalidField(`${label}.name`, layer.name, 'a unique layer name no other splat layer uses');
    }
    seenNames.add(layer.name);
    name = layer.name;
  }
  const maps = {};
  for (const field of TEXTURE_MAP_FIELDS) {
    if (layer[field] === undefined) continue;
    const id = layer[field];
    if (typeof id !== 'string' || !ASSET_ID.test(id.toLowerCase())) {
      throw invalidField(`${label}.${field}`, id, 'the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists them', TypeError);
    }
    maps[field] = id.toLowerCase();
  }
  if (!LAYER_MAP_FIELDS.some(field => maps[field] !== undefined)) {
    throw invalidField(label, layer, `at least one of ${LAYER_MAP_FIELDS.join(', ')}`);
  }
  let normalConvention;
  if (layer.normalConvention !== undefined) {
    if (!NORMAL_CONVENTIONS.includes(layer.normalConvention)) {
      throw invalidField(`${label}.normalConvention`, layer.normalConvention, `one of ${NORMAL_CONVENTIONS.join(', ')}`, TypeError);
    }
    if (maps.normalMap === undefined) {
      throw invalidField(`${label}.normalConvention`, layer.normalConvention, 'a layer that sets normalMap; add normalMap or remove normalConvention');
    }
    normalConvention = layer.normalConvention;
  }
  if (layer.triplanar !== undefined && typeof layer.triplanar !== 'boolean') {
    throw invalidField(`${label}.triplanar`, layer.triplanar, 'true or false', TypeError);
  }
  const tiling = positiveNumber(layer.tiling ?? layer.scale, DEFAULT_TILING_METRES, `${label}.${layer.tiling !== undefined ? 'tiling' : 'scale'}`, DEFAULT_TILING_METRES);
  return {
    name,
    maps,
    normalConvention,
    tiling,
    tint: layer.tint === undefined ? undefined : colorTriplet(layer.tint, [1, 1, 1], [0, 1000], `${label}.tint`, '[0.7, 0.9, 0.5]'),
    normalStrength: nonNegativeNumber(layer.normalStrength, 1, `${label}.normalStrength`, 1),
    triplanar: layer.triplanar ?? defaultTriplanar,
  };
}

function resolveRuleLayer(target, layers, label) {
  if (Number.isInteger(target) && target >= 0 && target < layers.length) return target;
  if (typeof target === 'string') {
    const index = layers.findIndex(layer => layer.name === target);
    if (index >= 0) return index;
    const named = layers.map(layer => layer.name).filter(Boolean);
    throw invalidField(`${label}.layer`, target, named.length ? `an integer 0 to ${layers.length - 1} or one of the layer names: ${named.join(', ')}` : `an integer 0 to ${layers.length - 1}`);
  }
  throw invalidField(`${label}.layer`, target, `an integer 0 to ${layers.length - 1} or the name of a layer`);
}

function terrainPathNames(terrainDefinition) {
  return (terrainDefinition?.paths ?? []).map((path, index) => path?.name ?? `path${index}`);
}

function normalizeRules(rules, layers, terrainDefinition) {
  if (rules === undefined) return { positionalRules: [], maskNames: [] };
  if (!Array.isArray(rules) || rules.length > layers.length) {
    throw invalidField('terrain.material.rules', Array.isArray(rules) ? `${rules.length} rules` : rules, `an array of at most ${layers.length} rules (one per layer)`);
  }
  const availableMasks = terrainPathNames(terrainDefinition);
  const positionalRules = new Array(layers.length).fill(undefined);
  const maskNames = [];
  const assignedLayers = new Set();
  rules.forEach((rule, index) => {
    const label = `terrain.material.rules[${index}]`;
    knownKeys(rule, RULE_FIELDS, label, 'an object such as { "layer": 1, "slope": [28, 90] }');
    const layerIndex = resolveRuleLayer(rule.layer, layers, label);
    if (assignedLayers.has(layerIndex)) {
      throw invalidField(`${label}.layer`, rule.layer, 'a layer not already targeted by an earlier rule');
    }
    assignedLayers.add(layerIndex);
    const normalized = {};
    if (rule.slope !== undefined) normalized.slope = rangePair(rule.slope, [0, 90], `${label}.slope`, '[28, 90]');
    if (rule.height !== undefined) normalized.height = rangePair(rule.height, [-1e6, 1e6], `${label}.height`, '[-5, 10]');
    if (rule.slopeSoftness !== undefined) normalized.slopeSoftness = nonNegativeNumber(rule.slopeSoftness, 4, `${label}.slopeSoftness`, 4);
    if (rule.heightSoftness !== undefined) normalized.heightSoftness = nonNegativeNumber(rule.heightSoftness, 1.5, `${label}.heightSoftness`, 1.5);
    if (rule.invertMask !== undefined && typeof rule.invertMask !== 'boolean') {
      throw invalidField(`${label}.invertMask`, rule.invertMask, 'true or false', TypeError);
    }
    if (rule.invertMask !== undefined && rule.mask === undefined) {
      throw invalidField(`${label}.invertMask`, rule.invertMask, 'a rule that also sets mask; add mask or remove invertMask');
    }
    if (rule.mask !== undefined) {
      if (typeof rule.mask !== 'string' || !rule.mask.trim()) {
        throw invalidField(`${label}.mask`, rule.mask, 'the name of a terrain path mask, such as "road"', TypeError);
      }
      if (!availableMasks.includes(rule.mask)) {
        throw invalidField(`${label}.mask`, rule.mask, availableMasks.length ? `one of the terrain path masks: ${availableMasks.join(', ')}` : 'omitted when the terrain has no paths; add terrain.paths with that name first');
      }
      let channelIndex = maskNames.indexOf(rule.mask);
      if (channelIndex === -1) {
        if (maskNames.length >= MASK_CHANNELS.length) {
          throw invalidField(`${label}.mask`, rule.mask, `one of at most ${MASK_CHANNELS.length} distinct masks per terrain material`);
        }
        channelIndex = maskNames.length;
        maskNames.push(rule.mask);
      }
      normalized.mask = MASK_CHANNELS[channelIndex];
      if (rule.invertMask) normalized.invertMask = true;
    }
    positionalRules[layerIndex] = normalized;
  });
  return { positionalRules, maskNames };
}

/** Validates `terrain.material` in a recipe and returns the normalized configuration. */
export function normalizeTerrainSplatMaterial(material, terrainDefinition) {
  knownKeys(material, MATERIAL_FIELDS, 'terrain.material', 'an object with layers (1 to 4 scanned texture layers)');
  if (!Array.isArray(material.layers) || material.layers.length < 1 || material.layers.length > SPLAT_MAXIMUM_LAYERS) {
    throw invalidField('terrain.material.layers', Array.isArray(material.layers) ? `${material.layers.length} layers` : material.layers, `an array of 1 to ${SPLAT_MAXIMUM_LAYERS} layers`);
  }
  if (material.triplanar !== undefined && typeof material.triplanar !== 'boolean') {
    throw invalidField('terrain.material.triplanar', material.triplanar, 'true or false', TypeError);
  }
  const defaultTriplanar = material.triplanar === true;
  const seenNames = new Set();
  const layers = material.layers.map((layer, index) => normalizeLayer(layer, index, defaultTriplanar, seenNames));
  const { positionalRules, maskNames } = normalizeRules(material.rules, layers, terrainDefinition);
  const triplanarStart = finiteIn(material.triplanarStart, 38, [0, 90], 'terrain.material.triplanarStart', 38);
  const triplanarEnd = finiteIn(material.triplanarEnd, 52, [0, 90], 'terrain.material.triplanarEnd', 52);
  if (triplanarStart > triplanarEnd) {
    throw invalidField('terrain.material.triplanarStart', triplanarStart, `at most terrain.material.triplanarEnd (${triplanarEnd})`);
  }
  let textureSize;
  if (material.textureSize !== undefined) {
    if (!Number.isInteger(material.textureSize) || material.textureSize < 4 || material.textureSize > 4096) {
      throw invalidField('terrain.material.textureSize', material.textureSize, 'a whole number from 4 to 4096, such as 512');
    }
    textureSize = material.textureSize;
  }
  let maskResolution = TERRAIN_PATH_LIMITS.defaultMaskResolution;
  if (material.maskResolution !== undefined) {
    const [minimum, maximum] = TERRAIN_PATH_LIMITS.maskResolution;
    if (!Number.isInteger(material.maskResolution) || material.maskResolution < minimum || material.maskResolution > maximum) {
      throw invalidField('terrain.material.maskResolution', material.maskResolution, `a whole number from ${minimum} to ${maximum}, such as ${TERRAIN_PATH_LIMITS.defaultMaskResolution}`);
    }
    maskResolution = material.maskResolution;
  }
  return {
    layers,
    positionalRules,
    maskNames,
    heightBlend: nonNegativeNumber(material.heightBlend, 0.22, 'terrain.material.heightBlend', 0.22),
    heightInfluence: nonNegativeNumber(material.heightInfluence, 1, 'terrain.material.heightInfluence', 1),
    antiTiling: booleanOrNumber(material.antiTiling, 1, 1, [0, 1], 'terrain.material.antiTiling', 1),
    variation: finiteIn(material.variation, 1, [0, 2], 'terrain.material.variation', 1),
    edgeNoise: finiteIn(material.edgeNoise, 1, [0, 2], 'terrain.material.edgeNoise', 1),
    parallax: booleanOrNumber(material.parallax, DEFAULT_PARALLAX_METRES, DEFAULT_PARALLAX_METRES, [0, 0.15], 'terrain.material.parallax', DEFAULT_PARALLAX_METRES),
    triplanarStart,
    triplanarEnd,
    cavity: finiteIn(material.cavity, 0.55, [0, 1], 'terrain.material.cavity', 0.55),
    textureSize,
    maskResolution,
    color: colorTriplet(material.color, [1, 1, 1], [0, 1], 'terrain.material.color', '[1, 1, 1]'),
  };
}

function asClampedPixels(frame) {
  return frame.data instanceof Uint8ClampedArray ? frame.data : new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

function frameFromPool(terrainId, layerIndex, field, id, pool) {
  const frame = pool?.get(id);
  if (!frame) {
    throw new Error(`Terrain ${terrainId}: layers[${layerIndex}].${field} image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`);
  }
  return frame;
}

function buildCombinedMaskImage(maskNames, resolution, size, pathMasks) {
  const halfSize = size / 2;
  const bounds = [-halfSize, -halfSize, halfSize, halfSize];
  const data = new Uint8ClampedArray(resolution * resolution * 4);
  for (let row = 0; row < resolution; row++) {
    const pointZ = -halfSize + ((row + 0.5) / resolution) * size;
    for (let column = 0; column < resolution; column++) {
      const pointX = -halfSize + ((column + 0.5) / resolution) * size;
      const offset = (row * resolution + column) * 4;
      data[offset + 3] = 255;
      for (let channel = 0; channel < maskNames.length; channel++) {
        data[offset + channel] = Math.round(pathMasks.at(maskNames[channel], pointX, pointZ) * 255);
      }
    }
  }
  return { descriptor: { image: createImage(data, resolution, resolution), colorSpace: 'linear' }, maskBounds: bounds };
}

/** Builds and caches the frozen splat material object (`layers` + `splat`) consumed by `CrucibleRenderer` for a recipe terrain. */
export function buildTerrainSplatMaterial(terrainDefinition, pool, pathMasks = null) {
  const normalized = normalizeTerrainSplatMaterial(terrainDefinition.material, terrainDefinition);
  const size = terrainDefinition.size ?? 40;
  const referencedFrames = [];
  for (let index = 0; index < normalized.layers.length; index++) {
    const layer = normalized.layers[index];
    for (const field of LAYER_MAP_FIELDS) {
      if (layer.maps[field]) referencedFrames.push(frameFromPool(terrainDefinition.id, index, field, layer.maps[field], pool));
    }
  }
  const cacheKey = JSON.stringify([terrainDefinition.id, size, normalized, normalized.maskNames.length ? terrainDefinition.paths : null]);
  const cached = splatMaterialCache.get(cacheKey);
  if (cached && cached.frames.length === referencedFrames.length && cached.frames.every((frame, index) => frame === referencedFrames[index])) {
    splatMaterialCache.delete(cacheKey);
    splatMaterialCache.set(cacheKey, cached);
    return cached.material;
  }

  let frameCursor = 0;
  const nextFrame = () => referencedFrames[frameCursor++];
  const layers = Object.freeze(normalized.layers.map(layer => {
    const descriptor = {};
    if (layer.maps.colorMap) descriptor.color = Object.freeze({ image: createImage(asClampedPixels(nextFrame()), referencedFrames[frameCursor - 1].width, referencedFrames[frameCursor - 1].height), colorSpace: 'srgb' });
    if (layer.maps.normalMap) {
      const raw = nextFrame();
      const processed = layer.normalConvention === 'directx' ? flipNormalGreen(raw) : raw;
      descriptor.normal = Object.freeze({ image: createImage(asClampedPixels(processed), processed.width, processed.height), colorSpace: 'linear' });
    }
    if (layer.maps.roughnessMap) {
      const raw = nextFrame();
      descriptor.roughness = Object.freeze({ image: createImage(asClampedPixels(raw), raw.width, raw.height), colorSpace: 'linear' });
    }
    if (layer.maps.heightMap) {
      const raw = nextFrame();
      descriptor.height = Object.freeze({ image: createImage(asClampedPixels(raw), raw.width, raw.height), colorSpace: 'linear' });
    }
    descriptor.scale = layer.tiling;
    if (layer.tint) descriptor.tint = Object.freeze([...layer.tint]);
    if (layer.normalStrength !== 1) descriptor.normalStrength = layer.normalStrength;
    if (layer.triplanar) descriptor.triplanar = true;
    return Object.freeze(descriptor);
  }));

  const splat = {
    rules: Object.freeze(normalized.positionalRules.map(rule => (rule ? Object.freeze({ ...rule }) : undefined))),
    heightBlend: normalized.heightBlend,
    heightInfluence: normalized.heightInfluence,
    antiTiling: normalized.antiTiling,
    variation: normalized.variation,
    edgeNoise: normalized.edgeNoise,
    parallax: normalized.parallax,
    triplanarStart: normalized.triplanarStart,
    triplanarEnd: normalized.triplanarEnd,
    cavity: normalized.cavity,
    ...(normalized.textureSize !== undefined ? { textureSize: normalized.textureSize } : {}),
  };
  if (normalized.maskNames.length > 0) {
    if (!pathMasks) {
      throw new Error(`Terrain ${terrainDefinition.id} rules reference path masks (${normalized.maskNames.join(', ')}), which require pathMasks from the built terrain.`);
    }
    const { descriptor, maskBounds } = buildCombinedMaskImage(normalized.maskNames, normalized.maskResolution, size, pathMasks);
    splat.maskMap = descriptor;
    splat.maskBounds = Object.freeze(maskBounds);
  }

  const material = Object.freeze({
    id: `${terrainDefinition.id}:splat`,
    tag: 'surface',
    color: Object.freeze([...normalized.color]),
    metallic: 0,
    roughness: 1,
    opacity: 1,
    alphaMode: 'opaque',
    doubleSided: false,
    layers,
    splat: Object.freeze(splat),
  });
  validateSplatMaterial(material);

  if (splatMaterialCache.size >= SPLAT_CACHE_SIZE) splatMaterialCache.delete(splatMaterialCache.keys().next().value);
  splatMaterialCache.set(cacheKey, { frames: referencedFrames, material });
  return material;
}
