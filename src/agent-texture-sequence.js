import { createImage } from './material-texture-kit.js';
import { TEXTURE_SEQUENCE_LIMITS } from './texture-sequence-limits.js';
import { invalidField } from './field-error.js';
import { graphImageAssets } from './material-graph.js';
import { textureMapIds } from './agent-texture-set.js';

// An image sequence as the colour map of a recipe material: `map: { sequence: { frames, fps, loop } }`. The frames are
// catalog image assets that the host decodes before createAgentScene. The scene picks a frame from its motion time, so a
// preview, a seek and a render job show the same frame for the same time.

const ASSET_ID = /^[a-f0-9]{64}$/;
const MAP_FIELDS = ['sequence'];
const SEQUENCE_FIELDS = ['frames', 'catalog', 'fps', 'loop'];

function knownKeys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
  }
}

/** Validate a material `map` field. Returns the canonical form kept in the recipe. */
export function normalizeMapSequence(value) {
  knownKeys(value, MAP_FIELDS, 'map');
  if (value.sequence === undefined) throw invalidField('map.sequence', value.sequence, 'a sequence, such as { "frames": [<asset id>, <asset id>], "fps": 12 }', TypeError);
  const sequence = value.sequence;
  knownKeys(sequence, SEQUENCE_FIELDS, 'map.sequence');
  const { frames, fps, loop = true } = sequence;
  if (frames === undefined && sequence.catalog !== undefined) {
    throw invalidField('map.sequence.catalog', sequence.catalog, 'frames, a list of catalog image asset IDs: the MCP server turns a catalog sequence name into its frame IDs before the scene is built, so a library caller passes the IDs', TypeError);
  }
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > TEXTURE_SEQUENCE_LIMITS.maxFrames) {
    throw invalidField('map.sequence.frames', Array.isArray(frames) ? `${frames.length} frames` : frames, `a list of 2 to ${TEXTURE_SEQUENCE_LIMITS.maxFrames} catalog image asset IDs, such as [<asset id>, <asset id>]; for a longer film, split it into several sequences or lower the frame rate`);
  }
  // A plain loop: forEach skips the holes of a sparse list.
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (typeof frame !== 'string' || !ASSET_ID.test(frame.toLowerCase())) {
      throw invalidField(`map.sequence.frames[${index}]`, frame, 'the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists them', TypeError);
    }
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > TEXTURE_SEQUENCE_LIMITS.maxFps) {
    throw invalidField('map.sequence.fps', fps, `a number above 0 and at most ${TEXTURE_SEQUENCE_LIMITS.maxFps}, such as 12`);
  }
  if (typeof loop !== 'boolean') throw invalidField('map.sequence.loop', loop, 'true or false', TypeError);
  return { sequence: { frames: frames.map(frame => frame.toLowerCase()), fps, loop } };
}

/** The frame shown at a scene time: floor(time * fps), wrapped when the sequence loops and held on the last frame otherwise. */
export function sequenceFrameIndex(sequence, time) {
  const count = sequence.frames.length;
  if (time !== undefined && time !== null && !Number.isFinite(time)) {
    throw invalidField('time', time, 'a finite number of seconds, such as 0.5', RangeError);
  }
  // The small offset keeps a time such as 0.29 s at 100 fps on frame 29 despite binary rounding.
  const raw = Math.floor(Math.max(0, time ?? 0) * sequence.fps + 1e-9);
  if (!Number.isFinite(raw)) {
    throw invalidField('time', time, `a number of seconds small enough that time times ${sequence.fps} fps stays finite, such as 0.5`, RangeError);
  }
  return sequence.loop ? raw % count : Math.min(raw, count - 1);
}

/** True for a sequence longer than the whole-sequence limit: its frames are read and decoded on demand, not with the scene. */
export function isStreamedSequence(frames) {
  return Array.isArray(frames) && frames.length > TEXTURE_SEQUENCE_LIMITS.wholeSequenceFrames;
}

/**
 * The catalog image IDs a recipe, or a list of edit operations, loads with the scene: the frames of whole sequences, the first
 * frame of each streamed sequence and the `image` nodes of a material graph.
 */
export function sequenceFrameIds(value) {
  const ids = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (node.type === 'graph' && node.graph) {
      for (const asset of graphImageAssets(node.graph)) {
        if (ASSET_ID.test(asset.toLowerCase())) ids.add(asset.toLowerCase());
      }
    }
    if (node.op === 'displace' && typeof node.source?.image === 'string' && ASSET_ID.test(node.source.image.toLowerCase())) ids.add(node.source.image.toLowerCase());
    for (const id of textureMapIds(node)) ids.add(id);
    // The far crown clump of a scanned leaf card (vegetation.scans) sits beside its colour and normal maps.
    if (typeof node.crownMap === 'string' && ASSET_ID.test(node.crownMap.toLowerCase())) ids.add(node.crownMap.toLowerCase());
    // The six faces of environment.skybox and environment.puddles.mask are catalog images decoded into the pool.
    if (node.skybox && typeof node.skybox === 'object') {
      for (const id of Object.values(node.skybox)) {
        if (typeof id === 'string' && ASSET_ID.test(id.toLowerCase())) ids.add(id.toLowerCase());
      }
    }
    if (typeof node.puddles?.mask === 'string' && ASSET_ID.test(node.puddles.mask.toLowerCase())) ids.add(node.puddles.mask.toLowerCase());
    const frames = node.map?.sequence?.frames;
    if (Array.isArray(frames)) {
      const shippedFrames = isStreamedSequence(frames) ? frames.slice(0, 1) : frames;
      for (const frame of shippedFrames) {
        if (typeof frame === 'string' && ASSET_ID.test(frame.toLowerCase())) ids.add(frame.toLowerCase());
      }
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...ids];
}

/** The material `map` field of a recipe material: validates it against the rest of the material and stores it on `result`. */
export function applyMapSequence(value, result) {
  if (result.tag !== 'surface' && result.tag !== 'unlit') throw invalidField('map', value.map, 'a material with the surface or unlit tag; remove map or set tag to surface or unlit');
  if (value.pattern !== undefined) throw invalidField('pattern', value.pattern, 'nothing, because a material takes a pattern or a map sequence, not both', TypeError);
  result.map = normalizeMapSequence(value.map);
  // Like a pattern, the frames bring their own colours, so color tints them and defaults to white.
  if (value.color === undefined) result.color = [1, 1, 1];
}

function wholeSequence(materialId, frames, fps, loop, pool) {
  const images = frames.map(id => {
    const frame = pool?.get(id);
    if (!frame) throw new Error(`Material ${materialId}: image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`);
    return frame;
  });
  const { width, height } = images[0];
  if (images.some(frame => frame.width !== width || frame.height !== height)) {
    throw invalidField('map.sequence.frames', `frames of different sizes in material ${materialId}`, `frames that all measure ${width}x${height}; resize the images in the catalog`);
  }
  const wrapped = images.map(frame => createImage(frame.data, frame.width, frame.height));
  return { width, height, imageAt: index => wrapped[index], first: wrapped[0], streamed: false };
}

// A streamed sequence keeps the frames the host supplied for the current time and the time before it, nothing else.
function streamedSequence(materialId, frames, pool) {
  const firstFrame = pool?.get(frames[0]);
  if (!firstFrame) throw invalidField('map.sequence.frames[0]', `image ${frames[0].slice(0, 12)} of material ${materialId}, which was not loaded`, 'the first frame decoded by the host before createAgentScene or apply');
  const { width, height } = firstFrame;
  const resident = new Map([[frames[0], createImage(firstFrame.data, width, height)]]);
  return {
    width,
    height,
    first: resident.get(frames[0]),
    streamed: true,
    resident,
    imageAt(index) {
      const image = resident.get(frames[index]);
      if (!image) {
        throw invalidField('map.sequence.frames', `frame ${index} not decoded`, `frame ${index} (${frames[index].slice(0, 12)}) of streamed material ${materialId} supplied by the host before the draw; seek with a motion time through the preview or a render job`);
      }
      return image;
    },
  };
}

/**
 * The runtime of one material: a stable colour map descriptor holding the first frame, and the frame picked by `seek`.
 * `pool` maps catalog image IDs to decoded `{ width, height, data }` RGBA frames: every frame of a whole sequence, and the first
 * frame of a streamed one (see isStreamedSequence), whose other frames the host adds with `supply` before it draws their time.
 */
export function createTextureSequence(materialId, mapField, pool) {
  const { frames, fps, loop } = mapField.sequence;
  const source = isStreamedSequence(frames) ? streamedSequence(materialId, frames, pool) : wholeSequence(materialId, frames, fps, loop, pool);
  const { width, height } = source;
  const descriptor = { image: source.first, colorSpace: 'srgb' };
  const definition = { frames, fps, loop };
  let index = 0;
  return {
    descriptor,
    streamed: source.streamed,
    seek(time) {
      index = sequenceFrameIndex(definition, time);
      return index;
    },
    get index() {
      return index;
    },
    get image() {
      return source.imageAt(index);
    },
    /** The asset ID of the frame a time selects, and whether it is decoded now. Streamed sequences only. */
    frameAt(time) {
      const id = frames[sequenceFrameIndex(definition, time)];
      return { id, decoded: !source.streamed || source.resident.has(id) };
    },
    /** Adds the decoded frame of a streamed sequence. It must measure as the first frame does. */
    supply(id, frame) {
      if (!source.streamed || !frames.includes(id)) return false;
      if (frame.width !== width || frame.height !== height) {
        throw invalidField('map.sequence.frames', `a ${frame.width}x${frame.height} frame in material ${materialId}`, `frames that all measure ${width}x${height}; resize the images in the catalog`);
      }
      source.resident.set(id, createImage(frame.data, frame.width, frame.height));
      return true;
    },
    /** Drops every decoded frame of a streamed sequence except the listed IDs. Returns the decoded bytes that stay. */
    retain(ids) {
      if (!source.streamed) return 0;
      for (const id of [...source.resident.keys()]) {
        if (!ids.has(id)) source.resident.delete(id);
      }
      return source.resident.size * width * height * 4;
    },
    describe() {
      return { material: materialId, frames: frames.length, fps, loop, index, frame: frames[index], size: [width, height],
        ...(source.streamed ? { streamed: true, decodedFrames: source.resident.size } : {}) };
    },
  };
}

// The window of a streamed sequence: the frame of the time being shown and the frame of the time shown before it.
const shownBefore = new WeakMap();

/** The catalog IDs of streamed frames that a motion time needs and the scene has not decoded. `sequences` is `scene.sequenceTextures()`. */
export function missingStreamedFrames(sequences, time) {
  const missing = new Set();
  for (const sequence of sequences) {
    if (!sequence.streamed) continue;
    const { id, decoded } = sequence.frameAt(time);
    if (!decoded) missing.add(id);
  }
  return [...missing];
}

/** Hands a decoded frame to every streamed sequence that lists its asset ID. */
export function supplyStreamedFrame(sequences, id, frame) {
  for (const sequence of sequences) sequence.supply(id, frame);
}

/**
 * Keeps only the frame of `time` and the one shown before it in each streamed sequence, so a video job that walks the frames in
 * order holds two decoded frames per sequence. Returns the decoded bytes that stay and throws when they pass `byteLimit`.
 */
export function retainStreamedWindow(sequences, time, byteLimit) {
  let retainedBytes = 0;
  for (const sequence of sequences) {
    if (!sequence.streamed) continue;
    const shownNow = sequence.frameAt(time).id;
    const keep = new Set([shownNow]);
    const previous = shownBefore.get(sequence);
    if (previous) keep.add(previous);
    retainedBytes += sequence.retain(keep);
    shownBefore.set(sequence, shownNow);
  }
  if (retainedBytes > byteLimit) {
    throw invalidField('map.sequence.frames', `${retainedBytes / 1048576} MiB of decoded streamed frames`, `at most ${byteLimit / 1048576} MiB; use frames of at most ${TEXTURE_SEQUENCE_LIMITS.maxSide} pixels a side or fewer streamed sequences in one scene`);
  }
  return retainedBytes;
}

/** True when a recipe, or a list of edit operations, holds a streamed sequence, so a host knows to supply frames before a seek. */
export function hasStreamedSequence(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (isStreamedSequence(value.map?.sequence?.frames)) return true;
  return Object.values(value).some(child => hasStreamedSequence(child, depth + 1));
}
