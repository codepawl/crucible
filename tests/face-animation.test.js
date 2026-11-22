import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { MAX_EXPRESSIONS, MAX_PHONEMES, canonicalKeyName, detectRig, faceTracks } from '../src/face-animation.js';
import { blinkClosure } from '../src/blink-curve.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { FACE_TARGETS, MIXAMO_LIKE, humanoidGlb, humanoidJoints } from './fixtures/humanoid-glb.js';

const OCULUS_KEYS = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'].map(name => `viseme_${name}`);
const FACE_CAP_KEYS = ['browInnerUp', 'eyeBlink_L', 'eyeBlink_R', 'eyeWide_L', 'eyeWide_R', 'jawOpen', 'mouthSmile_L', 'mouthSmile_R', 'cheekSquint_L', 'cheekSquint_R', 'mouthFunnel', 'mouthClose'];

function weightAt(track, time) {
  const keys = track.keyframes;
  if (time <= keys[0].time) return keys[0].value;
  for (let index = 1; index < keys.length; index++) {
    if (time <= keys[index].time) {
      const before = keys[index - 1];
      return before.value + (keys[index].value - before.value) * (time - before.time) / (keys[index].time - before.time);
    }
  }
  return keys[keys.length - 1].value;
}

const trackOf = (tracks, id) => tracks.find(track => track.id === id);

test('blinkClosure is the closure curve the film rig used', () => {
  for (const offset of [-0.2, -0.13, -0.1, -0.05, 0, 0.03, 0.12, 0.13, 0.4]) {
    const phase = Math.abs(offset) / 0.13;
    const expected = phase < 1 ? Math.cos(phase * Math.PI / 2) ** 2 : 0;
    assert.equal(blinkClosure(offset), expected);
  }
});

test('key names match across ARKit, Oculus and the three.js face cap spellings', () => {
  assert.equal(canonicalKeyName('eyeBlink_L'), canonicalKeyName('eyeBlinkLeft'));
  assert.equal(canonicalKeyName('mouthSmile_R'), canonicalKeyName('MouthSmileRight'));
  assert.equal(canonicalKeyName('viseme_PP'), canonicalKeyName('PP'));
  assert.equal(canonicalKeyName('Blink_Left'), canonicalKeyName('blinkLeft'));
  assert.equal(detectRig(OCULUS_KEYS), 'oculus');
  assert.equal(detectRig(FACE_CAP_KEYS), 'arkit');
  assert.equal(detectRig(['a', 'b']), 'unknown');
});

test('blink keyframes are identical for one seed, differ for another, and keep their timing', () => {
  const face = { blink: { interval: 2, jitter: 0.4, seed: 11 } };
  const first = faceTracks(face, { morphTargets: FACE_CAP_KEYS, duration: 12 });
  const again = faceTracks(structuredClone(face), { morphTargets: [...FACE_CAP_KEYS], duration: 12 });
  assert.equal(JSON.stringify(first), JSON.stringify(again), 'the same seed gives the same bytes');
  const other = faceTracks({ blink: { interval: 2, jitter: 0.4, seed: 12 } }, { morphTargets: FACE_CAP_KEYS, duration: 12 });
  assert.notEqual(JSON.stringify(first), JSON.stringify(other));
  assert.deepEqual(first.map(track => track.id), ['eyeBlink_L', 'eyeBlink_R'], 'both lids blink, in key order');
  assert.deepEqual(first[0].keyframes, first[1].keyframes);
  const keys = first[0].keyframes;
  assert.ok(keys.every(key => key.time >= 0 && key.time <= 12 && key.value >= 0 && key.value <= 1));
  assert.equal(keys.filter(key => key.value === 1).length >= 5, true, 'a 12 s motion at a 2 s interval blinks about 6 times');
  assert.equal(weightAt(first[0], 0), 0);
});

test('with no jitter blinks are one interval apart and peak mid blink', () => {
  const [track] = faceTracks({ blink: { interval: 3, jitter: 0, start: 1, keys: ['jawOpen'] } }, { morphTargets: FACE_CAP_KEYS, duration: 8 });
  const peaks = track.keyframes.filter(key => key.value === 1).map(key => key.time);
  assert.deepEqual(peaks, [1, 4, 7]);
  assert.equal(weightAt(track, 1 - 0.13), 0);
  assert.ok(Math.abs(weightAt(track, 1 + 0.065) - blinkClosure(0.065)) < 1e-9);
});

test('blink spacing stays inside interval plus or minus jitter and is not constant', () => {
  const interval = 1.4;
  const jitter = 0.3;
  const [track] = faceTracks({ blink: { interval, jitter, seed: 5, start: 0.5, keys: ['jawOpen'] } }, { morphTargets: FACE_CAP_KEYS, duration: 30 });
  const peaks = track.keyframes.filter(key => key.value === 1).map(key => key.time);
  const gaps = peaks.slice(1).map((time, index) => time - peaks[index]);
  assert.ok(gaps.length > 15);
  for (const gap of gaps) {
    assert.ok(gap >= interval * (1 - jitter) - 1e-4 && gap <= interval * (1 + jitter) + 1e-4, `gap ${gap} is outside ${interval} +/- ${jitter * 100}%`);
  }
  assert.ok(new Set(gaps.map(gap => gap.toFixed(3))).size > gaps.length / 2, 'the gaps differ from each other');
});

test('visemes ramp in and out on the Oculus key of each phoneme', () => {
  const tracks = faceTracks({ visemes: { blend: 0.05, coarticulation: 0, phonemes: [{ time: 0.2, phoneme: 'PP' }, { time: 0.5, phoneme: 'AA' }, { time: 0.8, phoneme: 'sil' }] } }, { morphTargets: OCULUS_KEYS, duration: 1 });
  assert.deepEqual(tracks.map(track => track.id), ['viseme_PP', 'viseme_aa']);
  assert.deepEqual(trackOf(tracks, 'viseme_PP').keyframes.slice(1, 5), [
    { time: 0.2, value: 0 }, { time: 0.25, value: 1 }, { time: 0.45, value: 1 }, { time: 0.5, value: 0 },
  ]);
  const open = trackOf(tracks, 'viseme_aa');
  assert.equal(weightAt(open, 0.3), 0);
  assert.equal(weightAt(open, 0.55), 1);
  assert.equal(weightAt(open, 0.75), 1);
  assert.equal(weightAt(open, 0.8), 0, 'a rest closes the mouth');
});

test('coarticulation lets neighbouring phonemes overlap, and short phonemes peak lower', () => {
  const dip = coarticulation => {
    const [track] = faceTracks({ visemes: { blend: 0.05, coarticulation, phonemes: [{ time: 0.2, phoneme: 'aa' }, { time: 0.3, phoneme: 'aa' }, { time: 0.4, phoneme: 'sil' }] } }, { morphTargets: OCULUS_KEYS, duration: 1 });
    return weightAt(track, 0.3);
  };
  assert.equal(dip(0), 0, 'no overlap: the mouth closes between two phonemes');
  assert.equal(dip(1), 0.5, 'full overlap: the two shapes cross at half weight');
  assert.ok(dip(0.5) > dip(0) && dip(0.5) < dip(1));
  const [quick] = faceTracks({ visemes: { blend: 0.06, coarticulation: 0, phonemes: [{ time: 0, phoneme: 'aa' }, { time: 0.04, phoneme: 'sil' }] } }, { morphTargets: OCULUS_KEYS, duration: 1 });
  assert.ok(Math.abs(Math.max(...quick.keyframes.map(key => key.value)) - 0.04 / 0.12) < 1e-5, 'a 40 ms phoneme peaks at a third');
});

test('visemes keep crossing points where two shapes meet, so linear keys reproduce the blend', () => {
  const [track] = faceTracks({ visemes: { blend: 0.1, coarticulation: 1, phonemes: [{ time: 0.2, phoneme: 'aa' }, { time: 0.45, phoneme: 'aa' }, { time: 0.9, phoneme: 'sil' }] } }, { morphTargets: OCULUS_KEYS, duration: 1 });
  const keyTimes = track.keyframes.map(key => key.time);
  assert.ok(keyTimes.includes(0.45) || keyTimes.some(time => time > 0.4 && time < 0.6));
  for (const time of [0.1, 0.3, 0.42, 0.5, 0.6]) {
    const shapeA = Math.max(0, Math.min(1, (time - 0.1) / 0.2, (0.55 - time) / 0.2));
    const shapeB = Math.max(0, Math.min(1, (time - 0.35) / 0.2, (1.0 - time) / 0.2));
    const expected = Math.max(shapeA, shapeB);
    assert.ok(Math.abs(weightAt(track, time) - expected) < 1e-9, `at ${time}: ${weightAt(track, time)} against ${expected}`);
  }
});

test('visemes on an ARKit head use its keys, and a map overrides them', () => {
  const phonemes = [{ time: 0.1, phoneme: 'OW' }, { time: 0.4, phoneme: 'sil' }];
  const arkit = faceTracks({ visemes: { phonemes } }, { morphTargets: FACE_CAP_KEYS.concat(['mouthPucker', 'mouthPressLeft']), duration: 1 }, undefined);
  assert.ok(arkit.map(track => track.id).includes('jawOpen'));
  assert.ok(arkit.map(track => track.id).includes('mouthFunnel'));
  const mapped = faceTracks({ visemes: { phonemes, map: { O: { jawOpen: 0.5 } } } }, { morphTargets: FACE_CAP_KEYS, duration: 1 });
  assert.deepEqual(mapped.map(track => track.id), ['jawOpen']);
  assert.equal(Math.max(...mapped[0].keyframes.map(key => key.value)), 0.5);
});

test('expressions blend by name, and the next one takes over', () => {
  const tracks = faceTracks({ expressions: [{ time: 0.5, name: 'smile', weight: 0.5, blend: 0.25 }, { time: 2, name: 'surprised', blend: 0.25 }] }, { morphTargets: FACE_CAP_KEYS, duration: 4 });
  const smile = trackOf(tracks, 'mouthSmile_L');
  assert.equal(weightAt(smile, 0.4), 0);
  assert.equal(weightAt(smile, 1), 0.4);
  assert.equal(weightAt(smile, 2.25), 0, 'the smile has faded once the surprise has arrived');
  assert.equal(weightAt(trackOf(tracks, 'jawOpen'), 3.9), 0.5, 'the last expression holds to the end');
  const custom = faceTracks({ definitions: { smirk: { mouthSmile_R: 0.7 } }, expressions: [{ time: 0, name: 'smirk' }] }, { morphTargets: FACE_CAP_KEYS, duration: 1 });
  assert.deepEqual(custom.map(track => track.id), ['mouthSmile_R']);
});

test('a missing key throws an error that names it and lists the keys there are', () => {
  assert.throws(() => faceTracks({ expressions: [{ time: 0, name: 'sad' }] }, { morphTargets: FACE_CAP_KEYS, duration: 1 }),
    error => error instanceof RangeError && /"mouthFrownLeft" is not on this character\. Keys available: browInnerUp, eyeBlink_L/.test(error.message));
  assert.throws(() => faceTracks({ visemes: { phonemes: [{ time: 0, phoneme: 'aa' }] }, rig: 'oculus' }, { morphTargets: FACE_CAP_KEYS, duration: 1 }), /"aa" is not on this character/);
  assert.throws(() => faceTracks({ blink: {} }, { morphTargets: ['jawOpen'], duration: 1 }), /no blink shape keys found.*Keys available: jawOpen/);
  assert.throws(() => faceTracks({ blink: { keys: ['winkLeft'] } }, { morphTargets: ['jawOpen'], duration: 1 }), /"winkLeft" is not on this character\. Keys available: jawOpen/);
  assert.throws(() => faceTracks({ visemes: { phonemes: [{ time: 0, phoneme: 'aa' }] } }, { morphTargets: ['a', 'b'], duration: 1 }), /neither Oculus viseme keys/);
  assert.throws(() => faceTracks({ blink: {} }, { morphTargets: [], duration: 1 }), /no shape keys to animate/);
});

test('bad input is refused with what to pass instead', () => {
  const options = { morphTargets: OCULUS_KEYS, duration: 2 };
  assert.throws(() => faceTracks({ visemes: { phonemes: [{ time: 0, phoneme: 'xx' }] } }, options), /motion\.face\.visemes\.phonemes\[0\]\.phoneme: got "xx"; expected an ARPAbet phoneme/);
  assert.throws(() => faceTracks({ visemes: { phonemes: [{ time: 0.5, phoneme: 'aa' }, { time: 0.5, phoneme: 'E' }] } }, options), /phonemes\[1\]\.time: got 0\.5; expected a time after 0\.5/);
  assert.throws(() => faceTracks({ visemes: { phonemes: [] } }, options), /1 to 4096 entries/);
  assert.throws(() => faceTracks({ expressions: [{ time: 0, name: 'grin' }] }, options), /one of neutral, smile.*motion\.face\.definitions/);
  assert.throws(() => faceTracks({ blink: { interval: 0.1 } }, options), /interval: got 0\.1; expected a number from 0\.5 to 30/);
  assert.throws(() => faceTracks({ blink: { seed: 1.5 } }, options), /seed: got 1\.5; expected a whole number/);
  assert.throws(() => faceTracks({ mouth: {} }, options), /motion\.face\.mouth/);
  assert.throws(() => faceTracks({ rig: 'bones' }, options), /one of auto, arkit, oculus/);
});

test('phonemes and expressions are bounded', () => {
  const phonemes = Array.from({ length: MAX_PHONEMES + 1 }, (_, index) => ({ time: index / 200, phoneme: 'aa' }));
  assert.throws(() => faceTracks({ visemes: { phonemes } }, { morphTargets: OCULUS_KEYS, duration: 30 }), /4097 entries/);
  const expressions = Array.from({ length: MAX_EXPRESSIONS + 1 }, (_, index) => ({ time: index / 100, name: 'smile' }));
  assert.throws(() => faceTracks({ expressions }, { morphTargets: FACE_CAP_KEYS, duration: 30 }), /at most 64 entries/);
  const fine = Array.from({ length: MAX_PHONEMES }, (_, index) => ({ time: index / 140, phoneme: index % 2 ? 'aa' : 'sil' }));
  assert.ok(faceTracks({ visemes: { phonemes: fine } }, { morphTargets: OCULUS_KEYS, duration: 30 }).length > 0);
});

test('a motion carries face as the morph tracks it expands to, and seeking repeats', async () => {
  const joints = humanoidJoints();
  const asset = await parseGltf(humanoidGlb({ names: MIXAMO_LIKE, joints, face: true }), { maxVertices: 500000 });
  const face = { blink: { interval: 1, jitter: 0, seed: 3, start: 0.5 }, visemes: { map: { aa: { jawOpen: 1 } }, phonemes: [{ time: 0.2, phoneme: 'AA' }, { time: 1.2, phoneme: 'sil' }] } };
  const recipe = { format: 'crucible.asset', schemaVersion: 1, assetId: 'ef'.repeat(32), motion: { duration: 2, face } };
  await loadAgentSceneModules(recipe);
  const scene = createAgentAssetScene(asset, recipe);
  const faceIndex = asset.parts.findIndex(part => part.name === 'Face');
  const weights = time => {
    scene.sampleMotion(time);
    return Array.from(scene.parts[faceIndex].morph.weights, weight => Number(weight.toFixed(4)));
  };
  const expected = faceTracks(face, { morphTargets: FACE_TARGETS, duration: 2 });
  assert.deepEqual(expected.map(track => track.id), ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen']);
  const atBlink = weights(0.5);
  assert.equal(atBlink[FACE_TARGETS.indexOf('eyeBlinkLeft')], 1);
  assert.equal(atBlink[FACE_TARGETS.indexOf('eyeBlinkRight')], 1);
  assert.equal(weights(0.7)[FACE_TARGETS.indexOf('jawOpen')], 1);
  assert.equal(weights(1.9)[FACE_TARGETS.indexOf('jawOpen')], 0);
  assert.deepEqual(weights(0.5), atBlink, 'seeking back repeats the weights');
  const duplicate = { ...recipe, motion: { duration: 2, face, tracks: [{ kind: 'morph', id: 'jawOpen', property: 'weight', keyframes: [{ time: 0, value: 0 }] }] } };
  assert.throws(() => createAgentAssetScene(asset, duplicate), /one track per target and property/);
});
