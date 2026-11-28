// Studio colour picker: a popover with a saturation and value area, a hue slider, a hex field and quick picks.
// The caller decides what a colour means: it gets every change through `onPreview` while the popover is open and one
// `onConfirm` or `onCancel` when it closes. Edit mode confirms on any dismissal and Escape cancels; add mode confirms only
// through the Add button or Enter, so a colour is never added by clicking away.

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu;
const KEYBOARD_STEP = 0.02;
const KEYBOARD_STEP_LARGE = 0.1;
const POPOVER_WIDTH = 248;
const POPOVER_HEIGHT_ESTIMATE = 330;
const VIEWPORT_MARGIN = 8;

/** A colour typed as `#rgb`, `#rrggbb` or the same without the hash, as lowercase `#rrggbb`; null when it is not a colour. */
export function normaliseHexColour(text) {
  const match = HEX_PATTERN.exec(String(text ?? '').trim());
  if (!match) {
    return null;
  }
  const digits = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
  return `#${digits.toLowerCase()}`;
}

/** Hue in degrees (0 to 360), saturation and value (0 to 1) of a `#rrggbb` colour. */
export function hexToHsv(hex) {
  const normalised = normaliseHexColour(hex);
  if (!normalised) {
    throw new RangeError(`Pass a colour as #rrggbb, received ${JSON.stringify(hex)}.`);
  }
  const [red, green, blue] = [1, 3, 5].map(start => Number.parseInt(normalised.slice(start, start + 2), 16) / 255);
  const maximum = Math.max(red, green, blue);
  const spread = maximum - Math.min(red, green, blue);
  let hue = 0;
  if (spread > 0) {
    if (maximum === red) {
      hue = ((green - blue) / spread) % 6;
    } else if (maximum === green) {
      hue = (blue - red) / spread + 2;
    } else {
      hue = (red - green) / spread + 4;
    }
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation: maximum === 0 ? 0 : spread / maximum, value: maximum };
}

/** The `#rrggbb` colour of a hue in degrees and a saturation and value from 0 to 1. */
export function hsvToHex({ hue, saturation, value }) {
  const channelFor = offset => {
    const sector = (offset + hue / 60) % 6;
    const level = value - value * saturation * Math.max(0, Math.min(sector, 4 - sector, 1));
    return Math.round(level * 255).toString(16).padStart(2, '0');
  };
  return `#${channelFor(5)}${channelFor(3)}${channelFor(1)}`;
}

function clampUnit(number) {
  return Math.min(1, Math.max(0, number));
}

/**
 * Builds the picker. `open({ anchor, hex, mode, quickColours, confirmLabel, onPreview, onConfirm, onCancel })` shows it
 * beside `anchor`; `mode` is 'edit' or 'add'. Append `element` once somewhere inside the Studio root.
 */
export function createColourPicker({ documentReference, createElement, createIcon }) {
  const thumb = createElement(documentReference, 'span', { className: 'crucible-studio-picker-thumb', attributes: { 'aria-hidden': 'true' } });
  const area = createElement(documentReference, 'div', {
    className: 'crucible-studio-picker-area',
    tabIndex: 0,
    attributes: { role: 'application', 'aria-label': 'Saturation and brightness. Arrow keys move the colour.' },
  }, thumb);
  const hueSlider = createElement(documentReference, 'input', {
    type: 'range',
    className: 'crucible-studio-picker-hue',
    min: '0',
    max: '360',
    step: '1',
    value: '0',
    attributes: { 'aria-label': 'Hue' },
  });
  const preview = createElement(documentReference, 'span', { className: 'crucible-studio-picker-preview', attributes: { 'aria-hidden': 'true' } });
  const hexInput = createElement(documentReference, 'input', {
    type: 'text',
    className: 'crucible-studio-picker-hex',
    spellcheck: false,
    maxLength: 7,
    attributes: { 'aria-label': 'Hex colour', autocomplete: 'off' },
  });
  const quickRow = createElement(documentReference, 'div', { className: 'crucible-studio-picker-quick', attributes: { role: 'group', 'aria-label': 'Quick picks' } });
  const confirmLabelElement = createElement(documentReference, 'span');
  const confirmButton = createElement(
    documentReference,
    'button',
    { type: 'button', className: 'crucible-studio-picker-confirm', hidden: true },
    createIcon(documentReference, 'check'),
    confirmLabelElement,
  );
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-popover crucible-studio-picker', attributes: { popover: 'auto', role: 'dialog', 'aria-label': 'Colour' } },
    area,
    hueSlider,
    createElement(documentReference, 'div', { className: 'crucible-studio-picker-row' }, preview, hexInput),
    quickRow,
    confirmButton,
  );

  let session = null;
  let hsv = { hue: 0, saturation: 0, value: 0 };
  let currentHex = '#000000';

  function paint() {
    element.style.setProperty('--picker-hue', String(Math.round(hsv.hue)));
    element.style.setProperty('--picker-colour', currentHex);
    thumb.style.left = `${hsv.saturation * 100}%`;
    thumb.style.top = `${(1 - hsv.value) * 100}%`;
    hueSlider.value = String(Math.round(hsv.hue));
    if (documentReference.activeElement !== hexInput) {
      hexInput.value = currentHex;
    }
  }

  function applyHsv(nextHsv) {
    hsv = nextHsv;
    const nextHex = hsvToHex(hsv);
    const changed = nextHex !== currentHex;
    currentHex = nextHex;
    paint();
    if (changed) {
      session?.onPreview?.(currentHex);
    }
  }

  function applyHex(hex) {
    const normalised = normaliseHexColour(hex);
    if (!normalised) {
      return;
    }
    const changed = normalised !== currentHex;
    currentHex = normalised;
    hsv = hexToHsv(normalised);
    paint();
    if (changed) {
      session?.onPreview?.(currentHex);
    }
  }

  function finish(outcome) {
    if (session && session.outcome === undefined) {
      session.outcome = outcome;
    }
    element.hidePopover?.();
  }

  function moveAreaTo(event) {
    const bounds = area.getBoundingClientRect();
    const saturation = bounds.width > 0 ? clampUnit((event.clientX - bounds.left) / bounds.width) : hsv.saturation;
    const value = bounds.height > 0 ? 1 - clampUnit((event.clientY - bounds.top) / bounds.height) : hsv.value;
    applyHsv({ hue: hsv.hue, saturation, value });
  }

  let dragging = false;
  area.addEventListener('pointerdown', event => {
    dragging = true;
    area.setPointerCapture?.(event.pointerId);
    area.focus?.();
    moveAreaTo(event);
  });
  area.addEventListener('pointermove', event => {
    if (dragging) {
      moveAreaTo(event);
    }
  });
  const stopDragging = () => { dragging = false; };
  area.addEventListener('pointerup', stopDragging);
  area.addEventListener('pointercancel', stopDragging);
  area.addEventListener('keydown', event => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    applyHsv({ hue: hsv.hue, saturation: clampUnit(hsv.saturation + move[0]), value: clampUnit(hsv.value + move[1]) });
  });

  hueSlider.addEventListener('input', () => applyHsv({ hue: Number(hueSlider.value), saturation: hsv.saturation, value: hsv.value }));
  hexInput.addEventListener('input', () => applyHex(hexInput.value));
  hexInput.addEventListener('change', () => {
    hexInput.value = currentHex;
  });
  hexInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyHex(hexInput.value);
      finish('confirm');
    }
  });
  confirmButton.addEventListener('click', () => finish('confirm'));

  // Escape belongs to the picker while it is open: it cancels and must not also reach the Studio shortcuts.
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      finish('cancel');
    }
  });

  const isOpen = () => element.popoverOpen ?? element.matches(':popover-open');

  // Hands the colour to the caller, once, whichever way the popover closed.
  function settle() {
    if (!session) {
      return;
    }
    const closing = session;
    session = null;
    dragging = false;
    const outcome = closing.outcome ?? (closing.mode === 'edit' ? 'confirm' : 'cancel');
    if (outcome === 'confirm') {
      closing.onConfirm?.(currentHex);
    } else {
      closing.onCancel?.();
    }
    closing.anchor.focus?.();
  }

  // The browser reports a close after the fact; a picker already reopened for another swatch is not closing.
  element.addEventListener('toggle', event => {
    if (event.newState === 'closed' && !isOpen()) {
      settle();
    }
  });

  function placeBeside(anchor) {
    const rectangle = anchor.getBoundingClientRect();
    const view = documentReference.defaultView;
    const viewportWidth = view?.innerWidth ?? 1280;
    const viewportHeight = view?.innerHeight ?? 800;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rectangle.left - 5, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN));
    const opensUpward = rectangle.bottom + 12 + POPOVER_HEIGHT_ESTIMATE > viewportHeight && rectangle.top > viewportHeight / 2;
    element.style.left = `${Math.round(left)}px`;
    element.style.right = 'auto';
    element.style.top = opensUpward ? 'auto' : `${Math.round(rectangle.bottom + 12)}px`;
    element.style.bottom = opensUpward ? `${Math.round(Math.max(VIEWPORT_MARGIN, viewportHeight - rectangle.top + 12))}px` : 'auto';
    element.style.setProperty('--studio-popover-origin', `0 ${opensUpward ? '100%' : '0'}`);
    element.style.setProperty('--studio-popover-shift', opensUpward ? '0 4px' : '0 -4px');
  }

  function open({ anchor, hex, mode = 'edit', quickColours = [], confirmLabel = 'Add colour', onPreview, onConfirm, onCancel }) {
    const startHex = normaliseHexColour(hex);
    if (!startHex) {
      throw new RangeError(`Pass the starting colour as #rrggbb, received ${JSON.stringify(hex)}.`);
    }
    if (session) {
      settle();
    }
    if (isOpen()) {
      element.hidePopover();
    }
    session = { anchor, mode, onPreview, onConfirm, onCancel, outcome: undefined };
    currentHex = startHex;
    hsv = hexToHsv(startHex);
    quickRow.replaceChildren(...[...new Set(quickColours.map(normaliseHexColour).filter(Boolean))].map(colour => {
      const button = createElement(documentReference, 'button', { type: 'button', title: colour, attributes: { 'aria-label': `Use ${colour}` } });
      button.style.background = colour;
      button.addEventListener('click', () => applyHex(colour));
      return button;
    }));
    quickRow.hidden = quickRow.children.length === 0;
    confirmButton.hidden = mode !== 'add';
    confirmLabelElement.textContent = confirmLabel;
    paint();
    placeBeside(anchor);
    element.showPopover?.();
    // Focus inside the popover, so Escape and the arrow keys reach it and not the Studio shortcuts.
    area.focus?.();
  }

  return { element, open, close: () => finish('cancel'), currentHex: () => currentHex };
}

// The popover reuses the menu popover frame. Spacing uses the Studio scale: equal padding on every side, a larger gap
// between the controls than inside the quick-pick row.
export const COLOUR_PICKER_CSS = `
.crucible-studio-popover.crucible-studio-picker {
  inline-size: ${POPOVER_WIDTH}px;
  max-inline-size: ${POPOVER_WIDTH}px;
  padding: var(--studio-space-12);
  gap: var(--studio-space-12);
}
.crucible-studio-picker-area {
  position: relative;
  block-size: 128px;
  border-radius: var(--studio-radius-control);
  background:
    linear-gradient(to top, #000, transparent),
    linear-gradient(to right, #fff, hsl(var(--picker-hue, 0) 100% 50%));
  touch-action: none;
  cursor: crosshair;
}
.crucible-studio-picker-area:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }
.crucible-studio-picker-thumb {
  position: absolute;
  inline-size: 14px;
  block-size: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 999px;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.4);
  pointer-events: none;
}
.crucible-studio input[type="range"].crucible-studio-picker-hue {
  inline-size: 100%;
  block-size: 12px;
  margin: 0;
  border-radius: 999px;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  appearance: none;
}
.crucible-studio-picker-hue::-webkit-slider-runnable-track { background: transparent; block-size: 12px; }
.crucible-studio-picker-hue::-webkit-slider-thumb {
  appearance: none;
  inline-size: 16px;
  block-size: 16px;
  margin-block-start: -2px;
  border-radius: 999px;
  border: 2px solid #fff;
  background: hsl(var(--picker-hue, 0) 100% 50%);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.4);
}
.crucible-studio-picker-hue::-moz-range-thumb {
  inline-size: 12px;
  block-size: 12px;
  border-radius: 999px;
  border: 2px solid #fff;
  background: hsl(var(--picker-hue, 0) 100% 50%);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.4);
}
.crucible-studio-picker-row {
  display: flex;
  align-items: center;
  gap: var(--studio-space-8);
}
.crucible-studio-picker-preview {
  flex: none;
  inline-size: 28px;
  block-size: 28px;
  border-radius: 999px;
  border: 1px solid var(--studio-border);
  background: var(--picker-colour, #000);
}
.crucible-studio input.crucible-studio-picker-hex {
  flex: 1;
  min-inline-size: 0;
  font-family: var(--studio-font-mono);
  text-transform: lowercase;
}
.crucible-studio-picker-quick {
  display: flex;
  flex-wrap: wrap;
  gap: var(--studio-space-8);
}
.crucible-studio-picker-quick[hidden] { display: none; }
.crucible-studio .crucible-studio-picker-quick > button {
  inline-size: 24px;
  min-inline-size: 24px;
  block-size: 24px;
  min-block-size: 24px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--studio-border);
}
.crucible-studio .crucible-studio-picker-quick > button:hover { box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-muted); }
.crucible-studio-picker-confirm[hidden] { display: none; }
.crucible-studio button.crucible-studio-picker-confirm {
  justify-content: center;
  font-weight: 600;
  background: color-mix(in srgb, var(--studio-text) 10%, transparent);
}
`;
