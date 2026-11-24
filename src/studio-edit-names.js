// What the History list calls an edit. The name comes from the operations the edit applied, so every way of making the
// same edit (a handle, a field, an agent) reads the same in the list.

export const EDIT_LABEL_FALLBACK = 'Edit';

export const GIZMO_EDIT_LABELS = Object.freeze({ translate: 'Move', rotate: 'Rotate', scale: 'Scale' });

const OPERATION_LABELS = Object.freeze({
  'remove-node': 'Delete',
  'set-material': 'Change material',
  'add-material': 'Add material',
  'set-environment': 'Change environment',
  'set-effects': 'Change effects',
  'set-shadow': 'Change shadows',
  'set-camera': 'Move camera',
  'set-timeline': 'Edit shots',
  'set-motion': 'Edit animation',
});

// The operations that only support another one: a new object brings its geometry and material, a pose edit may key itself.
const SUPPORTING_TYPES = Object.freeze({
  'add-geometry': 'add-node',
  'add-material': 'add-node',
  'set-motion': null,
});

const NODE_FIELD_LABELS = Object.freeze([
  ['label', 'Rename'],
  ['parent', 'Change parent'],
  ['material', 'Change material'],
  ['castShadow', 'Change shadows'],
  ['receiveShadow', 'Change shadows'],
]);

function nameNodeChange(operation) {
  if (operation.visible !== undefined) {
    return operation.visible ? 'Show' : 'Hide';
  }
  const posed = ['translation', 'rotation', 'scale'].filter(field => operation[field] !== undefined);
  if (posed.length > 1) {
    return 'Transform';
  }
  if (posed.length === 1) {
    return { translation: 'Move', rotation: 'Rotate', scale: 'Scale' }[posed[0]];
  }
  const named = NODE_FIELD_LABELS.find(([field]) => operation[field] !== undefined);
  return named ? named[1] : EDIT_LABEL_FALLBACK;
}

function nameAddedNode(node) {
  const kind = String(node?.label ?? '').replace(/\s+\d+$/, '').trim().toLowerCase();
  return kind ? `Add ${kind}` : 'Add object';
}

function leadingOperation(operations) {
  const types = new Set(operations.map(operation => operation.type));
  return operations.find(operation => {
    if (!(operation.type in SUPPORTING_TYPES)) {
      return true;
    }
    const supported = SUPPORTING_TYPES[operation.type];
    return supported === null ? types.size === 1 : !types.has(supported);
  }) ?? operations[0];
}

/** The label of a node in a recipe, or its id when it has none; '' when the recipe has no such node. */
export function nodeLabelIn(recipe, nodeId) {
  const node = recipe?.nodes?.find(candidate => candidate.id === nodeId);
  return node ? String(node.label ?? node.id) : '';
}

/** What the edit acted on, read from the recipe before it ran: an object's label or a material's id; '' when the edit has no single target. */
export function nameEditTarget(operations, recipeBefore) {
  const leading = leadingOperation(operations);
  if (leading?.type === 'set-node' || leading?.type === 'remove-node') {
    return nodeLabelIn(recipeBefore, leading.id);
  }
  return leading?.type === 'set-material' ? String(leading.id) : '';
}

/** A short name for the edit that applied these scene operations, such as "Move", "Add cube" or "Change material". */
export function nameEditOperations(operations) {
  const leading = leadingOperation(operations);
  if (!leading) {
    return EDIT_LABEL_FALLBACK;
  }
  if (leading.type === 'set-node') {
    return nameNodeChange(leading);
  }
  if (leading.type === 'add-node') {
    return nameAddedNode(leading.node);
  }
  return OPERATION_LABELS[leading.type] ?? EDIT_LABEL_FALLBACK;
}

const EDIT_ICON_BY_LABEL = Object.freeze({
  Move: 'translate',
  Rotate: 'rotate',
  Scale: 'scale',
  Transform: 'translate',
  Delete: 'remove',
  Hide: 'eyeOff',
  Show: 'eye',
  Rename: 'text',
  'Change parent': 'group',
  'Change material': 'material',
  'Add material': 'material',
  'Change environment': 'sun',
  'Change effects': 'look',
  'Change shadows': 'shadow',
  'Move camera': 'camera',
  'Edit shots': 'film',
  'Edit animation': 'keyframe',
  'Open scene': 'open',
});

/** The icon that stands for a kind of edit in the History panel; every "Add ..." edit shares one, an unknown edit gets the generic node icon. */
export function editIconName(label) {
  if (String(label).startsWith('Add ') && label !== 'Add material') {
    return 'add';
  }
  return EDIT_ICON_BY_LABEL[label] ?? 'node';
}
