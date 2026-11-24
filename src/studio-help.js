// The Help menu of Studio: the sheet of keys for the active keymap and the link to the Studio guide.
// The sheet reads its labels from the keymap each time it is filled, so a preset or a rebound key shows its new label.
import { keyLabel, shortcutRowsFor } from './studio-keymap.js';

export const STUDIO_GUIDE_URL = 'https://crucible.codepawl.com/studio.md';

// The order of the groups in the sheet and the icon at the head of each.
const SHEET_GROUPS = Object.freeze([
  Object.freeze({ title: 'File', icon: 'save' }),
  Object.freeze({ title: 'Edit', icon: 'duplicate' }),
  Object.freeze({ title: 'View', icon: 'camera' }),
  Object.freeze({ title: 'Tools', icon: 'select' }),
  Object.freeze({ title: 'Animate', icon: 'keyframe' }),
  Object.freeze({ title: 'Edit mode', icon: 'meshVertex' }),
  Object.freeze({ title: 'Holding an object', icon: 'translate' }),
  Object.freeze({ title: 'Mouse', icon: 'select' }),
  Object.freeze({ title: 'Help', icon: 'help' }),
]);

// A keymap whose tool keys do not pick an object up has no holding state, and names its tools by the move they start.
const TOOL_LABELS_WITHOUT_GRAB = Object.freeze({ 'tool.translate': 'Move', 'tool.rotate': 'Rotate', 'tool.scale': 'Scale' });

function keysOfAction(keymap, actionId, bindingCount) {
  const labels = [];
  for (let bindingIndex = 0; bindingIndex < bindingCount; bindingIndex += 1) {
    const label = keyLabel(keymap, actionId, bindingIndex);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(' / ');
}

function mouseRows(keymap) {
  const rows = shortcutRowsFor(keymap);
  return rows.slice(rows.length - keymap.mouse.length);
}

/** The sheet as `[{ title, icon, rows: [{ label, keys }] }]`: every action of the keymap that has a key, grouped by area. */
export function shortcutSheetGroups(keymap) {
  const rowsByGroup = new Map(SHEET_GROUPS.map(group => [group.title, []]));
  for (const item of keymap.actions) {
    if (item.bindings.length === 0 || !rowsByGroup.has(item.group)) continue;
    if (item.group === 'Holding an object' && !keymap.toolKeysGrab) continue;
    const label = keymap.toolKeysGrab ? item.label : TOOL_LABELS_WITHOUT_GRAB[item.id] ?? item.label;
    rowsByGroup.get(item.group).push({ label, keys: keysOfAction(keymap, item.id, item.bindings.length) });
  }
  rowsByGroup.get('Mouse').push(
    { label: 'Add or remove an object from the selection', keys: 'Shift + click' },
    { label: 'Snap to a step or an angle', keys: 'Shift + drag' },
    { label: 'Menu of the object under the pointer', keys: 'Right click' },
    { label: 'Scrub a number', keys: 'Drag X / Y / Z' },
    ...mouseRows(keymap).map(({ label, keys }) => ({ label, keys })),
  );
  return SHEET_GROUPS
    .map(group => ({ ...group, rows: rowsByGroup.get(group.title) }))
    .filter(group => group.rows.length > 0);
}

/** Opens the Studio guide through the host's `openExternal` hook, or in a new tab that cannot reach back into Studio. */
export function openStudioGuide({ openExternal, windowReference, url = STUDIO_GUIDE_URL } = {}) {
  if (typeof openExternal === 'function') return openExternal(url);
  return windowReference?.open?.(url, '_blank', 'noopener,noreferrer') ?? null;
}
