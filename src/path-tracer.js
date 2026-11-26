import { portalPdf, samplePortalDirection } from './path-tracer-portal.js';
import { cameraFieldOfView, resolveThinLens } from './camera.js';
import { fresnelSchlick } from './material-layers.js';
import { pointLightFalloff } from './ray-query.js';
import { profileGain } from './light-profile.js';
import { buildTraceScene, buildTraceSceneForDevice, partUsesVertexAlpha, refuseLocalVolumes, SUN_ANGULAR_RADIUS, uniqueTriangleCount, validateTraceEnvironment } from './path-tracer-scene.js';
import { denoiseRadiance, estimateRelativeNoise } from './path-tracer-denoise.js';
import { acesChannel, displayColor } from './view-transform.js';
import { VIEW_TRANSFORM_NAMES } from './view-transform-names.js';
import {
  buildFrame, createSurface, dielectricFresnel, environmentPdf, environmentRadiance, evaluateSurface, luminance, mirrorWeight, prepareSurface,
  roughnessToAlpha, sampleEnvironment, sampleGlass, sampleSurface, setWhiteDiffuse, splitSubsurface, writeEscapedAlbedo, writeFirstHitAlbedo,
} from './path-tracer-shading.js';
import { buildLightTree, chooseLightFromTree, LIGHT_TREE_FIRST_HIT_LIGHTS, resolveLightSelection } from './path-tracer-light-tree.js';
import { createRandomWalk, WALK_OUTCOME } from './path-tracer-subsurface.js';
import { describeUntracedWater } from './path-tracer-water.js';
import { henyeyGreensteinPhase, sampleHenyeyGreensteinCosine, volumeInterval, createLocalVolumeCrossing, createLocalVolumeSurfaceShadow, meanEnvironmentRadiance } from './path-tracer-volume.js';

// Offline still renderer: unidirectional path tracing on the CPU with next-event estimation for every light, the
// environment map drawn by importance, and a wavelet denoiser. It reads the same parts, materials, lights and camera
// as the rasterizer. Same input gives the same bytes: random numbers come from a hash of pixel, sample and seed, and
// the clock only decides whether a render is allowed to finish.

export const PATH_TRACER_LIMITS = Object.freeze({
  width: Object.freeze({ minimum: 16, maximum: 4096, fallback: 960 }),
  height: Object.freeze({ minimum: 16, maximum: 4096, fallback: 540 }),
  samples: Object.freeze({ minimum: 1, maximum: 1024, fallback: 64 }),
  bounces: Object.freeze({ minimum: 1, maximum: 16, fallback: 8 }),
  maxSeconds: Object.freeze({ minimum: 1, maximum: 1800, fallback: 300 }),
  fireflyClamp: Object.freeze({ minimum: 1, maximum: 1000, fallback: 20 }),
  noiseThreshold: Object.freeze({ minimum: 0, maximum: 1, fallback: 0 }),
  seed: Object.freeze({ minimum: 0, maximum: 2 ** 31 - 1, fallback: 0 }),
  threads: Object.freeze({ minimum: 1, maximum: 8, fallback: 4 }),
});
export const MAX_TRACE_PIXELS = 2_073_600;
export const MAX_TRACE_RAY_WORK = 4_000_000_000;
const ALPHA_STEP_LIMIT = 64;
// A shadow ray that has lost this much light to glass and water is blocked: the rest is below what a pixel can show.
const MINIMUM_SHADOW_TRANSMITTANCE = 1e-4;
const WORKER_BAND_ROWS = 8;
// Held in a constant so the bundler leaves the URL alone: the worker is its own package entry, built beside this file.
const WORKER_FILE = './path-tracer-worker.js';
const RUSSIAN_ROULETTE_START = 3;
// A pixel is checked for convergence from this many samples on, then after every batch of samples.
const ADAPTIVE_MINIMUM_SAMPLES = 16;
const ADAPTIVE_BATCH_SAMPLES = 8;
// Mean luminance added to the standard error's reference, so very dark pixels are not held to a relative error.
const CONVERGENCE_LUMINANCE_FLOOR = 0.05;
const IGNORED_MAP_FIELDS = ['heightMap'];
// Shading layers of the rasterizer that the tracer's surface model has no term for.
const IGNORED_LAYERS = [
  ['anisotropy', material => material.anisotropy > 0, true],
  ['iridescence', material => material.iridescence > 0, true],
  ['sheen', material => (material.sheenColor ?? []).some(channel => channel !== 0), true],
  ['moss', material => material.moss > 0],
  ['splat layers', (material, kernelMaterials) => Boolean(material.layers || Object.keys(material.layerMaps ?? {}).some(name => !(kernelMaterials ? KERNEL_LAYER_MAPS : ['clearcoatTexture']).includes(name)))],
  ['lightMap', material => Boolean(material.lightMap)],
];
// The layer maps the native "cycles" kernel reads with its whole materials (the roughness maps of the coat and the sheen have no slot).
const KERNEL_LAYER_MAPS = ['clearcoatTexture', 'clearcoatNormalTexture', 'anisotropyTexture', 'sheenColorTexture'];

// The native kernel reads a coat's weight and roughness, and a sheen's tint and roughness, from one map each
// (@codepawlhq/cook job-input carries the map only when it cannot change the roughness).
function hasSplitLayerMap(material) {
  const maps = material.layerMaps ?? {};
  const coatIsSplit = Boolean(maps.clearcoatTexture) && material.clearcoatRoughness > 0 && maps.clearcoatTexture.image !== maps.clearcoatRoughnessTexture?.image;
  const sheenIsSplit = Boolean(maps.sheenColorTexture) && material.sheenRoughness > 0 && maps.sheenColorTexture.image !== maps.sheenRoughnessTexture?.image;
  return coatIsSplit || sheenIsSplit;
}

// The CPU and WebGL tracers read COLOR_0 alpha (a blend part cuts out at half, a mask part adds it to the cutoff test); the others do not.
function vertexAlphaNote(backend, kernelMaterials, alphaMode) {
  if (kernelMaterials || backend === 'webgpu') return 'COLOR_0 vertex alpha is ignored: only the CPU and "gpu" (WebGL) tracers read it. Use one of those backends to trace it.';
  return alphaMode === 'mask' ? 'COLOR_0 vertex alpha is multiplied into the alpha tested against the cutoff.' : 'COLOR_0 vertex alpha on a blended material is traced as a cutout at 0.5.';
}

function hasGraphOpacity(material) {
  return material.pattern?.type === 'graph' && Object.hasOwn(material.pattern.graph ?? {}, 'opacity');
}

function boundedInteger(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (!Number.isInteger(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be an integer from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

function boundedNumber(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be a number from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

// Kept equal to PATH_TRACER_DENOISERS in path-tracer-capabilities.js by tests/path-tracer-denoise-oidn.test.js; the
// capabilities file stays out of this bundle.
export const PATH_TRACER_DENOISERS = Object.freeze(['wavelet', 'oidn', 'none']);
export const SAMPLING_PATTERNS = Object.freeze(['random', 'blue-noise-first']);
export const LIGHT_SELECTIONS = Object.freeze(['auto', 'uniform', 'importance', 'tree']);

/**
 * `denoise` is true (the wavelet filter) or false (none), or a name: "wavelet", "oidn" or "none". "oidn" is the optional
 * native Open Image Denoise (packages/denoise-oidn): the tracer then leaves the colour as traced and returns the feature
 * images, and the caller that has the package filters them.
 */
function denoiserNamed(value) {
  if (value === true) return 'wavelet';
  if (value === false) return 'none';
  if (PATH_TRACER_DENOISERS.includes(value)) return value;
  throw new TypeError(`Path tracer denoise must be a boolean or one of ${PATH_TRACER_DENOISERS.join(', ')}.`);
}

// "webgpu" is the WGSL compute tracer (src/path-tracer-webgpu.js, loaded only for that backend).
const PATH_TRACER_BACKENDS = ['cpu', 'gpu', 'webgpu'];

export function normalizePathTracerOptions(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('Path tracer options must be an object.');
  const result = {
    width: boundedInteger(options, 'width'),
    height: boundedInteger(options, 'height'),
    samples: boundedInteger(options, 'samples'),
    bounces: boundedInteger(options, 'bounces'),
    seed: boundedInteger(options, 'seed'),
    threads: boundedInteger(options, 'threads'),
    maxSeconds: boundedNumber(options, 'maxSeconds'),
    fireflyClamp: boundedNumber(options, 'fireflyClamp'),
    noiseThreshold: boundedNumber(options, 'noiseThreshold'),
    denoiser: denoiserNamed(options.denoise ?? true),
    viewTransform: options.viewTransform ?? 'aces',
    look: options.look ?? null,
    exposure: options.exposure ?? 1,
    backend: options.backend ?? 'cpu',
    samplingPattern: options.samplingPattern ?? 'random',
    lightSelection: options.lightSelection ?? 'auto',
  };
  result.denoise = result.denoiser !== 'none';
  if (typeof result.exposure !== 'number' || !Number.isFinite(result.exposure) || result.exposure <= 0) throw new RangeError(`Path tracer exposure must be a finite number above 0 (got ${result.exposure}). Pass 1 to leave the picture as traced, 2 to double it.`);
  if (!VIEW_TRANSFORM_NAMES.includes(result.viewTransform)) throw new RangeError(`Path tracer viewTransform must be one of ${VIEW_TRANSFORM_NAMES.join(', ')}.`);
  if (!PATH_TRACER_BACKENDS.includes(result.backend)) throw new TypeError('Path tracer backend must be "cpu", "gpu" or "webgpu".');
  if (!SAMPLING_PATTERNS.includes(result.samplingPattern)) throw new RangeError(`Path tracer samplingPattern must be one of ${SAMPLING_PATTERNS.join(', ')}.`);
  if (!LIGHT_SELECTIONS.includes(result.lightSelection)) throw new RangeError(`Path tracer lightSelection must be one of ${LIGHT_SELECTIONS.join(', ')}.`);
  if (result.backend !== 'gpu' && result.samplingPattern !== 'random') {
    throw new RangeError('Path tracer samplingPattern "blue-noise-first" needs backend "gpu"; the CPU reference and the WebGPU tracer draw random samples.');
  }
  if (result.lightSelection === 'importance' && result.backend !== 'gpu') {
    throw new RangeError('Path tracer lightSelection "importance" needs backend "gpu"; the CPU reference and the WebGPU tracer pick lights uniformly; "tree" also runs on the WebGPU tracer.');
  }
  if (result.width * result.height > MAX_TRACE_PIXELS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_PIXELS} pixels.`);
  if (result.width * result.height * result.samples * (result.bounces + 1) > MAX_TRACE_RAY_WORK) throw new RangeError('This path trace would need too much ray work: lower the size, samples or bounces.');
  return result;
}

function finiteVector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new TypeError(`Path tracer camera ${name} must be three finite numbers.`);
  }
  return value;
}

export function createCamera(camera, width, height) {
  const eye = finiteVector(camera.eye, 'eye');
  const target = finiteVector(camera.target, 'target');
  const up = finiteVector(camera.up ?? [0, 1, 0], 'up');
  if (camera.projection === 'orthographic' || camera.shift) throw new RangeError('The path tracer draws perspective cameras without lens shift. Render those without the renderer option.');
  const fov = camera.focalLength === undefined ? camera.fov : cameraFieldOfView(camera, width / height);
  if (typeof fov !== 'number' || !(fov > 1 && fov < 170)) throw new RangeError('Path tracer camera fov must be between 1 and 170 degrees.');
  const forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const forwardLength = Math.hypot(...forward);
  if (forwardLength === 0) throw new RangeError('Path tracer camera eye and target must differ.');
  for (let axis = 0; axis < 3; axis++) forward[axis] /= forwardLength;
  const right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
  const rightLength = Math.hypot(...right);
  if (rightLength === 0) throw new RangeError('Path tracer camera up must not be parallel to its view.');
  for (let axis = 0; axis < 3; axis++) right[axis] /= rightLength;
  const above = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const halfHeight = Math.tan(fov * Math.PI / 360);
  const clipStart = camera.clipStart ?? 0;
  if (typeof clipStart !== 'number' || !Number.isFinite(clipStart) || clipStart < 0 || clipStart > 1e5) throw new RangeError(`Path tracer camera clipStart must be a distance from 0 to 100000 scene units along the view axis, got ${JSON.stringify(camera.clipStart)}. Leave it out to start rays at the eye.`);
  if (typeof camera.far === 'number' && clipStart >= camera.far) throw new RangeError(`Path tracer camera clipStart ${clipStart} is at or past the far plane ${camera.far}, so nothing would be drawn. Pass a clipStart below far, or raise far.`);
  const view = { eye, forward, right, above, halfHeight, halfWidth: halfHeight * width / height, ...(clipStart > 0 ? { clipStart, near: clipStart } : {}) };
  // A camera with an fStop adds its thin lens (apertureRadius, focalDistance, apertureBlades, apertureRotation). Only the
  // native "cycles" kernel draws it; every other tracer ignores the extra fields, and a pinhole view is unchanged.
  const thinLens = resolveThinLens(camera, { aspect: width / height, eye, target });
  return thinLens ? { ...view, ...thinLens } : view;
}

// ---- Random numbers ----

function createRandom() {
  let state = 1;
  return {
    reset(pixel, sample, seed) {
      let mixed = Math.imul(pixel + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(sample + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(seed + 0x165667b1, 0x27d4eb2f);
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x2c1b3c6d);
      mixed = Math.imul(mixed ^ (mixed >>> 12), 0x297a2d39);
      mixed ^= mixed >>> 15;
      state = mixed === 0 ? 1 : mixed;
    },
    // PCG (RXS-M-XS): successive values are independent enough for light and lobe choices that share one path.
    next() {
      state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
      const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
      return (((word >>> 22) ^ word) >>> 0) / 4294967296;
    },
  };
}

// ---- Hits ----

function createHit() {
  return {
    distance: 0, material: null,
    point: new Float64Array(3), normal: new Float64Array(3), color: new Float64Array(3),
    texel: new Float64Array(4), mapTexel: new Float64Array(4), emission: new Float64Array(3),
    metallic: 0, roughness: 0, clearcoat: 0, transmission: 0,
    // Share of indirect light the surface lets in, from its occlusion map: 1 without one.
    occlusion: 1,
  };
}

// Edges of the hit triangle and the matching UV differences, set by fillHit for the tangent frame of a normal map.
const TANGENT_EDGES = new Float64Array(6);
const TANGENT_UV_DIFFERENCES = new Float64Array(4);

/**
 * Tilts the interpolated normal by a tangent-space normal map, with the tangent frame of the hit triangle as in the
 * rasterizer: tangent from the UV gradient made perpendicular to the normal, bitangent following the UV handedness.
 */
function applyNormalMap(material, hit, u, v) {
  const edgeOneX = TANGENT_EDGES[0];
  const edgeOneY = TANGENT_EDGES[1];
  const edgeOneZ = TANGENT_EDGES[2];
  const edgeTwoX = TANGENT_EDGES[3];
  const edgeTwoY = TANGENT_EDGES[4];
  const edgeTwoZ = TANGENT_EDGES[5];
  const uOne = TANGENT_UV_DIFFERENCES[0];
  const vOne = TANGENT_UV_DIFFERENCES[1];
  const uTwo = TANGENT_UV_DIFFERENCES[2];
  const vTwo = TANGENT_UV_DIFFERENCES[3];
  const determinant = uOne * vTwo - uTwo * vOne;
  if (Math.abs(determinant) < 1e-12) return;
  const normalX = hit.normal[0];
  const normalY = hit.normal[1];
  const normalZ = hit.normal[2];
  let tangentX = (edgeOneX * vTwo - edgeTwoX * vOne) / determinant;
  let tangentY = (edgeOneY * vTwo - edgeTwoY * vOne) / determinant;
  let tangentZ = (edgeOneZ * vTwo - edgeTwoZ * vOne) / determinant;
  const bitangentX = (edgeTwoX * uOne - edgeOneX * uTwo) / determinant;
  const bitangentY = (edgeTwoY * uOne - edgeOneY * uTwo) / determinant;
  const bitangentZ = (edgeTwoZ * uOne - edgeOneZ * uTwo) / determinant;
  const alongNormal = tangentX * normalX + tangentY * normalY + tangentZ * normalZ;
  tangentX -= normalX * alongNormal;
  tangentY -= normalY * alongNormal;
  tangentZ -= normalZ * alongNormal;
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  if (tangentLength === 0) return;
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  tangentZ /= tangentLength;
  let crossX = normalY * tangentZ - normalZ * tangentY;
  let crossY = normalZ * tangentX - normalX * tangentZ;
  let crossZ = normalX * tangentY - normalY * tangentX;
  const crossLength = Math.hypot(crossX, crossY, crossZ) || 1;
  const handedness = (crossX * bitangentX + crossY * bitangentY + crossZ * bitangentZ) < 0 ? -1 : 1;
  crossX *= handedness / crossLength;
  crossY *= handedness / crossLength;
  crossZ *= handedness / crossLength;
  const { mapTexel } = hit;
  sampleTexture(material.normalTexture, u, v, mapTexel);
  const sideways = (mapTexel[0] * 2 - 1) * material.normalScale[0];
  const forwards = (mapTexel[1] * 2 - 1) * material.normalScale[1];
  const outwards = mapTexel[2] * 2 - 1;
  const mappedX = tangentX * sideways + crossX * forwards + normalX * outwards;
  const mappedY = tangentY * sideways + crossY * forwards + normalY * outwards;
  const mappedZ = tangentZ * sideways + crossZ * forwards + normalZ * outwards;
  const mappedLength = Math.hypot(mappedX, mappedY, mappedZ);
  if (!(mappedLength > 1e-6)) return;
  hit.normal[0] = mappedX / mappedLength;
  hit.normal[1] = mappedY / mappedLength;
  hit.normal[2] = mappedZ / mappedLength;
}

// The interpolated UVs of the hit, set by fillHit: TEXCOORD_0 then TEXCOORD_1 (zeros when the part has no second set).
const HIT_UV = new Float64Array(4);

/** Samples a map at the hit with the UV set the map names. */
function sampleMap(texture, out) {
  const offset = texture.uvSet === 1 ? 2 : 0;
  sampleTexture(texture, HIT_UV[offset], HIT_UV[offset + 1], out);
}

// A texel index folded into 0..size-1 by a wrap code: 0 repeat, 1 clamp to edge, 2 mirrored repeat.
export function wrapTexelIndex(index, size, mode) {
  if (mode === 1) return Math.max(0, Math.min(size - 1, index));
  if (mode === 2) {
    const folded = ((index % (2 * size)) + 2 * size) % (2 * size);
    return folded < size ? folded : 2 * size - 1 - folded;
  }
  return ((index % size) + size) % size;
}

function sampleTexture(texture, u, v, out) {
  const { width, height, data, colorLookup } = texture;
  const wrapU = texture.wrapU ?? (texture.repeat ? 0 : 1);
  const wrapV = texture.wrapV ?? (texture.repeat ? 0 : 1);
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const shareX = x - left;
  const shareY = y - top;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  for (let corner = 0; corner < 4; corner++) {
    let column = left + (corner & 1);
    let row = top + (corner >> 1);
    column = wrapTexelIndex(column, width, wrapU);
    row = wrapTexelIndex(row, height, wrapV);
    const weight = ((corner & 1) ? shareX : 1 - shareX) * ((corner >> 1) ? shareY : 1 - shareY);
    const base = (row * width + column) * 4;
    for (let channel = 0; channel < 3; channel++) out[channel] += weight * (colorLookup ? colorLookup[data[base + channel]] : data[base + channel] / 255);
    out[3] += weight * data[base + 3] / 255;
  }
}

const CORNER_VERTICES = new Uint32Array(3);
const CORNER_WEIGHTS = new Float64Array(3);

/** Interpolates the surface at a hit: position, facing-corrected normal is left to the caller, colour and alpha. */
function fillHit(scene, triangleId, originX, originY, originZ, directionX, directionY, directionZ, distance, hit) {
  const { positions, normals, uvs, uvs1, colors, vertexAlpha, indices } = scene;
  const first = indices[triangleId * 3];
  const second = indices[triangleId * 3 + 1];
  const third = indices[triangleId * 3 + 2];
  hit.distance = distance;
  hit.point[0] = originX + directionX * distance;
  hit.point[1] = originY + directionY * distance;
  hit.point[2] = originZ + directionZ * distance;
  const edgeOneX = positions[second * 3] - positions[first * 3];
  const edgeOneY = positions[second * 3 + 1] - positions[first * 3 + 1];
  const edgeOneZ = positions[second * 3 + 2] - positions[first * 3 + 2];
  const edgeTwoX = positions[third * 3] - positions[first * 3];
  const edgeTwoY = positions[third * 3 + 1] - positions[first * 3 + 1];
  const edgeTwoZ = positions[third * 3 + 2] - positions[first * 3 + 2];
  const offsetX = hit.point[0] - positions[first * 3];
  const offsetY = hit.point[1] - positions[first * 3 + 1];
  const offsetZ = hit.point[2] - positions[first * 3 + 2];
  const oneOne = edgeOneX * edgeOneX + edgeOneY * edgeOneY + edgeOneZ * edgeOneZ;
  const oneTwo = edgeOneX * edgeTwoX + edgeOneY * edgeTwoY + edgeOneZ * edgeTwoZ;
  const twoTwo = edgeTwoX * edgeTwoX + edgeTwoY * edgeTwoY + edgeTwoZ * edgeTwoZ;
  const offsetOne = offsetX * edgeOneX + offsetY * edgeOneY + offsetZ * edgeOneZ;
  const offsetTwo = offsetX * edgeTwoX + offsetY * edgeTwoY + offsetZ * edgeTwoZ;
  const denominator = oneOne * twoTwo - oneTwo * oneTwo || 1;
  const secondWeight = (twoTwo * offsetOne - oneTwo * offsetTwo) / denominator;
  const thirdWeight = (oneOne * offsetTwo - oneTwo * offsetOne) / denominator;
  const firstWeight = 1 - secondWeight - thirdWeight;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let u = 0;
  let v = 0;
  let secondSetU = 0;
  let secondSetV = 0;
  CORNER_VERTICES[0] = first;
  CORNER_VERTICES[1] = second;
  CORNER_VERTICES[2] = third;
  CORNER_WEIGHTS[0] = firstWeight;
  CORNER_WEIGHTS[1] = secondWeight;
  CORNER_WEIGHTS[2] = thirdWeight;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = CORNER_VERTICES[corner];
    const weight = CORNER_WEIGHTS[corner];
    normalX += weight * normals[vertex * 3];
    normalY += weight * normals[vertex * 3 + 1];
    normalZ += weight * normals[vertex * 3 + 2];
    red += weight * colors[vertex * 3];
    green += weight * colors[vertex * 3 + 1];
    blue += weight * colors[vertex * 3 + 2];
    u += weight * uvs[vertex * 2];
    v += weight * uvs[vertex * 2 + 1];
    if (uvs1) {
      secondSetU += weight * uvs1[vertex * 2];
      secondSetV += weight * uvs1[vertex * 2 + 1];
    }
  }
  HIT_UV[0] = u;
  HIT_UV[1] = v;
  HIT_UV[2] = secondSetU;
  HIT_UV[3] = secondSetV;
  const length = Math.hypot(normalX, normalY, normalZ) || 1;
  hit.normal[0] = normalX / length;
  hit.normal[1] = normalY / length;
  hit.normal[2] = normalZ / length;
  const material = scene.materials[scene.triangleMaterial[triangleId]];
  hit.material = material;
  let alpha = 1;
  hit.color[0] = material.color[0] * red;
  hit.color[1] = material.color[1] * green;
  hit.color[2] = material.color[2] * blue;
  if (material.texture) {
    sampleMap(material.texture, hit.texel);
    hit.color[0] *= hit.texel[0];
    hit.color[1] *= hit.texel[1];
    hit.color[2] *= hit.texel[2];
    alpha = hit.texel[3];
  }
  // COLOR_0 alpha, interpolated at the hit; the scene holds it only for blended and masked parts.
  if (vertexAlpha) alpha *= firstWeight * vertexAlpha[first] + secondWeight * vertexAlpha[second] + thirdWeight * vertexAlpha[third];
  hit.emission[0] = material.emission[0];
  hit.emission[1] = material.emission[1];
  hit.emission[2] = material.emission[2];
  if (material.emissiveTexture) {
    sampleMap(material.emissiveTexture, hit.mapTexel);
    hit.emission[0] *= hit.mapTexel[0];
    hit.emission[1] *= hit.mapTexel[1];
    hit.emission[2] *= hit.mapTexel[2];
  }
  hit.metallic = material.metallic;
  hit.roughness = material.roughness;
  hit.clearcoat = material.clearcoat;
  hit.transmission = material.transmission;
  if (material.clearcoatTexture) {
    sampleMap(material.clearcoatTexture, hit.mapTexel);
    hit.clearcoat *= hit.mapTexel[0];
  }
  if (material.transmissionTexture) {
    sampleMap(material.transmissionTexture, hit.mapTexel);
    hit.transmission *= hit.mapTexel[0];
  }
  if (material.surfaceTexture) {
    sampleMap(material.surfaceTexture, hit.mapTexel);
    hit.roughness *= hit.mapTexel[1];
    hit.metallic *= hit.mapTexel[2];
  }
  hit.occlusion = 1;
  if (material.occlusionTexture) {
    sampleMap(material.occlusionTexture, hit.mapTexel);
    hit.occlusion = 1 + material.occlusionStrength * (hit.mapTexel[0] - 1);
  }
  // A metal does not transmit: only the dielectric share of the surface lets light through (glTF KHR_materials_transmission, #2827).
  hit.transmission *= 1 - hit.metallic;
  if (material.normalTexture) {
    TANGENT_EDGES[0] = edgeOneX;
    TANGENT_EDGES[1] = edgeOneY;
    TANGENT_EDGES[2] = edgeOneZ;
    TANGENT_EDGES[3] = edgeTwoX;
    TANGENT_EDGES[4] = edgeTwoY;
    TANGENT_EDGES[5] = edgeTwoZ;
    const normalSet = material.normalTexture.uvSet === 1 && uvs1 ? uvs1 : uvs;
    TANGENT_UV_DIFFERENCES[0] = normalSet[second * 2] - normalSet[first * 2];
    TANGENT_UV_DIFFERENCES[1] = normalSet[second * 2 + 1] - normalSet[first * 2 + 1];
    TANGENT_UV_DIFFERENCES[2] = normalSet[third * 2] - normalSet[first * 2];
    TANGENT_UV_DIFFERENCES[3] = normalSet[third * 2 + 1] - normalSet[first * 2 + 1];
    const normalOffset = normalSet === uvs1 ? 2 : 0;
    applyNormalMap(material, hit, HIT_UV[normalOffset], HIT_UV[normalOffset + 1]);
  }
  return alpha;
}

/**
 * The nearest solid hit along a ray, stepping through the transparent texels of cutout materials. A camera ray also
 * steps through a shadow-only part, which stays in the scene for shadow and bounce rays (Blender's camera visibility off).
 */
function intersect(scene, originX, originY, originZ, directionX, directionY, directionZ, hit, isCameraRay = false) {
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let travelled = 0;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, scene.farDistance, false);
    if (found.nearestTriangle < 0) return false;
    const seenByCamera = !(isCameraRay && scene.shadowOnlyParts?.[scene.triangleMaterial[found.nearestTriangle]] === 1);
    const alpha = seenByCamera ? fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit) : 0;
    if (seenByCamera && (hit.material.alphaCutoff === 0 || alpha >= hit.material.alphaCutoff)) {
      hit.distance += travelled;
      return true;
    }
    const advance = found.nearestDistance + scene.surfaceOffset;
    travelled += advance;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return false;
}

/** True when the part is the glowing lamp mesh of the point light `lightBit` (src/lamp-mesh.js), which its own shadow rays pass through. */
function isOwnLampMesh(scene, materialIndex, lightBit) {
  return lightBit >= 0 && ((scene.lampLightMasks?.[materialIndex] ?? 0) >> lightBit & 1) === 1;
}

const TRANSMISSIVE_FLAGS = new WeakMap();

/** One byte per material: 1 when a path may refract through it (a transmission factor or map), so a shadow ray must not stop at it. */
function transmissiveMaterialFlags(scene) {
  let flags = TRANSMISSIVE_FLAGS.get(scene);
  if (!flags) {
    flags = Uint8Array.from(scene.materials, material => (material.transmission > 0 || material.transmissionTexture ? 1 : 0));
    TRANSMISSIVE_FLAGS.set(scene, flags);
  }
  return flags;
}

/**
 * Lets a shadow ray through one face of a transmissive part, as far as a straight ray can: the share of light that is not
 * reflected there (Fresnel of the dielectric the tracer's glass lobe uses), the part's transmission and colour, and, when it
 * leaves a part it was inside, Beer-Lambert absorption over the length it travelled. The ray does not bend, so light that
 * refracts around the part (caustics) is not counted. Returns the absorbing part the ray is inside afterwards, or null.
 */
function crossGlassFace(hit, material, directionX, directionY, directionZ, segmentLength, insideMaterial, transmittance) {
  const facing = hit.normal[0] * directionX + hit.normal[1] * directionY + hit.normal[2] * directionZ;
  const entering = facing < 0;
  if (!entering && insideMaterial) absorbOverDistance(insideMaterial, segmentLength, transmittance);
  // The straight ray stands for the one the light would bend into: its angle is the one on the air side of both faces, so no
  // direction meets the glass past the critical angle, and Fresnel is the same entering and leaving.
  const passes = (1 - dielectricFresnel(Math.abs(facing), 1 / material.ior)) * hit.transmission;
  for (let channel = 0; channel < 3; channel++) transmittance[channel] *= passes * hit.color[channel];
  return entering && Number.isFinite(material.attenuationDistance) ? material : null;
}

/**
 * True when the ray is blocked before `limit`. Otherwise `transmittance` holds the share of light per channel that gets
 * through the glass and water on the way (1 when there is none). An opaque part blocks fully; a transmissive part is stepped
 * through with `crossGlassFace`, within ALPHA_STEP_LIMIT surfaces, unless `glassBlocks` says it stops the ray. `insideMaterial` is
 * the absorbing part the ray starts inside.
 */
function occluded(scene, originX, originY, originZ, directionX, directionY, directionZ, limit, hit, transmittance, insideMaterial = null, glassBlocks = false, lightBit = -1) {
  transmittance[0] = 1;
  transmittance[1] = 1;
  transmittance[2] = 1;
  const transmissiveFlags = glassBlocks ? null : transmissiveMaterialFlags(scene);
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let remaining = limit;
  let inside = insideMaterial;
  // An any-hit trace returns the first hit traversal meets, not the nearest. A solid one shadows the point wherever it lies;
  // a transparent one says nothing about what sits before it, so the walk then retraces for nearest hits and steps through.
  let anyHit = true;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, remaining, anyHit);
    if (found.nearestTriangle < 0) return false;
    const materialIndex = scene.triangleMaterial[found.nearestTriangle];
    const ownLamp = isOwnLampMesh(scene, materialIndex, lightBit);
    const transmissive = !ownLamp && !glassBlocks && transmissiveFlags[materialIndex] === 1;
    let covered = false;
    if (!ownLamp) {
      // Only a cutout material needs its texture read to know whether the ray passes through: skip the interpolation for the rest.
      if (!transmissive && scene.materials[materialIndex].alphaCutoff === 0) return true;
      const alpha = fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit);
      covered = alpha >= hit.material.alphaCutoff;
      if (covered && !transmissive) return true;
    }
    if (anyHit) {
      anyHit = false;
      continue;
    }
    if (covered) {
      inside = crossGlassFace(hit, hit.material, directionX, directionY, directionZ, found.nearestDistance, inside, transmittance);
      if (Math.max(transmittance[0], transmittance[1], transmittance[2]) < MINIMUM_SHADOW_TRANSMITTANCE) return true;
    }
    const advance = found.nearestDistance + scene.surfaceOffset;
    remaining -= advance;
    if (remaining <= 0) return false;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return true;
}

// ---- One path ----

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function createPathTracer(scene, options) {
  const surface = createSurface();
  const hit = createHit();
  const shadowHit = createHit();
  const shadowTransmittance = new Float64Array(3);
  const throughput = new Float64Array(3);
  const radiance = new Float64Array(3);
  const direction = new Float64Array(3);
  const lightDirection = new Float64Array(3);
  const lightRadiance = new Float64Array(3);
  const sky = new Float64Array(3);
  const sunFrame = new Float64Array(9);
  const mirror = new Float64Array(3);
  const normal = new Float64Array(3);
  const features = { albedo: new Float64Array(3), normal: new Float64Array(3), depth: 0 };
  const random = createRandom();
  // The denoiser's features come from the first surface a camera ray meets, not from fog in front of it.
  let featuresRecorded = false;
  const { lights, environment } = scene;
  const cameraBackground = scene.cameraBackground ?? null;
  // With portals the sky is drawn through them (#1144); a scene with none samples the whole map as before.
  const portals = environment ? lights.portals ?? [] : [];
  if (lights.sun) buildFrame(lights.sun.direction, sunFrame);
  const sunCosineMax = Math.cos(lights.sun?.angularRadius ?? SUN_ANGULAR_RADIUS);

  function addRadiance(depth, red, green, blue) {
    let clampedRed = red;
    let clampedGreen = green;
    let clampedBlue = blue;
    if (depth > 0) {
      const peak = Math.max(red, green, blue);
      if (peak > options.fireflyClamp) {
        const scale = options.fireflyClamp / peak;
        clampedRed *= scale;
        clampedGreen *= scale;
        clampedBlue *= scale;
      }
    }
    radiance[0] += clampedRed;
    radiance[1] += clampedGreen;
    radiance[2] += clampedBlue;
  }

  // The material of the transmissive part the path is inside, when it absorbs; null outside and inside parts that do not absorb.
  let absorbingMaterial = null;

  // True while a light is sampled from a scattering event in the fog instead of from a surface.
  let inMedium = false;
  const phaseCandidate = { pdf: 0 };
  const volumeSpan = new Float64Array(2);
  const mediumFrame = new Float64Array(9);
  const scatteredDirection = new Float64Array(3);

  /** The share of light that survives the fog along a shadow ray of the given length. */
  function fogTransmittance(originX, originY, originZ, distance) {
    const { volume } = scene;
    if (!volume) return 1;
    if (!volumeInterval(volume, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, volumeSpan)) return 1;
    return Math.exp(-volume.density * (volumeSpan[1] - volumeSpan[0]));
  }

  /** Light from the sampled direction at a scattering event: phase function, shadow ray, fog on the way to the light. */
  function addMediumDirect(depth, distance, weight) {
    const { volume } = scene;
    const cosine = lightDirection[0] * direction[0] + lightDirection[1] * direction[1] + lightDirection[2] * direction[2];
    const phase = henyeyGreensteinPhase(volume.anisotropy, cosine);
    const [originX, originY, originZ] = hit.point;
    if (occluded(scene, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, shadowHit, shadowTransmittance, absorbingMaterial, lightIsEnvironment, sampleLightBit)) return;
    phaseCandidate.pdf = phase;
    const scale = phase * fogTransmittance(originX, originY, originZ, distance) * weight(phaseCandidate);
    addRadiance(
      depth + 1,
      throughput[0] * lightRadiance[0] * scale * shadowTransmittance[0],
      throughput[1] * lightRadiance[1] * scale * shadowTransmittance[1],
      throughput[2] * lightRadiance[2] * scale * shadowTransmittance[2],
    );
  }

  /** Adds the light from one sampled direction: surface value, cosine, shadow ray. `weight` carries MIS and sampling. */
  function addDirect(depth, normal, distance, weight) {
    if (inMedium) {
      addMediumDirect(depth, distance, weight);
      return;
    }
    const cosine = normal[0] * lightDirection[0] + normal[1] * lightDirection[1] + normal[2] * lightDirection[2];
    if (cosine <= 0) return;
    evaluateSurface(surface, lightDirection[0], lightDirection[1], lightDirection[2]);
    const value = surface.value;
    if (value[0] + value[1] + value[2] <= 0) return;
    const originX = hit.point[0] + normal[0] * scene.surfaceOffset;
    const originY = hit.point[1] + normal[1] * scene.surfaceOffset;
    const originZ = hit.point[2] + normal[2] * scene.surfaceOffset;
    if (occluded(scene, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, shadowHit, shadowTransmittance, absorbingMaterial, lightIsEnvironment, sampleLightBit)) return;
    const scale = cosine * weight(surface) * fogTransmittance(originX, originY, originZ, distance);
    if (lightIsSun && writeSunShadow) writeSunShadow(originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], sunShadow);
    else sunShadow.fill(1);
    addRadiance(
      depth,
      throughput[0] * value[0] * lightRadiance[0] * scale * sunShadow[0] * shadowTransmittance[0],
      throughput[1] * value[1] * lightRadiance[1] * scale * sunShadow[1] * shadowTransmittance[1],
      throughput[2] * value[2] * lightRadiance[2] * scale * sunShadow[2] * shadowTransmittance[2],
    );
  }

  // Past the first hit one light is drawn at random instead of all of them, so a scene with many lights costs one shadow
  // ray per bounce. `selectionProbability` is the chance that this light was the one drawn; dividing by it keeps the sum unbiased.
  let selectionProbability = 1;
  // The point light whose shadow ray is being traced, or -1: that light's own lamp mesh does not block it.
  let sampleLightBit = -1;
  const fullWeight = () => 1 / selectionProbability;

  // A light skips a part whose mask has its bit clear, at every bounce, so it is no bounce source there either.
  const reaches = light => inMedium || (hit.material.lightMask >> light.bit & 1) === 1;

  function sampleSun(depth, normal) {
    if (!reaches(lights.sun)) return;
    const cosineTheta = 1 - random.next() * (1 - sunCosineMax);
    const sineTheta = Math.sqrt(Math.max(0, 1 - cosineTheta * cosineTheta));
    const phi = 2 * Math.PI * random.next();
    const across = sineTheta * Math.cos(phi);
    const along = sineTheta * Math.sin(phi);
    for (let axis = 0; axis < 3; axis++) lightDirection[axis] = sunFrame[axis] * across + sunFrame[3 + axis] * along + sunFrame[6 + axis] * cosineTheta;
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = lights.sun.color[channel];
    lightIsSun = true;
    addDirect(depth, normal, scene.farDistance, fullWeight);
    lightIsSun = false;
  }

  function aimAt(targetX, targetY, targetZ) {
    const deltaX = targetX - hit.point[0];
    const deltaY = targetY - hit.point[1];
    const deltaZ = targetZ - hit.point[2];
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    const distance = Math.sqrt(distanceSquared);
    lightDirection[0] = deltaX / distance;
    lightDirection[1] = deltaY / distance;
    lightDirection[2] = deltaZ / distance;
    return { distance, distanceSquared };
  }

  function randomOnSphere(radius, out) {
    const height = 2 * random.next() - 1;
    const angle = 2 * Math.PI * random.next();
    const ring = Math.sqrt(1 - height * height);
    out[0] = radius * ring * Math.cos(angle);
    out[1] = radius * height;
    out[2] = radius * ring * Math.sin(angle);
  }

  const jitter = new Float64Array(3);

  function samplePointLight(depth, normal, light) {
    if (!reaches(light)) return;
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    sampleLightBit = light.bit;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
    sampleLightBit = -1;
  }

  function sampleSpotLight(depth, normal, light) {
    if (!reaches(light)) return;
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const axisCosine = -(light.direction[0] * lightDirection[0] + light.direction[1] * lightDirection[1] + light.direction[2] * lightDirection[2]);
    const inside = axisCosine - light.cosineHalfAngle;
    if (inside <= 0) return;
    const mask = light.blend > 0 && inside < light.blend ? smoothstep(inside / light.blend) : 1;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light) * mask * (light.profile ? profileGain(light.profile, axisCosine) : 1);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  function sampleAreaLight(depth, normal, light) {
    if (!reaches(light)) return;
    const across = (random.next() - 0.5) * light.width;
    const along = (random.next() - 0.5) * light.height;
    const pointX = light.position[0] + light.across[0] * across + light.along[0] * along;
    const pointY = light.position[1] + light.across[1] * across + light.along[1] * along;
    const pointZ = light.position[2] + light.across[2] * across + light.along[2] * along;
    const { distance, distanceSquared } = aimAt(pointX, pointY, pointZ);
    if (distance < 1e-6) return;
    const emitCosine = -(light.normal[0] * lightDirection[0] + light.normal[1] * lightDirection[1] + light.normal[2] * lightDirection[2]);
    if (emitCosine <= 0) return;
    const strength = light.intensity * emitCosine / distanceSquared * (light.profile ? profileGain(light.profile, emitCosine) : 1);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  let environmentSampledPdf = 0;
  const environmentWeight = candidate => {
    const lightPdf = environmentSampledPdf * selectionProbability;
    const total = lightPdf * lightPdf + candidate.pdf * candidate.pdf;
    return lightPdf * lightPdf / total / lightPdf;
  };

  function sampleEnvironmentLight(depth, normal) {
    environmentSampledPdf = portals.length > 0
      ? samplePortalDirection(portals, hit.point[0], hit.point[1], hit.point[2], random.next(), random.next(), random.next(), lightDirection)
      : sampleEnvironment(environment, random.next(), random.next(), random.next(), random.next(), lightDirection);
    if (!(environmentSampledPdf > 0)) return;
    environmentRadiance(environment, lightDirection[0], lightDirection[1], lightDirection[2], lightRadiance);
    // A path that bends through glass and reaches the sky is already counted in full (addEscape after a mirror or glass bounce), so
    // the sky's shadow ray stops at glass: letting it through as well would count that light twice.
    lightIsEnvironment = true;
    // The sky is indirect light, so the occlusion map darkens it; the sun and the lights above are direct and are not.
    const { occlusion } = hit;
    const [pathRed, pathGreen, pathBlue] = throughput;
    throughput[0] = pathRed * occlusion;
    throughput[1] = pathGreen * occlusion;
    throughput[2] = pathBlue * occlusion;
    addDirect(depth, normal, scene.farDistance, environmentWeight);
    throughput[0] = pathRed;
    throughput[1] = pathGreen;
    throughput[2] = pathBlue;
    lightIsEnvironment = false;
  }

  const emitterCount = (lights.sun ? 1 : 0) + lights.points.length + lights.spots.length + lights.areas.length + (environment ? 1 : 0);

  function addEveryLight(depth, normal) {
    selectionProbability = 1;
    if (lights.sun) sampleSun(depth, normal);
    for (const light of lights.points) samplePointLight(depth, normal, light);
    for (const light of lights.spots) sampleSpotLight(depth, normal, light);
    for (const light of lights.areas) sampleAreaLight(depth, normal, light);
    if (environment) sampleEnvironmentLight(depth, normal);
  }

  const lightCount = lights.points.length + lights.spots.length + lights.areas.length;
  const useLightTree = resolveLightSelection(options.lightSelection, lights) === 'tree' && lightCount > 1;
  const lightTree = useLightTree ? buildLightTree(lights) : null;
  const drawRandom = () => random.next();
  function sampleLightByIndex(depth, normal, index) {
    if (index < lights.points.length) return samplePointLight(depth, normal, lights.points[index]);
    index -= lights.points.length;
    if (index < lights.spots.length) return sampleSpotLight(depth, normal, lights.spots[index]);
    return sampleAreaLight(depth, normal, lights.areas[index - lights.spots.length]);
  }

  const linkedLightsByMask = new Map();
  const allLights = () => [...lights.points, ...lights.spots, ...lights.areas];
  /** The sampling-order indices of the local lights the hit part is lit by; every light inside a medium. */
  function linkedLights() {
    const mask = inMedium ? -1 : hit.material.lightMask;
    let linked = linkedLightsByMask.get(mask);
    if (!linked) {
      linked = [];
      allLights().forEach((light, index) => {
        if ((mask >> light.bit & 1) === 1) linked.push(index);
      });
      linkedLightsByMask.set(mask, linked);
    }
    return linked;
  }

  /** One emitter by the light tree: the sun and the sky keep a uniform share, the local lights share theirs down the tree. */
  function addOneLightByTree(depth, normal) {
    const lightsShare = lightCount / emitterCount;
    let remaining = Math.floor(random.next() * emitterCount);
    if (lights.sun) {
      if (remaining === 0) {
        selectionProbability = 1 / emitterCount;
        return sampleSun(depth, normal);
      }
      remaining--;
    }
    if (remaining >= lightCount) {
      selectionProbability = 1 / emitterCount;
      return sampleEnvironmentLight(depth, normal);
    }
    const linked = linkedLights();
    if (linked.length < lightCount) {
      // The tree weighs a node by every light under it, linked or not, so a receiver with light linking draws uniformly among the lights it can see.
      selectionProbability = 1 / emitterCount;
      if (linked.length === 0) return;
      selectionProbability = lightsShare / linked.length;
      sampleLightByIndex(depth, normal, linked[Math.floor(random.next() * linked.length)]);
      selectionProbability = 1 / emitterCount;
      return;
    }
    const picked = chooseLightFromTree(lightTree, hit.point[0], hit.point[1], hit.point[2], normal[0], normal[1], normal[2], drawRandom);
    selectionProbability = 1 / emitterCount;
    if (picked.lightIndex < 0) return;
    selectionProbability = lightsShare * picked.probability;
    sampleLightByIndex(depth, normal, picked.lightIndex);
    // The sky is drawn with its uniform share whatever light was chosen: that share weighs the next escape ray.
    selectionProbability = 1 / emitterCount;
  }

  function addOneLight(depth, normal) {
    selectionProbability = 1 / emitterCount;
    let remaining = Math.floor(random.next() * emitterCount);
    if (lights.sun) {
      if (remaining === 0) return sampleSun(depth, normal);
      remaining--;
    }
    if (remaining < lights.points.length) return samplePointLight(depth, normal, lights.points[remaining]);
    remaining -= lights.points.length;
    if (remaining < lights.spots.length) return sampleSpotLight(depth, normal, lights.spots[remaining]);
    remaining -= lights.spots.length;
    if (remaining < lights.areas.length) return sampleAreaLight(depth, normal, lights.areas[remaining]);
    return sampleEnvironmentLight(depth, normal);
  }

  function addLights(depth, normal) {
    const firstHitByTree = useLightTree && lightCount > LIGHT_TREE_FIRST_HIT_LIGHTS;
    if ((depth === 0 && !firstHitByTree) || emitterCount <= 1) addEveryLight(depth, normal);
    else if (useLightTree) addOneLightByTree(depth, normal);
    else addOneLight(depth, normal);
  }

  // A ray that has only gone straight on or through glass is a camera ray: with world false it sees the flat background the
  // rasterizer clears to, not the map (the map still lights the scene through the escapes of every other ray, #2016).
  function addEscape(depth, previousPdf, afterMirror, originX, originY, originZ, isCameraRay) {
    if (isCameraRay && cameraBackground) {
      addRadiance(depth, throughput[0] * cameraBackground[0], throughput[1] * cameraBackground[1], throughput[2] * cameraBackground[2]);
      return;
    }
    if (!environment) return;
    environmentRadiance(environment, direction[0], direction[1], direction[2], sky);
    let weight = 1;
    if (!afterMirror) {
      const environmentSide = (portals.length > 0 ? portalPdf(portals, originX, originY, originZ, direction[0], direction[1], direction[2]) : environmentPdf(environment, direction[0], direction[1], direction[2])) * selectionProbability;
      weight = previousPdf * previousPdf / (previousPdf * previousPdf + environmentSide * environmentSide);
    }
    addRadiance(depth, throughput[0] * sky[0] * weight, throughput[1] * sky[1] * weight, throughput[2] * sky[2] * weight);
    if (!featuresRecorded) writeEscapedAlbedo(features.albedo);
  }

  function recordFeatures(normal, viewX, viewY, viewZ) {
    const { transmission } = hit;
    if (transmission < 1) prepareSurface(surface, hit.material, hit.metallic, hit.roughness, hit.color, normal, viewX, viewY, viewZ, hit.clearcoat);
    writeFirstHitAlbedo(features.albedo, surface, hit.material, hit.color, transmission, normal[0] * viewX + normal[1] * viewY + normal[2] * viewZ);
    features.normal[0] = normal[0];
    features.normal[1] = normal[1];
    features.normal[2] = normal[2];
    features.depth = hit.distance;
  }

  function survivesRoulette(depth) {
    if (depth < RUSSIAN_ROULETTE_START) return true;
    const survival = Math.min(0.95, Math.max(0.05, Math.max(throughput[0], throughput[1], throughput[2])));
    if (random.next() >= survival) return false;
    for (let channel = 0; channel < 3; channel++) throughput[channel] /= survival;
    return true;
  }

  /**
   * Draws the distance to the next scattering event along the segment. When it falls inside the fog before the segment ends,
   * puts the event in `hit.point` and returns true; otherwise the ray crosses the fog (or misses it) unchanged, because the
   * chance of not scattering is exactly the transmittance that the sampling would otherwise multiply in.
   */
  function scatterInFog(originX, originY, originZ, segmentLength) {
    const { volume } = scene;
    if (!volumeInterval(volume, originX, originY, originZ, direction[0], direction[1], direction[2], segmentLength, volumeSpan)) return false;
    const eventDistance = volumeSpan[0] - Math.log(1 - random.next()) / volume.density;
    if (eventDistance >= volumeSpan[1]) return false;
    hit.point[0] = originX + direction[0] * eventDistance;
    hit.point[1] = originY + direction[1] * eventDistance;
    hit.point[2] = originZ + direction[2] * eventDistance;
    return true;
  }

  /** Lights the scattering event, then turns `direction` by a Henyey-Greenstein draw. Returns the draw's density. */
  function scatterInMedium(depth) {
    const { volume } = scene;
    for (let channel = 0; channel < 3; channel++) throughput[channel] *= volume.albedo[channel];
    inMedium = true;
    addLights(depth, normal);
    inMedium = false;
    const cosine = sampleHenyeyGreensteinCosine(volume.anisotropy, random.next());
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const azimuth = 2 * Math.PI * random.next();
    buildFrame(direction, mediumFrame);
    for (let axis = 0; axis < 3; axis++) {
      scatteredDirection[axis] = mediumFrame[axis] * sine * Math.cos(azimuth) + mediumFrame[3 + axis] * sine * Math.sin(azimuth) + mediumFrame[6 + axis] * cosine;
    }
    for (let axis = 0; axis < 3; axis++) direction[axis] = scatteredDirection[axis];
    return henyeyGreensteinPhase(volume.anisotropy, cosine);
  }

  // A scattering local volume is lit by the sky's mean radiance and by the sun through a shadow ray, as the rasterizer lights it.
  const localVolumeLighting = scene.localVolumes?.some(volume => volume.scatter > 0)
    ? {
      sun: lights.sun,
      ambient: meanEnvironmentRadiance(environment),
      sunVisibility: (pointX, pointY, pointZ) => (occluded(scene, pointX, pointY, pointZ, lights.sun.direction[0], lights.sun.direction[1], lights.sun.direction[2], scene.farDistance, shadowHit, shadowTransmittance) ? 0 : (shadowTransmittance[0] + shadowTransmittance[1] + shadowTransmittance[2]) / 3),
    }
    : null;
  const crossLocalVolumes = scene.localVolumes ? createLocalVolumeCrossing(scene.localVolumes, localVolumeLighting) : null;
  // The local volumes that cast shadows dim the sun's direct light at a surface (#1047); sunShadow holds the per-channel factor of the last sun sample.
  const writeSunShadow = scene.localVolumes ? createLocalVolumeSurfaceShadow(scene.localVolumes) : null;
  const sunShadow = new Float64Array(3);
  let lightIsSun = false;
  let lightIsEnvironment = false;
  const localEmitted = new Float64Array(3);

  const walkSubsurface = createRandomWalk(scene, random, intersect);
  const walkWeight = new Float64Array(3);

  /**
   * Sends the diffuse light of the hit through its subsurface random walk. On success the path stands where the walk left (or,
   * for a card with nothing behind it, on the near or far face), `normal` faces out of that point, `surface` is a white diffuse
   * lobe there with its lights added, and the throughput carries the walk. False when the walk ended inside the part.
   */
  function enterSubsurface(depth, subsurface) {
    const color = subsurface.color ?? hit.color;
    walkWeight.fill(1);
    const outcome = walkSubsurface(subsurface, color, hit.point[0], hit.point[1], hit.point[2], normal, hit.material, shadowHit, walkWeight);
    if (outcome === WALK_OUTCOME.lost) return false;
    const entryScale = surface.diffuseShare * subsurface.weight / surface.subsurfaceChance;
    if (outcome === WALK_OUTCOME.exit) {
      const facing = shadowHit.normal[0] * walkSubsurface.direction[0] + shadowHit.normal[1] * walkSubsurface.direction[1] + shadowHit.normal[2] * walkSubsurface.direction[2] < 0 ? -1 : 1;
      for (let axis = 0; axis < 3; axis++) {
        hit.point[axis] = shadowHit.point[axis];
        normal[axis] = shadowHit.normal[axis] * facing;
      }
      for (let channel = 0; channel < 3; channel++) throughput[channel] *= walkWeight[channel] * entryScale;
    } else {
      // A card: half of the colour is reflected on the side the ray came from and half is transmitted diffusely through it.
      if (random.next() < 0.5) for (let axis = 0; axis < 3; axis++) normal[axis] = -normal[axis];
      for (let channel = 0; channel < 3; channel++) throughput[channel] *= color[channel] * entryScale;
    }
    setWhiteDiffuse(surface, normal);
    addLights(depth, normal);
    return true;
  }

  /** Follows one camera ray. Leaves the radiance in `radiance` and the first-hit features in `features`. */
  function trace(originX, originY, originZ, directionX, directionY, directionZ, pixel, sample) {
    random.reset(pixel, sample, options.seed);
    radiance[0] = 0;
    radiance[1] = 0;
    radiance[2] = 0;
    throughput[0] = 1;
    throughput[1] = 1;
    throughput[2] = 1;
    features.albedo.fill(0);
    featuresRecorded = false;
    // A ray that finds nothing has the sky as its feature: one fixed normal and depth, so the filter treats sky as one surface.
    features.normal[0] = 0;
    features.normal[1] = 0;
    features.normal[2] = 1;
    features.depth = 0;
    direction[0] = directionX;
    direction[1] = directionY;
    direction[2] = directionZ;
    let positionX = originX;
    let positionY = originY;
    let positionZ = originZ;
    let previousPdf = 0;
    let afterMirror = true;
    absorbingMaterial = null;
    let isCameraRay = true;
    for (let depth = 0; depth <= options.bounces; depth++) {
      const found = intersect(scene, positionX, positionY, positionZ, direction[0], direction[1], direction[2], hit, depth === 0);
      if (absorbingMaterial && found) absorbOverDistance(absorbingMaterial, hit.distance, throughput);
      const scattersInFog = scene.volume && scatterInFog(positionX, positionY, positionZ, found ? hit.distance : scene.farDistance);
      if (crossLocalVolumes) {
        const segmentLength = scattersInFog ? Math.hypot(hit.point[0] - positionX, hit.point[1] - positionY, hit.point[2] - positionZ) : (found ? hit.distance : scene.farDistance);
        crossLocalVolumes(positionX, positionY, positionZ, direction[0], direction[1], direction[2], segmentLength, random.next(), throughput, localEmitted);
        addRadiance(depth, localEmitted[0], localEmitted[1], localEmitted[2]);
      }
      if (scattersInFog) {
        previousPdf = scatterInMedium(depth);
        afterMirror = false;
        isCameraRay = false;
        positionX = hit.point[0];
        positionY = hit.point[1];
        positionZ = hit.point[2];
        if (!survivesRoulette(depth)) break;
        continue;
      }
      if (!found) {
        addEscape(depth, previousPdf, afterMirror, positionX, positionY, positionZ, isCameraRay);
        break;
      }
      const material = hit.material;
      const entering = hit.normal[0] * direction[0] + hit.normal[1] * direction[1] + hit.normal[2] * direction[2] < 0;
      const facing = entering ? 1 : -1;
      normal[0] = hit.normal[0] * facing;
      normal[1] = hit.normal[1] * facing;
      normal[2] = hit.normal[2] * facing;
      const isGlass = hit.transmission > 0 && random.next() < hit.transmission;
      const viewX = -direction[0];
      const viewY = -direction[1];
      const viewZ = -direction[2];
      if (!featuresRecorded) {
        recordFeatures(normal, viewX, viewY, viewZ);
        featuresRecorded = true;
      }
      const emissionScale = hit.material.emissionFresnel > 0
        ? fresnelSchlick(-(direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2]), hit.material.emissionFresnel)
        : 1;
      addRadiance(depth, throughput[0] * hit.emission[0] * emissionScale, throughput[1] * hit.emission[1] * emissionScale, throughput[2] * hit.emission[2] * emissionScale);
      if (isGlass) {
        const alpha = roughnessToAlpha(hit.roughness);
        if (!sampleGlass(normal, viewX, viewY, viewZ, entering, material.ior, alpha, random.next(), random.next(), random.next(), direction)) break;
        const refracted = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2] < 0;
        if (!refracted) isCameraRay = false;
        if (refracted) {
          throughput[0] *= hit.color[0];
          throughput[1] *= hit.color[1];
          throughput[2] *= hit.color[2];
          absorbingMaterial = entering && Number.isFinite(material.attenuationDistance) ? material : null;
        }
        afterMirror = true;
      } else {
        isCameraRay = false;
        prepareSurface(surface, material, hit.metallic, hit.roughness, hit.color, normal, viewX, viewY, viewZ, hit.clearcoat);
        const subsurface = material.subsurface;
        if (subsurface) splitSubsurface(surface, subsurface.weight);
        addLights(depth, normal);
        let lobeUnit = random.next();
        if (subsurface) {
          if (lobeUnit < surface.subsurfaceChance) {
            if (!enterSubsurface(depth, subsurface)) break;
            lobeUnit = 0;
          } else {
            lobeUnit -= surface.subsurfaceChance;
          }
        }
        const isMirror = sampleSurface(surface, lobeUnit, random.next(), random.next(), direction);
        const cosine = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
        if (cosine <= 0) break;
        // Everything the next ray gathers (sky and bounced light) is indirect, so the occlusion map scales it.
        for (let channel = 0; channel < 3; channel++) throughput[channel] *= hit.occlusion;
        if (isMirror) {
          mirrorWeight(surface, mirror);
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= mirror[channel];
          afterMirror = true;
        } else {
          evaluateSurface(surface, direction[0], direction[1], direction[2]);
          if (!(surface.pdf > 0)) break;
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= surface.value[channel] * cosine / surface.pdf;
          previousPdf = surface.pdf;
          afterMirror = false;
        }
      }
      positionX = hit.point[0] + direction[0] * scene.surfaceOffset;
      positionY = hit.point[1] + direction[1] * scene.surfaceOffset;
      positionZ = hit.point[2] + direction[2] * scene.surfaceOffset;
      if (!survivesRoulette(depth)) break;
    }
  }

  return { trace, radiance, features };
}

/** Beer-Lambert: the colour `attenuationColor` is what `attenuationDistance` metres of the part let through, so a path of `distance` metres keeps colour^(distance / attenuationDistance). */
function absorbOverDistance(material, distance, throughput) {
  const metres = distance / material.attenuationDistance;
  for (let channel = 0; channel < 3; channel++) throughput[channel] *= material.attenuationColor[channel] ** metres;
}

// ---- Image ----

/** The display transform of the rasterizer's post pass (exposure, view transform, gamma 2.2, optional look) applied to linear pixels. */
export function toneMapToRgba8(linear, width, height, { viewTransform = 'aces', look = null, exposure = 1 } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const plainCurve = viewTransform === 'aces' && !look;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const color = plainCurve
      ? [0, 1, 2].map(channel => acesChannel(linear[pixel * 3 + channel] * exposure) ** (1 / 2.2))
      : displayColor([linear[pixel * 3] * exposure, linear[pixel * 3 + 1] * exposure, linear[pixel * 3 + 2] * exposure], { viewTransform, look });
    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = Math.round(color[channel] * 255);
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}

/** Names what this scene asks for that the path tracer does not draw, so a result never claims more than it traced. */
export function describeIgnoredFeatures(parts, environment, backend = 'cpu', { kernelMaterials = false, clipStart = 0 } = {}) {
  const notes = new Set();
  if (clipStart > 0 && backend === 'gpu') notes.add('camera.clipStart is ignored: only the CPU, WebGPU and native cycles tracers start camera rays at it, so geometry between the eye and the clip start is drawn.');
  const fog = environment?.volumeFog;
  if (fog?.density > 0 && (fog.noiseAmount ?? 0.5) > 0) notes.add('volumeFog is traced as a uniform medium: noiseAmount, noiseScale and drift are ignored.');
  if (fog?.density > 0 && fog.ambient) notes.add('volumeFog.ambient is not added: the fog is lit by the traced lights and sky.');
  if (environment?.world === true && environment.fogDensity > 0 && !(fog?.density > 0)) notes.add('fogDensity is traced as a uniform medium with extinction fogDensity per metre and fogColor as its scatter colour, lit by the traced lights and sky; the sky and ground haze shading of the rasterizer is not.');
  const hasSoftFalloff = [...(environment?.pointLights ?? []), ...(environment?.spotLights ?? [])].some(light => light.softFalloff === true);
  if (hasSoftFalloff && !kernelMaterials) notes.add('softFalloff is ignored: only the native cycles kernel draws a light as an oriented disk, the other tracers draw a sphere.');
  const lightsWithOwnLimit = [...(environment?.pointLights ?? []), ...(environment?.spotLights ?? []), ...(environment?.areaLights ?? [])];
  const hasBounceLimit = environment?.sunMaxBounces !== undefined || lightsWithOwnLimit.some(light => light.maxBounces !== undefined);
  if (hasBounceLimit && !kernelMaterials) notes.add('A light maxBounces (sunMaxBounces for the sun) is ignored: only the native cycles kernel stops a light after its own bounces, the other tracers run every light to the scene bounces.');
  const hasPortal = (environment?.areaLights ?? []).some(light => light.portal === true);
  if (hasPortal && !kernelMaterials && backend === 'gpu') notes.add('Light portals (areaLights with portal: true) are ignored: only the native cycles kernel, the CPU tracer and the WebGPU tracer sample the environment through them, the other tracers draw no light from a portal.');
  const hasGridVolume = (environment?.localVolumes ?? []).some(volume => volume?.shape === 'grid');
  if (hasGridVolume && kernelMaterials && environment.volumeShutter > 0) notes.add('environment.volumeShutter is ignored for a grid volume: Cook draws the grid as it is at the frame time, with no motion blur from its velocity channel. Use backend "cpu" or "webgpu" for a blurred blast.');
  if ((environment?.localVolumes ?? []).some(volume => volume?.shape === 'grid' && volume.noiseAmount > 0)) notes.add('noiseAmount, noiseScale and noiseOctaves of a grid volume are ignored: only the rasterizer adds that fine detail on top of the grid, a trace reads the grid as it is.');
  const sunColor = Array.from(environment?.keyColor ?? [], channel => channel * (environment?.keyIntensity ?? 1));
  const hasSun = sunColor.some(channel => channel > 0);
  if (!environment?.map) {
    notes.add('There is no environment map, so the sky is black and only the lights shine.');
    if (!hasSun) notes.add('No sun is set: set keyColor, keyIntensity and lightDirection to add a sun.');
  }
  if (environment?.fillIntensity > 0) notes.add('fillIntensity is ignored: the two fixed fill lights are rasterizer only. Add a point or area light, or raise environmentIntensity, to light the shadow side of a trace.');
  if (environment?.world === true) notes.add('world: true is ignored: the outdoor haze shading is rasterizer only, and a trace draws the environment map behind the picture and lights with it.');
  if (environment?.world === false && kernelMaterials) notes.add('world: false draws the flat background colour behind the picture in the CPU, "gpu" (WebGL) and "webgpu" tracers only: the native cycles kernel draws the environment map there, as it lights with it.');
  if (environment?.cameraIntensity !== undefined && !kernelMaterials) notes.add('cameraIntensity is ignored: only the native cycles kernel draws the sky a camera ray sees at its own strength, the other tracers use the map intensity.');
  for (const part of parts) {
    const material = part.material ?? {};
    for (const note of describeUntracedWater(part)) notes.add(note);
    if (material.tag === 'water' && backend === 'gpu') notes.add('The depth tint under a thin water sheet is not drawn: the CPU, WebGPU and native cycles tracers add an absorbing medium under it, the WebGL tracer draws the water clear.');
    if (partUsesVertexAlpha(part)) notes.add(vertexAlphaNote(backend, kernelMaterials, material.alphaMode));
    for (const field of IGNORED_MAP_FIELDS) if (material[field]) notes.add(`${field} is ignored.`);
    if (material.occlusionMap && (kernelMaterials || (backend !== 'cpu' && backend !== 'webgpu'))) notes.add(kernelMaterials ? 'occlusionMap is ignored by the native cycles kernel: its material record has no occlusion slot (codepawl/cook#71). Use backend "cpu" or "webgpu" to trace it.' : `occlusionMap is ignored by the ${backend} tracer: only the CPU and WebGPU tracers read it. Use backend "cpu" or "webgpu" to trace it.`);
    if (material.tag && material.tag !== 'surface' && material.tag !== 'water') notes.add(`${material.tag} materials are traced as plain surfaces.`);
    if (material.alphaMode === 'blend' && hasGraphOpacity(material)) notes.add('A graph opacity output is traced as a cutout at 0.5.');
    else if (material.alphaMode === 'blend' && !kernelMaterials) notes.add('Blended transparency is traced as opaque.');
    if (!kernelMaterials && (material.layerMaps?.clearcoatTexture || material.transmissionMap)) notes.add('Graph clearcoat and transmission masks are read by the CPU tracer; the GPU tracers use the factors.');
    if (kernelMaterials && hasSplitLayerMap(material)) notes.add('A clearcoat or sheen colour map is ignored when the layer has a roughness above 0 kept in another map.');
    if (material.emissionFresnel > 0 && kernelMaterials) notes.add('emission fresnel is ignored by the native cycles kernel: its material record has no slot for it. The cpu, "gpu" and "webgpu" tracers apply it.');
    if (material.emissionMask) notes.add('emissionMask is ignored by the path tracers; the rasterizer applies it.');
    for (const [name, isUsed, kernelShades] of IGNORED_LAYERS) if (!(kernelMaterials && kernelShades) && isUsed(material, kernelMaterials)) notes.add(`${name} is ignored.`);
  }
  return [...notes];
}

/**
 * Renders rows `rowStart` up to `rowEnd` and returns their buffers (colour, albedo, normal, depth, variance), row
 * major from the band's first row. A pixel's random numbers depend only on its place in the whole image, so bands
 * can be drawn in any order, on any thread, and give the same pixels.
 */
/**
 * True when the mean luminance of a pixel is known well enough: its standard error, relative to the mean plus a small
 * floor so that near-black pixels do not ask for endless samples, is under `threshold`. It reads only the pixel's own
 * samples, so the decision is the same on any thread and in any band split.
 */
function hasConverged(sumLuminance, sumLuminanceSquares, sampleCount, threshold) {
  const mean = sumLuminance / sampleCount;
  const sampleVariance = Math.max(0, sumLuminanceSquares / sampleCount - mean * mean) * sampleCount / (sampleCount - 1);
  const standardError = Math.sqrt(sampleVariance / sampleCount);
  return standardError < threshold * (mean + CONVERGENCE_LUMINANCE_FLOOR);
}

function isConvergenceCheckDue(sampleCount, options) {
  if (!(options.noiseThreshold > 0)) return false;
  if (sampleCount < ADAPTIVE_MINIMUM_SAMPLES) return false;
  return (sampleCount - ADAPTIVE_MINIMUM_SAMPLES) % ADAPTIVE_BATCH_SAMPLES === 0;
}

export function renderBand(scene, camera, options, rowStart, rowEnd, shouldStop = () => {}) {
  const tracer = createPathTracer(scene, options);
  const { width, height, samples } = options;
  const pixelCount = (rowEnd - rowStart) * width;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount);
  const samplesTaken = new Uint16Array(pixelCount);
  for (let row = rowStart; row < rowEnd; row++) {
    shouldStop();
    for (let column = 0; column < width; column++) {
      const pixel = row * width + column;
      const slot = (row - rowStart) * width + column;
      let sumLuminance = 0;
      let sumLuminanceSquares = 0;
      let taken = 0;
      while (taken < samples) {
        const sample = taken;
        const jitterX = hashJitter(pixel, sample, options.seed, 1);
        const jitterY = hashJitter(pixel, sample, options.seed, 2);
        const screenX = ((column + jitterX) / width * 2 - 1) * camera.halfWidth;
        const screenY = (1 - (row + jitterY) / height * 2) * camera.halfHeight;
        const directionX = camera.forward[0] + camera.right[0] * screenX + camera.above[0] * screenY;
        const directionY = camera.forward[1] + camera.right[1] * screenX + camera.above[1] * screenY;
        const directionZ = camera.forward[2] + camera.right[2] * screenX + camera.above[2] * screenY;
        const length = Math.hypot(directionX, directionY, directionZ);
        // clipStart is a distance along the view axis, as Cycles' clip start: a ray from the eye starts where it has gone that far along the axis.
        const rayDirectionX = directionX / length;
        const rayDirectionY = directionY / length;
        const rayDirectionZ = directionZ / length;
        const clipDistance = camera.clipStart ? camera.clipStart / (rayDirectionX * camera.forward[0] + rayDirectionY * camera.forward[1] + rayDirectionZ * camera.forward[2]) : 0;
        tracer.trace(camera.eye[0] + rayDirectionX * clipDistance, camera.eye[1] + rayDirectionY * clipDistance, camera.eye[2] + rayDirectionZ * clipDistance, rayDirectionX, rayDirectionY, rayDirectionZ, pixel, sample);
        const { radiance, features } = tracer;
        const sampleLuminance = luminance(radiance[0], radiance[1], radiance[2]);
        sumLuminance += sampleLuminance;
        sumLuminanceSquares += sampleLuminance * sampleLuminance;
        for (let channel = 0; channel < 3; channel++) {
          color[slot * 3 + channel] += radiance[channel];
          albedo[slot * 3 + channel] += features.albedo[channel];
          normal[slot * 3 + channel] += features.normal[channel];
        }
        depth[slot] += features.depth;
        taken++;
        if (isConvergenceCheckDue(taken, options) && hasConverged(sumLuminance, sumLuminanceSquares, taken, options.noiseThreshold)) break;
      }
      for (let channel = 0; channel < 3; channel++) {
        color[slot * 3 + channel] /= taken;
        albedo[slot * 3 + channel] /= taken;
        normal[slot * 3 + channel] /= taken;
      }
      depth[slot] /= taken;
      const meanLuminance = sumLuminance / taken;
      variance[slot] = Math.max(0, sumLuminanceSquares / taken - meanLuminance * meanLuminance) / Math.max(taken - 1, 1);
      samplesTaken[slot] = taken;
    }
  }
  return { color, albedo, normal, depth, variance, samplesTaken };
}

function hashJitter(pixel, sample, seed, dimension) {
  let mixed = Math.imul(pixel ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul(sample + dimension * 0x632be5ab, 0x85ebca6b) ^ Math.imul(seed + 0x1b873593, 0xc2b2ae35);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 4294967296;
}

function totalSamples(samplesTaken) {
  let total = 0;
  for (let pixel = 0; pixel < samplesTaken.length; pixel++) total += samplesTaken[pixel];
  return total;
}

function normalizeNormals(normal, pixelCount) {
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const length = Math.hypot(normal[pixel * 3], normal[pixel * 3 + 1], normal[pixel * 3 + 2]);
    if (length === 0) continue;
    for (let axis = 0; axis < 3; axis++) normal[pixel * 3 + axis] /= length;
  }
}

function copyBand(buffers, band, rowStart, width) {
  const pixelOffset = rowStart * width;
  for (const name of ['color', 'albedo', 'normal']) buffers[name].set(band[name], pixelOffset * 3);
  for (const name of ['depth', 'variance', 'samplesTaken']) buffers[name].set(band[name], pixelOffset);
}

/** Draws bands on a pool of module workers, handing the next band to whichever worker finishes first. */
function renderBandsInWorkers(scene, camera, options, buffers, shouldStop) {
  const bandCount = Math.ceil(options.height / WORKER_BAND_ROWS);
  const workerCount = Math.min(options.threads, bandCount);
  const workers = [];
  const { tracer: _tracer, ...transferableScene } = scene;
  return new Promise((resolve, reject) => {
    let nextBand = 0;
    let finishedBands = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(clock);
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    const clock = setInterval(() => {
      try {
        shouldStop();
      } catch (error) {
        finish(error);
      }
    }, 250);
    const assign = (worker) => {
      if (nextBand >= bandCount) return;
      const rowStart = nextBand * WORKER_BAND_ROWS;
      nextBand++;
      worker.postMessage({ type: 'band', rowStart, rowEnd: Math.min(rowStart + WORKER_BAND_ROWS, options.height) });
    };
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL(WORKER_FILE, import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(`Path tracer worker failed: ${event.message}`));
      worker.onmessage = (event) => {
        if (event.data.type === 'ready') {
          assign(worker);
          return;
        }
        copyBand(buffers, event.data.band, event.data.rowStart, options.width);
        finishedBands++;
        if (finishedBands === bandCount) finish();
        else assign(worker);
      };
      worker.postMessage({ type: 'scene', scene: transferableScene, camera, options });
    }
  });
}

/**
 * Renders one still. `scene` is `{ parts, environment, camera }` as the rasterizer takes them. Resolves with the linear
 * pixels, the tone-mapped RGBA bytes, and a report. Rejects, and returns nothing, when `maxSeconds` runs out.
 * `threads` above 1 uses module workers where the platform has them; the pixels are the same either way.
 */
export async function renderPathTracedImage({ parts, environment = {}, camera }, rawOptions = {}) {
  const options = normalizePathTracerOptions(rawOptions);
  validateTraceEnvironment(environment);
  const started = performance.now();
  const shouldStop = () => {
    if ((performance.now() - started) / 1000 > options.maxSeconds) throw new Error(`The path trace passed its ${options.maxSeconds} second limit and was stopped.`);
  };
  const { width, height } = options;
  const view = createCamera(camera, width, height);
  const gpuModule = options.backend === 'gpu' || options.backend === 'webgpu'
    ? await (options.backend === 'webgpu' ? import('./path-tracer-webgpu.js') : import('./path-tracer-gpu.js'))
    : null;
  const scene = gpuModule ? await buildTraceSceneForDevice(parts, environment, gpuModule) : buildTraceScene(parts, environment);
  if (options.backend !== 'cpu' && options.backend !== 'webgpu') refuseLocalVolumes(scene, `backend "${options.backend}"`);
  const pixelCount = width * height;
  const buffers = {
    color: new Float32Array(pixelCount * 3), albedo: new Float32Array(pixelCount * 3), normal: new Float32Array(pixelCount * 3),
    depth: new Float32Array(pixelCount), variance: new Float32Array(pixelCount), samplesTaken: new Uint16Array(pixelCount),
  };
  const threads = typeof Worker === 'function' ? options.threads : 1;
  let gpuName = null;
  let gpuCompileSeconds = 0;
  let gpuKernelCompiles = 0;
  if (gpuModule) {
    const { traceOnGpu, gpuKernelCompileCount } = gpuModule;
    const traced = await traceOnGpu(scene, view, options, shouldStop);
    gpuName = traced.gpu;
    gpuCompileSeconds = traced.compileSeconds;
    gpuKernelCompiles = gpuKernelCompileCount();
    copyBand(buffers, traced, 0, width);
  } else if (threads > 1) {
    await renderBandsInWorkers(scene, view, { ...options, threads }, buffers, shouldStop);
  } else {
    copyBand(buffers, renderBand(scene, view, options, 0, height, shouldStop), 0, width);
  }
  shouldStop();
  const tracedSeconds = (performance.now() - started) / 1000;
  normalizeNormals(buffers.normal, pixelCount);
  const { samplesTaken, ...denoiseInputs } = buffers;
  const linear = options.denoiser === 'wavelet' ? denoiseRadiance({ width, height, ...denoiseInputs }) : buffers.color;
  const averageSamples = totalSamples(samplesTaken) / pixelCount;
  const estimatedNoise = estimateRelativeNoise({ color: buffers.color, variance: buffers.variance, averageSamples });
  return {
    width, height, linear, rgba: toneMapToRgba8(linear, width, height, options), features: denoiseInputs,
    report: {
      width, height, samples: options.samples, bounces: options.bounces, seed: options.seed, denoised: options.denoiser === 'wavelet',
      denoiser: options.denoiser, threads,
      backend: options.backend, ...(gpuName ? { gpu: gpuName, gpuCompileSeconds, gpuKernelCompiles } : {}),
      averageSamples, noiseThreshold: options.noiseThreshold, ...(estimatedNoise === null ? {} : { estimatedNoise }),
      triangles: uniqueTriangleCount(scene), tracedSeconds, seconds: (performance.now() - started) / 1000,
      ignored: describeIgnoredFeatures(parts, environment, options.backend, { clipStart: view.clipStart }),
    },
  };
}

// Cook is the public name of the path tracer.
export const Cook = renderPathTracedImage;
