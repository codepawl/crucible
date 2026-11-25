import { invalidField } from './field-error.js';
import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Surface cover (#3147): a layer (snow, dust, moss) drawn over the material where the surface faces up or sits high, with
// the mask worked out per pixel in the fragment shader from the interpolated world normal and world position. The graph
// `surface` node bakes the same masks into one UV texture per mesh, so on a mesh as large as a mountain one texel covers
// a lot of ground and the edge of the mask shows stair steps. A cover has no texture, so its edge is as sharp as the pixel.
//
// Signal (0 where the layer must not sit, 1 where it sits fully), the same values the graph reads from a `surface` node:
//   slope    1 minus the baked slope output: 1 on a surface facing up, 0 on a wall and under an overhang.
//   normalY  the up component of the normal from -1 to 1 written as 0 to 1.
//   height   the world height as a share of `range` [low, high] metres (required, the shader has no mesh bounds).
// noise.amount * (noise - 0.5) is added to the signal to break the edge up, then the cover is
// smoothstep(edge - softness, edge + softness, signal). The module also holds the GLSL (registered on import) and the
// CPU twin of it that the tests compare against the baked `surface` maps.

export const SURFACE_COVER_OUTPUTS = Object.freeze(['slope', 'normalY', 'height']);
export const SURFACE_COVER_FIELDS = Object.freeze(['output', 'range', 'edge', 'softness', 'noise', 'color', 'roughness']);
export const SURFACE_COVER_NOISE_FIELDS = Object.freeze(['scale', 'amount', 'seed']);
export const SURFACE_COVER_LIMITS = Object.freeze({
  edge: Object.freeze([0, 1]),
  softness: Object.freeze([0.001, 0.5]),
  noiseScale: Object.freeze([0.01, 1000]),
  noiseAmount: Object.freeze([0, 1]),
  noiseSeed: Object.freeze([0, 1000]),
  rangeMetres: 100000,
});
export const SURFACE_COVER_DEFAULTS = Object.freeze({ output: 'slope', edge: 0.5, softness: 0.1, color: Object.freeze([0.9, 0.92, 0.95]), roughness: 0.85 });
export const SURFACE_COVER_NOISE_DEFAULTS = Object.freeze({ scale: 1, amount: 0.4, seed: 0 });
// The shader sums two octaves of lattice noise, the second at this frequency ratio and weight (a fixed, bounded cost).
export const SURFACE_COVER_OCTAVE = Object.freeze({ firstWeight: 0.6, secondWeight: 0.4, ratio: 5.3, shift: 13 });
// The edge never gets thinner than the pixel, but the pixel's share is capped at this many softnesses: a crease in the mesh
// normals jumps the signal between two neighbouring pixels, and an uncapped fwidth smears a white band along every crease.
export const SURFACE_COVER_FILTER_CAP = 1.5;
// An octave whose lattice cell is under a few pixels wide only aliases (speckles that shimmer when the camera moves), so its
// amplitude fades out as the pixel footprint, in lattice cells per pixel, grows: full at the first value, gone at the second
// (4 pixels a cell and 2 pixels a cell). A faded octave is replaced by its mean 0.5, so the edge stays where it was.
// A negative noise lobe over a covered pixel punches a dark hole into the layer, an isolated blob where the signal only sits a
// little above the edge. Noise may still add layer on the bare side, but the pull-down fades to nothing once the signal is
// this far (in signal units) above the edge, so holes can only open along the edge itself.
export const SURFACE_COVER_HOLE_REACH = 0.05;
export const SURFACE_COVER_OCTAVE_FADE = Object.freeze({ fullBelow: 0.25, goneAbove: 0.5 });

const RIGHT_ANGLE = Math.PI / 2;
const EXAMPLE = '{"surfaceCover":{"output":"slope","edge":0.5,"noise":{"scale":0.2}}}';

function onlyKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, `an object, such as ${EXAMPLE}`, TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${label}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
  }
}

function numberIn(value, label, fallback, [minimum, maximum]) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !(result >= minimum && result <= maximum)) {
    throw invalidField(label, value, `a number from ${minimum} to ${maximum}, such as ${fallback}`, TypeError);
  }
  return result;
}

function readRange(value, output) {
  if (output !== 'height') {
    if (value !== undefined) throw invalidField('surfaceCover.range', value, 'nothing: range only applies to output "height"; remove it', TypeError);
    return undefined;
  }
  const limit = SURFACE_COVER_LIMITS.rangeMetres;
  const valid = Array.isArray(value) && value.length === 2 && value.every(metres => typeof metres === 'number' && Math.abs(metres) <= limit) && value[0] < value[1];
  if (!valid) throw invalidField('surfaceCover.range', value, 'world heights [low, high] in metres with low below high, such as [0, 12]; height needs it because the shader has no mesh bounds', TypeError);
  return Object.freeze([value[0], value[1]]);
}

function readNoise(value) {
  if (value === undefined) return undefined;
  onlyKeys(value, SURFACE_COVER_NOISE_FIELDS, 'surfaceCover.noise');
  return Object.freeze({
    scale: numberIn(value.scale, 'surfaceCover.noise.scale', SURFACE_COVER_NOISE_DEFAULTS.scale, SURFACE_COVER_LIMITS.noiseScale),
    amount: numberIn(value.amount, 'surfaceCover.noise.amount', SURFACE_COVER_NOISE_DEFAULTS.amount, SURFACE_COVER_LIMITS.noiseAmount),
    seed: Math.round(numberIn(value.seed, 'surfaceCover.noise.seed', SURFACE_COVER_NOISE_DEFAULTS.seed, SURFACE_COVER_LIMITS.noiseSeed)),
  });
}

function readColor(value) {
  const result = value ?? SURFACE_COVER_DEFAULTS.color;
  if (!Array.isArray(result) || result.length !== 3 || result.some(channel => typeof channel !== 'number' || !(channel >= 0 && channel <= 1))) {
    throw invalidField('surfaceCover.color', value, `three numbers from 0 to 1, such as [${SURFACE_COVER_DEFAULTS.color.join(', ')}]`, TypeError);
  }
  return Object.freeze([...result]);
}

/** Validate a material `surfaceCover` field and return a frozen copy with every default filled in. */
export function normalizeSurfaceCover(value) {
  onlyKeys(value, SURFACE_COVER_FIELDS, 'surfaceCover');
  const output = value.output ?? SURFACE_COVER_DEFAULTS.output;
  if (!SURFACE_COVER_OUTPUTS.includes(output)) {
    throw invalidField('surfaceCover.output', output, `one of ${SURFACE_COVER_OUTPUTS.join(', ')}, such as "slope"`, TypeError);
  }
  const result = {
    output,
    edge: numberIn(value.edge, 'surfaceCover.edge', SURFACE_COVER_DEFAULTS.edge, SURFACE_COVER_LIMITS.edge),
    softness: numberIn(value.softness, 'surfaceCover.softness', SURFACE_COVER_DEFAULTS.softness, SURFACE_COVER_LIMITS.softness),
    color: readColor(value.color),
    roughness: numberIn(value.roughness, 'surfaceCover.roughness', SURFACE_COVER_DEFAULTS.roughness, [0, 1]),
  };
  const range = readRange(value.range, output);
  if (range) result.range = range;
  const noise = readNoise(value.noise);
  if (noise) result.noise = noise;
  return Object.freeze(result);
}

// ---- the CPU twin of the shader ----

function latticeHash(x, y, z) {
  let bits = Math.imul(x + 32768, 1597334673) ^ Math.imul(y + 32768, 3812015801) ^ Math.imul(z + 32768, 2798796415);
  bits = Math.imul(bits ^ (bits >>> 16), 2246822519);
  bits = Math.imul(bits ^ (bits >>> 13), 3266489917);
  bits ^= bits >>> 16;
  return (bits >>> 8) / 16777215;
}

const lerp = (from, to, amount) => from + (to - from) * amount;

function latticeNoise(x, y, z) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const cellZ = Math.floor(z);
  const [blendX, blendY, blendZ] = [x - cellX, y - cellY, z - cellZ].map(fraction => fraction * fraction * (3 - 2 * fraction));
  const plane = offsetZ => lerp(
    lerp(latticeHash(cellX, cellY, cellZ + offsetZ), latticeHash(cellX + 1, cellY, cellZ + offsetZ), blendX),
    lerp(latticeHash(cellX, cellY + 1, cellZ + offsetZ), latticeHash(cellX + 1, cellY + 1, cellZ + offsetZ), blendX),
    blendY,
  );
  return lerp(plane(0), plane(1), blendZ);
}

/** How much of an octave is kept, 1 down to 0, for a pixel footprint of `cellsPerPixel` lattice cells. */
export function surfaceCoverOctaveFade(cellsPerPixel) {
  return 1 - smoothstepBetween(SURFACE_COVER_OCTAVE_FADE.fullBelow, SURFACE_COVER_OCTAVE_FADE.goneAbove, cellsPerPixel);
}

/**
 * The two octave noise the shader adds to the signal, from 0 to 1, at a world position in metres. `footprint` is the
 * length of the screen-space change of the first octave's coordinate; each octave fades to 0.5 as its own footprint grows.
 */
export function surfaceCoverNoise(position, noise, footprint = 0) {
  const shift = noise.seed * 31;
  const [x, y, z] = position.map(coordinate => coordinate * noise.scale + shift);
  const { firstWeight, secondWeight, ratio, shift: octaveShift } = SURFACE_COVER_OCTAVE;
  const first = lerp(0.5, latticeNoise(x, y, z), surfaceCoverOctaveFade(footprint));
  const second = lerp(0.5, latticeNoise(x * ratio + octaveShift, y * ratio + octaveShift, z * ratio + octaveShift), surfaceCoverOctaveFade(footprint * ratio));
  return firstWeight * first + secondWeight * second;
}

/** The mask signal before noise: 1 where the layer sits, from the unit up component of the normal and the world height. */
export function surfaceCoverSignal(cover, upNormal, height) {
  const clamped = Math.min(1, Math.max(-1, upNormal));
  if (cover.output === 'slope') return 1 - Math.acos(clamped) / RIGHT_ANGLE;
  if (cover.output === 'normalY') return 0.5 + 0.5 * clamped;
  return (height - cover.range[0]) / (cover.range[1] - cover.range[0]);
}

/** Half the width of the smoothstep: the softness, widened toward half the screen-space change of the signal, up to the cap. */
export function surfaceCoverHalfWidth(softness, filterWidth) {
  return Math.max(softness, Math.min(0.5 * filterWidth, SURFACE_COVER_FILTER_CAP * softness));
}

function smoothstepBetween(low, high, value) {
  const unit = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return unit * unit * (3 - 2 * unit);
}

/** The signal with the noise added: `noiseValue` from 0 to 1 moves it by amount * (noiseValue - 0.5), pulls toward bare fading out above the edge. */
export function surfaceCoverBrokenSignal(cover, signal, noiseValue) {
  const offset = cover.noise.amount * (noiseValue - 0.5);
  if (offset >= 0) return signal + offset;
  const marginAboveEdge = Math.max(0, signal - cover.edge);
  return signal + offset * (1 - smoothstepBetween(0, SURFACE_COVER_HOLE_REACH, marginAboveEdge));
}

/**
 * How much of the layer covers a point: `position` is the world position and `normal` the world normal (any length).
 * `filterWidth` is the screen-space change of the signal, which the shader passes from fwidth so the edge never gets
 * thinner than a pixel; 0 gives the exact mask.
 */
export function surfaceCoverAmount(cover, position, normal, filterWidth = 0, noiseFootprint = 0) {
  const length = Math.hypot(...normal);
  const upNormal = length > 0 ? normal[1] / length : 0;
  const signal = surfaceCoverSignal(cover, upNormal, position[1]);
  const broken = cover.noise ? surfaceCoverBrokenSignal(cover, signal, surfaceCoverNoise(position, cover.noise, noiseFootprint)) : signal;
  const half = surfaceCoverHalfWidth(cover.softness, filterWidth);
  return smoothstepBetween(cover.edge - half, cover.edge + half, broken);
}

// The graph reaches the same mask in two steps: a `smoothstep(low, high, signal)` mask, then the `layer` node's own
// smoothstep(edge - softness, edge + softness) over that mask. Both steps collapse into one cover whose edge sits where the
// first step reaches the layer's edge and whose softness is the signal distance the second step spans. A cover with the
// graph's default layer edge 0.5 and softness 0.1 over smoothstep(0.2, 0.46) is edge 0.33, softness 0.026, far narrower than
// the 0.13 that reading the mask alone suggests.
function inverseSmoothstep(value) {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (middle * middle * (3 - 2 * middle) < value) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** The `edge` and `softness` of a cover that matches a graph mask `smoothstep(low, high, signal)` gated by a layer node `edge` and `softness`. */
export function surfaceCoverFromGraphMask({ low, high, layerEdge = 0.5, layerSoftness = 0.1 }) {
  const span = high - low;
  const lower = Math.max(0, layerEdge - layerSoftness);
  const upper = Math.min(1, layerEdge + layerSoftness);
  const edge = low + span * inverseSmoothstep(layerEdge);
  const softness = Math.max(SURFACE_COVER_LIMITS.softness[0], span * (inverseSmoothstep(upper) - inverseSmoothstep(lower)) / 2);
  return { edge, softness };
}

// ---- the shader ----

const OFF = -1;
const OUTPUT_INDEX = Object.freeze({ slope: 0, normalY: 1, height: 2 });

// One cover per draw. materialCoverShape holds the output index (OFF when the batch has no cover), edge, softness and noise
// amount; materialCoverNoise the noise scale, seed offset and the height range; materialCoverLook the colour and roughness.
// wearNoise's hash is not reused: this noise has its own so the two stay free to change.
const SURFACE_COVER_DECLARATIONS = `uniform vec4 materialCoverShape;
uniform vec4 materialCoverNoise;
uniform vec4 materialCoverLook;
float coverCellHash(vec3 cell) {
  uvec3 lattice = uvec3(ivec3(floor(cell)) + ivec3(32768));
  uint bits = (lattice.x * 1597334673u) ^ (lattice.y * 3812015801u) ^ (lattice.z * 2798796415u);
  bits = (bits ^ (bits >> 16u)) * 2246822519u;
  bits = (bits ^ (bits >> 13u)) * 3266489917u;
  bits ^= bits >> 16u;
  return float(bits >> 8u) / 16777215.0;
}
float coverNoise(vec3 position) {
  vec3 cell = floor(position);
  vec3 blend = fract(position);
  blend = blend * blend * (3.0 - 2.0 * blend);
  float low = mix(mix(coverCellHash(cell), coverCellHash(cell + vec3(1, 0, 0)), blend.x), mix(coverCellHash(cell + vec3(0, 1, 0)), coverCellHash(cell + vec3(1, 1, 0)), blend.x), blend.y);
  float high = mix(mix(coverCellHash(cell + vec3(0, 0, 1)), coverCellHash(cell + vec3(1, 0, 1)), blend.x), mix(coverCellHash(cell + vec3(0, 1, 1)), coverCellHash(cell + vec3(1, 1, 1)), blend.x), blend.y);
  return mix(low, high, blend.z);
}
float coverOctaveFade(float cellsPerPixel) {
  return 1.0 - smoothstep(${SURFACE_COVER_OCTAVE_FADE.fullBelow}, ${SURFACE_COVER_OCTAVE_FADE.goneAbove}, cellsPerPixel);
}
`;

const SURFACE_COVER_SURFACE = `  if (materialCoverShape.x > -0.5) {
    float coverUp = normalize(worldNormal).y;
    float coverSignal = materialCoverShape.x < 0.5 ? 1.0 - acos(clamp(coverUp, -1.0, 1.0)) / 1.5707963 : (materialCoverShape.x < 1.5 ? 0.5 + 0.5 * clamp(coverUp, -1.0, 1.0) : (worldPosition.y - materialCoverNoise.z) / (materialCoverNoise.w - materialCoverNoise.z));
    float coverWidth = max(materialCoverShape.z, min(0.5 * fwidth(coverSignal), ${SURFACE_COVER_FILTER_CAP} * materialCoverShape.z));
    float coverBroken = coverSignal;
    if (materialCoverShape.w > 0.0) {
      vec3 coverPoint = worldPosition * materialCoverNoise.x + vec3(materialCoverNoise.y);
      float coverFootprint = length(fwidth(coverPoint));
      float coverBreak = ${SURFACE_COVER_OCTAVE.firstWeight} * mix(0.5, coverNoise(coverPoint), coverOctaveFade(coverFootprint)) + ${SURFACE_COVER_OCTAVE.secondWeight} * mix(0.5, coverNoise(coverPoint * ${SURFACE_COVER_OCTAVE.ratio} + vec3(${SURFACE_COVER_OCTAVE.shift}.0)), coverOctaveFade(coverFootprint * ${SURFACE_COVER_OCTAVE.ratio}));
      float coverOffset = materialCoverShape.w * (coverBreak - 0.5);
      coverBroken += coverOffset < 0.0 ? coverOffset * (1.0 - smoothstep(0.0, ${SURFACE_COVER_HOLE_REACH}, max(coverSignal - materialCoverShape.y, 0.0))) : coverOffset;
    }
    float covered = smoothstep(materialCoverShape.y - coverWidth, materialCoverShape.y + coverWidth, coverBroken);
    color = mix(color, materialCoverLook.rgb, covered);
    metallic *= 1.0 - covered;
    roughness = clamp(mix(roughness, materialCoverLook.w, covered), 0.075, 1.0);
    coatKept *= 1.0 - covered;
  }
`;

registerShaderFeatureCode('surfaceCover', Object.freeze({
  declarations: SURFACE_COVER_DECLARATIONS,
  worldSurface: SURFACE_COVER_SURFACE,
}));

function uniformOf(renderer, name) {
  renderer.uniforms[name] ??= renderer.context.getUniformLocation(renderer.program, name);
  return renderer.uniforms[name];
}

/** The three uniform vectors of a cover, or the off marker for a batch without one. */
export function surfaceCoverUniformValues(cover) {
  if (!cover) return { shape: [OFF, 0, 0, 0], noise: [0, 0, 0, 1], look: [0, 0, 0, 0] };
  const noise = cover.noise;
  return {
    shape: [OUTPUT_INDEX[cover.output], cover.edge, cover.softness, noise ? noise.amount : 0],
    noise: [noise ? noise.scale : 1, noise ? noise.seed * 31 : 0, cover.range ? cover.range[0] : 0, cover.range ? cover.range[1] : 1],
    look: [...cover.color, cover.roughness],
  };
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures?.has('surfaceCover')) return;
  const values = surfaceCoverUniformValues(batch.parts?.[0]?.material?.surfaceCover);
  renderer.context.uniform4f(uniformOf(renderer, 'materialCoverShape'), ...values.shape);
  renderer.context.uniform4f(uniformOf(renderer, 'materialCoverNoise'), ...values.noise);
  renderer.context.uniform4f(uniformOf(renderer, 'materialCoverLook'), ...values.look);
};
