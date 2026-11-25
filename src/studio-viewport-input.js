// Which wheel turns and which presses over the 3D view belong to the camera. The handles, the marks and the widgets are drawn
// over the canvas, so the camera cannot be bound to the canvas alone.

const WHEEL_OWNER_TAGS = new Set(['input', 'textarea', 'select', 'dialog']);
const WHEEL_OWNER_ROLES = new Set(['menu', 'listbox', 'dialog', 'slider', 'spinbutton']);

function elementOwnsWheel(element) {
  if (WHEEL_OWNER_TAGS.has(element.tagName?.toLowerCase())) return true;
  if (WHEEL_OWNER_ROLES.has(element.getAttribute?.('role'))) return true;
  if (element.getAttribute?.('contenteditable') === 'true') return true;
  const marker = element.getAttribute?.('data-wheel-owner');
  return marker !== null && marker !== undefined;
}

/**
 * True when a wheel turn at `target` does not zoom the view: the target lies outside the view (a panel, a list, an open menu),
 * or a control inside it, such as a field or a menu, uses the wheel. Anything else drawn over the view zooms it.
 */
export function targetOwnsWheel(target, viewportElement) {
  if (!target || !viewportElement.contains(target)) return true;
  for (let element = target; element && element !== viewportElement; element = element.parentNode) {
    if (elementOwnsWheel(element)) return true;
  }
  return false;
}

/** The camera move a press on a handle or a mark starts when the keymap names none: 'pan', or null when the press is the overlay own. */
export function overlayCameraMode(event) {
  const button = event.button ?? 0;
  return button === 1 || button === 2 || (button === 0 && event.shiftKey) ? 'pan' : null;
}
