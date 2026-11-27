// Keys of one animated property (position, rotation or scale) of a node: read, retimed, re-valued, re-eased and removed.
// The Studio controller runs these on the recipe's motion tracks, so each edit is one undo step and lands in the recipe.
import { parseEasing, EASING_HELP } from './easing.js';

export const POSE_PROPERTIES = Object.freeze(['translation', 'rotation', 'scale']);
export const KEYFRAME_TIME_TOLERANCE = 0.005;

const VALUE_LENGTH_BY_PROPERTY = Object.freeze({ translation: 3, rotation: 4, scale: 3 });
const EASING_INTERPOLATIONS = Object.freeze(['LINEAR', 'SMOOTH']);

function isNodePropertyTrack(track, nodeId, property) {
  return track.kind === 'node' && track.id === nodeId && track.property === property;
}

function keyIndexAt(keyframes, time) {
  return keyframes.findIndex(keyframe => Math.abs(keyframe.time - time) < KEYFRAME_TIME_TOLERANCE);
}

function roundTo(value, precision) {
  return Math.round(value * precision) / precision;
}

/** The tracks with a key of `value` at `time` on the node's property track (made when missing); a key already there is replaced. */
export function upsertNodeKeyframeTrack(tracks, nodeId, property, time, value) {
  const nextTracks = tracks.slice();
  const existingIndex = nextTracks.findIndex(track => isNodePropertyTrack(track, nodeId, property));
  const roundedTime = roundTo(time, 1000);
  const entry = { time: roundedTime, value: Array.from(value, component => roundTo(component, 10000)) };
  if (existingIndex < 0) {
    nextTracks.push({ kind: 'node', id: nodeId, property, keyframes: [entry] });
    return nextTracks;
  }
  const existing = nextTracks[existingIndex];
  const nextKeyframes = existing.keyframes.slice();
  const matchIndex = keyIndexAt(nextKeyframes, roundedTime);
  if (matchIndex >= 0) {
    nextKeyframes[matchIndex] = entry;
  } else {
    nextKeyframes.push(entry);
    nextKeyframes.sort((first, second) => first.time - second.time);
  }
  nextTracks[existingIndex] = { ...existing, keyframes: nextKeyframes };
  return nextTracks;
}

/** The property's track of a node, or undefined. */
export function findPropertyTrack(tracks, nodeId, property) {
  return tracks.find(track => isNodePropertyTrack(track, nodeId, property));
}

/** The animated pose properties of a node, in position, rotation, scale order, each with its keys ({ time, value, easing }) by time. */
export function propertyKeysOf(tracks, nodeId) {
  return POSE_PROPERTIES.flatMap(property => {
    const track = findPropertyTrack(tracks, nodeId, property);
    if (!track) {
      return [];
    }
    const interpolation = track.interpolation ?? 'LINEAR';
    const keys = track.keyframes.map(keyframe => ({ time: keyframe.time, value: keyframe.value, easing: keyframe.easing ?? null }));
    return [{ property, interpolation, canEase: EASING_INTERPOLATIONS.includes(interpolation), keys }];
  });
}

/** The key of the property at `time`, or undefined. */
export function propertyKeyAt(tracks, nodeId, property, time) {
  const track = findPropertyTrack(tracks, nodeId, property);
  return track?.keyframes[keyIndexAt(track.keyframes, time)];
}

function requireKey(track, nodeId, property, time) {
  const index = track ? keyIndexAt(track.keyframes, time) : -1;
  if (index < 0) {
    throw new RangeError(`Node "${nodeId}" has no ${property} key at ${time} s. Pass the time of one of its keys.`);
  }
  return index;
}

function checkedValue(property, value) {
  const length = VALUE_LENGTH_BY_PROPERTY[property];
  if (!Array.isArray(value) || value.length !== length || !value.every(component => typeof component === 'number' && Number.isFinite(component))) {
    throw new RangeError(`A ${property} key value is ${length} finite numbers, such as ${JSON.stringify(property === 'rotation' ? [0, 0, 0, 1] : [0, 0, 0])}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function checkedEasing(track, easing) {
  if (easing === null || easing === '') {
    return undefined;
  }
  if (!EASING_INTERPOLATIONS.includes(track.interpolation ?? 'LINEAR')) {
    throw new RangeError(`An easing applies to a LINEAR or SMOOTH track; this ${track.property} track is ${track.interpolation}.`);
  }
  try {
    parseEasing(easing);
  } catch {
    throw new RangeError(`Easing "${String(easing)}" is not one Crucible knows. Use ${EASING_HELP}.`);
  }
  return easing.trim();
}

/**
 * The tracks with the property's key at `time` changed by `patch` ({ time, value, easing }); a field left out stays as it is,
 * `easing: null` removes the easing. A key already at the new time on that track is replaced.
 */
export function editPropertyKey(tracks, nodeId, property, time, patch) {
  const nextTracks = tracks.map(track => structuredClone(track));
  const track = findPropertyTrack(nextTracks, nodeId, property);
  const index = requireKey(track, nodeId, property, time);
  const [keyframe] = track.keyframes.splice(index, 1);
  if (patch.value !== undefined) {
    keyframe.value = checkedValue(property, patch.value);
  }
  if (patch.easing !== undefined) {
    const easing = checkedEasing(track, patch.easing);
    if (easing === undefined) {
      delete keyframe.easing;
    } else {
      keyframe.easing = easing;
    }
  }
  if (patch.time !== undefined) {
    keyframe.time = patch.time;
    const occupiedIndex = keyIndexAt(track.keyframes, patch.time);
    if (occupiedIndex >= 0) {
      track.keyframes.splice(occupiedIndex, 1);
    }
  }
  track.keyframes.push(keyframe);
  track.keyframes.sort((first, second) => first.time - second.time);
  return nextTracks;
}

/** The tracks without the property's key at `time`; a track left with no key is dropped. */
export function removePropertyKey(tracks, nodeId, property, time) {
  const nextTracks = tracks.map(track => structuredClone(track));
  const track = findPropertyTrack(nextTracks, nodeId, property);
  const index = requireKey(track, nodeId, property, time);
  track.keyframes.splice(index, 1);
  return nextTracks.filter(candidate => candidate.keyframes.length > 0);
}

/**
 * The controller's per-property key actions, built on its own helpers (`host`): `recipe()`, `requireNode(recipe, nodeId)`,
 * `commitNodeTracks(recipe, tracks, duration, nodeId)` (one undo step), `validatedKeyTime(time, label)`, `motionTime()`,
 * `nodePose(nodeId)` and `selectedNodeId()`.
 */
export function createPropertyKeyActions(host) {
  const tracksOf = recipe => recipe.motion?.tracks ?? [];
  return {
    /** The node's animated properties with their keys ({ property, canEase, keys: [{ time, value, easing }] }), for the timeline rows. */
    nodePropertyKeys(nodeId = host.selectedNodeId()) {
      return propertyKeysOf(tracksOf(host.recipe()), nodeId);
    },
    /** Puts a key on one property at the playhead from the pose shown there, or removes it when one is already there. Returns true when a key was added. */
    togglePropertyKeyframe(nodeId, property) {
      const recipe = host.recipe();
      host.requireNode(recipe, nodeId);
      if (!POSE_PROPERTIES.includes(property)) {
        throw new RangeError(`Property must be one of ${POSE_PROPERTIES.join(', ')}, got ${JSON.stringify(property)}.`);
      }
      const time = host.motionTime();
      if (propertyKeyAt(tracksOf(recipe), nodeId, property, time)) {
        host.commitNodeTracks(recipe, removePropertyKey(tracksOf(recipe), nodeId, property, time), recipe.motion.duration, nodeId);
        return false;
      }
      const tracks = upsertNodeKeyframeTrack(tracksOf(recipe), nodeId, property, time, host.nodePose(nodeId)[property]);
      host.commitNodeTracks({ ...recipe, motion: { loop: true, ...recipe.motion } }, tracks, Math.max(4, recipe.motion?.duration ?? 4, time), nodeId);
      return true;
    },
    /** Changes the key of a property at `time` ({ time, value, easing }; a field left out stays) as one undo step. */
    updatePropertyKeyframe(nodeId, property, time, patch) {
      const recipe = host.recipe();
      host.requireNode(recipe, nodeId);
      const edit = { ...patch };
      if (edit.time !== undefined) {
        edit.time = host.validatedKeyTime(edit.time, 'patch.time');
      }
      const tracks = editPropertyKey(tracksOf(recipe), nodeId, property, host.validatedKeyTime(time, 'time'), edit);
      return host.commitNodeTracks(recipe, tracks, Math.max(recipe.motion.duration ?? 0, edit.time ?? 0), nodeId);
    },
    /** Deletes the key of one property at `time` as one undo step; a track left empty is removed. */
    deletePropertyKeyframe(nodeId, property, time) {
      const recipe = host.recipe();
      host.requireNode(recipe, nodeId);
      const tracks = removePropertyKey(tracksOf(recipe), nodeId, property, host.validatedKeyTime(time, 'time'));
      return host.commitNodeTracks(recipe, tracks, recipe.motion?.duration, nodeId);
    },
  };
}
