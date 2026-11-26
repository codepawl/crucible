// Per-material overrides, glTF options scaling, and glTF loader warnings for headless scene files (--scene file).
import { GLTF_CAPABILITIES } from './gltf.js';
import { MATERIAL_LAYER_FIELDS, validateMaterialLayers } from './material-layers.js';

export const DEFAULT_MEMORY_BUDGET_MIB = 384;
export const WORLD_MATERIAL_TAGS = Object.freeze(new Set(['water', 'foliage', 'grass', 'terrain', 'fire', 'smoke']));

const VALID_MATERIAL_TAGS = new Set(['surface', 'gltf', 'unlit', 'liquid', 'foam', 'foliage', 'grass', 'water', 'terrain', 'floor', 'fire', 'smoke']);
const PROCEDURAL_MATERIAL_TAGS = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke', 'liquid', 'foam']);
const SWAYING_MATERIAL_TAGS = new Set(['foliage', 'grass']);
const ALPHA_MODES = new Set(['opaque', 'mask', 'blend', 'add']);
const WATER_MATERIAL_FIELDS = Object.freeze([
  'waterPreset', 'absorption', 'turbidity', 'foamEdge', 'foamWidth', 'foamColor', 'foamVeins', 'contactFoam', 'caustics', 'ripples', 'waterRamp',
]);
const SAFE_MATERIAL_FIELDS = new Set([
  'tag', 'color', 'metallic', 'roughness', 'emission', 'emissiveColor',
  'opacity', 'alphaMode', 'alphaCutoff', 'doubleSided', 'depthTest',
  'normalScale', 'occlusionStrength', 'toonColors',
  ...MATERIAL_LAYER_FIELDS,
  ...WATER_MATERIAL_FIELDS,
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteFloat32(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError(`${label} must be a finite number that fits Float32, such as 0.5.`);
  }
  return value;
}

function vectorOfLength(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must be an array of ${length} numbers.`);
  }
  return value.map((component, index) => finiteFloat32(component, `${label}[${index}]`));
}

function validateUnitScalar(value, label) {
  finiteFloat32(value, label);
  if (value < 0 || value > 1) {
    throw new RangeError(`${label} must be a number from 0 to 1, such as 0.5.`);
  }
}

function validateMaterialOverride(materialName, override) {
  const prefix = `materials.${materialName}`;
  if (!isPlainObject(override)) {
    throw new TypeError(`scene.json "${prefix}" must be a plain object of material fields, such as { "tag": "water", "roughness": 0.05 }.`);
  }
  for (const field of Object.keys(override)) {
    if (!SAFE_MATERIAL_FIELDS.has(field)) {
      throw new TypeError(`scene.json "${prefix}.${field}" is not a supported material override field; use one of ${[...SAFE_MATERIAL_FIELDS].join(', ')}.`);
    }
  }
  if (override.tag !== undefined && (typeof override.tag !== 'string' || !VALID_MATERIAL_TAGS.has(override.tag))) {
    throw new RangeError(`${prefix}.tag must be one of ${[...VALID_MATERIAL_TAGS].join(', ')}.`);
  }
  if (override.color !== undefined) {
    const color = vectorOfLength(override.color, 3, `${prefix}.color`);
    if (color.some(component => component < 0 || component > 1)) {
      throw new RangeError(`${prefix}.color must be three numbers from 0 to 1, such as [0.2, 0.5, 0.7].`);
    }
  }
  if (override.emissiveColor !== undefined) {
    const emissiveColor = vectorOfLength(override.emissiveColor, 3, `${prefix}.emissiveColor`);
    if (emissiveColor.some(component => component < 0)) {
      throw new RangeError(`${prefix}.emissiveColor must be three numbers of 0 or more, such as [1, 0.5, 0.2].`);
    }
  }
  for (const field of ['metallic', 'roughness', 'opacity', 'alphaCutoff', 'occlusionStrength']) {
    if (override[field] !== undefined) {
      validateUnitScalar(override[field], `${prefix}.${field}`);
    }
  }
  if (override.emission !== undefined) {
    finiteFloat32(override.emission, `${prefix}.emission`);
    if (override.emission < 0) {
      throw new RangeError(`${prefix}.emission must be a number of 0 or more, such as 1.`);
    }
  }
  if (override.alphaMode !== undefined && (typeof override.alphaMode !== 'string' || !ALPHA_MODES.has(override.alphaMode))) {
    throw new RangeError(`${prefix}.alphaMode must be one of ${[...ALPHA_MODES].join(', ')}.`);
  }
  for (const field of ['doubleSided', 'depthTest']) {
    if (override[field] !== undefined && typeof override[field] !== 'boolean') {
      throw new TypeError(`${prefix}.${field} must be true or false.`);
    }
  }
  if (override.normalScale !== undefined) {
    vectorOfLength(override.normalScale, 2, `${prefix}.normalScale`);
  }
  for (const field of ['attenuationColor', 'sheenColor', 'specularColor']) {
    if (override[field] !== undefined) {
      vectorOfLength(override[field], 3, `${prefix}.${field}`);
    }
  }
  if (override.toonColors !== undefined) {
    if (!Array.isArray(override.toonColors)) {
      throw new TypeError(`${prefix}.toonColors must be an array of [red, green, blue] colours.`);
    }
    override.toonColors.forEach((color, index) => vectorOfLength(color, 3, `${prefix}.toonColors[${index}]`));
  }
}

// Procedural tags and unlit only draw a subset of PBR maps; drop incompatible source maps when an override switches tag.
function stripIncompatibleMaps(material) {
  if (material.tag === 'unlit') {
    delete material.normalMap;
    delete material.metallicRoughnessMap;
    delete material.occlusionMap;
    return;
  }
  if (!PROCEDURAL_MATERIAL_TAGS.has(material.tag)) {
    return;
  }
  if (!SWAYING_MATERIAL_TAGS.has(material.tag)) {
    delete material.normalMap;
  }
  delete material.metallicRoughnessMap;
  delete material.occlusionMap;
  delete material.emissiveMap;
  delete material.layers;
}

function needsWaterShader(sourceMaterial, override) {
  return sourceMaterial?.tag === 'water'
    || override?.tag === 'water'
    || WATER_MATERIAL_FIELDS.some(field => override?.[field] !== undefined);
}

function mergeMaterialOverride(sourceMaterial, override, worldMaterials) {
  const merged = { ...sourceMaterial };
  for (const field of Object.keys(override)) {
    if (WATER_MATERIAL_FIELDS.includes(field)) {
      continue;
    }
    const value = override[field];
    if (field === 'toonColors') {
      merged.toonColors = value.map(color => [...color]);
      continue;
    }
    merged[field] = Array.isArray(value) ? [...value] : value;
  }
  if (override.opacity !== undefined && merged.opacity < 1 && override.alphaMode === undefined && merged.alphaMode === 'opaque') {
    merged.alphaMode = 'blend';
  }
  stripIncompatibleMaps(merged);
  validateMaterialLayers(merged);
  if (needsWaterShader(sourceMaterial, override)) {
    if (!worldMaterials?.copyWaterFields) {
      throw new Error('water material overrides require world-material-shader.js (copyWaterFields).');
    }
    const waterInput = {
      ...(sourceMaterial?.tag === 'water' && override.waterPreset === undefined
        ? { waterPreset: sourceMaterial.waterPreset, absorption: sourceMaterial.absorption, turbidity: sourceMaterial.turbidity }
        : {}),
      ...override,
    };
    worldMaterials.copyWaterFields(waterInput, merged, vectorOfLength);
    if (worldMaterials.copyWaterRamp) {
      worldMaterials.copyWaterRamp(waterInput, merged, vectorOfLength);
    }
  }
  return Object.freeze(merged);
}

/**
 * Returns true when any override in `overrides` (or a matched water source part when `parts` is passed) needs `world-material-shader.js`.
 */
export function needsWorldMaterialsForOverrides(overrides, parts = null) {
  if (overrides === undefined || overrides === null) return false;
  if (!isPlainObject(overrides)) {
    throw new TypeError('scene.json "materials" must be a plain object keyed by glTF material name, such as { "Water": { "tag": "water" } }.');
  }
  if (Object.values(overrides).some(entry => Boolean(entry && (WORLD_MATERIAL_TAGS.has(entry.tag) || WATER_MATERIAL_FIELDS.some(field => entry[field] !== undefined))))) {
    return true;
  }
  if (!Array.isArray(parts)) return false;
  return parts.some(part => {
    const materialName = part.material?.name;
    return typeof materialName === 'string' && Object.hasOwn(overrides, materialName) && needsWaterShader(part.material, overrides[materialName]);
  });
}

/**
 * Applies named `materials` overrides from a `scene.json` onto decoded glTF parts before water reflection runs.
 * Returns `{ parts, replaced }` where `replaced` maps each overridden input part to its updated copy, preserving shared material identity.
 */
export function applyFileSceneMaterialOverridesWithReplacements(parts, overrides, worldMaterials = null) {
  if (overrides === undefined) {
    return { parts, replaced: new Map() };
  }
  if (!isPlainObject(overrides)) {
    throw new TypeError('scene.json "materials" must be a plain object keyed by glTF material name, such as { "Water": { "tag": "water" } }.');
  }
  for (const [materialName, override] of Object.entries(overrides)) {
    validateMaterialOverride(materialName, override);
  }
  if (Object.keys(overrides).length === 0) {
    return { parts, replaced: new Map() };
  }
  const mergedBySource = new Map();
  const replaced = new Map();
  const updatedParts = parts.map((part) => {
    const materialName = part.material?.name;
    if (typeof materialName !== 'string' || !Object.hasOwn(overrides, materialName)) {
      return part;
    }
    let mergedMaterial = mergedBySource.get(part.material);
    if (!mergedMaterial) {
      mergedMaterial = mergeMaterialOverride(part.material, overrides[materialName], worldMaterials);
      mergedBySource.set(part.material, mergedMaterial);
    }
    const updatedPart = Object.freeze({ ...part, material: mergedMaterial });
    replaced.set(part, updatedPart);
    return updatedPart;
  });
  return { parts: updatedParts, replaced };
}

/**
 * Applies named `materials` overrides from a `scene.json` onto decoded glTF parts before water reflection runs.
 */
export function applyFileSceneMaterialOverrides(parts, overrides, worldMaterials = null) {
  if (overrides === undefined || overrides === null) return parts;
  const { parts: updatedParts } = applyFileSceneMaterialOverridesWithReplacements(parts, overrides, worldMaterials);
  return updatedParts === parts ? parts : Object.freeze(updatedParts);
}

/**
 * Returns `gltfOptions` for `loadGltf`. When `gltfOptions.maxTexturePixels` is omitted and `renderer.memoryBudgetMiB` exceeds
 * the 384 MiB default, the default pixel budget scales proportionally with `memoryBudgetMiB`.
 */
export function resolveFileSceneGltfOptions(description) {
  if (description?.gltfOptions !== undefined && !isPlainObject(description.gltfOptions)) {
    throw new TypeError('scene.json "gltfOptions" must be a plain object.');
  }
  const gltfOptions = { ...(description?.gltfOptions ?? {}) };
  const memoryBudgetMiB = description?.renderer?.memoryBudgetMiB;
  if (gltfOptions.maxTexturePixels === undefined && typeof memoryBudgetMiB === 'number' && Number.isFinite(memoryBudgetMiB) && memoryBudgetMiB > DEFAULT_MEMORY_BUDGET_MIB) {
    gltfOptions.maxTexturePixels = Math.round(GLTF_CAPABILITIES.limits.maxTexturePixels * (memoryBudgetMiB / DEFAULT_MEMORY_BUDGET_MIB));
  }
  return gltfOptions;
}

/** Combines warning lists from the primary GLB and any `glbRest` files, keeping the first occurrence of each message. */
export function collectFileSceneWarnings(...warningLists) {
  const collected = [];
  for (const list of warningLists) {
    for (const warning of list ?? []) {
      if (!collected.includes(warning)) {
        collected.push(warning);
      }
    }
  }
  return collected;
}

/** Logs every glTF load warning via `console.warn` (or a supplied logger in tests). */
export function reportFileSceneWarnings(warnings, log = console.warn) {
  for (const warning of warnings) {
    log(warning);
  }
}

/**
 * Logs glTF decode warnings (such as maxTexturePixels downscaling or mesh repairs) so `--scene file` runs never drop them silently.
 */
export function logGltfWarnings(warnings, warn = console.warn) {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  for (const warning of warnings) {
    warn(`glTF: ${warning}`);
  }
}
