// The row of round material colours in the Material tab. Hovering a swatch dims it and shows a pencil in a ring; a click opens
// the colour picker, whose edits apply live as one undo step. The dashed + opens the same picker and adds a colour on confirm.
import { createColourPicker } from './studio-colour-picker.js';
import { hexToLinearRgb, linearRgbToHex } from './studio-controller.js';

const DEFAULT_NEW_COLOUR = [0.72, 0.72, 0.72];

/** Builds the swatch section: `element` goes in the Material panel, `sync` follows the recipe, `scrollPressedIntoView` runs after a sync. */
export function createMaterialSwatches({ documentReference, createElement, createIcon, createIconButton, controller, selectedTargets, announce }) {
  const strip = createElement(documentReference, 'div', { className: 'crucible-studio-swatches crucible-studio-scroll' });
  const addButton = createIconButton(documentReference, 'add', 'Add a colour', { className: 'crucible-studio-swatch-add' });
  const picker = createColourPicker({ documentReference, createElement, createIcon });
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-palette-section' }, strip, addButton, picker.element);

  let lastIdsKey = '';
  let lastPressedMaterialId;
  let scrollWanted = false;
  let materials = [];

  const quickColours = () => materials.map(material => linearRgbToHex(material.color));

  function editColour(material, anchor) {
    const originalHex = linearRgbToHex(material.color);
    let edited = false;
    controller.beginUndoGroup();
    picker.open({
      anchor,
      hex: originalHex,
      mode: 'edit',
      quickColours: quickColours(),
      onPreview: hex => {
        edited = true;
        controller.updateMaterial(material.id, { hexColor: hex });
      },
      onConfirm: () => controller.endUndoGroup(),
      onCancel: () => {
        // The group holds the whole live edit as one history step; undoing it puts the colour back.
        if (edited) {
          controller.undo();
        }
        controller.endUndoGroup();
      },
    });
  }

  addButton.addEventListener('click', () => {
    picker.open({
      anchor: addButton,
      hex: linearRgbToHex(DEFAULT_NEW_COLOUR),
      mode: 'add',
      quickColours: quickColours(),
      confirmLabel: 'Add colour',
      onConfirm: hex => {
        const created = controller.createMaterial({ color: hexToLinearRgb(hex), assignToNodeIds: selectedTargets() });
        announce(`Created ${created.id}`);
      },
    });
  });

  function buildSwatch(material) {
    const swatch = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-swatch-btn',
      title: material.id,
      attributes: { 'aria-pressed': 'false', 'aria-label': `Edit colour of ${material.id}` },
    }, createIcon(documentReference, 'edit'));
    swatch.addEventListener('click', () => {
      const current = controller.exportRecipe().materials.find(candidate => candidate.id === material.id);
      if (current) {
        editColour(current, swatch);
      }
    });
    return swatch;
  }

  /** Rebuilds the swatches only when a material was added or removed; a recolour repaints the swatch it changed. */
  function sync(recipe, boundMaterialId) {
    materials = recipe.materials;
    const idsKey = materials.map(material => material.id).join('|');
    if (idsKey !== lastIdsKey) {
      lastIdsKey = idsKey;
      scrollWanted = true;
      strip.replaceChildren(...materials.map(buildSwatch));
      lastPressedMaterialId = undefined;
    }
    materials.forEach((material, index) => {
      const swatch = strip.children[index];
      const hex = linearRgbToHex(material.color);
      if (swatch.dataset.colour !== hex) {
        swatch.dataset.colour = hex;
        swatch.style.setProperty('--swatch-colour', hex);
      }
    });
    if (boundMaterialId === lastPressedMaterialId) {
      return;
    }
    lastPressedMaterialId = boundMaterialId;
    scrollWanted = true;
    materials.forEach((material, index) => {
      const pressed = material.id === boundMaterialId ? 'true' : 'false';
      const swatch = strip.children[index];
      if (swatch.getAttribute('aria-pressed') !== pressed) {
        swatch.setAttribute('aria-pressed', pressed);
      }
    });
  }

  // The strip is one row that scrolls sideways; the swatch of the selected node stays inside it.
  function scrollPressedIntoView() {
    if (!scrollWanted) {
      return;
    }
    scrollWanted = false;
    const pressedSwatch = [...strip.children].find(swatch => swatch.getAttribute('aria-pressed') === 'true');
    if (!pressedSwatch || !Number.isFinite(pressedSwatch.offsetLeft)) {
      return;
    }
    const swatchStart = pressedSwatch.offsetLeft;
    const swatchEnd = swatchStart + pressedSwatch.offsetWidth;
    if (swatchStart < strip.scrollLeft) {
      strip.scrollLeft = swatchStart - 4;
    } else if (swatchEnd > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = swatchEnd - strip.clientWidth + 4;
    }
  }

  return { element, strip, sync, scrollPressedIntoView };
}

export const MATERIAL_SWATCHES_CSS = `
.crucible-studio-palette-section {
  display: flex;
  align-items: center;
  gap: var(--studio-space-4);
  flex-shrink: 0;
}
/* One row that scrolls sideways. The padding keeps the rings of a swatch inside the strip. */
.crucible-studio-swatches {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--studio-space-4);
  min-inline-size: 0;
  padding: var(--studio-space-4);
  margin: calc(var(--studio-space-4) * -1) 0 calc(var(--studio-space-4) * -1) calc(var(--studio-space-4) * -1);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  container-type: scroll-state;
}
.crucible-studio-swatches::-webkit-scrollbar { display: none; }
/* While more swatches lie to the right, the last one in view dissolves into the panel instead of being sliced. */
.crucible-studio-swatches::after {
  content: "";
  position: sticky;
  inset-inline-end: -4px;
  flex: none;
  inline-size: 28px;
  block-size: 24px;
  margin-inline-start: -28px;
  background: linear-gradient(to right, transparent, var(--studio-panel) 85%);
  opacity: 0;
  pointer-events: none;
}
@container scroll-state(scrollable: right) {
  .crucible-studio-swatches::after { opacity: 1; }
}
.crucible-studio-swatches > button { flex: none; }
.crucible-studio button.crucible-studio-swatch-btn,
.crucible-studio button.crucible-studio-swatch-add {
  position: relative;
  min-inline-size: 24px;
  min-block-size: 24px;
  inline-size: 24px;
  block-size: 24px;
  padding: 0;
  border-radius: 999px;
}
.crucible-studio button.crucible-studio-swatch-btn {
  border: 1px solid var(--studio-border);
  background: var(--swatch-colour, transparent);
  overflow: hidden;
}
.crucible-studio button.crucible-studio-swatch-btn[aria-pressed="true"] {
  box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-text);
}
/* The dim and the pencil fade in over the colour; the ring is drawn outside it in the panel colour and the muted text colour. */
.crucible-studio-swatch-btn .crucible-studio-icon {
  position: absolute;
  inset: 0;
  margin: auto;
  inline-size: 12px;
  block-size: 12px;
  color: #fff;
  opacity: 0;
  transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
}
.crucible-studio button.crucible-studio-swatch-btn::before {
  content: "";
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.5);
  opacity: 0;
  transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
}
.crucible-studio button.crucible-studio-swatch-btn:focus-visible { box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-accent); }
@media (hover: hover) {
  .crucible-studio button.crucible-studio-swatch-btn:hover { box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-muted); }
  .crucible-studio button.crucible-studio-swatch-btn[aria-pressed="true"]:hover { box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-text); }
}
.crucible-studio button.crucible-studio-swatch-btn:focus-visible::before,
.crucible-studio-swatch-btn:focus-visible .crucible-studio-icon { opacity: 1; }
@media (hover: hover) {
  .crucible-studio button.crucible-studio-swatch-btn:hover::before,
  .crucible-studio-swatch-btn:hover .crucible-studio-icon { opacity: 1; }
}
@media (hover: none) {
  .crucible-studio-swatch-btn .crucible-studio-icon { display: none; }
}
.crucible-studio button.crucible-studio-swatch-add {
  flex: none;
  color: var(--studio-muted);
  border: 1px dashed color-mix(in srgb, var(--studio-text) 30%, transparent);
}
.crucible-studio-swatch-add .crucible-studio-icon {
  inline-size: 13px;
  block-size: 13px;
}
`;
