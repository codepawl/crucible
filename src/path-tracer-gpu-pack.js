import { DATA_TEXTURE_WIDTH, TRIANGLE_TEXELS, MATERIAL_TEXELS, LIGHT_TEXELS } from './path-tracer-gpu-shader.js';
import { buildLightTree, LIGHT_TREE_NODE_TEXELS } from './path-tracer-light-tree.js';
import { SUBSURFACE_TEXELS } from './path-tracer-gpu-subsurface.js';

// Lays a traced scene (path-tracer-scene.js) out as the float textures the GPU kernel reads. Everything here is plain
// typed arrays, so it runs and is tested without a GPU. Each table is a run of RGBA texels, DATA_TEXTURE_WIDTH to a row.

export const ATLAS_WIDTH = 4096;
const MAXIMUM_TEXTURE_SIZE = 16384;

const TRIANGLE_BYTES = TRIANGLE_TEXELS * 16;

/**
 * How many triangles a device can hold in the tables above. The triangle table is the largest: TRIANGLE_TEXELS RGBA32F
 * texels each, DATA_TEXTURE_WIDTH to a row, so a WebGL2 texture of `maximumTextureSize` rows holds
 * maximumTextureSize * DATA_TEXTURE_WIDTH / TRIANGLE_TEXELS triangles (3,355,443 at the usual 16384). The BVH table needs
 * four texels a triangle at most and the other tables stay small, so the triangle table decides. A WebGPU storage buffer of
 * `maximumBufferBytes` (and `maximumBufferSize`, when given) holds that many whole table rows of triangles. Pass what the device reports; the result is also capped
 * at `ceiling`, the most the tracers hold on any device (MAX_GPU_TRACE_TRIANGLES).
 */
export function gpuTriangleCapacity({ maximumTextureSize, maximumBufferBytes, maximumBufferSize }, ceiling) {
  const capacities = [ceiling];
  if (maximumTextureSize !== undefined) {
    const rows = Math.min(maximumTextureSize, MAXIMUM_TEXTURE_SIZE);
    capacities.push(Math.floor((rows * DATA_TEXTURE_WIDTH) / TRIANGLE_TEXELS));
  }
  if (maximumBufferBytes !== undefined) {
    // The upload pads the table to whole rows, so the buffer is counted in rows and one more row never tips it over the limit.
    const rowBytes = DATA_TEXTURE_WIDTH * 16;
    const usableBytes = Math.min(maximumBufferBytes, maximumBufferSize ?? Infinity);
    capacities.push(Math.floor((Math.floor(usableBytes / rowBytes) * DATA_TEXTURE_WIDTH) / TRIANGLE_TEXELS));
  }
  return Math.max(1, Math.min(...capacities));
}

/** A table of `texelCount` RGBA texels, padded to whole rows. */
export function createTable(texelCount, channels = 4) {
  const rows = Math.max(1, Math.ceil(texelCount / DATA_TEXTURE_WIDTH));
  if (rows > MAXIMUM_TEXTURE_SIZE) throw new RangeError('The scene is too large for the GPU path tracer tables.');
  return { width: DATA_TEXTURE_WIDTH, height: rows, channels, data: new Float32Array(DATA_TEXTURE_WIDTH * rows * channels) };
}

/** Two texels per node: (minimum, -leaf triangle count or right child) and (maximum, first triangle slot). */
export function packNodes(bvh) {
  const table = createTable(bvh.nodeCount * 2);
  const { data } = table;
  for (let node = 0; node < bvh.nodeCount; node++) {
    const target = node * 8;
    for (let axis = 0; axis < 3; axis++) {
      data[target + axis] = bvh.nodeBounds[node * 6 + axis];
      data[target + 4 + axis] = bvh.nodeBounds[node * 6 + 3 + axis];
    }
    const right = bvh.rightChild[node];
    data[target + 3] = right < 0 ? -bvh.rangeCount[node] : right;
    data[target + 7] = bvh.rangeStart[node];
  }
  return table;
}

// Material texel 5, third channel: a bit per map that is set when the map reads TEXCOORD_1 (bit 0 base colour, 1 normal, 2 surface, 3 emissive).
export const UV_SET_SLOT = 22;
const GPU_MAP_FIELDS = ['texture', 'normalTexture', 'surfaceTexture', 'emissiveTexture'];
const GPU_MAP_UV_BITS = [['texture', 1], ['normalTexture', 2], ['surfaceTexture', 4], ['emissiveTexture', 8]];

/** The bit mask of the maps of a material that read TEXCOORD_1; 0 when every map reads TEXCOORD_0. */
export function materialUvSetMask(material) {
  let mask = 0;
  for (const [field, bit] of GPU_MAP_UV_BITS) {
    if (material[field]?.uvSet === 1) mask |= bit;
  }
  return mask;
}

/**
 * The UV set the native v1 record carries in its single UV pair per corner: the base colour's set, or the first map's when there is
 * no base colour. The native export, its fallback and the native light bake read that pair for every map of the material.
 */
export function materialUvSet(material) {
  const first = GPU_MAP_FIELDS.map(field => material[field]).find(Boolean);
  return first?.uvSet === 1 ? 1 : 0;
}

/** The triangle record of the native Cook tracer: nine texels, no second UV set. Cook reads it with a fixed stride of 36 floats. */
export const NATIVE_TRIANGLE_TEXELS = 9;

/**
 * Nine texels per triangle by default, the record the native tracer reads (Cook walks it with a fixed stride). That record keeps its
 * old meaning: the UV pair in the normal and colour texels is the set `materialUvSet` names for the triangle's material. The WebGL and WebGPU
 * tracers pass `{ secondUvSet: true }` for ten texels per triangle in leaf order: corner and material, two edges, three normals with u, three colours with v, then the second
 * UV set. TEXCOORD_0 always sits in the w of the normal and colour texels. TEXCOORD_1 sits in texel 9 (u and v of the first two corners)
 * and in the w of the two edge texels (u and v of the third corner), which no kernel reads as geometry. A scene without a second set
 * leaves those floats at 0 and no material asks for them.
 */
export function packTriangles(scene, { secondUvSet = false } = {}) {
  const texelsPerTriangle = secondUvSet ? TRIANGLE_TEXELS : NATIVE_TRIANGLE_TEXELS;
  const table = createTable(scene.bvh.triangleOrder.length * texelsPerTriangle);
  writeTriangles(table.data, 0, scene, { secondUvSet });
  return table;
}

/** One texel per triangle slot, in leaf order: the COLOR_0 alpha of its three corners. Null for a scene whose parts carry none. */
export function packVertexAlpha(scene) {
  if (!scene.vertexAlpha) return null;
  const order = scene.bvh.triangleOrder;
  const table = createTable(order.length);
  for (let slot = 0; slot < order.length; slot++) {
    for (let corner = 0; corner < 3; corner++) {
      table.data[slot * 4 + corner] = scene.vertexAlpha[scene.indices[order[slot] * 3 + corner]];
    }
  }
  return table;
}

/** Writes the triangles of `scene` in leaf order into `data`, starting at triangle slot `firstSlot`. */
export function writeTriangles(data, firstSlot, scene, { secondUvSet = false } = {}) {
  const { positions, normals, uvs, uvs1, colors, indices, triangleMaterial, bvh } = scene;
  const order = bvh.triangleOrder;
  const nativeSecondSetMaterials = !secondUvSet && uvs1 ? scene.materials?.map(materialUvSet) : null;
  const texelsPerTriangle = secondUvSet ? TRIANGLE_TEXELS : NATIVE_TRIANGLE_TEXELS;
  for (let slot = 0; slot < order.length; slot++) {
    const triangle = order[slot];
    const base = (firstSlot + slot) * texelsPerTriangle * 4;
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    const uvSource = nativeSecondSetMaterials?.[triangleMaterial[triangle]] === 1 ? uvs1 : uvs;
    for (let axis = 0; axis < 3; axis++) {
      const origin = positions[corners[0] * 3 + axis];
      data[base + axis] = origin;
      data[base + 4 + axis] = positions[corners[1] * 3 + axis] - origin;
      data[base + 8 + axis] = positions[corners[2] * 3 + axis] - origin;
    }
    data[base + 3] = triangleMaterial[triangle];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = corners[corner];
      for (let axis = 0; axis < 3; axis++) {
        data[base + (3 + corner) * 4 + axis] = normals[vertex * 3 + axis];
        data[base + (6 + corner) * 4 + axis] = colors[vertex * 3 + axis];
      }
      data[base + (3 + corner) * 4 + 3] = uvSource[vertex * 2];
      data[base + (6 + corner) * 4 + 3] = uvSource[vertex * 2 + 1];
    }
    if (secondUvSet && uvs1) packSecondUvSet(data, base, uvs1, corners);
  }
}

function packSecondUvSet(data, base, uvs1, corners) {
  data[base + 9 * 4] = uvs1[corners[0] * 2];
  data[base + 9 * 4 + 1] = uvs1[corners[0] * 2 + 1];
  data[base + 9 * 4 + 2] = uvs1[corners[1] * 2];
  data[base + 9 * 4 + 3] = uvs1[corners[1] * 2 + 1];
  data[base + 4 + 3] = uvs1[corners[2] * 2];
  data[base + 8 + 3] = uvs1[corners[2] * 2 + 1];
}

/**
 * Shelf-packs the distinct material textures into one RGBA8 atlas; returns where each one went. `withOcclusion` also places the occlusion
 * maps (the WebGPU tracer reads them from its own table, packOcclusion); the other tracers leave them out, so their atlas never grows.
 */
export function packAtlas(materials, { withOcclusion = false } = {}) {
  const fields = withOcclusion ? [...GPU_MAP_FIELDS, 'occlusionTexture'] : GPU_MAP_FIELDS;
  const placements = new Map();
  const textures = [];
  for (const material of materials) {
    for (const field of fields) {
      const texture = material[field];
      if (texture && !placements.has(texture.data)) {
        placements.set(texture.data, null);
        textures.push(texture);
      }
    }
  }
  if (textures.length === 0) return { placements, width: 1, height: 1, data: new Uint8Array(4) };
  textures.sort((first, second) => second.height - first.height);
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  for (const texture of textures) {
    if (texture.width > ATLAS_WIDTH) throw new RangeError('A material texture is wider than the GPU atlas.');
    if (shelfX + texture.width > ATLAS_WIDTH) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    placements.set(texture.data, { x: shelfX, y: shelfY });
    shelfX += texture.width;
    shelfHeight = Math.max(shelfHeight, texture.height);
  }
  const height = shelfY + shelfHeight;
  if (height > MAXIMUM_TEXTURE_SIZE) throw new RangeError('The material textures do not fit the GPU atlas.');
  const data = new Uint8Array(ATLAS_WIDTH * height * 4);
  for (const texture of textures) {
    const { x, y } = placements.get(texture.data);
    for (let row = 0; row < texture.height; row++) {
      data.set(texture.data.subarray(row * texture.width * 4, (row + 1) * texture.width * 4), ((y + row) * ATLAS_WIDTH + x) * 4);
    }
  }
  return { placements, width: ATLAS_WIDTH, height, data };
}

// The float of a material record that holds the shadow-only flag: texel 5, second channel (its first channel is the emission map flag).
export const SHADOW_ONLY_SLOT = 21;
/** Slot of the emissive map flags, whose fraction carries the emission Fresnel factor (see emissionFresnelFraction). */
export const EMISSION_FRESNEL_SLOT = 20;
/** Slot of the material table that holds the point light bits whose own lamp mesh the part is (src/lamp-mesh.js); shadow rays of those lights pass through it. */
export const LAMP_LIGHTS_SLOT = 23;

// Bit 0 (value 1) is set when both axes repeat and the value 2 marks sRGB texels: Cook's reduceV1MaterialTable reads only those two bits
// (`flags & 1`, `flags & 2`), so they keep their meaning. Values 4 to 12 hold the wrap code of U and 16 to 48 the wrap code of V
// (0 repeat, 1 clamp, 2 mirror), which the shaders read on their own; the colour test is no longer `flags >= 2`.
/**
 * The emission Fresnel factor of a material as the fraction added to the emissive map flags (float 20 of the record, the first
 * float of texel 5): 0 for no factor, else 0.5 + 0.5 * the reflectance at normal incidence, so a factor whose reflectance is 0
 * still reads as set. The whole part stays the map flags, which the kernels read with floor() and Cook reads as an integer.
 */
export function emissionFresnelFraction(emissionFresnel) {
  if (!(emissionFresnel > 0)) return 0;
  const normalIncidence = ((emissionFresnel - 1) / (emissionFresnel + 1)) ** 2;
  return 0.5 + 0.5 * Math.min(normalIncidence, 0.999);
}

export function textureFlags(texture) {
  const wrapU = texture.wrapU ?? (texture.repeat ? 0 : 1);
  const wrapV = texture.wrapV ?? (texture.repeat ? 0 : 1);
  const bothRepeat = wrapU === 0 && wrapV === 0;
  return (bothRepeat ? 1 : 0) + (texture.colorLookup ? 2 : 0) + wrapU * 4 + wrapV * 16;
}

/**
 * Ten texels per material: surface values, texture flags, then one atlas rectangle per map. A material of a shadow-only part
 * (`shadowOnlyParts[index] === 1`) also gets 1 in SHADOW_ONLY_SLOT, which camera rays read to step through it.
 */
export function packMaterials(materials, atlas, shadowOnlyParts = null, lampLightMasks = null) {
  const table = createTable(materials.length * MATERIAL_TEXELS);
  const { data } = table;
  const fields = ['texture', 'normalTexture', 'surfaceTexture', 'emissiveTexture'];
  materials.forEach((material, index) => {
    const base = index * MATERIAL_TEXELS * 4;
    const mask = material.lightMask < 0 ? 0xffffffff : material.lightMask >>> 0;
    data.set([...material.color, material.metallic], base);
    data.set([...material.emission, material.roughness], base + 4);
    data.set([material.clearcoat, material.clearcoatRoughness, material.transmission, material.ior], base + 8);
    data.set([material.normalScale[0], material.normalScale[1], material.alphaCutoff, mask & 0xffff], base + 12);
    data[base + 16] = (mask >>> 16) & 0xffff;
    fields.forEach((field, fieldIndex) => {
      const texture = material[field];
      if (!texture) return;
      const place = atlas.placements.get(texture.data);
      data[base + 17 + fieldIndex] = textureFlags(texture);
      data.set([place.x, place.y, texture.width, texture.height], base + (6 + fieldIndex) * 4);
    });
    data[base + EMISSION_FRESNEL_SLOT] += emissionFresnelFraction(material.emissionFresnel);
    data[base + UV_SET_SLOT] = materialUvSetMask(material);
    if (shadowOnlyParts?.[index] === 1) data[base + SHADOW_ONLY_SLOT] = 1;
    if (lampLightMasks) data[base + LAMP_LIGHTS_SLOT] = lampLightMasks[index];
  });
  return table;
}

/** Vectors per material of the occlusion table: (atlas rectangle) and (texture flags, strength, second UV set, unused). */
export const OCCLUSION_TEXELS = 2;

/** True when a material has an occlusion map, which is when the WebGPU kernel needs the occlusion table. */
export function sceneUsesOcclusionMap(materials) {
  return materials.some(material => material.occlusionTexture);
}

/**
 * The occlusion map of each material, two texels per material. The material record has no free slot for a fifth map, so this table
 * follows the material table in the same buffer. A material without a map has a rectangle of width 0, which the kernel reads as no occlusion.
 */
export function packOcclusion(materials, atlas) {
  const table = createTable(materials.length * OCCLUSION_TEXELS);
  const { data } = table;
  materials.forEach((material, index) => {
    const texture = material.occlusionTexture;
    if (!texture) return;
    const place = atlas.placements.get(texture.data);
    const base = index * OCCLUSION_TEXELS * 4;
    data.set([place.x, place.y, texture.width, texture.height], base);
    data.set([textureFlags(texture), material.occlusionStrength ?? 1, texture.uvSet === 1 ? 1 : 0, 0], base + 4);
  });
  return table;
}

/** True when a part has a subsurface weight above 0, which is when the kernel needs the random walk. */
export function sceneUsesSubsurface(materials) {
  return materials.some(material => material.subsurface);
}

/**
 * Two texels per material: (weight, mean free path in metres for red, green and blue) and (colour, unused). The colour red is
 * -1 for the base colour. A material without a block packs a weight of 0, which the kernel treats as the unchanged path.
 */
export function packSubsurface(materials) {
  const table = createTable(materials.length * SUBSURFACE_TEXELS);
  const { data } = table;
  materials.forEach((material, index) => {
    const base = index * SUBSURFACE_TEXELS * 4;
    const block = material.subsurface;
    if (!block) return;
    data.set([block.weight, ...block.meanFreePath], base);
    data.set([...(block.color ?? [-1, -1, -1]), 0], base + 4);
  });
  return table;
}

const LIGHT_TYPES = { point: 0, spot: 1, area: 2 };

// The light's own bounce limit plus one (its `maxBounces`, already checked by buildTraceScene), or 0 for none.
const bounceLimitCode = light => (light.maxBounces === undefined ? 0 : light.maxBounces + 1);

/**
 * Six texels per point, spot or area light, in the order the tracer samples them. The third float of the last texel is 1 for a point or
 * spot light with `softFalloff` (an oriented disk, read by the `cycles` kernel only) and 0 for every other light. The fourth float is
 * the light's own bounce limit plus one (0 for none), also read by the `cycles` kernel only.
 */
export function packLights(lights) {
  const entries = [
    ...lights.points.map(light => ({ light, type: LIGHT_TYPES.point })),
    ...lights.spots.map(light => ({ light, type: LIGHT_TYPES.spot })),
    ...lights.areas.map(light => ({ light, type: LIGHT_TYPES.area })),
  ];
  const table = createTable(Math.max(1, entries.length) * LIGHT_TEXELS);
  const { data } = table;
  entries.forEach(({ light, type }, index) => {
    const base = index * LIGHT_TEXELS * 4;
    data.set([...light.position, type], base);
    data.set([...light.color, light.bit], base + 4);
    if (type === LIGHT_TYPES.area) {
      data.set([...light.normal, light.width], base + 8);
      data.set([...light.across, light.height], base + 12);
      data.set([...light.along, 0], base + 16);
      data.set([light.intensity, 0, 0, bounceLimitCode(light)], base + 20);
      return;
    }
    data.set([...(light.direction ?? [0, 0, 0]), light.radius], base + 8);
    data.set([0, 0, 0, light.cosineHalfAngle ?? 0], base + 12);
    data.set([0, 0, 0, light.blend ?? 0], base + 16);
    data.set([light.intensity, light.range, light.softFalloff === true ? 1 : 0, bounceLimitCode(light)], base + 20);
  });
  return { table, count: entries.length };
}

/** The light tree (path-tracer-light-tree.js) as a table: four texels per node, in the node order of the tree. */
export function packLightTree(lights) {
  const tree = buildLightTree(lights);
  const table = createTable(Math.max(1, tree.nodeCount) * LIGHT_TREE_NODE_TEXELS);
  table.data.set(tree.data);
  return table;
}

/** The map as RGBA32F plus normalised cumulative tables, so the shader compares them with a unit random number. */
export function packEnvironment(environment) {
  if (!environment) return null;
  const { width, height, channels, data: source } = environment;
  const colors = new Float32Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) colors[pixel * 4 + channel] = source[pixel * channels + channel];
    colors[pixel * 4 + 3] = 1;
  }
  const rows = createTable(height, 1);
  const pixels = createTable(width * height, 1);
  const rowTotal = environment.rowCumulative[height - 1];
  for (let row = 0; row < height; row++) rows.data[row] = environment.rowCumulative[row] / rowTotal;
  for (let row = 0; row < height; row++) {
    const rowEnd = environment.pixelCumulative[row * width + width - 1];
    for (let column = 0; column < width; column++) pixels.data[row * width + column] = environment.pixelCumulative[row * width + column] / rowEnd;
  }
  return { colors, width, height, rows, pixels };
}
