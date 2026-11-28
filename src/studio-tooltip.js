import { registerStudioStyle } from './studio-registry.js';

// The Studio tooltip: the name of an icon button, its key as key caps and one line on what it does. It replaces the browser's title
// tooltip, which shows late and says too little. One element serves every button; it is made on the first hover.
export const TOOLTIP_DELAY_MILLISECONDS = 300;
// After a tooltip closes, the next one opens at once for this long, so sweeping along a row of buttons reads without waiting.
export const TOOLTIP_WARM_MILLISECONDS = 250;
// How long the fade-out lasts before the element leaves the top layer; the style's exit duration matches it.
const TOOLTIP_EXIT_MILLISECONDS = 80;
const TOOLTIP_GAP = 8;
const TOOLTIP_EDGE = 8;
let tooltipCounter = 0;

/** The keys of a label such as "Shift+D" or "Ctrl+Shift+Z" as separate caps; a trailing plus is the plus key itself. */
export function splitKeyCaps(keyLabelText) {
  return String(keyLabelText ?? '').split(/\+(?!$)/).map(part => part.trim()).filter(Boolean);
}

/** What a tooltip shows for a button: what its owner registered, else the button's own accessible name. */
function readTip(button, registeredReaders) {
  const read = registeredReaders.get(button);
  if (read) return read();
  if (button.dataset?.icon && button.getAttribute('aria-label')) return { name: button.getAttribute('aria-label') };
  return null;
}

function keyboardFocusIsVisible(element) {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function createStudioTooltip({ root, documentReference, toolbarSelector = '.crucible-studio-toolbar' }) {
  const registeredReaders = new WeakMap();
  let element = null;
  let nameElement = null;
  let keysElement = null;
  let hintElement = null;
  let anchor = null;
  let visible = false;
  let warm = false;
  let showTimer = null;
  let pendingButton = null;
  // The button just pressed stays quiet until the pointer leaves it, so a click is not answered by its own tooltip.
  let pressedButton = null;
  let exitTimer = null;
  let warmTimer = null;

  function ensureElement() {
    if (element) return;
    tooltipCounter += 1;
    nameElement = documentReference.createElement('span');
    nameElement.className = 'crucible-studio-tooltip-name';
    keysElement = documentReference.createElement('span');
    keysElement.className = 'crucible-studio-tooltip-keys';
    hintElement = documentReference.createElement('span');
    hintElement.className = 'crucible-studio-tooltip-hint';
    const head = documentReference.createElement('span');
    head.className = 'crucible-studio-tooltip-head';
    head.append(nameElement, keysElement);
    element = documentReference.createElement('div');
    element.className = 'crucible-studio-tooltip';
    element.id = `crucible-studio-tooltip-${tooltipCounter}`;
    element.setAttribute('role', 'tooltip');
    element.setAttribute('popover', 'manual');
    element.append(head, hintElement);
    root.append(element);
  }

  function fill({ name, keys = '', hint = '' }) {
    nameElement.textContent = name;
    keysElement.replaceChildren(...splitKeyCaps(keys).map(cap => {
      const keyCap = documentReference.createElement('kbd');
      keyCap.textContent = cap;
      return keyCap;
    }));
    keysElement.hidden = splitKeyCaps(keys).length === 0;
    hintElement.textContent = hint;
    hintElement.hidden = !hint;
  }

  // Beside the toolbar the tooltip sits to the right of the button; anywhere else it sits below, or above when there is no room.
  function place(button) {
    const view = documentReference.defaultView;
    const viewWidth = view?.innerWidth ?? root.clientWidth;
    const viewHeight = view?.innerHeight ?? root.clientHeight;
    const buttonBox = button.getBoundingClientRect();
    const tipBox = element.getBoundingClientRect();
    const clamp = (value, size, limit) => Math.max(TOOLTIP_EDGE, Math.min(value, limit - size - TOOLTIP_EDGE));
    let left;
    let top;
    const toolbar = button.closest(toolbarSelector);
    if (toolbar) {
      // The gap is measured from the edge of the rail, not from the button inside its padding.
      left = toolbar.getBoundingClientRect().right + TOOLTIP_GAP;
      top = clamp(buttonBox.top + buttonBox.height / 2 - tipBox.height / 2, tipBox.height, viewHeight);
      element.dataset.side = 'right';
    } else {
      const roomBelow = viewHeight - buttonBox.bottom - TOOLTIP_GAP - TOOLTIP_EDGE;
      const below = roomBelow >= tipBox.height || buttonBox.top < tipBox.height + TOOLTIP_GAP + TOOLTIP_EDGE;
      top = below ? buttonBox.bottom + TOOLTIP_GAP : buttonBox.top - TOOLTIP_GAP - tipBox.height;
      left = clamp(buttonBox.left + buttonBox.width / 2 - tipBox.width / 2, tipBox.width, viewWidth);
      element.dataset.side = below ? 'bottom' : 'top';
    }
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  function show(button) {
    const tip = readTip(button, registeredReaders);
    if (!tip?.name) return;
    ensureElement();
    clearTimeout(exitTimer);
    if (anchor && anchor !== button) anchor.removeAttribute('aria-describedby');
    anchor = button;
    fill(tip);
    element.dataset.instant = visible || warm ? 'true' : 'false';
    if (!visible) element.showPopover?.();
    visible = true;
    // Measured after the content is in, so a longer name still lines up with its button.
    place(button);
    button.setAttribute('aria-describedby', element.id);
    element.dataset.state = 'in';
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = null;
    pendingButton = null;
    if (!visible) return;
    visible = false;
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
    element.dataset.state = 'out';
    warm = true;
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => { warm = false; }, TOOLTIP_WARM_MILLISECONDS);
    exitTimer = setTimeout(() => element.hidePopover?.(), TOOLTIP_EXIT_MILLISECONDS);
  }

  function request(button, immediate) {
    if (button === pressedButton || (button === anchor && visible) || (button === pendingButton && !immediate)) return;
    clearTimeout(showTimer);
    pendingButton = null;
    if (immediate || visible || warm) {
      show(button);
      return;
    }
    pendingButton = button;
    showTimer = setTimeout(() => {
      pendingButton = null;
      show(button);
    }, TOOLTIP_DELAY_MILLISECONDS);
  }

  const tipButtonOf = event => {
    const button = event.target?.closest?.('button');
    return button && readTip(button, registeredReaders) ? button : null;
  };

  const onPointerOver = event => {
    if (event.pointerType === 'touch') return;
    const button = tipButtonOf(event);
    if (button) request(button, false);
  };
  const onPointerOut = event => {
    const button = event.target?.closest?.('button');
    if (!button || button.contains(event.relatedTarget)) return;
    if (button === pressedButton) pressedButton = null;
    if (button === anchor || button === pendingButton) hide();
  };
  const onPointerDown = event => {
    pressedButton = event.target?.closest?.('button') ?? null;
    hide();
  };
  const onFocusIn = event => {
    const button = tipButtonOf(event);
    if (button && keyboardFocusIsVisible(button)) request(button, true);
  };
  const onFocusOut = () => hide();
  const onKeyDown = event => {
    if (event.key === 'Escape') hide();
  };

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('scroll', hide, true);
  root.addEventListener('wheel', hide, { capture: true, passive: true });
  // Escape is heard on the window, wherever the focus is; where there is no window the root hears it.
  const keyTarget = documentReference.defaultView?.addEventListener ? documentReference.defaultView : root;
  keyTarget.addEventListener('keydown', onKeyDown, true);

  return {
    /** Gives a button a tooltip made fresh on every show: `read()` returns `{ name, keys, hint }`, so a changed keymap or state shows at once. */
    describe(button, read) {
      registeredReaders.set(button, read);
      button.removeAttribute('title');
      return button;
    },
    hide,
    get element() {
      return element;
    },
    dispose() {
      clearTimeout(showTimer);
      clearTimeout(exitTimer);
      clearTimeout(warmTimer);
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerout', onPointerOut);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('scroll', hide, true);
      root.removeEventListener('wheel', hide, true);
      keyTarget.removeEventListener('keydown', onKeyDown, true);
      element?.remove();
    },
  };
}

registerStudioStyle(`
.crucible-studio-tooltip {
  position: fixed;
  margin: 0;
  inset: auto;
  inline-size: max-content;
  max-inline-size: 280px;
  padding: var(--studio-space-8);
  border: 1px solid var(--studio-border);
  border-radius: var(--studio-radius-control);
  background: var(--studio-panel);
  color: var(--studio-text);
  box-shadow: var(--studio-shadow);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  overflow: visible;
  opacity: 0;
  transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
}
.crucible-studio-tooltip:popover-open { display: grid; gap: var(--studio-space-4); }
.crucible-studio-tooltip[data-state="in"] { opacity: 1; }
.crucible-studio-tooltip[data-state="out"] { transition-duration: var(--studio-motion-exit); }
.crucible-studio-tooltip[data-instant="true"] { transition-duration: 0ms; }
.crucible-studio-tooltip-head { display: flex; align-items: center; justify-content: space-between; gap: var(--studio-space-12); }
.crucible-studio-tooltip-name { font-weight: 600; white-space: nowrap; }
.crucible-studio-tooltip-keys { display: flex; gap: var(--studio-space-4); }
.crucible-studio-tooltip-keys[hidden], .crucible-studio-tooltip-hint[hidden] { display: none; }
.crucible-studio .crucible-studio-tooltip-keys kbd {
  min-inline-size: 20px;
  padding: 2px var(--studio-space-4);
  text-align: center;
  border: 1px solid var(--studio-border);
  background: color-mix(in srgb, var(--studio-text) 8%, transparent);
}
.crucible-studio-tooltip-hint { color: var(--studio-muted); }
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio-tooltip { transition-property: opacity, translate; translate: var(--tooltip-shift, 0 0); }
  .crucible-studio-tooltip[data-side="right"] { --tooltip-shift: -4px 0; }
  .crucible-studio-tooltip[data-side="bottom"] { --tooltip-shift: 0 -4px; }
  .crucible-studio-tooltip[data-side="top"] { --tooltip-shift: 0 4px; }
  .crucible-studio-tooltip[data-state="in"] { --tooltip-shift: 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .crucible-studio-tooltip { transition-property: opacity; translate: none; }
}
`);
