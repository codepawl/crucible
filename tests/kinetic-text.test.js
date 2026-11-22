import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { text } from '../src/text-geometry.js';
import { splitText, staggerNodeTracks, staggerRanks, STAGGER_ORDERS } from '../src/kinetic-text.js';

const TOLERANCE = 1e-5;
const RISE = [{ time: 0, value: [0, -1, 0] }, { time: 0.4, value: [0, 0, 0] }];

function pieceGeometry(split, geometryId) {
  const geometry = split.geometries.find(candidate => candidate.id === geometryId);
  return text(geometry.text, { size: geometry.size, depth: geometry.depth, curveSegments: geometry.curveSegments, align: geometry.align });
}

/** Every vertex of the pieces in reading order, each moved by its node translation. */
function piecePositions(split) {
  const positions = [];
  for (const node of split.nodes) {
    const mesh = pieceGeometry(split, node.geometry);
    for (let index = 0; index < mesh.positions.length; index += 3) {
      positions.push(mesh.positions[index] + node.translation[0], mesh.positions[index + 1] + node.translation[1], mesh.positions[index + 2] + node.translation[2]);
    }
  }
  return positions;
}

function assertSameAsUnsplit(content, options, split) {
  const whole = text(content, options);
  const pieces = piecePositions(split);
  assert.equal(pieces.length, whole.positions.length, 'the pieces hold the same vertices as the whole text');
  pieces.forEach((value, index) => assert.ok(Math.abs(value - whole.positions[index]) < TOLERANCE, `vertex value ${index}: ${value} vs ${whole.positions[index]}`));
}

test('splitText makes one node per letter or word and none for spaces or line breaks', () => {
  assert.equal(splitText('Hello', { split: 'letters' }).nodes.length, 5);
  assert.equal(splitText('Hello world', { split: 'letters' }).nodes.length, 10);
  assert.equal(splitText('Hello world', { split: 'words' }).nodes.length, 2);
  assert.equal(splitText('ab cd\nef', { split: 'words' }).nodes.length, 3);
  assert.equal(splitText('ab cd\nef', { split: 'letters' }).nodes.length, 6);
  assert.equal(splitText('one  two', { split: 'words' }).nodes.length, 2);
  assert.deepEqual(splitText('ab cd\nef', { split: 'words' }).pieces.map(piece => [piece.text, piece.line]), [['ab', 0], ['cd', 0], ['ef', 1]]);
});

test('splitText letters is the default, ids follow reading order, and repeated letters share a geometry', () => {
  const split = splitText('Hello', { id: 'title' });
  assert.deepEqual(split.nodes.map(node => node.id), ['title-0', 'title-1', 'title-2', 'title-3', 'title-4']);
  assert.equal(split.geometries.length, 4);
  assert.equal(split.nodes[2].geometry, split.nodes[3].geometry);
  assert.deepEqual(split.geometries.map(geometry => geometry.text), ['H', 'e', 'l', 'o']);
});

test('the pieces sit exactly where the unsplit text puts them', () => {
  const cases = [
    ['Hello', { split: 'letters' }],
    ['Hello world', { split: 'words', size: 0.5, depth: 0.1 }],
    ['Crucible\nMotion', { split: 'letters', align: 'center' }],
    ['ab cd\nefg h', { split: 'words', align: 'right', curveSegments: 2 }],
  ];
  for (const [content, options] of cases) {
    const { split, ...textOptions } = options;
    assertSameAsUnsplit(content, textOptions, splitText(content, { ...textOptions, split }));
  }
});

test('splitText adds the translation, material and parent to every node and is deterministic', () => {
  const options = { id: 'title', split: 'words', material: 'gold', parent: 'rig', translation: [1, 2, 3] };
  const split = splitText('Hi you', options);
  assert.ok(split.nodes.every(node => node.material === 'gold' && node.parent === 'rig'));
  assert.equal(split.nodes[0].translation[0], 1);
  assert.equal(split.nodes[0].translation[2], 3);
  assert.deepEqual(splitText('Hi you', options), split);
});

test('splitText says what to pass for a bad split, id, text or size', () => {
  assert.throws(() => splitText('Hi', { split: 'chars' }), /split must be one of letters, words/);
  assert.throws(() => splitText('Hi', { id: '' }), /id must be 1 to 101/);
  assert.throws(() => splitText('   ', {}), /no visible characters to split/);
  assert.throws(() => splitText('Hi', { translation: [0, 0] }), /three finite numbers/);
  assert.throws(() => splitText('a'.repeat(129), {}), /at most 128 pieces.*words/);
  assert.throws(() => splitText('Hi', { align: 'middle' }), /align must be one of/);
  assert.throws(() => splitText('Hi', { font: 'missing' }), /Unknown font/);
});

test('stagger start times follow the order, with the middle pair of an even count together', () => {
  const nodes = splitText('ABCDE').nodes;
  const delays = order => staggerNodeTracks(nodes, { property: 'translation', keyframes: RISE, offset: 0.1, order }).delays;
  assert.deepEqual(delays('forward'), [0, 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(delays('reverse'), [0.4, 0.3, 0.2, 0.1, 0]);
  assert.deepEqual(delays('center'), [0.2, 0.1, 0, 0.1, 0.2]);
  assert.deepEqual(staggerRanks(4, 'center'), [1, 0, 0, 1]);
  assert.deepEqual(staggerRanks(1, 'center'), [0]);
});

test('random order is a seeded permutation: the same seed repeats and another seed differs', () => {
  const first = staggerRanks(12, 'random', 7);
  assert.deepEqual(first, staggerRanks(12, 'random', 7));
  assert.deepEqual([...first].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
  assert.notDeepEqual(first, staggerRanks(12, 'random', 8));
  assert.notDeepEqual(first, staggerRanks(12, 'forward'));
  assert.deepEqual(STAGGER_ORDERS, ['forward', 'reverse', 'center', 'random']);
});

test('an easing curve spreads the start times between the first and the last node', () => {
  const nodes = splitText('ABCDE').nodes;
  const { delays } = staggerNodeTracks(nodes, { property: 'scale', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 0.2, value: [1, 1, 1] }], offset: 0.1, easing: 'easeInQuad' });
  assert.deepEqual(delays, [0, 0.025, 0.1, 0.225, 0.4]);
  assert.throws(() => staggerNodeTracks(nodes, { property: 'scale', keyframes: [{ time: 0, value: [1, 1, 1] }], offset: 0.1, easing: 'bouncy' }), /easing|bouncy/i);
});

test('a staggered track starts at its delay, holds its first pose before it and measures the motion duration', () => {
  const nodes = splitText('ABC', { id: 'title' }).nodes;
  const { tracks, duration } = staggerNodeTracks(nodes, { property: 'translation', keyframes: RISE, offset: 0.25 });
  assert.deepEqual(tracks[0].keyframes.map(keyframe => keyframe.time), [0, 0.4]);
  assert.deepEqual(tracks[2].keyframes.map(keyframe => keyframe.time), [0, 0.5, 0.9]);
  assert.equal(tracks[2].keyframes[0].value[1], nodes[2].translation[1] - 1);
  assert.deepEqual(tracks.map(track => [track.kind, track.id, track.property]), nodes.map(node => ['node', node.id, 'translation']));
  assert.equal(duration, 0.9);
});

test('keyframe easings pass through unchanged', () => {
  const nodes = splitText('AB').nodes;
  const keyframes = [{ time: 0, value: [0, -1, 0], easing: 'easeOutBack' }, { time: 0.4, value: [0, 0, 0] }];
  const { tracks } = staggerNodeTracks(nodes, { property: 'translation', keyframes, offset: 0.1 });
  assert.equal(tracks[1].keyframes.find(keyframe => keyframe.time === 0.1).easing, 'easeOutBack');
});

test('staggerNodeTracks says what to pass for bad input and for the motion limits', () => {
  const nodes = splitText('AB', { id: 'title' }).nodes;
  const valid = { property: 'translation', keyframes: RISE, offset: 0.1 };
  assert.throws(() => staggerNodeTracks([], valid), /at least one node/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, property: 'glow' }), /property must be one of translation, rotation, scale, visible, opacity/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, offset: -1 }), /offset must be a finite number of seconds from 0/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, order: 'spiral' }), /order must be one of forward, reverse, center, random/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, seed: 1.5 }), /seed/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, keyframes: [] }), /at least one entry/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, keyframes: [{ time: 1, value: [0, 0, 0] }, { time: 1, value: [0, 0, 0] }] }), /later than the keyframe before/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, keyframes: [{ time: 0, value: [0, 0] }] }), /array of 3 finite numbers/);
  assert.throws(() => staggerNodeTracks([nodes[0], nodes[0]], valid), /repeats an earlier node/);
  assert.throws(() => staggerNodeTracks(nodes, { ...valid, offset: 40 }), /lasts at most 30/);
  const many = Array.from({ length: 129 }, (_, index) => ({ id: `n${index}` }));
  assert.throws(() => staggerNodeTracks(many, valid), /at most 128 nodes/);
  const long = Array.from({ length: 20 },(_, index) => ({ time: index, value: [0, 0, 0] }));
  const tens = Array.from({ length: 128 }, (_, index) => ({ id: `n${index}` }));
  assert.throws(() => staggerNodeTracks(tens, { property: 'translation', keyframes: long, offset: 0 }), /a motion holds at most 2048/);
});

function titleScene(order) {
  const title = splitText('Hi', { id: 'title', split: 'letters', material: 'gold', translation: [0, 0, 0] });
  const { tracks, duration } = staggerNodeTracks(title.nodes, { property: 'translation', keyframes: RISE, offset: 0.5, order });
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: title.geometries,
    materials: [{ id: 'gold', color: [0.9, 0.7, 0.2], metallic: 1, roughness: 0.3 }],
    nodes: title.nodes,
    motion: { duration, tracks },
  });
  return { scene, title };
}

function partTranslation(scene, id) {
  const part = scene.parts.find(candidate => candidate.name === id);
  return [part.matrix[12], part.matrix[13], part.matrix[14]];
}

test('a recipe plays the stagger: a late letter holds low, rises later, and ends at its rest position', () => {
  const { scene, title } = titleScene('forward');
  const [first, second] = title.nodes;
  scene.sampleMotion(0);
  assert.ok(Math.abs(partTranslation(scene, first.id)[1] - (first.translation[1] - 1)) < TOLERANCE);
  assert.ok(Math.abs(partTranslation(scene, second.id)[1] - (second.translation[1] - 1)) < TOLERANCE, 'the second letter holds its first pose at time 0');
  scene.sampleMotion(0.4);
  assert.ok(Math.abs(partTranslation(scene, first.id)[1] - first.translation[1]) < TOLERANCE);
  assert.ok(Math.abs(partTranslation(scene, second.id)[1] - (second.translation[1] - 1)) < TOLERANCE, 'the second letter has not started at 0.4 s');
  scene.sampleMotion(0.9);
  assert.ok(Math.abs(partTranslation(scene, second.id)[0] - second.translation[0]) < TOLERANCE, 'the offset keeps the letter at its x');
  assert.ok(Math.abs(partTranslation(scene, second.id)[1] - second.translation[1]) < TOLERANCE);
});

test('reverse order starts the last letter first in a played scene', () => {
  const { scene, title } = titleScene('reverse');
  const [first, last] = title.nodes;
  scene.sampleMotion(0.4);
  assert.ok(Math.abs(partTranslation(scene, last.id)[1] - last.translation[1]) < TOLERANCE);
  assert.ok(Math.abs(partTranslation(scene, first.id)[1] - (first.translation[1] - 1)) < TOLERANCE);
});
