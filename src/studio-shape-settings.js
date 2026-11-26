// Shape settings: the fields of a basic shape in the node panel. Studio keeps the recipe, so the fields stay for as long as the
// geometry is still the shape's own description. They write the geometry fields that agents write, so a shape edited here opens the same over MCP.
//
// A shape's size is its node's scale (Transform), not a geometry field, so only what the recipe's geometry types carry is here:
// segments, rings, bevel, radii, subdivisions. The ranges repeat the checks of geometry.js and agent-scene.js, which stay the
// authority; tests/studio-shape-settings.test.js applies each bound to the real validator, so a drift fails there.

import { MIXED_PROPERTY_LABEL, batchShapeChangeOperations, summarizeShapeSelection } from './studio-multi-edit.js';

const WHOLE = true;

function wholeField(id, label, defaultValue, min, max) {
  return Object.freeze({ id, label, defaultValue, min, max, whole: WHOLE, step: 1 });
}

function decimalField(id, label, defaultValue, min, max, step = 0.01, extra = {}) {
  return Object.freeze({ id, label, defaultValue, min, max, whole: false, step, ...extra });
}

const SEGMENTS = (defaultValue, label = 'Segments') => wholeField('segments', label, defaultValue, 3, 2048);

/** The fields each shape type shows, in order, with the value the recipe uses when it writes none. */
export const SHAPE_SETTINGS = Object.freeze({
  box: Object.freeze([
    decimalField('bevel', 'Bevel', 0.08, 0, 0.5, 0.01),
    wholeField('subdivisions', 'Subdivisions', 6, 1, 128),
  ]),
  cylinder: Object.freeze([
    SEGMENTS(80),
    decimalField('bevel', 'Bevel', 0.025, 0, 0.5, 0.005),
    wholeField('bevelSegments', 'Bevel segments', 6, 1, 128),
  ]),
  sphere: Object.freeze([SEGMENTS(64), wholeField('rings', 'Rings', 40, 2, 2048)]),
  cone: Object.freeze([
    decimalField('radiusTop', 'Top radius', 0, 0, Infinity),
    decimalField('radiusBottom', 'Bottom radius', 1, 0, Infinity),
    SEGMENTS(64),
  ]),
  icoSphere: Object.freeze([wholeField('subdivisions', 'Subdivisions', 2, 0, 7)]),
  circle: Object.freeze([
    SEGMENTS(64),
    decimalField('innerRadius', 'Inner radius', 0, 0, 1, 0.01, { upperBoundExcluded: true }),
  ]),
  torus: Object.freeze([
    decimalField('tubeRadius', 'Tube radius', 0.08, 0, Infinity, 0.01, { lowerBoundExcluded: true }),
    SEGMENTS(96),
    wholeField('sides', 'Sides', 24, 3, 128),
  ]),
  plane: Object.freeze([wholeField('segments', 'Segments', 16, 1, 64)]),
  grid: Object.freeze([wholeField('segments', 'Segments', 16, 1, 64)]),
});

export const MESH_EDITED_REASON = 'Edited in edit mode, so it is no longer a parametric shape. Undo the edit to get its settings back.';

/** The fields a geometry shows, or null for a geometry that is not a basic shape. */
export function shapeFieldsOf(geometry) {
  return geometry && Object.hasOwn(SHAPE_SETTINGS, geometry.type) ? SHAPE_SETTINGS[geometry.type] : null;
}

/** The number a field shows for a geometry: what the recipe writes, else the value the shape builds with. */
export function shapeFieldValue(geometry, field) {
  return geometry[field.id] ?? field.defaultValue;
}

function describeRange(field) {
  const lower = field.min;
  if (field.whole) {
    return `a whole number from ${lower} to ${field.max}`;
  }
  if (field.lowerBoundExcluded) {
    return 'a number above 0';
  }
  if (field.upperBoundExcluded) {
    return `a number from ${lower} up to but not including ${field.max}`;
  }
  return Number.isFinite(field.max) ? `a number from ${lower} to ${field.max}` : `a number of ${lower} or more`;
}

/**
 * The number a person typed in a field, or a RangeError that says what to type. Anything that is not a number is refused,
 * so a half-typed value never reaches the recipe.
 */
export function checkedShapeValue(field, typed) {
  const text = String(typed ?? '').trim();
  const value = text === '' ? Number.NaN : Number(text);
  const refusal = new RangeError(`${field.label} must be ${describeRange(field)}, such as ${field.whole ? field.min : field.defaultValue}.`);
  if (!Number.isFinite(value) || (field.whole && !Number.isInteger(value))) {
    throw refusal;
  }
  const belowRange = field.lowerBoundExcluded ? value <= field.min : value < field.min;
  const aboveRange = field.upperBoundExcluded ? value >= field.max : value > field.max;
  if (belowRange || aboveRange) {
    throw refusal;
  }
  return value;
}

function shapeSettingsOfNode(recipe, nodeId) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  const geometry = node?.geometry === undefined ? null : recipe.geometries.find(candidate => candidate.id === node.geometry);
  return { node, geometry };
}

/** What the section shows for a node: its fields, the reason they are gone, or nothing for a node that is no basic shape. */
export function shapeSectionOf(recipe, nodeId) {
  const { geometry } = shapeSettingsOfNode(recipe, nodeId);
  const fields = shapeFieldsOf(geometry);
  if (fields) {
    return { fields, geometry };
  }
  if (geometry?.type === 'mesh') {
    return { reason: MESH_EDITED_REASON };
  }
  return null;
}

function uniqueGeometryId(recipe, wanted) {
  const taken = new Set(recipe.geometries.map(geometry => geometry.id));
  let candidate = wanted;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${wanted}-${suffix}`;
  }
  return candidate;
}

/**
 * The operations that rebuild the shape of one node with one field changed. A shape the node owns is replaced in place, keeping its
 * id; a geometry other nodes use gets a copy for this node, so the others keep their shape.
 */
export function shapeChangeOperations(recipe, nodeId, fieldId, value) {
  const { geometry } = shapeSettingsOfNode(recipe, nodeId);
  const fields = shapeFieldsOf(geometry);
  const field = fields?.find(candidate => candidate.id === fieldId);
  if (!field) {
    throw new RangeError(`Node "${nodeId}" has no shape setting "${fieldId}". Select a basic shape (box, cylinder, sphere, cone, ico sphere, circle, torus or plane) and use one of its fields.`);
  }
  const changed = { ...geometry, [fieldId]: checkedShapeValue(field, value) };
  const sharing = recipe.nodes.filter(candidate => candidate.geometry === geometry.id).length > 1;
  if (!sharing) {
    return [{ type: 'remove-geometry', id: geometry.id }, { type: 'add-geometry', geometry: changed }];
  }
  const copyId = uniqueGeometryId(recipe, `${geometry.id}-${nodeId}`);
  return [{ type: 'add-geometry', geometry: { ...changed, id: copyId } }, { type: 'set-node', id: nodeId, geometry: copyId }];
}

/** Rebuilds the selected shape (or shapes) with one field changed, as one undo step. Throws what to type when the value is refused. */
export function changeShapeSetting(controller, nodeIds, fieldId, value) {
  const targets = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  const recipe = controller.exportRecipe();
  const operations = targets.length === 1
    ? shapeChangeOperations(recipe, targets[0], fieldId, value)
    : batchShapeChangeOperations(recipe, targets, fieldId, value, { shapeFieldsOf, checkedShapeValue });
  controller.applyImportOperations(operations, { detail: { kind: 'topology', nodeId: targets[0] } });
}

/** The rows of the node panel for a basic shape: its fields, or the reason they are gone once the shape was edited as a mesh. */
export function createShapeSettings({ documentReference, createElement, createPropertyLine, controller, announce }) {
  const title = createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Shape' });
  const rows = createElement(documentReference, 'div', { className: 'crucible-studio-shape-rows' });
  const reason = createElement(documentReference, 'p', { className: 'crucible-studio-shape-reason', hidden: true });
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-shape-settings', dataset: { shapeSettings: 'true' } }, title, rows, reason);
  element.hidden = true;
  let shownKey = null;
  let inputs = new Map();

  function refuse(error) {
    announce(error.message);
    syncFromRecipe();
  }

  function createRow(field) {
    const input = createElement(documentReference, 'input', {
      type: 'number',
      min: String(field.min),
      step: String(field.step),
      attributes: { 'aria-label': field.label },
    });
    if (Number.isFinite(field.max)) {
      input.max = String(field.max);
    }
    input.addEventListener('change', () => {
      try {
        const targets = controller.selectedNodeIds.length > 0 ? controller.selectedNodeIds : [controller.selectedNodeId];
        changeShapeSetting(controller, targets, field.id, input.value);
      } catch (error) {
        refuse(error);
      }
    });
    inputs.set(field.id, input);
    return createPropertyLine(documentReference, createElement, field.label, input);
  }

  function syncFromRecipe() {
    const summary = summarizeShapeSelection(
      controller.exportRecipe(),
      controller.selectedNodeIds,
      controller.selectedNodeId,
      { shapeFieldsOf, shapeFieldValue },
    );
    element.hidden = summary === null;
    if (summary === null) {
      shownKey = null;
      return;
    }
    reason.hidden = !summary.meshEdited;
    reason.textContent = summary.meshEdited ? MESH_EDITED_REASON : '';
    const key = summary.fields ? `${summary.nodeIds.join(',')}:${summary.shapeType}` : `${summary.nodeIds.join(',')}:reason`;
    if (key !== shownKey) {
      shownKey = key;
      inputs = new Map();
      rows.replaceChildren(...(summary.fields ?? []).map(createRow));
    }
    for (const field of summary.fields ?? []) {
      const input = inputs.get(field.id);
      const isMixed = summary.mixedFields.has(field.id);
      input.dataset.mixed = isMixed ? 'true' : 'false';
      input.placeholder = isMixed ? MIXED_PROPERTY_LABEL : '';
      input.value = isMixed ? '' : String(shapeFieldValue(summary.geometry, field));
    }
  }

  return { element, sync: syncFromRecipe };
}
