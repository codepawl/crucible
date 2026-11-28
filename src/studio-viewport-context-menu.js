import { popoverOpeningStyle } from './studio-popover-motion.js';
import { MODIFIER_CHOICES, addModifier, modifierRefusalOf } from './studio-modifier-panel.js';

// The right click menus of the viewport. The object menu (Frame, Duplicate, Hide, Delete and the rest) is built in studio.js from the
// Edit menu's own rows; this file adds what it lacked: an Add Modifier submenu that does what the Modifiers tab's Add Modifier does,
// a scene menu for a right click on empty space, which object a right click acts on, arrow-key use of every such menu, and the
// keyboard way to open them (the Menu key or Shift+F10) for a mouse whose right button is set to select.

// The rows a key can land on: a dimmed or hidden row is skipped.
const chooseRowsOf = popover => [...popover.querySelectorAll('button')].filter(row => row.getAttribute('aria-disabled') !== 'true' && !row.hidden);

/**
 * The object a right click at this point acts on. An object already in the selection keeps the selection as it is, so a
 * several-object selection survives the click; an object outside it becomes the selection; empty space changes nothing.
 * Returns the selected node id the menu is for, or null when nothing is selected.
 */
export function selectForContextMenu(controller, pixelX, pixelY) {
  const selectedBefore = controller.selectedNodeIds;
  const hit = controller.pickAt(pixelX, pixelY, { mode: 'add' });
  if (hit && !selectedBefore.includes(controller.selectedNodeId)) {
    controller.selectNodes([controller.selectedNodeId]);
  }
  return controller.selectedNodeId;
}

/** Arrow keys, Home and End move between the rows of a menu popover; Enter runs the row (a button does that itself). */
export function wireMenuKeyboard(popover) {
  popover.addEventListener('keydown', event => {
    const rows = chooseRowsOf(popover);
    if (rows.length === 0) return;
    const current = rows.indexOf(popover.ownerDocument.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % rows.length;
    else if (event.key === 'ArrowUp') next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next === null) return;
    event.preventDefault();
    rows[next].focus();
  });
  // A menu opened from the keyboard or the pointer puts the focus on its first row, so the arrow keys work at once.
  popover.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    chooseRowsOf(popover)[0]?.focus?.({ preventScroll: true });
  });
}

/**
 * `createMenuPopover` and `createMenuItem` are Studio's own, so the rows look and open as the top bar menus do.
 * `openPopoverAtMenuPoint` opens a popover where the menu that asked for it opened; `getAddPopover` returns the Add menu.
 */
export function createViewportContextMenus({ createMenuPopover, createMenuItem, controller, announce, announceError, openPopoverAtMenuPoint, getAddPopover, onPaste, onShowAll }) {
  function chooseModifier(operation, title) {
    const nodeId = controller.selectedNodeId;
    try {
      addModifier(controller, nodeId, operation);
    } catch (error) {
      announceError(error.message);
      return;
    }
    announce(`${title} added`);
  }

  const modifierRows = MODIFIER_CHOICES.map(choice => createMenuItem(choice.title, '', () => chooseModifier(choice.operation, choice.title), choice.icon));
  const modifierPopover = createMenuPopover('crucible-studio-pop-add-modifier', ...modifierRows);
  modifierPopover.setAttribute('role', 'menu');
  const addModifierRow = createMenuItem('Add Modifier…', '', () => {
    const refusal = modifierRefusalOf(controller, controller.selectedNodeId);
    if (refusal) announceError(refusal);
    else openPopoverAtMenuPoint(modifierPopover);
  }, 'modifiers');
  addModifierRow.setAttribute('aria-haspopup', 'menu');

  // An object that cannot carry modifiers (a light, a group) leaves the row dimmed with the reason, the way the tab's button does.
  function showModifierAvailability() {
    const refusal = modifierRefusalOf(controller, controller.selectedNodeId);
    addModifierRow.setAttribute('aria-disabled', refusal ? 'true' : 'false');
    addModifierRow.title = refusal ?? '';
  }

  const addObjectRow = createMenuItem('Add object…', '', () => openPopoverAtMenuPoint(getAddPopover()), 'add');
  addObjectRow.setAttribute('aria-haspopup', 'menu');
  const scenePopover = createMenuPopover(
    'crucible-studio-pop-scene',
    addObjectRow,
    createMenuItem('Paste', 'edit.paste', () => onPaste(), 'clipboard'),
    createMenuItem('Show all', 'edit.showAll', () => onShowAll(), 'eye'),
  );

  const popovers = [modifierPopover, scenePopover];
  for (const popover of popovers) wireMenuKeyboard(popover);

  return {
    addModifierRow,
    modifierPopover,
    scenePopover,
    popovers,
    /** Wires an object menu that holds the Add Modifier row: arrow keys, and the row dimmed whenever the menu opens. */
    watchObjectMenu(popover) {
      wireMenuKeyboard(popover);
      popover.addEventListener('beforetoggle', event => {
        if (event.newState === 'open') showModifierAvailability();
      });
    },
  };
}

/**
 * Opens a menu popover with its corner at the pointer: downward in the upper half of the window, upward in the lower half, and
 * slid back inside the window when it is taller than the room, so no row is cut off.
 */
export function openPopoverNearPointer(documentReference, popover, clientX, clientY) {
  const windowWidth = documentReference.defaultView?.innerWidth ?? 1280;
  const windowHeight = documentReference.defaultView?.innerHeight ?? 800;
  popover.togglePopover?.(false);
  popover.style.left = `${Math.round(Math.max(8, Math.min(clientX, windowWidth - 256)))}px`;
  popover.style.right = 'auto';
  const opensUpward = clientY > windowHeight / 2;
  popover.style.top = opensUpward ? 'auto' : `${Math.round(clientY)}px`;
  popover.style.bottom = opensUpward ? `${Math.round(Math.max(8, windowHeight - clientY))}px` : 'auto';
  const opening = popoverOpeningStyle({ opensUpward });
  popover.style.setProperty('--studio-popover-origin', opening.origin);
  popover.style.setProperty('--studio-popover-shift', opening.shift);
  popover.showPopover?.();
  const shown = popover.getBoundingClientRect?.();
  if (shown && shown.height > 0 && (shown.bottom > windowHeight - 8 || shown.top < 8)) {
    popover.style.bottom = 'auto';
    popover.style.top = `${Math.max(8, Math.round(windowHeight - 8 - shown.height))}px`;
  }
}

/**
 * Where a right click or the Menu key opens a menu: the object menu while something is selected, the scene menu otherwise.
 * `selectInPanel(select)` runs a selection change the way a click does; `onOpen([x, y])` remembers where submenus open.
 */
export function createViewportMenuOpening({ controller, documentReference, viewportElement, canvas, getViewportPointer, isHoldingObject, isKeyboardBlocked, openObjectMenu, openScenePopover, selectInPanel, onOpen }) {
  function openAt(clientX, clientY) {
    if (controller.selectedNodeId) {
      openObjectMenu(clientX, clientY);
      return;
    }
    if (isHoldingObject()) return;
    onOpen([clientX, clientY]);
    openScenePopover(clientX, clientY);
  }

  // The pointer's own place, or the middle of the viewport when focus is on the canvas and the pointer is elsewhere.
  function openFromKeyboard() {
    const pointer = getViewportPointer();
    if (isKeyboardBlocked() || (!pointer && documentReference.activeElement !== canvas)) return false;
    const bounds = viewportElement.getBoundingClientRect();
    const local = pointer ?? { x: bounds.width / 2, y: bounds.height / 2 };
    if (pointer) selectInPanel(() => selectForContextMenu(controller, local.x, local.y));
    openAt(bounds.left + local.x, bounds.top + local.y);
    return true;
  }

  // A right press that did not drag opens the menu of the object under it, or of the scene over empty space. It opens after
  // this release has been handled, because the release itself closes any open menu.
  function openAfterRelease({ clientX, clientY }) {
    setTimeout(() => openAt(clientX, clientY), 0);
  }

  function handleKeydown(event) {
    if (!isContextMenuKey(event) || !openFromKeyboard()) return false;
    event.preventDefault();
    return true;
  }

  return { openAt, openFromKeyboard, openAfterRelease, handleKeydown };
}

/** True for the keys that ask for a context menu from the keyboard: the Menu key and Shift+F10. */
export function isContextMenuKey(event) {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}
