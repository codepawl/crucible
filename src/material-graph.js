import { MATERIAL_GRAPH_LIMITS, MATERIAL_GRAPH_OUTPUTS, MATERIAL_GRAPH_OPERATORS, MESH_MAP_NAMES, SURFACE_OUTPUTS, SURFACE_SPACES } from './agent-scene-capabilities.js';
import { EMISSION_FRESNEL_IOR_RANGE } from './material-layers.js';
import { clampUnit, smoothStep, wrapCell, hashCell, cellularNoise, smoothCellularDistance, linearToSrgbByte, createImage, normalMapFromHeightFunction } from './material-texture-kit.js';

// A bounded material node graph. Like a field expression (src/mesh-fields.js), a graph is data and never code: it is
// walked as plain objects against a fixed table of operators, checked against its limits before any pixel is
// evaluated, and baked on the CPU into textures. Nothing here builds shader source, and the only strings accepted are
// the fixed names listed below, so agent input can not reach the GPU as text. Issue 98 will merge this with the field
// language; the shape (one operator per object, numbers are constants, [r, g, b] is a constant vector) already matches.
//
//   { "color": { "ramp": { "value": { "noise": { "scale": 8 } }, "stops": [[0, [0.1, 0.05, 0.02]], [1, [0.6, 0.4, 0.2]]] } },
//     "height": { "noise": { "scale": 8 } } }
//
// Every texture node is periodic over the unit square, so a baked graph tiles. Values are numbers or vectors of three.

const MAX_LITERAL = 1e6;
const MAX_SEED = 0x7fffffff;
const MAX_REPORTED_KEY_LENGTH = 24;
const NOISE_SCALE_LIMIT = 64;
// noise and voronoi may go finer than 64 cells across a tile when the bake can resolve them: a scale above 64 needs a
// resolution of at least FINE_SCALE_MIN_PIXELS pixels per cell, so 256 cells at 1024 and never above the hard limit.
const FINE_SCALE_LIMIT = 1024;
const FINE_SCALE_MIN_PIXELS = 4;
const NOISE_OCTAVE_LIMIT = 6;
// Work units. One unit is about 33 ns of one pixel on a 2024 desktop CPU in Node (a noise octave is 2.1 units); the
// costs below are in hundredths of a unit, measured one node kind at a time (#3147, docs/agent-scene.md "Work budget").
// maxWork then reads as a time budget: 60 million units is about 2 s of baking. A plain operator costs NODE_COST.
export const WORK_UNIT_NANOSECONDS = 33;
const NODE_COST = 10;
const RAMP_COST = 375;
const HUE_COST = 625;
const CURVE_COST = 250;
const LAYER_COST = 225;
// normalMapFromHeightFunction reads the height field four times a pixel and normalizes the slope in between.
const BUMP_HEIGHT_READS = 4;
const BUMP_NORMALIZE_COST = 250;
// A vector node (a colour) runs its operation once for each of three channels, and the bake writes each pixel's channels.
const VECTOR_NODE_COST = 200;
const PIXEL_COST = 250;
const COST_DENOMINATOR = 100;
const VORONOI_COST = 750;
const NOISE_COST_PER_OCTAVE = 190;

function graphError(message) {
  return new TypeError(`Material graph: ${message}`);
}

function describeKey(key) {
  const clipped = key.length > MAX_REPORTED_KEY_LENGTH ? `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}...` : key;
  return JSON.stringify(clipped);
}

function describeValue(value) {
  if (value === undefined) return 'nothing (the field is missing)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return describeKey(value);
  return typeof value === 'object' ? 'an object' : String(value);
}

// A one-argument operator given a list of three reads as a vector literal by mistake; say how to pass one (#2403).
function describeArgumentCount(name, argumentCount, operands) {
  const plural = argumentCount === 1 ? '' : 's';
  const got = Array.isArray(operands) ? `a list of ${operands.length}` : describeValue(operands);
  const hint = argumentCount === 1 && Array.isArray(operands) && operands.length === 3
    ? ` A list is read as the arguments; to pass a vector, wrap it: {"${name}": [[x, y, z]]} or {"${name}": {"vec": [x, y, z]}}.`
    : '';
  return `${name} needs ${argumentCount} argument${plural}, got ${got}.${hint}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(node, allowed, label) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw graphError(`${label} does not take ${describeKey(key)}; fields: ${allowed.join(', ')}.`);
  }
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw graphError(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  return value;
}

function fineScale(value, label, state) {
  if (!Number.isInteger(value) || value < 1 || value > FINE_SCALE_LIMIT) {
    throw graphError(`${label} must be a whole number from 1 to ${NOISE_SCALE_LIMIT}, or up to ${FINE_SCALE_LIMIT} when the bake resolution is at least ${FINE_SCALE_MIN_PIXELS} times the scale.`);
  }
  state.finestScale = Math.max(state.finestScale ?? 0, value);
  return value;
}

function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw graphError(`${label} must be a number from ${minimum} to ${maximum}, got ${describeValue(value)}.`);
  return value;
}

function oneOf(value, names, label) {
  if (typeof value !== 'string' || !names.includes(value)) throw graphError(`${label} must be one of ${names.join(', ')}.`);
  return value;
}

function finiteLiteral(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LITERAL;
}

// ---------------------------------------------------------------------------------------------------------------
// Compiled values take the pixel position: { kind: 'scalar', evaluate(u, v) } or { kind: 'vector', parts: [x, y, z] }.

const scalarValue = evaluate => ({ kind: 'scalar', evaluate });
const vectorValue = (partX, partY, partZ) => ({ kind: 'vector', parts: [partX, partY, partZ] });
const partsOf = value => (value.kind === 'vector' ? value.parts : [value.evaluate, value.evaluate, value.evaluate]);

function liftComponentwise(values, compute) {
  if (values.every(value => value.kind === 'scalar')) {
    const [first, second, third] = values.map(value => value.evaluate);
    return scalarValue((u, v) => compute(first(u, v), second?.(u, v), third?.(u, v)));
  }
  // A scalar beside a vector is read by all three channels; keep its value for the texel instead of working it out three times.
  const [first, second, third] = values.map(value => (value.kind === 'vector' ? value.parts : Array(3).fill(rememberLastTexel(value.evaluate))));
  const channel = index => (u, v) => compute(first[index](u, v), second?.[index](u, v), third?.[index](u, v));
  return vectorValue(channel(0), channel(1), channel(2));
}

const finiteOrZero = value => (Number.isFinite(value) ? value : 0);
const fract = value => value - Math.floor(value);
const mixNumbers = (start, end, factor) => start + (end - start) * factor;

// name: [argument count, compute(first, second, third)]
const MATH_OPERATORS = new Map([
  ['add', [2, (a, b) => a + b]],
  ['sub', [2, (a, b) => a - b]],
  ['mul', [2, (a, b) => a * b]],
  ['div', [2, (a, b) => (b === 0 ? 0 : a / b)]],
  ['min', [2, (a, b) => Math.min(a, b)]],
  ['max', [2, (a, b) => Math.max(a, b)]],
  ['pow', [2, (a, b) => Math.abs(a) ** Math.min(Math.max(b, -16), 16)]],
  ['abs', [1, Math.abs]],
  ['floor', [1, Math.floor]],
  ['fract', [1, fract]],
  ['sqrt', [1, value => Math.sqrt(Math.max(value, 0))]],
  ['invert', [1, value => 1 - value]],
  ['clamp', [3, (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))]],
  ['smoothstep', [3, (low, high, value) => (low === high ? (value < low ? 0 : 1) : smoothStep(low, high, value))]],
  ['mix', [3, mixNumbers]],
]);

// ---------------------------------------------------------------------------------------------------------------
// Compiling. The state counts nodes, the work each costs per pixel and the deepest nesting.

function compileCoordinates(node) {
  const axis = oneOf(node.uv, ['u', 'v', 'both'], 'uv');
  if (Object.keys(node).length !== 1) throw graphError('uv takes no other fields.');
  if (axis === 'u') return scalarValue(u => u);
  if (axis === 'v') return scalarValue((u, v) => v);
  return vectorValue(u => u, (u, v) => v, () => 0);
}

const WARP_STRENGTH_LIMIT = 4;
const WARP_COST = 250;
// The fields every texture node that reads a position takes: where it samples ("at") and what pushes that spot around ("warp").
const POSITION_FIELDS = ['at', 'warp'];

// A warp node moves the lookup of the node that holds it: a number offsets u and v by (number - 0.5) * strength, a vector
// offsets u by its first part and v by its second. The warp node is read at the unwarped pixel, so a periodic warp keeps the
// texture tiling.
function compileWarp(warp, state, depth) {
  if (!isPlainObject(warp)) throw graphError('warp takes { node, strength }, such as {"warp":{"node":{"noise":{"scale":3}},"strength":1}}.');
  onlyKeys(warp, ['node', 'strength'], 'warp');
  if (warp.node === undefined) throw graphError('warp needs "node", the number or vector that offsets the lookup.');
  const strength = warp.strength ?? 1;
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > WARP_STRENGTH_LIMIT) {
    throw graphError(`warp strength must be a number from 0 to ${WARP_STRENGTH_LIMIT} (tiles), got ${describeValue(strength)}.`);
  }
  const offsetNode = compileNode(warp.node, state, depth + 1, 'warp "node"');
  state.cost += WARP_COST;
  const [offsetU, offsetV] = offsetNode.kind === 'vector' ? offsetNode.parts : [offsetNode.evaluate, offsetNode.evaluate];
  return {
    shiftU: (u, v) => (finiteOrZero(offsetU(u, v)) - 0.5) * strength,
    shiftV: (u, v) => (finiteOrZero(offsetV(u, v)) - 0.5) * strength,
  };
}

function compilePosition(settings, state, depth) {
  let positionU = u => u;
  let positionV = (u, v) => v;
  if (settings.at !== undefined) {
    const position = compileNode(settings.at, state, depth + 1, '"at"');
    if (position.kind !== 'vector') throw graphError('"at" needs a vector such as {"uv":"both"}.');
    [positionU, positionV] = position.parts;
  }
  if (settings.warp === undefined) return [positionU, positionV];
  const { shiftU, shiftV } = compileWarp(settings.warp, state, depth);
  const unwarpedU = positionU;
  const unwarpedV = positionV;
  return [(u, v) => unwarpedU(u, v) + shiftU(u, v), (u, v) => unwarpedV(u, v) + shiftV(u, v)];
}

function textureSettings(node, name, allowed) {
  const settings = node[name];
  if (!isPlainObject(settings) || Object.keys(node).length !== 1) throw graphError(`${name} takes { ${allowed.join(', ')} } and nothing else.`);
  onlyKeys(settings, allowed, name);
  return settings;
}

// Blender's Noise Texture node (2D, Perlin, fractal Brownian motion, Normalize on): Jenkins lookup3 hash of the lattice
// corner, the 8 gradients of its 2D Perlin, 6t^5 - 15t^4 + 10t^3 fade, and the octave sum divided by the amplitude sum.
// Detail is octaves - 1, Roughness 0.5 and Lacunarity 2, the node's defaults.
const HASH_START = (0xdeadbeef + (2 << 2) + 13) >>> 0;
const rotateLeft = (value, bits) => (value << bits) | (value >>> (32 - bits));
const PERLIN_OUTPUT_SCALE = 0.6616;
const NOISE_GAIN = 0.5;
const NOISE_LACUNARITY = 2;
const NOISE_KINDS = ['fbm', 'ridged', 'billow'];
const LACUNARITY_RANGE = [1, 4];
const GAIN_RANGE = [0, 1];

function hashLatticeCorner(cellX, cellY) {
  let a = (HASH_START + cellX) >>> 0;
  let b = (HASH_START + cellY) >>> 0;
  let thirdState = HASH_START;
  thirdState = (thirdState ^ b) - rotateLeft(b, 14);
  a = ((a ^ thirdState) >>> 0) - rotateLeft(thirdState, 11);
  b = ((b ^ a) >>> 0) - rotateLeft(a, 25);
  thirdState = ((thirdState ^ b) >>> 0) - rotateLeft(b, 16);
  a = ((a ^ thirdState) >>> 0) - rotateLeft(thirdState, 4);
  b = ((b ^ a) >>> 0) - rotateLeft(a, 14);
  thirdState = ((thirdState ^ b) >>> 0) - rotateLeft(b, 24);
  return thirdState >>> 0;
}

function cornerGradient(hash, offsetX, offsetY) {
  const choice = hash & 7;
  const major = choice < 4 ? offsetX : offsetY;
  const minor = 2 * (choice < 4 ? offsetY : offsetX);
  return ((choice & 1) ? -major : major) + ((choice & 2) ? -minor : minor);
}

const fade = value => value * value * value * (value * (value * 6 - 15) + 10);

// A period of 0 leaves the lattice unwrapped, which is Blender's. A period in cells wraps the corner indices so the
// noise repeats every period cells (only the cells at the far edge of the unit square then differ from Blender).
function latticeHash(cellX, cellY, period) {
  if (period === 0) return hashLatticeCorner(cellX, cellY);
  return hashLatticeCorner(wrapCell(cellX, period), wrapCell(cellY, period));
}

function perlinNoise(x, y, period) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fractionX = x - cellX;
  const fractionY = y - cellY;
  const blendX = fade(fractionX);
  const blendY = fade(fractionY);
  const bottom = mixNumbers(
    cornerGradient(latticeHash(cellX, cellY, period), fractionX, fractionY),
    cornerGradient(latticeHash(cellX + 1, cellY, period), fractionX - 1, fractionY),
    blendX,
  );
  const top = mixNumbers(
    cornerGradient(latticeHash(cellX, cellY + 1, period), fractionX, fractionY - 1),
    cornerGradient(latticeHash(cellX + 1, cellY + 1, period), fractionX - 1, fractionY - 1),
    blendX,
  );
  return PERLIN_OUTPUT_SCALE * mixNumbers(bottom, top, blendY);
}

// What one octave of Perlin noise (about -1 to 1) contributes to the sum: fbm keeps the signed value, billow its absolute
// value (rounded hills) and ridged the square of one minus it (sharp crests where the noise crosses zero), both 0 to 1.
const OCTAVE_SIGNALS = {
  fbm: value => value,
  billow: value => Math.abs(value),
  ridged: value => (1 - Math.min(Math.abs(value), 1)) ** 2,
};

// A tiling noise needs a whole number of cells across the tile in every octave. A lacunarity of 2 gives that by itself;
// any other frequency is moved to the nearest whole number of cells.
function tiledOctaveFrequency(frequency, tileCells) {
  if (tileCells === 0 || Number.isInteger(tileCells * frequency)) return frequency;
  return Math.max(1, Math.round(tileCells * frequency)) / tileCells;
}

/**
 * Blender's Noise Texture Fac at (x, y), already scaled by the node's Scale. `tileCells` is the first octave's number of
 * cells across the unit square when the noise must repeat, or 0 for Blender's endless lattice. `kind` (fbm is Blender's),
 * `lacunarity` (the frequency step between octaves) and `gain` (the amplitude step, Blender's Roughness) default to
 * Blender's own values, so the default call is Blender's output.
 */
export function blenderNoise(x, y, octaves, tileCells = 0, { kind = 'fbm', lacunarity = NOISE_LACUNARITY, gain = NOISE_GAIN } = {}) {
  const signal = OCTAVE_SIGNALS[kind];
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const octaveFrequency = tiledOctaveFrequency(frequency, tileCells);
    total += signal(perlinNoise(x * octaveFrequency, y * octaveFrequency, tileCells * octaveFrequency)) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  if (kind !== 'fbm') return clampUnit(total / amplitudeSum);
  return 0.5 * total / amplitudeSum + 0.5;
}

// The seed moves the lattice by whole cells, the same for Blender's side (bench/reference/render-blender.py).
const SEED_SHIFT_X = 7919;
const SEED_SHIFT_Y = 104729;
const SEED_SHIFT_RANGE = 1024;

function compileNoise(node, state, depth) {
  const settings = textureSettings(node, 'noise', ['scale', 'seed', 'octaves', 'kind', 'lacunarity', 'gain', 'tile', ...POSITION_FIELDS]);
  const scale = fineScale(settings.scale ?? 4, 'noise scale', state);
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'noise seed');
  const octaves = integerInRange(settings.octaves ?? 4, 1, NOISE_OCTAVE_LIMIT, 'noise octaves');
  const kind = oneOf(settings.kind ?? 'fbm', NOISE_KINDS, 'noise kind');
  const lacunarity = numberInRange(settings.lacunarity ?? NOISE_LACUNARITY, ...LACUNARITY_RANGE, 'noise lacunarity');
  const gain = numberInRange(settings.gain ?? NOISE_GAIN, ...GAIN_RANGE, 'noise gain');
  if (settings.tile !== undefined && typeof settings.tile !== 'boolean') throw graphError('noise tile must be true or false.');
  const tileCells = settings.tile === false ? 0 : scale;
  const shiftX = (seed * SEED_SHIFT_X) % SEED_SHIFT_RANGE;
  const shiftY = (seed * SEED_SHIFT_Y) % SEED_SHIFT_RANGE;
  state.cost += octaves * NOISE_COST_PER_OCTAVE;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  const options = { kind, lacunarity, gain };
  return scalarValue((u, v) => blenderNoise(positionU(u, v) * scale + shiftX, positionV(u, v) * scale + shiftY, octaves, tileCells, options));
}

// distance is F1, the distance to the nearest point; edge and f2MinusF1 are F2 - F1, which is 0 on the line between two
// cells, so the cracks of mud, cobbles and leather; f2 is the distance to the second nearest point; smoothF1 is F1 with
// the hard minimum smoothed (Blender's Smooth F1), so cells melt into organic blobs; cell is one random value per cell.
const VORONOI_OUTPUTS = ['distance', 'edge', 'cell', 'f2', 'f2MinusF1', 'smoothF1'];
const VORONOI_SMOOTH_COST = 2375;

function compileVoronoi(node, state, depth) {
  const settings = textureSettings(node, 'voronoi', ['scale', 'seed', 'output', 'jitter', 'smoothness', ...POSITION_FIELDS]);
  const scale = fineScale(settings.scale ?? 4, 'voronoi scale', state);
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'voronoi seed');
  const output = oneOf(settings.output ?? 'distance', VORONOI_OUTPUTS, 'voronoi output');
  const jitter = numberInRange(settings.jitter ?? 1, 0, 1, 'voronoi jitter');
  if (settings.smoothness !== undefined && output !== 'smoothF1') throw graphError('voronoi smoothness only applies to output "smoothF1"; remove it or set output to "smoothF1".');
  const smoothness = numberInRange(settings.smoothness ?? 1, 0, 1, 'voronoi smoothness');
  state.cost += output === 'smoothF1' ? VORONOI_SMOOTH_COST : VORONOI_COST;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    if (output === 'smoothF1') return clampUnit(smoothCellularDistance(positionU(u, v), positionV(u, v), scale, seed, jitter, smoothness));
    const { nearest, second, cell } = cellularNoise(positionU(u, v), positionV(u, v), scale, seed, jitter);
    if (output === 'cell') return cell / 4294967296;
    if (output === 'f2') return clampUnit(second);
    return clampUnit(output === 'distance' ? nearest : second - nearest);
  });
}

const WAVE_DIRECTIONS = ['u', 'v', 'diagonal'];
const WAVE_SHAPES = ['sine', 'saw', 'triangle'];

function compileWave(node, state, depth) {
  const settings = textureSettings(node, 'wave', ['frequency', 'direction', 'shape', ...POSITION_FIELDS]);
  const frequency = integerInRange(settings.frequency ?? 4, 1, NOISE_SCALE_LIMIT, 'wave frequency');
  const direction = oneOf(settings.direction ?? 'u', WAVE_DIRECTIONS, 'wave direction');
  const shape = oneOf(settings.shape ?? 'sine', WAVE_SHAPES, 'wave shape');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    const along = direction === 'u' ? positionU(u, v) : direction === 'v' ? positionV(u, v) : positionU(u, v) + positionV(u, v);
    const phase = along * frequency;
    if (shape === 'sine') return Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
    return shape === 'saw' ? fract(phase) : 1 - Math.abs(fract(phase) * 2 - 1);
  });
}

function compileChecker(node, state, depth) {
  const settings = textureSettings(node, 'checker', ['count', ...POSITION_FIELDS]);
  const count = integerInRange(settings.count ?? 8, 2, NOISE_SCALE_LIMIT, 'checker count');
  // An odd count would flip the pattern across the tiling seam.
  if (count % 2 !== 0) throw graphError('checker count must be even so it tiles.');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => (Math.floor(positionU(u, v) * count) + Math.floor(positionV(u, v) * count)) % 2 === 0 ? 0 : 1);
}

const GRADIENT_TYPES = ['u', 'v', 'radial'];

function compileGradient(node, state, depth) {
  const settings = textureSettings(node, 'gradient', ['type', ...POSITION_FIELDS]);
  const type = oneOf(settings.type ?? 'u', GRADIENT_TYPES, 'gradient type');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    if (type === 'u') return clampUnit(positionU(u, v));
    if (type === 'v') return clampUnit(positionV(u, v));
    return clampUnit(1 - Math.hypot(positionU(u, v) - 0.5, positionV(u, v) - 0.5) * 2);
  });
}

function checkedStop(stop, index, previousPosition) {
  if (!Array.isArray(stop) || stop.length !== 2) throw graphError(`ramp stop ${index} must be [position, value].`);
  const [position, value] = stop;
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 1 || position <= previousPosition) {
    throw graphError('ramp stop positions must rise strictly from 0 to 1.');
  }
  const isVector = Array.isArray(value);
  if (isVector ? value.length !== 3 || !value.every(finiteLiteral) : !finiteLiteral(value)) {
    throw graphError(`ramp stop ${index} value must be a number or [r, g, b] of finite numbers.`);
  }
  return { position, value, isVector };
}

function compileRamp(node, state, depth) {
  const settings = textureSettings(node, 'ramp', ['value', 'stops']);
  const { stops: rawStops } = settings;
  if (!Array.isArray(rawStops) || rawStops.length < 2 || rawStops.length > MATERIAL_GRAPH_LIMITS.maxStops) {
    throw graphError(`ramp needs 2 to ${MATERIAL_GRAPH_LIMITS.maxStops} stops.`);
  }
  let previousPosition = -1;
  const stops = rawStops.map((stop, index) => {
    const checked = checkedStop(stop, index, previousPosition);
    previousPosition = checked.position;
    return checked;
  });
  if (!stops.every(stop => stop.isVector === stops[0].isVector)) throw graphError('ramp stops are all numbers or all [r, g, b].');
  const input = compileNode(settings.value, state, depth + 1, 'ramp "value"');
  if (input.kind !== 'scalar') throw graphError('ramp "value" needs a number.');
  const channelRamp = channel => (u, v) => {
    const position = clampUnit(input.evaluate(u, v));
    const valueOf = stop => (stop.isVector ? stop.value[channel] : stop.value);
    if (position <= stops[0].position) return valueOf(stops[0]);
    for (let index = 1; index < stops.length; index++) {
      if (position <= stops[index].position) {
        const from = stops[index - 1];
        const to = stops[index];
        return mixNumbers(valueOf(from), valueOf(to), (position - from.position) / (to.position - from.position));
      }
    }
    return valueOf(stops[stops.length - 1]);
  };
  state.cost += RAMP_COST;
  return stops[0].isVector ? vectorValue(channelRamp(0), channelRamp(1), channelRamp(2)) : scalarValue(channelRamp(0));
}

function compileVector(node, state, depth) {
  if (!Array.isArray(node.vec) || node.vec.length !== 3 || Object.keys(node).length !== 1) throw graphError('vec needs [x, y, z] in an array.');
  const [partX, partY, partZ] = node.vec.map((part, index) => {
    const compiled = compileNode(part, state, depth + 1, `vec part ${index + 1}`);
    if (compiled.kind !== 'scalar') throw graphError('vec parts must be numbers.');
    return compiled.evaluate;
  });
  return vectorValue(partX, partY, partZ);
}

function compileMath(name, node, state, depth) {
  const [argumentCount, compute] = MATH_OPERATORS.get(name);
  const operands = argumentCount === 1 && !Array.isArray(node[name]) ? [node[name]] : node[name];
  if (!Array.isArray(operands) || operands.length !== argumentCount) throw graphError(describeArgumentCount(name, argumentCount, operands));
  return liftComponentwise(operands.map((operand, index) => compileNode(operand, state, depth + 1, `${name} argument ${index + 1}`)), compute);
}

// ---------------------------------------------------------------------------------------------------------------
// Mixing nodes: a layer put over another where a mask passes, a hue shift and a curve.

function compileScalarInput(node, state, depth, label) {
  const compiled = compileNode(node, state, depth + 1, label);
  if (compiled.kind !== 'scalar') throw graphError(`${label} needs a number.`);
  return compiled;
}

function compileLayer(node, state, depth) {
  const settings = textureSettings(node, 'layer', ['base', 'top', 'mask', 'edge', 'softness']);
  for (const required of ['base', 'top', 'mask']) {
    if (settings[required] === undefined) throw graphError(`layer needs "${required}".`);
  }
  state.cost += LAYER_COST;
  const edge = settings.edge ?? 0.5;
  const softness = settings.softness ?? 0.1;
  if (!finiteLiteral(edge) || !finiteLiteral(softness) || softness < 0) throw graphError('layer edge is a number and softness a number from 0.');
  const base = compileNode(settings.base, state, depth + 1, 'layer "base"');
  const top = compileNode(settings.top, state, depth + 1, 'layer "top"');
  const mask = compileScalarInput(settings.mask, state, depth, 'layer "mask"');
  const coverage = scalarValue((u, v) => {
    const value = mask.evaluate(u, v);
    return softness === 0 ? (value >= edge ? 1 : 0) : smoothStep(edge - softness, edge + softness, value);
  });
  return liftComponentwise([base, top, coverage], mixNumbers);
}

function rgbToHsv(red, green, blue) {
  const high = Math.max(red, green, blue);
  const spread = high - Math.min(red, green, blue);
  let hue = 0;
  if (spread > 0) {
    if (high === red) hue = ((green - blue) / spread + 6) % 6;
    else if (high === green) hue = (blue - red) / spread + 2;
    else hue = (red - green) / spread + 4;
  }
  return [hue / 6, high === 0 ? 0 : spread / high, high];
}

function hsvToRgb(hue, saturation, value) {
  const channel = offset => {
    const sector = (offset + hue * 6) % 6;
    return value * (1 - saturation * Math.max(0, Math.min(sector, 4 - sector, 1)));
  };
  return [channel(5), channel(3), channel(1)];
}

function compileHue(node, state, depth) {
  const settings = textureSettings(node, 'hue', ['color', 'shift', 'saturation', 'value']);
  const saturation = settings.saturation ?? 1;
  const brightness = settings.value ?? 1;
  for (const factor of [saturation, brightness]) {
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 4) throw graphError('hue saturation and value are numbers from 0 to 4.');
  }
  const color = compileNode(settings.color, state, depth + 1, 'hue "color"');
  if (color.kind !== 'vector') throw graphError('hue "color" needs a colour such as [r, g, b].');
  const shift = compileScalarInput(settings.shift ?? 0, state, depth, 'hue "shift"');
  state.cost += HUE_COST;
  const [red, green, blue] = color.parts;
  // The three channels read the same pixel in a row, so the last result is kept instead of converting three times.
  let lastU = NaN;
  let lastV = NaN;
  let lastResult = [0, 0, 0];
  const shifted = (u, v) => {
    if (u !== lastU || v !== lastV) {
      const [hue, sourceSaturation, sourceValue] = rgbToHsv(finiteOrZero(red(u, v)), finiteOrZero(green(u, v)), finiteOrZero(blue(u, v)));
      lastResult = hsvToRgb(fract(hue + finiteOrZero(shift.evaluate(u, v))), clampUnit(sourceSaturation * saturation), sourceValue * brightness);
      lastU = u;
      lastV = v;
    }
    return lastResult;
  };
  return vectorValue((u, v) => shifted(u, v)[0], (u, v) => shifted(u, v)[1], (u, v) => shifted(u, v)[2]);
}

function compileCurve(node, state, depth) {
  const settings = textureSettings(node, 'curve', ['value', 'points']);
  const { points } = settings;
  if (!Array.isArray(points) || points.length < 2 || points.length > MATERIAL_GRAPH_LIMITS.maxStops) throw graphError(`curve needs 2 to ${MATERIAL_GRAPH_LIMITS.maxStops} points.`);
  let previousX = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(finiteLiteral) || point[0] <= previousX) throw graphError('curve points are [x, y] with x rising.');
    previousX = point[0];
  }
  const remap = input => {
    if (input <= points[0][0]) return points[0][1];
    for (let index = 1; index < points.length; index++) {
      if (input <= points[index][0]) {
        const [fromX, fromY] = points[index - 1];
        const [toX, toY] = points[index];
        return mixNumbers(fromY, toY, (input - fromX) / (toX - fromX));
      }
    }
    return points[points.length - 1][1];
  };
  state.cost += CURVE_COST;
  return liftComponentwise([compileNode(settings.value, state, depth + 1, 'curve "value"')], remap);
}

const COORDINATE_SPACES = ['generated', 'object', 'world'];

// Where a texel sits on the surface. A baked texture is projected onto the mesh (box mapping along the object axes, or
// its UVs), so the two axes it knows are the only ones a texel can report: the third is 0. "generated" is the unit tile,
// "object" and "world" are metres across the tile (u * size). Box mapping reads the placed, scaled position, so the
// two are the same here.
function compileCoordinate(node, state) {
  const space = oneOf(node.coord, COORDINATE_SPACES, 'coord');
  if (Object.keys(node).length !== 1) throw graphError('coord takes no other fields.');
  const metres = space === 'generated' ? 1 : state.size;
  return vectorValue(u => u * metres, (u, v) => v * metres, () => 0);
}

const MAPPING_FIELDS = ['vector', 'scale', 'offset', 'rotate'];

function mappingTriple(value, fallback, label) {
  if (value === undefined) return fallback;
  const triple = typeof value === 'number' ? [value, value, value] : value;
  if (!Array.isArray(triple) || triple.length !== 3 || !triple.every(finiteLiteral)) throw graphError(`mapping "${label}" is a number or [x, y, z] of finite numbers.`);
  return triple;
}

// Blender's Mapping node (point): scale, then rotate around Z, then move. The vector defaults to {"coord":"generated"}.
function compileMapping(node, state, depth) {
  const settings = textureSettings(node, 'mapping', MAPPING_FIELDS);
  const [scaleX, scaleY, scaleZ] = mappingTriple(settings.scale, [1, 1, 1], 'scale');
  const [offsetX, offsetY, offsetZ] = mappingTriple(settings.offset, [0, 0, 0], 'offset');
  const rotation = settings.rotate ?? 0;
  if (!finiteLiteral(rotation)) throw graphError('mapping "rotate" is an angle in radians around Z.');
  const input = compileNode(settings.vector ?? { coord: 'generated' }, state, depth + 1, 'mapping "vector"');
  if (input.kind !== 'vector') throw graphError('mapping "vector" needs a vector such as {"coord":"generated"}.');
  const [inputX, inputY, inputZ] = input.parts;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedX = (u, v) => inputX(u, v) * scaleX * cosine - inputY(u, v) * scaleY * sine + offsetX;
  const rotatedY = (u, v) => inputX(u, v) * scaleX * sine + inputY(u, v) * scaleY * cosine + offsetY;
  return vectorValue(rotatedX, rotatedY, (u, v) => inputZ(u, v) * scaleZ + offsetZ);
}

const BRICK_OUTPUTS = ['mortar', 'edge', 'cell'];
const BRICK_COST = 25;

// Blender's Brick Texture, laid in a running bond. Whole columns and an even number of rows keep it tileable.
function compileBrick(node, state, depth) {
  const settings = textureSettings(node, 'brick', ['columns', 'rows', 'mortar', 'offset', 'seed', 'output', ...POSITION_FIELDS]);
  const columns = integerInRange(settings.columns ?? 8, 1, NOISE_SCALE_LIMIT, 'brick columns');
  const rows = integerInRange(settings.rows ?? 8, 2, NOISE_SCALE_LIMIT, 'brick rows');
  if (rows % 2 !== 0) throw graphError('brick rows must be even so the bond tiles.');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'brick seed');
  const output = oneOf(settings.output ?? 'mortar', BRICK_OUTPUTS, 'brick output');
  const mortar = settings.mortar ?? 0.05;
  const offset = settings.offset ?? 0.5;
  if (!finiteLiteral(mortar) || mortar < 0 || mortar > 0.5) throw graphError('brick mortar is the joint width as a share of a brick, from 0 to 0.5.');
  if (!finiteLiteral(offset) || offset < 0 || offset >= 1) throw graphError('brick offset is the shift of every other row as a share of a brick, from 0 up to 1.');
  state.cost += BRICK_COST;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    const scaledV = positionV(u, v) * rows;
    const row = Math.floor(scaledV);
    const scaledU = positionU(u, v) * columns + (wrapCell(row, 2) === 1 ? offset : 0);
    const column = Math.floor(scaledU);
    if (output === 'cell') return hashCell(wrapCell(column, columns), wrapCell(row, rows), seed) / 4294967296;
    const fractionU = scaledU - column;
    const fractionV = scaledV - row;
    const distance = Math.min(fractionU, 1 - fractionU, fractionV, 1 - fractionV);
    if (output === 'edge') return clampUnit(distance * 2);
    return mortar === 0 ? 0 : 1 - smoothStep(mortar * 0.5, mortar, distance);
  });
}

const WHITE_NOISE_OUTPUTS = ['value', 'color'];

// A random value per cell of a scale by scale grid; the cells wrap, so it tiles. "color" is three independent values.
function compileWhiteNoise(node, state, depth) {
  const settings = textureSettings(node, 'whiteNoise', ['scale', 'seed', 'output', ...POSITION_FIELDS]);
  const scale = integerInRange(settings.scale ?? 16, 1, NOISE_SCALE_LIMIT, 'whiteNoise scale');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'whiteNoise seed');
  const output = oneOf(settings.output ?? 'value', WHITE_NOISE_OUTPUTS, 'whiteNoise output');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  const channel = channelIndex => (u, v) => {
    const cellX = wrapCell(Math.floor(positionU(u, v) * scale), scale);
    const cellY = wrapCell(Math.floor(positionV(u, v) * scale), scale);
    return hashCell(cellX, cellY, (seed + channelIndex * 7919) | 0) / 4294967296;
  };
  return output === 'color' ? vectorValue(channel(1), channel(2), channel(3)) : scalarValue(channel(0));
}

const IMAGE_OUTPUTS = ['color', 'alpha', 'r', 'g', 'b', 'luminance'];
const IMAGE_DATA_CHANNELS = { r: 0, g: 1, b: 2, alpha: 3 };
const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];
const IMAGE_COST = 1000;
const IMAGE_ASSET_PATTERN = /^[a-f0-9]{64}$/;

const srgbToLinear = byte => {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
};

// One channel of an RGBA image read with bilinear filtering; the image repeats, so it tiles. Row 0 is the top, as is
// row 0 of a baked graph, so v needs no flip. Colour channels are decoded from sRGB to linear before they are blended.
function sampleImageChannel(image, positionU, positionV, channel, decode) {
  const { width, height, data } = image;
  const texelU = fract(positionU) * width - 0.5;
  const texelV = fract(positionV) * height - 0.5;
  const leftColumn = Math.floor(texelU);
  const topRow = Math.floor(texelV);
  const shareU = texelU - leftColumn;
  const shareV = texelV - topRow;
  const read = (column, row) => decode(data[(wrapCell(row, height) * width + wrapCell(column, width)) * 4 + channel]);
  const top = mixNumbers(read(leftColumn, topRow), read(leftColumn + 1, topRow), shareU);
  const bottom = mixNumbers(read(leftColumn, topRow + 1), read(leftColumn + 1, topRow + 1), shareU);
  return mixNumbers(top, bottom, shareV);
}

/**
 * The catalog image asset IDs a graph reads with `image` nodes, in the order they first appear. The host decodes these
 * (the same pool as texture sequence frames) before the graph is baked.
 */
export function graphImageAssets(graph) {
  const assets = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MATERIAL_GRAPH_LIMITS.maxDepth * 3) return;
    if (!Array.isArray(value) && typeof value.image?.asset === 'string') assets.add(value.image.asset);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(graph, 0);
  return [...assets];
}

// An image from the catalog, decoded by the host. Validating a graph needs no pixels, so without a pool only the
// asset ID is checked; baking without the image throws.
function compileImage(node, state, depth) {
  const settings = textureSettings(node, 'image', ['asset', 'output', ...POSITION_FIELDS]);
  const asset = typeof settings.asset === 'string' ? settings.asset.toLowerCase() : settings.asset;
  if (typeof asset !== 'string' || !IMAGE_ASSET_PATTERN.test(asset)) throw graphError('image asset must be the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists them. Remote URLs are not accepted.');
  const output = oneOf(settings.output ?? 'color', IMAGE_OUTPUTS, 'image output');
  const isNumberOutput = output !== 'color';
  state.cost += IMAGE_COST;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  const image = state.images ? state.images.get(asset) : null;
  if (state.images && !image) throw graphError(`image ${asset.slice(0, 12)} was not loaded. The host decodes catalog images before the scene is created.`);
  if (!image) return isNumberOutput ? scalarValue(() => 0) : vectorValue(() => 0, () => 0, () => 0);
  const at = (channel, decode) => (u, v) => sampleImageChannel(image, positionU(u, v), positionV(u, v), channel, decode);
  const dataValue = byte => byte / 255;
  if (output === 'luminance') {
    const channels = LUMINANCE_WEIGHTS.map((weight, channel) => ({ weight, read: at(channel, dataValue) }));
    return scalarValue((u, v) => channels.reduce((sum, { weight, read }) => sum + weight * read(u, v), 0));
  }
  if (isNumberOutput) return scalarValue(at(IMAGE_DATA_CHANNELS[output], dataValue));
  return vectorValue(at(0, srgbToLinear), at(1, srgbToLinear), at(2, srgbToLinear));
}

// Fresnel depends on the angle between the view and the surface, which a texture baked from u and v cannot hold. The
// renderers evaluate it per pixel instead, so it is accepted only as a factor of emission: {"fresnel":{"ior":1.5}} on
// its own, or in a "mul" with the rest of the emission. The graph bakes the rest; the factor travels as emissionFresnel.
function readFresnelIor(node) {
  const settings = textureSettings(node, 'fresnel', ['ior']);
  const [minimum, maximum] = EMISSION_FRESNEL_IOR_RANGE;
  const ior = settings.ior ?? 1.5;
  if (typeof ior !== 'number' || !Number.isFinite(ior) || ior < minimum || ior > maximum) {
    throw graphError(`fresnel ior must be a number from ${minimum} to ${maximum}, got ${describeKey(ior)}. Use 1.5 for glass.`);
  }
  return ior;
}

function isFresnelNode(node) {
  return isPlainObject(node) && Object.keys(node).length === 1 && Object.hasOwn(node, 'fresnel');
}

function compileFresnelOutsideEmission() {
  throw graphError('fresnel depends on the view angle and renders per pixel, so it only works as a factor of emission, such as {"emission":{"mul":[[1,0.6,0.2],{"fresnel":{"ior":1.5}}]}}.');
}

// Splits an emission node into what bakes and the fresnel IOR the renderer applies, or returns it unchanged.
function splitEmissionFresnel(node) {
  if (isFresnelNode(node)) return { base: 1, ior: readFresnelIor(node) };
  const operands = isPlainObject(node) && Object.keys(node).length === 1 ? node.mul : undefined;
  if (!Array.isArray(operands) || operands.length !== 2) return { base: node };
  const fresnelSlot = operands.findIndex(isFresnelNode);
  if (fresnelSlot < 0) return { base: node };
  return { base: operands[1 - fresnelSlot], ior: readFresnelIor(operands[fresnelSlot]) };
}

// A vertex group is mesh data, which a graph baked from u and v does not have. The host rasterizes each group a graph
// names into a weight map in UV space for one mesh (material-vertex-group-map.js) and bakes the graph with those maps, so
// the node reads its weight at the texel's own u and v. Validating a graph needs no mesh, so without maps only the name
// is checked; a pattern with the node must use uv mapping, since box mapping has no u and v to match.
const VERTEX_GROUP_COST = 120;
const VERTEX_GROUP_NAME_LIMIT = 128;

function readVertexGroupName(node) {
  const settings = textureSettings(node, 'vertexGroup', ['name']);
  const { name } = settings;
  if (typeof name !== 'string' || name === '' || name.length > VERTEX_GROUP_NAME_LIMIT) {
    throw graphError('vertexGroup needs the name of a vertex group of the mesh, such as {"vertexGroup":{"name":"edge"}}; make the group with a vertex_group mesh edit.');
  }
  return name;
}

function compileVertexGroup(node, state) {
  const name = readVertexGroupName(node);
  state.cost += VERTEX_GROUP_COST;
  if (!state.groups) return scalarValue(() => 0);
  const map = state.groups.get(name);
  if (!map) throw graphError(`vertexGroup ${describeKey(name)} was not rasterized for this mesh. Bake the material through a part whose mesh has the group.`);
  return scalarValue((u, v) => sampleImageChannel(map, u, v, 0, byte => byte / 255));
}

/** The vertex group names a graph reads with `vertexGroup` nodes, in the order they first appear. */
export function graphVertexGroupNames(graph) {
  const names = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MATERIAL_GRAPH_LIMITS.maxDepth * 3) return;
    if (!Array.isArray(value) && isPlainObject(value.vertexGroup) && typeof value.vertexGroup.name === 'string') names.add(value.vertexGroup.name);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(graph, 0);
  return [...names];
}

// A mesh map (curvature, ao, thickness) is baked per texel from the mesh by mesh-map-bake.js and handed in with the
// vertex group maps under the key "meshMap:<name>", so the node reads it at the texel's own u and v.
const MESH_MAP_COST = 120;
export const MESH_MAP_KEY_PREFIX = 'meshMap:';

function readMeshMapName(node) {
  const { name } = textureSettings(node, 'meshMap', ['name']);
  if (!MESH_MAP_NAMES.includes(name)) throw graphError(`meshMap name must be one of ${MESH_MAP_NAMES.join(', ')}, got ${describeKey(name)}, such as {"meshMap":{"name":"curvature"}}.`);
  return name;
}

function compileMeshMap(node, state) {
  const name = readMeshMapName(node);
  state.cost += MESH_MAP_COST;
  if (!state.groups) return scalarValue(() => 0);
  const map = state.groups.get(MESH_MAP_KEY_PREFIX + name);
  if (!map) throw graphError(`meshMap ${describeKey(name)} was not baked for this mesh. Bake the material through a part whose mesh has UVs.`);
  return scalarValue((u, v) => sampleImageChannel(map, u, v, 0, byte => byte / 255));
}

/** The mesh map names a graph reads with `meshMap` nodes, in the order they first appear. */
export function graphMeshMapNames(graph) {
  const names = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MATERIAL_GRAPH_LIMITS.maxDepth * 3) return;
    if (!Array.isArray(value) && isPlainObject(value.meshMap) && MESH_MAP_NAMES.includes(value.meshMap.name)) names.add(value.meshMap.name);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(graph, 0);
  return [...names];
}

// A surface node reads the slope, the up part of the normal or the height of the mesh at each texel. The host bakes
// each distinct output, space and range into UV space (material-surface-map.js) and hands the maps in under the key
// "surface:<output>|<space>|<range>", so the node reads it at the texel's own u and v.
const SURFACE_COST = 120;
export const SURFACE_KEY_PREFIX = 'surface:';
const SURFACE_EXAMPLE = '{"surface":{"output":"slope","space":"world"}}';

function readSurfaceRange(range, output) {
  if (range === undefined) return undefined;
  if (output !== 'height') throw graphError(`surface range only applies to output "height", not ${describeKey(output)}; slope and normalY are already 0 to 1.`);
  const valid = Array.isArray(range) && range.length === 2 && range.every(value => typeof value === 'number' && Number.isFinite(value)) && range[0] < range[1];
  if (!valid) throw graphError('surface range must be [low, high] in metres with low below high, such as {"surface":{"output":"height","range":[0,2]}}.');
  return [range[0], range[1]];
}

function readSurfaceSettings(node) {
  const settings = textureSettings(node, 'surface', ['output', 'space', 'range']);
  const { output } = settings;
  if (!SURFACE_OUTPUTS.includes(output)) throw graphError(`surface output must be one of ${SURFACE_OUTPUTS.join(', ')}, got ${describeKey(String(output))}, such as ${SURFACE_EXAMPLE}.`);
  const space = settings.space ?? 'world';
  if (!SURFACE_SPACES.includes(space)) throw graphError(`surface space must be one of ${SURFACE_SPACES.join(', ')}, got ${describeKey(String(space))}, such as ${SURFACE_EXAMPLE}.`);
  const range = readSurfaceRange(settings.range, output);
  return range ? { output, space, range } : { output, space };
}

/** The key a baked surface map is handed to the graph under, one per output, space and range. */
export function surfaceMapKey({ output, space, range }) {
  return `${SURFACE_KEY_PREFIX}${output}|${space}|${range ? range.join(',') : ''}`;
}

function compileSurface(node, state) {
  const settings = readSurfaceSettings(node);
  state.cost += SURFACE_COST;
  if (!state.groups) return scalarValue(() => 0);
  const map = state.groups.get(surfaceMapKey(settings));
  if (!map) throw graphError(`surface ${describeKey(settings.output)} was not baked for this mesh. Bake the material through a part whose mesh has UVs.`);
  return scalarValue((u, v) => sampleImageChannel(map, u, v, 0, byte => byte / 255));
}

/** The distinct `surface` settings a graph reads, in the order they first appear. */
export function graphSurfaceSettings(graph) {
  const found = new Map();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MATERIAL_GRAPH_LIMITS.maxDepth * 3) return;
    if (!Array.isArray(value) && isPlainObject(value.surface)) {
      const settings = readSurfaceSettings(value);
      found.set(surfaceMapKey(settings), settings);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(graph, 0);
  return [...found.values()];
}

// The imported textures of a placed asset part (#3202). The host hands them in `groups` under "base:<source map>", as it
// does for `surface`, so the node reads the scan's own base colour, roughness, metallic and normal at the texel's u and v.
export const BASE_KEY_PREFIX = 'base:';
export const BASE_OUTPUT_SOURCES = Object.freeze({ color: 'map', roughness: 'metallicRoughnessMap', metallic: 'metallicRoughnessMap', normal: 'normalMap' });
const BASE_COST = 2;
const BASE_EXAMPLE = '{"base":{"output":"color"}}';

function readBaseOutput(node) {
  const settings = textureSettings(node, 'base', ['output']);
  const output = settings.output ?? 'color';
  if (!Object.hasOwn(BASE_OUTPUT_SOURCES, output)) throw graphError(`base output must be one of ${Object.keys(BASE_OUTPUT_SOURCES).join(', ')}, got ${describeKey(String(output))}, such as ${BASE_EXAMPLE}.`);
  return output;
}

/** The key a scan's source map is handed to the graph under. */
export function baseMapKey(sourceMap) {
  return `${BASE_KEY_PREFIX}${sourceMap}`;
}

const signedByte = byte => byte / 127.5 - 1;

function compileBase(node, state) {
  const output = readBaseOutput(node);
  state.cost += BASE_COST;
  const isVector = output === 'color' || output === 'normal';
  if (!state.groups) return isVector ? vectorValue(() => 0, () => 0, () => 0) : scalarValue(() => 0);
  const sourceMap = BASE_OUTPUT_SOURCES[output];
  const map = state.groups.get(baseMapKey(sourceMap));
  if (!map) throw graphError(`base ${output} reads the ${sourceMap} of a placed asset part, and this material has none. Use base only in asset.materials[].pattern or asset.pattern, on a material that has that map.`);
  const at = (channel, decode) => (u, v) => sampleImageChannel(map, u, v, channel, decode);
  if (output === 'color') return vectorValue(at(0, srgbToLinear), at(1, srgbToLinear), at(2, srgbToLinear));
  if (output === 'normal') return vectorValue(at(0, signedByte), at(1, signedByte), at(2, signedByte));
  return scalarValue(at(output === 'roughness' ? 1 : 2, byte => byte / 255));
}

/** The distinct `base` outputs a graph reads, in the order they first appear. */
export function graphBaseOutputs(graph) {
  const found = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MATERIAL_GRAPH_LIMITS.maxDepth * 3) return;
    // A node holds exactly one operator, so the settings of a layer (which has a "base" of its own) are not a base node.
    if (!Array.isArray(value) && Object.keys(value).length === 1 && isPlainObject(value.base)) found.add(readBaseOutput(value));
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(graph, 0);
  return [...found];
}

const TEXTURE_COMPILERS = new Map([
  ['vertexGroup', compileVertexGroup],
  ['meshMap', compileMeshMap],
  ['surface', compileSurface],
  ['base', compileBase],
  ['image', compileImage], ['noise', compileNoise], ['whiteNoise', compileWhiteNoise], ['brick', compileBrick], ['voronoi', compileVoronoi], ['wave', compileWave], ['checker', compileChecker], ['gradient', compileGradient],
]);

// Shared subgraphs (#3147). A node that appears more than once in a graph (the same snow mask gating colour, roughness and
// bump) is compiled once: later copies reuse it, add nothing to the cost or the node count, and its value is kept for the
// texel being baked, so every output reads one evaluation. Equal nodes are found by hash-consing: each distinct structure
// gets one number, built from the numbers of its parts, so the walk stays linear however deep the graph nests.
const UNSHARED_STRUCTURE = -1;
const MAX_INTERNED_DEPTH = 512;

function internStructure(value, ids, interned, depth = 0) {
  const isObject = value !== null && typeof value === 'object';
  if (isObject && ids.has(value)) return ids.get(value);
  // Too deep (or a loop): leave it unshared so compiling reports the nesting error.
  if (depth > MAX_INTERNED_DEPTH) return UNSHARED_STRUCTURE;
  let signature;
  if (isObject) {
    const keys = Array.isArray(value) ? undefined : Object.keys(value);
    const parts = (keys ?? value).map(entry => internStructure(keys ? value[entry] : entry, ids, interned, depth + 1));
    if (parts.includes(UNSHARED_STRUCTURE)) return UNSHARED_STRUCTURE;
    signature = keys ? `o:${keys.map((key, index) => `${JSON.stringify(key)}:${parts[index]}`).join(',')}` : `a:${parts.join(',')}`;
  } else if (typeof value === 'number') {
    signature = Object.is(value, -0) ? 'n:-0' : `n:${value}`;
  } else {
    signature = `p:${JSON.stringify(value) ?? 'undefined'}`;
  }
  if (!interned.has(signature)) interned.set(signature, interned.size);
  const id = interned.get(signature);
  if (isObject) ids.set(value, id);
  return id;
}

// How many times each object structure is reached; a repeated structure is not walked again, so what sits inside a
// shared node is counted once.
function countRepeatedStructures(graph) {
  const ids = new Map();
  internStructure(graph, ids, new Map());
  const reached = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const id = ids.get(value);
    reached.set(id, (reached.get(id) ?? 0) + 1);
    if (reached.get(id) > 1) return;
    for (const part of Array.isArray(value) ? value : Object.values(value)) visit(part);
  };
  visit(graph);
  const repeated = new Set();
  for (const [id, count] of reached) if (count > 1) repeated.add(id);
  return { ids, repeated };
}

// Keep the value of the last texel asked for. The bake asks every output for the same texel in turn, so a node shared by
// several outputs is worked out once per texel. An exact match on (u, v) is the only reuse, so the result is the same
// number the node would give again.
function rememberLastTexel(evaluate) {
  let lastU = Number.NaN;
  let lastV = Number.NaN;
  let lastValue = 0;
  return (u, v) => {
    if (u !== lastU || v !== lastV) {
      lastValue = evaluate(u, v);
      lastU = u;
      lastV = v;
    }
    return lastValue;
  };
}

function rememberCompiled(compiled) {
  if (compiled.kind === 'scalar') return scalarValue(rememberLastTexel(compiled.evaluate));
  return vectorValue(...compiled.parts.map(rememberLastTexel));
}

function compileSharedNode(node, state, depth, field, structureId) {
  const cached = state.shared.compiled.get(structureId);
  if (cached) {
    // Compile the copy once more, apart from the totals, so it is checked at its own nesting depth.
    compileNodeAt(node, { ...state, nodeCount: 0, cost: 0, shared: undefined }, depth, field);
    return cached;
  }
  const compiled = rememberCompiled(compileNodeAt(node, state, depth, field));
  state.shared.compiled.set(structureId, compiled);
  return compiled;
}

function compileNode(node, state, depth, field) {
  const structureId = state.shared?.ids.get(node);
  if (structureId !== undefined && state.shared.repeated.has(structureId) && isPlainObject(node)) {
    return compileSharedNode(node, state, depth, field, structureId);
  }
  return compileNodeAt(node, state, depth, field);
}

// `field` names where the node sits (such as 'hue "color"'), so a missing or wrong input says which one it is (#2403).
function compileNodeAt(node, state, depth, field) {
  const compiled = compileUnpricedNode(node, state, depth, field);
  if (compiled.kind === 'vector') state.cost += VECTOR_NODE_COST;
  return compiled;
}

function compileUnpricedNode(node, state, depth, field) {
  state.nodeCount++;
  state.cost += NODE_COST;
  if (state.nodeCount > MATERIAL_GRAPH_LIMITS.maxNodes) throw graphError(`more than ${MATERIAL_GRAPH_LIMITS.maxNodes} nodes.`);
  if (depth > MATERIAL_GRAPH_LIMITS.maxDepth) throw graphError(`nesting deeper than ${MATERIAL_GRAPH_LIMITS.maxDepth}.`);
  if (typeof node === 'number') {
    if (!finiteLiteral(node)) throw graphError(`numbers must be finite and within ${MAX_LITERAL}.`);
    return scalarValue(() => node);
  }
  if (Array.isArray(node)) {
    if (node.length !== 3 || !node.every(finiteLiteral)) throw graphError('a vector literal is three finite numbers; build one from expressions with "vec".');
    const [literalX, literalY, literalZ] = node;
    return vectorValue(() => literalX, () => literalY, () => literalZ);
  }
  if (!isPlainObject(node)) {
    const where = field === undefined ? 'each node' : field;
    throw graphError(`${where} must be a number, a vector of three numbers or an object with one operator, got ${describeValue(node)}.`);
  }
  const keys = Object.keys(node);
  if (keys.length !== 1) throw graphError(`a node holds exactly one operator; got ${keys.length}.`);
  const name = keys[0];
  if (name === 'uv') return compileCoordinates(node);
  if (name === 'coord') return compileCoordinate(node, state);
  if (name === 'mapping') return compileMapping(node, state, depth);
  if (name === 'vec') return compileVector(node, state, depth);
  if (name === 'ramp') return compileRamp(node, state, depth);
  if (name === 'layer') return compileLayer(node, state, depth);
  if (name === 'hue') return compileHue(node, state, depth);
  if (name === 'curve') return compileCurve(node, state, depth);
  if (name === 'fresnel') return compileFresnelOutsideEmission();
  if (TEXTURE_COMPILERS.has(name)) return TEXTURE_COMPILERS.get(name)(node, state, depth);
  if (MATH_OPERATORS.has(name)) return compileMath(name, node, state, depth);
  throw graphError(`unknown operator ${describeKey(name)}. Use one of ${MATERIAL_GRAPH_OPERATORS.join(', ')}.`);
}

const SCALAR_OUTPUTS = ['roughness', 'metallic', 'height', 'opacity', 'clearcoat', 'transmission'];

// The bump reads the height field four times a pixel, each at a shifted spot, so a node shared with another output is worked
// out again for each read. The graph's total already holds the height once, at what it added beyond the nodes the other
// outputs share (`addedCost`); the bump pays for four standalone reads of the whole height field, plus the normalize.
function bumpExtraCost(heightNode, state, addedCost) {
  const alone = { ...state, nodeCount: 0, cost: 0, shared: undefined };
  const { ids, repeated } = countRepeatedStructures(heightNode);
  alone.shared = { ids, repeated, compiled: new Map() };
  compileNode(heightNode, alone, 0, 'output "height"');
  return BUMP_HEIGHT_READS * alone.cost - addedCost + BUMP_NORMALIZE_COST;
}

/**
 * Check a graph and compile each output. `size` is the metres one texture tile covers, which object and world coordinates report. Limits on nodes, depth and work per pixel are enforced here, before any
 * pixel is evaluated. Returns { outputs: { name: compiled }, emissionFresnel (an IOR, or undefined), nodeCount, cost }.
 */
export function compileMaterialGraph(graph, { size = 1, images, groups } = {}) {
  if (!isPlainObject(graph)) throw graphError(`graph must be an object with outputs: ${MATERIAL_GRAPH_OUTPUTS.join(', ')}.`);
  onlyKeys(graph, MATERIAL_GRAPH_OUTPUTS, 'graph');
  const names = Object.keys(graph);
  if (names.length === 0) throw graphError(`graph needs at least one output: ${MATERIAL_GRAPH_OUTPUTS.join(', ')}.`);
  const { ids, repeated } = countRepeatedStructures(graph);
  const state = { nodeCount: 0, cost: 0, size, images, groups, shared: { ids, repeated, compiled: new Map() } };
  const outputs = Object.create(null);
  let emissionFresnel;
  for (const name of MATERIAL_GRAPH_OUTPUTS) {
    if (!names.includes(name)) continue;
    let node = graph[name];
    if (name === 'emission') {
      const split = splitEmissionFresnel(node);
      node = split.base;
      emissionFresnel = split.ior;
    }
    const costBefore = state.cost;
    outputs[name] = compileNode(node, state, 0, `output "${name}"`);
    if (name === 'height') state.cost += bumpExtraCost(node, state, state.cost - costBefore);
    if (SCALAR_OUTPUTS.includes(name) && outputs[name].kind !== 'scalar') throw graphError(`${name} needs a number, not a vector.`);
  }
  return { outputs, emissionFresnel, nodeCount: state.nodeCount, cost: (state.cost + PIXEL_COST) / COST_DENOMINATOR, finestScale: state.finestScale ?? 0 };
}

/** Throw when a graph is too costly to bake at this size. Called while normalizing, so a bad scene fails at once. */
export function checkMaterialGraphWork(compiled, resolution) {
  integerInRange(resolution, 1, 16384, 'resolution');
  if (compiled.finestScale > NOISE_SCALE_LIMIT && compiled.finestScale * FINE_SCALE_MIN_PIXELS > resolution) {
    throw new RangeError(`Material graph: noise or voronoi scale ${compiled.finestScale} is too fine for a ${resolution} by ${resolution} bake; at this resolution scale allows 1 to ${Math.max(NOISE_SCALE_LIMIT, Math.floor(resolution / FINE_SCALE_MIN_PIXELS))}. Lower the scale or raise the resolution.`);
  }
  const work = compiled.cost * resolution * resolution;
  if (work > MATERIAL_GRAPH_LIMITS.maxWork) {
    throw new RangeError(`Material graph: ${compiled.cost} work units per pixel at ${resolution} by ${resolution} is ${Math.round(work).toLocaleString('en-US')} in all, over the limit of ${MATERIAL_GRAPH_LIMITS.maxWork.toLocaleString('en-US')} work units (about ${Math.round(MATERIAL_GRAPH_LIMITS.maxWork * WORK_UNIT_NANOSECONDS / 1e9 * 10) / 10} s of baking). Pass fewer or cheaper nodes, or a smaller resolution (256, 512 or 1024).`);
  }
}

/** Validate a graph and return a plain copy of it. A normalized graph normalizes to itself. */
export function normalizeMaterialGraph(graph, resolution) {
  const compiled = compileMaterialGraph(graph);
  checkMaterialGraphWork(compiled, resolution);
  return JSON.parse(JSON.stringify(graph));
}

// ---------------------------------------------------------------------------------------------------------------
// Baking. Colours are linear RGB, as recipe colours are.

function sampleChannels(compiled, u, v) {
  if (compiled.kind === 'scalar') {
    const value = finiteOrZero(compiled.evaluate(u, v));
    return [value, value, value];
  }
  return [finiteOrZero(compiled.parts[0](u, v)), finiteOrZero(compiled.parts[1](u, v)), finiteOrZero(compiled.parts[2](u, v))];
}

const unitByte = value => Math.round(clampUnit(finiteOrZero(value)) * 255);

// A mask is read from the red channel, as glTF reads clearcoatTexture and transmissionTexture.
function writeMask(data, offset, value) {
  data[offset] = unitByte(value);
  data[offset + 3] = 255;
}

function writeColor(data, offset, channels) {
  for (let channel = 0; channel < 3; channel++) data[offset + channel] = linearToSrgbByte(channels[channel]);
  data[offset + 3] = 255;
}

// The kernel worker takes plain data, so the images a graph uses arrive as { [assetId]: { width, height, data } };
// the host's own pool is a Map. Both work.
function imagePoolMap(images) {
  if (!images) return new Map();
  return images instanceof Map ? images : new Map(Object.entries(images));
}

/** The pixels a graph's image nodes read, as plain data a kernel worker can clone and the cache can hash. */
export function graphImageData(graph, pool) {
  const used = {};
  for (const asset of graphImageAssets(graph)) {
    const id = asset.toLowerCase();
    const frame = pool?.get(id);
    if (frame) used[id] = { width: frame.width, height: frame.height, data: frame.data };
  }
  return used;
}

/** Bake a normalized graph into texture descriptors, one for each output the graph has. Deterministic. */
export function bakeMaterialGraph(graph, { resolution, bump, size = 1 }, images, groups) {
  const compiled = compileMaterialGraph(graph, { size, images: imagePoolMap(images), groups: groups ? imagePoolMap(groups) : undefined });
  checkMaterialGraphWork(compiled, resolution);
  const { color, roughness, metallic, emission, height, opacity, clearcoat, transmission, aov } = compiled.outputs;
  const pixelCount = resolution * resolution;
  // Opacity travels in the alpha of the base texture, so an opacity-only graph still gets a (white) base texture.
  const colorData = color || opacity ? new Uint8ClampedArray(pixelCount * 4).fill(255) : null;
  const clearcoatData = clearcoat ? new Uint8ClampedArray(pixelCount * 4) : null;
  const transmissionData = transmission ? new Uint8ClampedArray(pixelCount * 4) : null;
  const emissionData = emission ? new Uint8ClampedArray(pixelCount * 4) : null;
  const aovData = aov ? new Uint8ClampedArray(pixelCount * 4) : null;
  const surfaceData = roughness || metallic ? new Uint8ClampedArray(pixelCount * 4) : null;
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const pixel = row * resolution + column;
      const u = (column + 0.5) / resolution;
      const v = (row + 0.5) / resolution;
      const offset = pixel * 4;
      if (color) writeColor(colorData, offset, sampleChannels(color, u, v));
      if (opacity) colorData[offset + 3] = unitByte(opacity.evaluate(u, v));
      if (clearcoat) writeMask(clearcoatData, offset, clearcoat.evaluate(u, v));
      if (transmission) writeMask(transmissionData, offset, transmission.evaluate(u, v));
      if (emission) writeColor(emissionData, offset, sampleChannels(emission, u, v));
      if (aov) {
        const channels = sampleChannels(aov, u, v);
        for (let channel = 0; channel < 3; channel++) aovData[offset + channel] = unitByte(channels[channel]);
        aovData[offset + 3] = 255;
      }
      if (surfaceData) {
        surfaceData[offset] = 255;
        surfaceData[offset + 1] = roughness ? Math.round(clampUnit(finiteOrZero(roughness.evaluate(u, v))) * 255) : 255;
        surfaceData[offset + 2] = metallic ? Math.round(clampUnit(finiteOrZero(metallic.evaluate(u, v))) * 255) : 255;
        surfaceData[offset + 3] = 255;
      }
    }
  }
  const descriptor = (data, colorSpace) => (data ? { image: createImage(data, resolution, resolution), colorSpace } : undefined);
  return {
    map: descriptor(colorData, 'srgb'),
    emissiveMap: descriptor(emissionData, 'srgb'),
    metallicRoughnessMap: descriptor(surfaceData, 'linear'),
    // The rasterizer binds clearcoatTexture from layerMaps; transmission has no layer slot, so the tracer reads transmissionMap.
    layerMaps: clearcoatData ? { clearcoatTexture: descriptor(clearcoatData, 'linear') } : undefined,
    transmissionMap: descriptor(transmissionData, 'linear'),
    aovMap: descriptor(aovData, 'linear'),
    // Not a texture: the renderers multiply the emission by Schlick's Fresnel of this IOR per pixel.
    emissionFresnel: compiled.emissionFresnel,
    normalMap: descriptor(height ? normalMapFromHeightFunction((u, v) => finiteOrZero(height.evaluate(u, v)), resolution, bump) : null, 'linear'),
  };
}
