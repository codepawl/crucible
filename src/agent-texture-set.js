import { createImage } from './material-texture-kit.js';
import { invalidField } from './field-error.js';
import { HEIGHT_PARALLAX_FIELDS, HEIGHT_PARALLAX_LIMITS, NORMAL_CONVENTIONS, TEXTURE_MAP_FIELDS, UV_TRANSFORM_FIELDS, UV_TRANSFORM_LIMITS } from './texture-set-fields.js';

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
  applyUvTransform(value, result, used.length > 0 || value.map !== undefined);
  const usesParallax = HEIGHT_PARALLAX_FIELDS.some(field => value[field] !== undefined);
  if (used.length === 0 && value.normalConvention === undefined && !usesParallax) return;
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
  if (usesParallax) applyHeightParallax(value, result);
}

const HEIGHT_EXAMPLES = Object.freeze({ heightScale: '0.02 (2 cm deep)', heightFade: '12 (metres)', heightSteps: '16' });

/** Each parallax field sits inside its limits (heightSteps is a whole number), with or without a heightMap, and the fields need a heightMap. The module that draws the relief is not loaded for this. */
function applyHeightParallax(value, result) {
  const named = HEIGHT_PARALLAX_FIELDS.find(field => value[field] !== undefined);
  if (value.heightScale !== undefined) result.heightScale = checkedNumber('heightScale', value.heightScale, HEIGHT_PARALLAX_LIMITS.scale, HEIGHT_EXAMPLES.heightScale);
  if (value.heightFade !== undefined) result.heightFade = checkedNumber('heightFade', value.heightFade, HEIGHT_PARALLAX_LIMITS.fade, HEIGHT_EXAMPLES.heightFade);
  if (value.heightSteps !== undefined) {
    if (!Number.isInteger(value.heightSteps)) throw invalidField('heightSteps', value.heightSteps, `a whole number ${rangeText(HEIGHT_PARALLAX_LIMITS.steps)}, such as ${HEIGHT_EXAMPLES.heightSteps}`);
    result.heightSteps = checkedNumber('heightSteps', value.heightSteps, HEIGHT_PARALLAX_LIMITS.steps, HEIGHT_EXAMPLES.heightSteps);
  }
  if (value.heightMap === undefined) throw invalidField(named, value[named], 'a material that sets heightMap; add the height map, or remove the parallax fields');
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

const DEGREES_TO_RADIANS = Math.PI / 180;

function rangeText([minimum, maximum]) {
  return `from ${minimum} to ${maximum}`;
}

function checkedNumber(field, value, [minimum, maximum], example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(field, value, `a number ${rangeText([minimum, maximum])}, such as ${example}`);
  }
  return value;
}

function checkedPair(field, value, limits, example, componentExample) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(field, value, `two numbers [u, v] ${rangeText(limits)}, such as ${example}`, TypeError);
  }
  return value.map((component, index) => checkedNumber(`${field}[${index}]`, component, limits, componentExample));
}

/**
 * Validates the UV transform fields of a recipe material and stores them on `result`, in the order the glTF KHR_texture_transform
 * applies them: scale, then rotation (degrees), then offset, for every map of the material together. `uvScale` is one number or [u, v].
 * `worldScale` is the metres one texture tile covers, so the tile size does not depend on the mesh size. Absent fields store nothing.
 */
export function applyUvTransform(value, result, hasMaps) {
  const given = UV_TRANSFORM_FIELDS.filter(field => value[field] !== undefined);
  if (given.length === 0) return;
  if (!hasMaps) throw invalidField(given[0], value[given[0]], 'a material that sets colorMap or another catalog map; the UV transform moves those maps, so add a map or remove the UV fields');
  if (value.uvScale !== undefined && value.worldScale !== undefined) {
    throw invalidField('worldScale', value.worldScale, 'nothing next to uvScale: worldScale sets the tile size in metres, uvScale the tile count; keep one of them', TypeError);
  }
  const limits = UV_TRANSFORM_LIMITS;
  if (value.uvScale !== undefined) {
    if (typeof value.uvScale === 'number') {
      const tiles = checkedNumber('uvScale', value.uvScale, limits.scale, 50);
      result.uvScale = [tiles, tiles];
    } else {
      result.uvScale = checkedPair('uvScale', value.uvScale, limits.scale, '[50, 50] or 50', 50);
    }
  }
  if (value.uvOffset !== undefined) result.uvOffset = checkedPair('uvOffset', value.uvOffset, limits.offset, '[0.25, 0]', 0.25);
  if (value.uvRotation !== undefined) result.uvRotation = checkedNumber('uvRotation', value.uvRotation, limits.rotation, 45);
  if (value.worldScale !== undefined) {
    // One number is a square tile; [u, v] sizes the two sides apart, such as a 4 m by 0.5 m plank.
    result.worldScale = Array.isArray(value.worldScale)
      ? checkedPair('worldScale', value.worldScale, limits.worldScale, '[4, 0.5]', 2)
      : checkedNumber('worldScale', value.worldScale, limits.worldScale, 2);
  }
}

/** Whether a recipe material changes the UVs at all: a transform of scale 1, offset 0 and rotation 0 leaves the geometry as it is. */
export function changesUvs(material) {
  if (material?.worldScale !== undefined) return true;
  const [scaleU, scaleV] = material?.uvScale ?? [1, 1];
  const [offsetU, offsetV] = material?.uvOffset ?? [0, 0];
  return scaleU !== 1 || scaleV !== 1 || offsetU !== 0 || offsetV !== 0 || (material?.uvRotation ?? 0) !== 0;
}

function columnScale(matrix) {
  if (!matrix) return [1, 1, 1];
  return [0, 4, 8].map(offset => Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2]));
}

/** Metres one UV unit spans on the drawn mesh: the square root of the world area over the UV area of its triangles. */
function metresPerUvUnit(geometry, scale) {
  const { positions, indices, uvs } = geometry;
  let worldArea = 0;
  let uvArea = 0;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [first, second, third] = [0, 1, 2].map(corner => indices[triangle + corner]);
    const edgeA = [0, 1, 2].map(axis => (positions[second * 3 + axis] - positions[first * 3 + axis]) * scale[axis]);
    const edgeB = [0, 1, 2].map(axis => (positions[third * 3 + axis] - positions[first * 3 + axis]) * scale[axis]);
    worldArea += Math.hypot(edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]) / 2;
    const [uA, vA] = [uvs[second * 2] - uvs[first * 2], uvs[second * 2 + 1] - uvs[first * 2 + 1]];
    const [uB, vB] = [uvs[third * 2] - uvs[first * 2], uvs[third * 2 + 1] - uvs[first * 2 + 1]];
    uvArea += Math.abs(uA * vB - uB * vA) / 2;
  }
  return uvArea > 0 ? Math.sqrt(worldArea / uvArea) : 0;
}

function linearPart(matrix) {
  return matrix ? [0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => Math.round(matrix[index] * 1e6) / 1e6) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Metres one UV unit spans along u and along v on the drawn mesh, measured through the whole world matrix (rotation and
 * parent scale included): the world length of each triangle's u and v directions, weighted by the UV area it covers.
 */
export function metresPerUvAxis(geometry, worldMatrix) {
  const { positions, indices, uvs } = geometry;
  const columns = linearPart(worldMatrix);
  const toWorld = vertex => [0, 1, 2].map(row => columns[row] * positions[vertex * 3] + columns[3 + row] * positions[vertex * 3 + 1] + columns[6 + row] * positions[vertex * 3 + 2]);
  let uvArea = 0;
  let sumU = 0;
  let sumV = 0;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [first, second, third] = [0, 1, 2].map(corner => indices[triangle + corner]);
    const origin = toWorld(first);
    const edgeA = toWorld(second).map((value, axis) => value - origin[axis]);
    const edgeB = toWorld(third).map((value, axis) => value - origin[axis]);
    const [uA, vA] = [uvs[second * 2] - uvs[first * 2], uvs[second * 2 + 1] - uvs[first * 2 + 1]];
    const [uB, vB] = [uvs[third * 2] - uvs[first * 2], uvs[third * 2 + 1] - uvs[first * 2 + 1]];
    const determinant = uA * vB - uB * vA;
    if (determinant === 0) continue;
    const alongU = [0, 1, 2].map(axis => (edgeA[axis] * vB - edgeB[axis] * vA) / determinant);
    const alongV = [0, 1, 2].map(axis => (edgeB[axis] * uA - edgeA[axis] * uB) / determinant);
    const weight = Math.abs(determinant);
    uvArea += weight;
    sumU += weight * Math.hypot(...alongU);
    sumV += weight * Math.hypot(...alongV);
  }
  return uvArea > 0 ? [sumU / uvArea, sumV / uvArea] : [0, 0];
}

const transformedByGeometry = new WeakMap();

/**
 * The geometry with the material's UV transform baked into its first UV channel, the way the glTF loader bakes KHR_texture_transform:
 * the renderers, the path tracers and the exports all read the same UVs. Cached per source geometry and transform, so a part keeps its
 * identity between rebuilds. A transform that changes nothing returns the geometry itself. `worldMatrix` gives worldScale the mesh size.
 */
export function geometryWithUvTransform(geometry, material, worldMatrix, nodeId) {
  if (!changesUvs(material)) return geometry;
  if (!geometry.uvs) throw invalidField('uvScale', nodeId, `a mesh with UVs; node ${nodeId} has none, so use a geometry that has UVs or remove the UV fields from its material`);
  const scale = columnScale(worldMatrix);
  const sizeKey = Array.isArray(material.worldScale) ? linearPart(worldMatrix) : scale;
  const key = [material.uvScale, material.uvOffset, material.uvRotation, material.worldScale, material.worldScale === undefined ? '' : sizeKey].join('|');
  let variants = transformedByGeometry.get(geometry);
  if (!variants) {
    variants = new Map();
    transformedByGeometry.set(geometry, variants);
  }
  let transformed = variants.get(key);
  if (!transformed) {
    // The baked UVs move the tangent frame of a mapped normal, so authored tangents no longer fit.
    transformed = { ...geometry, uvs: bakedUvs(geometry, material, scale, nodeId, worldMatrix), tangents: undefined };
    variants.set(key, transformed);
  }
  return transformed;
}

function bakedUvs(geometry, material, scale, nodeId, worldMatrix) {
  let [scaleU, scaleV] = material.uvScale ?? [1, 1];
  if (Array.isArray(material.worldScale)) {
    const metres = metresPerUvAxis(geometry, worldMatrix);
    if (!(metres[0] > 0 && metres[1] > 0)) throw invalidField('worldScale', material.worldScale, `a mesh whose UVs cover an area along both sides; node ${nodeId} has degenerate UVs, so remove worldScale or fix the UVs`);
    scaleU = metres[0] / material.worldScale[0];
    scaleV = metres[1] / material.worldScale[1];
  } else if (material.worldScale !== undefined) {
    const metres = metresPerUvUnit(geometry, scale);
    if (!(metres > 0)) throw invalidField('worldScale', material.worldScale, `a mesh whose UVs cover an area; node ${nodeId} has degenerate UVs, so remove worldScale or fix the UVs`);
    scaleU = metres / material.worldScale;
    scaleV = scaleU;
  }
  const rotation = (material.uvRotation ?? 0) * DEGREES_TO_RADIANS;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const [offsetU, offsetV] = material.uvOffset ?? [0, 0];
  const uvs = new Float32Array(geometry.uvs.length);
  for (let index = 0; index < uvs.length; index += 2) {
    const u = geometry.uvs[index];
    const v = geometry.uvs[index + 1];
    uvs[index] = cosine * scaleU * u + sine * scaleV * v + offsetU;
    uvs[index + 1] = -sine * scaleU * u + cosine * scaleV * v + offsetV;
  }
  return uvs;
}
