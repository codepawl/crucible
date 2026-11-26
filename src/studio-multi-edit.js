// Pure multi-object transform, copy-paste, batch property edit and mixed-field helpers for Studio.
import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { MIXED_PROPERTY_LABEL, summarizeSharedPropertyValues } from './studio-properties.js';
import { registerStudioStyle } from './studio-registry.js';

export const MIXED_SELECT_VALUE = '__mixed__';
const AXIS_NAMES = Object.freeze(['x', 'y', 'z']);
const POSE_PROPERTIES = Object.freeze(['translation', 'rotation', 'scale']);
const VALUE_TOLERANCE = 1e-4;
const DEGREE_TOLERANCE = 0.01;
const POSITION_EPSILON = 1e-8;
const DEFAULT_CLEARCOAT_ROUGHNESS = 0.1;

registerStudioStyle(`
.crucible-studio [data-mixed="true"]::placeholder {
  color: var(--studio-muted);
  opacity: 1;
}
.crucible-studio .crucible-studio-mixed-tag {
  font-size: 11px;
  color: var(--studio-muted);
  font-variant-numeric: tabular-nums;
}
.crucible-studio .crucible-studio-mixed-tag[hidden] {
  display: none;
}
.crucible-studio .crucible-studio-chips button[aria-pressed="mixed"] {
  color: var(--studio-text);
}
.crucible-studio .crucible-studio-field:has(> input[type="color"]) {
  gap: var(--studio-space-8);
}
.crucible-studio .crucible-studio-field:has(> input[type="color"]) > .crucible-studio-field-head {
  flex: 1 1 auto;
}
`);

export function directionThroughMatrix(direction, matrix) {
  return [
    matrix[0] * direction[0] + matrix[4] * direction[1] + matrix[8] * direction[2],
    matrix[1] * direction[0] + matrix[5] * direction[1] + matrix[9] * direction[2],
    matrix[2] * direction[0] + matrix[6] * direction[1] + matrix[10] * direction[2],
  ];
}

export function toNodeLocalDelta(worldDelta, parentInverse) {
  if (!parentInverse) {
    return worldDelta;
  }
  const rotated = vec3.fromValues(worldDelta[0], worldDelta[1], worldDelta[2]);
  const linearInverse = mat4.clone(parentInverse);
  linearInverse[12] = 0;
  linearInverse[13] = 0;
  linearInverse[14] = 0;
  vec3.transformMat4(rotated, rotated, linearInverse);
  return [rotated[0], rotated[1], rotated[2]];
}

function rotationQuatFromMatrix(matrix, worldBasisOf) {
  if (!matrix) {
    return null;
  }
  const basis = worldBasisOf(matrix);
  const rotationMat3 = mat3.fromValues(
    basis.x[0], basis.x[1], basis.x[2],
    basis.y[0], basis.y[1], basis.y[2],
    basis.z[0], basis.z[1], basis.z[2],
  );
  return quat.normalize(quat.create(), quat.fromMat3(quat.create(), rotationMat3));
}

/**
 * Builds descriptors for every selected root object that moves, rotates or scales alongside the active one.
 * Children of the active object follow it through the hierarchy; a selected ancestor carries the active one instead.
 */
export function buildDragCompanions({
  recipe,
  activeId,
  worldMatrices,
  autoKey,
  motionTime,
  authoredNodePose,
  sampledNodePose,
  normalizeQuaternion,
  descendantIdsOf,
  selectionRootsIn,
  worldBasisOf,
}) {
  const recipeNodes = recipe.nodes;
  const carriedByActive = descendantIdsOf(recipeNodes, activeId);
  return selectionRootsIn(recipeNodes)
    .filter(nodeId => !carriedByActive.has(nodeId))
    .map(nodeId => {
      const node = recipeNodes.find(candidate => candidate.id === nodeId);
      const nodeWorld = worldMatrices.get(nodeId) ?? mat4.create();
      const parentWorld = node.parent ? worldMatrices.get(node.parent) : null;
      const authored = authoredNodePose(node);
      const startPose = autoKey ? sampledNodePose(recipe, node, motionTime) : authored;
      return {
        nodeId,
        authoredPose: { ...authored, rotation: normalizeQuaternion(authored.rotation) },
        baseTranslation: startPose.translation,
        baseRotation: normalizeQuaternion(startPose.rotation),
        baseScale: startPose.scale,
        baseWorldPosition: [nodeWorld[12], nodeWorld[13], nodeWorld[14]],
        baseWorldBasis: worldBasisOf(nodeWorld),
        parentInverse: parentWorld ? mat4.invert(mat4.create(), parentWorld) : null,
        parentWorldQuat: rotationQuatFromMatrix(parentWorld, worldBasisOf),
      };
    });
}

/** Move operations for all companion roots matching the active object's world translation delta. */
export function companionMoveOperations(dragState, translation, roundVector) {
  if (dragState.companions.length === 0) {
    return [];
  }
  const localDelta = translation.map((component, axisIndex) => component - dragState.baseTranslation[axisIndex]);
  const worldDelta = dragState.parentWorld ? directionThroughMatrix(localDelta, dragState.parentWorld) : localDelta;
  return dragState.companions.map(({ nodeId, baseTranslation, parentInverse }) => {
    const companionDelta = toNodeLocalDelta(worldDelta, parentInverse);
    const moved = baseTranslation.map((component, axisIndex) => component + companionDelta[axisIndex]);
    return { type: 'set-node', id: nodeId, translation: roundVector(moved) };
  });
}

/** Rotate operations orbiting and turning all companion roots around the drag pivot and axis. */
export function companionRotateOperations(dragState, radians, { normalizeQuaternion, roundVector }) {
  if (dragState.companions.length === 0) {
    return [];
  }
  const worldAxis = dragState.axisWorld ?? dragState.basis?.z ?? [0, 0, 1];
  const worldDeltaQuat = quat.setAxisAngle(quat.create(), worldAxis, radians);
  const pivot = dragState.basePivot;
  return dragState.companions.map(companion => {
    const offset = [
      companion.baseWorldPosition[0] - pivot[0],
      companion.baseWorldPosition[1] - pivot[1],
      companion.baseWorldPosition[2] - pivot[2],
    ];
    const hasOffset = Math.hypot(offset[0], offset[1], offset[2]) > POSITION_EPSILON;
    let translationPatch = null;
    if (hasOffset) {
      const rotatedOffset = vec3.transformQuat(vec3.create(), offset, worldDeltaQuat);
      const worldDelta = [
        rotatedOffset[0] - offset[0],
        rotatedOffset[1] - offset[1],
        rotatedOffset[2] - offset[2],
      ];
      const localDelta = toNodeLocalDelta(worldDelta, companion.parentInverse);
      translationPatch = roundVector([
        companion.baseTranslation[0] + localDelta[0],
        companion.baseTranslation[1] + localDelta[1],
        companion.baseTranslation[2] + localDelta[2],
      ]);
    }
    const localDeltaQuat = companion.parentWorldQuat
      ? quat.multiply(
          quat.create(),
          quat.multiply(quat.create(), quat.conjugate(quat.create(), companion.parentWorldQuat), worldDeltaQuat),
          companion.parentWorldQuat,
        )
      : worldDeltaQuat;
    const nextRotation = normalizeQuaternion(quat.multiply(quat.create(), localDeltaQuat, companion.baseRotation));
    return {
      type: 'set-node',
      id: companion.nodeId,
      ...(translationPatch ? { translation: translationPatch } : {}),
      rotation: nextRotation,
    };
  });
}

/** Scale operations scaling each companion root's offset from the drag pivot and its local size. */
export function companionScaleOperations(dragState, factor, affectsAxis, { minimumScale, maximumScale, roundVector }) {
  if (dragState.companions.length === 0) {
    return [];
  }
  const clampScale = value => Math.max(minimumScale, Math.min(maximumScale, value));
  const gizmoFactors = [0, 1, 2].map(axisIndex => (affectsAxis(axisIndex) ? factor : 1));
  const uniform = gizmoFactors[0] === gizmoFactors[1] && gizmoFactors[1] === gizmoFactors[2];
  const basisAxes = [dragState.basis.x, dragState.basis.y, dragState.basis.z];
  const pivot = dragState.basePivot;
  return dragState.companions.map(companion => {
    const offset = [
      companion.baseWorldPosition[0] - pivot[0],
      companion.baseWorldPosition[1] - pivot[1],
      companion.baseWorldPosition[2] - pivot[2],
    ];
    const worldDelta = [0, 0, 0];
    for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
      if (gizmoFactors[axisIndex] === 1) {
        continue;
      }
      const axisDirection = basisAxes[axisIndex];
      const projection = offset[0] * axisDirection[0] + offset[1] * axisDirection[1] + offset[2] * axisDirection[2];
      const deltaScale = gizmoFactors[axisIndex] - 1;
      worldDelta[0] += deltaScale * projection * axisDirection[0];
      worldDelta[1] += deltaScale * projection * axisDirection[1];
      worldDelta[2] += deltaScale * projection * axisDirection[2];
    }
    const hasMove = Math.hypot(worldDelta[0], worldDelta[1], worldDelta[2]) > POSITION_EPSILON;
    let translationPatch = null;
    if (hasMove) {
      const localDelta = toNodeLocalDelta(worldDelta, companion.parentInverse);
      translationPatch = roundVector([
        companion.baseTranslation[0] + localDelta[0],
        companion.baseTranslation[1] + localDelta[1],
        companion.baseTranslation[2] + localDelta[2],
      ]);
    }
    const nextScale = uniform
      ? companion.baseScale.map(component => clampScale(component * factor))
      : AXIS_NAMES.map((axisName, axisIndex) => {
          const localWorldAxis = companion.baseWorldBasis[axisName];
          const projected0 = vec3.dot(localWorldAxis, basisAxes[0]) * gizmoFactors[0];
          const projected1 = vec3.dot(localWorldAxis, basisAxes[1]) * gizmoFactors[1];
          const projected2 = vec3.dot(localWorldAxis, basisAxes[2]) * gizmoFactors[2];
          return clampScale(companion.baseScale[axisIndex] * Math.hypot(projected0, projected1, projected2));
        });
    return {
      type: 'set-node',
      id: companion.nodeId,
      ...(translationPatch ? { translation: translationPatch } : {}),
      scale: roundVector(nextScale),
    };
  });
}

/** Merges live auto-key updates across all node pose operations in a drag step. */
export function liveMotionForDragOperations({ baseMotion, operations, motionTime, motionWithPoseKeys }) {
  let nextMotion = baseMotion;
  let updated = false;
  for (const operation of operations) {
    if (operation.type !== 'set-node') {
      continue;
    }
    const keyedMotion = motionWithPoseKeys(nextMotion, operation.id, operation, motionTime);
    if (keyedMotion) {
      nextMotion = keyedMotion;
      updated = true;
    }
  }
  return updated ? nextMotion : null;
}

export function buildNodeCopy(source, offsetSteps, existingIds, { copyOffset, roundVector, uniqueIdentifier }) {
  const copyId = uniqueIdentifier(existingIds, `${source.id}-copy`);
  existingIds.add(copyId);
  const cloned = structuredClone(source);
  cloned.id = copyId;
  cloned.label = `${source.label ?? source.id} copy`;
  cloned.translation = roundVector([
    (source.translation?.[0] ?? 0) + copyOffset[0] * offsetSteps,
    source.translation?.[1] ?? 0,
    (source.translation?.[2] ?? 0) + copyOffset[2] * offsetSteps,
  ]);
  return cloned;
}

export function parentsFirst(nodes) {
  const ordered = [];
  const placed = new Set();
  const waiting = [...nodes];
  while (waiting.length > 0) {
    const waitingIds = new Set(waiting.map(node => node.id));
    const ready = waiting.filter(node => !waitingIds.has(node.parent) || node.parent === node.id);
    for (const node of ready.length > 0 ? ready : waiting) {
      ordered.push(node);
      placed.add(node.id);
    }
    waiting.splice(0, waiting.length, ...waiting.filter(node => !placed.has(node.id)));
  }
  return ordered;
}

export function buildAddCopyOperations(recipe, sources, offsetSteps, activeSourceId, { copyOffset, roundVector, uniqueIdentifier }) {
  const existingIds = new Set(recipe.nodes.map(node => node.id));
  const copies = sources.map(source => buildNodeCopy(source, offsetSteps, existingIds, { copyOffset, roundVector, uniqueIdentifier }));
  const copyIdBySourceId = new Map(sources.map((source, index) => [source.id, copies[index].id]));
  copies.forEach((cloned, index) => {
    const source = sources[index];
    if (copyIdBySourceId.has(source.parent)) {
      cloned.parent = copyIdBySourceId.get(source.parent);
      cloned.translation = structuredClone(source.translation ?? [0, 0, 0]);
    } else if (cloned.parent !== undefined && !recipe.nodes.some(node => node.id === cloned.parent)) {
      delete cloned.parent;
    }
  });
  const activeIndex = Math.max(0, sources.findIndex(source => source.id === activeSourceId));
  return {
    operations: parentsFirst(copies).map(node => ({ type: 'add-node', node })),
    copyIds: copies.map(node => node.id),
    activeCopy: copies[activeIndex],
  };
}

function assertPartialVector(vector, length, label) {
  if (!Array.isArray(vector) || vector.length !== length) {
    throw new TypeError(`${label} must be an array of ${length} numbers.`);
  }
  let hasNumber = false;
  for (const component of vector) {
    if (component === null || component === undefined) {
      continue;
    }
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new TypeError(`${label} components must be finite numbers.`);
    }
    hasNumber = true;
  }
  if (!hasNumber) {
    throw new TypeError(`${label} must include at least one finite number.`);
  }
  return vector;
}

function resolvePartialVector(patchVector, fallbackVector) {
  return fallbackVector.map((component, index) => (
    patchVector[index] === null || patchVector[index] === undefined ? component : patchVector[index]
  ));
}

/**
 * Builds `set-node` (and merged `set-motion`) operations to update one or more nodes as one undo step.
 * Vector fields (`translation`, `rotationDegrees`, `scale`) may pass `null`/`undefined` components to preserve
 * each node's own value on untouched or mixed axes.
 */
export function batchNodeTransformOperations(recipe, nodeIds, patch, helpers) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some(nodeId => typeof nodeId !== 'string' || nodeId === '')) {
    throw new TypeError('updateNodesTransform expects a non-empty array of node ID strings.');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('updateNodesTransform expects a patch object.');
  }
  const {
    autoKey,
    motionTime,
    assertFiniteVector,
    roundVector,
    eulerDegreesToQuaternion,
    quaternionToEulerDegrees,
    normalizeQuaternion,
    reparentOperationsFor,
    authoredNodePose,
    sampledNodePose,
    motionWithPoseKeys,
  } = helpers;
  const uniqueIds = [...new Set(nodeIds)];
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  for (const nodeId of uniqueIds) {
    if (!nodesById.has(nodeId)) {
      throw new RangeError(`Unknown node "${nodeId}".`);
    }
  }
  let trimmedLabel;
  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || patch.label.length > 256) {
      throw new TypeError('Node label must be a string of at most 256 characters.');
    }
    trimmedLabel = patch.label.trim();
  }
  for (const flagField of ['visible', 'castShadow', 'receiveShadow']) {
    if (patch[flagField] !== undefined && typeof patch[flagField] !== 'boolean') {
      throw new TypeError(`Node ${flagField} must be true or false.`);
    }
  }
  if (patch.translation !== undefined) {
    assertPartialVector(patch.translation, 3, 'translation');
  }
  if (patch.rotationDegrees !== undefined) {
    assertPartialVector(patch.rotationDegrees, 3, 'rotationDegrees');
  } else if (patch.rotation !== undefined) {
    assertFiniteVector(patch.rotation, 4, 'rotation');
  }
  if (patch.scale !== undefined) {
    const checked = assertPartialVector(patch.scale, 3, 'scale');
    if (checked.some(component => component !== null && component !== undefined && component <= 0)) {
      throw new RangeError('Node scale components must stay positive.');
    }
  }

  const reparentById = new Map();
  if (patch.parent !== undefined) {
    const hasExplicitTransform = patch.translation !== undefined || patch.rotationDegrees !== undefined || patch.rotation !== undefined || patch.scale !== undefined;
    const keepWorld = patch.keepWorld !== false && !hasExplicitTransform;
    const reparented = reparentOperationsFor(recipe, uniqueIds, patch.parent, { keepWorld, roundVector, normalizeQuaternion });
    for (const operation of reparented) {
      reparentById.set(operation.id, operation);
    }
  }

  const operations = [];
  let nextMotion = recipe.motion ?? null;
  let keyed = false;
  for (const nodeId of uniqueIds) {
    const node = nodesById.get(nodeId);
    const basePose = autoKey ? sampledNodePose(recipe, node, motionTime) : authoredNodePose(node);
    const operation = { type: 'set-node', id: nodeId };
    if (reparentById.has(nodeId)) {
      Object.assign(operation, reparentById.get(nodeId));
    } else if (patch.parent !== undefined && !reparentById.has(nodeId) && (node.parent ?? null) !== (patch.parent ?? null)) {
      operation.parent = patch.parent;
    }
    if (trimmedLabel !== undefined) {
      operation.label = trimmedLabel || nodeId;
    }
    if (patch.translation !== undefined) {
      operation.translation = roundVector(resolvePartialVector(patch.translation, basePose.translation));
    }
    if (patch.rotationDegrees !== undefined) {
      const currentDegrees = quaternionToEulerDegrees(basePose.rotation);
      operation.rotation = eulerDegreesToQuaternion(resolvePartialVector(patch.rotationDegrees, currentDegrees));
    } else if (patch.rotation !== undefined) {
      operation.rotation = normalizeQuaternion(patch.rotation);
    }
    if (patch.scale !== undefined) {
      const resolvedScale = resolvePartialVector(patch.scale, basePose.scale);
      if (resolvedScale.some(component => component <= 0)) {
        throw new RangeError('Node scale components must stay positive.');
      }
      operation.scale = roundVector(resolvedScale);
    }
    for (const flagField of ['visible', 'castShadow', 'receiveShadow']) {
      if (patch[flagField] !== undefined) {
        operation[flagField] = patch[flagField];
      }
    }
    if (patch.vegetation !== undefined) {
      operation.vegetation = patch.vegetation;
    }
    operations.push(operation);
    if (autoKey && POSE_PROPERTIES.some(property => operation[property] !== undefined)) {
      const updatedMotion = motionWithPoseKeys(nextMotion, nodeId, operation, motionTime);
      if (updatedMotion) {
        nextMotion = updatedMotion;
        keyed = true;
      }
    }
  }
  if (keyed && nextMotion) {
    operations.push({ type: 'set-motion', motion: nextMotion });
  }
  const changesTopology = patch.parent !== undefined || patch.vegetation !== undefined;
  return { operations, keyed, changesTopology };
}

/** Assigns `materialId` to every geometry node in `nodeIds` as one operation batch. */
export function batchAssignMaterialOperations(recipe, nodeIds, materialId) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some(nodeId => typeof nodeId !== 'string' || nodeId === '')) {
    throw new TypeError('assignNodesMaterial expects a non-empty array of node ID strings.');
  }
  if (!recipe.materials.some(material => material.id === materialId)) {
    throw new RangeError(`Unknown material "${String(materialId)}".`);
  }
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const targets = [...new Set(nodeIds)]
    .map(nodeId => nodesById.get(nodeId))
    .filter(node => node && node.geometry !== undefined);
  if (targets.length === 0) {
    throw new RangeError(`Node "${String(nodeIds[0])}" has no geometry to paint.`);
  }
  return targets.map(node => ({ type: 'set-node', id: node.id, material: materialId }));
}

/** Updates every distinct material in `materialIds` in one operation batch. */
export function batchMaterialUpdateOperations(recipe, materialIds, patchOrFactory, helpers) {
  if (!Array.isArray(materialIds) || materialIds.length === 0 || materialIds.some(materialId => typeof materialId !== 'string' || materialId === '')) {
    throw new TypeError('updateMaterials expects a non-empty array of material ID strings.');
  }
  const { hexToLinearRgb, assertFiniteVector, roundVector, roundValue } = helpers;
  const materialsById = new Map(recipe.materials.map(material => [material.id, material]));
  const uniqueIds = [...new Set(materialIds)];
  const operations = [];
  for (const materialId of uniqueIds) {
    const material = materialsById.get(materialId);
    if (!material) {
      throw new RangeError(`Unknown material "${String(materialId)}".`);
    }
    const patch = typeof patchOrFactory === 'function' ? patchOrFactory(material) : patchOrFactory;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('updateMaterials expects a patch object.');
    }
    const operation = { type: 'set-material', id: materialId };
    if (patch.hexColor !== undefined) {
      operation.color = hexToLinearRgb(patch.hexColor);
    } else if (patch.color !== undefined) {
      operation.color = roundVector(assertFiniteVector(patch.color, 3, 'color'));
    }
    if (patch.emissiveHex !== undefined) {
      operation.emissiveColor = hexToLinearRgb(patch.emissiveHex);
    } else if (patch.emissiveColor !== undefined) {
      operation.emissiveColor = roundVector(assertFiniteVector(patch.emissiveColor, 3, 'emissiveColor'));
    }
    for (const scalarField of ['roughness', 'metallic', 'clearcoat', 'clearcoatRoughness', 'emission', 'opacity']) {
      if (patch[scalarField] !== undefined) {
        if (typeof patch[scalarField] !== 'number' || !Number.isFinite(patch[scalarField])) {
          throw new TypeError(`Material ${scalarField} must be a finite number.`);
        }
        operation[scalarField] = roundValue(patch[scalarField]);
      }
    }
    if (patch.doubleSided !== undefined) {
      if (typeof patch.doubleSided !== 'boolean') {
        throw new TypeError('Material doubleSided must be true or false.');
      }
      operation.doubleSided = patch.doubleSided;
    }
    operations.push(operation);
  }
  return operations;
}

function uniqueGeometryId(takenIds, wanted) {
  let candidate = wanted;
  for (let suffix = 2; takenIds.has(candidate); suffix += 1) {
    candidate = `${wanted}-${suffix}`;
  }
  takenIds.add(candidate);
  return candidate;
}

/** Builds geometry update/copy operations for a shared shape field edit across `nodeIds`. */
export function batchShapeChangeOperations(recipe, nodeIds, fieldId, value, { shapeFieldsOf, checkedShapeValue }) {
  const uniqueNodeIds = [...new Set(nodeIds)];
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const geometriesById = new Map(recipe.geometries.map(geometry => [geometry.id, geometry]));
  const selectedSet = new Set(uniqueNodeIds);
  const takenGeometryIds = new Set(recipe.geometries.map(geometry => geometry.id));
  const groupedByGeometryId = new Map();
  let validatedValue = null;

  for (const nodeId of uniqueNodeIds) {
    const node = nodesById.get(nodeId);
    const geometry = node?.geometry === undefined ? null : geometriesById.get(node.geometry);
    const fields = shapeFieldsOf(geometry);
    const field = fields?.find(candidate => candidate.id === fieldId);
    if (!field) {
      throw new RangeError(`Node "${nodeId}" has no shape setting "${fieldId}". Select a basic shape (box, cylinder, sphere, cone, ico sphere, circle, torus or plane) and use one of its fields.`);
    }
    if (validatedValue === null) {
      validatedValue = checkedShapeValue(field, value);
    }
    const list = groupedByGeometryId.get(geometry.id) ?? [];
    list.push(nodeId);
    groupedByGeometryId.set(geometry.id, list);
  }

  const operations = [];
  for (const [geometryId, memberNodeIds] of groupedByGeometryId.entries()) {
    const geometry = geometriesById.get(geometryId);
    const changed = { ...geometry, [fieldId]: validatedValue };
    const unselectedUsers = recipe.nodes.some(node => node.geometry === geometryId && !selectedSet.has(node.id));
    if (!unselectedUsers) {
      operations.push({ type: 'remove-geometry', id: geometryId }, { type: 'add-geometry', geometry: changed });
    } else {
      const copyId = uniqueGeometryId(takenGeometryIds, `${geometryId}-${memberNodeIds[0]}`);
      operations.push({ type: 'add-geometry', geometry: { ...changed, id: copyId } });
      for (const nodeId of memberNodeIds) {
        operations.push({ type: 'set-node', id: nodeId, geometry: copyId });
      }
    }
  }
  return operations;
}

function nearlyEqual(first, second, tolerance = VALUE_TOLERANCE) {
  return Math.abs(first - second) <= tolerance;
}

function summarizeVectorComponents(vectors, fallback, tolerance = VALUE_TOLERANCE) {
  const axes = [0, 1, 2].map(axisIndex => summarizeSharedPropertyValues(
    vectors.map(vector => vector?.[axisIndex] ?? fallback[axisIndex]),
    (first, second) => nearlyEqual(first, second, tolerance),
  ));
  return {
    values: axes.map(axis => axis.value),
    mixed: axes.map(axis => axis.mixed),
  };
}

/** Summarizes shared and mixed Object + Material properties across `selectedNodeIds` (active first for fallback display). */
export function summarizeNodeSelection(recipe, selectedNodeIds, activeNodeId, {
  animatedNodeProperties,
  nodePose,
  quaternionToEulerDegrees,
  linearRgbToHex,
}) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const selectedNodes = selectedNodeIds.map(nodeId => nodesById.get(nodeId)).filter(Boolean);
  const activeNode = (activeNodeId ? nodesById.get(activeNodeId) : null) ?? selectedNodes.at(-1) ?? null;
  if (!activeNode) {
    return null;
  }
  const orderedNodes = [activeNode, ...selectedNodes.filter(node => node.id !== activeNode.id)];
  const poses = orderedNodes.map(node => {
    const animated = animatedNodeProperties(node.id);
    return { node, animated, pose: animated.length > 0 ? nodePose(node.id) : node };
  });

  const label = summarizeSharedPropertyValues(orderedNodes.map(node => node.label ?? node.id));
  const visible = summarizeSharedPropertyValues(orderedNodes.map(node => node.visible ?? true));
  const parent = summarizeSharedPropertyValues(orderedNodes.map(node => node.parent ?? ''));
  const castShadow = summarizeSharedPropertyValues(orderedNodes.map(node => node.castShadow ?? true));
  const receiveShadow = summarizeSharedPropertyValues(orderedNodes.map(node => node.receiveShadow ?? true));
  const translation = summarizeVectorComponents(poses.map(entry => entry.pose?.translation), [0, 0, 0], VALUE_TOLERANCE);
  const rotationDegrees = summarizeVectorComponents(
    poses.map(entry => quaternionToEulerDegrees(entry.pose?.rotation ?? [0, 0, 0, 1])),
    [0, 0, 0],
    DEGREE_TOLERANCE,
  );
  const scale = summarizeVectorComponents(poses.map(entry => entry.pose?.scale), [1, 1, 1], VALUE_TOLERANCE);

  const lockFor = property => poses.some(entry => entry.animated.includes(property));
  const geometryNodes = orderedNodes.filter(node => node.geometry !== undefined);
  const assignedSummary = summarizeSharedPropertyValues(geometryNodes.map(node => node.material ?? ''));
  const materialsById = new Map(recipe.materials.map(material => [material.id, material]));
  const distinctMaterials = [];
  const seenMaterialIds = new Set();
  for (const node of geometryNodes) {
    const material = node.material ? materialsById.get(node.material) : null;
    if (material && !seenMaterialIds.has(material.id)) {
      seenMaterialIds.add(material.id);
      distinctMaterials.push(material);
    }
  }
  if (distinctMaterials.length === 0 && geometryNodes.length === 0 && orderedNodes.length === 1 && recipe.materials[0]) {
    distinctMaterials.push(recipe.materials[0]);
  }
  const activeMaterial = distinctMaterials[0] ?? null;
  const materialSummary = {
    geometryNodeIds: geometryNodes.map(node => node.id),
    materialIds: distinctMaterials.map(material => material.id),
    activeMaterial,
    assignedId: assignedSummary.value ?? activeMaterial?.id ?? '',
    assignedMixed: assignedSummary.mixed,
    color: summarizeSharedPropertyValues(distinctMaterials.map(material => linearRgbToHex(material.color))),
    emissiveColor: summarizeSharedPropertyValues(distinctMaterials.map(material => linearRgbToHex(material.emissiveColor ?? material.color))),
    roughness: summarizeSharedPropertyValues(distinctMaterials.map(material => material.roughness ?? 0.5), nearlyEqual),
    metallic: summarizeSharedPropertyValues(distinctMaterials.map(material => material.metallic ?? 0), nearlyEqual),
    clearcoat: summarizeSharedPropertyValues(distinctMaterials.map(material => material.clearcoat ?? 0), nearlyEqual),
    clearcoatRoughness: summarizeSharedPropertyValues(distinctMaterials.map(material => material.clearcoatRoughness ?? 0), nearlyEqual),
    opacity: summarizeSharedPropertyValues(distinctMaterials.map(material => material.opacity ?? 1), nearlyEqual),
    emission: summarizeSharedPropertyValues(distinctMaterials.map(material => material.emission ?? 0), nearlyEqual),
    doubleSided: summarizeSharedPropertyValues(distinctMaterials.map(material => material.doubleSided === true)),
  };

  return {
    nodes: selectedNodes,
    activeNode,
    multiSelected: selectedNodes.length > 1,
    label,
    visible,
    parent,
    castShadow,
    receiveShadow,
    translation: { ...translation, lockedByTrack: lockFor('translation') },
    rotationDegrees: { ...rotationDegrees, lockedByTrack: lockFor('rotation') },
    scale: { ...scale, lockedByTrack: lockFor('scale') },
    material: materialSummary,
  };
}

/** Summarizes shape fields for one or more selected nodes when all share the same parametric shape type. */
export function summarizeShapeSelection(recipe, selectedNodeIds, activeNodeId, { shapeFieldsOf, shapeFieldValue }) {
  const uniqueIds = selectedNodeIds.length > 0 ? selectedNodeIds : (activeNodeId ? [activeNodeId] : []);
  if (uniqueIds.length === 0) {
    return null;
  }
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const geometriesById = new Map(recipe.geometries.map(geometry => [geometry.id, geometry]));
  const geometries = uniqueIds.map(nodeId => {
    const node = nodesById.get(nodeId);
    return node?.geometry === undefined ? null : (geometriesById.get(node.geometry) ?? null);
  });
  if (uniqueIds.length === 1) {
    const geometry = geometries[0];
    const fields = shapeFieldsOf(geometry);
    if (fields) {
      return {
        fields,
        geometry,
        shapeType: geometry.type,
        nodeIds: uniqueIds,
        mixedFields: new Set(),
      };
    }
    return geometry?.type === 'mesh' ? { meshEdited: true, nodeIds: uniqueIds } : null;
  }
  const firstType = geometries[0]?.type;
  if (!firstType || geometries.some(geometry => geometry?.type !== firstType)) {
    return null;
  }
  const fields = shapeFieldsOf(geometries[0]);
  if (!fields) {
    return null;
  }
  const activeIndex = Math.max(0, uniqueIds.indexOf(activeNodeId));
  const activeGeometry = geometries[activeIndex] ?? geometries[0];
  const mixedFields = new Set();
  for (const field of fields) {
    const summary = summarizeSharedPropertyValues(geometries.map(geometry => shapeFieldValue(geometry, field)), nearlyEqual);
    if (summary.mixed) {
      mixedFields.add(field.id);
    }
  }
  return {
    fields,
    geometry: activeGeometry,
    shapeType: firstType,
    nodeIds: uniqueIds,
    mixedFields,
  };
}

/** Keeps a disabled "Mixed" option at the top of a `<select>` only when `isMixed` is true. */
export function syncSelectMixedOption(selectElement, documentReference, createElement, isMixed) {
  let mixedOption = selectElement.querySelector(`option[value="${MIXED_SELECT_VALUE}"]`);
  if (isMixed) {
    if (!mixedOption) {
      mixedOption = createElement(documentReference, 'option', { value: MIXED_SELECT_VALUE, textContent: MIXED_PROPERTY_LABEL, disabled: true });
      selectElement.prepend(mixedOption);
    }
    selectElement.value = MIXED_SELECT_VALUE;
    selectElement.dataset.mixed = 'true';
    return;
  }
  mixedOption?.remove();
  selectElement.dataset.mixed = 'false';
}

/** Shows or hides a quiet "Mixed" label beside a colour swatch when selected materials differ. */
export function syncColorMixedBadge(badgeElement, fieldElement, isMixed) {
  badgeElement.hidden = !isMixed;
  badgeElement.textContent = isMixed ? MIXED_PROPERTY_LABEL : '';
  fieldElement.dataset.mixed = isMixed ? 'true' : 'false';
}

function syncToggleChip(button, label, isMixed, value) {
  button.dataset.mixed = isMixed ? 'true' : 'false';
  button.textContent = isMixed ? `${label} (${MIXED_PROPERTY_LABEL})` : label;
  button.setAttribute('aria-pressed', isMixed ? 'mixed' : (value ? 'true' : 'false'));
}

/** Updates Object and Material panel controls from a single or multi-node selection summary. */
export function syncObjectAndMaterialPanels({
  recipe,
  controller,
  summary,
  documentReference,
  createElement,
  degreePrecision,
  linearRgbToHex,
  setButtonIcon,
  setRowLockedByTrack,
  syncTreeInspector,
  shapeSettings,
  renderPaletteSwatches,
  controls,
}) {
  const {
    nodeLabelInput,
    nodeParentSelect,
    visibleToggle,
    castShadowToggle,
    receiveShadowToggle,
    positionRow,
    rotationRow,
    scaleRow,
    materialSelect,
    colorInput,
    colorMixedTag,
    colorField,
    emissiveColorInput,
    emissiveMixedTag,
    emissiveField,
    roughnessField,
    metallicField,
    clearcoatField,
    clearcoatRoughnessField,
    doubleSidedToggle,
    opacityField,
    emissionField,
  } = controls;

  const hasNode = Boolean(summary);
  nodeLabelInput.disabled = !hasNode;
  nodeParentSelect.disabled = !hasNode;
  visibleToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
  castShadowToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
  receiveShadowToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');

  if (summary) {
    nodeLabelInput.dataset.mixed = summary.label.mixed ? 'true' : 'false';
    nodeLabelInput.placeholder = summary.label.mixed ? MIXED_PROPERTY_LABEL : 'Node label';
    nodeLabelInput.value = summary.label.mixed ? '' : summary.label.value;
    syncSelectMixedOption(nodeParentSelect, documentReference, createElement, summary.parent.mixed);
    if (!summary.parent.mixed) {
      nodeParentSelect.value = summary.parent.value;
    }
    visibleToggle.dataset.mixed = summary.visible.mixed ? 'true' : 'false';
    const shownVisible = summary.visible.value !== false;
    setButtonIcon(visibleToggle, shownVisible ? 'eye' : 'eyeOff', summary.visible.mixed ? 'Mixed visibility' : (shownVisible ? 'Hide' : 'Show'));
    syncToggleChip(castShadowToggle, 'Casts shadow', summary.castShadow.mixed, summary.castShadow.value !== false);
    syncToggleChip(receiveShadowToggle, 'Receives shadow', summary.receiveShadow.mixed, summary.receiveShadow.value !== false);
    positionRow.setValues(summary.translation.values);
    positionRow.setMixed(summary.translation.mixed);
    rotationRow.setValues(summary.rotationDegrees.values, degreePrecision);
    rotationRow.setMixed(summary.rotationDegrees.mixed);
    scaleRow.setValues(summary.scale.values);
    scaleRow.setMixed(summary.scale.mixed);
    setRowLockedByTrack(positionRow, !controller.autoKey && summary.translation.lockedByTrack);
    setRowLockedByTrack(rotationRow, !controller.autoKey && summary.rotationDegrees.lockedByTrack);
    setRowLockedByTrack(scaleRow, !controller.autoKey && summary.scale.lockedByTrack);
    syncTreeInspector(summary.multiSelected ? null : summary.activeNode);
  } else {
    nodeLabelInput.dataset.mixed = 'false';
    nodeLabelInput.placeholder = 'Node label';
    nodeLabelInput.value = '';
    syncSelectMixedOption(nodeParentSelect, documentReference, createElement, false);
    nodeParentSelect.value = '';
    visibleToggle.dataset.mixed = 'false';
    syncToggleChip(castShadowToggle, 'Casts shadow', false, true);
    syncToggleChip(receiveShadowToggle, 'Receives shadow', false, true);
    positionRow.setValues([0, 0, 0]);
    positionRow.setMixed([false, false, false]);
    rotationRow.setValues([0, 0, 0], degreePrecision);
    rotationRow.setMixed([false, false, false]);
    scaleRow.setValues([1, 1, 1]);
    scaleRow.setMixed([false, false, false]);
    setRowLockedByTrack(positionRow, false);
    setRowLockedByTrack(rotationRow, false);
    setRowLockedByTrack(scaleRow, false);
    syncTreeInspector(null);
  }
  shapeSettings.sync();

  const materialSummary = summary?.material ?? null;
  const activeMaterial = materialSummary?.activeMaterial ?? (!summary ? (recipe.materials[0] ?? null) : null);
  renderPaletteSwatches(recipe, materialSummary && !materialSummary.assignedMixed ? (activeMaterial?.id ?? null) : null);
  const hasMaterial = Boolean(activeMaterial);
  materialSelect.disabled = !hasMaterial;
  colorInput.disabled = !hasMaterial;
  emissiveColorInput.disabled = !hasMaterial;
  roughnessField.input.disabled = !hasMaterial;
  metallicField.input.disabled = !hasMaterial;
  clearcoatField.input.disabled = !hasMaterial;
  clearcoatRoughnessField.input.disabled = !hasMaterial;
  doubleSidedToggle.disabled = !hasMaterial;
  opacityField.input.disabled = !hasMaterial;
  emissionField.input.disabled = !hasMaterial;
  if (!hasMaterial) {
    syncSelectMixedOption(materialSelect, documentReference, createElement, false);
    syncColorMixedBadge(colorMixedTag, colorField, false);
    syncColorMixedBadge(emissiveMixedTag, emissiveField, false);
    syncToggleChip(doubleSidedToggle, 'Double sided', false, false);
    return;
  }
  syncSelectMixedOption(materialSelect, documentReference, createElement, Boolean(materialSummary?.assignedMixed));
  if (!materialSummary?.assignedMixed) {
    materialSelect.value = materialSummary?.assignedId || activeMaterial.id;
  }
  colorInput.value = materialSummary ? materialSummary.color.value : linearRgbToHex(activeMaterial.color);
  syncColorMixedBadge(colorMixedTag, colorField, Boolean(materialSummary?.color.mixed));
  emissiveColorInput.value = materialSummary ? materialSummary.emissiveColor.value : linearRgbToHex(activeMaterial.emissiveColor ?? activeMaterial.color);
  syncColorMixedBadge(emissiveMixedTag, emissiveField, Boolean(materialSummary?.emissiveColor.mixed));
  const sliderEntries = [
    [roughnessField, 'roughness', 0.5],
    [metallicField, 'metallic', 0],
    [clearcoatField, 'clearcoat', 0],
    [clearcoatRoughnessField, 'clearcoatRoughness', 0],
    [opacityField, 'opacity', 1],
    [emissionField, 'emission', 0],
  ];
  for (const [fieldControl, key, fallback] of sliderEntries) {
    const value = materialSummary ? materialSummary[key].value : (activeMaterial[key] ?? fallback);
    fieldControl.setValue(value);
    fieldControl.setMixed(Boolean(materialSummary?.[key].mixed));
  }
  syncToggleChip(
    doubleSidedToggle,
    'Double sided',
    Boolean(materialSummary?.doubleSided.mixed),
    materialSummary ? materialSummary.doubleSided.value : activeMaterial.doubleSided === true,
  );
}

export { MIXED_PROPERTY_LABEL };
