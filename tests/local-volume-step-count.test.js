// A noisy local volume takes at least two samples per noise cell along the ray (issue 855, owner report: smoke looks pixelated).
// Fewer steps jump whole cells and the start-offset dither shows as pixel-pitch grain; the rasterizer and the CPU tracer share the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { localVolumeStepCount, localVolumeOctaveStepCount, resolveLocalVolumes, LOCAL_VOLUME_MAXIMUM_STEPS, LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS, LOCAL_VOLUME_STEPS_PER_NOISE_CELL } from '../src/local-volumes.js';
import { createLocalVolumeCompositeFragment } from '../src/post.js';
import '../src/fog-shader.js';

const resolve = fields => resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [2, 2, 2], ...fields }])[0];

test('a volume without noise keeps its own step count', () => {
  const volume = resolve({ steps: 8, noiseAmount: 0, noiseScale: 20 });
  assert.equal(localVolumeStepCount(volume, 5), 8);
});

test('a noisy volume gets two steps per noise cell along the ray, never fewer than its steps', () => {
  const volume = resolve({ steps: 8, noiseAmount: 0.5, noiseScale: 2.2 });
  assert.equal(LOCAL_VOLUME_STEPS_PER_NOISE_CELL, 2);
  assert.equal(localVolumeStepCount(volume, 3.2), Math.ceil(3.2 * 2.2 * 2));
  assert.equal(localVolumeStepCount(volume, 0.5), 8, 'a short ray keeps the requested steps');
});

test('the raised count stops at the maximum', () => {
  const volume = resolve({ steps: 16, noiseAmount: 1, noiseScale: 100 });
  assert.equal(localVolumeStepCount(volume, 10), LOCAL_VOLUME_MAXIMUM_STEPS);
});

test('the post shader and the path tracer use the same rule', () => {
  const shader = readFileSync(new URL('../src/fog-shader.js', import.meta.url), 'utf8');
  assert.match(shader, /if \(localVolumeAbsorption\[index\]\.w > 0\.0\) steps = min\(\$\{LOCAL_VOLUME_MAXIMUM_STEPS\}, max\(steps, int\(ceil\(length \* localVolumeEmission\[index\]\.w \* \$\{LOCAL_VOLUME_STEPS_PER_NOISE_CELL\.toFixed\(1\)\}\)\)\)\);/);
  const tracer = readFileSync(new URL('../src/path-tracer-volume.js', import.meta.url), 'utf8');
  assert.match(tracer, /let stepCount = localVolumeStepCount\(volume, segmentEnd - entry\);/);
});

// Noise octaves (#1855): the finest cell is 2^(octaves - 1) times smaller than the base one, so the count follows it and may pass the plain cap.
test('the octave step count follows the finest cell and stops at its own bound', () => {
  assert.equal(LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS, 96);
  assert.ok(LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS > LOCAL_VOLUME_MAXIMUM_STEPS);
  assert.equal(localVolumeOctaveStepCount(1, 2.2, 2), Math.ceil(2 * 2.2 * 2));
  assert.equal(localVolumeOctaveStepCount(4, 2.2, 2), Math.ceil(2 * 2.2 * 8 * 2), 'the #1816 sphere needs 71 samples, not 32');
  assert.equal(localVolumeOctaveStepCount(5, 10, 10), LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS);
});

test('a volume with octaves counts from its finest cell and one without keeps the plain rule', () => {
  const fractal = resolve({ steps: 16, noiseAmount: 1, noiseScale: 2.2, noiseOctaves: 4 });
  const plain = resolve({ steps: 16, noiseAmount: 1, noiseScale: 2.2 });
  assert.equal(localVolumeStepCount(fractal, 2), 71);
  assert.equal(localVolumeStepCount(plain, 2), 16);
  assert.equal(localVolumeStepCount(resolve({ steps: 16, noiseAmount: 1, noiseScale: 100, noiseOctaves: 5 }), 10), LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS);
  assert.equal(localVolumeStepCount(resolve({ steps: 16, noiseAmount: 1, noiseScale: 100 }), 10), LOCAL_VOLUME_MAXIMUM_STEPS, 'without octaves the cap is untouched');
  assert.equal(localVolumeStepCount(resolve({ steps: 8, noiseAmount: 1, noiseScale: 2.2, noiseOctaves: 4 }), 0.1), 8, 'a short ray keeps the requested steps');
});

const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// The fingerprints were retaken when each march step began to weight its glow by the exact step integral (#1894).
// The motion-blur variant was retaken again when its shadow taps began to read the grid at their own shutter time (#1763).
// All three were retaken when the surface shadow began to read the emission mask of the frame (#1360), when the bloom was kept out of the volume's blur and the surface shadow,
// and when grid blackbody emission switched to evaluate from the interpolated emission temperature via localGridBlackbodyTable (#1735).
test('the shader text without octaves is the text from before #1855, and with octaves the march loop and the count follow the finest cell', () => {
  assert.equal(hashOf(createLocalVolumeCompositeFragment(false, 'both', false)), 'f869af2d9e0b53ca');
  assert.equal(hashOf(createLocalVolumeCompositeFragment(true, 'both', false)), '81e9d272b2ebf63f');
  assert.equal(hashOf(createLocalVolumeCompositeFragment(false, 'shape', false)), '40de8fd73596c0a9');
  const withOctaves = createLocalVolumeCompositeFragment(false, 'both', true);
  assert.match(withOctaves, new RegExp(`min\\(${LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS}, int\\(ceil\\(length \\* localVolumeEmission\\[index\\]\\.w \\* exp2\\(float\\(octaves - 1\\)\\) \\* 2\\.0\\)\\)\\)`));
  assert.match(withOctaves, new RegExp(`step < ${LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS}; step\\+\\+`));
  assert.doesNotMatch(createLocalVolumeCompositeFragment(false, 'both', false), /exp2\(float\(octaves/);
});
