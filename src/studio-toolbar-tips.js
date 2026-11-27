import { createStudioTooltip } from './studio-tooltip.js';

// What each button of Studio's rail says in its tooltip: a name, the key it has in the keymap now in force, and one line on what it does.
// The key is read again on every show, so a changed keymap or preference shows without rebuilding anything.
const TOOL_TIPS = Object.freeze({
  select: { name: 'Select', hint: 'Click an object in the view to pick it.' },
  translate: { name: 'Move', hint: 'Drag an arrow to slide the selection.' },
  rotate: { name: 'Rotate', hint: 'Drag a ring to turn the selection.' },
  scale: { name: 'Scale', hint: 'Drag a handle to resize the selection.' },
});

const MESH_MODE_TIPS = Object.freeze({
  vertex: 'Pick and move single points of the mesh.',
  edge: 'Pick and move the lines between points.',
  face: 'Pick and move whole surfaces.',
});

/** The titles of the view chips: each names its key in the keymap now in force. */
export function writeViewChipTitles(viewPresetButtons, projectionPillButton, keyOf) {
  const viewTitles = { front: ['Front view', 'view.front'], right: ['Right view', 'view.right'], top: ['Top view', 'view.top'], isometric: ['Isometric view', null] };
  for (const button of viewPresetButtons) {
    const [labelText, actionId] = viewTitles[button.dataset.view];
    const shortcut = actionId ? keyOf(actionId) : '';
    button.title = shortcut ? `${labelText} (${shortcut})` : labelText;
  }
  const projectionShortcut = keyOf('view.projection');
  projectionPillButton.title = projectionShortcut ? `Perspective / Orthographic (${projectionShortcut})` : 'Perspective / Orthographic';
}

/**
 * Makes the tooltip and gives the rail's buttons their text.
 * `keyOf(actionId)` is the label of an action's key in the keymap now in force; `lastKeyOf` the last of its keys.
 */
export function createToolbarTooltip({ root, documentReference }, controls, { keyOf, lastKeyOf, toolActions, meshModes, snapState }) {
  const tooltip = createStudioTooltip({ root, documentReference });
  const tip = (button, readName, hint, readKeys = () => '') => tooltip.describe(button, () => ({ name: readName(), hint, keys: readKeys() }));
  const fixed = name => () => name;
  for (const button of controls.toolButtons) {
    const { name, hint } = TOOL_TIPS[button.dataset.tool];
    tip(button, fixed(name), hint, () => keyOf(toolActions[button.dataset.tool]));
  }
  tip(controls.snapToggleButton, () => `Snapping ${snapState().enabled ? 'on' : 'off'}`, 'Moves jump to the grid and nearby points.', () => keyOf('snap.toggle'));
  tip(controls.snapTargetButton, () => `Snap to ${snapState().targetLabel}`, 'Choose what moves snap to.');
  for (const button of controls.meshModeButtons) {
    const { label, action } = meshModes.find(mode => mode.mode === button.dataset.meshMode);
    tip(button, fixed(`${label} select`), MESH_MODE_TIPS[button.dataset.meshMode], () => keyOf(action));
  }
  tip(controls.meshObjectButton, fixed('Object mode'), 'Leave mesh editing and go back to whole objects.', () => keyOf('mesh.leave'));
  tip(controls.proportionalButton, fixed('Proportional editing'), 'Points near the one you move follow it, fading with distance.', () => keyOf('mesh.proportional'));
  tip(controls.proportionalMenuButton, fixed('Proportional falloff'), 'Set how far the pull reaches and how it fades.');
  tip(controls.meshToolsButton, fixed('Mesh tools'), 'Extrude, bevel, subdivide and other edits of the selected points.');
  tip(controls.addMenuButton, fixed('Add'), 'Put a shape, a model or a light in the scene.');
  tip(controls.undoButton, fixed('Undo'), 'Take back the last edit.', () => keyOf('edit.undo'));
  tip(controls.redoButton, fixed('Redo'), 'Bring back the edit you took back.', () => keyOf('edit.redo'));
  tip(controls.gridButton, fixed('Grid'), 'Show or hide the floor grid.');
  tip(controls.seeThroughButton, fixed('See through'), 'Show points and edges behind the surface while editing.', () => keyOf('view.seeThrough'));
  tip(controls.toggleDocksButton, fixed('Panels'), 'Show or hide the Scene and Properties panels.');
  tip(controls.duplicateButton, fixed('Duplicate'), 'Copy the selection and pick the copy up.', () => lastKeyOf('edit.duplicate'));
  tip(controls.deleteButton, fixed('Delete'), 'Remove the selection from the scene.', () => keyOf('edit.delete'));
  tip(controls.frameButton, fixed('Frame'), 'Fly the camera to the selection.', () => keyOf('view.frame'));
  return tooltip;
}
