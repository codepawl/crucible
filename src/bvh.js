// BVH (Biovision Hierarchy) motion capture: the common open mocap text format (CMU, many Mixamo and phone-capture exports).
// parseBvh reads the text into joints and frames; bvhToGlb (bvh-gltf.js) turns that into a skeleton-only GLB that every
// catalog consumer, the motion layer `from` retarget included, already reads.
//
// Format notes this parser follows:
// - HIERARCHY holds ROOT and JOINT blocks. Each has OFFSET (the rest position inside its parent), CHANNELS and children;
//   an "End Site" block closes a limb and has only an OFFSET.
// - MOTION holds `Frames: n`, `Frame Time: seconds` and n rows with one number per channel, in hierarchy order.
// - A rotation channel list such as "Zrotation Xrotation Yrotation" means the matrix Rz * Rx * Ry: the first channel is the
//   outermost rotation. Rotations are in degrees, the rest pose has every rotation at zero.
// - A position channel (usually only the root has any) gives that axis of the joint's local translation outright, as three.js and
//   Blender read it; an axis without a channel keeps the OFFSET. Root OFFSETs are 0 in nearly every mocap file, so this rarely matters.

import { BVH_LIMITS } from './bvh-limits.js';

export { BVH_LIMITS };

const CHANNEL_NAMES = ['Xposition', 'Yposition', 'Zposition', 'Xrotation', 'Yrotation', 'Zrotation'];

/**
 * Units are not written in a BVH file, so the rest height of the skeleton (highest joint minus lowest, from the OFFSETs) says which
 * a file uses: up to 4 is metres, 4 to 40 is the CMU mocap unit (1 / 0.45 inch, 5.64 cm, so a person is about 30 units), more is centimetres.
 */
const METRES_HEIGHT_LIMIT = 4;
const CMU_HEIGHT_LIMIT = 40;
const CMU_UNITS_TO_METRES = 0.0254 / 0.45;
const CENTIMETRES_TO_METRES = 0.01;

/** Words per line, with the 1-based line number kept for errors. */
function tokenize(text) {
  const tokens = [];
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((line, index) => {
    const words = line.trim().split(/\s+/);
    for (const word of words) {
      if (word) tokens.push({ word, line: index + 1 });
    }
  });
  return tokens;
}

function createReader(tokens) {
  let position = 0;
  const lastLine = () => tokens[tokens.length - 1]?.line ?? 1;
  function failure(expected, found) {
    const token = tokens[position];
    const line = token?.line ?? lastLine();
    const seen = token ? `"${token.word.slice(0, 40)}"` : 'the end of the file';
    return new SyntaxError(`BVH line ${line}: expected ${expected}, found ${found ?? seen}.`);
  }
  return {
    atEnd: () => position >= tokens.length,
    peek: () => tokens[position]?.word,
    line: () => tokens[position]?.line ?? lastLine(),
    failure,
    word(expected) {
      if (position >= tokens.length) throw failure(expected);
      return tokens[position++].word;
    },
    expect(keyword) {
      if (tokens[position]?.word !== keyword) throw failure(`"${keyword}"`);
      position += 1;
    },
    number(expected) {
      if (position >= tokens.length) throw failure(expected);
      const value = Number(tokens[position].word);
      if (!Number.isFinite(value)) throw failure(expected);
      position += 1;
      return value;
    },
    count(expected, maximum) {
      const line = this.line();
      const value = this.number(expected);
      if (!Number.isInteger(value) || value < 0) throw new SyntaxError(`BVH line ${line}: expected ${expected}, found ${value}.`);
      if (value > maximum) throw new RangeError(`BVH line ${line}: ${expected} is ${value}, over the limit of ${maximum}.`);
      return value;
    },
    position: () => position,
    remaining: () => tokens.length - position,
    skip(count) { position += count; },
    tokens,
  };
}

function readOffset(reader) {
  reader.expect('OFFSET');
  return [reader.number('an x offset number'), reader.number('a y offset number'), reader.number('a z offset number')];
}

function readChannels(reader, jointName) {
  reader.expect('CHANNELS');
  const line = reader.line();
  const count = reader.count('the channel count (0 to 6)', 6);
  const channels = [];
  for (let index = 0; index < count; index++) {
    const nameLine = reader.line();
    const name = reader.word(`channel ${index + 1} of ${count} of ${jointName}`);
    if (!CHANNEL_NAMES.includes(name)) {
      throw new SyntaxError(`BVH line ${nameLine}: channel "${name.slice(0, 40)}" of ${jointName} is unknown; expected one of ${CHANNEL_NAMES.join(', ')}.`);
    }
    if (channels.includes(name)) throw new SyntaxError(`BVH line ${nameLine}: ${jointName} lists channel ${name} twice; each channel appears once.`);
    channels.push(name);
  }
  if (reader.peek() && CHANNEL_NAMES.includes(reader.peek())) {
    throw new SyntaxError(`BVH line ${line}: ${jointName} declares ${count} channels but lists more; raise the CHANNELS count or remove the extra names.`);
  }
  return channels;
}

/** Appends a joint (End Sites count) and returns its index; the skeleton is bounded by BVH_LIMITS.maxJoints. */
function addJoint(reader, joints, joint) {
  if (joints.length >= BVH_LIMITS.maxJoints) {
    throw new RangeError(`BVH line ${reader.line()}: the skeleton has more than ${BVH_LIMITS.maxJoints} joints, End Sites included. Remove joints or split the file.`);
  }
  return joints.push(joint) - 1;
}

/** One ROOT or JOINT block, then its children, depth first, into `joints`. */
function readJoint(reader, joints, parent, keyword) {
  const name = reader.word(`a name after ${keyword}`);
  reader.expect('{');
  const joint = { name, parent, offset: readOffset(reader), channels: readChannels(reader, name), endSite: false };
  const index = addJoint(reader, joints, joint);
  for (;;) {
    const next = reader.peek();
    if (next === '}') {
      reader.expect('}');
      return;
    }
    if (next === 'JOINT') {
      reader.expect('JOINT');
      readJoint(reader, joints, index, 'JOINT');
    } else if (next === 'End') {
      reader.expect('End');
      reader.expect('Site');
      reader.expect('{');
      addJoint(reader, joints, { name: `${name}_End`, parent: index, offset: readOffset(reader), channels: [], endSite: true });
      reader.expect('}');
    } else {
      throw reader.failure('"JOINT", "End Site" or "}"');
    }
  }
}

function readHierarchy(reader) {
  reader.expect('HIERARCHY');
  const joints = [];
  if (reader.peek() !== 'ROOT') throw reader.failure('"ROOT"');
  while (reader.peek() === 'ROOT') {
    reader.expect('ROOT');
    readJoint(reader, joints, -1, 'ROOT');
  }
  const names = joints.map(joint => joint.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new SyntaxError(`BVH: the joint name "${duplicate.slice(0, 40)}" is used twice; joint names must be unique so clips can address them.`);
  return joints;
}

/** Joint heights at rest, in file units, from the OFFSETs alone. */
function restHeight(joints) {
  const heights = [];
  joints.forEach((joint, index) => {
    heights[index] = (joint.parent >= 0 ? heights[joint.parent] : 0) + joint.offset[1];
  });
  return Math.max(...heights) - Math.min(...heights);
}

/** The factor that takes file units to metres: the number given, or the unit the skeleton's height points to. */
function resolveScale(scale, joints) {
  const height = restHeight(joints);
  if (scale === undefined || scale === 'auto') {
    if (height <= METRES_HEIGHT_LIMIT) return { scale: 1, unit: 'metres', restHeight: height };
    if (height < CMU_HEIGHT_LIMIT) return { scale: CMU_UNITS_TO_METRES, unit: 'cmu', restHeight: height };
    return { scale: CENTIMETRES_TO_METRES, unit: 'centimetres', restHeight: height };
  }
  if (!Number.isFinite(scale) || scale < BVH_LIMITS.minScale || scale > BVH_LIMITS.maxScale) {
    throw new RangeError(`BVH scale must be "auto" or a number from ${BVH_LIMITS.minScale} to ${BVH_LIMITS.maxScale} (metres per file unit; 0.01 for centimetres), got ${String(scale)}.`);
  }
  return { scale, unit: 'given', restHeight: height };
}

function readMotion(reader, joints) {
  reader.expect('MOTION');
  reader.expect('Frames:');
  const frameCount = reader.count('the frame count after "Frames:"', BVH_LIMITS.maxFrames);
  reader.expect('Frame');
  reader.expect('Time:');
  const timeLine = reader.line();
  const frameTime = reader.number('the seconds per frame after "Frame Time:"');
  if (!(frameTime >= BVH_LIMITS.minFrameTime && frameTime <= BVH_LIMITS.maxFrameTime)) {
    throw new RangeError(`BVH line ${timeLine}: Frame Time is ${frameTime}; expected seconds from ${BVH_LIMITS.minFrameTime} to ${BVH_LIMITS.maxFrameTime}, such as 0.0333333 for 30 frames per second.`);
  }
  const channelCount = joints.reduce((sum, joint) => sum + joint.channels.length, 0);
  if (frameCount < 1) throw new SyntaxError(`BVH line ${timeLine}: expected at least 1 frame after "Frames:", found ${frameCount}.`);
  if (channelCount < 1) throw new SyntaxError('BVH: the hierarchy has no channels, so there is nothing to animate; give the root Xposition Yposition Zposition and a rotation order.');
  if (frameCount * channelCount > BVH_LIMITS.maxChannelValues) {
    throw new RangeError(`BVH: ${frameCount} frames of ${channelCount} channels is ${frameCount * channelCount} numbers, over the limit of ${BVH_LIMITS.maxChannelValues}. Trim frames or remove joints.`);
  }
  const expected = frameCount * channelCount;
  const available = reader.remaining();
  if (available < expected) {
    const completeFrames = Math.floor(available / channelCount);
    throw new SyntaxError(`BVH line ${reader.line()}: expected ${frameCount} frames of ${channelCount} numbers (${expected} in total), but the file ends after ${completeFrames} complete frames. Fix "Frames:" or complete the data.`);
  }
  if (available > expected) {
    reader.skip(expected);
    throw reader.failure(`the end of the file after ${frameCount} frames of ${channelCount} numbers`);
  }
  const values = new Float64Array(expected);
  for (let index = 0; index < expected; index++) {
    const token = reader.tokens[reader.position()];
    const value = Number(token.word);
    if (!Number.isFinite(value)) {
      const frame = Math.floor(index / channelCount);
      throw new SyntaxError(`BVH line ${token.line}: expected a number for frame ${frame}, channel ${index % channelCount}, found "${token.word.slice(0, 40)}".`);
    }
    values[index] = value;
    reader.skip(1);
  }
  return { frameCount, frameTime, channelCount, values };
}

/**
 * Parse BVH text.
 * Returns `{ joints, frameCount, frameTime, frameRate, channelCount, values, scale, unit, restHeight }`: `joints` in file order
 * (parents first) as `{ name, parent, offset, channels, endSite }`; `values` holds frame after frame, one number per channel in joint order.
 * `scale` is metres per file unit: pass a number, or leave it out (or "auto") to pick metres, CMU units or centimetres from the skeleton's height.
 * Throws a SyntaxError that names the line and what was expected, or a RangeError for a limit in BVH_LIMITS.
 */
export function parseBvh(text, { scale } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('parseBvh needs the text of a BVH file, which starts with HIERARCHY.');
  if (text.length > BVH_LIMITS.maxBytes) {
    throw new RangeError(`BVH text is ${text.length} characters, over the limit of ${BVH_LIMITS.maxBytes} (32 MiB). Trim frames or split the file.`);
  }
  const reader = createReader(tokenize(text));
  const joints = readHierarchy(reader);
  const motion = readMotion(reader, joints);
  return { joints, ...motion, frameRate: 1 / motion.frameTime, ...resolveScale(scale, joints) };
}
