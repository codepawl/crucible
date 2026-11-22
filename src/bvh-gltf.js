import { parseBvh } from './bvh.js';

// A parsed BVH as a skeleton-only GLB: one node per joint with its OFFSET (scaled to metres) as the rest translation and no
// rest rotation, a skin that names every node as a joint, and one animation with a rotation track per rotating joint and a
// translation track per joint that has position channels. Retargeting, scene_inspect and the motion layer `from` then treat it like any
// other skeleton-only file of the catalog (see docs/retarget.md).

const DEGREES_TO_RADIANS = Math.PI / 180;
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const FLOAT = 5126;

function quaternionAboutAxis(axisIndex, degrees) {
  const half = degrees * DEGREES_TO_RADIANS / 2;
  const quaternion = [0, 0, 0, Math.cos(half)];
  quaternion[axisIndex] = Math.sin(half);
  return quaternion;
}

/** The Hamilton product left * right as [x, y, z, w]. */
function multiplyQuaternions(left, right) {
  const [leftX, leftY, leftZ, leftW] = left;
  const [rightX, rightY, rightZ, rightW] = right;
  return [
    leftW * rightX + leftX * rightW + leftY * rightZ - leftZ * rightY,
    leftW * rightY - leftX * rightZ + leftY * rightW + leftZ * rightX,
    leftW * rightZ + leftX * rightY - leftY * rightX + leftZ * rightW,
    leftW * rightW - leftX * rightX - leftY * rightY - leftZ * rightZ,
  ];
}

/** The local rotation of one frame: the rotation channels in file order, first listed outermost (Zrotation Xrotation Yrotation is Rz * Rx * Ry). */
function frameRotation(joint, rowValues, firstChannel) {
  let rotation = [0, 0, 0, 1];
  joint.channels.forEach((channel, position) => {
    if (!channel.endsWith('rotation')) return;
    rotation = multiplyQuaternions(rotation, quaternionAboutAxis(AXIS_INDEX[channel[0]], rowValues[firstChannel + position]));
  });
  return rotation;
}

/**
 * The local translation of one frame, scaled to metres: a position channel gives its axis outright, as three.js and Blender read it
 * (a root OFFSET of 0 is the usual case, so nothing differs there); an axis without a channel keeps the OFFSET.
 */
function frameTranslation(joint, rowValues, firstChannel, scale) {
  const translation = [...joint.offset];
  joint.channels.forEach((channel, position) => {
    if (channel.endsWith('position')) translation[AXIS_INDEX[channel[0]]] = rowValues[firstChannel + position];
  });
  return translation.map(component => component * scale);
}

/** Per joint: its first channel column and which kinds of channel it has. */
function channelLayout(joints) {
  let column = 0;
  return joints.map(joint => {
    const layout = {
      firstChannel: column,
      rotates: joint.channels.some(channel => channel.endsWith('rotation')),
      moves: joint.channels.some(channel => channel.endsWith('position')),
    };
    column += joint.channels.length;
    return layout;
  });
}

const REST_POSES = ['auto', 'offsets', 'firstFrame'];
/** The first frame replaces the OFFSET pose as the rest pose when its bones sit at least a quarter closer to the world axes (misalignment below this share of the OFFSET pose). */
const FIRST_FRAME_REST_ADVANTAGE = 0.75;

/** World position and rotation of every joint for the local rotations given (identity for a missing one). */
function worldPose(joints, localRotations) {
  const positions = [];
  const rotations = [];
  joints.forEach((joint, index) => {
    const parentRotation = joint.parent >= 0 ? rotations[joint.parent] : [0, 0, 0, 1];
    const parentPosition = joint.parent >= 0 ? positions[joint.parent] : [0, 0, 0];
    rotations[index] = multiplyQuaternions(parentRotation, localRotations[index]);
    const [x, y, z, w] = parentRotation;
    const [offsetX, offsetY, offsetZ] = joint.offset;
    const crossX = y * offsetZ - z * offsetY + w * offsetX;
    const crossY = z * offsetX - x * offsetZ + w * offsetY;
    const crossZ = x * offsetY - y * offsetX + w * offsetZ;
    positions[index] = [
      parentPosition[0] + offsetX + 2 * (y * crossZ - z * crossY),
      parentPosition[1] + offsetY + 2 * (z * crossX - x * crossZ),
      parentPosition[2] + offsetZ + 2 * (x * crossY - y * crossX),
    ];
  });
  return positions;
}

/** How far the bones of a pose lean from the world axes, in radians weighted by bone length: a T-pose is near 0, a splayed or mid-stride pose is not. */
function axisMisalignment(joints, localRotations) {
  const positions = worldPose(joints, localRotations);
  let total = 0;
  joints.forEach((joint, index) => {
    if (joint.parent < 0) return;
    const bone = positions[index].map((component, axis) => component - positions[joint.parent][axis]);
    const length = Math.hypot(...bone);
    if (length > 0) total += length * Math.acos(Math.min(1, Math.max(...bone.map(Math.abs)) / length));
  });
  return total;
}

/**
 * Whether the first frame is the rest pose. A mocap file's zero rotations are only the skeleton's own pose (CMU's has the legs splayed by about 20
 * degrees), and the retarget compares each bone with that rest pose, so a character whose rest is a plain T-pose would copy the splay. Many mocap
 * files open with a T-pose reference frame instead. 'auto' takes the first frame when its bones lie clearly closer to the world axes than the OFFSETs do.
 */
function usesFirstFrameAsRest(parsed, layouts, restPose) {
  if (restPose === 'offsets' || parsed.frameCount < 2) return false;
  const row = parsed.values.subarray(0, parsed.channelCount);
  const firstFrame = parsed.joints.map((joint, index) => (layouts[index].rotates ? frameRotation(joint, row, layouts[index].firstChannel) : [0, 0, 0, 1]));
  if (restPose === 'firstFrame') return true;
  const offsets = parsed.joints.map(() => [0, 0, 0, 1]);
  return axisMisalignment(parsed.joints, firstFrame) < FIRST_FRAME_REST_ADVANTAGE * axisMisalignment(parsed.joints, offsets);
}

/** The frame rows of one joint's rotation and translation, with each quaternion on the same side as the one before so a blend takes the short way. */
function sampleJoint(parsed, joint, layout, firstPlayedFrame) {
  const rotations = [];
  const translations = [];
  for (let frame = firstPlayedFrame; frame < parsed.frameCount; frame++) {
    const row = parsed.values.subarray(frame * parsed.channelCount, (frame + 1) * parsed.channelCount);
    if (layout.rotates) {
      const rotation = frameRotation(joint, row, layout.firstChannel);
      const previous = rotations[rotations.length - 1];
      const flip = previous && previous.reduce((sum, component, axis) => sum + component * rotation[axis], 0) < 0;
      rotations.push(flip ? rotation.map(component => -component) : rotation);
    }
    if (layout.moves) translations.push(frameTranslation(joint, row, layout.firstChannel, parsed.scale));
  }
  return { rotations, translations };
}

function createBinaryBuilder() {
  const accessors = [];
  const bufferViews = [];
  const chunks = [];
  let byteLength = 0;
  function append(values, type, extra = {}) {
    const data = new Float32Array(values);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength });
    chunks.push(new Uint8Array(data.buffer));
    byteLength += data.byteLength;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: FLOAT, count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type, ...extra });
    return accessors.length - 1;
  }
  return { accessors, bufferViews, append, finish: () => ({ byteLength, binary: Buffer.concat(chunks) }) };
}

function glbFromDocument(document, binary) {
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + binary.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(GLB_MAGIC, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonPadded.length, 12);
  glb.writeUInt32LE(JSON_CHUNK, 16);
  jsonPadded.copy(glb, 20);
  const binaryStart = 20 + jsonPadded.length;
  glb.writeUInt32LE(binary.length, binaryStart);
  glb.writeUInt32LE(BINARY_CHUNK, binaryStart + 4);
  binary.copy(glb, binaryStart + 8);
  return glb;
}

/**
 * The GLB bytes (a Buffer) of text or of an already parsed BVH. `name` becomes the clip name.
 * `scale` is the option of parseBvh. `restPose` is 'offsets' (the skeleton's zero pose), 'firstFrame' (the first frame is the rest pose and is not played) or 'auto' (default, see usesFirstFrameAsRest).
 * The report is `{ glb, joints, frameCount (played), frameRate, duration, scale, unit, restPose }`.
 */
export function bvhToGlb(source, { name = 'BVH motion', scale, restPose = 'auto' } = {}) {
  if (!REST_POSES.includes(restPose)) throw new RangeError(`BVH restPose must be one of ${REST_POSES.join(', ')}, got ${String(restPose)}.`);
  const parsed = typeof source === 'string' ? parseBvh(source, { scale }) : source;
  const layouts = channelLayout(parsed.joints);
  const firstFrameIsRest = usesFirstFrameAsRest(parsed, layouts, restPose);
  const firstPlayedFrame = firstFrameIsRest ? 1 : 0;
  const nodes = parsed.joints.map(joint => ({
    name: joint.name,
    translation: joint.offset.map(component => component * parsed.scale),
  }));
  parsed.joints.forEach((joint, index) => {
    if (joint.parent >= 0) (nodes[joint.parent].children ??= []).push(index);
  });
  const firstRow = parsed.values.subarray(0, parsed.channelCount);
  parsed.joints.forEach((joint, index) => {
    // A moving joint (the root) rests where the first frame puts it: mocap roots have OFFSET 0 and an absolute height in the frames, and the
    // retarget adds the change from the rest position to the target's rest hips, so resting at the OFFSET would lift the character by the whole height.
    if (layouts[index].moves) nodes[index].translation = frameTranslation(joint, firstRow, layouts[index].firstChannel, parsed.scale);
    if (firstFrameIsRest && layouts[index].rotates) nodes[index].rotation = frameRotation(joint, firstRow, layouts[index].firstChannel);
  });
  const playedFrames = parsed.frameCount - firstPlayedFrame;
  const times = Array.from({ length: playedFrames }, (_, frame) => frame * parsed.frameTime);
  const builder = createBinaryBuilder();
  const timeAccessor = builder.append(times, 'SCALAR', { min: [0], max: [times[times.length - 1]] });
  const samplers = [];
  const channels = [];
  parsed.joints.forEach((joint, index) => {
    const layout = layouts[index];
    if (!layout.rotates && !layout.moves) return;
    const { rotations, translations } = sampleJoint(parsed, joint, layout, firstPlayedFrame);
    const tracks = [];
    if (layout.rotates) tracks.push(['rotation', 'VEC4', rotations]);
    if (layout.moves) tracks.push(['translation', 'VEC3', translations]);
    for (const [path, type, frames] of tracks) {
      samplers.push({ input: timeAccessor, output: builder.append(frames.flat(), type), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: index, path } });
    }
  });
  const rootNodes = parsed.joints.flatMap((joint, index) => (joint.parent < 0 ? [index] : []));
  const { byteLength, binary } = builder.finish();
  const document = {
    asset: { version: '2.0', generator: 'Crucible BVH import' },
    scene: 0,
    scenes: [{ nodes: rootNodes }],
    nodes,
    skins: [{ joints: nodes.map((_, index) => index) }],
    animations: [{ name, samplers, channels }],
    accessors: builder.accessors,
    bufferViews: builder.bufferViews,
    buffers: [{ byteLength }],
  };
  return {
    glb: glbFromDocument(document, binary),
    joints: parsed.joints.length,
    frameCount: playedFrames,
    restPose: firstFrameIsRest ? 'firstFrame' : 'offsets',
    frameRate: parsed.frameRate,
    duration: times[times.length - 1],
    scale: parsed.scale,
    unit: parsed.unit,
  };
}
