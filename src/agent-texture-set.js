import { createImage } from './material-texture-kit.js';
import { invalidField } from './field-error.js';
import { NORMAL_CONVENTIONS, TEXTURE_MAP_FIELDS } from './texture-set-fields.js';

// Scanned PBR maps on a recipe material: `colorMap`, `normalMap`, `roughnessMap`, `metallicMap`, `occlusionMap` and `heightMap`
// each take a catalog image asset ID (the MCP server turns `textureSet: "<name>"` into those IDs before the scene is built).
// The host decodes the images into the same pool as texture sequence frames. The renderer's textures are made from them here:
// the normal map with its green channel flipped for DirectX, roughness and metallic repacked into the glTF channel layout.

const ASSET_ID = /^[a-f0-9]{64}$/;
const BYTES_PER_PIXEL = 4;

/** The catalog image IDs a material (a recipe material, or any object with the map fields) names, in field order. */
export function textureMapIds(material) {
  const ids = [];
  for (const field of TEXTURE_MAP_FIELDS) {
    const id = material?.[field];
    if (typeof id === 'string' && ASSET_ID.test(id.toLowerCase())) ids.push(id.toLowerCase());
  }
  return ids;
}

/** Whether a recipe material uses any of the catalog map fields. */
export function usesTextureMaps(material) {
  return TEXTURE_MAP_FIELDS.some(field => material?.[field] !== undefined) || material?.textureSet !== undefined;
}

/**
 * Validates the catalog map fields of a recipe material against the rest of it and stores them on `result` (IDs in lower case).
 * `textureSet` is not stored: the MCP server replaces it with the maps, so a library caller passes the map fields itself.
 */
export function applyTextureMaps(value, result) {
  if (value.textureSet !== undefined) {
    throw invalidField('textureSet', value.textureSet, 'a recipe with the maps already filled in: the MCP server swaps textureSet for the catalog image IDs of its maps, so a library caller passes colorMap, normalMap, roughnessMap, metallicMap, occlusionMap and heightMap itself');
  }
  const used = TEXTURE_MAP_FIELDS.filter(field => value[field] !== undefined);
  if (used.length === 0 && value.normalConvention === undefined) return;
  if (result.tag !== 'surface') throw invalidField(used[0] ?? 'normalConvention', value[used[0]], 'a material with the surface tag; remove the map fields or use the surface tag');
  if (value.pattern !== undefined) throw invalidField(used[0] ?? 'normalConvention', value[used[0]], 'nothing, because a material takes a pattern or catalog maps, not both', TypeError);
  if (value.colorMap !== undefined && value.map !== undefined) throw invalidField('colorMap', value.colorMap, 'nothing, because the colour map is either a map sequence or a catalog colorMap, not both', TypeError);
  for (const field of used) {
    const id = value[field];
    if (typeof id !== 'string' || !ASSET_ID.test(id.toLowerCase())) {
      throw invalidField(field, id, 'the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists them, and a textureSet entry lists its maps', TypeError);
    }
    result[field] = id.toLowerCase();
  }
  if (value.normalConvention !== undefined) {
    if (!NORMAL_CONVENTIONS.includes(value.normalConvention)) throw invalidField('normalConvention', value.normalConvention, `one of ${NORMAL_CONVENTIONS.join(', ')}`, TypeError);
    if (value.normalMap === undefined) throw invalidField('normalConvention', value.normalConvention, 'a material that sets normalMap; add the normal map, or remove normalConvention');
    result.normalConvention = value.normalConvention;
  }
}

function sameSize(left, right) {
  return left.width === right.width && left.height === right.height;
}

/** A copy of a decoded normal map with the green channel flipped: DirectX (Y down) becomes OpenGL (Y up), which the renderers read. */
export function flipNormalGreen(frame) {
  const data = new Uint8ClampedArray(frame.data);
  for (let offset = 1; offset < data.length; offset += BYTES_PER_PIXEL) data[offset] = 255 - data[offset];
  return { width: frame.width, height: frame.height, data };
}

/**
 * One glTF metallicRoughness image from grey roughness and metallic images: green holds the roughness, blue the metallic, red is
 * 255 and alpha is 255. A missing image fills its channel with 255, so the material's own factor scales it.
 */
export function repackMetallicRoughness(roughness, metallic) {
  const source = roughness ?? metallic;
  if (roughness && metallic && !sameSize(roughness, metallic)) {
    throw invalidField('metallicMap', `${metallic.width}x${metallic.height}`, `an image of the roughnessMap size, ${roughness.width}x${roughness.height}; resize one of the two in the catalog so the maps share one size`);
  }
  const pixelCount = source.width * source.height;
  const data = new Uint8ClampedArray(pixelCount * BYTES_PER_PIXEL);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * BYTES_PER_PIXEL;
    data[offset] = 255;
    data[offset + 1] = roughness ? roughness.data[offset] : 255;
    data[offset + 2] = metallic ? metallic.data[offset] : 255;
    data[offset + 3] = 255;
  }
  return { width: source.width, height: source.height, data };
}

function descriptorOf(frame, colorSpace) {
  return { image: createImage(frame.data, frame.width, frame.height), colorSpace };
}

/**
 * The texture descriptors of one material's catalog maps, built on first use: `{ map, normalMap, metallicRoughnessMap, occlusionMap,
 * heightMap }`, each present only when the material names it. `pool` maps catalog image IDs to decoded `{ width, height, data }`.
 */
export function createTextureMaps(materialId, material, pool) {
  const frameOf = field => {
    const id = material[field];
    const frame = pool?.get(id);
    if (!frame) throw new Error(`Material ${materialId}: ${field} image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`);
    return frame;
  };
  const textures = {};
  if (material.colorMap) textures.map = descriptorOf(frameOf('colorMap'), 'srgb');
  if (material.normalMap) {
    const normal = frameOf('normalMap');
    textures.normalMap = descriptorOf(material.normalConvention === 'directx' ? flipNormalGreen(normal) : normal, 'linear');
  }
  if (material.roughnessMap || material.metallicMap) {
    textures.metallicRoughnessMap = descriptorOf(repackMetallicRoughness(material.roughnessMap && frameOf('roughnessMap'), material.metallicMap && frameOf('metallicMap')), 'linear');
  }
  if (material.occlusionMap) textures.occlusionMap = descriptorOf(frameOf('occlusionMap'), 'linear');
  if (material.heightMap) textures.heightMap = descriptorOf(frameOf('heightMap'), 'linear');
  return textures;
}
