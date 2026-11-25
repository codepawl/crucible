// The Apply and Set origin menus of Studio: fold the selected object's location, rotation and scale into its geometry, and move
// the point it turns and scales about. Each choice is one recipe operation (`apply-transform`, `set-origin`) sent as one scene
// change, so one undo step brings the object back. The operations check the object and say what to do when they refuse it.

export const APPLY_CHOICES = Object.freeze([
  Object.freeze({ id: 'location', label: 'Location', parts: Object.freeze(['location']), icon: 'translate' }),
  Object.freeze({ id: 'rotation', label: 'Rotation', parts: Object.freeze(['rotation']), icon: 'rotate' }),
  Object.freeze({ id: 'scale', label: 'Scale', parts: Object.freeze(['scale']), icon: 'scale' }),
  Object.freeze({ id: 'all', label: 'All transforms', parts: Object.freeze(['location', 'rotation', 'scale']), icon: 'node' }),
]);

export const ORIGIN_CHOICES = Object.freeze([
  Object.freeze({ id: 'geometry', label: 'Origin to geometry' }),
  Object.freeze({ id: 'bottom', label: 'Origin to bottom centre' }),
  Object.freeze({ id: 'selection', label: 'Origin to selection' }),
]);

const NOTHING_TO_APPLY = 'Nothing to apply: this object already has no location, rotation or scale to fold in.';
const NO_PICK_FOR_ORIGIN = 'Pick a vertex, an edge or a face in edit mode first, then set the origin to it.';
const SHAPE_BECAME_MESH = 'The shape is now a mesh, so it no longer has shape settings. Undo brings them back.';

function geometryOf(recipe, nodeId) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  return recipe.geometries.find(candidate => candidate.id === node?.geometry) ?? null;
}

const AT_REST = Object.freeze({ location: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const NODE_FIELD_OF_PART = Object.freeze({ location: 'translation', rotation: 'rotation', scale: 'scale' });

/** True when the node has something to fold in for one of the parts: a location, a turn or a scale that is not at rest. */
function hasTransformToApply(recipe, nodeId, parts) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  return parts.some(part => {
    const value = node?.[NODE_FIELD_OF_PART[part]] ?? AT_REST[part];
    const turnedByNegative = part === 'rotation' && value[3] < 0 && value.slice(0, 3).every(component => component === 0);
    return !turnedByNegative && value.some((component, index) => component !== AT_REST[part][index]);
  });
}

function describeParts(parts) {
  return parts.length === 3 ? 'All transforms' : `${parts[0][0].toUpperCase()}${parts[0].slice(1)}`;
}

/**
 * The menus and what their rows do. `createMenuPopover` and `createMenuItem` are Studio's own, so the rows look and open as the
 * other menus do; `getMeshEditor` returns the edit mode editor, or null before it has loaded.
 */
export function createApplyMenus({ createMenuPopover, createMenuItem, controller, announce, announceError, getMeshEditor, openPopoverAtMenuPoint }) {
  function sendOperation(operation) {
    const nodeId = controller.selectedNodeId;
    if (!nodeId) {
      announceError('Select an object first.');
      return false;
    }
    try {
      controller.applyImportOperations([{ ...operation, node: nodeId }], { detail: { kind: 'topology', nodeId } });
    } catch (error) {
      announceError(error.message);
      return false;
    }
    return true;
  }

  function applyTransform(parts) {
    const nodeId = controller.selectedNodeId;
    if (nodeId && !hasTransformToApply(controller.exportRecipe(), nodeId, parts)) {
      announce(NOTHING_TO_APPLY);
      return;
    }
    const geometryBefore = nodeId ? geometryOf(controller.exportRecipe(), nodeId) : null;
    if (!sendOperation({ type: 'apply-transform', parts: [...parts] })) return;
    const becameMesh = geometryBefore && geometryBefore.type !== 'mesh';
    announce(`${describeParts(parts)} applied.${becameMesh ? ` ${SHAPE_BECAME_MESH}` : ''}`);
  }

  function setOrigin(choiceId) {
    if (choiceId === 'selection') {
      const editor = getMeshEditor();
      const centre = editor?.active ? editor.selectionCentreLocal() : null;
      if (!centre) {
        announceError(NO_PICK_FOR_ORIGIN);
        return;
      }
      if (sendOperation({ type: 'set-origin', to: 'point', point: centre })) announce('Origin moved to the selection.');
      return;
    }
    const nodeId = controller.selectedNodeId;
    const geometryBefore = nodeId ? geometryOf(controller.exportRecipe(), nodeId) : null;
    if (sendOperation({ type: 'set-origin', to: choiceId })) {
      const becameMesh = geometryBefore && geometryBefore.type !== 'mesh';
      announce(`Origin moved to the ${choiceId === 'geometry' ? 'middle of the geometry' : 'bottom centre'}.${becameMesh ? ` ${SHAPE_BECAME_MESH}` : ''}`);
    }
  }

  const applyPopover = createMenuPopover(
    'crucible-studio-pop-apply',
    ...APPLY_CHOICES.map(choice => createMenuItem(choice.label, choice.id === 'all' ? 'edit.apply' : '', () => applyTransform(choice.parts), choice.icon)),
  );
  const originItems = ORIGIN_CHOICES.map(choice => createMenuItem(choice.label, '', () => setOrigin(choice.id)));
  const originPopover = createMenuPopover('crucible-studio-pop-origin', ...originItems);
  const selectionItem = originItems[ORIGIN_CHOICES.findIndex(choice => choice.id === 'selection')];
  originPopover.addEventListener('beforetoggle', () => {
    const editor = getMeshEditor();
    selectionItem.disabled = !(editor?.active && editor.selectionCentreLocal());
  });

  const applyRow = createMenuItem('Apply…', 'edit.apply', () => openPopoverAtMenuPoint(applyPopover), 'node');
  const originRow = createMenuItem('Set origin…', '', () => openPopoverAtMenuPoint(originPopover), 'frame');
  return { applyPopover, originPopover, applyRow, originRow, applyTransform, setOrigin };
}
