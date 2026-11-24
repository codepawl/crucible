// The Help menu of Studio: the sheet of keys for the active keymap and the link to the Studio guide.
// The sheet reads its labels from the keymap each time it is filled, so a preset or a rebound key shows its new label.
import { keyLabel, shortcutRowsFor } from './studio-keymap.js';

// GitHub shows the guide as a page. The site serves the same file as raw markdown, which a person would read unformatted.
export const STUDIO_GUIDE_URL = 'https://github.com/codepawl/crucible/blob/main/docs/studio.md';

// The groups of the sheet, in reading order, with the icon at the head of each.
const SHEET_GROUPS = Object.freeze([
  Object.freeze({ title: 'File', icon: 'save' }),
  Object.freeze({ title: 'History', icon: 'undo' }),
  Object.freeze({ title: 'Selection', icon: 'check' }),
  Object.freeze({ title: 'Clipboard and objects', icon: 'duplicate' }),
  Object.freeze({ title: 'Transform and tools', icon: 'translate' }),
  Object.freeze({ title: 'View', icon: 'camera' }),
  Object.freeze({ title: 'Animation', icon: 'keyframe' }),
  Object.freeze({ title: 'Mesh editing', icon: 'meshVertex' }),
  Object.freeze({ title: 'Holding an object', icon: 'handle' }),
  Object.freeze({ title: 'Mouse', icon: 'select' }),
  Object.freeze({ title: 'Help and settings', icon: 'help' }),
]);

// The group of an action is read from its id prefix; these ids sit in another group than their prefix says.
const GROUP_BY_PREFIX = Object.freeze({
  file: 'File',
  select: 'Selection',
  tool: 'Transform and tools',
  view: 'View',
  animate: 'Animation',
  mesh: 'Mesh editing',
  modal: 'Holding an object',
  settings: 'Help and settings',
  help: 'Help and settings',
  add: 'Clipboard and objects',
  edit: 'Clipboard and objects',
});
const GROUP_BY_ACTION = Object.freeze({
  'edit.undo': 'History',
  'edit.redo': 'History',
  'edit.deselect': 'Selection',
  'edit.hide': 'Selection',
  'edit.showAll': 'Selection',
  'edit.resetPosition': 'Transform and tools',
  'edit.resetRotation': 'Transform and tools',
  'edit.resetScale': 'Transform and tools',
  'mesh.enter': 'Mesh editing',
});

// A keymap whose tool keys do not pick an object up names its tools by the move they start.
const TOOL_LABELS_WITHOUT_GRAB = Object.freeze({ 'tool.translate': 'Move', 'tool.rotate': 'Rotate', 'tool.scale': 'Scale' });

/** The group title an action belongs to in the sheet. */
export function sheetGroupOf(actionId) {
  return GROUP_BY_ACTION[actionId] ?? GROUP_BY_PREFIX[actionId.split('.')[0]];
}

function keysOfAction(keymap, actionId, bindingCount) {
  const labels = [];
  for (let bindingIndex = 0; bindingIndex < bindingCount; bindingIndex += 1) {
    const label = keyLabel(keymap, actionId, bindingIndex);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(', ');
}

function mouseRows(keymap) {
  const rows = shortcutRowsFor(keymap);
  return rows.slice(rows.length - keymap.mouse.length);
}

/** The sheet as `[{ title, icon, rows: [{ label, keys }] }]`: every action of the keymap that has a key, grouped by what a person is doing. */
export function shortcutSheetGroups(keymap) {
  const rowsByGroup = new Map(SHEET_GROUPS.map(group => [group.title, []]));
  for (const item of keymap.actions) {
    if (item.bindings.length === 0) continue;
    const title = sheetGroupOf(item.id);
    if (!rowsByGroup.has(title)) throw new RangeError(`Keymap action "${item.id}" has no group in the shortcut sheet: add its id or prefix to studio-help.js.`);
    const label = keymap.toolKeysGrab ? item.label : TOOL_LABELS_WITHOUT_GRAB[item.id] ?? item.label;
    rowsByGroup.get(title).push({ label, keys: keysOfAction(keymap, item.id, item.bindings.length) });
  }
  rowsByGroup.get('Mouse').push(
    { label: 'Add or remove an object from the selection', keys: 'Shift + click' },
    { label: 'Snap to a step or an angle', keys: 'Shift + drag' },
    { label: 'Menu of the object under the pointer', keys: 'Right click' },
    { label: 'Scrub a number', keys: 'Drag X, Y or Z' },
    ...mouseRows(keymap).map(({ label, keys }) => ({ label, keys })),
  );
  return SHEET_GROUPS
    .map(group => ({ ...group, rows: rowsByGroup.get(group.title) }))
    .filter(group => group.rows.length > 0);
}

/** Splits the groups into two columns of about equal height, keeping their order and never cutting a group. */
export function balanceSheetColumns(groups) {
  const weight = group => group.rows.length + 2;
  const total = groups.reduce((sum, group) => sum + weight(group), 0);
  let running = 0;
  let splitIndex = groups.length;
  let bestGap = Infinity;
  groups.forEach((group, index) => {
    running += weight(group);
    const gap = Math.abs(total - running - running);
    if (gap < bestGap) {
      bestGap = gap;
      splitIndex = index + 1;
    }
  });
  return [groups.slice(0, splitIndex), groups.slice(splitIndex)];
}

/** Opens the Studio guide through the host's `openExternal` hook, or in a new tab that cannot reach back into Studio. */
export function openStudioGuide({ openExternal, windowReference, url = STUDIO_GUIDE_URL } = {}) {
  if (typeof openExternal === 'function') return openExternal(url);
  return windowReference?.open?.(url, '_blank', 'noopener,noreferrer') ?? null;
}
