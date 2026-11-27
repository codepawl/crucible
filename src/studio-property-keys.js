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
