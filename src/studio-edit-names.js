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

/** A short name for the edit that applied these scene operations, such as "Move", "Add cube" or "Change material". */
export function nameEditOperations(operations) {
  const types = new Set(operations.map(operation => operation.type));
  const leading = operations.find(operation => {
    if (!(operation.type in SUPPORTING_TYPES)) {
      return true;
    }
    const supported = SUPPORTING_TYPES[operation.type];
    return supported === null ? types.size === 1 : !types.has(supported);
  }) ?? operations[0];
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
