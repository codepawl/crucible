import { mat4 } from 'gl-matrix';

// A deterministic GLB that stands in for a rigid character exported with baked animation: boxes joined by parent-child links
// (no skinning), one LINEAR translation, rotation and scale channel per node, sampled once per frame (#3232).
// The sample values depend only on the node index and the frame index, so a test can rebuild the expected pose without the renderer.

export const BAKED_RIG_DEFAULTS = Object.freeze({ chainCount: 12, chainLength: 10, frameCount: 90, framesPerSecond: 30 });

const COMPONENTS_PER_TYPE = { SCALAR: 1, VEC3: 3, VEC4: 4 };

function paddedTo4(bytes, fill) {
  return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4, fill)]);
}

function chunk(bytes, type) {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(bytes.length, 0);
  prefix.write(type, 4, 'latin1');
  return Buffer.concat([prefix, bytes]);
}

/** The baked local pose of a node at a frame: the same numbers go into the GLB and into the expected matrices. */
export function bakedLocalPose(nodeIndex, frameIndex) {
  const isChainRoot = nodeIndex % BAKED_RIG_DEFAULTS.chainLength === 0;
  const chainIndex = Math.floor(nodeIndex / BAKED_RIG_DEFAULTS.chainLength);
  const phase = nodeIndex * 0.37;
  const angle = 0.12 * frameIndex + phase;
  const axisX = Math.sin(phase + 1);
  const axisY = Math.cos(phase + 2);
  const axisZ = 0.5 + 0.5 * Math.sin(phase);
  const axisLength = Math.hypot(axisX, axisY, axisZ);
  const sine = Math.sin(angle / 2) / axisLength;
  return {
    translation: [0.3 + 0.002 * frameIndex + (isChainRoot ? -1.5 + 0.3 * chainIndex : 0), 0.05 * Math.sin(frameIndex * 0.2 + phase), 0.01 * frameIndex],
    rotation: [axisX * sine, axisY * sine, axisZ * sine, Math.cos(angle / 2)],
    scale: [1 + 0.002 * frameIndex, 1, 1 - 0.001 * frameIndex],
  };
}

/** Builds the GLB bytes and the node layout: `parents[i]` is the parent node index or -1 for a chain root. */
export function buildBakedRigGlb(options = {}) {
  const { chainCount, chainLength, frameCount, framesPerSecond } = { ...BAKED_RIG_DEFAULTS, ...options };
  const nodeCount = chainCount * chainLength;
  const parents = Array.from({ length: nodeCount }, (_, index) => (index % chainLength === 0 ? -1 : index - 1));
  const boxCorners = [];
  for (const x of [-0.1, 0.1]) for (const y of [-0.1, 0.1]) for (const z of [-0.1, 0.1]) boxCorners.push(x, y, z);
  const boxIndices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;
  const addAccessor = (data, componentType, type, extra = {}) => {
    const bytes = paddedTo4(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength });
    buffers.push(bytes);
    byteOffset += bytes.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: data.length / COMPONENTS_PER_TYPE[type], type, ...extra });
    return accessors.length - 1;
  };
  const positionAccessor = addAccessor(new Float32Array(boxCorners), 5126, 'VEC3', { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] });
  const indexAccessor = addAccessor(new Uint16Array(boxIndices), 5123, 'SCALAR');
  const times = new Float32Array(frameCount).map((_, frame) => frame / framesPerSecond);
  const timeAccessor = addAccessor(times, 5126, 'SCALAR', { min: [times[0]], max: [times[frameCount - 1]] });
  const nodes = [];
  const channels = [];
  const samplers = [];
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const poses = Array.from({ length: frameCount }, (_, frame) => bakedLocalPose(nodeIndex, frame));
    const outputs = {
      translation: [new Float32Array(poses.flatMap(pose => pose.translation)), 'VEC3'],
      rotation: [new Float32Array(poses.flatMap(pose => pose.rotation)), 'VEC4'],
      scale: [new Float32Array(poses.flatMap(pose => pose.scale)), 'VEC3'],
    };
    for (const [path, [data, type]] of Object.entries(outputs)) {
      samplers.push({ input: timeAccessor, output: addAccessor(data, 5126, type), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex, path } });
    }
    nodes.push({ name: `n${String(nodeIndex).padStart(3, '0')}`, mesh: 0, translation: poses[0].translation, rotation: poses[0].rotation, scale: poses[0].scale });
  }
  parents.forEach((parent, index) => {
    if (parent >= 0) (nodes[parent].children ??= []).push(index);
  });
  const roots = parents.flatMap((parent, index) => (parent < 0 ? [index] : []));
  const binary = Buffer.concat(buffers);
  const json = paddedTo4(Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: roots }], nodes,
    meshes: [{ name: 'Box', primitives: [{ attributes: { POSITION: positionAccessor }, indices: indexAccessor }] }],
    animations: [{ name: 'baked', channels, samplers }],
    accessors, bufferViews, buffers: [{ byteLength: binary.length }],
  })), 0x20);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const bytes = Buffer.concat([header, chunk(json, 'JSON'), chunk(binary, 'BIN\0')]);
  return { bytes, nodeCount, parents, frameCount, framesPerSecond };
}

/** The world matrix of every node at a frame, from the baked values only (column-major, doubles). */
export function expectedWorldMatrices({ parents }, frameIndex) {
  const worlds = [];
  parents.forEach((parent, nodeIndex) => {
    const pose = bakedLocalPose(nodeIndex, frameIndex);
    const local = mat4.fromRotationTranslationScale(mat4.create(), pose.rotation, pose.translation, pose.scale);
    worlds.push(parent < 0 ? local : mat4.multiply(mat4.create(), worlds[parent], local));
  });
  return worlds;
}
