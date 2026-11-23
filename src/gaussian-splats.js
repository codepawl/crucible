import { mat4 } from 'gl-matrix';
import { compileProgram } from './gl-program.js';
import { createSplatSorter } from './gaussian-splat-sort.js';
import { runInChunks } from './gaussian-splat-chunks.js';
import { GAUSSIAN_SPLAT_HARD_COUNT_LIMIT, GAUSSIAN_SPLAT_LIMITS, parseGaussianSplatPly, parseGaussianSplatPlyAsync } from './gaussian-splat-ply.js';
import { parseGaussianSplatSpz, parseGaussianSplatSpzAsync } from './gaussian-splat-spz.js';
import { checkCovarianceFinite, covarianceOf, DATA_TEXTURE_WIDTH, resolveSplatUpdate, TEXELS_PER_SPLAT, WORDS_PER_TEXEL, writeSplatUpdate } from './gaussian-splat-update.js';
import { buildPaletteFragmentSource, resolveSplatPalette } from './splat-palette.js';
import { buildOutlineVertexSource, OUTLINE_FRAGMENT_SOURCE, resolveSplatOutline } from './splat-outline.js';
import { HARMONIC_SHADER_SOURCE, harmonicCoefficientsPerChannel, harmonicTexelsPerSplat, SPHERICAL_HARMONIC_MAXIMUM_DEGREE, toHalfFloatBits } from './gaussian-splat-harmonics.js';

export { GAUSSIAN_SPLAT_HARD_COUNT_LIMIT, GAUSSIAN_SPLAT_LIMITS, parseGaussianSplatPly, parseGaussianSplatPlyAsync, parseGaussianSplatSpz, parseGaussianSplatSpzAsync };

// Gaussian splats as an optional addon (crucible/addons/gaussian-splats). A splat is an ellipsoid with a colour and an opacity;
// each is drawn as a screen-space quad whose shape comes from projecting its 3D covariance. The splats are drawn after
// the opaque and translucent parts of the renderer, with the depth test against them and no depth write, back to front.
// The renderer needs no code for this: attachGaussianSplats wraps its drawBlendBatches step, which runs once per frame
// after those parts and before the frame is resolved to the canvas. Perspective cameras only.
// The per-splat data sits in one RGBA32UI texture, three texels per splat:
// - texel 0: centre x, y, z as float bits and the colour as four bytes;
// - texels 1 and 2: the six unique values of the 3D covariance (xx, xy, xz, yy, yz, zz) as float bits.
// Splats with spherical harmonic bands (#2734) have a second RGBA32UI texture of their coefficients as half floats, two per
// word, read by the vertex shader for the direction from the eye.
// The only per-frame upload is the sort order, one 32-bit index per visible splat.

const MAXIMUM_SPLAT_COUNT = GAUSSIAN_SPLAT_HARD_COUNT_LIMIT;
const DATA_TEXTURE_UNIT = 10;
const HARMONIC_TEXTURE_UNIT = 11;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D splatData;
uniform mat4 modelView;
uniform mat4 projection;
uniform vec2 focal;
uniform vec2 viewport;
layout(location = 0) in uint splatIndex;
out vec4 vertexColor;
out vec2 vertexOffset;
${HARMONIC_SHADER_SOURCE}
ivec2 texelOf(uint splat, uint texel) {
  uint linear = splat * 3u + texel;
  return ivec2(int(linear & 2047u), int(linear >> 11));
}
void main() {
  uvec4 first = texelFetch(splatData, texelOf(splatIndex, 0u), 0);
  uvec4 second = texelFetch(splatData, texelOf(splatIndex, 1u), 0);
  uvec4 third = texelFetch(splatData, texelOf(splatIndex, 2u), 0);
  vec3 center = uintBitsToFloat(first.xyz);
  vec4 cameraSpace = modelView * vec4(center, 1.0);
  vec4 clip = projection * cameraSpace;
  if (clip.z < -clip.w || abs(clip.x) > 1.3 * clip.w || abs(clip.y) > 1.3 * clip.w) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 firstCovariance = uintBitsToFloat(second);
  vec2 secondCovariance = uintBitsToFloat(third.xy);
  mat3 covariance = mat3(
    firstCovariance.x, firstCovariance.y, firstCovariance.z,
    firstCovariance.y, firstCovariance.w, secondCovariance.x,
    firstCovariance.z, secondCovariance.x, secondCovariance.y);
  float depth = -cameraSpace.z;
  mat3 jacobian = mat3(
    focal.x / depth, 0.0, 0.0,
    0.0, focal.y / depth, 0.0,
    focal.x * cameraSpace.x / (depth * depth), focal.y * cameraSpace.y / (depth * depth), 0.0);
  mat3 transform = jacobian * mat3(modelView);
  mat3 screen = transform * covariance * transpose(transform);
  float a = screen[0][0] + 0.3;
  float b = screen[0][1];
  float c = screen[1][1] + 0.3;
  float middle = 0.5 * (a + c);
  float radius = length(vec2(0.5 * (a - c), b));
  float majorVariance = middle + radius;
  float minorVariance = max(middle - radius, 0.1);
  vec2 direction = vec2(b, majorVariance - a);
  direction = dot(direction, direction) < 1e-12 ? vec2(1.0, 0.0) : normalize(direction);
  vec2 majorAxis = min(sqrt(2.0 * majorVariance), 1024.0) * direction;
  vec2 minorAxis = min(sqrt(2.0 * minorVariance), 1024.0) * vec2(direction.y, -direction.x);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 4.0 - 2.0;
  vec2 offset = (corner.x * majorAxis + corner.y * minorAxis) * 2.0 / viewport;
  vertexColor = vec4(float(first.w & 255u), float((first.w >> 8) & 255u), float((first.w >> 16) & 255u), float(first.w >> 24)) / 255.0;
  if (harmonicDegree > 0) vertexColor.rgb = max(vertexColor.rgb + harmonicColor(splatIndex, normalize(center - eyeModel)), 0.0);
  vertexOffset = corner;
  gl_Position = vec4(clip.xy / clip.w + offset, clip.z / clip.w, 1.0);
}`;

// A splat colour is display-referred, so the sRGB path takes it as is; the HDR path linearises it and applies exposure.
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform float hdrEnabled;
uniform float exposure;
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float falloff = -dot(vertexOffset, vertexOffset);
  if (falloff < -4.0) discard;
  float alpha = exp(falloff) * vertexColor.a;
  if (alpha < 1.0 / 255.0) discard;
  vec3 color = hdrEnabled > 0.5 ? pow(vertexColor.rgb, vec3(2.2)) * exposure : vertexColor.rgb;
  outputColor = vec4(color * alpha, alpha);
}`;

// The opaque variant (alphaCut): a fragment whose gaussian alpha is under the cut is discarded, every other one writes its
// colour at full strength. With depth write on, the nearest one wins and the order of the splats no longer matters.
const OPAQUE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform float hdrEnabled;
uniform float exposure;
uniform float alphaCut;
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float falloff = -dot(vertexOffset, vertexOffset);
  if (falloff < -4.0) discard;
  float alpha = exp(falloff) * vertexColor.a;
  if (alpha < max(alphaCut, 1.0 / 255.0)) discard;
  vec3 color = hdrEnabled > 0.5 ? pow(vertexColor.rgb, vec3(2.2)) * exposure : vertexColor.rgb;
  outputColor = vec4(color, 1.0);
}`;

// Soft splats blend without depth write, so a user pass or depth effect would read the background behind them (#2752). A second
// colourless pass writes the depth of every fragment whose gaussian alpha reaches this level; the nearest one wins, so the
// order of the splats does not matter.
export const SPLAT_DEPTH_ALPHA_THRESHOLD = 0.5;
const DEPTH_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform float alphaCut;
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float falloff = -dot(vertexOffset, vertexOffset);
  if (falloff < -4.0) discard;
  if (exp(falloff) * vertexColor.a < alphaCut) discard;
  outputColor = vec4(0.0);
}`;

const UNIFORM_NAMES = ['splatData', 'modelView', 'projection', 'focal', 'viewport', 'hdrEnabled', 'exposure', 'alphaCut', 'harmonicData', 'harmonicDegree', 'harmonicTexels', 'eyeModel'];
export const GAUSSIAN_SPLAT_SHADER_SOURCES = Object.freeze({ vertex: VERTEX_SOURCE, fragment: FRAGMENT_SOURCE, opaqueFragment: OPAQUE_FRAGMENT_SOURCE });

function createSplatPacker(data, capacity) {
  const texelCount = capacity * TEXELS_PER_SPLAT;
  const rows = Math.ceil(texelCount / DATA_TEXTURE_WIDTH);
  const words = new Uint32Array(rows * DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL);
  const floats = new Float32Array(words.buffer);
  const colorWords = new Uint32Array(data.colors.buffer, data.colors.byteOffset, data.count);
  function packRange(start, end) {
    for (let index = start; index < end; index++) {
      const base = index * TEXELS_PER_SPLAT * WORDS_PER_TEXEL;
      floats.set(data.positions.subarray(index * 3, index * 3 + 3), base);
      words[base + 3] = colorWords[index];
      const covariance = covarianceOf(data.scales, data.rotations, index);
      checkCovarianceFinite(covariance, index);
      floats.set(covariance, base + 4);
    }
  }
  const harmonics = createHarmonicPacker(data);
  function packRangeWithHarmonics(start, end) {
    packRange(start, end);
    harmonics?.packRange(start, end);
  }
  return { packRange: packRangeWithHarmonics, packed: { words, rows, harmonics: harmonics?.packed ?? null } };
}

// Packs each splat's band coefficients as half floats, two per 32-bit word, into texels of their own.
function createHarmonicPacker(data) {
  if (!data.sphericalHarmonics) return null;
  const { degree, coefficients, colorOverflow } = data.sphericalHarmonics;
  const coefficientsPerSplat = harmonicCoefficientsPerChannel(degree) * 3;
  // The colour overflow follows the coefficients; data without it packs zero, the bytes' own colour.
  const valuesPerSplat = coefficientsPerSplat + 3;
  const valueOf = (index, value) => {
    if (value < coefficientsPerSplat) return coefficients[index * coefficientsPerSplat + value];
    return colorOverflow ? colorOverflow[index * 3 + value - coefficientsPerSplat] : 0;
  };
  const texelsPerSplat = harmonicTexelsPerSplat(degree);
  const wordsPerSplat = texelsPerSplat * WORDS_PER_TEXEL;
  const rows = Math.ceil((data.count * texelsPerSplat) / DATA_TEXTURE_WIDTH);
  const words = new Uint32Array(rows * DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL);
  function packRange(start, end) {
    for (let index = start; index < end; index++) {
      for (let value = 0; value < valuesPerSplat; value += 2) {
        const low = toHalfFloatBits(valueOf(index, value));
        const high = value + 1 < valuesPerSplat ? toHalfFloatBits(valueOf(index, value + 1)) : 0;
        words[index * wordsPerSplat + value / 2] = (low | (high << 16)) >>> 0;
      }
    }
  }
  return { packRange, packed: { words, rows, degree, texelsPerSplat } };
}

// Per-splat arrays the packer reads: how many values each splat takes and which typed arrays are accepted. colors are read
// as one 32-bit word per splat, so they must be bytes (red, green, blue, opacity).
const SPLAT_ARRAYS = [
  { field: 'positions', stride: 3, types: [Float32Array, Float64Array], meaning: 'x, y, z per splat' },
  { field: 'scales', stride: 3, types: [Float32Array, Float64Array], meaning: 'three axis lengths per splat' },
  { field: 'rotations', stride: 4, types: [Float32Array, Float64Array], meaning: 'quaternion w, x, y, z per splat' },
  { field: 'colors', stride: 4, types: [Uint8Array, Uint8ClampedArray], meaning: 'red, green, blue, opacity bytes per splat' },
];

function checkSplatArray(data, { field, stride, types, meaning }, caller) {
  const values = data[field];
  const expectedLength = data.count * stride;
  const typeNames = types.map(type => type.name).join(' or ');
  if (!types.some(type => values instanceof type)) {
    throw new TypeError(`${caller} needs data.${field} as a ${typeNames} of ${expectedLength} values (${data.count} splats x ${stride}: ${meaning}), got ${values === null ? 'null' : typeof values === 'object' ? values.constructor?.name ?? 'an object' : typeof values}`);
  }
  if (values.length < expectedLength) {
    throw new RangeError(`${caller} needs data.${field} to hold ${expectedLength} values (${data.count} splats x ${stride}: ${meaning}), got ${values.length}. Pass ${field} with ${stride} values for every splat, or lower data.count to ${Math.floor(values.length / stride)}`);
  }
  if (field === 'colors' && values.byteOffset % 4 !== 0) {
    throw new RangeError(`${caller} needs data.colors to start on a 4-byte boundary of its buffer (byteOffset ${values.byteOffset}). Pass a copy made with colors.slice()`);
  }
}

// Optional bands: { degree, coefficients } as parseGaussianSplatPly returns them.
function checkSplatHarmonics(data, caller) {
  const harmonics = data.sphericalHarmonics;
  if (harmonics === undefined || harmonics === null) return;
  const degree = harmonics?.degree;
  if (!Number.isInteger(degree) || degree < 1 || degree > SPHERICAL_HARMONIC_MAXIMUM_DEGREE) {
    throw new RangeError(`${caller} needs data.sphericalHarmonics.degree as a whole number from 1 to ${SPHERICAL_HARMONIC_MAXIMUM_DEGREE}, got ${String(degree)}. Pass the sphericalHarmonics parseGaussianSplatPly returns, or leave it out for one colour per splat`);
  }
  const expectedLength = data.count * harmonicCoefficientsPerChannel(degree) * 3;
  const coefficients = harmonics.coefficients;
  if (!(coefficients instanceof Float32Array || coefficients instanceof Float64Array) || coefficients.length < expectedLength) {
    throw new TypeError(`${caller} needs data.sphericalHarmonics.coefficients as a Float32Array or Float64Array of ${expectedLength} values (${data.count} splats x ${harmonicCoefficientsPerChannel(degree)} coefficients x red, green, blue), got ${ArrayBuffer.isView(coefficients) ? `a ${coefficients.constructor.name} of ${coefficients.length}` : typeof coefficients}`);
  }
  const overflow = harmonics.colorOverflow;
  if (overflow !== undefined && !((overflow instanceof Float32Array || overflow instanceof Float64Array) && overflow.length >= data.count * 3)) {
    throw new TypeError(`${caller} needs data.sphericalHarmonics.colorOverflow as a Float32Array or Float64Array of ${data.count * 3} values (red, green, blue per splat that the colour bytes cut), got ${ArrayBuffer.isView(overflow) ? `a ${overflow.constructor.name} of ${overflow.length}` : typeof overflow}. Pass the sphericalHarmonics parseGaussianSplatPly returns, or leave colorOverflow out`);
  }
}

function checkSplatBounds(bounds, caller) {
  const isCorner = corner => (Array.isArray(corner) || ArrayBuffer.isView(corner)) && corner.length === 3 && Array.from(corner).every(Number.isFinite);
  if (!isCorner(bounds?.minimum) || !isCorner(bounds?.maximum)) {
    throw new TypeError(`${caller} needs data.bounds as { minimum, maximum }, each three finite numbers (the box that holds every splat centre; parseGaussianSplatPly returns it). Pass the bounds from the parse result`);
  }
}

function resolveSplatOptions(options, caller) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${caller} options must be an object such as { matrix, maximumCount, alphaCut, palette, dither, outline } or left out, got ${options === null ? 'null' : typeof options}`);
  }
  return options;
}

function resolveMatrix(matrix, caller) {
  if (matrix === undefined) return mat4.create();
  if (!(Array.isArray(matrix) || ArrayBuffer.isView(matrix)) || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) {
    throw new TypeError(`${caller} matrix must be 16 finite numbers (a column-major 4x4 array) or left out for identity, got ${matrix === null ? 'null' : Array.isArray(matrix) || ArrayBuffer.isView(matrix) ? `${matrix.length} values` : typeof matrix}`);
  }
  return matrix;
}

// How many splats the set can hold: `options.capacity` when given (room to grow with `update`), else exactly `count`.
function resolveCapacity(capacity, count, limit, caller) {
  if (capacity === undefined) return count;
  if (!Number.isInteger(capacity) || capacity < count || capacity > limit) {
    throw new RangeError(`${caller} capacity must be a whole number from the splat count (${count}) to ${limit}, got ${String(capacity)}. Pass the most splats you will ever update the set to, or leave it out for exactly ${count}`);
  }
  return capacity;
}

function checkSplatInput(data, maximumCount, caller) {
  if (!(typeof maximumCount === 'number' && maximumCount > 0)) {
    throw new RangeError(`maximumCount must be a positive number (it is capped at ${MAXIMUM_SPLAT_COUNT}), got ${String(maximumCount)}`);
  }
  const limit = Math.min(maximumCount, MAXIMUM_SPLAT_COUNT);
  if (!(data?.count > 0)) throw new Error(`${caller} needs parsed splat data with at least one splat`);
  if (!Number.isInteger(data.count)) throw new RangeError(`${caller} needs data.count to be a whole number of splats, got ${data.count}`);
  if (data.count > limit) throw new RangeError(`Gaussian splat scene holds ${data.count} splats, over the limit of ${limit}`);
  for (const description of SPLAT_ARRAYS) checkSplatArray(data, description, caller);
  checkSplatHarmonics(data, caller);
  checkSplatBounds(data.bounds, caller);
  return limit;
}

function resolveAlphaCut(alphaCut, caller) {
  if (alphaCut === undefined || alphaCut === null) return null;
  if (!(typeof alphaCut === 'number' && alphaCut >= 0 && alphaCut <= 1)) {
    throw new RangeError(`${caller} alphaCut must be a number from 0 to 1 (a splat pixel whose alpha is below it is dropped, the rest are drawn opaque), or left out for soft blending, got ${String(alphaCut)}`);
  }
  return alphaCut;
}

function resolveSplatLook(options, caller) {
  const alphaCut = resolveAlphaCut(options.alphaCut, caller);
  return { alphaCut, palette: resolveSplatPalette(options.palette, options.dither, alphaCut, caller), outline: resolveSplatOutline(options.outline, alphaCut, caller) };
}

function buildSplats(data, matrix, packed, capacity, { alphaCut, palette, outline }) {
  const sorter = createSplatSorter(data.positions, data.count, data.bounds, capacity);
  const statistics = { count: data.count, visibleCount: 0, sortMilliseconds: 0, gpuBytes: 0, cpuBytes: data.positions.byteLength + capacity * 8 };
  // `centres` is the caller's array until the first update that moves a splat, then a copy of its own.
  return { count: data.count, capacity, matrix: mat4.clone(matrix), bounds: data.bounds, statistics, packed, sorter, alphaCut, palette, outline, centres: data.positions, ownsCentres: false, harmonicBands: Boolean(packed.harmonics) };
}

/**
 * Splat data ready to draw, from `parseGaussianSplatPly`. `matrix` (a 16-number column-major array, default identity) places
 * the splat scene in the world; it may rotate, translate and scale uniformly. Many captures are y-down, so a flip is
 * usual. Throws a RangeError when `data.count` is over `maximumCount` (default 2,000,000, at most 4,000,000).
 * `alphaCut` (a number from 0 to 1, default off) turns the blended look into hard opaque discs: a pixel whose gaussian alpha
 * (falloff times the splat's opacity) is below it is dropped and every other pixel is written opaque, with depth, so
 * neighbouring splats no longer mix their colours. These splats draw before the soft ones.
 * `palette` (2 to 256 colours, hex strings or [r, g, b] from 0 to 1; needs `alphaCut`) snaps every opaque pixel to its nearest
 * palette colour, and `dither` (`'none'` default, `'bayer4'`, `'bayer8'`) adds an ordered dither first. Both are off by default.
 * `outline` (`{ color, width }`, width 1 to 4 pixels, color a hex string or [r, g, b], default near black; needs `alphaCut`)
 * draws a dark outline round the outer silhouette of the hard discs. Off by default.
 * `data.sphericalHarmonics` (from the parse, optional) makes each splat change colour with the view direction.
 * The returned object has `count`, `matrix`, `bounds` and `statistics` (`count`, `visibleCount`, `sortMilliseconds`,
 * `gpuBytes`, `cpuBytes`, and `harmonicsSkipped` when the GPU could not hold the bands and they were left off).
 */
export function createGaussianSplats(data, options) {
  const resolvedOptions = resolveSplatOptions(options, 'createGaussianSplats');
  const { maximumCount = GAUSSIAN_SPLAT_LIMITS.maximumCount } = resolvedOptions;
  const limit = checkSplatInput(data, maximumCount, 'createGaussianSplats');
  const capacity = resolveCapacity(resolvedOptions.capacity, data.count, limit, 'createGaussianSplats');
  const matrix = resolveMatrix(resolvedOptions.matrix, 'createGaussianSplats');
  const look = resolveSplatLook(resolvedOptions, 'createGaussianSplats');
  const { packRange, packed } = createSplatPacker(data, capacity);
  packRange(0, data.count);
  return buildSplats(data, matrix, packed, capacity, look);
}

/**
 * The same result as `createGaussianSplats`, packed in slices of `chunkSize` splats (default 32,768) with a wait of one
 * macrotask between slices. `onProgress(fraction)` rises to exactly 1 and an aborted `signal` rejects with an error named
 * `AbortError`. Input checks run first and reject before any splat is packed.
 */
export async function createGaussianSplatsAsync(data, rawOptions) {
  const options = resolveSplatOptions(rawOptions, 'createGaussianSplatsAsync');
  const { maximumCount = GAUSSIAN_SPLAT_LIMITS.maximumCount } = options;
  const limit = checkSplatInput(data, maximumCount, 'createGaussianSplatsAsync');
  const capacity = resolveCapacity(options.capacity, data.count, limit, 'createGaussianSplatsAsync');
  const matrix = resolveMatrix(options.matrix, 'createGaussianSplatsAsync');
  const look = resolveSplatLook(options, 'createGaussianSplatsAsync');
  const { packRange, packed } = createSplatPacker(data, capacity);
  await runInChunks(data.count, options, 'createGaussianSplatsAsync', packRange);
  return buildSplats(data, matrix, packed, capacity, look);
}

function uploadWordTexture(context, unit, rows, words) {
  const texture = context.createTexture();
  context.activeTexture(context.TEXTURE0 + unit);
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32UI, DATA_TEXTURE_WIDTH, rows, 0, context.RGBA_INTEGER, context.UNSIGNED_INT, words);
  return texture;
}

// The band texture is twice as tall as the splat texture at degree 3, so a GPU with a small texture limit could refuse it
// for a file whose splats fit. Then the splats draw with one colour from every direction, as they did before bands were read,
// and `statistics.harmonicsSkipped` says why.
function uploadHarmonics(context, harmonics, statistics) {
  if (!harmonics) return null;
  const largestRows = context.getParameter(context.MAX_TEXTURE_SIZE);
  if (typeof largestRows === 'number' && harmonics.rows > largestRows) {
    statistics.harmonicsSkipped = `The spherical harmonic texture needs ${harmonics.rows} rows, over this GPU's limit of ${largestRows}; the splats draw with one colour from every direction. Parse the file with a lower sphericalHarmonicDegree, or with fewer splats, to keep the bands`;
    return null;
  }
  const texture = uploadWordTexture(context, HARMONIC_TEXTURE_UNIT, harmonics.rows, harmonics.words);
  return { texture, rows: harmonics.rows, degree: harmonics.degree, texelsPerSplat: harmonics.texelsPerSplat };
}

function createGpuResources(context, splats) {
  const { words, rows } = splats.packed;
  const harmonics = uploadHarmonics(context, splats.packed.harmonics, splats.statistics);
  const texture = uploadWordTexture(context, DATA_TEXTURE_UNIT, rows, words);
  const orderBuffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, orderBuffer);
  context.bufferData(context.ARRAY_BUFFER, splats.capacity * 4, context.DYNAMIC_DRAW);
  const vertexArray = context.createVertexArray();
  context.bindVertexArray(vertexArray);
  context.enableVertexAttribArray(0);
  context.vertexAttribIPointer(0, 1, context.UNSIGNED_INT, 0, 0);
  context.vertexAttribDivisor(0, 1);
  context.bindVertexArray(null);
  const harmonicBytes = harmonics ? splats.packed.harmonics.words.byteLength : 0;
  splats.statistics.gpuBytes = words.byteLength + splats.capacity * 4 + harmonicBytes;
  splats.packed = null;
  return { texture, orderBuffer, vertexArray, rows, harmonics };
}

// Reads the packed data textures back so detached splats can attach to another renderer without keeping a CPU copy.
function readPackedBack(context, entry) {
  if (context.isContextLost?.()) return null;
  const words = readTextureWords(context, entry.texture, entry.rows);
  const harmonics = entry.harmonics && { words: readTextureWords(context, entry.harmonics.texture, entry.harmonics.rows), rows: entry.harmonics.rows, degree: entry.harmonics.degree, texelsPerSplat: entry.harmonics.texelsPerSplat };
  return { words, rows: entry.rows, harmonics };
}

function readTextureWords(context, texture, rows) {
  const words = new Uint32Array(rows * DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL);
  const previousFramebuffer = context.getParameter(context.READ_FRAMEBUFFER_BINDING);
  const previousPackBuffer = context.getParameter(context.PIXEL_PACK_BUFFER_BINDING);
  const framebuffer = context.createFramebuffer();
  context.bindBuffer(context.PIXEL_PACK_BUFFER, null);
  context.bindFramebuffer(context.READ_FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.READ_FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  context.readPixels(0, 0, DATA_TEXTURE_WIDTH, rows, context.RGBA_INTEGER, context.UNSIGNED_INT, words);
  context.bindFramebuffer(context.READ_FRAMEBUFFER, previousFramebuffer);
  context.bindBuffer(context.PIXEL_PACK_BUFFER, previousPackBuffer);
  context.deleteFramebuffer(framebuffer);
  return words;
}

const attachments = new WeakMap();

function createProgramInfo(context, fragmentSource, extraUniformNames = [], vertexSource = VERTEX_SOURCE) {
  const program = compileProgram(context, vertexSource, fragmentSource);
  const uniforms = Object.fromEntries([...UNIFORM_NAMES, ...extraUniformNames].map(name => [name, context.getUniformLocation(program, name)]));
  return { program, uniforms };
}

function createAttachment(renderer) {
  const context = renderer.context;
  const attachment = { blended: createProgramInfo(context, FRAGMENT_SOURCE), opaque: null, depth: null, palettePrograms: new Map(), outline: null, entries: new Set(), modelView: mat4.create(), inverseModelView: mat4.create(), emptyHarmonics: null, original: null, disposeOriginal: null };
  // Splats without bands still need an unsigned integer texture on the harmonic unit for the shader's sampler.
  attachment.emptyHarmonics = uploadWordTexture(context, HARMONIC_TEXTURE_UNIT, 1, new Uint32Array(DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL));
  attachment.original = renderer.drawBlendBatches;
  attachment.disposeOriginal = renderer.dispose;
  renderer.drawBlendBatches = function drawBlendBatchesAndSplats(frame) {
    attachment.original.call(this, frame);
    drawEntries(this, attachment, frame);
  };
  renderer.dispose = function disposeWithSplats() {
    releaseAttachment(renderer, attachment);
    return attachment.disposeOriginal.call(this);
  };
  return attachment;
}

function releaseEntry(context, entry) {
  context.deleteTexture(entry.texture);
  if (entry.harmonics) context.deleteTexture(entry.harmonics.texture);
  context.deleteBuffer(entry.orderBuffer);
  context.deleteVertexArray(entry.vertexArray);
}

function releaseAttachment(renderer, attachment) {
  for (const entry of attachment.entries) releaseEntry(renderer.context, entry);
  attachment.entries.clear();
  renderer.context.deleteTexture(attachment.emptyHarmonics);
  renderer.context.deleteProgram(attachment.blended.program);
  if (attachment.opaque) renderer.context.deleteProgram(attachment.opaque.program);
  if (attachment.depth) renderer.context.deleteProgram(attachment.depth.program);
  if (attachment.outline) renderer.context.deleteProgram(attachment.outline.program);
  for (const programInfo of attachment.palettePrograms.values()) renderer.context.deleteProgram(programInfo.program);
  renderer.drawBlendBatches = attachment.original;
  renderer.dispose = attachment.disposeOriginal;
  attachments.delete(renderer);
}

function prepareFrameState(renderer) {
  const context = renderer.context;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
  context.enable(context.DEPTH_TEST);
  context.disable(context.CULL_FACE);
}

function useProgram(renderer, programInfo, frame) {
  const context = renderer.context;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  context.useProgram(programInfo.program);
  const { uniforms } = programInfo;
  context.uniformMatrix4fv(uniforms.projection, false, renderer.rasterProjection ?? renderer.projection);
  context.uniform2f(uniforms.focal, renderer.projection[0] * width * 0.5, renderer.projection[5] * height * 0.5);
  context.uniform2f(uniforms.viewport, width, height);
  context.uniform1f(uniforms.hdrEnabled, renderer.hdr ? 1 : 0);
  context.uniform1f(uniforms.exposure, frame.exposure ?? 1);
  context.uniform1i(uniforms.splatData, DATA_TEXTURE_UNIT);
  context.uniform1i(uniforms.harmonicData, HARMONIC_TEXTURE_UNIT);
}

function prepareBlendedState(renderer, attachment, frame) {
  const context = renderer.context;
  context.depthMask(false);
  context.enable(context.BLEND);
  context.blendFuncSeparate(context.ONE, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
  useProgram(renderer, attachment.blended, frame);
}

function prepareOpaqueState(renderer, attachment, frame) {
  const context = renderer.context;
  attachment.opaque ??= createProgramInfo(context, OPAQUE_FRAGMENT_SOURCE);
  context.depthMask(true);
  context.disable(context.BLEND);
  useProgram(renderer, attachment.opaque, frame);
}

function drawBlendedDepth(renderer, attachment, blendedEntries, frame) {
  const context = renderer.context;
  attachment.depth ??= createProgramInfo(context, DEPTH_FRAGMENT_SOURCE);
  context.depthMask(true);
  context.colorMask(false, false, false, false);
  context.disable(context.BLEND);
  useProgram(renderer, attachment.depth, frame);
  context.uniform1f(attachment.depth.uniforms.alphaCut, SPLAT_DEPTH_ALPHA_THRESHOLD);
  for (const entry of blendedEntries) drawEntry(renderer, attachment, entry, attachment.depth);
  context.colorMask(true, true, true, true);
}

function paletteProgramFor(renderer, attachment, palette) {
  const key = `${palette.count}:${palette.dither}`;
  if (!attachment.palettePrograms.has(key)) {
    attachment.palettePrograms.set(key, createProgramInfo(renderer.context, buildPaletteFragmentSource(palette.count, palette.dither), ['paletteColors']));
  }
  return attachment.palettePrograms.get(key);
}

function drawOutlines(renderer, attachment, outlineEntries, frame) {
  const context = renderer.context;
  attachment.outline ??= createProgramInfo(context, OUTLINE_FRAGMENT_SOURCE, ['outlineWidth', 'outlineColor'], buildOutlineVertexSource(VERTEX_SOURCE));
  context.depthMask(false);
  context.disable(context.BLEND);
  for (const entry of outlineEntries) {
    const { color, width } = entry.splats.outline;
    useProgram(renderer, attachment.outline, frame);
    context.uniform1f(attachment.outline.uniforms.outlineWidth, width);
    context.uniform3fv(attachment.outline.uniforms.outlineColor, color);
    drawEntry(renderer, attachment, entry, attachment.outline);
  }
}

function restoreState(renderer) {
  const context = renderer.context;
  context.depthMask(true);
  context.disable(context.BLEND);
  context.enable(context.CULL_FACE);
  context.bindVertexArray(null);
  context.activeTexture(context.TEXTURE0);
}

function drawEntry(renderer, attachment, entry, programInfo) {
  const context = renderer.context;
  const { splats } = entry;
  mat4.multiply(attachment.modelView, renderer.view, splats.matrix);
  const start = performance.now();
  const { order, visibleCount, changed } = splats.sorter.sort(attachment.modelView);
  // The sorter keeps its last order, so splats attached again after a detach upload it once to their new buffer.
  if (changed || !entry.orderUploaded) {
    entry.orderUploaded = true;
    context.bindBuffer(context.ARRAY_BUFFER, entry.orderBuffer);
    context.bufferSubData(context.ARRAY_BUFFER, 0, order, 0, visibleCount);
    splats.statistics.sortMilliseconds = performance.now() - start;
  }
  splats.statistics.visibleCount = visibleCount;
  if (visibleCount === 0) return;
  context.uniformMatrix4fv(programInfo.uniforms.modelView, false, attachment.modelView);
  if (splats.alphaCut !== null) context.uniform1f(programInfo.uniforms.alphaCut, splats.alphaCut);
  if (splats.palette && programInfo.uniforms.paletteColors !== undefined) context.uniform3fv(programInfo.uniforms.paletteColors, splats.palette.colors);
  bindHarmonics(context, attachment, entry, programInfo);
  context.activeTexture(context.TEXTURE0 + DATA_TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_2D, entry.texture);
  context.bindVertexArray(entry.vertexArray);
  context.bindBuffer(context.ARRAY_BUFFER, entry.orderBuffer);
  context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, visibleCount);
}

// The bands are evaluated in the splats' own space, so the eye is moved there: the inverse model-view's translation.
function bindHarmonics(context, attachment, entry, programInfo) {
  const { uniforms } = programInfo;
  context.activeTexture(context.TEXTURE0 + HARMONIC_TEXTURE_UNIT);
  if (!entry.harmonics) {
    context.bindTexture(context.TEXTURE_2D, attachment.emptyHarmonics);
    context.uniform1i(uniforms.harmonicDegree, 0);
    return;
  }
  context.bindTexture(context.TEXTURE_2D, entry.harmonics.texture);
  context.uniform1i(uniforms.harmonicDegree, entry.harmonics.degree);
  context.uniform1i(uniforms.harmonicTexels, entry.harmonics.texelsPerSplat);
  mat4.invert(attachment.inverseModelView, attachment.modelView);
  context.uniform3f(uniforms.eyeModel, attachment.inverseModelView[12], attachment.inverseModelView[13], attachment.inverseModelView[14]);
}

function drawEntries(renderer, attachment, frame) {
  if (attachment.entries.size === 0) return;
  prepareFrameState(renderer);
  const entries = [...attachment.entries];
  const opaqueEntries = entries.filter(entry => entry.splats.alphaCut !== null && !entry.splats.palette);
  const paletteEntries = entries.filter(entry => entry.splats.palette);
  const blendedEntries = entries.filter(entry => entry.splats.alphaCut === null);
  const outlineEntries = entries.filter(entry => entry.splats.outline);
  if (outlineEntries.length > 0) drawOutlines(renderer, attachment, outlineEntries, frame);
  if (opaqueEntries.length > 0) {
    prepareOpaqueState(renderer, attachment, frame);
    for (const entry of opaqueEntries) drawEntry(renderer, attachment, entry, attachment.opaque);
  }
  for (const entry of paletteEntries) {
    prepareOpaqueState(renderer, attachment, frame);
    const programInfo = paletteProgramFor(renderer, attachment, entry.splats.palette);
    useProgram(renderer, programInfo, frame);
    drawEntry(renderer, attachment, entry, programInfo);
  }
  if (blendedEntries.length > 0) {
    prepareBlendedState(renderer, attachment, frame);
    const farToNear = blendedEntries.map(entry => ({ entry, distance: distanceToEye(entry.splats, frame.eye) })).sort((first, second) => second.distance - first.distance);
    for (const { entry } of farToNear) drawEntry(renderer, attachment, entry, attachment.blended);
    drawBlendedDepth(renderer, attachment, blendedEntries, frame);
  }
  restoreState(renderer);
}

function distanceToEye(splats, eye) {
  const { minimum, maximum } = splats.bounds;
  const center = [0, 1, 2].map(axis => (minimum[axis] + maximum[axis]) / 2);
  const world = [splats.matrix[0] * center[0] + splats.matrix[4] * center[1] + splats.matrix[8] * center[2] + splats.matrix[12],
    splats.matrix[1] * center[0] + splats.matrix[5] * center[1] + splats.matrix[9] * center[2] + splats.matrix[13],
    splats.matrix[2] * center[0] + splats.matrix[6] * center[1] + splats.matrix[10] * center[2] + splats.matrix[14]];
  return Math.hypot(world[0] - eye[0], world[1] - eye[1], world[2] - eye[2]);
}

/**
 * Draws `splats` (from `createGaussianSplats`) with `renderer` on every normal frame, after its parts and with their
 * depth. Call it again for more splat scenes: they are drawn farthest first. Returns a function that removes this one,
 * frees its GPU memory and reads the packed data back, so the same splats can then attach to this or another renderer;
 * `renderer.dispose()` removes all of them without that read, so create them again after it. Not drawn in render
 * passes, benchmark mode or the water reflection image.
 */
export function attachGaussianSplats(renderer, splats) {
  if (!splats?.packed) throw new Error('These splats are already attached to a renderer; call the function attachGaussianSplats returned to detach them, then attach again, or create them again');
  if (typeof renderer?.drawBlendBatches !== 'function') throw new TypeError('attachGaussianSplats needs a CrucibleRenderer');
  const attachment = attachments.get(renderer) ?? createAttachment(renderer);
  attachments.set(renderer, attachment);
  const entry = { splats, ...createGpuResources(renderer.context, splats) };
  attachment.entries.add(entry);
  function detachGaussianSplats() {
    if (!attachment.entries.delete(entry)) return;
    splats.packed = readPackedBack(renderer.context, entry);
    splats.statistics.gpuBytes = 0;
    releaseEntry(renderer.context, entry);
    if (attachment.entries.size === 0 && attachments.get(renderer) === attachment) releaseAttachment(renderer, attachment);
  }
  detachGaussianSplats.update = change => updateAttachedSplats(renderer, attachment, entry, change);
  return detachGaussianSplats;
}

// Keeps a CPU copy of the data texture for the first update, read back once, so a range can be rewritten and its rows re-uploaded.
function ensureWordMirror(context, entry) {
  if (context.isContextLost?.()) throw new Error('The WebGL context is lost, so these splats cannot be updated. Create them again after the context is restored');
  entry.mirror ??= readTextureWords(context, entry.texture, entry.rows);
  return entry.mirror;
}

// Centres feed the sorter; they are copied out of the caller's array before the first change so the caller's data stays theirs.
function ensureOwnCentres(splats) {
  if (splats.ownsCentres) return;
  const own = new Float32Array(splats.capacity * 3);
  own.set(splats.centres.subarray(0, splats.count * 3));
  splats.centres = own;
  splats.ownsCentres = true;
  splats.statistics.cpuBytes += own.byteLength;
}

function boundsOfCentres(centres, count) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < count; index++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = centres[index * 3 + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
  }
  return { minimum, maximum };
}

function uploadRows(context, entry, { firstRow, endRow }) {
  if (endRow <= firstRow) return;
  const rowWords = DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL;
  context.activeTexture(context.TEXTURE0 + DATA_TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_2D, entry.texture);
  context.texSubImage2D(context.TEXTURE_2D, 0, 0, firstRow, DATA_TEXTURE_WIDTH, endRow - firstRow, context.RGBA_INTEGER, context.UNSIGNED_INT, entry.mirror.subarray(firstRow * rowWords, endRow * rowWords));
  context.activeTexture(context.TEXTURE0);
}

function updateAttachedSplats(renderer, attachment, entry, change) {
  const { splats } = entry;
  if (!attachment.entries.has(entry)) throw new Error('These splats are detached, so they cannot be updated. Attach them again, or call update on the function the latest attachGaussianSplats returned');
  const update = resolveSplatUpdate(change, splats);
  if (update.bounds) checkSplatBounds(update.bounds, 'update');
  const context = renderer.context;
  const mirror = ensureWordMirror(context, entry);
  const movesCentres = update.positions !== null || update.count !== splats.count;
  if (update.positions) {
    ensureOwnCentres(splats);
    splats.centres.set(update.positions.subarray(0, update.length * 3), update.start * 3);
  }
  const rows = writeSplatUpdate(mirror, update);
  uploadRows(context, entry, rows);
  splats.count = update.count;
  splats.statistics.count = update.count;
  if (update.bounds) splats.bounds = update.bounds;
  else if (movesCentres) splats.bounds = boundsOfCentres(splats.centres, update.count);
  splats.sorter.update({ positions: splats.centres, count: update.count, bounds: splats.bounds });
}
