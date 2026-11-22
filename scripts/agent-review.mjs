import { validateBranchName } from '../src/agent-branches.js';

export const REVIEW_LIMITS = Object.freeze({ minimumShots: 1, maximumShots: 4,
  minimumDimension: 64, maximumDimension: 480, defaultWidth: 384, defaultHeight: 384,
  labelHeight: 24, maximumLabelLength: 48, maximumGridWidth: 960, maximumGridHeight: 1008,
  maximumImageBytes: 1024 * 1024, maximumPendingFrames: 1 });

// A review camera is a view plus a projection: its field of view is in degrees, so the lens fields of a scene camera have no place here.
const CAMERA_FIELD_HINTS = Object.freeze({
  focalLength: 'pass fov in degrees instead, such as fov 45',
  sensorWidth: 'pass fov in degrees instead, such as fov 45',
});

function fields(value, allowed, name) {
  const subject = name === 'review' ? 'Review' : `Review ${name}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object with the fields ${allowed.join(', ')}.`);
  }
  const rejected = Object.keys(value).filter(key => !allowed.includes(key));
  if (rejected.length === 0) return;
  const reasons = rejected.map(key => (name === 'camera' && CAMERA_FIELD_HINTS[key] ? `${key} (${CAMERA_FIELD_HINTS[key]})` : key));
  throw new TypeError(`${subject} field${rejected.length > 1 ? 's' : ''} not accepted: ${reasons.join('; ')}. ${subject} takes ${allowed.join(', ')}; remove the others.`);
}

/** The message of a review that ran out of time: how far it got and what to ask for instead. */
export function reviewDeadlineMessage({ completedShots, requestedShots, deadlineSeconds }) {
  const fits = Math.max(1, completedShots);
  const advice = requestedShots > 1 && fits < requestedShots
    ? `Ask for at most ${fits} shot${fits === 1 ? '' : 's'} per call, or lower width and height, or leave labels off.`
    : 'Lower width and height, leave labels off, or review a simpler scene.';
  return `The review exceeded its total ${deadlineSeconds} second deadline after ${completedShots} of ${requestedShots} shots. ${advice}`;
}

function clock(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new RangeError(`${name} must be finite and within zero and 3600.`);
  }
  return value;
}

const REVIEW_CAMERA_FIELDS = ['eye', 'target', 'up', 'fov', 'near', 'far', 'projection', 'orthoScale'];
const REVIEW_VECTOR_FIELDS = ['eye', 'target', 'up'];
const REVIEW_PROJECTIONS = ['perspective', 'orthographic'];

function isFloat32Number(value) {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

/** Eye, target and up are three finite numbers, the other fields one; projection is a name and orthoScale a positive size. */
function validateReviewCamera(camera) {
  for (const [field, value] of Object.entries(camera)) {
    if (field === 'projection') {
      if (!REVIEW_PROJECTIONS.includes(value)) {
        throw new RangeError(`Review camera projection must be one of ${REVIEW_PROJECTIONS.join(', ')}; got ${JSON.stringify(value)}.`);
      }
      continue;
    }
    const isVector = REVIEW_VECTOR_FIELDS.includes(field);
    const components = isVector ? value : [value];
    if (!Array.isArray(components) || components.length !== (isVector ? 3 : 1) || !components.every(isFloat32Number)) {
      throw new RangeError('Shot camera must contain finite Float32 values.');
    }
    if (field === 'orthoScale' && !(value > 0)) {
      throw new RangeError('Review camera orthoScale must be above 0, such as orthoScale 8.');
    }
  }
}

/** The shader time of a shot: the one asked for, else the shot's own time so a post pass that reads `time` moves with the pose, else zero. */
function shotRendererTime(shot) {
  if (shot.rendererTime !== undefined) return clock(shot.rendererTime, 'Renderer time');
  const sampledTime = shot.motionTime ?? shot.animation?.time ?? 0;
  return clock(sampledTime, 'Renderer time');
}

/** Shots of one scene render together: the source scene, or one branch each. */
function groupShotsByBranch(shots) {
  const groups = new Map();
  for (const [index, shot] of shots.entries()) {
    if (!groups.has(shot.branch)) groups.set(shot.branch, { branch: shot.branch, shotIndexes: [] });
    groups.get(shot.branch).shotIndexes.push(index);
  }
  return [...groups.values()];
}

/** Validate before leasing the source renderer. Camera relationships use the sampled pose. */
export function normalizeReview(input) {
  fields(input, ['sessionId', 'expectedRevision', 'width', 'height', 'shots', 'labels', 'checks'], 'review');
  if (input.checks !== undefined && input.checks !== 'realism') throw new TypeError('Review checks must be "realism" (the only check set), or omitted.');
  if (input.labels !== undefined && typeof input.labels !== 'boolean') throw new TypeError('Review labels must be boolean.');
  if (typeof input.sessionId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError('Review requires a sessionId and a safe nonnegative expectedRevision.');
  }
  const width = input.width === undefined ? REVIEW_LIMITS.defaultWidth : input.width;
  const height = input.height === undefined ? REVIEW_LIMITS.defaultHeight : input.height;
  if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 480)) {
    throw new RangeError('Review dimensions must be integers from 64 to 480.');
  }
  if (!Array.isArray(input.shots) || input.shots.length < 1 || input.shots.length > 4) {
    throw new RangeError('Review requires one to four shots.');
  }
  const shots = input.shots.map((shot, index) => {
    fields(shot, ['label', 'camera', 'animation', 'motionTime', 'rendererTime', 'branch'], 'shot');
    if (shot.branch !== undefined) {
      validateBranchName(shot.branch);
      if (shot.animation !== undefined) throw new TypeError('A branch shot cannot sample an imported animation.');
    }
    if (shot.label !== undefined && (typeof shot.label !== 'string' || shot.label.length > 48)) {
      throw new TypeError('Shot label must be a string of at most 48 characters.');
    }
    if (shot.camera !== undefined) {
      fields(shot.camera, REVIEW_CAMERA_FIELDS, 'camera');
      validateReviewCamera(shot.camera);
    }
    if (shot.animation !== undefined) {
      fields(shot.animation, ['clip', 'time'], 'animation');
      if (!Number.isSafeInteger(shot.animation.clip) || shot.animation.clip < 0) throw new RangeError('Invalid animation clip.');
      clock(shot.animation.time, 'Animation time');
    }
    const motionTime = shot.motionTime ?? null;
    if (motionTime !== null) clock(motionTime, 'Motion time');
    return { label: shot.label ?? shot.branch ?? `View ${index + 1}`,
      ...(shot.branch === undefined ? {} : { branch: shot.branch }),
      ...(shot.camera === undefined ? {} : { camera: structuredClone(shot.camera) }),
      ...(shot.animation === undefined ? {} : { animation: structuredClone(shot.animation) }),
      motionTime, rendererTime: shotRendererTime(shot) };
  });
  const columns = shots.length > 1 ? 2 : 1;
  const groups = groupShotsByBranch(shots);
  return { sessionId: input.sessionId, expectedRevision: input.expectedRevision, width, height, shots, groups,
    branchNames: [...new Set(shots.flatMap(shot => shot.branch === undefined ? [] : [shot.branch]))],
    labels: input.labels === true, checks: input.checks,
    gridWidth: width * columns, gridHeight: (height + REVIEW_LIMITS.labelHeight) * Math.ceil(shots.length / columns), columns };
}
