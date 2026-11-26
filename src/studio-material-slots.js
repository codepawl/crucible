// Studio helpers for joining objects with different materials into one slotted mesh and assigning face materials in edit mode.
import { MIXED_SELECT_VALUE, syncSelectMixedOption } from './studio-multi-edit.js';

const NO_FACES_TEXT = 'Pick faces';
const PICK_FACES_SELECT_VALUE = '__pick_faces__';

function freeGeometryId(takenIds, baseId) {
  let candidate = `${baseId}-mesh`;
  for (let suffix = 2; takenIds.has(candidate); suffix += 1) {
    candidate = `${baseId}-mesh-${suffix}`;
  }
  takenIds.add(candidate);
  return candidate;
}

/**
 * Plans the scene operations for Ctrl+J Join: any primitive shape among `activeId` and `otherIds` becomes a mesh geometry first,
 * followed by one `join-meshes` operation that combines them into `activeId` (preserving each object's material as a slot).
 */
export function planJoinOperations(recipe, activeId, otherIds, meshGeometryOfPrimitive) {
  const operations = [];
  const takenIds = new Set((recipe.geometries ?? []).map(geometry => geometry.id));
  const nodesById = new Map((recipe.nodes ?? []).map(node => [node.id, node]));
  const geometriesById = new Map((recipe.geometries ?? []).map(geometry => [geometry.id, geometry]));
  for (const nodeId of [activeId, ...otherIds]) {
    const node = nodesById.get(nodeId);
    const geometry = geometriesById.get(node?.geometry);
    if (!geometry || geometry.type === 'mesh') continue;
    const converted = meshGeometryOfPrimitive(geometry);
    if (!converted) continue;
    const meshId = freeGeometryId(takenIds, geometry.id);
    operations.push({ type: 'add-geometry', geometry: { ...converted, id: meshId } });
    operations.push({ type: 'set-node', id: nodeId, geometry: meshId });
  }
  operations.push({ type: 'join-meshes', node: activeId, nodes: otherIds });
  return operations;
}

/** Summarizes the material slots used by `faces` on the edited mesh in Studio edit mode. */
export function selectedFaceSlotsState(recipe, nodeId, mesh, faces) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId) ?? null;
  const geometry = recipe.geometries?.find(candidate => candidate.id === node?.geometry) ?? null;
  const slots = geometry?.slots ? [...geometry.slots] : (node?.material ? [node.material] : []);
  const faceSlots = mesh.attributes.face.material_slot?.data;
  const usedSlots = new Set(faces.map(face => (faceSlots ? faceSlots[face] : 0)));
  const slotIndex = usedSlots.size === 1 ? [...usedSlots][0] : null;
  return {
    nodeId,
    faces,
    slots,
    slotted: Boolean(geometry?.slots),
    slotIndex,
    materialId: slotIndex === null ? null : (slots[slotIndex] ?? null),
    mixed: usedSlots.size > 1,
  };
}

/** Handles clicking a Scene palette swatch while Studio is in edit mode, assigning that material to the selected faces. */
export function assignSwatchMaterialInEditMode({ meshEditor, materialId, onAssigned }) {
  const outcome = meshEditor.assignMaterial(materialId);
  if (outcome?.ok) {
    onAssigned?.();
  }
  return outcome;
}

/** Runs `assign-face-material` in 1 undo step for Studio edit mode and announces the result. */
export function applyEditModeFaceMaterial({ controller, nodeId, faces, target, refresh, announce, refuse }) {
  const assignment = typeof target === 'number' ? { slot: target } : { material: target };
  try {
    controller.applyImportOperations([{ type: 'assign-face-material', node: nodeId, faces, ...assignment }], { detail: { kind: 'topology', nodeId } });
  } catch (error) {
    return refuse(error.message);
  }
  refresh();
  announce(`Assigned material to ${faces.length} ${faces.length === 1 ? 'face' : 'faces'}`);
  return { ok: true, faces: faces.length };
}

/** Builds ghost parts for Studio edit-mode see-through rendering across all material slots of the edited node. */
export function buildSeeThroughParts(parts, opacity) {
  return parts.map(candidate => Object.freeze({
    ...candidate,
    material: { ...candidate.material, alphaMode: 'blend', opacity: Math.min(candidate.material.opacity ?? 1, opacity), doubleSided: true },
  }));
}

/** Builds the Face material row shown in Studio's Material panel while mesh edit mode is active. */
export function createFaceMaterialPanel({ documentReference, createElement, controller, getMeshEditor, announceError, onAssigned }) {
  const statusOutput = createElement(documentReference, 'output', { textContent: NO_FACES_TEXT });
  const head = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-field-head' },
    createElement(documentReference, 'span', { textContent: 'Face material' }),
    statusOutput,
  );
  const materialSelect = createElement(documentReference, 'select', { attributes: { 'aria-label': 'Face material' } });
  const slotChips = createElement(documentReference, 'div', { className: 'crucible-studio-chips', hidden: true });
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-field', hidden: true, dataset: { faceMaterialPanel: 'true' } },
    head,
    materialSelect,
    slotChips,
  );

  let lastOptionsKey = '';
  let lastSlotsKey = '';

  function applyAssignment(target) {
    const editor = getMeshEditor();
    if (!editor?.active) return;
    const outcome = editor.assignMaterial(target);
    if (outcome?.ok) {
      onAssigned?.();
    } else if (outcome?.message) {
      announceError?.(outcome.message);
    }
    sync();
  }

  materialSelect.addEventListener('change', () => {
    const value = materialSelect.value;
    if (!value || value === MIXED_SELECT_VALUE || value === PICK_FACES_SELECT_VALUE) return;
    applyAssignment(value);
  });

  function syncOptions(recipe, hasSelection) {
    const optionsKey = `${hasSelection}|${recipe.materials.map(material => material.id).join('|')}`;
    if (optionsKey === lastOptionsKey) return;
    lastOptionsKey = optionsKey;
    const options = recipe.materials.map(material => createElement(documentReference, 'option', { value: material.id, textContent: material.id }));
    if (!hasSelection) {
      options.unshift(createElement(documentReference, 'option', { value: PICK_FACES_SELECT_VALUE, textContent: 'Select faces first', disabled: true }));
    }
    materialSelect.replaceChildren(...options);
  }

  function syncSlotChips(summary) {
    const showSlots = summary.slotted && summary.slots.length > 0;
    slotChips.hidden = !showSlots;
    if (!showSlots) {
      lastSlotsKey = '';
      slotChips.replaceChildren();
      return;
    }
    const slotsKey = summary.slots.join('|');
    if (slotsKey !== lastSlotsKey) {
      lastSlotsKey = slotsKey;
      slotChips.replaceChildren(...summary.slots.map((materialId, slotIndex) => {
        const button = createElement(documentReference, 'button', {
          type: 'button',
          textContent: `${slotIndex + 1}: ${materialId}`,
          dataset: { faceSlot: String(slotIndex) },
          attributes: { 'aria-pressed': 'false', title: `Assign slot ${slotIndex} (${materialId})` },
        });
        button.addEventListener('click', () => applyAssignment(slotIndex));
        return button;
      }));
    }
    const disabled = summary.faces.length === 0;
    Array.from(slotChips.children).forEach((button, slotIndex) => {
      button.disabled = disabled;
      const pressed = !disabled && !summary.mixed && summary.slotIndex === slotIndex;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  function sync() {
    const editor = getMeshEditor();
    if (!editor?.active) {
      element.hidden = true;
      return;
    }
    const summary = editor.selectedFaceSlots();
    if (!summary) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const recipe = controller.exportRecipe();
    const hasSelection = summary.faces.length > 0;
    syncOptions(recipe, hasSelection);
    materialSelect.disabled = !hasSelection || recipe.materials.length === 0;
    const faceLabel = summary.faces.length === 1 ? '1 face' : `${summary.faces.length} faces`;
    if (!hasSelection) {
      syncSelectMixedOption(materialSelect, documentReference, createElement, false);
      materialSelect.value = PICK_FACES_SELECT_VALUE;
      statusOutput.textContent = NO_FACES_TEXT;
    } else if (summary.mixed) {
      syncSelectMixedOption(materialSelect, documentReference, createElement, true);
      statusOutput.textContent = `${faceLabel}, mixed`;
    } else {
      syncSelectMixedOption(materialSelect, documentReference, createElement, false);
      if (summary.materialId) materialSelect.value = summary.materialId;
      statusOutput.textContent = summary.slotted && summary.slotIndex !== null ? `${faceLabel}, slot ${summary.slotIndex + 1}` : faceLabel;
    }
    syncSlotChips(summary);
  }

  return { element, sync };
}
