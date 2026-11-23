// Recipe node tracks (translation, rotation, scale) as one glTF clip for scene_export_glb. The scene is sampled at 30 frames
// a second, as the bone clip of bakeRigExport is, and every part the motion moves gets the translation, rotation and scale
// that change, as its world transform. A part under a moved group therefore moves too, and an eased or smooth track
// becomes linear keys.
import { createAnimationClip } from './animation.js';
import { matrixFrame } from './export-skeleton.js';
import { BAKED_NODE_PROPERTIES } from './glb-export-omissions.js';

export const EXPORT_FRAME_RATE = 30;
/** Keys per track: 30 seconds, the longest recipe motion, at 30 frames a second, plus the first. */
export const MAX_EXPORT_FRAMES = 901;
/** Moving parts, each of which takes up to three tracks. */
export const MAX_EXPORT_MOVING_PARTS = 128;
const CHANNEL_TOLERANCE = 1e-6;
const MATRIX_SIZE = 16;
const LOOP_END_OFFSET_SECONDS = 1e-9;

const CHANNELS = [
  { property: 'translation', size: 3 },
  { property: 'rotation', size: 4 },
  { property: 'scale', size: 3 },
];

/** True when the recipe has a node track the clip writes. */
export function hasBakedNodeTracks(recipe) {
  return (recipe.motion?.tracks ?? []).some(track => track.kind === 'node' && BAKED_NODE_PROPERTIES.includes(track.property));
}

function frameTimes(duration, loop) {
  const frameCount = Math.max(1, Math.ceil(duration * EXPORT_FRAME_RATE));
  if (frameCount + 1 > MAX_EXPORT_FRAMES) {
    throw new RangeError(`The motion lasts ${duration} s, which bakes ${frameCount + 1} keys at ${EXPORT_FRAME_RATE} a second, above the ${MAX_EXPORT_FRAMES} key limit. Shorten motion.duration to ${(MAX_EXPORT_FRAMES - 1) / EXPORT_FRAME_RATE} s or less, or pass motionTime to export one pose without a clip.`);
  }
  return Array.from({ length: frameCount + 1 }, (_, frame) => {
    const time = Math.min(duration, frame / EXPORT_FRAME_RATE);
    return { time, sampleTime: loop && time >= duration ? duration - LOOP_END_OFFSET_SECONDS : time };
  });
}

/** Per part, the world matrix of every frame; a part that never differs from frame 0 is not kept. */
function sampleMovingParts(scene, times) {
  const partCount = scene.parts.length;
  const firstFrame = [];
  const moving = new Map();
  times.forEach(({ sampleTime }, frameIndex) => {
    scene.sampleMotion(sampleTime);
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const part = scene.parts[partIndex];
      if (part.skin) continue;
      if (frameIndex === 0) firstFrame[partIndex] = Float32Array.from(part.matrix);
      let frames = moving.get(partIndex);
      const differs = firstFrame[partIndex].some((value, index) => Math.abs(value - part.matrix[index]) > CHANNEL_TOLERANCE);
      if (!frames && !differs) continue;
      if (!frames) {
        if (moving.size >= MAX_EXPORT_MOVING_PARTS) {
          throw new RangeError(`The motion moves more than ${MAX_EXPORT_MOVING_PARTS} parts, above the export limit of ${MAX_EXPORT_MOVING_PARTS} (three tracks each). Move fewer parts, or pass motionTime to export one pose without a clip.`);
        }
        frames = new Float32Array(times.length * MATRIX_SIZE);
        for (let backfill = 0; backfill < frameIndex; backfill++) frames.set(firstFrame[partIndex], backfill * MATRIX_SIZE);
        moving.set(partIndex, frames);
      }
      frames.set(part.matrix, frameIndex * MATRIX_SIZE);
    }
  });
  return moving;
}

function channelValues(frames, frameCount) {
  const values = CHANNELS.map(() => []);
  for (let frame = 0; frame < frameCount; frame++) {
    const { translation, rotation, scale } = matrixFrame(frames.subarray(frame * MATRIX_SIZE, (frame + 1) * MATRIX_SIZE));
    const previous = values[1][frame - 1];
    // The shortest way round: a flipped sign between two frames would spin the part the long way.
    const sign = previous && previous.reduce((sum, value, axis) => sum + value * rotation[axis], 0) < 0 ? -1 : 1;
    values[0].push(Array.from(translation));
    values[1].push(Array.from(rotation, value => value * sign));
    values[2].push(Array.from(scale));
  }
  return values;
}

function variesAcrossFrames(values) {
  return values.some(value => value.some((component, axis) => Math.abs(component - values[0][axis]) > CHANNEL_TOLERANCE));
}

function partTracks(partName, frames, times) {
  const channels = channelValues(frames, times.length);
  const tracks = [];
  CHANNELS.forEach(({ property }, channel) => {
    const values = channels[channel];
    // A rotation that only changed sign is not motion.
    const moves = property === 'rotation'
      ? values.some(value => 1 - Math.abs(value.reduce((sum, component, axis) => sum + component * values[0][axis], 0)) > CHANNEL_TOLERANCE)
      : variesAcrossFrames(values);
    if (moves) tracks.push({ target: partName, property, interpolation: 'LINEAR', keyframes: times.map(({ time }, frame) => ({ time, value: values[frame] })) });
  });
  return tracks;
}

/**
 * Samples the recipe motion on `scene` and returns the node tracks of the parts it moves, in `createAnimationClip` form
 * with the part name as the target. The scene goes back to the pose it had, so the exported nodes keep the current pose.
 * Returns `[]` when no part moves. Throws a RangeError past MAX_EXPORT_FRAMES or MAX_EXPORT_MOVING_PARTS.
 */
export function bakeMovingPartTracks(scene, motion) {
  const times = frameTimes(motion.duration, motion.loop === true);
  const restoreTime = scene.motionTime ?? null;
  let moving;
  try {
    moving = sampleMovingParts(scene, times);
  } finally {
    scene.sampleMotion(restoreTime);
  }
  const names = [...moving.keys()].map(partIndex => scene.parts[partIndex].name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new RangeError(`Two moving parts are named ${duplicate}, so a clip cannot tell them apart. Rename one of the nodes.`);
  return [...moving].flatMap(([partIndex, frames]) => partTracks(scene.parts[partIndex].name, frames, times));
}

/** One clip named motion from the baked part tracks and the clip the rig already baked, when it has one. */
export function motionClip(motion, partTracks, rigClip) {
  if (!partTracks.length) return rigClip ?? null;
  const tracks = [...(rigClip?.tracks ?? []), ...partTracks];
  return { ...createAnimationClip({ duration: motion.duration, loop: motion.loop === true, tracks }), name: 'motion' };
}
