import { OWN_SECTIONS } from './agent-apply-report.js';

// Undo and redo restore a recipe the scene already holds almost all of. When the two recipes differ only in things an
// existing scene operation can set in place, those operations are cheaper than building the whole scene again.
// With `allowRecordChanges` (an undo or redo step) records may be removed anywhere or added at the end of a list; anything else (a record inserted in the middle, a changed
// geometry, a field that would have to be removed) returns null.

const NESTED_MERGE_FIELDS = Object.freeze({ environment: 'volumeFog', effects: 'bloom' });
const MERGED_SECTIONS = Object.freeze({ environment: 'set-environment', effects: 'set-effects', shadow: 'set-shadow' });
const SECTION_OPERATIONS = Object.freeze(Object.fromEntries(Object.entries(OWN_SECTIONS).map(([type, section]) => [section, type])));
const COMPARED_RECIPE_KEYS = new Set(['nodes', 'materials', 'geometries', 'camera', ...Object.keys(MERGED_SECTIONS), ...Object.values(OWN_SECTIONS)]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality of two JSON-like values, ignoring key order. */
export function sameRecipeValue(left, right) {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameRecipeValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length && leftKeys.every(key => Object.hasOwn(right, key) && sameRecipeValue(left[key], right[key]));
  }
  return false;
}

/** The fields of `target` that differ from `current`, or null when a field of `current` is missing from `target` (a patch cannot remove it). */
function changedFields(current, target) {
  if (!isPlainObject(current) || !isPlainObject(target)) {
    return null;
  }
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(target, key)) {
      return null;
    }
  }
  const patch = {};
  for (const [key, value] of Object.entries(target)) {
    if (!sameRecipeValue(current[key], value)) {
      patch[key] = value;
    }
  }
  return patch;
}

function recordIds(records) {
  const ids = records.map(record => record?.id);
  return ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length ? ids : null;
}

// The target list is the current one with some records removed and new ones added at the tail. An insertion in the
// middle, a reorder, or records without unique IDs have no operations that express them.
function planRecordChanges(currentRecords, targetRecords) {
  if (!Array.isArray(currentRecords) || !Array.isArray(targetRecords)) {
    return null;
  }
  const currentIds = recordIds(currentRecords);
  const targetIds = recordIds(targetRecords);
  if (!currentIds || !targetIds) {
    return null;
  }
  const targetIdSet = new Set(targetIds);
  const kept = currentRecords.filter(record => targetIdSet.has(record.id));
  const removed = currentRecords.filter(record => !targetIdSet.has(record.id));
  if (!kept.every((record, index) => record.id === targetIds[index])) {
    return null;
  }
  return { kept, removed, added: targetRecords.slice(kept.length) };
}

function patchOperations(setType, keptRecords, targetRecords) {
  const operations = [];
  for (let index = 0; index < keptRecords.length; index += 1) {
    const current = keptRecords[index];
    const target = targetRecords[index];
    if (current === target || sameRecipeValue(current, target)) {
      continue;
    }
    // Geometries have no set operation, so a changed one is rebuilt.
    const patch = setType ? changedFields(current, target) : null;
    if (patch === null) {
      return null;
    }
    operations.push({ type: setType, id: target.id, ...patch });
  }
  return operations;
}

// Removing a node that still has children is refused, so removed children go before their parents.
function childrenFirst(removedNodes, currentNodes) {
  const parentById = new Map(currentNodes.map(node => [node.id, node.parent]));
  const depthOf = id => {
    let depth = 0;
    for (let parent = parentById.get(id); parent !== undefined && depth <= currentNodes.length; parent = parentById.get(parent)) {
      depth += 1;
    }
    return depth;
  };
  return removedNodes
    .map(node => ({ node, depth: depthOf(node.id) }))
    .sort((first, second) => second.depth - first.depth)
    .map(entry => entry.node);
}

function recordListOperations(kind, currentRecords, targetRecords, allowRecordChanges) {
  const plan = planRecordChanges(currentRecords, targetRecords);
  const changesRecords = plan !== null && (plan.removed.length > 0 || plan.added.length > 0);
  const patches = plan && (allowRecordChanges || !changesRecords) && patchOperations(kind.set, plan.kept, targetRecords);
  if (!patches) {
    return null;
  }
  const removed = kind.orderRemoved ? kind.orderRemoved(plan.removed, currentRecords) : plan.removed;
  return {
    removals: removed.map(record => ({ type: kind.remove, id: record.id })),
    patches,
    additions: plan.added.map(record => ({ type: kind.add, [kind.field]: record })),
  };
}

const NODE_RECORDS = Object.freeze({ set: 'set-node', remove: 'remove-node', add: 'add-node', field: 'node', orderRemoved: childrenFirst });
const MATERIAL_RECORDS = Object.freeze({ set: 'set-material', remove: 'remove-material', add: 'add-material', field: 'material' });
const GEOMETRY_RECORDS = Object.freeze({ set: null, remove: 'remove-geometry', add: 'add-geometry', field: 'geometry' });

function mergedSectionOperation(section, current, target) {
  const patch = changedFields(current, target);
  if (patch === null) {
    return null;
  }
  const nestedField = NESTED_MERGE_FIELDS[section];
  if (nestedField && Object.hasOwn(patch, nestedField)) {
    const nestedPatch = changedFields(current[nestedField], target[nestedField]);
    if (nestedPatch === null) {
      return null;
    }
    patch[nestedField] = nestedPatch;
  }
  if (section === 'environment' && Object.hasOwn(patch, 'sky') && changedFields(current.sky, target.sky) === null) {
    return null;
  }
  return Object.keys(patch).length === 0 ? [] : [{ type: MERGED_SECTIONS[section], [section]: patch }];
}

function mergedSectionOperations(currentRecipe, targetRecipe) {
  const operations = [];
  for (const section of Object.keys(MERGED_SECTIONS)) {
    if (sameRecipeValue(currentRecipe[section], targetRecipe[section])) {
      continue;
    }
    const sectionOperations = mergedSectionOperation(section, currentRecipe[section], targetRecipe[section]);
    if (sectionOperations === null) {
      return null;
    }
    operations.push(...sectionOperations);
  }
  return operations;
}

function ownSectionOperations(currentRecipe, targetRecipe) {
  const operations = [];
  for (const [section, type] of Object.entries(SECTION_OPERATIONS)) {
    if (sameRecipeValue(currentRecipe[section], targetRecipe[section])) {
      continue;
    }
    // Clearing a section leaves `section: null` in the scene's recipe, which is not the recipe being restored.
    if (targetRecipe[section] === undefined) {
      return null;
    }
    operations.push({ type, [section]: targetRecipe[section] });
  }
  return operations;
}

function cameraOperations(currentCamera, targetCamera) {
  if (sameRecipeValue(currentCamera, targetCamera)) {
    return [];
  }
  if (!isPlainObject(targetCamera)) {
    return null;
  }
  // A lens given as a focal length replaces a field of view, so a field the target lacks is not always a reason to
  // rebuild: the whole target camera is sent, and the caller's recipe check catches a field that stays behind.
  const patch = changedFields(currentCamera, targetCamera);
  return [{ type: 'set-camera', ...(patch ?? targetCamera) }];
}

function otherKeysMatch(currentRecipe, targetRecipe) {
  const keys = new Set([...Object.keys(currentRecipe), ...Object.keys(targetRecipe)]);
  for (const key of keys) {
    if (!COMPARED_RECIPE_KEYS.has(key) && !sameRecipeValue(currentRecipe[key], targetRecipe[key])) {
      return false;
    }
  }
  return true;
}

/**
 * The scene operations that turn `currentRecipe` into `targetRecipe` in place, or null when the scene must be built again.
 * Returns an empty list when the recipes already match. The caller still checks the result by exporting the recipe.
 */
export function operationsBetweenRecipes(currentRecipe, targetRecipe, { allowRecordChanges = false } = {}) {
  if (!isPlainObject(currentRecipe) || !isPlainObject(targetRecipe) || !otherKeysMatch(currentRecipe, targetRecipe)) {
    return null;
  }
  const nodes = recordListOperations(NODE_RECORDS, currentRecipe.nodes, targetRecipe.nodes, allowRecordChanges);
  const materials = recordListOperations(MATERIAL_RECORDS, currentRecipe.materials, targetRecipe.materials, allowRecordChanges);
  const geometries = recordListOperations(GEOMETRY_RECORDS, currentRecipe.geometries ?? [], targetRecipe.geometries ?? [], allowRecordChanges);
  const camera = cameraOperations(currentRecipe.camera, targetRecipe.camera);
  const mergedOperations = mergedSectionOperations(currentRecipe, targetRecipe);
  if (!nodes || !materials || !geometries || !camera || !mergedOperations) {
    return null;
  }
  const sectionOperations = ownSectionOperations(currentRecipe, targetRecipe);
  if (!sectionOperations) {
    return null;
  }
  return [
    ...nodes.removals,
    ...materials.removals,
    ...geometries.removals,
    ...materials.patches,
    ...nodes.patches,
    ...camera,
    ...mergedOperations,
    ...sectionOperations,
    ...geometries.additions,
    ...materials.additions,
    ...nodes.additions,
  ];
}
