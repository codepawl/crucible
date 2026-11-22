// The scene_review wedge option renders one field of a scene at several values in one labelled grid. This leaf module holds the plain data
// the MCP server, the runtime and the preview page share: the limits, the target sections and the operation that sets one value.

import { invalidField } from './field-error.js';

export const WEDGE_LIMITS = Object.freeze({ minimumValues: 2, maximumValues: 8, maximumValueBytes: 2048, maximumLabelLength: 48,
  maximumGridWidth: 960, maximumGridHeight: 1008, labelHeight: 24, minimumDimension: 64, maximumDimension: 480, defaultDimension: 320 });

/** Targets that name a section of the look. Any other target is a material ID. */
export const WEDGE_SECTIONS = Object.freeze({ environment: 'set-environment', effects: 'set-effects', shadow: 'set-shadow' });

const FIELD_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.([A-Za-z][A-Za-z0-9]*|\d{1,2}))*$/;

/** A field path such as "roughness", "lightDirection" or "pointLights.0.intensity", split into names and list indexes. */
export function parseWedgeField(field) {
  if (typeof field !== 'string' || !FIELD_PATH_PATTERN.test(field) || field.length > 64) {
    throw invalidField('parameter', field, 'a field name, optionally followed by .name or .index steps, such as "roughness", "lightDirection" or "pointLights.0.intensity"', TypeError);
  }
  return field.split('.').map(step => (/^\d+$/.test(step) ? Number(step) : step));
}

/** The column count of the grid for a number of values: two columns up to four values, then three, then four. */
export function wedgeColumns(valueCount) {
  if (valueCount <= 4) return 2;
  return valueCount <= 6 ? 3 : 4;
}

function setAtPath(root, steps, value, field) {
  let cursor = root;
  for (const step of steps.slice(0, -1)) {
    const next = cursor?.[step];
    if (next === null || typeof next !== 'object') {
      throw invalidField('parameter', field, `a path that exists in the scene: "${step}" is not set here, so set it first with scene_apply`, TypeError);
    }
    cursor = next;
  }
  cursor[steps.at(-1)] = value;
}

function sectionOrMaterial(target, recipe) {
  if (WEDGE_SECTIONS[target]) return recipe[target] ?? {};
  const material = (recipe.materials ?? []).find(candidate => candidate.id === target);
  if (material) return material;
  const ids = (recipe.materials ?? []).map(candidate => candidate.id).slice(0, 8).join(', ') || 'none yet';
  throw invalidField('target', target, `environment, effects, shadow or an existing material ID (${ids})`, TypeError);
}

/** The scene_apply operation that sets `field` of `target` to `value` in `recipe`. The recipe is read, never changed. */
export function wedgeOperation({ target, field, value }, recipe) {
  const steps = parseWedgeField(field);
  const top = steps[0];
  if (typeof top !== 'string') throw invalidField('parameter', field, 'a field name that starts with a letter', TypeError);
  const base = sectionOrMaterial(target, recipe);
  let patched = value;
  if (steps.length > 1) {
    patched = structuredClone(base[top]);
    if (patched === null || typeof patched !== 'object') {
      throw invalidField('parameter', field, `a field that is already a list or an object in ${target}; "${top}" is not, so name "${top}" alone and pass the whole value in each of values`, TypeError);
    }
    setAtPath({ [top]: patched }, steps, value, field);
  }
  const section = WEDGE_SECTIONS[target];
  if (section) return { type: section, [target]: { [top]: patched } };
  return { type: 'set-material', id: target, [top]: patched };
}

/** The label under one picture: the field and its value, cut to fit. */
export function wedgeLabel(field, value) {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const text = `${field}=${shown}`.replace(/[^\x20-\x7e]/g, '?');
  return text.length > WEDGE_LIMITS.maximumLabelLength ? `${text.slice(0, WEDGE_LIMITS.maximumLabelLength - 1)}~` : text;
}
