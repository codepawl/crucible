import { invalidField } from './field-error.js';

/**
 * Clearing an optional field: scene_apply set-camera, set-environment and set-effects take null to put a field back to "not set".
 * A required field has no unset state, so null on it is refused with what to pass instead.
 */

// Camera fields a recipe may leave out; the rest (eye, target, up, fov, near, far) always have a value.
const CLEARABLE_CAMERA_FIELDS = Object.freeze(['projection', 'orthoScale', 'focalLength', 'sensorWidth', 'shift', 'fStop', 'focusDistance']);
// Clearing one camera field takes the fields that only make sense beside it.
const CAMERA_FIELDS_CLEARED_WITH = Object.freeze({
  projection: ['orthoScale'],
  focalLength: ['sensorWidth'],
  fStop: ['focusDistance'],
});

function refuseClearing(path, field, defaultValue) {
  throw invalidField(path, null, `a value: ${field} is required and cannot be cleared to null; pass the value you want, such as ${JSON.stringify(defaultValue)} (its default)`);
}

/** The camera fields a set-camera operation clears, with the fields that depend on them. Throws for a required field given null. */
export function cameraFieldsToClear(fields, requiredDefaults) {
  const cleared = new Set();
  for (const [field, value] of Object.entries(fields)) {
    if (value !== null) continue;
    if (!CLEARABLE_CAMERA_FIELDS.includes(field)) {
      if (Object.hasOwn(requiredDefaults, field)) refuseClearing(`camera.${field}`, field, requiredDefaults[field]);
      continue;
    }
    cleared.add(field);
    for (const dependent of CAMERA_FIELDS_CLEARED_WITH[field] ?? []) cleared.add(dependent);
  }
  return cleared;
}

/**
 * Splits the null entries off a set-environment or set-effects patch.
 * `requiredDefaults` is the section as normalised with nothing set: its keys have no unset state. `valueFields` accept null as their value
 * (fogDensity null means "no fog density override"), and `groupFields` are nested objects that return to their defaults when cleared.
 */
export function splitClearedLookFields(section, patch, { requiredDefaults, valueFields = [], groupFields = [] }) {
  const cleared = [];
  const kept = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value !== null || valueFields.includes(field)) {
      kept[field] = value;
    } else if (groupFields.includes(field) || !Object.hasOwn(requiredDefaults, field)) {
      cleared.push(field);
    } else {
      refuseClearing(`${section}.${field}`, field, requiredDefaults[field]);
    }
  }
  return { kept, cleared };
}

/** Merges a nested group patch (bloom, depthOfField, motionBlur, volumeFog) into the current group; null clears an optional nested field. */
export function mergeGroupPatch(group, current, patch, requiredDefaults) {
  const { kept, cleared } = splitClearedLookFields(group, patch, { requiredDefaults });
  const merged = { ...current, ...kept };
  for (const field of cleared) delete merged[field];
  return merged;
}
