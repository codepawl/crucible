// The grips that resize Studio's panel column.
//
// Docked, the column is one piece: its inner edge sets the width of both cards and the gap between the cards sets how
// much of the column the Scene card takes. Floating, each card is its own window: its left edge sets only its width and
// its bottom edge only its height, and holding Ctrl (Meta on a Mac) works on both cards at once. A drag previews the
// size and letting go saves it. The Agent card, when a host offers one, sits under them and is resized by its top edge.
// Arrow keys do the same in steps, and a double click goes back to the automatic size, for both cards with Ctrl.

import {
  STUDIO_AGENT_CARD,
  STUDIO_CARD_SIZE,
  STUDIO_PANEL_WIDTH,
  STUDIO_PREFERENCE_DEFAULTS,
  STUDIO_SCENE_SHARE,
  normalizeStudioPreferences,
} from './studio-preferences.js';

const PANEL_WIDTH_KEY_STEP = 16;
const SCENE_SHARE_KEY_STEP = 5;
const CARD_HEIGHT_KEY_STEP = 24;
const DEFAULT_SCENE_SHARE = 42;
// The gap between the two cards, as the stylesheet sets it.
const CARD_GAP = 6;
// A card height used while the card has not been laid out, for instance before the window has a size.
const UNMEASURED_CARD_HEIGHT = 240;

/** Whether the pointer or key event asks for both cards at once. */
function bothCardsRequested(event) {
  return Boolean(event.ctrlKey || event.metaKey);
}

// How far a drag has grown its card: an edge on the left or the top grows it by moving away from the card.
function growthInPixels(axis, drag, event) {
  if (axis === 'x') {
    return drag.clientX - event.clientX;
  }
  return axis === 'y-up' ? drag.clientY - event.clientY : event.clientY - drag.clientY;
}

function measuredHeight(element, fallback) {
  const height = element.getBoundingClientRect?.().height;
  return height > 0 ? Math.round(height) : fallback;
}

/**
 * Builds the panel column from the two cards and wires its grips.
 * `readPreferences` returns the saved preferences and `changePreferences` saves a group of changes at once.
 */
export function createPanelGrips({ documentReference, createElement, root, outlinerDock, inspectorElement, agentDock = null, readPreferences, changePreferences }) {
  function createGrip(className, label, orientation, valueRange) {
    const attributes = {
      role: 'separator',
      'aria-orientation': orientation,
      'aria-label': label,
      'aria-valuemin': String(valueRange.least),
      'aria-valuemax': String(valueRange.most),
    };
    return createElement(documentReference, 'div', { className: `crucible-studio-grip ${className}`, tabIndex: 0, attributes });
  }

  const cardWidthRange = { least: STUDIO_PANEL_WIDTH.least, most: STUDIO_PANEL_WIDTH.most };
  const cardHeightRange = { least: STUDIO_CARD_SIZE.leastHeight, most: STUDIO_CARD_SIZE.mostHeight };
  const widthGrip = createGrip('crucible-studio-grip-width', 'Panel width', 'vertical', cardWidthRange);
  const splitGrip = createGrip('crucible-studio-grip-split', 'Scene card height', 'horizontal', { least: STUDIO_SCENE_SHARE.least, most: STUDIO_SCENE_SHARE.most });
  const sceneWidthGrip = createGrip('crucible-studio-grip-card-width', 'Resize Scene width', 'vertical', cardWidthRange);
  const sceneHeightGrip = createGrip('crucible-studio-grip-card-height crucible-studio-grip-scene-height', 'Resize Scene height', 'horizontal', cardHeightRange);
  const propertiesWidthGrip = createGrip('crucible-studio-grip-card-width', 'Resize Properties width', 'vertical', cardWidthRange);
  const propertiesHeightGrip = createGrip('crucible-studio-grip-card-height crucible-studio-grip-properties-height', 'Resize Properties height', 'horizontal', cardHeightRange);
  const agentHeightGrip = agentDock ? createGrip('crucible-studio-grip-agent-height', 'Resize Agent height', 'horizontal', cardHeightRange) : null;
  agentDock?.append(agentHeightGrip);
  outlinerDock.append(sceneWidthGrip, sceneHeightGrip);
  inspectorElement.append(propertiesWidthGrip, propertiesHeightGrip);
  const sideColumn = createElement(documentReference, 'div', { className: 'crucible-studio-side' }, widthGrip, outlinerDock, splitGrip, inspectorElement);

  function setRootVariable(name, value) {
    if (typeof root.style?.setProperty === 'function') {
      root.style.setProperty(name, value);
    } else if (root.style) {
      root.style[name] = value;
    }
  }

  function cardWidth(sizes, card) {
    return sizes[`${card}Width`] || sizes.panelWidth;
  }

  // The height a card has now: the one saved for it, or what it came to while it sizes itself.
  function cardHeight(sizes, card, element) {
    return sizes[`${card}Height`] || measuredHeight(element, UNMEASURED_CARD_HEIGHT);
  }

  /** Puts the sizes on the column and on the grips. A drag passes sizes it has not saved yet. */
  function showPanelSizes(sizes) {
    setRootVariable('--studio-side-width', `${sizes.panelWidth}px`);
    setRootVariable('--studio-scene-share', `${sizes.sceneShare}%`);
    setRootVariable('--studio-scene-width', `${cardWidth(sizes, 'scene')}px`);
    setRootVariable('--studio-properties-width', `${cardWidth(sizes, 'properties')}px`);
    setRootVariable('--studio-scene-height', `${sizes.sceneHeight}px`);
    setRootVariable('--studio-properties-height', `${sizes.propertiesHeight}px`);
    setRootVariable('--studio-agent-height', `${sizes.agentHeight || STUDIO_AGENT_CARD.automaticHeight}px`);
    root.dataset.sceneSized = sizes.sceneShare > STUDIO_SCENE_SHARE.automatic ? 'true' : 'false';
    root.dataset.sceneHeightSized = sizes.sceneHeight > STUDIO_CARD_SIZE.automatic ? 'true' : 'false';
    root.dataset.propertiesHeightSized = sizes.propertiesHeight > STUDIO_CARD_SIZE.automatic ? 'true' : 'false';
    widthGrip.setAttribute('aria-valuenow', String(sizes.panelWidth));
    splitGrip.setAttribute('aria-valuenow', String(sizes.sceneShare));
    sceneWidthGrip.setAttribute('aria-valuenow', String(cardWidth(sizes, 'scene')));
    propertiesWidthGrip.setAttribute('aria-valuenow', String(cardWidth(sizes, 'properties')));
    sceneHeightGrip.setAttribute('aria-valuenow', String(cardHeight(sizes, 'scene', outlinerDock)));
    propertiesHeightGrip.setAttribute('aria-valuenow', String(cardHeight(sizes, 'properties', inspectorElement)));
    agentHeightGrip?.setAttribute('aria-valuenow', String(sizes.agentHeight || measuredHeight(agentDock, STUDIO_AGENT_CARD.automaticHeight)));
  }

  function previewChanges(changes) {
    showPanelSizes(normalizeStudioPreferences({ ...readPreferences(), ...changes }));
  }

  // The share the Scene card takes now: the saved one, or what its rows came to while it sizes itself.
  function currentSceneShare() {
    const preferences = readPreferences();
    if (preferences.sceneShare > STUDIO_SCENE_SHARE.automatic) {
      return preferences.sceneShare;
    }
    const columnHeight = sideColumn.getBoundingClientRect?.().height;
    const sceneHeight = outlinerDock.getBoundingClientRect?.().height;
    if (!(columnHeight > 0) || !(sceneHeight > 0)) {
      return DEFAULT_SCENE_SHARE;
    }
    return (sceneHeight / columnHeight) * 100;
  }

  function shareFromPixels(pixels) {
    const columnHeight = sideColumn.getBoundingClientRect?.().height;
    return columnHeight > 0 ? (pixels / columnHeight) * 100 : 0;
  }

  // The most one card can take: the column without the other card, which keeps its own size.
  function roomBesideCard(otherCardShown, otherCardHeight) {
    const columnHeight = sideColumn.getBoundingClientRect?.().height;
    if (!(columnHeight > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    const taken = otherCardShown ? otherCardHeight + CARD_GAP : 0;
    return Math.max(STUDIO_CARD_SIZE.leastHeight, columnHeight - taken);
  }

  function propertiesHeightTaken(preferences) {
    if (root.dataset.inspectorMinimized === 'true') {
      return measuredHeight(inspectorElement, STUDIO_CARD_SIZE.leastHeight);
    }
    return preferences.propertiesHeight || STUDIO_CARD_SIZE.leastHeight;
  }

  function maximumSceneHeight(keepPropertiesHeight) {
    const inspectorShown = root.dataset.inspectorCollapsed !== 'true';
    const takenByProperties = keepPropertiesHeight ? propertiesHeightTaken(readPreferences()) : STUDIO_CARD_SIZE.leastHeight;
    return roomBesideCard(inspectorShown, takenByProperties);
  }

  function maximumPropertiesHeight() {
    const sceneShown = root.dataset.outlinerCollapsed !== 'true';
    return roomBesideCard(sceneShown, measuredHeight(outlinerDock, STUDIO_CARD_SIZE.leastHeight));
  }

  function currentWidths() {
    const preferences = readPreferences();
    return {
      panelWidth: preferences.panelWidth,
      sceneWidth: cardWidth(preferences, 'scene'),
      propertiesWidth: cardWidth(preferences, 'properties'),
    };
  }

  function currentHeights() {
    const preferences = readPreferences();
    return {
      sceneHeight: cardHeight(preferences, 'scene', outlinerDock),
      propertiesHeight: cardHeight(preferences, 'properties', inspectorElement),
    };
  }

  // One card's width changes, or with Ctrl both cards' widths change by the same amount.
  function cardWidthChanges(card, start, growth, bothCards) {
    if (bothCards) {
      return { sceneWidth: start.sceneWidth + growth, propertiesWidth: start.propertiesWidth + growth };
    }
    return { [`${card}Width`]: start[`${card}Width`] + growth };
  }

  const resetBothWidths = () => ({ sceneWidth: STUDIO_CARD_SIZE.automatic, propertiesWidth: STUDIO_CARD_SIZE.automatic });
  const resetBothHeights = () => ({ sceneHeight: STUDIO_CARD_SIZE.automatic, propertiesHeight: STUDIO_CARD_SIZE.automatic });

  const gripBehaviours = [
    // The column is on the right, so its inner edge moving left makes it wider.
    {
      grip: widthGrip,
      axis: 'x',
      keyStep: PANEL_WIDTH_KEY_STEP,
      growKey: 'ArrowLeft',
      shrinkKey: 'ArrowRight',
      startSizes: currentWidths,
      changesAfterGrowth: (start, growth) => ({ panelWidth: start.panelWidth + growth }),
      resetChanges: () => ({ panelWidth: STUDIO_PREFERENCE_DEFAULTS.panelWidth }),
    },
    {
      grip: splitGrip,
      axis: 'y',
      keyStep: SCENE_SHARE_KEY_STEP,
      growKey: 'ArrowDown',
      shrinkKey: 'ArrowUp',
      pixelsToUnits: shareFromPixels,
      startSizes: () => ({ sceneShare: currentSceneShare() }),
      changesAfterGrowth: (start, growth) => ({ sceneShare: start.sceneShare + growth }),
      resetChanges: () => ({ sceneShare: STUDIO_PREFERENCE_DEFAULTS.sceneShare }),
    },
    {
      grip: sceneWidthGrip,
      axis: 'x',
      keyStep: PANEL_WIDTH_KEY_STEP,
      growKey: 'ArrowLeft',
      shrinkKey: 'ArrowRight',
      startSizes: currentWidths,
      changesAfterGrowth: (start, growth, bothCards) => cardWidthChanges('scene', start, growth, bothCards),
      resetChanges: () => ({ sceneWidth: STUDIO_CARD_SIZE.automatic }),
      resetBothCardsChanges: resetBothWidths,
    },
    {
      grip: propertiesWidthGrip,
      axis: 'x',
      keyStep: PANEL_WIDTH_KEY_STEP,
      growKey: 'ArrowLeft',
      shrinkKey: 'ArrowRight',
      startSizes: currentWidths,
      changesAfterGrowth: (start, growth, bothCards) => cardWidthChanges('properties', start, growth, bothCards),
      resetChanges: () => ({ propertiesWidth: STUDIO_CARD_SIZE.automatic }),
      resetBothCardsChanges: resetBothWidths,
    },
    // Ctrl on the Scene card's bottom edge is the docked split: the Properties card takes what the Scene card leaves.
    {
      grip: sceneHeightGrip,
      axis: 'y',
      keyStep: CARD_HEIGHT_KEY_STEP,
      growKey: 'ArrowDown',
      shrinkKey: 'ArrowUp',
      startSizes: currentHeights,
      changesAfterGrowth: (start, growth, bothCards) => {
        const sceneHeight = Math.min(start.sceneHeight + growth, maximumSceneHeight(!bothCards));
        return bothCards ? { sceneHeight, propertiesHeight: STUDIO_CARD_SIZE.automatic } : { sceneHeight };
      },
      resetChanges: () => ({ sceneHeight: STUDIO_CARD_SIZE.automatic }),
      resetBothCardsChanges: resetBothHeights,
    },
    {
      grip: propertiesHeightGrip,
      axis: 'y',
      keyStep: CARD_HEIGHT_KEY_STEP,
      growKey: 'ArrowDown',
      shrinkKey: 'ArrowUp',
      startSizes: currentHeights,
      changesAfterGrowth: (start, growth) => ({ propertiesHeight: Math.min(start.propertiesHeight + growth, maximumPropertiesHeight()) }),
      resetChanges: () => ({ propertiesHeight: STUDIO_CARD_SIZE.automatic }),
      resetBothCardsChanges: resetBothHeights,
    },
  ];

  function wireGrip(behaviour) {
    const { grip, axis, keyStep, growKey, shrinkKey, startSizes, changesAfterGrowth, resetChanges, resetBothCardsChanges } = behaviour;
    const pixelsToUnits = behaviour.pixelsToUnits ?? (pixels => pixels);
    let drag = null;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) {
        return;
      }
      drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: startSizes(), latestChanges: null };
      grip.setPointerCapture?.(event.pointerId);
      grip.dataset.dragging = 'true';
      event.preventDefault();
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      // The column and the cards are on the right, so a left edge moving left grows them; a bottom edge moving down does.
      const pixels = growthInPixels(axis, drag, event);
      drag.latestChanges = changesAfterGrowth(drag.start, pixelsToUnits(pixels), bothCardsRequested(event));
      previewChanges(drag.latestChanges);
    });
    const finishDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const latestChanges = drag.latestChanges;
      drag = null;
      delete grip.dataset.dragging;
      if (latestChanges !== null) {
        changePreferences(latestChanges);
      }
    };
    grip.addEventListener('pointerup', finishDrag);
    grip.addEventListener('pointercancel', finishDrag);
    grip.addEventListener('keydown', event => {
      let direction = 0;
      if (event.key === growKey) {
        direction = 1;
      } else if (event.key === shrinkKey) {
        direction = -1;
      }
      if (direction === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      changePreferences(changesAfterGrowth(startSizes(), direction * keyStep, bothCardsRequested(event)));
    });
    grip.addEventListener('dblclick', event => {
      const useBothCards = bothCardsRequested(event) && resetBothCardsChanges;
      changePreferences(useBothCards ? resetBothCardsChanges() : resetChanges());
    });
  }

  // The card's top edge moving up makes it taller, up to its share of the column.
  function maximumAgentHeight() {
    const columnHeight = sideColumn.getBoundingClientRect?.().height;
    return columnHeight > 0 ? Math.max(STUDIO_CARD_SIZE.leastHeight, Math.round(columnHeight * STUDIO_AGENT_CARD.mostShare)) : Number.POSITIVE_INFINITY;
  }

  if (agentHeightGrip) {
    gripBehaviours.push({
      grip: agentHeightGrip,
      axis: 'y-up',
      keyStep: CARD_HEIGHT_KEY_STEP,
      growKey: 'ArrowUp',
      shrinkKey: 'ArrowDown',
      startSizes: () => ({ agentHeight: readPreferences().agentHeight || measuredHeight(agentDock, STUDIO_AGENT_CARD.automaticHeight) }),
      changesAfterGrowth: (start, growth) => ({ agentHeight: Math.min(start.agentHeight + growth, maximumAgentHeight()) }),
      resetChanges: () => ({ agentHeight: STUDIO_CARD_SIZE.automatic }),
    });
  }

  gripBehaviours.forEach(wireGrip);
  return { sideColumn, showPanelSizes };
}
