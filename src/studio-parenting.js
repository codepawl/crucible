// Pure world-transform and hierarchy helpers for Studio parenting (Ctrl+P, Alt+P, Inspector dropdown and Scene list drag).
import { mat4, quat } from 'gl-matrix';

const MINIMUM_PARENT_SCALE = 1e-8;

/** All node ids in `rootIds` plus their descendants in `nodes`. */
export function collectDescendantIds(nodes, rootIds) {
  const descendants = new Set(rootIds);
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parent && descendants.has(node.parent) && !descendants.has(node.id)) {
        descendants.add(node.id);
        added = true;
      }
    }
  }
  return descendants;
}

/** Column-major world matrix of every node in `nodes`, walking each parent chain once. */
export function buildNodeWorldMatrices(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const worldMatrices = new Map();
  function resolveWorldMatrix(nodeId, stack) {
    if (worldMatrices.has(nodeId)) {
      return worldMatrices.get(nodeId);
    }
    const node = byId.get(nodeId);
    if (!node || stack.has(nodeId)) {
      return mat4.create();
    }
    stack.add(nodeId);
    const localMatrix = mat4.fromRotationTranslationScale(
      mat4.create(),
      node.rotation ?? [0, 0, 0, 1],
      node.translation ?? [0, 0, 0],
      node.scale ?? [1, 1, 1],
    );
    const worldMatrix = node.parent
      ? mat4.multiply(mat4.create(), resolveWorldMatrix(node.parent, stack), localMatrix)
      : localMatrix;
    stack.delete(nodeId);
    worldMatrices.set(nodeId, worldMatrix);
    return worldMatrix;
  }
  for (const node of nodes) {
    resolveWorldMatrix(node.id, new Set());
  }
  return worldMatrices;
}

/** Decomposes a column-major TRS matrix into `{ translation, rotation, scale }`. */
export function decomposeLocalMatrix(matrix) {
  const scaleX = Math.hypot(matrix[0], matrix[1], matrix[2]);
  const scaleY = Math.hypot(matrix[4], matrix[5], matrix[6]);
  const scaleZ = Math.hypot(matrix[8], matrix[9], matrix[10]);
  if (scaleX <= MINIMUM_PARENT_SCALE || scaleY <= MINIMUM_PARENT_SCALE || scaleZ <= MINIMUM_PARENT_SCALE) {
    throw new RangeError('Cannot parent under an object with zero scale.');
  }
  const rotationBasis = [
    matrix[0] / scaleX, matrix[1] / scaleX, matrix[2] / scaleX,
    matrix[4] / scaleY, matrix[5] / scaleY, matrix[6] / scaleY,
    matrix[8] / scaleZ, matrix[9] / scaleZ, matrix[10] / scaleZ,
  ];
  const rotation = quat.normalize(quat.create(), quat.fromMat3(quat.create(), rotationBasis));
  return {
    translation: [matrix[12], matrix[13], matrix[14]],
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    scale: [scaleX, scaleY, scaleZ],
  };
}

/**
 * Builds the `set-node` operations to assign `parentId` (or `null` to clear) for `nodeIds`.
 * With `keepWorld` true, recomputes each node's local transform so its world pose stays unchanged.
 */
export function reparentOperationsFor(recipe, nodeIds, parentId, { keepWorld = true, roundVector = vector => vector, normalizeQuaternion = quaternion => quaternion } = {}) {
  const nodes = recipe.nodes ?? [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (parentId !== null && !byId.has(parentId)) {
    throw new RangeError(`Unknown parent node "${String(parentId)}".`);
  }
  const uniqueIds = [...new Set(nodeIds)];
  for (const nodeId of uniqueIds) {
    if (!byId.has(nodeId)) {
      throw new RangeError(`Unknown node "${String(nodeId)}".`);
    }
    if (parentId !== null && collectDescendantIds(nodes, [nodeId]).has(parentId)) {
      throw new RangeError('Cannot parent a node under itself or its descendant.');
    }
  }
  const targetParent = parentId ?? null;
  const changing = uniqueIds.filter(nodeId => (byId.get(nodeId).parent ?? null) !== targetParent);
  if (changing.length === 0) {
    return [];
  }
  if (!keepWorld) {
    return changing.map(nodeId => ({ type: 'set-node', id: nodeId, parent: targetParent }));
  }
  const worldMatrices = buildNodeWorldMatrices(nodes);
  let inverseParentWorld = null;
  if (targetParent !== null) {
    inverseParentWorld = mat4.invert(mat4.create(), worldMatrices.get(targetParent));
    if (!inverseParentWorld) {
      throw new RangeError('Cannot parent under an object with zero scale.');
    }
  }
  return changing.map(nodeId => {
    const childWorld = worldMatrices.get(nodeId);
    const localMatrix = inverseParentWorld
      ? mat4.multiply(mat4.create(), inverseParentWorld, childWorld)
      : childWorld;
    const localTransform = decomposeLocalMatrix(localMatrix);
    return {
      type: 'set-node',
      id: nodeId,
      parent: targetParent,
      translation: roundVector(localTransform.translation),
      rotation: normalizeQuaternion(localTransform.rotation),
      scale: roundVector(localTransform.scale),
    };
  });
}

/** Returns the root node ids to move when dragging `draggedId` onto `dropTargetId` (or `null` for root). */
export function resolveDragParentIds(draggedId, selectedNodeIds, recipeNodes, dropTargetId = null) {
  const candidates = selectedNodeIds.includes(draggedId) ? selectedNodeIds : [draggedId];
  const candidateSet = new Set(candidates);
  const parentOf = new Map(recipeNodes.map(node => [node.id, node.parent ?? null]));
  const roots = candidates.filter(nodeId => {
    const visited = new Set([nodeId]);
    for (let ancestor = parentOf.get(nodeId); ancestor && !visited.has(ancestor); ancestor = parentOf.get(ancestor)) {
      if (candidateSet.has(ancestor)) return false;
      visited.add(ancestor);
    }
    return true;
  });
  if (dropTargetId === null) {
    return roots;
  }
  return roots.filter(nodeId => nodeId !== dropTargetId && !collectDescendantIds(recipeNodes, [nodeId]).has(dropTargetId));
}

/** Wires drag-and-drop parenting on the Scene list and each node row. */
export function createOutlinerParentDrag({ outlinerTree, controller, announce, announceError, isEditingName = () => false }) {
  let draggedNodeId = null;
  let activeDropRow = null;

  function clearIndicators() {
    if (activeDropRow) {
      delete activeDropRow.dataset.dropTarget;
      activeDropRow = null;
    }
    delete outlinerTree.dataset.dropRoot;
  }

  function clearDrag() {
    draggedNodeId = null;
    clearIndicators();
  }

  function movableIdsFor(targetId) {
    if (!draggedNodeId) return [];
    const nodes = controller.exportRecipe().nodes;
    const candidates = resolveDragParentIds(draggedNodeId, controller.selectedNodeIds, nodes, targetId);
    const byId = new Map(nodes.map(node => [node.id, node]));
    return candidates.filter(nodeId => (byId.get(nodeId)?.parent ?? null) !== targetId);
  }

  function runReparent(targetId) {
    const ids = movableIdsFor(targetId);
    clearDrag();
    if (ids.length === 0) return;
    try {
      const result = controller.reparentNodes(ids, targetId);
      if (result.changed > 0) {
        const countWord = `${result.changed} ${result.changed === 1 ? 'object' : 'objects'}`;
        announce(targetId ? `Parented ${countWord} to ${targetId}` : `Cleared parent for ${countWord}`);
      }
    } catch (error) {
      announceError(error.message);
    }
  }

  outlinerTree.addEventListener('dragover', event => {
    if (!draggedNodeId || movableIdsFor(null).length === 0) return;
    event.preventDefault();
    clearIndicators();
    outlinerTree.dataset.dropRoot = 'true';
  });

  outlinerTree.addEventListener('dragleave', event => {
    if (event.target === outlinerTree) delete outlinerTree.dataset.dropRoot;
  });

  outlinerTree.addEventListener('drop', event => {
    if (!draggedNodeId) return;
    event.preventDefault();
    runReparent(null);
  });

  function bindRow(rowElement, nodeId) {
    rowElement.dataset.nodeId = nodeId;
    rowElement.draggable = true;
    rowElement.addEventListener('dragstart', event => {
      if (isEditingName()) {
        event.preventDefault();
        return;
      }
      draggedNodeId = nodeId;
      rowElement.dataset.dragging = 'true';
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', nodeId);
      }
    });
    rowElement.addEventListener('dragover', event => {
      if (!draggedNodeId || movableIdsFor(nodeId).length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (activeDropRow && activeDropRow !== rowElement) {
        delete activeDropRow.dataset.dropTarget;
      }
      delete outlinerTree.dataset.dropRoot;
      activeDropRow = rowElement;
      rowElement.dataset.dropTarget = 'true';
    });
    rowElement.addEventListener('dragleave', () => {
      if (activeDropRow === rowElement) {
        delete rowElement.dataset.dropTarget;
        activeDropRow = null;
      }
    });
    rowElement.addEventListener('drop', event => {
      if (!draggedNodeId) return;
      event.preventDefault();
      event.stopPropagation();
      runReparent(nodeId);
    });
    rowElement.addEventListener('dragend', () => {
      delete rowElement.dataset.dragging;
      clearDrag();
    });
  }

  return { bindRow };
}
