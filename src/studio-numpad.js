// Number pad view keys: preset bindings, one-time detection notice, setup keyboard drawings, and edit-mode key routing.
import { leadWithActionIcon } from './studio-icons.js';

export const NUMPAD_VIEW_BINDINGS = Object.freeze({
  'view.front': Object.freeze({ code: 'Numpad1' }),
  'view.right': Object.freeze({ code: 'Numpad3' }),
  'view.top': Object.freeze({ code: 'Numpad7' }),
  'view.projection': Object.freeze({ code: 'Numpad5' }),
});

export const NUMPAD_FRAME_BINDINGS = Object.freeze([
  Object.freeze({ key: 'f' }),
  Object.freeze({ code: 'NumpadDecimal' }),
]);

export function isNumpadKeyEvent(event) {
  return typeof event?.code === 'string' && event.code.startsWith('Numpad');
}

export function resolveStudioKeyAction(keymap, event, editingMesh, findKeymapAction, meshEditPassThrough) {
  if (!editingMesh) {
    return { match: findKeymapAction(keymap, event, 'normal'), fromMeshContext: false };
  }
  const meshMatch = findKeymapAction(keymap, event, 'mesh');
  const normalMatch = findKeymapAction(keymap, event, 'normal');
  // In edit mode with number pad enabled, physical Numpad 1/3 drive views rather than digit vertex/face modes.
  if (normalMatch && meshEditPassThrough.has(normalMatch.actionId) && isNumpadKeyEvent(event) && normalMatch.binding.code && !meshMatch?.binding.code) {
    return { match: normalMatch, fromMeshContext: false };
  }
  if (meshMatch) {
    return { match: meshMatch, fromMeshContext: true };
  }
  return { match: normalMatch, fromMeshContext: false };
}

function createSvgElement(documentReference, tagName, attributes = {}) {
  const element = documentReference.createElementNS('http://www.w3.org/2000/svg', tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

const KEY_UNIT = 9;
const KEY_PITCH = 10;
const KEY_HEIGHT = 8.5;

function appendKeyRow(documentReference, svg, startX, startY, widths, activeIndices = new Set()) {
  let cursorX = startX;
  widths.forEach((units, index) => {
    const keyWidth = units * KEY_PITCH - 1.5;
    svg.append(createSvgElement(documentReference, 'rect', {
      x: cursorX.toFixed(1),
      y: startY.toFixed(1),
      width: keyWidth.toFixed(1),
      height: KEY_HEIGHT.toFixed(1),
      rx: 1.5,
      class: activeIndices.has(index) ? 'crucible-studio-kb-key crucible-studio-kb-active' : 'crucible-studio-kb-key',
    }));
    cursorX += units * KEY_PITCH;
  });
}

function appendNumpadBlock(documentReference, svg, startX, startY) {
  svg.append(createSvgElement(documentReference, 'rect', {
    x: (startX - 2.5).toFixed(1),
    y: (startY - 2.5).toFixed(1),
    width: (4 * KEY_PITCH + 3.5).toFixed(1),
    height: (5 * KEY_PITCH + 3.5).toFixed(1),
    rx: 3,
    class: 'crucible-studio-kb-zone',
  }));
  appendKeyRow(documentReference, svg, startX, startY, [1, 1, 1, 1]);
  appendKeyRow(documentReference, svg, startX, startY + KEY_PITCH, [1, 1, 1], new Set([0]));
  appendKeyRow(documentReference, svg, startX, startY + 2 * KEY_PITCH, [1, 1, 1], new Set([1]));
  appendKeyRow(documentReference, svg, startX, startY + 3 * KEY_PITCH, [1, 1, 1], new Set([0, 2]));
  appendKeyRow(documentReference, svg, startX, startY + 4 * KEY_PITCH, [2, 1], new Set([1]));
  const rightColumnX = startX + 3 * KEY_PITCH;
  for (const rowOffset of [1, 3]) {
    svg.append(createSvgElement(documentReference, 'rect', {
      x: rightColumnX.toFixed(1),
      y: (startY + rowOffset * KEY_PITCH).toFixed(1),
      width: (KEY_PITCH - 1.5).toFixed(1),
      height: (2 * KEY_PITCH - 1.5).toFixed(1),
      rx: 1.5,
      class: 'crucible-studio-kb-key',
    }));
  }
}

/**
 * Simple drawing of a full-size keyboard (number pad highlighted) or compact keyboard without a number pad (number row
 * view keys highlighted), using CSS tokens only so both themes keep their contrast.
 */
export function createKeyboardDrawing(documentReference, withNumberPad) {
  const frameX = withNumberPad ? 6 : 29;
  const frameWidth = withNumberPad ? 228 : 182;
  const mainStartX = frameX + 6;
  const rowTopY = 17;
  const svg = createSvgElement(documentReference, 'svg', {
    viewBox: '0 0 240 86',
    class: 'crucible-studio-keyboard-svg',
    'aria-hidden': 'true',
  });
  svg.append(createSvgElement(documentReference, 'rect', {
    x: frameX,
    y: 11,
    width: frameWidth,
    height: 64,
    rx: 5,
    class: 'crucible-studio-kb-frame',
  }));
  const numberRowHighlights = withNumberPad ? new Set() : new Set([1, 3, 5, 7]);
  const mainRows = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1.4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.6],
    [1.7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.3],
    [2.1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.9],
    [1.25, 1.25, 1.25, 5.75, 1.25, 1.25, 1.25, 1.25],
  ];
  mainRows.forEach((widths, rowIndex) => {
    appendKeyRow(documentReference, svg, mainStartX, rowTopY + rowIndex * KEY_PITCH, widths, rowIndex === 0 ? numberRowHighlights : new Set());
  });
  const navStartX = mainStartX + 14.3 * KEY_PITCH;
  if (withNumberPad) {
    appendKeyRow(documentReference, svg, navStartX, rowTopY, [1, 1, 1]);
    appendKeyRow(documentReference, svg, navStartX, rowTopY + KEY_PITCH, [1, 1, 1]);
    appendKeyRow(documentReference, svg, navStartX + KEY_PITCH, rowTopY + 3 * KEY_PITCH, [1]);
    appendKeyRow(documentReference, svg, navStartX, rowTopY + 4 * KEY_PITCH, [1, 1, 1]);
    appendNumpadBlock(documentReference, svg, navStartX + 3.4 * KEY_PITCH, rowTopY);
  } else {
    appendKeyRow(documentReference, svg, navStartX, rowTopY + 4 * KEY_PITCH, [1, 1, 1]);
    svg.append(createSvgElement(documentReference, 'rect', {
      x: (navStartX + KEY_PITCH).toFixed(1),
      y: (rowTopY + 3 * KEY_PITCH).toFixed(1),
      width: KEY_UNIT - 0.5,
      height: KEY_HEIGHT,
      rx: 1.5,
      class: 'crucible-studio-kb-key',
    }));
  }
  return svg;
}

/** One-time viewport notice shown when a number pad key arrives while Number pad is off. */
export function createNumberPadNotice({ documentReference, createIcon, onSwitch, onKeep }) {
  const message = documentReference.createElement('p');
  message.textContent = 'Number pad key pressed. Use the number pad for view keys?';
  const switchButton = documentReference.createElement('button');
  switchButton.type = 'button';
  switchButton.textContent = 'Use number pad';
  leadWithActionIcon(switchButton, createIcon('check'), 'check');
  switchButton.addEventListener('click', onSwitch);
  const keepButton = documentReference.createElement('button');
  keepButton.type = 'button';
  keepButton.textContent = 'Keep number row';
  leadWithActionIcon(keepButton, createIcon('close'), 'close');
  keepButton.addEventListener('click', onKeep);

  const element = documentReference.createElement('div');
  element.className = 'crucible-studio-island crucible-studio-numpad-notice';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;
  element.append(createIcon('keyboard'), message, switchButton, keepButton);

  return {
    element,
    show() {
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
    get visible() {
      return !element.hidden;
    },
  };
}

export const STUDIO_NUMPAD_CSS = `
.crucible-studio-numpad-notice {
  position: absolute;
  inset-block-start: var(--studio-top);
  inset-inline: calc(var(--studio-rail) + 2 * var(--studio-edge)) calc(var(--studio-side-width, 284px) + 2 * var(--studio-edge));
  inline-size: fit-content;
  max-inline-size: 620px;
  margin-inline: auto;
  gap: 8px;
  padding: 12px 12px;
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 13px;
  z-index: 9;
}
.crucible-studio[data-compact="true"] .crucible-studio-numpad-notice { inset-inline: var(--studio-edge); }
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-numpad-notice {
  inset-block-start: var(--studio-edge);
  inset-inline: var(--studio-edge);
}
.crucible-studio-numpad-notice[hidden] { display: none; }
.crucible-studio-numpad-notice p { margin: 0; }
.crucible-studio-numpad-notice .crucible-studio-icon { flex: none; color: var(--studio-accent); }
.crucible-studio-setup-cards-numpad { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.crucible-studio-setup-keyboard-preview {
  aspect-ratio: 240 / 86;
  background: var(--studio-bg);
}
.crucible-studio-keyboard-svg {
  display: block;
  inline-size: 100%;
  block-size: 100%;
}
.crucible-studio-kb-frame {
  fill: color-mix(in srgb, var(--studio-text) 4%, var(--studio-bg));
  stroke: var(--studio-border);
  stroke-width: 1;
}
.crucible-studio-kb-zone {
  fill: color-mix(in srgb, var(--studio-accent) 12%, transparent);
  stroke: color-mix(in srgb, var(--studio-accent) 45%, transparent);
  stroke-width: 1;
}
.crucible-studio-kb-key {
  fill: color-mix(in srgb, var(--studio-text) 14%, transparent);
}
.crucible-studio-kb-key.crucible-studio-kb-active {
  fill: var(--studio-accent);
}
.crucible-studio .crucible-studio-setup-cards-numpad .crucible-studio-setup-keycap kbd {
  padding-inline: var(--studio-space-4);
  font-size: 12px;
  white-space: nowrap;
}
.crucible-studio-setup-keycap-name {
  font-size: 11px;
  color: var(--studio-muted);
}
`;
