import { invalidField } from './field-error.js';
import { MAX_SELECTED_ELEMENTS } from './mesh-operations.js';

// Shared validation errors for the fields of one mesh edit. The path is edits[index].field, which the recipe and the
// edit-mesh operation both extend to a full path when the edit sits inside a geometry.

export function editField(index, field, value, expected, ErrorType = TypeError) {
  return invalidField(`edits[${index}].${field}`, value, expected, ErrorType);
}

export function editInteger(value, index, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw editField(index, label, value, `a whole number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

export function editBoolean(value, index, label) {
  if (value !== undefined && typeof value !== 'boolean') throw editField(index, label, value, 'true or false');
  return value;
}

const AXES = ['x', 'y', 'z'];

export function editAxis(value, index, label = 'axis') {
  if (!AXES.includes(value)) throw editField(index, label, value, 'one of "x", "y", "z"');
  return value;
}

export function editRuleObject(value, index, label, hint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw editField(index, label, value, hint);
  return value;
}

/**
 * Why a list of vertex pairs is not a valid { "edges": [[a, b], ...] } selection, or null when its shape is fine.
 * An edge is named by the two vertices it joins, which survives edits that renumber edges and reads the same to a person
 * and an agent. A pair named twice, or in both orders, counts once. Whether each pair is an edge of the mesh, and whether
 * its vertices exist, is checked against the mesh when the rule runs.
 */
export function edgePairProblem(pairs) {
  const expected = `an array of 1 to ${MAX_SELECTED_ELEMENTS} vertex pairs, such as [[0, 1], [1, 2]]`;
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_SELECTED_ELEMENTS) return expected;
  const valid = pairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(vertex => Number.isInteger(vertex) && vertex >= 0) && pair[0] !== pair[1]);
  return valid ? null : `${expected}, each two different whole vertex indices`;
}

/** An edge rule field: an object, and when it names vertex pairs, nothing else and well-formed pairs. */
export function editEdgeRule(value, index, label, hint) {
  const rule = editRuleObject(value, index, label, hint);
  if (rule.edges === undefined) return rule;
  const others = Object.keys(rule).filter(key => key !== 'edges');
  if (others.length > 0) throw editField(index, label, rule, `one form: { "edges": [[a, b], ...] } alone, or another edge rule without "edges"; remove ${others.join(', ')}`);
  const problem = edgePairProblem(rule.edges);
  if (problem) throw editField(index, `${label}.edges`, rule.edges, problem);
  return rule;
}

/** The field's value, or the fallback only when the field is left out; null is a wrong value that the check after this call rejects. */
export function editDefault(value, fallback) {
  return value === undefined ? fallback : value;
}
