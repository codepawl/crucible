// Stagger: one node track copied across many nodes, each starting a little after the one before. Pure data in, motion tracks out.
import { easedProgress, normalizeKeyframeEasing } from './easing.js';
import { requireWholeSeed, seededRandom } from './seeded-random.js';

export const STAGGER_ORDERS = Object.freeze(['forward', 'reverse', 'center', 'random']);
const STAGGER_PROPERTIES = Object.freeze(['translation', 'rotation', 'scale', 'visible', 'opacity']);
const PROPERTY_SIZES = { translation: 3, rotation: 4, scale: 3, visible: 1, opacity: 1 };
const MAX_STAGGER_NODES = 128;
const MAX_TOTAL_KEYFRAMES = 2048;
const MIN_MOTION_DURATION = 0.1;
const MAX_MOTION_DURATION = 30;
const TIME_DECIMALS = 1e6;
const RANDOM_CHANNEL = 2891;

function roundTime(seconds) {
  return Math.round(seconds * TIME_DECIMALS) / TIME_DECIMALS;
}

function checkKeyframes(keyframes, property) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) throw new TypeError('keyframes must be a list of { time, value } with at least one entry, such as [{ "time": 0, "value": [0, -1, 0] }, { "time": 0.5, "value": [0, 0, 0] }].');
  const size = PROPERTY_SIZES[property];
  let previousTime = -Infinity;
  keyframes.forEach((keyframe, index) => {
    if (!Number.isFinite(keyframe?.time) || keyframe.time < 0) throw new RangeError(`keyframes[${index}].time must be a finite number of seconds from 0, such as 0.5.`);
    if (keyframe.time <= previousTime) throw new RangeError(`keyframes[${index}].time must be later than the keyframe before it (${previousTime}): list the keyframes in time order with distinct times.`);
    previousTime = keyframe.time;
    const valid = size === 1 ? Number.isFinite(keyframe.value) : Array.isArray(keyframe.value) && keyframe.value.length === size && keyframe.value.every(Number.isFinite);
    if (valid && property === 'opacity' && (keyframe.value < 0 || keyframe.value > 1)) throw new RangeError(`keyframes[${index}].value must be an opacity from 0 (clear) to 1 (opaque), such as 0.5, and this is ${keyframe.value}.`);
    if (!valid) throw new TypeError(`keyframes[${index}].value must be ${size === 1 ? 'a finite number, such as 1' : `an array of ${size} finite numbers`} for a ${property} track.`);
  });
}

/** The rank of each node in the order: 0 starts first. The two middle nodes of an even count share rank 0 in the center order. */
export function staggerRanks(count, order, seed = 0) {
  const indices = Array.from({ length: count }, (_, index) => index);
  if (order === 'forward') return indices;
  if (order === 'reverse') return indices.map(index => count - 1 - index);
  if (order === 'center') {
    const distances = indices.map(index => Math.abs(index - (count - 1) / 2));
    const distinct = [...new Set(distances)].sort((first, second) => first - second);
    return distances.map(distance => distinct.indexOf(distance));
  }
  const shuffled = [...indices].sort((first, second) => seededRandom(first, RANDOM_CHANNEL, seed) - seededRandom(second, RANDOM_CHANNEL, seed) || first - second);
  const ranks = new Array(count);
  shuffled.forEach((index, rank) => {
    ranks[index] = rank;
  });
  return ranks;
}

function startDelay(rank, count, offset, easing) {
  if (easing === 'linear' || count < 2) return rank * offset;
  const spread = (count - 1) * offset;
  return Math.max(0, easedProgress({ easing }, rank / (count - 1)) * spread);
}

function shiftedKeyframes(keyframes, delay, property, restTranslation) {
  const shifted = keyframes.map(keyframe => {
    const copy = { ...keyframe, time: roundTime(keyframe.time + delay) };
    if (property === 'translation') copy.value = keyframe.value.map((offset, axis) => offset + restTranslation[axis]);
    return copy;
  });
  // Before its start a node holds its first pose, so a late letter waits there instead of sitting at its rest pose.
  if (shifted[0].time > 0) shifted.unshift({ time: 0, value: shifted[0].value });
  return shifted;
}

/**
 * One node track for each node, the same keyframes starting `offset` seconds apart: `{ tracks, duration, delays }`. Put `tracks` in
 * `motion.tracks` and use `duration` (or more) as `motion.duration`.
 *
 * `nodes` are `{ id, translation? }`, such as the `nodes` of `splitText`. Translation keyframes are offsets from each node's own
 * translation; rotation, scale, visible and opacity (0 to 1) keyframes are the values themselves. `order` is forward, reverse, center (middle first;
 * the two middle nodes of an even count start together) or random (seeded). `easing` spreads the start times between the first
 * and the last node, as in the keyframe easings: linear starts each node `offset` after the one before.
 */
export function staggerNodeTracks(nodes, { property, keyframes, offset, order = 'forward', seed = 0, easing = 'linear' } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new TypeError('nodes must be a list of { id } with at least one node, such as the nodes splitText returns.');
  if (nodes.length > MAX_STAGGER_NODES) throw new RangeError(`A stagger has at most ${MAX_STAGGER_NODES} nodes (one motion holds 128 tracks) and this has ${nodes.length}: stagger fewer nodes, such as the words of the text.`);
  if (!STAGGER_PROPERTIES.includes(property)) throw new RangeError(`property must be one of ${STAGGER_PROPERTIES.join(', ')}, such as "translation".`);
  if (!Number.isFinite(offset) || offset < 0) throw new RangeError('offset must be a finite number of seconds from 0, such as 0.06.');
  if (!STAGGER_ORDERS.includes(order)) throw new RangeError(`order must be one of ${STAGGER_ORDERS.join(', ')}, such as "forward".`);
  requireWholeSeed(seed, 'seed');
  if (typeof easing !== 'string') throw new TypeError('easing must be a string, such as "linear" or "easeOutCubic".');
  normalizeKeyframeEasing({ easing });
  checkKeyframes(keyframes, property);
  const seenIds = new Set();
  nodes.forEach((node, index) => {
    if (typeof node?.id !== 'string' || node.id.length === 0) throw new TypeError(`nodes[${index}].id must be a node id string, such as "title-0".`);
    if (seenIds.has(node.id)) throw new RangeError(`nodes[${index}].id "${node.id}" repeats an earlier node: a motion holds one track per node and property.`);
    seenIds.add(node.id);
  });
  const ranks = staggerRanks(nodes.length, order, seed);
  const delays = ranks.map(rank => roundTime(startDelay(rank, nodes.length, offset, easing)));
  const tracks = nodes.map((node, index) => ({
    kind: 'node', id: node.id, property,
    keyframes: shiftedKeyframes(keyframes, delays[index], property, node.translation ?? [0, 0, 0]),
  }));
  const keyframeTotal = tracks.reduce((total, track) => total + track.keyframes.length, 0);
  if (keyframeTotal > MAX_TOTAL_KEYFRAMES) throw new RangeError(`This makes ${keyframeTotal} keyframes (a node that starts late gets one more, to hold its first pose) and a motion holds at most ${MAX_TOTAL_KEYFRAMES}: use fewer nodes or fewer keyframes.`);
  const duration = Math.max(MIN_MOTION_DURATION, Math.ceil(Math.max(...tracks.map(track => track.keyframes.at(-1).time)) * 1000) / 1000);
  if (duration > MAX_MOTION_DURATION) throw new RangeError(`The stagger lasts ${duration} seconds and a motion lasts at most ${MAX_MOTION_DURATION}: lower offset or the keyframe times.`);
  return { tracks, duration, delays };
}
