// A recipe timeline: shots played one after another over the recipe's motion clock. Plain data and plain functions with
// no engine imports, so the MCP server (render jobs) and the scene (recipe validation) share one definition.
// Not a video sequence editor: no layers, no overlaps and no clip trimming. Shots cut, or dip through black.

export const FILM_TIMELINE_LIMITS = Object.freeze({
  maxShots: 64, maxTotalSeconds: 60, minShotSeconds: 0.1, maxShotSeconds: 30, maxDipSeconds: 4, maxMotionStart: 3600,
  maxMarkers: 256, maxBeatsPerMinute: 400,
});

const SHOT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
// A running sum of shot lengths can overshoot the motion by float rounding, as agent-motion-bake.js allows.
const MOTION_END_TOLERANCE = 1e-9;
// A frame time such as 9 / 30 = 0.3 can sit a hair below the running sum 0.1 + 0.2; it still belongs to the later shot, as
// videoFrameCount counts it.
const SHOT_BOUNDARY_TOLERANCE = 1e-9;
const SHOT_FIELDS = ['name', 'duration', 'endAt', 'motionStart', 'camera', 'dip', 'focusDistance', 'blur'];
const MAX_FOCUS_DISTANCE = 100000;
const MARKER_NAME_PATTERN = SHOT_NAME_PATTERN;
// A shot written with both `duration` and `endAt` (an exported recipe keeps both) must agree to a microsecond.
const END_AT_AGREEMENT_TOLERANCE = 1e-6;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unsupported field ${JSON.stringify(key.slice(0, 48))}.`);
  }
}

function numberBetween(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function hasAnimatedScene(recipe) {
  return Boolean(recipe?.motion || recipe?.physics || recipe?.cloth || recipe?.environment?.localVolumes?.some(volume => volume?.frames));
}

function checkedMarkerList(markers) {
  if (!Array.isArray(markers)) throw new TypeError('timeline.markers must be a list of { name, time }.');
  return markers.map((marker, index) => {
    plainObject(marker, `Marker ${index}`);
    rejectUnknownKeys(marker, ['name', 'time'], `Marker ${index}`);
    if (typeof marker.name !== 'string' || !MARKER_NAME_PATTERN.test(marker.name)) {
      throw new TypeError(`Marker ${index} name must be 1 to 24 letters, digits, - or _.`);
    }
    return { name: marker.name, time: numberBetween(marker.time, 0, FILM_TIMELINE_LIMITS.maxTotalSeconds, `Marker ${marker.name} time`) };
  });
}

/** The markers a beat grid stands for: `beat-0`, `beat-1` ... at offset + index * 60 / bpm seconds. */
export function beatGridMarkers(beatGrid) {
  plainObject(beatGrid, 'timeline.beatGrid');
  rejectUnknownKeys(beatGrid, ['bpm', 'offset', 'count'], 'timeline.beatGrid');
  const bpm = numberBetween(beatGrid.bpm, 1, FILM_TIMELINE_LIMITS.maxBeatsPerMinute, 'timeline.beatGrid bpm');
  const offset = beatGrid.offset === undefined ? 0 : numberBetween(beatGrid.offset, 0, FILM_TIMELINE_LIMITS.maxTotalSeconds, 'timeline.beatGrid offset');
  const count = numberBetween(beatGrid.count, 1, FILM_TIMELINE_LIMITS.maxMarkers, 'timeline.beatGrid count');
  if (!Number.isInteger(count)) throw new RangeError('timeline.beatGrid count must be a whole number.');
  const beats = [];
  for (let index = 0; index < count; index += 1) beats.push({ name: `beat-${index}`, time: offset + index * 60 / bpm });
  return beats.filter(beat => beat.time <= FILM_TIMELINE_LIMITS.maxTotalSeconds);
}

/** Named cue times: the listed `markers` and the beats of `beatGrid`, by name, sorted by time. */
export function filmTimelineMarkers(timeline) {
  const listed = timeline.markers ? checkedMarkerList(timeline.markers) : [];
  const beats = timeline.beatGrid ? beatGridMarkers(timeline.beatGrid) : [];
  const all = [...listed, ...beats];
  if (all.length > FILM_TIMELINE_LIMITS.maxMarkers) {
    throw new RangeError(`The timeline has ${all.length} markers; the most is ${FILM_TIMELINE_LIMITS.maxMarkers}.`);
  }
  const byName = new Map();
  for (const marker of all) {
    if (byName.has(marker.name)) throw new RangeError(`Marker name ${marker.name} is used twice.`);
    byName.set(marker.name, marker.time);
  }
  return byName;
}

function shotDuration(shot, markers, startSeconds) {
  if (shot.endAt === undefined) return numberBetween(shot.duration, FILM_TIMELINE_LIMITS.minShotSeconds, FILM_TIMELINE_LIMITS.maxShotSeconds, `Shot ${shot.name} duration`);
  if (!markers.has(shot.endAt)) {
    const known = [...markers.keys()].slice(0, 8).join(', ') || 'none; add timeline.markers or timeline.beatGrid';
    throw new RangeError(`Shot ${shot.name} endAt names marker ${JSON.stringify(String(shot.endAt).slice(0, 48))}, which does not exist. Known markers: ${known}.`);
  }
  const duration = markers.get(shot.endAt) - startSeconds;
  if (shot.duration !== undefined && !(Math.abs(shot.duration - duration) <= END_AT_AGREEMENT_TOLERANCE)) {
    throw new RangeError(`Shot ${shot.name} sets duration ${shot.duration} but endAt ${shot.endAt} makes it ${duration}. Give one of them.`);
  }
  return numberBetween(duration, FILM_TIMELINE_LIMITS.minShotSeconds, FILM_TIMELINE_LIMITS.maxShotSeconds, `Shot ${shot.name} duration up to marker ${shot.endAt}`);
}

/**
 * Validates and copies a timeline against its recipe. `checkCamera(cameraOverrides)` lets the caller reject camera
 * fields with the engine's own rules and return the cleaned copy; without it the camera is only checked for shape.
 */
export function normalizeFilmTimeline(timeline, recipe, { checkCamera } = {}) {
  plainObject(timeline, 'timeline');
  rejectUnknownKeys(timeline, ['shots', 'markers', 'beatGrid'], 'timeline');
  const markers = filmTimelineMarkers(timeline);
  const { shots } = timeline;
  if (!Array.isArray(shots) || shots.length < 1 || shots.length > FILM_TIMELINE_LIMITS.maxShots) {
    throw new RangeError(`timeline.shots must list 1 to ${FILM_TIMELINE_LIMITS.maxShots} shots.`);
  }
  const animated = hasAnimatedScene(recipe);
  const seenNames = new Set();
  let startSeconds = 0;
  let previousShotDuration = Infinity;
  const normalized = shots.map((shot, index) => {
    plainObject(shot, `Shot ${index}`);
    rejectUnknownKeys(shot, SHOT_FIELDS, `Shot ${index}`);
    if (typeof shot.name !== 'string' || !SHOT_NAME_PATTERN.test(shot.name)) {
      throw new TypeError(`Shot ${index} name must be 1 to 24 letters, digits, - or _.`);
    }
    if (seenNames.has(shot.name)) throw new RangeError(`Shot name ${shot.name} is used twice.`);
    seenNames.add(shot.name);
    const duration = shotDuration(shot, markers, startSeconds);
    const result = { name: shot.name, duration };
    if (shot.endAt !== undefined) result.endAt = shot.endAt;
    if (shot.motionStart !== undefined) {
      if (!animated) throw new RangeError(`Shot ${shot.name} sets motionStart but the recipe has no motion, physics or cloth.`);
      result.motionStart = numberBetween(shot.motionStart, 0, FILM_TIMELINE_LIMITS.maxMotionStart, `Shot ${shot.name} motionStart`);
    }
    if (animated && recipe.motion && !recipe.motion.loop) {
      const motionStart = result.motionStart ?? startSeconds;
      if (motionStart + duration > recipe.motion.duration + MOTION_END_TOLERANCE) {
        throw new RangeError(`Shot ${shot.name} reads motion up to ${motionStart + duration} s but the motion lasts ${recipe.motion.duration} s. Set motionStart, or make the motion loop.`);
      }
    }
    if (shot.dip !== undefined) {
      result.dip = numberBetween(shot.dip, 0.05, FILM_TIMELINE_LIMITS.maxDipSeconds, `Shot ${shot.name} dip`);
      const previousDuration = index === 0 ? Infinity : previousShotDuration;
      if (result.dip / 2 > duration || result.dip / 2 > previousDuration) {
        throw new RangeError(`Shot ${shot.name} dip is longer than twice the shots on either side of the cut.`);
      }
    }
    if (shot.camera !== undefined) {
      plainObject(shot.camera, `Shot ${shot.name} camera`);
      result.camera = checkCamera ? checkCamera(shot.camera) : { ...shot.camera };
    }
    if (shot.focusDistance !== undefined) {
      result.focusDistance = numberBetween(shot.focusDistance, 0.01, MAX_FOCUS_DISTANCE, `Shot ${shot.name} focusDistance`);
    }
    if (shot.blur !== undefined) {
      result.blur = numberBetween(shot.blur, 0, 1, `Shot ${shot.name} blur`);
    }
    startSeconds += duration;
    previousShotDuration = duration;
    return result;
  });
  if (startSeconds > FILM_TIMELINE_LIMITS.maxTotalSeconds) {
    throw new RangeError(`The timeline lasts ${startSeconds} s; the most is ${FILM_TIMELINE_LIMITS.maxTotalSeconds} s.`);
  }
  const result = { shots: normalized };
  if (timeline.markers) result.markers = checkedMarkerList(timeline.markers);
  if (timeline.beatGrid) result.beatGrid = { ...timeline.beatGrid };
  return result;
}

/** Frames needed for a duration. A sum such as 0.1 + 0.2 lands a hair above its exact value and must not gain a whole frame. */
export function videoFrameCount(fps, durationSeconds) {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`fps must be a number above 0, got ${String(fps)}.`);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new RangeError(`duration must be a number of seconds from 0, got ${String(durationSeconds)}.`);
  return Math.ceil(fps * durationSeconds - 1e-9);
}

export function filmTimelineDuration(timeline) {
  let total = 0;
  for (const shot of timeline.shots) total += shot.duration;
  return total;
}

/** Shots with their start times, summed in order so the same time always lands in the same shot. */
export function filmTimelineShotStarts(timeline) {
  let startSeconds = 0;
  return timeline.shots.map(shot => {
    const entry = { name: shot.name, start: startSeconds, duration: shot.duration };
    startSeconds += shot.duration;
    return entry;
  });
}

function brightnessAt(timeline, starts, index, shotTime) {
  let brightness = 1;
  const shot = timeline.shots[index];
  if (shot.dip !== undefined) brightness = Math.min(brightness, shotTime / (shot.dip / 2));
  const next = timeline.shots[index + 1];
  if (next?.dip !== undefined) {
    const remaining = starts[index].duration - shotTime;
    brightness = Math.min(brightness, remaining / (next.dip / 2));
  }
  return Math.max(0, Math.min(1, brightness));
}

function depthOfFieldOverrides(shot) {
  const overrides = {};
  if (shot.focusDistance !== undefined) overrides.focusDistance = shot.focusDistance;
  if (shot.blur !== undefined) overrides.blur = shot.blur;
  return Object.keys(overrides).length > 0 ? overrides : null;
}

/**
 * Everything one frame needs at timeline time `time`: the shot, the motion clock (null for a static recipe), the
 * camera overrides, the depth of field overrides (null keeps the recipe's) and the brightness of a dip through black. It keeps no state, so any seek gives the same answer.
 */
export function sampleFilmTimeline(timeline, recipe, time) {
  const starts = filmTimelineShotStarts(timeline);
  const total = filmTimelineDuration(timeline);
  if (!Number.isFinite(time) || time < 0 || time > total) {
    throw new RangeError(`Timeline time ${time} is outside 0 to ${total} s.`);
  }
  let index = starts.length - 1;
  for (let candidate = 0; candidate < starts.length; candidate++) {
    if (time < starts[candidate].start + starts[candidate].duration - SHOT_BOUNDARY_TOLERANCE) {
      index = candidate;
      break;
    }
  }
  const shot = timeline.shots[index];
  const shotTime = Math.max(0, time - starts[index].start);
  const motionTime = hasAnimatedScene(recipe) ? (shot.motionStart ?? starts[index].start) + shotTime : null;
  return {
    shotIndex: index, shotName: shot.name, shotTime, motionTime,
    camera: shot.camera ?? null, depthOfField: depthOfFieldOverrides(shot), brightness: brightnessAt(timeline, starts, index, shotTime),
  };
}
