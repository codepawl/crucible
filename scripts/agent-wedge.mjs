import { WEDGE_LIMITS, parseWedgeField, wedgeColumns, wedgeLabel } from '../src/agent-wedge.js';
import { invalidField } from '../src/field-error.js';
import { normalizeReview } from './agent-review.mjs';

const ALLOWED_INPUT = ['sessionId', 'expectedRevision', 'wedge', 'shots', 'width', 'height', 'labels'];
const ALLOWED_WEDGE = ['target', 'parameter', 'values'];

function requireKnownKeys(value, allowed, subject) {
  const rejected = Object.keys(value).filter(key => !allowed.includes(key));
  if (rejected.length > 0) {
    throw new TypeError(`${subject} field${rejected.length > 1 ? 's' : ''} not accepted: ${rejected.join(', ')}. ${subject} takes ${allowed.join(', ')}; remove the others.`);
  }
}

function dimension(value, name, fallback, maximum) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < WEDGE_LIMITS.minimumDimension || chosen > maximum) {
    throw invalidField(name, value, `an integer from ${WEDGE_LIMITS.minimumDimension} to ${maximum} for this many values`);
  }
  return chosen;
}

function requireValues(values) {
  if (!Array.isArray(values) || values.length < WEDGE_LIMITS.minimumValues || values.length > WEDGE_LIMITS.maximumValues) {
    const received = Array.isArray(values) ? values.length : values;
    throw invalidField('wedge.values', received, `a list of ${WEDGE_LIMITS.minimumValues} to ${WEDGE_LIMITS.maximumValues} values, such as [0.2, 0.5, 0.8]`);
  }
  for (const [index, value] of values.entries()) {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > WEDGE_LIMITS.maximumValueBytes) {
      throw invalidField(`wedge.values[${index}]`, value, `JSON of at most ${WEDGE_LIMITS.maximumValueBytes} bytes; pass a number, a text, a list or a small object`);
    }
  }
}

function requireWedge(wedge) {
  if (!wedge || typeof wedge !== 'object' || Array.isArray(wedge)) {
    throw new TypeError(`wedge must be an object with the fields ${ALLOWED_WEDGE.join(', ')}.`);
  }
  requireKnownKeys(wedge, ALLOWED_WEDGE, 'wedge');
  if (typeof wedge.target !== 'string' || wedge.target.length === 0 || wedge.target.length > 128) {
    throw invalidField('wedge.target', wedge.target, 'environment, effects, shadow or a material ID', TypeError);
  }
  parseWedgeField(wedge.parameter);
  requireValues(wedge.values);
}

/** The one shot a wedge shares, checked by the review rules; it may name a camera and a motionTime but no branch or animation. */
function sharedShot(input) {
  const shots = input.shots ?? [{}];
  if (!Array.isArray(shots) || shots.length !== 1) {
    throw invalidField('shots', Array.isArray(shots) ? shots.length : shots, 'at most one shot with a wedge, which gives the camera and motionTime shared by every picture');
  }
  const [shot] = shots;
  if (shot && (shot.branch !== undefined || shot.animation !== undefined)) {
    throw new TypeError('A wedge shot takes a label, camera, motionTime and rendererTime; remove branch and animation.');
  }
  const { shots: [checked] } = normalizeReview({ sessionId: input.sessionId, expectedRevision: input.expectedRevision, shots: [shot] });
  return checked;
}

/** Validate a wedge before the renderer is leased, and shape it as a review: one shot per value, each on its own variant name. */
export function normalizeWedge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Review must be an object with the fields ${ALLOWED_INPUT.join(', ')}.`);
  }
  requireKnownKeys(input, ALLOWED_INPUT, 'Review');
  if (typeof input.sessionId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError('Review requires a sessionId and a safe nonnegative expectedRevision.');
  }
  requireWedge(input.wedge);
  const shared = sharedShot(input);
  const values = input.wedge.values;
  const columns = wedgeColumns(values.length);
  const rows = Math.ceil(values.length / columns);
  const maximumWidth = Math.min(WEDGE_LIMITS.maximumDimension, Math.floor(WEDGE_LIMITS.maximumGridWidth / columns));
  const maximumHeight = Math.min(WEDGE_LIMITS.maximumDimension, Math.floor(WEDGE_LIMITS.maximumGridHeight / rows) - WEDGE_LIMITS.labelHeight);
  const width = dimension(input.width, 'width', Math.min(WEDGE_LIMITS.defaultDimension, maximumWidth), maximumWidth);
  const height = dimension(input.height, 'height', Math.min(WEDGE_LIMITS.defaultDimension, maximumHeight), maximumHeight);
  const variantNames = values.map((_, index) => `wedge-${index}`);
  const { label: _unused, ...template } = shared;
  const shots = values.map((value, index) => ({ ...structuredClone(template), label: wedgeLabel(input.wedge.parameter, value), branch: variantNames[index] }));
  const groups = shots.map((entry, index) => ({ branch: entry.branch, shotIndexes: [index] }));
  return {
    sessionId: input.sessionId, expectedRevision: input.expectedRevision, width, height, shots, groups, branchNames: [],
    labels: input.labels === true, columns, gridWidth: width * columns, gridHeight: (height + WEDGE_LIMITS.labelHeight) * rows,
    wedge: { target: input.wedge.target, parameter: input.wedge.parameter, values: structuredClone(values), variantNames },
  };
}
