import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';
import { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT } from './light-link-bits.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import { boxProjectedGeometry, columnLengths } from './export-box-uv.js';
import { resolveTraceVolume, resolveTraceDistanceHaze, prepareMeshVolume } from './path-tracer-volume.js';
import { waterTraceMaterial } from './path-tracer-water.js';
import { thinWaterMedia, withWaterMedia } from './path-tracer-water-medium.js';
import { resolveLocalVolumes } from './local-volumes.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';
import { resolveTraceSubsurface } from './path-tracer-subsurface.js';
import { lightShapeSupport } from './shader-registry.js';
import { flushOrderOf } from './depth-layer.js';
import { liftRankedTriangles } from './flush-lift.js';
import { RAY_VISIBILITY_BITS } from './ray-visibility.js';
import { DEFAULT_BACKGROUND } from './clear-colour.js';
import { lampLightMasks } from './lamp-mesh.js';

// The scene a path trace reads: every part flattened into one world-space triangle soup with per-vertex normals, UVs
// and colours, one resolved material per part, the lights in plain arrays, and the environment map as a sampling table.

export const MAX_TRACE_TRIANGLES = 400_000;
// The most triangles the WebGL2 and WebGPU tracers are ever asked to hold, whatever the device could address: the triangle
// table is 160 bytes a triangle, so this is 320 MB of texture or buffer, plus the BVH built in JavaScript. A device with
// smaller limits lowers it (`gpuTriangleCapacity` in path-tracer-gpu-pack.js); the option `gpuTriangleLimit` carries the result.
export const MAX_GPU_TRACE_TRIANGLES = 2_000_000;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumTriangles` (unique triangles of an
// instanced scene, all triangles of a flattened one). The CPU and WebGL tracers never pass it and keep MAX_TRACE_TRIANGLES.
export const MAX_NATIVE_TRACE_TRIANGLES = 16_000_000;
// With that option an instanced scene also counts every copy: at most this many times `maximumTriangles` triangles in total.
export const NATIVE_INSTANCED_TOTAL_FACTOR = 4;
export const MAX_TRACE_PARTS = 1024;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumParts`: the parts of a flattened scene,
// and the distinct geometries of an instanced one. The CPU and WebGL tracers never pass it and keep MAX_TRACE_PARTS.
export const MAX_NATIVE_TRACE_PARTS = 1_000_000;
// An instanced trace counts triangles once per shared geometry and bounds the copies on their own.
export const MAX_TRACE_INSTANCES = 65_536;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumInstances`. The CPU and WebGL tracers
// never pass it and keep MAX_TRACE_INSTANCES.
export const MAX_NATIVE_TRACE_INSTANCES = 1_000_000;
export const MAX_TRACE_LIGHTS = 32;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumLights`. That kernel picks lights
// through a light tree and has no list per kind, so the per kind limits of a drawn frame (light-limits.js) do not apply.
export const MAX_NATIVE_TRACE_LIGHTS = 256;
// A Blender sun of 1 degree, which is what the reference harness gives Cycles.
export const SUN_ANGULAR_RADIUS = Math.PI / 360;

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const REPEAT_WRAP = 10497;
const CLAMP_WRAP = 33071;
const MIRRORED_REPEAT_WRAP = 33648;
// Per axis wrap codes of a resolved texture, the same numbers Cook's packer reads as wrapU and wrapV.
export const WRAP_REPEAT = 0;
export const WRAP_CLAMP = 1;
export const WRAP_MIRROR = 2;
const WRAP_CODES = new Map([[REPEAT_WRAP, WRAP_REPEAT], [CLAMP_WRAP, WRAP_CLAMP], [MIRRORED_REPEAT_WRAP, WRAP_MIRROR]]);

function wrapCodeOf(glWrapMode, field) {
  const code = WRAP_CODES.get(glWrapMode ?? REPEAT_WRAP);
  if (code === undefined) {
    throw new RangeError(`Texture ${field} is 10497 (repeat), 33071 (clamp to edge) or 33648 (mirrored repeat), got ${JSON.stringify(glWrapMode)}. Pass one of those glTF sampler values, or leave it out to repeat.`);
  }
  return code;
}

function addWeightedTransform(output, offset, palette, joint, weight, x, y, z, translationWeight) {
  const base = joint * 16;
  output[offset] += weight * (palette[base] * x + palette[base + 4] * y + palette[base + 8] * z + palette[base + 12] * translationWeight);
  output[offset + 1] += weight * (palette[base + 1] * x + palette[base + 5] * y + palette[base + 9] * z + palette[base + 13] * translationWeight);
  output[offset + 2] += weight * (palette[base + 2] * x + palette[base + 6] * y + palette[base + 10] * z + palette[base + 14] * translationWeight);
}

// Adds the weighted upper 3x3 of one joint matrix to the blended deformation matrix (row major, as normalMatrix reads it).
function addWeightedLinearPart(blended, palette, joint, weight) {
  const base = joint * 16;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      blended[row * 3 + column] += weight * palette[base + column * 4 + row];
    }
  }
}

/** The geometry of a skinned part at its current pose, as plain positions and normals. */
export function skinnedGeometry(part) {
  const { geometry, skin } = part;
  const vertexCount = geometry.positions.length / 3;
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  const blendedLinearPart = new Float64Array(9);
  const influenceCount = geometry.skinWeights.length / vertexCount;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    blendedLinearPart.fill(0);
    for (let influence = 0; influence < influenceCount; influence++) {
      const weight = geometry.skinWeights[vertex * influenceCount + influence];
      if (weight === 0) continue;
      const joint = geometry.skinIndices[vertex * influenceCount + influence];
      addWeightedTransform(positions, offset, skin.jointMatrices, joint, weight, geometry.positions[offset], geometry.positions[offset + 1], geometry.positions[offset + 2], 1);
      addWeightedLinearPart(blendedLinearPart, skin.jointMatrices, joint, weight);
    }
    // Like the rasterizer (shaders.js), the normal takes the inverse transpose of the blended deformation, which differs from
    // the deformation itself once a joint scales unevenly.
    const normalTransform = normalMatrix([...blendedLinearPart.slice(0, 3), 0, ...blendedLinearPart.slice(3, 6), 0, ...blendedLinearPart.slice(6, 9), 0, 0, 0, 0, 1]);
    const normalX = geometry.normals[offset];
    const normalY = geometry.normals[offset + 1];
    const normalZ = geometry.normals[offset + 2];
    for (let axis = 0; axis < 3; axis++) {
      normals[offset + axis] = normalTransform[axis * 3] * normalX + normalTransform[axis * 3 + 1] * normalY + normalTransform[axis * 3 + 2] * normalZ;
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return { ...geometry, positions, normals };
}

/** Normal matrix (cofactors of the upper 3x3, signed so that mirrored parts keep outward normals), row major. */
function normalMatrix(matrix) {
  const [r0c0, r1c0, r2c0, , r0c1, r1c1, r2c1, , r0c2, r1c2, r2c2] = matrix;
  const cofactors = [
    r1c1 * r2c2 - r2c1 * r1c2, r2c1 * r0c2 - r0c1 * r2c2, r0c1 * r1c2 - r1c1 * r0c2,
    r2c0 * r1c2 - r1c0 * r2c2, r0c0 * r2c2 - r2c0 * r0c2, r1c0 * r0c2 - r0c0 * r1c2,
    r1c0 * r2c1 - r2c0 * r1c1, r2c0 * r0c1 - r0c0 * r2c1, r0c0 * r1c1 - r1c0 * r0c1,
  ];
  const sign = r0c0 * cofactors[0] + r1c0 * cofactors[1] + r2c0 * cofactors[2] < 0 ? -1 : 1;
  return cofactors.map(value => value * sign);
}

/** True when the matrix mirrors (negative determinant of its upper 3x3), which turns every triangle inside out. */
function mirrorsGeometry(matrix) {
  const [r0c0, r1c0, r2c0, , r0c1, r1c1, r2c1, , r0c2, r1c2, r2c2] = matrix;
  return r0c0 * (r1c1 * r2c2 - r2c1 * r1c2) + r1c0 * (r2c1 * r0c2 - r0c1 * r2c2) + r2c0 * (r0c1 * r1c2 - r1c1 * r0c2) < 0;
}

function srgbToLinearTable() {
  const table = new Float32Array(256);
  for (let value = 0; value < 256; value++) {
    const encoded = value / 255;
    table[value] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  }
  return table;
}

const SRGB_TO_LINEAR = srgbToLinearTable();

// Pixels read back from browser images, kept per image so parts that share a texture read it once.
const drawablePixels = new WeakMap();

/**
 * RGBA8 pixels of a texture image: its own `data`, or, for a decoded glTF texture (an ImageBitmap, an image element or a
 * canvas), the pixels read back through a 2D canvas. GPU-compressed images and runtimes without a canvas give null.
 */
export function texturePixels(image, createCanvas = defaultCanvas) {
  if (!image?.width || !image.height) return null;
  if (image.data) return image.data;
  if (image.compressed || typeof image !== 'object') return null;
  if (drawablePixels.has(image)) return drawablePixels.get(image);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  drawablePixels.set(image, pixels);
  return pixels;
}

function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = globalThis.document?.createElement('canvas');
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Pixels and sampling of a texture descriptor for the trace, or null when its image cannot be read. */
export function resolveTexture(descriptor) {
  const image = descriptor?.image;
  const data = texturePixels(image);
  if (!data) return null;
  const wrapUCode = wrapCodeOf(descriptor.wrapS, 'wrapS');
  const wrapVCode = wrapCodeOf(descriptor.wrapT, 'wrapT');
  return {
    width: image.width,
    height: image.height,
    data,
    colorLookup: descriptor.colorSpace === 'linear' ? null : SRGB_TO_LINEAR,
    // A map without a wrap mode repeats: the rasteriser and glTF both default to repeat.
    repeat: wrapUCode === WRAP_REPEAT && wrapVCode === WRAP_REPEAT,
    wrapU: wrapUCode,
    wrapV: wrapVCode,
    // The UV set the map reads: 1 is TEXCOORD_1 (geometry.lightUvs), anything else is TEXCOORD_0 (geometry.uvs).
    uvSet: descriptor.uvChannel === 1 ? 1 : 0,
  };
}

// A part without a mask is lit by every light.
const ALL_LIGHTS = -1;

// The tracer has no blending: a blended material whose vertices carry alpha cuts out at half, like a graph opacity output.
const BLEND_CUTOUT = 0.5;

// A graph opacity output is texture alpha on a blended material. The tracer has no blending, so it cuts out at half.
function graphOpacityCutoff(material) {
  const graph = material.pattern?.type === 'graph' ? material.pattern.graph : null;
  return material.alphaMode === 'blend' && graph && Object.hasOwn(graph, 'opacity') ? 0.5 : 0;
}

// A blended or masked material reads the vertex alpha (glTF COLOR_0); an opaque one ignores it.
function readsVertexAlpha(material) {
  return material?.alphaMode === 'blend' || material?.alphaMode === 'mask';
}

/** True when a part carries COLOR_0 alpha that its material reads. */
export function partUsesVertexAlpha(part, geometry = part.geometry) {
  return Boolean(geometry?.colorAlpha) && readsVertexAlpha(part.material);
}

// The part's own material as the trace reads it: a water material becomes the dielectric it stands for, any other is unchanged.
function tracedMaterialOf(part) {
  return waterTraceMaterial(part.material ?? {});
}

function resolveMaterial(material, usesVertexAlpha = false) {
  const emissionColor = material.emissiveColor ?? material.color;
  const emissionStrength = material.emission ?? 0;
  return {
    color: material.color ?? [1, 1, 1],
    metallic: material.metallic ?? 0,
    roughness: material.roughness ?? 0.5,
    emission: emissionColor.map(channel => channel * emissionStrength),
    emissiveTexture: emissionStrength > 0 ? resolveTexture(material.emissiveMap) : null,
    emissionFresnel: material.emissionFresnel ?? 0,
    clearcoat: material.clearcoat ?? 0,
    clearcoatTexture: resolveTexture(material.layerMaps?.clearcoatTexture),
    transmissionTexture: resolveTexture(material.transmissionMap),
    clearcoatRoughness: material.clearcoatRoughness ?? 0,
    transmission: material.transmission ?? 0,
    subsurface: resolveTraceSubsurface(material.subsurface),
    ior: material.ior ?? 1.5,
    attenuationColor: material.attenuationColor ?? [1, 1, 1],
    attenuationDistance: material.attenuationDistance ?? Infinity,
    texture: resolveTexture(material.map),
    normalTexture: resolveTexture(material.normalMap),
    normalScale: material.normalScale ?? [1, 1],
    surfaceTexture: resolveTexture(material.metallicRoughnessMap),
    // Read by the CPU tracer only; it darkens indirect light (glTF occlusion), never a light's own direct light.
    occlusionTexture: resolveTexture(material.occlusionMap),
    occlusionStrength: material.occlusionStrength ?? 1,
    lightMask: material.lightMask ?? ALL_LIGHTS,
    alphaCutoff: material.alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : graphOpacityCutoff(material) || (usesVertexAlpha ? BLEND_CUTOUT : 0),
  };
}

function requireFiniteNumbers(values, expectedLength, label) {
  if (!values || (expectedLength !== undefined && values.length !== expectedLength)) throw new TypeError(`${label} must hold ${expectedLength} numbers.`);
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) throw new RangeError(`${label} must be finite numbers.`);
  }
}

function partLabel(part) {
  return `Part ${part.name ?? ''}`.trim();
}

function validateMatrix(part) {
  requireFiniteNumbers(part.matrix ?? IDENTITY_MATRIX, 16, `${partLabel(part)} matrix`);
}

function validateGeometry(part, geometry) {
  const label = partLabel(part);
  requireFiniteNumbers(geometry.positions, undefined, `${label} positions`);
  if (!geometry.indices) throw new TypeError(`${label} needs geometry.indices, three vertex numbers for every triangle. Pass a Uint32Array of indices.`);
  if (geometry.positions.length % 3 !== 0 || geometry.indices.length % 3 !== 0) throw new RangeError(`${label} positions and indices must come in threes.`);
  const vertexCount = geometry.positions.length / 3;
  if (geometry.normals?.length !== geometry.positions.length) throw new RangeError(`${label} needs one normal for every position.`);
  requireFiniteNumbers(geometry.normals, undefined, `${label} normals`);
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    const index = geometry.indices[slot];
    if (!Number.isInteger(index) || index < 0) throw new RangeError(`${label} has an index that is not a whole number from 0 up (got ${index}). Pass vertex numbers as non-negative integers.`);
    if (!(index < vertexCount)) throw new RangeError(`${label} has an index past its last vertex.`);
  }
  if (geometry.uvs && geometry.uvs.length !== vertexCount * 2) throw new RangeError(`${label} needs one UV pair for every position.`);
  if (geometry.lightUvs && geometry.lightUvs.length !== vertexCount * 2) throw new RangeError(`${label} needs one lightUvs pair (TEXCOORD_1) for every position.`);
  if (geometry.colors && geometry.colors.length !== vertexCount * 3) throw new RangeError(`${label} needs one colour for every position.`);
  if (geometry.colorAlpha && geometry.colorAlpha.length !== vertexCount) throw new RangeError(`${label} needs one colorAlpha for every position.`);
  if (geometry.lightUvs) requireFiniteNumbers(geometry.lightUvs, undefined, `${label} lightUvs`);
  if (geometry.uvs) requireFiniteNumbers(geometry.uvs, undefined, `${label} uvs`);
  if (geometry.colors) requireFiniteNumbers(geometry.colors, undefined, `${label} colors`);
}

// The maps resolveMaterial reads: the emissive map only while the material emits, the clearcoat map among the layer maps.
function tracedMapDescriptors(material) {
  return [
    material.map,
    material.normalMap,
    material.metallicRoughnessMap,
    material.occlusionMap,
    material.transmissionMap,
    (material.emission ?? 0) > 0 ? material.emissiveMap : null,
    material.layerMaps?.clearcoatTexture,
  ];
}

function namesSecondUvSet(material) {
  return tracedMapDescriptors(material).some(descriptor => descriptor?.uvChannel === 1);
}

function requireSecondUvSetGeometry(part, geometry) {
  if (namesSecondUvSet(part.material ?? {}) && !geometry.lightUvs) {
    throw new RangeError(`${partLabel(part)} has a map with uvChannel 1 but its geometry has no lightUvs. Set geometry.lightUvs (TEXCOORD_1), or use uvChannel 0.`);
  }
}

function validatePart(part, geometry) {
  validateMatrix(part);
  validateGeometry(part, geometry);
  requireSecondUvSetGeometry(part, geometry);
}

/**
 * The geometry a part is traced with. A box-projected material has no UVs, so it gets the UVs of its projection (the
 * ones the glTF export writes), and every map then reads them like those of an authored material.
 */
function traceGeometry(part) {
  // Faces hidden under a face on the same plane are cut away for the rasteriser (flush-resolve.js); rays get the same
  // geometry, or the two faces would split the hits between them.
  const traced = part.skin ? skinnedGeometry(part) : flushOrderOf(part)?.geometry ?? part.geometry;
  const geometry = liftRankedTriangles(part, traced);
  const { boxMapScale = 0, boxMapAxis = 1 } = part.material ?? {};
  if (!(boxMapScale > 0)) return geometry;
  return boxProjectedGeometry(geometry, columnLengths(part.matrix ?? IDENTITY_MATRIX), boxMapScale, boxMapAxis);
}

function allocateWorld(vertexTotal, indexTotal, withSecondUvSet = false, withVertexAlpha = false) {
  const secondUvSet = withSecondUvSet ? new Float32Array(vertexTotal * 2) : null;
  return {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    // The second UV set, only when a part has one; a part without it leaves zeros, the (0, 0) texel.
    uvs1: secondUvSet,
    // The same array under the name the native packer reads (`uv1s`), so a native trace samples TEXCOORD_1 too.
    ...(secondUvSet ? { uv1s: secondUvSet } : {}),
    colors: new Float32Array(vertexTotal * 3).fill(1),
    // COLOR_0 alpha per vertex, only when a blended or masked part has it (one float a vertex, 1 elsewhere).
    vertexAlpha: withVertexAlpha ? new Float32Array(vertexTotal).fill(1) : null,
    indices: new Uint32Array(indexTotal),
    triangleMaterial: new Uint32Array(indexTotal / 3),
  };
}

// Writes one part, moved by its matrix, into the world arrays at the given vertex and triangle offsets.
function writeWorldPart(world, part, geometry, partIndex, vertexOffset, triangleOffset) {
  const matrix = part.matrix ?? IDENTITY_MATRIX;
  const normals = normalMatrix(matrix);
  const vertexCount = geometry.positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = geometry.positions[vertex * 3];
    const y = geometry.positions[vertex * 3 + 1];
    const z = geometry.positions[vertex * 3 + 2];
    const target = (vertexOffset + vertex) * 3;
    world.positions[target] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    world.positions[target + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    world.positions[target + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const normalX = geometry.normals[vertex * 3];
    const normalY = geometry.normals[vertex * 3 + 1];
    const normalZ = geometry.normals[vertex * 3 + 2];
    const worldX = normals[0] * normalX + normals[3] * normalY + normals[6] * normalZ;
    const worldY = normals[1] * normalX + normals[4] * normalY + normals[7] * normalZ;
    const worldZ = normals[2] * normalX + normals[5] * normalY + normals[8] * normalZ;
    const length = Math.hypot(worldX, worldY, worldZ) || 1;
    world.normals[target] = worldX / length;
    world.normals[target + 1] = worldY / length;
    world.normals[target + 2] = worldZ / length;
  }
  if (geometry.uvs) world.uvs.set(geometry.uvs, (vertexOffset) * 2);
  if (geometry.lightUvs && world.uvs1) world.uvs1.set(geometry.lightUvs, vertexOffset * 2);
  if (geometry.colors) world.colors.set(geometry.colors, vertexOffset * 3);
  if (world.vertexAlpha && partUsesVertexAlpha(part, geometry)) world.vertexAlpha.set(geometry.colorAlpha, vertexOffset);
  // A mirrored part keeps outward vertex normals, so its triangles swap their last two corners to keep the winding
  // (and the cross-product normal) outward too.
  const mirrored = mirrorsGeometry(matrix);
  const cornerOrder = mirrored ? [0, 2, 1] : [0, 1, 2];
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    const sourceSlot = slot - (slot % 3) + cornerOrder[slot % 3];
    world.indices[triangleOffset * 3 + slot] = geometry.indices[sourceSlot] + vertexOffset;
  }
  world.triangleMaterial.fill(partIndex, triangleOffset, triangleOffset + geometry.indices.length / 3);
}

/**
 * The triangle bounds of one build: the CPU and WebGL default, or the native bound an exporter for the "cycles" kernel
 * asks for with `maximumTriangles`. A bad value is refused here so a typo cannot lift the bound.
 */
function resolveTriangleLimits(options) {
  const requested = options?.maximumTriangles;
  const deviceLimit = options?.gpuTriangleLimit;
  if (deviceLimit !== undefined) {
    if (requested !== undefined) throw new RangeError('buildTraceScene takes maximumTriangles (native tracer) or gpuTriangleLimit (WebGL2 and WebGPU tracers), not both.');
    if (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > MAX_GPU_TRACE_TRIANGLES) {
      throw new RangeError(`buildTraceScene option gpuTriangleLimit is an integer from 1 to ${MAX_GPU_TRACE_TRIANGLES}, got ${deviceLimit}. Leave it out for the CPU tracer, which takes at most ${MAX_TRACE_TRIANGLES} triangles.`);
    }
    return { native: false, gpu: true, unique: deviceLimit, total: Infinity };
  }
  if (requested === undefined) return { native: false, unique: MAX_TRACE_TRIANGLES, total: Infinity };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_TRIANGLES) {
    throw new RangeError(`buildTraceScene option maximumTriangles is an integer from 1 to ${MAX_NATIVE_TRACE_TRIANGLES} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_TRIANGLES} triangles.`);
  }
  return { native: true, unique: requested, total: requested * NATIVE_INSTANCED_TOTAL_FACTOR };
}

/** The part bound of one build: the CPU and WebGL default, or the native bound asked for with `maximumParts`. */
function resolvePartLimit(options) {
  const requested = options?.maximumParts;
  if (requested === undefined) return { native: false, count: MAX_TRACE_PARTS };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_PARTS) {
    throw new RangeError(`buildTraceScene option maximumParts is an integer from 1 to ${MAX_NATIVE_TRACE_PARTS} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_PARTS} parts.`);
  }
  return { native: true, count: requested };
}

/** The instance bound of one build: the CPU and WebGL default, or the native bound asked for with `maximumInstances`. */
function resolveInstanceLimit(options) {
  const requested = options?.maximumInstances;
  if (requested === undefined) return { native: false, count: MAX_TRACE_INSTANCES };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_INSTANCES) {
    throw new RangeError(`buildTraceScene option maximumInstances is an integer from 1 to ${MAX_NATIVE_TRACE_INSTANCES} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_INSTANCES} instances.`);
  }
  return { native: true, count: requested };
}

/**
 * How many parts reuse a geometry another part also uses, and the triangles left when each shared geometry counts once.
 * A flattened trace copies every instance into one triangle buffer, so the limit sees the first number's expansion.
 */
export function measureInstanceExpansion(parts, geometries) {
  const useCounts = new Map();
  parts.forEach((part, index) => {
    if (sharesAuthoredGeometry(part, geometries[index])) useCounts.set(geometries[index], (useCounts.get(geometries[index]) ?? 0) + 1);
  });
  let instancedNodes = 0;
  let uniqueTriangles = 0;
  const counted = new Set();
  parts.forEach((part, index) => {
    const geometry = geometries[index];
    const triangles = geometry.indices.length / 3;
    const shared = useCounts.get(geometry) > 1;
    if (shared) instancedNodes++;
    if (shared && counted.has(geometry)) return;
    counted.add(geometry);
    uniqueTriangles += triangles;
  });
  return { instancedNodes, uniqueTriangles };
}

function instancingNote(triangleCount, expansion) {
  if (!expansion || expansion.instancedNodes < 1) return '';
  return ` That is ${triangleCount} triangles after expanding ${expansion.instancedNodes} instanced nodes (${expansion.uniqueTriangles} unique): this backend copies every instance into one triangle buffer. Use fewer copies, a simpler GLB, or the Glaze renderer.`;
}

function flattenedLimitMessage(limits, triangleCount, expansion) {
  const note = instancingNote(triangleCount, expansion);
  if (limits.native) {
    return `A native path trace takes at most ${limits.unique} triangles in total, got ${triangleCount}, ${triangleCount - limits.unique} too many. Share geometry between copies (they stay instances) or simplify the meshes.${note}`;
  }
  if (limits.gpu) {
    return `This GPU path trace takes at most ${limits.unique} triangles in total (what the device's texture or buffer limits hold, up to ${MAX_GPU_TRACE_TRIANGLES}), got ${triangleCount}. Simplify or drop meshes (a crowd can use a lower detail level for the avatars far from the camera), or render the frame with the native Cook backend.${note}`;
  }
  return `A path trace takes at most ${MAX_TRACE_TRIANGLES} triangles in total, got ${triangleCount}. Simplify or drop meshes, or trace on the GPU backend, which holds more when the device allows it.${note}`;
}

function flattenParts(parts, geometries = parts.map(traceGeometry), limits = resolveTriangleLimits()) {
  let vertexTotal = 0;
  let indexTotal = 0;
  parts.forEach((part, index) => validatePart(part, geometries[index]));
  for (const geometry of geometries) {
    vertexTotal += geometry.positions.length / 3;
    indexTotal += geometry.indices.length;
  }
  if (indexTotal / 3 > limits.unique) {
    throw new RangeError(flattenedLimitMessage(limits, indexTotal / 3, measureInstanceExpansion(parts, geometries)));
  }
  const world = allocateWorld(vertexTotal, indexTotal, geometries.some(geometry => geometry.lightUvs), parts.some((part, index) => partUsesVertexAlpha(part, geometries[index])));
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const geometry = geometries[partIndex];
    writeWorldPart(world, part, geometry, partIndex, vertexOffset, triangleOffset);
    vertexOffset += geometry.positions.length / 3;
    triangleOffset += geometry.indices.length / 3;
  });
  return world;
}

function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

// The 16 relative values of the light's IES profile, or null for a light with none.
function traceProfile(light) {
  return light.ies === undefined ? null : lightShapeSupport.profile(light.ies);
}

// A point or spot light with a radius is a sphere unless it asks for the oriented disk of Blender's Soft Falloff. Only the `cycles` native kernel draws the disk.
function softFalloffOf(light, label) {
  if (light.softFalloff === undefined) return {};
  if (typeof light.softFalloff !== 'boolean') {
    throw new TypeError(`${label}.softFalloff must be true (a disk, as Blender's Soft Falloff) or false (a sphere), got ${JSON.stringify(light.softFalloff)}. Leave it out for the sphere.`);
  }
  return light.softFalloff ? { softFalloff: true } : {};
}

// The most bounces a light's own limit may name: Cook keeps it in 8 bits as the limit plus one.
const MAXIMUM_LIGHT_BOUNCES = 254;

/**
 * A light's own bounce limit, as the `max_bounces` of a Cycles light: the light adds direct light only at path vertices 0 to the limit,
 * on top of the scene's bounces. Left out, the light runs to the scene limit. Only the native cycles kernel reads it.
 */
function maxBouncesOf(value, label) {
  if (value === undefined) return {};
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_LIGHT_BOUNCES) {
    throw new RangeError(`${label} is a whole number of bounces from 0 to ${MAXIMUM_LIGHT_BOUNCES}, got ${JSON.stringify(value)}. Leave it out for no limit beyond the scene's bounces.`);
  }
  return { maxBounces: value };
}

// Missing colour and intensity default as in the rasterizer (lighting.js); a value that is given must be usable.
function lightEmission(light, label) {
  const color = light.color ?? [1, 1, 1];
  if (!(Array.isArray(color) || ArrayBuffer.isView(color)) || color.length !== 3 || !Array.from(color).every(channel => Number.isFinite(channel) && channel >= 0)) {
    throw new RangeError(`${label}.color is three finite numbers from 0 up, such as [1, 0.9, 0.8], got ${JSON.stringify(light.color)}. Leave it out for white.`);
  }
  const intensity = light.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity < 0) {
    throw new RangeError(`${label}.intensity is a finite number from 0 up, got ${JSON.stringify(light.intensity)}. Leave it out for 1.`);
  }
  return { color, intensity };
}

// Aimed along the guide, the cross product vanishes, so the rectangle falls back to the x axis (as light-bake.js and lighting.js do).
const MINIMUM_ACROSS_LENGTH = 1e-3;

function resolveAreaLight(light, index) {
  const label = `environment.areaLights[${index}]`;
  const normal = normalized(light.direction);
  const guide = normalized(light.up ?? [0, 1, 0]);
  const rawAcross = [guide[1] * normal[2] - guide[2] * normal[1], guide[2] * normal[0] - guide[0] * normal[2], guide[0] * normal[1] - guide[1] * normal[0]];
  const rawAcrossLength = Math.hypot(rawAcross[0], rawAcross[1], rawAcross[2]);
  if (light.up !== undefined && rawAcrossLength < MINIMUM_ACROSS_LENGTH) {
    throw new RangeError(`${label}.up must not be parallel to its direction, got up ${JSON.stringify(light.up)} for direction ${JSON.stringify(light.direction)}. Pass an up that points a different way, or leave it out.`);
  }
  const across = rawAcrossLength < MINIMUM_ACROSS_LENGTH ? [1, 0, 0] : normalized(rawAcross);
  const along = [normal[1] * across[2] - normal[2] * across[1], normal[2] * across[0] - normal[0] * across[2], normal[0] * across[1] - normal[1] * across[0]];
  return { bit: AREA_FIRST_BIT + index, position: light.position, ...lightEmission(light, label), width: light.width, height: light.height, normal, across, along, profile: traceProfile(light), ...maxBouncesOf(light.maxBounces, `${label}.maxBounces`) };
}

/**
 * A portal is a rect area light with `portal: true`. It emits nothing: the native cycles kernel draws environment light
 * through its rectangle, with the normal pointing into the room. The other tracers ignore it (describeIgnoredFeatures).
 */
function resolvePortal(light, lightIndex) {
  const path = `environment.areaLights[${lightIndex}]`;
  if (light.shape !== undefined && light.shape !== 'rect') {
    throw new RangeError(`${path}.portal is only supported on a rect area light, got shape ${JSON.stringify(light.shape)}. Remove \`portal\` or use a rect light.`);
  }
  for (const field of ['width', 'height']) {
    if (!(light[field] > 0)) throw new RangeError(`${path}.portal needs a ${field} above 0, got ${JSON.stringify(light[field])}. Pass the size of the opening in scene units.`);
  }
  const { across, along, normal } = resolveAreaLight(light, lightIndex);
  return { position: light.position, width: light.width, height: light.height, normal, across, along };
}

/** The light bound of one build: the CPU and WebGL default, or the native bound asked for with `maximumLights`. */
function resolveLightLimit(options) {
  const requested = options?.maximumLights;
  if (requested === undefined) return { native: false, count: MAX_TRACE_LIGHTS };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_LIGHTS) {
    throw new RangeError(`buildTraceScene option maximumLights is an integer from 1 to ${MAX_NATIVE_TRACE_LIGHTS} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_LIGHTS} lights.`);
  }
  return { native: true, count: requested };
}

// Light linking keeps one mask bit per light, laid out by the per kind limits of a drawn frame. A scene with more lights of
// one kind than that has lights without a bit of their own, so a part that names its lights cannot be honoured.
function refuseLinkingBeyondMaskBits(environment, parts) {
  const overKinds = [['pointLights', MAX_POINT_LIGHTS], ['spotLights', MAX_SPOT_LIGHTS], ['areaLights', MAX_AREA_LIGHTS]]
    .filter(([field, maximum]) => (environment[field]?.length ?? 0) > maximum);
  if (overKinds.length === 0) return;
  const linkedPart = parts.find(part => part.material?.lightMask !== undefined && part.material.lightMask !== ALL_LIGHTS);
  if (linkedPart === undefined) return;
  const [field, maximum] = overKinds[0];
  throw new RangeError(`Light linking (a light with \`affects\`, or a part with \`material.lightMask\`, here "${linkedPart.name}") needs at most ${maximum} ${field}, got ${environment[field].length}: each linked light keeps one mask bit. Remove the links, or keep ${field} to ${maximum}.`);
}

/** Per part, the point light bits whose own lamp mesh the part is (see src/lamp-mesh.js); null when the scene has none. */
function ownLampMasks(parts, lights) {
  return lampLightMasks(parts, lights.points, part => resolveMaterial(part.material ?? {}).emission.some(channel => channel > 0));
}

/** Solid-angle reciprocal (`1 / (pi * sin^2(r))`) for a camera-visible analytic sun disc, matching Cook's sun radiance; 0 when hidden or delta. */
export function sunDiscScaleOf(sun) {
  if (!sun?.cameraVisible) return 0;
  const halfAngle = sun.angularRadius ?? SUN_ANGULAR_RADIUS;
  const sineHalfAngle = Math.sin(halfAngle);
  return halfAngle > 0 && sineHalfAngle > 1e-7 ? 1 / (Math.PI * sineHalfAngle * sineHalfAngle) : 0;
}

function resolveLights(environment, limit = resolveLightLimit(), parts = []) {
  const areaLights = environment.areaLights ?? [];
  const sunColor = Array.from(environment.keyColor ?? [0, 0, 0], channel => channel * (environment.keyIntensity ?? 1));
  const sunPower = Math.max(...sunColor);
  // Only skies whose sun disc was kept out of the environment map (physical sky with sunDisc on, or split HDRI) ask camera rays to draw the analytic sun cone.
  const sunVisible = Boolean(environment.map?.sunDisc?.radiance?.some(channel => channel > 0))
    && environment.sky?.sunDisc !== false
    && environment.world !== false;
  const lightCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.filter(light => light.portal !== true).length ?? 0);
  if (!limit.native && lightCount > MAX_TRACE_LIGHTS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_LIGHTS} point, spot and area lights.`);
  if (limit.native) {
    if (lightCount > limit.count) {
      throw new RangeError(`A native path trace takes at most ${limit.count} point, spot and area lights, got ${lightCount} (${lightCount - limit.count} too many). Drop lights, or give the extra emitters as meshes with an emissive material, which have no count limit.`);
    }
    refuseLinkingBeyondMaskBits(environment, parts);
  }
  return {
    sun: sunPower > 0 ? { bit: SUN_BIT, direction: normalized(environment.lightDirection ?? [0, 1, 0]), color: sunColor, angularRadius: environment.sunAngularRadius ?? SUN_ANGULAR_RADIUS, ...(sunVisible ? { cameraVisible: true } : {}), ...maxBouncesOf(environment.sunMaxBounces, 'environment.sunMaxBounces') } : null,
    points: (environment.pointLights ?? []).map((light, index) => ({
      bit: POINT_FIRST_BIT + index, position: light.position, ...lightEmission(light, `environment.pointLights[${index}]`), radius: light.radius ?? 0, range: light.range ?? 0, ...softFalloffOf(light, `environment.pointLights[${index}]`),
      ...maxBouncesOf(light.maxBounces, `environment.pointLights[${index}].maxBounces`),
    })),
    spots: (environment.spotLights ?? []).map((light, index) => ({
      bit: SPOT_FIRST_BIT + index, position: light.position, ...lightEmission(light, `environment.spotLights[${index}]`), radius: light.radius ?? 0, range: light.range ?? 0, ...softFalloffOf(light, `environment.spotLights[${index}]`),
      ...maxBouncesOf(light.maxBounces, `environment.spotLights[${index}].maxBounces`),
      direction: normalized(light.direction),
      cosineHalfAngle: Math.cos(light.angle),
      profile: traceProfile(light),
      blend: (1 - Math.cos(light.angle)) * (light.penumbra ?? 0),
    })),
    areas: areaLights.map((light, index) => (light.portal === true ? null : resolveAreaLight(light, index))).filter(Boolean),
    portals: areaLights.map((light, index) => (light.portal === true ? resolvePortal(light, index) : null)).filter(Boolean),
  };
}

/**
 * The environment map as radiance lookups plus a luminance-weighted table, so a direction can be drawn in proportion
 * to the light it brings. `pdf` is per steradian.
 */
function resolveEnvironment(map, cameraIntensity) {
  requireCameraIntensity(map, cameraIntensity);
  if (!map) return null;
  const { width, height, channels, data, intensity, rotation } = map;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rowCumulative = new Float64Array(height);
  const pixelCumulative = new Float64Array(width * height);
  let total = 0;
  for (let row = 0; row < height; row++) {
    const rowWeight = Math.sin(Math.PI * (row + 0.5) / height);
    let rowTotal = 0;
    for (let column = 0; column < width; column++) {
      const base = (row * width + column) * channels;
      rowTotal += (0.2126 * data[base] + 0.7152 * data[base + 1] + 0.0722 * data[base + 2] + 1e-6) * rowWeight;
      pixelCumulative[row * width + column] = rowTotal;
    }
    total += rowTotal;
    rowCumulative[row] = total;
  }
  const resolved = { width, height, channels, data, intensity, cosine, sine, rowCumulative, pixelCumulative, total };
  // Only the native "cycles" kernel reads it; absent means the sky is seen at the strength that lights the scene.
  if (cameraIntensity !== undefined) resolved.cameraIntensity = cameraIntensity;
  return resolved;
}

/**
 * The colour a camera ray sees where it escapes the scene. The rasterizer clears to its flat background colour unless
 * `environment.world` is true, which draws the sky; a recipe states `world` as a boolean, so `world: false` gets the same
 * colour here (#2016) and the map keeps lighting the scene. A bare environment that leaves `world` out keeps the map behind the picture.
 * Returns null where the map is the picture.
 */
export function resolveCameraBackground(environment) {
  if (environment.world !== false) return null;
  const [red, green, blue] = DEFAULT_BACKGROUND;
  return [red, green, blue];
}

/** The camera background as the four numbers a GPU tracer uploads: its colour, then 1 when it replaces the map for camera rays, else 0. */
export function cameraBackgroundWords(cameraBackground) {
  if (!cameraBackground) return [0, 0, 0, 0];
  return [cameraBackground[0], cameraBackground[1], cameraBackground[2], 1];
}

/** `environment.cameraIntensity` is the sky strength a camera ray sees (through glass too), in the units of the map intensity. */
function requireCameraIntensity(map, cameraIntensity) {
  if (cameraIntensity === undefined) return;
  if (typeof cameraIntensity !== 'number' || !Number.isFinite(cameraIntensity) || cameraIntensity < 0) {
    throw new RangeError(`environment.cameraIntensity must be a finite number of 0 or more (got ${cameraIntensity}). Pass 0.2 to draw the view through a window at 0.2 of the sky, or leave it out to use the map intensity.`);
  }
  if (!map) {
    throw new RangeError('environment.cameraIntensity needs environment.map: it scales the sky a camera ray sees, and there is no sky. Add an environment map or remove cameraIntensity.');
  }
}

/** A scene that crossed a thread boundary has lost its ray query function: build it again from the arrays. */
export function attachTracer(scene) {
  return { ...scene, tracer: createTracer({ positions: scene.positions, indices: scene.indices, bvh: scene.bvh }) };
}

/** Local volumes are traced by the CPU path tracer and, for boxes and spheres, the WebGPU final tracer. Every other tracer entry point calls this so none drops them silently. */
export function refuseLocalVolumes(scene, tracerName) {
  // The depth tint under thin water (#2294) is not an author's volume: a tracer that cannot draw it draws the water clear, as before.
  if (!scene.localVolumes?.some(volume => volume.waterMedium !== true)) return;
  throw new RangeError(`environment.localVolumes is traced by the CPU path tracer only; ${tracerName} cannot draw them. Use backend "cpu" (backend "webgpu" draws box, sphere, mesh and grid volumes) or remove the volumes.`);
}

// The rasterizer's own test (renderer.js `isHidden`): a part hides by `visible: false` or by the `visibility.visible` that a posed scene keys.
// One triangle with all three corners on the origin has no area, so no ray hits it and no shadow ray stops at it.
const UNHITTABLE_PLACEHOLDER_PART = Object.freeze({
  name: 'all parts hidden',
  geometry: Object.freeze({ positions: new Float32Array(9), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: Object.freeze({ tag: 'surface', color: Object.freeze([0, 0, 0]), metallic: 0, roughness: 1, emission: 0 }),
});

function isHiddenPart(part) {
  return part?.visible === false || part?.visibility?.visible === false;
}

// The volumes of the trace, and the hidden parts of the scene (#1793, #1806): the rasterizer does not draw a part with
// `visible: false`, and the trace leaves it out of the geometry too, so a part can shape smoke, or sit idle, without becoming a wall
// and a hidden part never casts a shadow. A volume that names a hidden part still reads its shape, because it is bound before the filter.
function resolveTraceLocalVolumes(input, parts, volumeTime = 0, volumeShutter = 0) {
  const boundsOnlyParts = Array.isArray(parts) ? parts.filter(isHiddenPart) : [];
  if (!input?.length) return { volumes: null, boundsOnlyParts };
  const resolved = resolveLocalVolumes(input, 'environment.localVolumes');
  const volumes = bindLocalVolumeParts(resolved, parts, { time: volumeTime, shutter: volumeShutter }).map((volume, index) => (volume.part ? prepareMeshVolume(volume, `environment.localVolumes[${index}]`) : volume));
  return { volumes, boundsOnlyParts };
}

export { RAY_VISIBILITY_BITS };
const ALL_RAY_KINDS = 63;

function describePart(part, index) {
  return typeof part?.name === 'string' && part.name ? `part "${part.name}"` : `part ${index}`;
}

function requireRayVisibilityObject(rayVisibility, label) {
  if (rayVisibility === null || typeof rayVisibility !== 'object' || Array.isArray(rayVisibility)) {
    throw new TypeError(`${label} rayVisibility must be an object such as { shadow: false } with keys from ${Object.keys(RAY_VISIBILITY_BITS).join(', ')}, got ${JSON.stringify(rayVisibility)}.`);
  }
}

function rayKindBit(kind, value, label) {
  const bit = RAY_VISIBILITY_BITS[kind];
  if (bit === undefined) {
    throw new TypeError(`${label} rayVisibility has the unknown ray kind "${kind}": use ${Object.keys(RAY_VISIBILITY_BITS).join(', ')}.`);
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} rayVisibility.${kind} must be true or false, got ${JSON.stringify(value)}.`);
  }
  return bit;
}

/**
 * The FORMAT-v2 visibility bits of one part: `rayVisibility: { camera, diffuse, glossy, transmission, shadow, volumeScatter }`
 * (a kind set to false hides the part from those rays) and `shadowOnly` as camera off. `castShadow` is a raster flag that
 * library code sets by default, so it never reaches these bits. A part that hides from nothing gets 63, every ray kind.
 */
export function partRayVisibilityFlags(part, index = 0) {
  const label = describePart(part, index);
  let flags = ALL_RAY_KINDS;
  if (part.rayVisibility !== undefined) {
    requireRayVisibilityObject(part.rayVisibility, label);
    for (const [kind, value] of Object.entries(part.rayVisibility)) {
      const bit = rayKindBit(kind, value, label);
      if (value === false) flags &= ~bit;
    }
  }
  requireEmitterStaysVisibleToBounces(part, flags, label);
  if (part.shadowOnly === true) {
    if ((flags & RAY_VISIBILITY_BITS.shadow) === 0) {
      throw new TypeError(`${label} sets shadowOnly with rayVisibility.shadow: false, which would hide it from every ray: keep shadow rays on, or drop shadowOnly.`);
    }
    flags &= ~RAY_VISIBILITY_BITS.camera;
  }
  return flags;
}

const BOUNCE_RAY_BITS = RAY_VISIBILITY_BITS.diffuse | RAY_VISIBILITY_BITS.glossy | RAY_VISIBILITY_BITS.transmission;

/**
 * The kernel samples an emissive mesh by next-event estimation with a multiple-importance weight below 1 and weights its
 * bounce hits to match. Hiding the emitter from a bounce ray culls those hits while the sampled share stays, so part of its
 * light would vanish. Camera, shadow and volume rays do not take part in that weighting, so those stay allowed.
 */
function requireEmitterStaysVisibleToBounces(part, flags, label) {
  if ((flags & BOUNCE_RAY_BITS) === BOUNCE_RAY_BITS) return;
  if (!(part.material?.emission > 0)) return;
  throw new TypeError(`${label} emits light and sets rayVisibility.diffuse, glossy or transmission to false, which would drop part of its light. Hide an emitter with camera: false or shadow: false instead, or keep diffuse, glossy and transmission true.`);
}

// True when the part's rayVisibility turns at least one ray kind off; an empty object or all true is the default.
function hidesFromSomeRay(part) {
  return part.rayVisibility !== undefined && Object.values(part.rayVisibility).includes(false);
}

// One byte per part for a flattened scene, or null when no part hides from a ray kind (shadowOnly alone keeps its own path).
function flattenedRayVisibility(parts) {
  const flags = parts.map((part, index) => partRayVisibilityFlags(part, index));
  if (!parts.some(hidesFromSomeRay)) return null;
  return Uint8Array.from(flags);
}

/**
 * True when the part keeps the geometry object it was authored with, so its copies can share one bottom-level structure.
 * A skinned, flush-lifted or box-mapped part gets a geometry of its own from `traceGeometry`, and a geometry with
 * per-triangle materials would be read differently by the instanced packer, so those stay baked into world space.
 */
function sharesAuthoredGeometry(part, traced) {
  return traced === part.geometry && !traced.triangleMaterial;
}

// A matrix tilts a normal map differently from the unit-normal bake unless it is a rotation, mirror and uniform scale (#1844).
const NON_CONFORMAL_TOLERANCE = 1e-4;

function hasNonConformalMatrix(matrix) {
  if (!matrix) return false;
  const columns = [0, 4, 8].map(offset => [matrix[offset], matrix[offset + 1], matrix[offset + 2]]);
  const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const squaredLengths = columns.map(column => dot(column, column));
  const scale = Math.max(...squaredLengths);
  if (!(scale > 0)) return false;
  const tolerance = NON_CONFORMAL_TOLERANCE * scale;
  if (Math.max(...squaredLengths) - Math.min(...squaredLengths) > tolerance) return true;
  return [[0, 1], [0, 2], [1, 2]].some(([first, second]) => Math.abs(dot(columns[first], columns[second])) > tolerance);
}

function hasNormalMap(material) {
  return Boolean(material?.normalMap || material?.layerMaps?.clearcoatNormalTexture);
}

/**
 * True when flattening would lose the exact normal-map tilt: the part has a base or coat normal map, a matrix that is not a
 * uniform scale, and the geometry it was authored with (a baked copy has no matrix left to keep). Cook rebuilds the tilt
 * from the instance matrix like Cycles; a flattened pack only holds world positions and unit normals.
 */
function needsInstanceForNormalMap(part, geometry) {
  return hasNormalMap(part.material) && hasNonConformalMatrix(part.matrix) && sharesAuthoredGeometry(part, geometry);
}

function countSharedGeometries(parts, geometries) {
  const useCounts = new Map();
  parts.forEach((part, index) => {
    if (sharesAuthoredGeometry(part, geometries[index])) useCounts.set(geometries[index], (useCounts.get(geometries[index]) ?? 0) + 1);
  });
  return [...useCounts.values()].filter(count => count > 1).length;
}

/** Validates each part's matrix, and each distinct geometry once, then returns the unique geometry and triangle totals. */
function measureInstancedParts(parts, geometries) {
  const seen = new Set();
  let uniqueGeometries = 0;
  let uniqueTriangles = 0;
  let totalTriangles = 0;
  parts.forEach((part, index) => {
    const geometry = geometries[index];
    validateMatrix(part);
    requireSecondUvSetGeometry(part, geometry);
    totalTriangles += geometry.indices.length / 3;
    if (sharesAuthoredGeometry(part, geometry)) {
      if (seen.has(geometry)) return;
      seen.add(geometry);
    }
    validateGeometry(part, geometry);
    uniqueGeometries++;
    uniqueTriangles += geometry.indices.length / 3;
  });
  return { uniqueGeometries, uniqueTriangles, totalTriangles };
}

function requireInstancedCaps(parts, { uniqueGeometries, uniqueTriangles, totalTriangles }, limits) {
  if (parts.length > limits.instances.count) {
    throw new RangeError(`An instanced ${limits.instances.native ? 'native ' : ''}path trace takes at most ${limits.instances.count} instances, got ${parts.length}. Pass fewer parts, or merge small copies into one mesh.`);
  }
  if (uniqueGeometries > limits.parts.count) {
    throw new RangeError(`An instanced ${limits.parts.native ? 'native ' : ''}path trace takes at most ${limits.parts.count} distinct geometries, got ${uniqueGeometries}. Share one geometry object between copies instead of building a new one per part${limits.parts.native ? ', or merge small meshes' : ''}.`);
  }
  if (uniqueTriangles > limits.unique) {
    throw new RangeError(`An instanced path trace takes at most ${limits.unique} unique triangles, counted once per shared geometry, got ${uniqueTriangles}${limits.native ? `, ${uniqueTriangles - limits.unique} too many` : ''}. Share geometry between copies or simplify the meshes.`);
  }
  if (totalTriangles > limits.total) {
    throw new RangeError(`An instanced native path trace takes at most ${limits.total} triangles with every copy counted, got ${totalTriangles}. Pass fewer copies of the large meshes or simplify them.`);
  }
}

// A part that cannot share its geometry is moved into world space once and traced with an identity matrix.
function bakeWorldGeometry(part, geometry) {
  const world = allocateWorld(geometry.positions.length / 3, geometry.indices.length, Boolean(geometry.lightUvs));
  writeWorldPart(world, part, geometry, 0, 0, 0);
  delete world.triangleMaterial;
  return world;
}

// The native packer reads the second UV set from `uv1s` and expects un-offset `indices`. One view per shared geometry keeps copies sharing one geometry.
function nativeGeometryView(geometry, views) {
  const needsCopy = Boolean(geometry.lightUvs) || geometry.indices.byteOffset !== 0;
  if (!needsCopy) return geometry;
  if (!views.has(geometry)) {
    views.set(geometry, {
      ...geometry,
      ...(geometry.lightUvs ? { uv1s: geometry.lightUvs } : {}),
      ...(geometry.indices.byteOffset !== 0 ? { indices: geometry.indices.slice() } : {}),
    });
  }
  return views.get(geometry);
}

function instanceFor(part, geometry, partIndex, material, views) {
  const shared = sharesAuthoredGeometry(part, geometry);
  const instance = {
    geometry: shared ? nativeGeometryView(geometry, views) : bakeWorldGeometry(part, geometry),
    matrix: shared ? part.matrix ?? IDENTITY_MATRIX : IDENTITY_MATRIX,
    materialIndex: partIndex,
    objectId: partIndex,
    lightMask: material.lightMask,
  };
  if (part.material?.lightMaskHi !== undefined) instance.lightMaskHi = part.material.lightMaskHi;
  const visibilityFlags = partRayVisibilityFlags(part, partIndex);
  if (visibilityFlags !== ALL_RAY_KINDS) instance.visibilityFlags = visibilityFlags;
  return instance;
}

// The box around every instance, from the corners of each geometry's box, so it never reads a whole copy.
function instancedBounds(instances) {
  const boxes = new Map();
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const { geometry, matrix } of instances) {
    if (!boxes.has(geometry)) boxes.set(geometry, boundingBoxOf(geometry.positions));
    const box = boxes.get(geometry);
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? box.high[0] : box.low[0];
      const y = corner & 2 ? box.high[1] : box.low[1];
      const z = corner & 4 ? box.high[2] : box.low[2];
      for (let axis = 0; axis < 3; axis++) {
        const world = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        low[axis] = Math.min(low[axis], world);
        high[axis] = Math.max(high[axis], world);
      }
    }
  }
  return { low, high };
}

// The largest coordinate a box reaches.
function extentOf({ low, high }) {
  return Math.max(1e-3, ...low.map(Math.abs), ...high.map(Math.abs));
}

function boundingBoxOf(positions) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[offset + axis]);
      high[axis] = Math.max(high[axis], positions[offset + axis]);
    }
  }
  return { low, high };
}

/**
 * The scene with copies of one geometry kept as instances: `instances` (geometry, matrix, materialIndex, visibility) over
 * the unique geometries, and `materials` indexed by part (`traceMaterials` are the same parts' resolved materials alone, the
 * list a flattened scene calls `materials`), with no world-space triangle arrays and no CPU BVH. Only
 * `buildNativeInputV2` reads this shape, for the native "cycles" kernel.
 */
function buildInstancedTraceScene(parts, geometries, environment, localVolumes, limits) {
  requireInstancedCaps(parts, measureInstancedParts(parts, geometries), limits);
  const tracedPartMaterials = parts.map(tracedMaterialOf);
  // The instanced kernel reads no vertex alpha, so no material takes the vertex alpha cutout here.
  const traceMaterials = tracedPartMaterials.map(material => resolveMaterial(material));
  const materials = tracedPartMaterials.map((material, index) => ({ ...material, ...traceMaterials[index] }));
  const geometryViews = new Map();
  const instances = parts.map((part, index) => instanceFor(part, geometries[index], index, materials[index], geometryViews));
  const bounds = instancedBounds(instances);
  const extent = extentOf(bounds);
  const lights = resolveLights(environment, limits.lights, parts);
  return {
    instances,
    materials,
    traceMaterials,
    // The GPU tracers read this per part flag from the material table; the native kernel reads the instance visibility instead.
    ...(parts.some(part => part.shadowOnly === true) ? { shadowOnlyParts: Uint8Array.from(parts, part => (part.shadowOnly === true ? 1 : 0)) } : {}),
    lights,
    lampLightMasks: ownLampMasks(parts, lights),
    environment: resolveEnvironment(environment.map, environment.cameraIntensity),
    cameraBackground: resolveCameraBackground(environment),
    volume: resolveTraceVolume(environment.volumeFog) ?? resolveTraceDistanceHaze(environment, bounds),
    localVolumes: withWaterMedia(localVolumes, thinWaterMedia(parts, bounds)),
    surfaceOffset: extent * 1e-5,
    farDistance: extent * 1e4,
  };
}

/** True for a trace scene that keeps copies of one mesh as instances instead of flattened triangles. */
export function isInstancedScene(scene) {
  return Array.isArray(scene.instances);
}

/** The triangles a scene holds once per distinct mesh: what the GPU tables carry, and what the triangle limit counts. */
export function uniqueTriangleCount(scene) {
  if (!isInstancedScene(scene)) return scene.indices.length / 3;
  let total = 0;
  for (const geometry of new Set(scene.instances.map(instance => instance.geometry))) total += geometry.indices.length / 3;
  return total;
}

/**
 * `buildTraceScene` with the triangle bound of the device behind `gpuModule` (a tracer backend module that exports
 * `gpuTriangleLimit`). Every GPU caller builds its scene through here, so the bound and the error text are the same for a
 * still, the real-time tracer and the light bake. A page with no device builds with the default bound, so a scene error
 * reaches the caller before the device error of the trace.
 */
export async function buildTraceSceneForDevice(allParts, environment, gpuModule) {
  let deviceLimit;
  try {
    deviceLimit = await gpuModule.gpuTriangleLimit();
  } catch {
    deviceLimit = undefined;
  }
  const options = deviceLimit === undefined ? {} : { gpuTriangleLimit: deviceLimit };
  if (gpuModule.supportsInstancing === true) options.instancing = true;
  return buildTraceScene(allParts, environment, options);
}

const VALID_TRACE_ENVIRONMENT_FIELDS = new Set([
  'map', 'cameraIntensity', 'world', 'keyColor', 'keyIntensity', 'lightDirection',
  'sunAngularRadius', 'sunMaxBounces', 'pointLights', 'spotLights', 'areaLights',
  'fogColor', 'fogDensity', 'volumeFog', 'localVolumes', 'volumeTime', 'volumeShutter',
  'ground', 'setup', 'hdri', 'reflectionHdri', 'keyFromHdri', 'environmentIntensity', 'environmentRotation',
  'fillIntensity', 'ambientIntensity', 'daylight', 'skyTop', 'skyBottom', 'liquid',
  'shadowCascades', 'keyAffects', 'objectReflections', 'floorSkyTrace', 'sunBounce',
  'specularAntiAliasing', 'lines', 'resolveCoplanar', 'viewTransform', 'look', 'wind',
  'sky', 'wetness', 'puddles', 'rain', 'groundBounce', 'outdoorFill', 'roomBounce', 'explosionCenter',
]);

const ENVIRONMENT_FIELD_SUGGESTIONS = {
  suncolor: 'keyColor',
  suncolour: 'keyColor',
  keycolour: 'keyColor',
  lightcolor: 'keyColor',
  lightcolour: 'keyColor',
  sundirection: 'lightDirection',
  sundir: 'lightDirection',
  keydirection: 'lightDirection',
  lightdir: 'lightDirection',
  sunintensity: 'keyIntensity',
  sunstrength: 'keyIntensity',
  sunpower: 'keyIntensity',
  keystrength: 'keyIntensity',
  sunradius: 'sunAngularRadius',
  sunsize: 'sunAngularRadius',
  envmap: 'map',
  environmentmap: 'map',
  skymap: 'map',
  skycolor: 'map',
  background: 'world',
  backgroundcolor: 'world',
};

function editDistance(source, target) {
  const a = source.toLowerCase();
  const b = target.toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const nextPrevious = row[j];
      const cost = a[i - 1] === b[j - 1] ? previous : Math.min(previous, row[j], row[j - 1]) + 1;
      previous = nextPrevious;
      row[j] = cost;
    }
  }
  return row[b.length];
}

function suggestEnvironmentField(key) {
  const alias = ENVIRONMENT_FIELD_SUGGESTIONS[key.toLowerCase()];
  if (alias) return alias;
  let bestField = null;
  let bestDistance = Math.max(4, Math.floor(key.length / 2) + 1);
  for (const candidate of VALID_TRACE_ENVIRONMENT_FIELDS) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestField = candidate;
    }
  }
  return bestField;
}

/** Rejects unknown `environment` fields so typos such as `sunColor` fail with the field the tracers read instead of tracing black. */
export function validateTraceEnvironment(environment) {
  if (!environment || typeof environment !== 'object') return;
  for (const key of Object.keys(environment)) {
    if (VALID_TRACE_ENVIRONMENT_FIELDS.has(key)) continue;
    const suggestion = suggestEnvironmentField(key);
    const hint = suggestion
      ? `Pass "${suggestion}" instead (sun fields are keyColor, keyIntensity and lightDirection).`
      : 'Pass valid fields such as keyColor, keyIntensity, lightDirection or map.';
    throw new RangeError(`Unknown environment field "${key}" in path tracer scene. ${hint}`);
  }
}

/**
 * Builds the scene a path trace reads. With `options.instancing` and at least one geometry shared by two parts, the result
 * holds `instances` instead of flattened triangles (see `buildInstancedTraceScene`); with no shared geometry, or without the
 * option, it is the flattened scene, unchanged. `options.maximumTriangles` (an integer up to MAX_NATIVE_TRACE_TRIANGLES) is for
 * a scene exported to the native "cycles" tracer only: it replaces the 400,000 triangle bound of the CPU and WebGL tracers.
 * `options.maximumInstances` (an integer up to MAX_NATIVE_TRACE_INSTANCES) does the same for the 65,536 instances of an
 * instanced scene; a flattened scene has no instances and keeps its part bound. `options.maximumLights` (an integer up to
 * MAX_NATIVE_TRACE_LIGHTS) replaces the 32 lights of the CPU and WebGL tracers in the same way; light linking then still
 * needs every kind of light within the limits of a drawn frame. `options.maximumParts` (an integer up to MAX_NATIVE_TRACE_PARTS)
 * replaces the 1,024 parts of a flattened scene, and the 1,024 distinct geometries of an instanced one, for the native tracer.
 */
export function buildTraceScene(allParts, environment = {}, options = {}) {
  validateTraceEnvironment(environment);
  const limits = { ...resolveTriangleLimits(options), instances: resolveInstanceLimit(options), lights: resolveLightLimit(options), parts: resolvePartLimit(options) };
  const { volumes: localVolumes, boundsOnlyParts } = resolveTraceLocalVolumes(environment.localVolumes, allParts, environment.volumeTime ?? 0, environment.volumeShutter ?? 0);
  const shownParts = boundsOnlyParts.length ? allParts.filter(part => !boundsOnlyParts.includes(part)) : allParts;
  // A frame where every part is hidden traces the sky or background alone, like the rasterizer (#1806). The BVH and the native kernel need one triangle.
  const parts = Array.isArray(allParts) && allParts.length > 0 && shownParts.length === 0 ? [UNHITTABLE_PLACEHOLDER_PART] : shownParts;
  const tryInstancing = (options.instancing === true || options.instanceNormalMappedParts === true) && Array.isArray(parts) && parts.length > 0;
  const geometries = tryInstancing ? parts.map(traceGeometry) : undefined;
  const instancesWanted = options.instancing === true && countSharedGeometries(parts, geometries) > 0;
  const tiltNeedsInstances = tryInstancing && options.instanceNormalMappedParts === true && parts.some((part, index) => needsInstanceForNormalMap(part, geometries[index]));
  if (instancesWanted || tiltNeedsInstances) return buildInstancedTraceScene(parts, geometries, environment, localVolumes, limits);
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > limits.parts.count) {
    if (!Array.isArray(parts) || parts.length < 1) {
      if (limits.parts.native) throw new RangeError(`A native path trace takes 1 to ${limits.parts.count} parts, got ${Array.isArray(parts) ? 0 : parts}. Pass at least one part with geometry.`);
    } else if (limits.parts.native) {
      throw new RangeError(`A native path trace takes 1 to ${limits.parts.count} parts, got ${parts.length}. Merge small meshes into one part.`);
    }
    throw new RangeError(`A path trace takes 1 to ${MAX_TRACE_PARTS} parts.`);
  }
  const geometry = flattenParts(parts, geometries, limits);
  const bvh = buildTriangleBvh(geometry.positions, geometry.indices);
  const bounds = boundingBoxOf(geometry.positions);
  const extent = extentOf(bounds);
  const tracedPartMaterials = parts.map(tracedMaterialOf);
  const lights = resolveLights(environment, limits.lights, parts);
  return attachTracer({
    ...geometry,
    bvh,
    materials: tracedPartMaterials.map((material, index) => resolveMaterial(material, partUsesVertexAlpha(parts[index]))),
    // The parts' own materials: the fields resolveMaterial leaves out, which the native "cycles" kernel shades.
    partMaterials: tracedPartMaterials,
    shadowOnlyParts: parts.some(part => part.shadowOnly === true) ? Uint8Array.from(parts, part => (part.shadowOnly === true ? 1 : 0)) : null,
    // Per part FORMAT-v2 visibility bits for the native "cycles" kernel; the "legacy" kernel and the other tracers do not read them.
    partRayVisibility: flattenedRayVisibility(parts),
    lights,
    lampLightMasks: ownLampMasks(parts, lights),
    environment: resolveEnvironment(environment.map, environment.cameraIntensity),
    cameraBackground: resolveCameraBackground(environment),
    volume: resolveTraceVolume(environment.volumeFog) ?? resolveTraceDistanceHaze(environment, bounds),
    localVolumes: withWaterMedia(localVolumes, thinWaterMedia(parts, bounds)),
    surfaceOffset: extent * 1e-5,
    farDistance: extent * 1e4,
  });
}
