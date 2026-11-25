// Per-material overrides and glTF loader warnings for headless scene files (--scene file).

export const WORLD_MATERIAL_TAGS = Object.freeze(new Set(['water', 'foliage', 'grass', 'terrain', 'fire', 'smoke']));

const FILE_SCENE_MATERIAL_FIELDS = Object.freeze([
  'tag',
  'color',
  'roughness',
  'metallic',
  'opacity',
  'alphaMode',
  'doubleSided',
  'transmission',
  'ior',
  'thickness',
  'attenuationColor',
  'attenuationDistance',
]);

const PROCEDURAL_STRIPPED_MAPS = Object.freeze([
  'normalMap',
  'metallicRoughnessMap',
  'occlusionMap',
  'emissiveMap',
]);

function assertOverridesObject(overrides) {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new TypeError('scene.materials must be a plain object mapping material names to override fields.');
  }
}

/**
 * Returns true when any override in `overrides` assigns a world material tag that needs `world-material-shader.js`.
 */
export function needsWorldMaterialsForOverrides(overrides) {
  if (overrides === undefined || overrides === null) return false;
  assertOverridesObject(overrides);
  return Object.values(overrides).some(entry => Boolean(entry && WORLD_MATERIAL_TAGS.has(entry.tag)));
}

/**
 * Applies named `materials` overrides from a `scene.json` onto decoded glTF parts before water reflection runs.
 */
export function applyFileSceneMaterialOverrides(parts, overrides, worldMaterials = null) {
  if (overrides === undefined || overrides === null) return parts;
  assertOverridesObject(overrides);
  if (Object.keys(overrides).length === 0) return parts;
  return Object.freeze(parts.map((part) => {
    const override = overrides[part.material?.name];
    if (!override || typeof override !== 'object' || Array.isArray(override)) return part;
    const nextMaterial = { ...part.material };
    for (const field of FILE_SCENE_MATERIAL_FIELDS) {
      if (override[field] !== undefined) nextMaterial[field] = override[field];
    }
    if (WORLD_MATERIAL_TAGS.has(nextMaterial.tag)) {
      for (const mapField of PROCEDURAL_STRIPPED_MAPS) delete nextMaterial[mapField];
    }
    if (nextMaterial.tag === 'water') {
      if (!worldMaterials?.copyWaterFields) {
        throw new Error('water material overrides require world-material-shader.js (copyWaterFields).');
      }
      worldMaterials.copyWaterFields(override, nextMaterial, value => value);
    }
    return Object.freeze({ ...part, material: Object.freeze(nextMaterial) });
  }));
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
