// Facial animation for motion: blinks, named expressions and lip sync, written as morph weight tracks.
//
//   motion.face = {
//     blink: { interval: 3.5, jitter: 0.4, seed: 7 },
//     expressions: [{ time: 0, name: 'smile', weight: 0.8 }],
//     visemes: { phonemes: [{ time: 0.3, phoneme: 'HH' }, { time: 0.45, phoneme: 'AH' }] },
//   }
//
// The result is plain { kind: 'morph', id, property: 'weight', keyframes } tracks, so everything downstream (sampling,
// render jobs, GLB export) is the morph track path that already exists. Same input and seed give the same keyframes.

import { BLINK_HALF_DURATION, blinkClosure } from './blink-curve.js';

export const MAX_PHONEMES = 4096;
export const MAX_EXPRESSIONS = 64;

const DEFAULT_LAST_PHONEME_SECONDS = 0.12;
const MINIMUM_BLINK_INTERVAL = 0.5;
const FACE_FIELDS = ['rig', 'blink', 'expressions', 'definitions', 'visemes'];
const BLINK_FIELDS = ['interval', 'jitter', 'seed', 'start', 'keys'];
const EXPRESSION_FIELDS = ['time', 'name', 'weight', 'blend'];
const VISEME_FIELDS = ['phonemes', 'blend', 'coarticulation', 'map'];
const RIGS = ['auto', 'arkit', 'oculus'];

// The fifteen Oculus visemes, and the ARPAbet phonemes (and a few spelled-out rests) that drive them.
const VISEME_FOR_PHONEME = {
  sil: 'sil', rest: 'sil', pause: 'sil',
  pp: 'PP', ff: 'FF', th: 'TH', dd: 'DD', kk: 'kk', ch: 'CH', ss: 'SS', nn: 'nn', rr: 'RR', aa: 'aa', e: 'E', i: 'I', o: 'O', u: 'U',
  p: 'PP', b: 'PP', m: 'PP', f: 'FF', v: 'FF', dh: 'TH', t: 'DD', d: 'DD', k: 'kk', g: 'kk', ng: 'kk',
  jh: 'CH', sh: 'CH', zh: 'CH', s: 'SS', z: 'SS', n: 'nn', l: 'nn', r: 'RR', er: 'RR',
  ae: 'aa', ah: 'aa', ay: 'aa', ao: 'O', aw: 'O', ow: 'O', oy: 'O', eh: 'E', ey: 'E', hh: 'E',
  ih: 'I', iy: 'I', y: 'I', uh: 'U', uw: 'U', w: 'U',
};
const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'];

// Each Oculus viseme as ARKit keys, for a head that has the 52 ARKit shapes but no viseme keys.
const ARKIT_VISEMES = {
  sil: {},
  PP: { mouthClose: 0.7, mouthPressLeft: 0.5, mouthPressRight: 0.5 },
  FF: { mouthRollLower: 0.6, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.3, jawOpen: 0.1 },
  TH: { jawOpen: 0.2, tongueOut: 0.4 },
  DD: { jawOpen: 0.25, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2 },
  kk: { jawOpen: 0.3, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  CH: { mouthFunnel: 0.6, jawOpen: 0.15 },
  SS: { mouthSmileLeft: 0.3, mouthSmileRight: 0.3, jawOpen: 0.1, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  nn: { jawOpen: 0.2, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
  RR: { mouthPucker: 0.4, jawOpen: 0.2 },
  aa: { jawOpen: 0.7 },
  E: { jawOpen: 0.35, mouthSmileLeft: 0.4, mouthSmileRight: 0.4 },
  I: { jawOpen: 0.2, mouthSmileLeft: 0.5, mouthSmileRight: 0.5, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  O: { jawOpen: 0.4, mouthFunnel: 0.7 },
  U: { jawOpen: 0.15, mouthPucker: 0.8 },
};

const ARKIT_EXPRESSIONS = {
  neutral: {},
  smile: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  frown: { mouthFrownLeft: 0.8, mouthFrownRight: 0.8, browDownLeft: 0.5, browDownRight: 0.5 },
  sad: { browInnerUp: 0.8, mouthFrownLeft: 0.6, mouthFrownRight: 0.6, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
  angry: { browDownLeft: 0.9, browDownRight: 0.9, noseSneerLeft: 0.5, noseSneerRight: 0.5, mouthPressLeft: 0.5, mouthPressRight: 0.5 },
  surprised: { browInnerUp: 0.9, eyeWideLeft: 0.8, eyeWideRight: 0.8, jawOpen: 0.5 },
};

// Blink key sets in order of preference: ARKit, Mixamo-style and Ready Player Me (eyesClosed).
const BLINK_KEY_SETS = [['eyeBlinkLeft', 'eyeBlinkRight'], ['blinkLeft', 'blinkRight'], ['eyesClosed'], ['blink']];

/**
 * A key name reduced for comparing across rigs: case, separators and a viseme_ prefix go, and a trailing _L or _R
 * (the three.js face cap) reads as Left or Right.
 */
export function canonicalKeyName(name) {
  const sided = String(name).replace(/[_.\- ]([LR])$/, (_, side) => (side === 'L' ? 'Left' : 'Right'));
  return sided.toLowerCase().replace(/^.*?(?=viseme)/, '').replace(/^viseme/, '').replace(/[^a-z0-9]/g, '');
}

function faceError(path, value, expected) {
  const shown = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return new TypeError(`${path}: got ${shown}; expected ${expected}`);
}

function checkFields(object, allowed, path) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw faceError(path, object, `an object with fields ${allowed.join(', ')}`);
  for (const field of Object.keys(object)) {
    if (!allowed.includes(field)) throw faceError(`${path}.${field}`, object[field], `a field left out; ${path} takes ${allowed.join(', ')}`);
  }
}

function checkNumber(value, minimum, maximum, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw faceError(path, value, `a number from ${minimum} to ${maximum}`);
  }
  return value;
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Finds the morph target named like `wanted` among `available`. Names compare through canonicalKeyName, so eyeBlink_L,
 * eyeBlinkLeft and EYEBLINKLEFT are one key, and viseme_PP matches PP.
 */
export function resolveKeyName(wanted, available, path = 'face') {
  const target = canonicalKeyName(wanted);
  const found = available.find(name => name === wanted) ?? available.find(name => canonicalKeyName(name) === target);
  if (found === undefined) {
    const listed = available.slice(0, 24).join(', ') || 'none';
    throw new RangeError(`${path}: shape key ${JSON.stringify(wanted)} is not on this character. Keys available: ${listed}${available.length > 24 ? `, and ${available.length - 24} more` : ''}.`);
  }
  return found;
}

function findKeySet(sets, available) {
  const canonical = new Set(available.map(canonicalKeyName));
  const complete = sets.find(set => set.every(name => canonical.has(canonicalKeyName(name))));
  return complete ? complete.map(name => resolveKeyName(name, available)) : null;
}

/** The rig a character's keys belong to: Oculus viseme keys win for lip sync, ARKit keys cover the rest. */
export function detectRig(available) {
  const canonical = new Set(available.map(canonicalKeyName));
  if (VISEMES.slice(1).every(name => canonical.has(canonicalKeyName(name)))) return 'oculus';
  if (canonical.has('jawopen')) return 'arkit';
  return 'unknown';
}

// A trapezoid: weight 0 at start, `peak` from rampEnd to holdEnd, 0 again at end. Weights from several shapes on one
// key combine as their maximum, which is how a mouth that stays open across two phonemes stays open.
function trapezoid(start, rampEnd, holdEnd, end, peak) {
  return { start, rampEnd, holdEnd, end, peak };
}

function trapezoidValue(shape, time) {
  if (time <= shape.start || time >= shape.end) return 0;
  if (time < shape.rampEnd) return shape.peak * (time - shape.start) / (shape.rampEnd - shape.start);
  if (time <= shape.holdEnd) return shape.peak;
  return shape.peak * (shape.end - time) / (shape.end - shape.holdEnd);
}

function combinedValue(shapes, time) {
  let value = 0;
  for (const shape of shapes) value = Math.max(value, trapezoidValue(shape, time));
  return value;
}

/**
 * Keyframes for the maximum of several trapezoids on [0, duration]. Keys sit at every corner, and where two shapes cross
 * between corners, so linear interpolation reproduces the maximum exactly. Runs of zero keep only their ends.
 */
function keyframesFor(shapes, duration) {
  const corners = new Set([0, duration]);
  for (const shape of shapes) {
    for (const time of [shape.start, shape.rampEnd, shape.holdEnd, shape.end]) {
      if (time > 0 && time < duration) corners.add(time);
    }
  }
  const sorted = [...corners].sort((first, second) => first - second);
  const times = new Set(sorted);
  for (let index = 0; index + 1 < sorted.length; index++) {
    const before = sorted[index];
    const after = sorted[index + 1];
    const middle = (before + after) / 2;
    const leader = shapes.reduce((best, shape) => (trapezoidValue(shape, middle) > trapezoidValue(best, middle) ? shape : best), shapes[0]);
    for (const rival of shapes) {
      if (rival === leader) continue;
      const gapBefore = trapezoidValue(leader, before) - trapezoidValue(rival, before);
      const gapAfter = trapezoidValue(leader, after) - trapezoidValue(rival, after);
      if (gapBefore * gapAfter < 0) times.add(before + (after - before) * gapBefore / (gapBefore - gapAfter));
    }
  }
  const keyframes = [...times].sort((first, second) => first - second)
    .map(time => ({ time: Math.round(time * 1e6) / 1e6, value: Math.round(combinedValue(shapes, time) * 1e6) / 1e6 }));
  return keyframes.filter((key, index) => !(key.value === 0 && keyframes[index - 1]?.value === 0 && keyframes[index + 1]?.value === 0));
}

function blinkShapes(blink, duration) {
  const interval = checkNumber(blink.interval ?? 3.5, MINIMUM_BLINK_INTERVAL, 30, 'motion.face.blink.interval');
  const jitter = checkNumber(blink.jitter ?? 0.3, 0, 1, 'motion.face.blink.jitter');
  const seed = checkNumber(blink.seed ?? 1, 0, 4294967295, 'motion.face.blink.seed');
  if (!Number.isInteger(seed)) throw faceError('motion.face.blink.seed', seed, 'a whole number such as 7');
  const start = checkNumber(blink.start ?? Math.min(interval, duration) / 2, 0, duration, 'motion.face.blink.start');
  const random = createRandom(seed);
  const shapes = [];
  let middle = start;
  while (middle - BLINK_HALF_DURATION < duration) {
    shapes.push({ middle });
    middle += Math.max(interval * (1 + jitter * (2 * random() - 1)), 2 * BLINK_HALF_DURATION + 0.01);
  }
  return shapes;
}

function blinkKeyframes(blinks, duration) {
  const corners = [0, duration];
  for (const { middle } of blinks) {
    for (const fraction of [-1, -0.5, 0, 0.5, 1]) corners.push(middle + fraction * BLINK_HALF_DURATION);
  }
  const times = [...new Set(corners.filter(time => time >= 0 && time <= duration))].sort((first, second) => first - second);
  const value = time => blinks.reduce((closure, { middle }) => Math.max(closure, blinkClosure(time - middle)), 0);
  const keyframes = times.map(time => ({ time: Math.round(time * 1e6) / 1e6, value: Math.round(value(time) * 1e6) / 1e6 }));
  return keyframes.filter((key, index) => !(key.value === 0 && keyframes[index - 1]?.value === 0 && keyframes[index + 1]?.value === 0));
}

function expressionShapes(entries, definitions, available, duration) {
  if (!Array.isArray(entries) || entries.length > MAX_EXPRESSIONS) {
    throw faceError('motion.face.expressions', Array.isArray(entries) ? `${entries.length} entries` : entries, `an array of at most ${MAX_EXPRESSIONS} entries such as [{ "time": 0, "name": "smile" }]`);
  }
  const perKey = new Map();
  const times = entries.map(entry => entry?.time);
  entries.forEach((entry, index) => {
    const path = `motion.face.expressions[${index}]`;
    checkFields(entry, EXPRESSION_FIELDS, path);
    checkNumber(entry.time, 0, duration, `${path}.time`);
    if (times.indexOf(entry.time) !== index) throw faceError(`${path}.time`, entry.time, 'distinct times');
    if (!Object.hasOwn(definitions, entry.name)) {
      throw faceError(`${path}.name`, entry.name, `one of ${Object.keys(definitions).join(', ')}, or a name added under motion.face.definitions`);
    }
    const scale = checkNumber(entry.weight ?? 1, 0, 1, `${path}.weight`);
    const blend = checkNumber(entry.blend ?? 0.2, 0.01, 5, `${path}.blend`);
    const following = entries.map(other => other.time).filter(time => time > entry.time).sort((first, second) => first - second)[0];
    const end = following ?? duration;
    // The expression fades out as the next one fades in; the last one holds to the end of the motion.
    const rampEnd = Math.min(entry.time + blend, (entry.time + end) / 2);
    const tail = end + blend;
    for (const [keyName, weight] of Object.entries(definitions[entry.name])) {
      const resolved = resolveKeyName(keyName, available, `${path}.name ${JSON.stringify(entry.name)}`);
      if (!perKey.has(resolved)) perKey.set(resolved, []);
      perKey.get(resolved).push(trapezoid(entry.time, rampEnd, end, tail, scale * weight));
    }
  });
  return perKey;
}

function phonemeEntries(phonemes) {
  if (!Array.isArray(phonemes) || !phonemes.length || phonemes.length > MAX_PHONEMES) {
    throw faceError('motion.face.visemes.phonemes', Array.isArray(phonemes) ? `${phonemes.length} entries` : phonemes, `an array of 1 to ${MAX_PHONEMES} entries such as [{ "time": 0.3, "phoneme": "AH" }]`);
  }
  let previous = -Infinity;
  return phonemes.map((entry, index) => {
    const path = `motion.face.visemes.phonemes[${index}]`;
    checkFields(entry, ['time', 'phoneme'], path);
    checkNumber(entry.time, 0, 30, `${path}.time`);
    if (entry.time <= previous) throw faceError(`${path}.time`, entry.time, `a time after ${previous}, since phonemes are listed in time order`);
    previous = entry.time;
    const viseme = typeof entry.phoneme === 'string' ? VISEME_FOR_PHONEME[entry.phoneme.toLowerCase()] : undefined;
    if (viseme === undefined) {
      throw faceError(`${path}.phoneme`, entry.phoneme, `an ARPAbet phoneme such as AH, M or SH, or an Oculus viseme: ${VISEMES.join(', ')}`);
    }
    return { time: entry.time, viseme };
  });
}

function visemeKeyWeights(viseme, rig, overrides) {
  if (overrides && Object.hasOwn(overrides, viseme)) return overrides[viseme];
  if (rig === 'oculus') return viseme === 'sil' ? {} : { [viseme]: 1 };
  return ARKIT_VISEMES[viseme];
}

function visemeShapes(visemes, rig, available, duration) {
  checkFields(visemes, VISEME_FIELDS, 'motion.face.visemes');
  const blend = checkNumber(visemes.blend ?? 0.06, 0.005, 1, 'motion.face.visemes.blend');
  const coarticulation = checkNumber(visemes.coarticulation ?? 0.5, 0, 1, 'motion.face.visemes.coarticulation');
  const entries = phonemeEntries(visemes.phonemes);
  const perKey = new Map();
  entries.forEach((entry, index) => {
    const following = entries[index + 1]?.time ?? entry.time + DEFAULT_LAST_PHONEME_SECONDS;
    const span = following - entry.time;
    // A short phoneme peaks lower instead of overshooting, and coarticulation starts and ends the shape early and late
    // so neighbours overlap and the mouth glides between them instead of snapping.
    const ramp = Math.min(blend, span / 2);
    const peak = Math.min(1, span / (2 * blend));
    const reach = blend * coarticulation;
    const weights = visemeKeyWeights(entry.viseme, rig, visemes.map);
    for (const [keyName, weight] of Object.entries(weights)) {
      const resolved = resolveKeyName(keyName, available, `motion.face.visemes (viseme ${entry.viseme})`);
      if (!perKey.has(resolved)) perKey.set(resolved, []);
      perKey.get(resolved).push(trapezoid(entry.time - reach, entry.time + ramp, Math.max(entry.time + ramp, following - ramp), following + reach, peak * weight));
    }
  });
  return perKey;
}

function checkMap(map) {
  if (map === undefined) return;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw faceError('motion.face.visemes.map', map, 'an object from viseme to { key: weight }');
  for (const [viseme, weights] of Object.entries(map)) {
    if (!VISEMES.includes(viseme)) throw faceError(`motion.face.visemes.map.${viseme}`, viseme, `one of ${VISEMES.join(', ')}`);
    checkWeights(weights, `motion.face.visemes.map.${viseme}`);
  }
}

function checkWeights(weights, path) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw faceError(path, weights, 'an object from shape key name to a weight from 0 to 1');
  for (const [key, weight] of Object.entries(weights)) checkNumber(weight, 0, 1, `${path}.${key}`);
}

function mergeInto(target, source) {
  for (const [key, shapes] of source) {
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(...shapes);
  }
}

/**
 * Expand motion.face into morph tracks. `morphTargets` are the shape key names of the character; `duration` is the
 * motion's length. Throws, naming the missing key and the keys there are, when a character lacks a key.
 * Tracks come out in key-name order, so the same face gives the same tracks every time.
 */
export function faceTracks(face, { morphTargets, duration }) {
  checkFields(face, FACE_FIELDS, 'motion.face');
  const available = [...morphTargets];
  if (!available.length) throw new RangeError('motion.face: this recipe has no shape keys to animate. Add geometry shapeKeys, or place an asset with morph targets such as ARKit blendshapes.');
  if (face.rig !== undefined && !RIGS.includes(face.rig)) throw faceError('motion.face.rig', face.rig, `one of ${RIGS.join(', ')}`);
  const rig = face.rig === undefined || face.rig === 'auto' ? detectRig(available) : face.rig;
  const definitions = { ...ARKIT_EXPRESSIONS };
  if (face.definitions !== undefined) {
    const names = Object.keys(face.definitions ?? {});
    if (names.length > MAX_EXPRESSIONS) throw faceError('motion.face.definitions', `${names.length} names`, `at most ${MAX_EXPRESSIONS} expression names`);
    for (const name of names) {
      checkWeights(face.definitions[name], `motion.face.definitions.${name}`);
      definitions[name] = face.definitions[name];
    }
  }
  const shapesByKey = new Map();
  const blinkTracks = new Map();
  if (face.blink !== undefined) {
    checkFields(face.blink, BLINK_FIELDS, 'motion.face.blink');
    const blinks = blinkShapes(face.blink, duration);
    if (face.blink.keys !== undefined && (!Array.isArray(face.blink.keys) || !face.blink.keys.length || face.blink.keys.length > 8)) {
      throw faceError('motion.face.blink.keys', face.blink.keys, 'an array of 1 to 8 shape key names such as ["eyeBlinkLeft", "eyeBlinkRight"]');
    }
    const keys = face.blink.keys === undefined
      ? findKeySet(BLINK_KEY_SETS, available)
      : face.blink.keys.map(name => resolveKeyName(name, available, 'motion.face.blink.keys'));
    if (!keys) {
      throw new RangeError(`motion.face.blink: no blink shape keys found (looked for eyeBlinkLeft and eyeBlinkRight, blinkLeft and blinkRight, eyesClosed, blink). Name them with blink.keys. Keys available: ${available.slice(0, 24).join(', ')}.`);
    }
    const keyframes = blinkKeyframes(blinks, duration);
    for (const key of keys) blinkTracks.set(key, keyframes);
  }
  if (face.expressions !== undefined) mergeInto(shapesByKey, expressionShapes(face.expressions, definitions, available, duration));
  if (face.visemes !== undefined) {
    checkFields(face.visemes, VISEME_FIELDS, 'motion.face.visemes');
    checkMap(face.visemes.map);
    if (rig === 'unknown' && face.visemes.map === undefined) {
      throw new RangeError(`motion.face.visemes: this character has neither Oculus viseme keys (viseme_PP ...) nor ARKit keys (jawOpen ...). Give visemes.map such as { "aa": { "MouthOpen": 1 } }. Keys available: ${available.slice(0, 24).join(', ')}.`);
    }
    mergeInto(shapesByKey, visemeShapes(face.visemes, rig, available, duration));
  }
  const tracks = [];
  const keysInOrder = [...new Set([...blinkTracks.keys(), ...shapesByKey.keys()])].sort();
  for (const key of keysInOrder) {
    const shapes = shapesByKey.get(key);
    let keyframes;
    if (blinkTracks.has(key) && !shapes) keyframes = blinkTracks.get(key);
    else if (!blinkTracks.has(key)) keyframes = keyframesFor(shapes, duration);
    else keyframes = mergeKeyframes(blinkTracks.get(key), keyframesFor(shapes, duration));
    tracks.push({ kind: 'morph', id: key, property: 'weight', interpolation: 'LINEAR', keyframes });
  }
  return tracks;
}

// Blink on a key an expression or viseme also moves: the larger of the two at every key time of either.
function mergeKeyframes(first, second) {
  const at = (keyframes, time) => {
    const index = keyframes.findIndex(key => key.time >= time);
    if (index < 0) return keyframes[keyframes.length - 1].value;
    if (keyframes[index].time === time || index === 0) return keyframes[index].value;
    const before = keyframes[index - 1];
    return before.value + (keyframes[index].value - before.value) * (time - before.time) / (keyframes[index].time - before.time);
  };
  const times = [...new Set([...first, ...second].map(key => key.time))].sort((earlier, later) => earlier - later);
  return times.map(time => ({ time, value: Math.max(at(first, time), at(second, time)) }));
}
