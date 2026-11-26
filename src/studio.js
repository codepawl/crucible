import { CRUCIBLE_MARK_LAYERS, CRUCIBLE_MARK_VIEW_BOX } from './studio-brand-mark.js';
import { applyProjection } from './camera.js';
import { createAgentScene, loadAgentSceneModules, loadMeshBooleans, meshBooleansLoaded, needsMeshBooleans } from './agent-scene.js';
import { agentEnvironmentMap, fitAgentShadow, resolveAgentShadow } from './agent-look.js';
import { agentSceneModulesNeeded } from './agent-scene-modules.js';
import { LIGHTING_SETUP_NAMES } from './lighting-setup-names.js';
import { VIEW_TRANSFORM_NAMES } from './view-transform-names.js';
import { CrucibleRenderer, studioFloorHeight } from './renderer.js';
import { ProgramNotReady, isLinkComplete, setPreparing } from './gl-program.js';
import { exportGlb } from './export.js';
import { dataUrlByteLength, formatFileSize, lastPathName } from './studio-export.js';
import { encodePack } from './scene-pack-format.js';
import { checkImageBudget } from './scene-pack-limits.js';
import { packedSkyOf } from './scene-pack-sky.js';
import { encodePackOrRefuse } from './studio-pack-refusal.js';
import { PACK_SHADER_MODULES, PACK_UNSUPPORTED_MODULES } from './scene-pack-shaders.js';
import { STUDIO_CSS } from './studio-styles.js';
import { AGENT_CHAT_CSS, createAgentPanel } from './studio-agent-chat.js';
import { createApplyMenus } from './studio-apply-menu.js';
import { createMeshMenus } from './studio-mesh-menus.js';
import { findKeymapAction, findMouseNavigation, formatShortcutKeys, KEYMAP_PRESETS, keyLabel, lastKeyLabel, resolveKeymapPreset, shortcutRowsFor } from './studio-keymap.js';
import { balanceSheetColumns, openStudioGuide, sheetColumnCount, shortcutSheetGroups, watchScrollFades } from './studio-help.js';
import { createStudioCatalog, NO_STORE_MESSAGE } from './studio-catalog.js';
import { createStudioSetup } from './studio-setup.js';
import { createStudioSettings } from './studio-settings.js';
import { createNumberPadNotice, isNumpadKeyEvent, resolveStudioKeyAction } from './studio-numpad.js';
import { withPresetOverrides } from './studio-key-overrides.js';
import { detectStudioHardware, gatherStudioHardwareInputs, rendererChangeFor, resolveStudioPerformanceTier, studioViewportSettingsFor } from './studio-hardware.js';
import { createStudioDiagnostics, describeStudioEnvironment, watchStudioDiagnostics } from './studio-diagnostics.js';
import { STUDIO_GIZMO_PIXELS, STUDIO_PREFERENCE_CHOICES, STUDIO_PREFERENCE_DEFAULTS, loadStudioPreferences, normalizeStudioPreferences, saveStudioPreferences } from './studio-preferences.js';
import { createOutlineMask } from './studio-outline-mask.js';
import { createPanelGrips } from './studio-panel-grips.js';
import { leadWithActionIcon, STUDIO_ACTION_ICONS, STUDIO_BRAND_ICON_NAMES, STUDIO_FILLED_ICON_NAMES, STUDIO_ICON_ACCENTS, STUDIO_LIGHT_ICONS, STUDIO_NOTICE_ICONS, STUDIO_PRIMITIVE_ICONS, studioIconPath } from './studio-icons.js';
import { createPropertyLine, createPropertyPanel } from './studio-property-panel.js';
import './studio-features.js';
import { hasStudioTab, registeredStudioMenuEntries, registeredStudioStyles, registeredStudioTabIds, registeredStudioTabs, registeredStudioWorkspaces, registerStudioTab } from './studio-registry.js';
import { createShapeSettings } from './studio-shape-settings.js';
import { MIXED_PROPERTY_LABEL, MIXED_SELECT_VALUE, summarizeNodeSelection, syncObjectAndMaterialPanels } from './studio-multi-edit.js';
import { createKeyMarkers } from './studio-timeline-keys.js';
import { cameraFocalLengthMillimetres, choiceDisplayLabel } from './studio-properties.js';
import { AXIS_COLORS, buildGridParts, cameraVisibleHeight, createViewWidget, describeBounds, describeCamera, describeGridStep, gridLayout, placeGridParts, studioDrawsFloor, viewportClipPlanes, viewportFloorPart } from './studio-viewport-aids.js';
import { formatLengthInputValue, lengthFromUnit, parseLengthInput } from './studio-units.js';
// The grid is textured, and replaceParts takes a textured part only with this module loaded.
import './replace-textured-parts.js';
import { clearStudioDraft, createDraftNotice, DRAFT_SAVE_DELAY_MILLISECONDS, draftDiffersFrom, loadStudioDraft, saveStudioDraft } from './studio-draft.js';
import { createBakeMark } from './studio-bake-mark.js';
import { watchScrollFade } from './studio-scroll-cue.js';
import { extensionOf, openNameEditor, splitFileName, validateFileStem, validateNodeLabel, validateShotName } from './studio-name-editor.js';
import { isModifierKey, longestTransitionMilliseconds, popoverOpeningStyle } from './studio-popover-motion.js';
import { SNAP_TARGETS } from './studio-snapping.js';
import { createOutlinerParentDrag } from './studio-parenting.js';
import { editIconName } from './studio-edit-names.js';
import { createPostPassNotice, createPostPassPlanner, installPostPasses, sceneHasPostPasses } from './studio-post-passes.js';
import { CONTEXT_LOST_MESSAGE, createPausedPictureNotice, describeFrameFailure, frameFailureReason, watchContextLoss } from './studio-context-loss.js';
import { assertAgentName, createAgentPresence, DEFAULT_AGENT_NAME, describeAgentEdit, diffRecipeNodes } from './studio-agent-presence.js';
import { STUDIO_LENS_PRESETS, STUDIO_MATERIAL_PRESETS, STUDIO_PRIMITIVE_GROUPS, STUDIO_PRIMITIVES, primitiveGeometrySpec, STUDIO_TEMPLATES, STUDIO_TOOLS, STUDIO_VIEW_PRESETS, buildTemplateRecipe } from './studio-templates.js';
import { createStudioController, hasAnimatedData, linearRgbToHex, quaternionToEulerDegrees, roundValue } from './studio-controller.js';
import { createPartSyncTracker } from './studio-live-parts.js';
import { assignSwatchMaterialInEditMode, createFaceMaterialPanel, planJoinOperations } from './studio-material-slots.js';
import {
  BASE_STUDIO_WORKSPACES,
  createWorkspaceTabBar,
  createWorkspaceTabController,
} from './studio-workspace-tabs.js';

const CORE_STUDIO_TABS = [
  { id: 'node', label: 'Object', order: 10, workspaces: [{ id: 'build', order: 10 }, { id: 'animate', order: 20 }], createPanel: ({ inlinePanels }) => ({ element: inlinePanels.node }) },
  { id: 'material', label: 'Material', order: 30, workspaces: ['look'], createPanel: ({ inlinePanels }) => ({ element: inlinePanels.material }) },
  { id: 'look', label: 'Look', order: 40, workspaces: ['look'], createPanel: ({ inlinePanels, syncLookPanels }) => ({ element: inlinePanels.look, sync: syncLookPanels }) },
  { id: 'camera', label: 'Camera', order: 50, workspaces: [{ id: 'animate', order: 10 }], createPanel: ({ inlinePanels, syncCameraPanel }) => ({ element: inlinePanels.camera, sync: syncCameraPanel }) },
];
for (const coreTab of CORE_STUDIO_TABS) {
  if (!hasStudioTab(coreTab.id)) registerStudioTab(coreTab);
}
const STUDIO_TABS = registeredStudioTabIds();

export { STUDIO_LENS_PRESETS, STUDIO_MATERIAL_PRESETS, STUDIO_PRIMITIVE_GROUPS, STUDIO_PRIMITIVES, STUDIO_TABS, STUDIO_TEMPLATES, STUDIO_TOOLS, STUDIO_VIEW_PRESETS, buildTemplateRecipe, createStudioController };

const AXIS_NAMES = Object.freeze(['x', 'y', 'z']);
const STATUS_DEFAULT_MILLISECONDS = 3400;
// The reason of a bad scene name sits beside the name when the free gap between the workspace tabs and the name holds it (the reason
// is at most 240 px wide, plus 8 px of air on each side); otherwise it drops under the name.
const ERROR_BESIDE_NAME_MIN_GAP = 256;
// Past the exit transition, in case the browser never sends its transitionend.
const STATUS_EXIT_SLACK_MILLISECONDS = 40;
const DEGREE_PRECISION = 100;
const ROUND_PRECISION = 10000;
const LENS_CHIP_TOLERANCE_MILLIMETRES = 0.5;
// A view chip is active while the camera looks along its direction, within about two degrees; a free orbit matches none.
const VIEW_CHIP_DIRECTIONS = Object.freeze({ front: [0, 0, 1], right: [1, 0, 0], top: [0.002, 1, 0.002], isometric: [1, 0.72, 1] });
const VIEW_CHIP_MINIMUM_COSINE = 0.9995;
// A tree row is 28px high with a 4px gap (--studio-space-4 in studio-styles.js); the Scene list stretches its rows a little so a whole number of them fills it.
const TREE_ROW_GAP_PIXELS = 4;

/** The view chip whose direction the camera looks along, or null when the camera is in a free orbit. */
function matchingViewChip(camera) {
  const offset = camera.eye.map((coordinate, axis) => coordinate - camera.target[axis]);
  const offsetLength = Math.hypot(...offset);
  if (offsetLength === 0) {
    return null;
  }
  const match = Object.entries(VIEW_CHIP_DIRECTIONS).find(([, direction]) => {
    const dot = offset.reduce((sum, coordinate, axis) => sum + coordinate * direction[axis], 0);
    return dot / (offsetLength * Math.hypot(...direction)) >= VIEW_CHIP_MINIMUM_COSINE;
  });
  return match ? match[0] : null;
}
const STUDIO_STYLE_ID = 'crucible-studio-styles';
const COMPACT_WIDTH = 820;
const TIGHT_WIDTH = 920;
const STUDIO_WORKSPACES = registeredStudioWorkspaces(BASE_STUDIO_WORKSPACES);
const DEFAULT_CLEARCOAT_ROUGHNESS = 0.08;
const PRIMITIVE_LABELS = Object.freeze({ icoSphere: 'Icosphere', disc: 'Circle' });
const primitiveLabel = primitiveType => PRIMITIVE_LABELS[primitiveType] ?? primitiveType[0].toUpperCase() + primitiveType.slice(1);
const TREE_ICON_BY_GEOMETRY = Object.freeze({
  circle: 'plane',
  box: 'node',
  sphere: 'sphere',
  icoSphere: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  torus: 'torus',
  plane: 'plane',
  terrain: 'plane',
});

// The icon a scene row shows: the shape of the object's geometry, a stack for a group, a cube for any other mesh.
const SCENE_OBJECT_ICONS = Object.freeze({ camera: 'camera', sun: 'sun', point: 'pointLight', spot: 'spotLight', area: 'areaLight' });

function treeIconName(node, geometriesById) {
  if (!node.geometry) {
    return 'group';
  }
  return TREE_ICON_BY_GEOMETRY[geometriesById.get(node.geometry)?.type] ?? 'node';
}

function injectStudioStyles(documentReference) {
  let style = documentReference.getElementById(STUDIO_STYLE_ID);
  if (!style) {
    style = documentReference.createElement('style');
    style.id = STUDIO_STYLE_ID;
    documentReference.head.append(style);
  }
  const extraStyles = registeredStudioStyles();
  style.textContent = STUDIO_CSS + AGENT_CHAT_CSS + (extraStyles ? `\n${extraStyles}` : '');
}

function createElement(documentReference, tagName, properties = {}, ...children) {
  const element = documentReference.createElement(tagName);
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'attributes') {
      for (const [attributeName, attributeValue] of Object.entries(value)) {
        if (attributeValue !== null && attributeValue !== undefined) {
          element.setAttribute(attributeName, String(attributeValue));
        }
      }
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else {
      element[key] = value;
    }
  }
  element.append(...children);
  return element;
}

function createSvgElement(documentReference, tagName, attributes = {}) {
  const element = documentReference.createElementNS('http://www.w3.org/2000/svg', tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function createIcon(documentReference, iconName) {
  const icon = createSvgElement(documentReference, 'svg', { viewBox: '0 0 24 24', class: 'crucible-studio-icon', 'aria-hidden': 'true' });
  if (STUDIO_BRAND_ICON_NAMES.includes(iconName)) {
    icon.dataset.brand = 'true';
  }
  if (STUDIO_FILLED_ICON_NAMES.includes(iconName)) {
    icon.dataset.filled = 'true';
  }
  icon.append(createSvgElement(documentReference, 'path', { d: studioIconPath(iconName) }));
  for (const { kind, path } of STUDIO_ICON_ACCENTS[iconName] ?? []) {
    icon.append(createSvgElement(documentReference, 'path', { d: path, class: `crucible-studio-icon-${kind}` }));
  }
  return icon;
}

function setButtonIcon(button, iconName, label) {
  if (button.dataset.icon !== iconName) {
    button.dataset.icon = iconName;
    button.replaceChildren(createIcon(button.ownerDocument, iconName));
  }
  button.setAttribute('aria-label', label);
  button.title = label;
}

function createIconButton(documentReference, iconName, label, properties = {}) {
  const button = createElement(documentReference, 'button', { type: 'button', ...properties });
  setButtonIcon(button, iconName, label);
  return button;
}

function wireRovingFocusFallback(container, items, { vertical = false, followFocus = false, onSelect } = {}) {
  if ('focusGroup' in HTMLElement.prototype) {
    return;
  }
  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });
  container.addEventListener('focusin', event => {
    if (!items.includes(event.target)) {
      return;
    }
    items.forEach(item => {
      item.tabIndex = item === event.target ? 0 : -1;
    });
  });
  container.addEventListener('keydown', event => {
    const liveItems = items.filter(item => !item.hasAttribute('hidden'));
    const currentIndex = liveItems.indexOf(container.ownerDocument.activeElement);
    if (currentIndex < 0) {
      return;
    }
    const rightToLeft = getComputedStyle(container).direction === 'rtl';
    const nextKey = vertical ? 'ArrowDown' : rightToLeft ? 'ArrowLeft' : 'ArrowRight';
    const previousKey = vertical ? 'ArrowUp' : rightToLeft ? 'ArrowRight' : 'ArrowLeft';
    let targetIndex = null;
    if (event.key === nextKey) targetIndex = (currentIndex + 1) % liveItems.length;
    else if (event.key === previousKey) targetIndex = (currentIndex - 1 + liveItems.length) % liveItems.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = liveItems.length - 1;
    if (targetIndex === null) {
      return;
    }
    event.preventDefault();
    const targetItem = liveItems[targetIndex];
    targetItem.focus();
    if (followFocus && onSelect) {
      onSelect(targetItem);
    }
  });
}

function createVectorRow(documentReference, title, onInput, { sensitivity = 0.02, minimumComponent = -Infinity, lockToggle = null, axisNames = AXIS_NAMES, accessibleTitle = title, getLengthUnit = null, onGestureStart, onGestureEnd } = {}) {
  let latestValues = axisNames.map(() => 0);
  let mixedAxes = axisNames.map(() => false);
  let locked = false;
  let disabled = false;
  const inputs = axisNames.map(axis => createElement(documentReference, 'input', {
    type: getLengthUnit ? 'text' : 'number',
    ...(getLengthUnit ? { dataset: { length: 'true' } } : { step: '0.05' }),
    attributes: getLengthUnit
      ? { 'aria-label': `${accessibleTitle} ${axis.toUpperCase()}`, inputmode: 'decimal' }
      : { 'aria-label': `${accessibleTitle} ${axis.toUpperCase()}` },
  }));

  function readAxisInput(field) {
    if (getLengthUnit) {
      return parseLengthInput(field.value, getLengthUnit());
    }
    const numeric = Number(field.value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function emitEditedAxis(axisIndex, rawNumeric) {
    const clamped = Math.max(minimumComponent, rawNumeric);
    if (locked && !mixedAxes[axisIndex] && latestValues[axisIndex] > 0) {
      const ratio = clamped / latestValues[axisIndex];
      const scaled = latestValues.map(component => Math.max(minimumComponent, component * ratio));
      onInput(scaled, axisIndex, { locked: true });
      return;
    }
    const parsed = inputs.map((field, index) => (index === axisIndex ? clamped : (mixedAxes[index] && field.value === '' ? null : readAxisInput(field))));
    if (parsed[axisIndex] !== null && parsed.every((component, index) => (component === null && mixedAxes[index]) || (component !== null && Number.isFinite(component)))) {
      onInput(parsed, axisIndex, { locked: false });
    }
  }

  inputs.forEach((input, axisIndex) => {
    input.addEventListener('change', () => {
      const numeric = readAxisInput(input);
      if (numeric !== null && Number.isFinite(numeric)) {
        emitEditedAxis(axisIndex, numeric);
      }
    });
  });

  const axisLabels = axisNames.map((axis, axisIndex) => {
    const badge = createElement(documentReference, 'span', {
      className: 'crucible-studio-axis-scrub',
      textContent: axis.toUpperCase(),
      title: 'Drag horizontally to scrub value',
    });
    badge.style.color = AXIS_COLORS[axis];
    let scrubState = null;
    badge.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (disabled) return;
      onGestureStart?.();
      scrubState = { startX: event.clientX, startValue: getLengthUnit ? (latestValues[axisIndex] ?? 0) : (Number(inputs[axisIndex].value) || 0) };
      badge.setPointerCapture?.(event.pointerId);
    });
    badge.addEventListener('pointermove', event => {
      if (!scrubState) return;
      const stepFactor = event.shiftKey ? sensitivity * 0.2 : sensitivity;
      const nextValue = roundValue(scrubState.startValue + (event.clientX - scrubState.startX) * stepFactor, 100);
      emitEditedAxis(axisIndex, nextValue);
    });
    const finishScrub = () => {
      if (scrubState) onGestureEnd?.();
      scrubState = null;
    };
    badge.addEventListener('pointerup', finishScrub);
    badge.addEventListener('pointercancel', finishScrub);
    return badge;
  });

  const head = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-field-head' },
    createElement(documentReference, 'span', { textContent: title }),
  );
  if (lockToggle) {
    const lockButton = createIconButton(documentReference, 'link', 'Keep the three axes together', {
      className: 'crucible-studio-mini-btn',
      attributes: { 'aria-pressed': 'false' },
    });
    lockButton.addEventListener('click', () => {
      locked = !locked;
      lockButton.setAttribute('aria-pressed', locked ? 'true' : 'false');
    });
    head.append(lockButton);
  }

  const container = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-field' },
    head,
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-vector', dataset: { axes: String(axisNames.length) } },
      ...inputs.map((input, axisIndex) => createElement(
        documentReference,
        'label',
        {},
        axisLabels[axisIndex],
        input,
      )),
    ),
  );
  return {
    container,
    inputs,
    setDisabled(nextDisabled) {
      disabled = nextDisabled;
      inputs.forEach(input => {
        input.disabled = nextDisabled;
      });
    },
    setValues(values, precision = ROUND_PRECISION) {
      latestValues = Array.from(values, component => Number(component) || 0);
      inputs.forEach((input, index) => {
        input.value = getLengthUnit
          ? formatLengthInputValue(values[index] ?? 0, getLengthUnit())
          : String(roundValue(values[index] ?? 0, precision));
      });
    },
    setMixed(mixed = axisNames.map(() => false)) {
      mixedAxes = axisNames.map((_, index) => Boolean(mixed[index]));
      inputs.forEach((input, index) => {
        input.dataset.mixed = mixedAxes[index] ? 'true' : 'false';
        input.placeholder = mixedAxes[index] ? MIXED_PROPERTY_LABEL : '';
        if (mixedAxes[index]) input.value = '';
      });
    },
  };
}

function createSliderField(documentReference, labelText, { min, max, step, value = 0 }, onChange) {
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const output = createElement(documentReference, 'output', { textContent: Number(value).toFixed(decimals) });
  const input = createElement(documentReference, 'input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    attributes: { 'aria-label': labelText },
  });
  input.addEventListener('input', () => {
    const numeric = Number(input.value);
    output.textContent = numeric.toFixed(decimals);
    onChange(numeric);
  });
  const container = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-field' },
    createElement(documentReference, 'div', { className: 'crucible-studio-field-head' }, createElement(documentReference, 'span', { textContent: labelText }), output),
    input,
  );
  return {
    container,
    input,
    output,
    setValue(nextValue) {
      input.value = String(nextValue);
      output.textContent = Number(nextValue).toFixed(decimals);
    },
    setMixed(isMixed) {
      container.dataset.mixed = isMixed ? 'true' : 'false';
      if (isMixed) output.textContent = MIXED_PROPERTY_LABEL;
    },
  };
}

function createSunPad(documentReference, onSunChange, { onDragStart, onDragEnd } = {}) {
  const padSvg = createSvgElement(documentReference, 'svg', {
    class: 'crucible-studio-sunpad',
    viewBox: '0 0 120 120',
    'aria-label': 'Sun direction pad. Drag to move key light azimuth and elevation.',
    role: 'application',
  });
  const outerRing = createSvgElement(documentReference, 'circle', {
    cx: '60',
    cy: '60',
    r: '52',
    fill: 'none',
    stroke: 'color-mix(in srgb, var(--studio-text) 55%, transparent)',
    'stroke-width': '1.5',
  });
  const midRing = createSvgElement(documentReference, 'circle', {
    cx: '60',
    cy: '60',
    r: '28',
    fill: 'none',
    stroke: 'color-mix(in srgb, var(--studio-text) 30%, transparent)',
    'stroke-dasharray': '3 3',
    'stroke-width': '1',
  });
  const sunRay = createSvgElement(documentReference, 'line', {
    x1: '60',
    y1: '60',
    x2: '40',
    y2: '34',
    stroke: 'color-mix(in srgb, var(--studio-text) 70%, transparent)',
    'stroke-width': '2',
  });
  const sunKnob = createSvgElement(documentReference, 'circle', {
    cx: '40',
    cy: '34',
    r: '7',
    fill: 'var(--studio-text)',
    stroke: 'var(--studio-panel)',
    'stroke-width': '2',
  });
  padSvg.append(outerRing, midRing, sunRay, sunKnob);

  let dragging = false;
  let disabled = false;
  function updateFromPointer(event) {
    const bounds = padSvg.getBoundingClientRect();
    const normalizedX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const normalizedY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    const radial = Math.min(1, Math.hypot(normalizedX, normalizedY));
    const azimuthDegrees = Math.round((Math.atan2(normalizedX, -normalizedY) * 180) / Math.PI);
    const elevationDegrees = Math.round(Math.max(4, Math.min(88, (1 - radial * 0.88) * 88)));
    onSunChange({ azimuthDegrees, elevationDegrees });
  }
  padSvg.addEventListener('pointerdown', event => {
    if (disabled) return;
    dragging = true;
    onDragStart?.();
    padSvg.setPointerCapture?.(event.pointerId);
    updateFromPointer(event);
  });
  padSvg.addEventListener('pointermove', event => {
    if (dragging) updateFromPointer(event);
  });
  const endDrag = () => {
    if (dragging) onDragEnd?.();
    dragging = false;
  };
  padSvg.addEventListener('pointerup', endDrag);
  padSvg.addEventListener('pointercancel', endDrag);

  return {
    element: padSvg,
    setDisabled(nextDisabled) {
      disabled = nextDisabled;
      padSvg.setAttribute('aria-disabled', nextDisabled ? 'true' : 'false');
    },
    setAngles(azimuthDegrees, elevationDegrees) {
      const radial = Math.max(0.05, Math.min(1, (88 - elevationDegrees) / (88 * 0.88))) * 50;
      const radians = (azimuthDegrees * Math.PI) / 180;
      const knobX = 60 + Math.sin(radians) * radial;
      const knobY = 60 - Math.cos(radians) * radial;
      sunRay.setAttribute('x2', knobX.toFixed(1));
      sunRay.setAttribute('y2', knobY.toFixed(1));
      sunKnob.setAttribute('cx', knobX.toFixed(1));
      sunKnob.setAttribute('cy', knobY.toFixed(1));
    },
  };
}

function buildBrandMarkSvg(documentReference) {
  const mark = createSvgElement(documentReference, 'svg', { viewBox: CRUCIBLE_MARK_VIEW_BOX, 'aria-hidden': 'true' });
  for (const [layer, pathData] of CRUCIBLE_MARK_LAYERS) {
    mark.append(createSvgElement(documentReference, 'path', { class: `crucible-studio-mark-${layer}`, 'fill-rule': 'evenodd', d: pathData }));
  }
  return mark;
}

const ARROW_HEAD_LENGTH = 15;
const ARROW_HEAD_HALF_WIDTH = 7;
const ARROW_MINIMUM_AXIS_LENGTH = 10;

// The arrow head of a move handle: it points away from the origin, which says "drag me this way". Null when the axis
// points at the viewer and is too short on screen to have a direction.
function arrowHeadPoints(origin, tip) {
  const deltaX = tip.x - origin.x;
  const deltaY = tip.y - origin.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length < ARROW_MINIMUM_AXIS_LENGTH) {
    return null;
  }
  const alongX = deltaX / length;
  const alongY = deltaY / length;
  const baseX = tip.x - alongX * (ARROW_HEAD_LENGTH * 0.4);
  const baseY = tip.y - alongY * (ARROW_HEAD_LENGTH * 0.4);
  const corners = [
    [tip.x + alongX * (ARROW_HEAD_LENGTH * 0.6), tip.y + alongY * (ARROW_HEAD_LENGTH * 0.6)],
    [baseX - alongY * ARROW_HEAD_HALF_WIDTH, baseY + alongX * ARROW_HEAD_HALF_WIDTH],
    [baseX + alongY * ARROW_HEAD_HALF_WIDTH, baseY - alongX * ARROW_HEAD_HALF_WIDTH],
  ];
  return corners.map(corner => `${corner[0].toFixed(1)},${corner[1].toFixed(1)}`).join(' ');
}

// The ring is a little wider than the 6.5 px centre handle, so a vertex that lands under the handle stays visible, and
// the dot is the vertex itself. The dark halo is wider than the pale ring by 2 px a side so the ring reads over the
// accent outline of the selected object and over a pale surface alike.
const SNAP_MARKER_RING_RADIUS = 10;
const SNAP_MARKER_DOT_RADIUS = 2.5;
const SNAP_MARKER_HALO_WIDTH = 6;
const SNAP_MARKER_RING_WIDTH = 2;

// The vertex a drag is snapping to. Drawn after the handles and the outline, so nothing covers it.
function appendSnapMarker(documentReference, gizmoSvg, marker) {
  if (!marker) {
    return;
  }
  const centre = { cx: marker.x.toFixed(1), cy: marker.y.toFixed(1), 'pointer-events': 'none' };
  gizmoSvg.append(
    createSvgElement(documentReference, 'circle', { ...centre, r: String(SNAP_MARKER_RING_RADIUS), fill: 'none', stroke: 'var(--studio-trace-edge)', 'stroke-width': String(SNAP_MARKER_HALO_WIDTH), 'data-snap-halo': 'vertex' }),
    createSvgElement(documentReference, 'circle', { ...centre, r: String(SNAP_MARKER_DOT_RADIUS + 1), fill: 'var(--studio-trace-edge)', 'data-snap-halo': 'dot' }),
    createSvgElement(documentReference, 'circle', { ...centre, r: String(SNAP_MARKER_RING_RADIUS), fill: 'none', stroke: 'var(--studio-trace)', 'stroke-width': String(SNAP_MARKER_RING_WIDTH), 'data-snap-marker': 'vertex' }),
    createSvgElement(documentReference, 'circle', { ...centre, r: String(SNAP_MARKER_DOT_RADIUS), fill: 'var(--studio-trace)', 'data-snap-marker': 'dot' }),
  );
}

// What a drag has changed so far: a dashed outline where the object was and, for a move, a dashed line from there to
// where it is now. Nothing here takes the pointer.
function appendDragTrace(documentReference, gizmoSvg, trace) {
  if (!trace) {
    return;
  }
  // Each pale dashed line lies on a wider dark line, so it reads over a pale object and over the dark ground alike.
  // The colours are fixed, not the theme's: the scene behind them does not change with the theme.
  const quiet = { stroke: 'var(--studio-trace)', 'stroke-width': '1.8', 'stroke-dasharray': '6 4', 'pointer-events': 'none' };
  const halo = { stroke: 'var(--studio-trace-edge)', 'stroke-width': '4.6', 'stroke-linecap': 'round', 'pointer-events': 'none' };
  if (trace.outline) {
    const outline = {
      points: trace.outline.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' '),
      fill: 'none',
      'stroke-linejoin': 'round',
    };
    gizmoSvg.append(
      createSvgElement(documentReference, 'polygon', { ...outline, ...halo, 'data-drag-halo': 'ghost' }),
      createSvgElement(documentReference, 'polygon', { ...outline, ...quiet, 'data-drag-trace': 'ghost' }),
    );
  }
  if (trace.from?.visible && trace.to?.visible) {
    const travel = {
      x1: trace.from.x.toFixed(1),
      y1: trace.from.y.toFixed(1),
      x2: trace.to.x.toFixed(1),
      y2: trace.to.y.toFixed(1),
    };
    gizmoSvg.append(
      createSvgElement(documentReference, 'line', { ...travel, ...halo, 'data-drag-halo': 'travel' }),
      createSvgElement(documentReference, 'line', { ...travel, ...quiet, 'data-drag-trace': 'travel' }),
      createSvgElement(documentReference, 'circle', {
        cx: trace.from.x.toFixed(1),
        cy: trace.from.y.toFixed(1),
        r: '4',
        fill: 'var(--studio-trace)',
        stroke: 'var(--studio-trace-edge)',
        'stroke-width': '1.5',
        'pointer-events': 'none',
        'data-drag-trace': 'start',
      }),
    );
  }
}

// The turn in progress: a faint wedge over the angle already turned, a dashed spoke where the drag began and a solid
// spoke where the object is now. Nothing here takes the pointer, so the drag carries on through it.
function appendRotationSweep(documentReference, gizmoSvg, sweep) {
  const color = AXIS_COLORS[sweep.axis];
  const centre = sweep.centre;
  const arc = sweep.arc.filter(point => point.visible);
  if (arc.length < 2) {
    return;
  }
  const pair = point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  const spoke = (point, part, extra) => createSvgElement(documentReference, 'line', {
    x1: centre.x.toFixed(1),
    y1: centre.y.toFixed(1),
    x2: point.x.toFixed(1),
    y2: point.y.toFixed(1),
    stroke: color,
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'pointer-events': 'none',
    'data-rotation-sweep': part,
    ...extra,
  });
  gizmoSvg.append(
    createSvgElement(documentReference, 'polygon', {
      points: [centre, ...arc].map(pair).join(' '),
      fill: color,
      'fill-opacity': '0.22',
      stroke: 'none',
      'pointer-events': 'none',
      'data-rotation-sweep': 'wedge',
    }),
    spoke(arc[0], 'start', { 'stroke-dasharray': '4 4', 'stroke-opacity': '0.7' }),
    spoke(arc.at(-1), 'now', {}),
  );
}

// The flight to a framed object: long enough to follow, short enough never to wait for.
const FLIGHT_MILLISECONDS = 320;
const SILHOUETTE_FILTER_ID = 'crucible-studio-silhouette';
// The active object is outlined thicker than the rest of the selection: the two read apart by width, and both keep the full accent.
const SILHOUETTE_EDGE_PIXELS = { active: 4, others: 2 };
// A ring of the viewport's dark on each side of the accent (the shape's own edge pixels inside, the ground outside), so the
// outline holds on a surface as light as the accent, such as a cream model, and on a dark one.
const SILHOUETTE_CASING_PIXELS = 1;

// The steps that turn a filled shape into its outline: the accent ring just outside the shape, with the casing on both sides of it.
function silhouetteFilterSteps(documentReference, layer) {
  const edgePixels = SILHOUETTE_EDGE_PIXELS[layer];
  const merge = createSvgElement(documentReference, 'feMerge');
  merge.append(
    createSvgElement(documentReference, 'feMergeNode', { in: 'casing' }),
    createSvgElement(documentReference, 'feMergeNode', { in: 'innerCasing' }),
    createSvgElement(documentReference, 'feMergeNode', { in: 'ring' }),
  );
  return [
    createSvgElement(documentReference, 'feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: edgePixels, result: 'grown' }),
    createSvgElement(documentReference, 'feComposite', { in: 'grown', in2: 'SourceAlpha', operator: 'out', result: 'edge' }),
    createSvgElement(documentReference, 'feFlood', { class: 'crucible-studio-silhouette-colour', 'data-layer': layer, result: 'colour' }),
    createSvgElement(documentReference, 'feComposite', { in: 'colour', in2: 'edge', operator: 'in', result: 'ring' }),
    createSvgElement(documentReference, 'feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: edgePixels + SILHOUETTE_CASING_PIXELS, result: 'wide' }),
    createSvgElement(documentReference, 'feComposite', { in: 'wide', in2: 'grown', operator: 'out', result: 'casingEdge' }),
    createSvgElement(documentReference, 'feFlood', { class: 'crucible-studio-silhouette-casing', result: 'casingColour' }),
    createSvgElement(documentReference, 'feComposite', { in: 'casingColour', in2: 'casingEdge', operator: 'in', result: 'casing' }),
    createSvgElement(documentReference, 'feMorphology', { in: 'SourceAlpha', operator: 'erode', radius: SILHOUETTE_CASING_PIXELS, result: 'shrunk' }),
    createSvgElement(documentReference, 'feComposite', { in: 'SourceAlpha', in2: 'shrunk', operator: 'out', result: 'innerEdge' }),
    createSvgElement(documentReference, 'feComposite', { in: 'casingColour', in2: 'innerEdge', operator: 'in', result: 'innerCasing' }),
    merge,
  ];
}

// Draws the edge of the selected object's shape on screen: the triangles are filled as one shape, and a filter keeps
// only the ring just outside it, so no line crosses the inside of the object.
// `layer` is 'active' for the object the panels follow and 'others' for the rest of the selection, drawn at a lower strength.
function appendSelectionSilhouette(documentReference, gizmoSvg, triangles, layer = 'active') {
  const baseFilterId = gizmoSvg.getAttribute('data-silhouette-filter') ?? SILHOUETTE_FILTER_ID;
  const filterId = layer === 'active' ? baseFilterId : `${baseFilterId}-${layer}`;
  let pathData = '';
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let offset = 0; offset < triangles.length; offset += 6) {
    pathData += `M${triangles[offset].toFixed(1)} ${triangles[offset + 1].toFixed(1)}L${triangles[offset + 2].toFixed(1)} ${triangles[offset + 3].toFixed(1)}L${triangles[offset + 4].toFixed(1)} ${triangles[offset + 5].toFixed(1)}Z`;
    for (let corner = 0; corner < 6; corner += 2) {
      left = Math.min(left, triangles[offset + corner]);
      right = Math.max(right, triangles[offset + corner]);
      top = Math.min(top, triangles[offset + corner + 1]);
      bottom = Math.max(bottom, triangles[offset + corner + 1]);
    }
  }
  const margin = SILHOUETTE_EDGE_PIXELS[layer] + SILHOUETTE_CASING_PIXELS + 2;
  const filter = createSvgElement(documentReference, 'filter', {
    id: filterId,
    filterUnits: 'userSpaceOnUse',
    x: (left - margin).toFixed(1),
    y: (top - margin).toFixed(1),
    width: (right - left + margin * 2).toFixed(1),
    height: (bottom - top + margin * 2).toFixed(1),
  });
  filter.append(...silhouetteFilterSteps(documentReference, layer));
  const definitions = createSvgElement(documentReference, 'defs');
  definitions.append(filter);
  gizmoSvg.append(definitions, createSvgElement(documentReference, 'path', {
    class: 'crucible-studio-selection-silhouette',
    'data-layer': layer,
    d: pathData,
    filter: `url(#${filterId})`,
  }));
}

function maskFilterIdFor(filterId, layer) {
  return layer === 'active' ? filterId : `${filterId}-${layer}`;
}

// The filter that turns the mask canvas into its edge: the same dilate-and-subtract as the path outline, over the whole canvas.
// One filter for a mask that outlines a single object, and one at the lower strength for a mask under the active object's own outline.
function createMaskFilterSvg(documentReference, filterId) {
  const definitions = createSvgElement(documentReference, 'defs');
  for (const layer of ['active', 'others']) {
    const filter = createSvgElement(documentReference, 'filter', { id: maskFilterIdFor(filterId, layer), x: '0', y: '0', width: '1', height: '1' });
    filter.append(...silhouetteFilterSteps(documentReference, layer));
    definitions.append(filter);
  }
  const holder = createSvgElement(documentReference, 'svg', { class: 'crucible-studio-mask-filters', width: '0', height: '0', 'aria-hidden': 'true' });
  holder.append(definitions);
  return holder;
}

// How far from a handle a press still takes it, in pixels: the drawn handle stays thin, the area that answers is wide.
const GIZMO_HIT_LINE_WIDTH = 22;
const GIZMO_HIT_TIP_RADIUS = 16;
const GIZMO_HIT_ORIGIN_RADIUS = 13;

// The unseen areas go in first, so every drawn handle lies above them and a press on a drawn handle is still its own.
function appendGizmoHitAreas(documentReference, gizmoSvg, handles, tool, clearRadius = null) {
  const hitAttributes = axis => ({ fill: 'none', stroke: 'transparent', 'data-gizmo-axis': axis, 'data-gizmo-hit': 'line' });
  const hitDisc = (point, radius, axis) => createSvgElement(documentReference, 'circle', {
    cx: point.x.toFixed(1),
    cy: point.y.toFixed(1),
    r: String(radius),
    fill: 'transparent',
    stroke: 'none',
    'data-gizmo-axis': axis,
    'data-gizmo-hit': 'disc',
  });
  if (tool === 'rotate') {
    for (const axis of AXIS_NAMES) {
      const pointString = handles.rings[axis].filter(point => point.visible).map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      if (pointString) {
        gizmoSvg.append(createSvgElement(documentReference, 'polyline', { points: pointString, ...hitAttributes(axis) }));
      }
    }
    return;
  }
  const origin = handles.origin;
  const cleared = clearRadius !== null;
  const centreAxis = tool === 'scale' ? 'uniform' : 'screen';
  if (cleared) {
    // Only the ring answers for the centre, so a click inside it still picks the element under it.
    gizmoSvg.append(createSvgElement(documentReference, 'circle', {
      cx: origin.x.toFixed(1),
      cy: origin.y.toFixed(1),
      r: clearedRingRadius(clearRadius).toFixed(1),
      fill: 'none',
      'stroke-width': String(EDIT_RING_HIT_HALF_WIDTH * 2),
      'data-gizmo-axis': centreAxis,
      'data-gizmo-hit': 'ring',
    }));
  }
  for (const axis of AXIS_NAMES) {
    const tip = handles.axes[axis];
    if (!tip.visible) continue;
    // In edit mode the answering line starts and ends where the drawn arrow does, with a flat end, so the gap stays a gap.
    const { start, end } = clearedArrow(origin, tip, clearRadius);
    gizmoSvg.append(createSvgElement(documentReference, 'line', {
      x1: start.x.toFixed(1),
      y1: start.y.toFixed(1),
      x2: end.x.toFixed(1),
      y2: end.y.toFixed(1),
      'stroke-linecap': cleared ? 'butt' : 'round',
      ...hitAttributes(axis),
    }));
    if (!cleared) {
      gizmoSvg.append(hitDisc(tip, GIZMO_HIT_TIP_RADIUS, axis));
    }
  }
  if (!cleared) {
    gizmoSvg.append(hitDisc(origin, GIZMO_HIT_ORIGIN_RADIUS, centreAxis));
  }
}

function appendHullOutline(documentReference, gizmoSvg, points, active) {
  const attributes = {
    'data-layer': active ? 'active' : 'others',
    points: points.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' '),
  };
  gizmoSvg.append(
    createSvgElement(documentReference, 'polygon', { class: 'crucible-studio-selection-outline-casing', ...attributes }),
    createSvgElement(documentReference, 'polygon', { class: 'crucible-studio-selection-outline', ...attributes }),
  );
}

// Over a mask that outlines the whole selection: the active object at its own width, from its shape when it fits the
// triangle budget alone, from a second mask of its own when it is over the budget, else (no second mask) from its hull.
function appendActiveOverMask(documentReference, gizmoSvg, controller, activeOutlineMask, width, height) {
  const activeMaskDrawn = activeOutlineMask.draw(controller.selectionActiveMaskSource(), width, height);
  if (activeMaskDrawn) {
    activeOutlineMask.element.style.filter = `url(#${maskFilterIdFor(`${gizmoSvg.getAttribute('data-silhouette-filter')}-mask`, 'active')})`;
    return;
  }
  const { active } = controller.selectionSilhouetteLayers();
  if (active) {
    appendSelectionSilhouette(documentReference, gizmoSvg, active, 'active');
    return;
  }
  const hull = controller.selectionOutline();
  if (hull) {
    appendHullOutline(documentReference, gizmoSvg, hull, true);
  }
}

/** The answering discs of the arrow tips in edit mode; they go in after the plane squares, so a tip wins where a square lies over it. */
function appendClearedTipHitAreas(documentReference, gizmoSvg, handles, clearRadius) {
  for (const axis of AXIS_NAMES) {
    const tip = handles.axes[axis];
    if (!tip.visible) continue;
    const { end } = clearedArrow(handles.origin, tip, clearRadius);
    gizmoSvg.append(createSvgElement(documentReference, 'circle', {
      cx: end.x.toFixed(1),
      cy: end.y.toFixed(1),
      r: String(GIZMO_HIT_TIP_RADIUS),
      fill: 'transparent',
      stroke: 'none',
      'data-gizmo-axis': axis,
      'data-gizmo-hit': 'disc',
    }));
  }
}

// In mesh edit mode the move handles leave the picked element's middle clear, as Blender's do. The centre dot gives way to a thin ring
// (the free-move circle) at the clearance, and each arrow moves out whole, start and tip, by the pick's screen reach plus a gap,
// so it keeps its drawn length. The move stops at a cap: past it the arrow may lie over a big pick, which is the limit of this design.
const EDIT_CLEARANCE_GAP = 12;
// The ring sits further out than the arrows start; its answering band begins 14 px from a vertex, the reach of a vertex pick.
const EDIT_RING_GAP = 20;
const EDIT_CLEARANCE_CAP = 100;
// A ring's answering band is this far to each side of the ring: with the gap above, a vertex keeps its whole 14 px pick area.
const EDIT_RING_HIT_HALF_WIDTH = 6;
// A plane square thinner than this on screen, in pixels across its narrow side, is hidden: a pointer cannot be aimed at less (a 30 px square seen at 8 degrees).
const PLANE_SQUARE_MINIMUM_THICKNESS = 4;

function clearedDistance(clearRadius) {
  return Math.min(clearRadius + EDIT_CLEARANCE_GAP, EDIT_CLEARANCE_CAP);
}

/** The radius of the free-move ring around the pick, in pixels. */
export function clearedRingRadius(clearRadius) {
  return Math.min(clearRadius + EDIT_RING_GAP, EDIT_CLEARANCE_CAP);
}

/** An arrow from the origin to the tip moved outward along itself by the cleared distance, same length; unchanged when nothing is cleared. */
export function clearedArrow(origin, tip, clearRadius) {
  const length = Math.hypot(tip.x - origin.x, tip.y - origin.y);
  if (clearRadius === null || length < 1e-3) {
    return { start: origin, end: tip };
  }
  const share = clearedDistance(clearRadius) / length;
  const shift = { x: (tip.x - origin.x) * share, y: (tip.y - origin.y) * share };
  return { start: { x: origin.x + shift.x, y: origin.y + shift.y }, end: { x: tip.x + shift.x, y: tip.y + shift.y } };
}

const PLANE_AXIS_NAMES = Object.freeze({ xy: ['x', 'y'], xz: ['x', 'z'], yz: ['y', 'z'] });

/** How many pixels across a plane square is at its narrowest on screen (its area over its longer side). */
export function planeSquareThickness(corners) {
  const first = { x: corners[1].x - corners[0].x, y: corners[1].y - corners[0].y };
  const second = { x: corners[3].x - corners[0].x, y: corners[3].y - corners[0].y };
  const longest = Math.max(Math.hypot(first.x, first.y), Math.hypot(second.x, second.y));
  return longest < 1e-3 ? 0 : Math.abs(first.x * second.y - first.y * second.x) / longest;
}

/** True when the square is too thin to aim at, as when its two axes lie almost along one line on screen. */
export function planeSquareIsTooThin(corners) {
  return planeSquareThickness(corners) < PLANE_SQUARE_MINIMUM_THICKNESS;
}

// Two axes that point nearly opposite ways on screen make the two shifts partly cancel and the square would stay on the pick. The
// shifts then grow, by this step and up to this many times, until the square is as far out as the arrows start.
const PLANE_SHIFT_GROWTH_STEP = 0.25;
const PLANE_SHIFT_MAXIMUM_GROWTH = 3;

/** The corners of a plane square moved outward along its two axes by what each arrow skips; the corners themselves when nothing is cleared. */
export function clearedPlaneCorners(corners, origin, axisTips, clearRadius) {
  const shifts = axisTips.map(tip => {
    const { start } = clearedArrow(origin, tip, clearRadius);
    return { x: start.x - origin.x, y: start.y - origin.y };
  });
  const wantedDistance = Math.max(...shifts.map(shift => Math.hypot(shift.x, shift.y)));
  const shiftBy = growth => corners.map(corner => ({
    ...corner,
    x: corner.x + growth * shifts.reduce((sum, shift) => sum + shift.x, 0),
    y: corner.y + growth * shifts.reduce((sum, shift) => sum + shift.y, 0),
  }));
  let growth = 1;
  let moved = shiftBy(growth);
  while (growth < PLANE_SHIFT_MAXIMUM_GROWTH && Math.min(...moved.map(corner => Math.hypot(corner.x - origin.x, corner.y - origin.y))) < wantedDistance) {
    growth += PLANE_SHIFT_GROWTH_STEP;
    moved = shiftBy(growth);
  }
  return moved;
}

function renderGizmoMarkup(documentReference, gizmoSvg, controller, outlineMask, activeOutlineMask, { hideSelectionOutline = false, clearRadius = null } = {}) {
  gizmoSvg.replaceChildren();
  const width = controller.viewportWidth;
  const height = controller.viewportHeight;
  gizmoSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const silhouette = hideSelectionOutline ? null : controller.selectionSilhouette();
  // A dense selection is drawn by the mask; the hull below is only for when the mask cannot draw (no WebGL2).
  const maskSource = silhouette || hideSelectionOutline ? null : controller.selectionMaskSource();
  const maskDrawn = outlineMask.draw(maskSource, width, height);
  if (maskDrawn) {
    // With others selected the mask is their strength and the active object is drawn over it at its own.
    outlineMask.element.style.filter = `url(#${maskFilterIdFor(`${gizmoSvg.getAttribute('data-silhouette-filter')}-mask`, maskSource.othersExist ? 'others' : 'active')})`;
    if (maskSource.othersExist) {
      appendActiveOverMask(documentReference, gizmoSvg, controller, activeOutlineMask, width, height);
    }
  }
  if (!maskDrawn || !maskSource.othersExist) {
    activeOutlineMask.draw(null, width, height);
  }
  const outlines = silhouette || maskDrawn || hideSelectionOutline ? [] : controller.selectionOutlineLayers();
  if (silhouette) {
    const layers = controller.selectionSilhouetteLayers();
    if (layers.othersExist) {
      appendSelectionSilhouette(documentReference, gizmoSvg, layers.others, 'others');
    }
    if (layers.activeExists) {
      appendSelectionSilhouette(documentReference, gizmoSvg, layers.active, 'active');
    }
  }
  for (const outline of outlines.sort((first, second) => Number(first.active) - Number(second.active))) {
    appendHullOutline(documentReference, gizmoSvg, outline.points, outline.active);
  }
  appendDragTrace(documentReference, gizmoSvg, controller.dragTrace());
  const handles = controller.gizmoHandles();
  if (!handles || !handles.origin.visible) {
    return;
  }
  const origin = handles.origin;
  const tool = controller.tool;

  if (tool === 'select') {
    gizmoSvg.append(createSvgElement(documentReference, 'circle', {
      cx: origin.x.toFixed(1),
      cy: origin.y.toFixed(1),
      r: '8',
      fill: 'color-mix(in srgb, var(--studio-accent) 15%, transparent)',
      stroke: 'var(--studio-accent)',
      'stroke-width': '2',
      'data-gizmo-axis': 'screen',
    }));
    return;
  }

  if (!controller.dragging) {
    appendGizmoHitAreas(documentReference, gizmoSvg, handles, tool, clearRadius);
  }

  if (tool === 'rotate') {
    const sweep = controller.rotationSweep();
    if (sweep && sweep.centre.visible) {
      appendRotationSweep(documentReference, gizmoSvg, sweep);
    }
    for (const axis of AXIS_NAMES) {
      // While one ring is being turned the other two leave, so the turn is the only thing to read.
      if (sweep && sweep.axis !== axis) continue;
      const ring = handles.rings[axis];
      const pointString = ring.filter(point => point.visible).map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      if (!pointString) continue;
      gizmoSvg.append(createSvgElement(documentReference, 'polyline', {
        points: pointString,
        fill: 'none',
        stroke: AXIS_COLORS[axis],
        'stroke-width': '3',
        'stroke-opacity': '0.92',
        'data-gizmo-axis': axis,
      }));
    }
    gizmoSvg.append(createSvgElement(documentReference, 'circle', {
      cx: origin.x.toFixed(1),
      cy: origin.y.toFixed(1),
      r: '5',
      fill: 'var(--studio-text)',
      stroke: 'var(--studio-bg)',
      'stroke-width': '1.8',
    }));
    return;
  }

  // clearRadius is null in object mode, which keeps every handle exactly as it was.
  const cleared = clearRadius !== null;

  if (tool === 'translate') {
    const planeColors = { xy: '#5ea8ff', xz: '#5fc48a', yz: '#ee7a6c' };
    for (const planeAxis of ['xy', 'xz', 'yz']) {
      const planeCorners = handles.planes[planeAxis];
      if (!planeCorners || planeCorners.some(point => !point.visible)) continue;
      if (cleared && planeSquareIsTooThin(planeCorners)) continue;
      const corners = cleared ? clearedPlaneCorners(planeCorners, origin, PLANE_AXIS_NAMES[planeAxis].map(axis => handles.axes[axis]), clearRadius) : planeCorners;
      gizmoSvg.append(createSvgElement(documentReference, 'polygon', {
        points: corners.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
        fill: planeColors[planeAxis],
        'fill-opacity': '0.24',
        stroke: planeColors[planeAxis],
        'stroke-width': '1.2',
        'data-gizmo-axis': planeAxis,
      }));
    }
    if (cleared && !controller.dragging) {
      appendClearedTipHitAreas(documentReference, gizmoSvg, handles, clearRadius);
    }
  }

  for (const axis of AXIS_NAMES) {
    const handleTip = handles.axes[axis];
    if (!handleTip.visible) continue;
    const arrow = clearedArrow(origin, handleTip, clearRadius);
    const shaftStart = arrow.start;
    const tip = arrow.end;
    gizmoSvg.append(createSvgElement(documentReference, 'line', {
      x1: shaftStart.x.toFixed(1),
      y1: shaftStart.y.toFixed(1),
      x2: arrow.end.x.toFixed(1),
      y2: arrow.end.y.toFixed(1),
      stroke: AXIS_COLORS[axis],
      'stroke-width': '3',
      'stroke-linecap': 'round',
      'data-gizmo-axis': axis,
    }));
    if (tool === 'scale') {
      gizmoSvg.append(createSvgElement(documentReference, 'rect', {
        x: (tip.x - 6).toFixed(1),
        y: (tip.y - 6).toFixed(1),
        width: '12',
        height: '12',
        rx: '2',
        fill: AXIS_COLORS[axis],
        stroke: 'var(--studio-bg)',
        'stroke-width': '1.5',
        'data-gizmo-axis': axis,
      }));
    } else {
      const arrowPoints = tool === 'translate' ? arrowHeadPoints(shaftStart, tip) : null;
      const handleAttributes = { fill: AXIS_COLORS[axis], stroke: 'none', 'stroke-linejoin': 'round', 'data-gizmo-axis': axis };
      gizmoSvg.append(arrowPoints
        ? createSvgElement(documentReference, 'polygon', { points: arrowPoints, 'data-gizmo-shape': 'arrow', ...handleAttributes })
        : createSvgElement(documentReference, 'circle', { cx: tip.x.toFixed(1), cy: tip.y.toFixed(1), r: '7', ...handleAttributes }));
    }
  }

  const centreAxis = tool === 'scale' ? 'uniform' : 'screen';
  if (cleared) {
    appendFreeMoveRing(documentReference, gizmoSvg, origin, clearedRingRadius(clearRadius), centreAxis);
    return;
  }
  gizmoSvg.append(createSvgElement(documentReference, 'circle', {
    cx: origin.x.toFixed(1),
    cy: origin.y.toFixed(1),
    r: '6.5',
    fill: 'var(--studio-text)',
    stroke: 'var(--studio-bg)',
    'stroke-width': '2',
    'data-gizmo-axis': centreAxis,
  }));
}

// The free-move ring of edit mode: a thin line in the text colour over a wider one in the background colour, so it reads on light and
// dark surfaces in both themes. Only the answering ring (appendGizmoHitAreas) takes the pointer; the drawn one lets clicks through to the pick.
function appendFreeMoveRing(documentReference, gizmoSvg, origin, radius, axis) {
  const ringAttributes = { cx: origin.x.toFixed(1), cy: origin.y.toFixed(1), r: radius.toFixed(1), fill: 'none', 'data-gizmo-ring': 'drawn' };
  gizmoSvg.append(
    createSvgElement(documentReference, 'circle', { ...ringAttributes, stroke: 'var(--studio-bg)', 'stroke-opacity': '0.7', 'stroke-width': '4' }),
    createSvgElement(documentReference, 'circle', { ...ringAttributes, stroke: 'var(--studio-text)', 'stroke-width': '1.5', 'data-gizmo-axis': axis }),
  );
}

const SCENE_OBJECT_MARK_RADIUS = 13;
// A sun has no place in the scene, so its mark floats in front of the view at a share of the way to what the view looks at.
const SUN_MARK_DISTANCE_SHARE = 0.35;
const SUN_MARK_RAY_SHARE = 0.12;

/** Where a ray meets the plane through a point with a normal, or null when it runs parallel or the plane lies behind it. */
function intersectPlane(ray, planePoint, planeNormal) {
  const facing = ray.direction.reduce((sum, component, axis) => sum + component * planeNormal[axis], 0);
  if (Math.abs(facing) < 1e-6) {
    return null;
  }
  const distance = planePoint.reduce((sum, component, axis) => sum + (component - ray.origin[axis]) * planeNormal[axis], 0) / facing;
  return distance > 0 ? ray.origin.map((component, axis) => component + ray.direction[axis] * distance) : null;
}

function sceneObjectMarkPosition(object, viewCamera) {
  if (object.kind !== 'sun') {
    return object.position;
  }
  const reach = Math.hypot(...viewCamera.eye.map((component, axis) => component - viewCamera.target[axis])) * SUN_MARK_DISTANCE_SHARE;
  return viewCamera.target.map((component, axis) => component + object.direction[axis] * reach);
}

function appendSceneObjectMark(documentReference, gizmoSvg, object, projected, selected) {
  const mark = createSvgElement(documentReference, 'g', {
    class: 'crucible-studio-scene-mark',
    'data-selected': selected ? 'true' : 'false',
    transform: `translate(${projected.x.toFixed(1)} ${projected.y.toFixed(1)})`,
  });
  const markAttributes = { 'data-scene-object': object.key };
  const disc = createSvgElement(documentReference, 'circle', { r: SCENE_OBJECT_MARK_RADIUS, class: 'crucible-studio-scene-mark-disc', ...markAttributes });
  const glyph = createSvgElement(documentReference, 'path', { d: studioIconPath(SCENE_OBJECT_ICONS[object.kind]), transform: 'translate(-9 -9) scale(0.75)', ...markAttributes });
  mark.append(disc, glyph);
  gizmoSvg.append(mark);
}

function appendSunRay(documentReference, gizmoSvg, controller, object, projected, selected) {
  const viewCamera = controller.viewCamera;
  const reach = Math.hypot(...viewCamera.eye.map((component, axis) => component - viewCamera.target[axis])) * SUN_MARK_RAY_SHARE;
  const origin = sceneObjectMarkPosition(object, viewCamera);
  const end = controller.projectWorldPoint(origin.map((component, axis) => component - object.direction[axis] * reach));
  if (!end.visible) {
    return;
  }
  gizmoSvg.append(createSvgElement(documentReference, 'line', {
    class: 'crucible-studio-scene-mark-ray',
    'data-selected': selected ? 'true' : 'false',
    x1: projected.x.toFixed(1),
    y1: projected.y.toFixed(1),
    x2: end.x.toFixed(1),
    y2: end.y.toFixed(1),
  }));
}

/** One mark per light and one for the sun; the scene camera is drawn only while the view looks away from it. */
function renderSceneObjectMarks(documentReference, gizmoSvg, controller) {
  const width = controller.viewportWidth;
  const height = controller.viewportHeight;
  for (const object of controller.listSceneObjects()) {
    if (object.kind === 'camera' && !controller.freeView) {
      continue;
    }
    const projected = controller.projectWorldPoint(sceneObjectMarkPosition(object, controller.viewCamera));
    if (!projected.visible || projected.x < 0 || projected.x > width || projected.y < 0 || projected.y > height) {
      continue;
    }
    const selected = object.key === controller.selectedObjectKey;
    if (object.kind === 'sun') {
      appendSunRay(documentReference, gizmoSvg, controller, object, projected, selected);
    }
    appendSceneObjectMark(documentReference, gizmoSvg, object, projected, selected);
  }
}

function buildPackReadyRecipe(recipe) {
  const cloned = structuredClone(recipe);
  const stripped = [];
  for (const field of ['motion', 'timeline', 'physics', 'cloth', 'particles', 'game', 'postPasses', 'armatures']) {
    if (cloned[field] !== undefined) {
      delete cloned[field];
      stripped.push(field);
    }
  }
  if (cloned.environment) {
    for (const envField of ['sky', 'spotLights', 'areaLights', 'shadowCascades', 'sunAngularRadius', 'lines']) {
      if (cloned.environment[envField] !== undefined) {
        delete cloned.environment[envField];
        stripped.push(`environment.${envField}`);
      }
    }
  }
  return { stillRecipe: cloned, stripped };
}

function depthSortedNodes(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered = [];
  const visited = new Set();
  function walk(parentId, depth) {
    for (const node of nodes) {
      if (node.assetPart || visited.has(node.id)) continue;
      if ((node.parent ?? null) !== parentId) continue;
      visited.add(node.id);
      ordered.push({ node, depth });
      walk(node.id, depth + 1);
    }
  }
  walk(null, 0);
  for (const node of nodes) {
    if (!node.assetPart && !visited.has(node.id)) {
      ordered.push({ node, depth: 0 });
    }
  }
  return ordered;
}

const MODAL_AXES = Object.freeze(['x', 'y', 'z']);
const MODAL_AXIS_BY_ACTION = Object.freeze({
  'modal.axisX': 'x', 'modal.axisY': 'y', 'modal.axisZ': 'z',
  // Shift keeps the object on the plane across the axis, so Shift+Y is the ground in Y-up space.
  'modal.planeX': 'yz', 'modal.planeY': 'xz', 'modal.planeZ': 'xy',
});
const MODAL_AXIS_ACROSS_PLANE = Object.freeze({ yz: 'x', xz: 'y', xy: 'z' });
const MODAL_TYPED_UNITS = Object.freeze({ translate: ' m', rotate: '°', scale: '×' });
const MODAL_TYPED_PATTERN = /^-?\d*\.?\d*$/;
const MODAL_TOOL_BY_ACTION = Object.freeze({ 'modal.translate': 'translate', 'modal.rotate': 'rotate', 'modal.scale': 'scale' });
const TOOL_ACTION_BY_TOOL = Object.freeze({ select: 'tool.select', translate: 'tool.translate', rotate: 'tool.rotate', scale: 'tool.scale' });
const PICK_UP_TOOL_BY_ACTION = Object.freeze({ 'tool.translate': 'translate', 'tool.rotate': 'rotate', 'tool.scale': 'scale' });
const MODAL_FREE_AXIS = Object.freeze({ translate: 'screen', scale: 'uniform' });
const MODAL_TOOL_WORDS = Object.freeze({ translate: 'Move', rotate: 'Rotate', scale: 'Scale' });
const TRANSFORM_PART_BY_ACTION = Object.freeze({ 'edit.resetPosition': 'translation', 'edit.resetRotation': 'rotation', 'edit.resetScale': 'scale' });
const TRANSFORM_AT_REST = Object.freeze({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const TRANSFORM_PART_WORDS = Object.freeze({ translation: 'Position', rotation: 'Rotation', scale: 'Scale' });
const VIEW_PRESET_BY_ACTION = Object.freeze({ 'view.front': 'front', 'view.right': 'right', 'view.top': 'top' });

function browserPreferenceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function describeSceneSize(controller) {
  const triangles = controller.scene.parts.reduce((count, part) => count + (part.geometry?.indices?.length ?? 0) / 3, 0);
  return { nodes: controller.exportRecipe().nodes.length, triangles: Math.round(triangles) };
}

/**
 * Mounts Crucible Studio: 3-zone 3D editor with outliner, SVG 3D gizmos, 4-tab inspector, timeline and desktop IPC hooks.
 */
export function createStudio(container, {
  scene: suppliedScene,
  recipe: suppliedRecipe,
  template = 'blockout',
  canvas: suppliedCanvas,
  renderer: suppliedRenderer,
  rendererOptions = {},
  // Builds the renderer when Studio makes its own; tests pass a recording one.
  createRenderer = (renderCanvas, parts, options) => new CrucibleRenderer(renderCanvas, parts, options),
  // Fetches the render pass code a post pass with `objects` needs; tests pass their own to control when it arrives.
  renderPassesLoader = undefined,
  desktop = null,
  fileName: initialFileName = 'untitled.scene.json',
  homeHref = null,
  watchedPath: initialWatchedPath = null,
  agentName: initialAgentName = DEFAULT_AGENT_NAME,
  preferences: suppliedPreferences = null,
  preferenceStorage = browserPreferenceStorage(),
  catalog: catalogHooks = {},
  onDirtyChange,
  onThemeChange,
  onDiagnostic,
  // Opens an address outside Studio. A host page supplies it; without one the guide opens in a new tab.
  openExternal,
  diagnostics: diagnosticsOptions = {},
} = {}) {
  const catalog = createStudioCatalog(catalogHooks);
  let preferences = normalizeStudioPreferences({ ...loadStudioPreferences(preferenceStorage), ...suppliedPreferences });
  if (!container || typeof container.append !== 'function') {
    throw new TypeError('createStudio requires a DOM container element.');
  }
  const documentReference = container.ownerDocument;
  const defaultAgentName = assertAgentName(initialAgentName);
  injectStudioStyles(documentReference);

  // A recipe with catalog scans, an HDRI or a boolean mesh edit needs its files or code fetched first. Studio opens on
  // the template meanwhile and swaps the recipe in when `ready` settles, so createStudio itself stays synchronous.
  const recipeNeedsFetching = recipe => catalog.needsLoading(recipe) || (needsMeshBooleans(recipe) && !meshBooleansLoaded());
  const pendingRecipe = suppliedRecipe && !suppliedScene && recipeNeedsFetching(suppliedRecipe) ? suppliedRecipe : null;
  const initialRecipe = pendingRecipe ? buildTemplateRecipe(template) : suppliedRecipe ?? (suppliedScene ? null : buildTemplateRecipe(template));
  // The scene reads catalog assets and images from the pool, so an import into the first scene can place them.
  const initialScene = suppliedScene ?? createAgentScene(initialRecipe, {}, { assets: catalog.pool, sequenceFrames: catalog.pool, deferInitialFlush: true });
  let handleChange = () => {};
  const studioDiagnostics = createStudioDiagnostics({
    limit: diagnosticsOptions.limit,
    now: diagnosticsOptions.now,
    slowOperationMilliseconds: diagnosticsOptions.slowOperationMilliseconds,
    onEntry: onDiagnostic,
    describeScene: () => describeSceneSize(controller),
    describeEnvironment: () => describeStudioEnvironment({
      windowReference: documentReference.defaultView,
      renderer,
      viewportWidth: controller.viewportWidth,
      viewportHeight: controller.viewportHeight,
    }),
  });
  const controller = createStudioController({
    scene: initialScene,
    assets: catalog.pool,
    onChange: detail => studioDiagnostics.measure('handleChange', () => handleChange(detail)),
    measureOperation: studioDiagnostics.measure,
  });

  async function prepareRecipe(recipe) {
    await loadAgentSceneModules(recipe);
    if (needsMeshBooleans(recipe)) {
      await loadMeshBooleans();
    }
    await catalog.prepare(recipe);
  }

  let activeFilePath = initialWatchedPath;
  let activeFileName = initialFileName;
  // The extension of the file a host opened or saved, when it is not one Studio knows: it stays the type of the name on a rename.
  let activeFileSuffix = '';
  let isDirty = false;
  let autoReloadWatch = true;
  let renderer = suppliedRenderer ?? null;
  let rendererHasDepth = false;
  let rendererHasFloor = true;
  let rendererFloorHeight = null;
  let sceneLoadedSinceFloorFit = false;
  let floorDecision = { scene: null, revision: -1, drawsFloor: true };
  const partSync = createPartSyncTracker(initialScene);
  let gridVisible = preferences.gridVisible;
  let gridParts = null;
  let gridPartsByName = null;
  let flightHandle = 0;
  let capturingStill = false;
  let selectionReadoutStale = true;
  let renderedShadowKey = null;
  let contextLost = false;
  let resizeObserver = null;
  let intersectionObserver = null;
  let frameHandle = 0;
  let playing = false;
  let lastFrameTime = 0;
  let isVisible = true;
  let insideDraw = false;
  // A scheduled frame does not wait for the driver to link a main program that new parts need (#2944): it keeps the last
  // picture and draws again once the program is ready. A direct draw and a still block instead, since their caller reads the canvas.
  let deferringLinks = false;
  let awaitedProgram = null;
  let awaitedProgramTimer = 0;
  let pointerState = null;
  let viewportPointer = null;
  // Edit mode (src/studio-mesh-edit.js) is loaded on the first Tab, so the core entry carries none of it.
  let meshEditor = null;
  let meshEditorLoad = null;
  // The held E and I of edit mode (src/studio-mesh-tool.js); set when the editor loads.
  let faceToolInput = null;
  let modalTransform = null;
  let swallowContextMenu = false;
  let swallowClick = false;
  let statusTimer = 0;
  let statusExitTimer = 0;
  let liveDeltaLabel = '';

  const root = createElement(documentReference, 'div', {
    className: 'crucible-studio',
    dataset: {
      desktop: desktop ? 'true' : 'false',
      outlinerCollapsed: 'false',
      inspectorCollapsed: 'false',
    },
  });
  // A slider or colour drag fires many input events; they are one undo step, closed by the change event.
  const isContinuousInput = target => target?.tagName === 'INPUT' && (target.type === 'range' || target.type === 'color');
  root.addEventListener('input', event => {
    if (isContinuousInput(event.target)) controller.beginUndoGroup();
  }, true);
  root.addEventListener('change', event => {
    if (isContinuousInput(event.target)) controller.endUndoGroup();
  });

  // Top Workspace Header Bar
  const filePill = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-filepill', attributes: { 'aria-label': 'Rename scene' } });
  const watchPill = createElement(documentReference, 'span', {
    className: 'crucible-studio-watch-pill',
    hidden: !activeFilePath,
    title: 'Reloads when the agent edits this file',
    attributes: { role: 'img', 'aria-label': 'Reloads when the agent edits this file' },
  });
  // The keymap in force. Choosing another preset swaps it and every place that shows a key is drawn again.
  const keymapOf = () => resolveKeymapPreset(preferences.keymap, preferences.keyOverrides[preferences.keymap], { numberPad: preferences.numberPad });
  const keymapSignature = () => JSON.stringify([preferences.keymap, preferences.numberPad, preferences.keyOverrides[preferences.keymap] ?? {}]);
  let keymap = keymapOf();
  let appliedKeymap = '';
  const menuKeyViews = [];
  const keyTooltipViews = [];
  const setShortcutLabel = (element, label) => {
    if (label) element.dataset.shortcut = label;
    else delete element.dataset.shortcut;
  };
  // A menu row or button that names the key of an action on its right.
  const showActionKey = (element, actionId) => {
    if (!actionId) return element;
    menuKeyViews.push({ element, actionId });
    setShortcutLabel(element, keyLabel(keymap, actionId));
    return element;
  };
  // An icon button whose tooltip names a key, written again when the keymap changes.
  const createKeyedIconButton = (iconName, describe, properties = {}) => {
    const button = createIconButton(documentReference, iconName, describe(), properties);
    keyTooltipViews.push({ button, iconName, describe });
    return button;
  };
  const openButton = showActionKey(createElement(documentReference, 'button', { type: 'button', textContent: 'Open…' }), 'file.open');
  // Import needs a place to keep the file (catalog.store) and a way to name it (SHA-256); without either the row is not offered.
  const canImport = catalog.canStore && Boolean(documentReference.defaultView?.crypto?.subtle ?? globalThis.crypto?.subtle);
  const importButton = canImport ? createElement(documentReference, 'button', { type: 'button', textContent: 'Import…' }) : null;
  const saveButton = showActionKey(createElement(documentReference, 'button', { type: 'button', textContent: 'Save' }), 'file.save');
  const saveAsButton = showActionKey(createElement(documentReference, 'button', { type: 'button', textContent: 'Save as…' }), 'file.saveAs');
  const addMenuButton = createIconButton(documentReference, 'add', 'Add an object or a light', { attributes: { popovertarget: 'crucible-studio-pop-add' } });
  // The menus of the top bar, as a desktop app lays them out. Each one opens a popover of rows.
  const createMenuButton = (label, popoverId, attributes = {}) => createElement(documentReference, 'button', {
    type: 'button',
    className: 'crucible-studio-menu-button',
    textContent: label,
    attributes: { popovertarget: popoverId, ...attributes },
  });
  // Every menu row starts with the same square: its icon, or nothing, so the labels line up either way.
  const giveMenuIcon = (item, iconName) => {
    if (!iconName) {
      item.prepend(createElement(documentReference, 'span', { className: 'crucible-studio-menu-gap', attributes: { 'aria-hidden': 'true' } }));
      return item;
    }
    item.prepend(createIcon(documentReference, iconName));
    return item;
  };
  // Export is a place to look at the shot and save it: nothing in the scene changes there and the view does not move. Undo and redo,
  // the file commands and the settings stay. This one guard serves the keys, the menu rows and the viewport.
  const SHOT_PASS_THROUGH = new Set(['edit.undo', 'edit.redo', 'file.open', 'file.save', 'file.saveAs', 'settings.open', 'help.shortcuts', 'view.properties']);
  const viewingShot = () => root.dataset.workspace === 'export';
  const shotLocksAction = actionId => viewingShot() && !SHOT_PASS_THROUGH.has(actionId);
  // The rows and rail buttons that do nothing in Export look disabled there, the way undo does with nothing to undo.
  const shotLockedControls = [];
  const lockInShot = control => {
    shotLockedControls.push(control);
    return control;
  };
  // One row of a menu: its icon, what it does, and its key on the right.
  const createMenuItem = (label, actionId, onChoose, iconName) => {
    const item = showActionKey(createElement(documentReference, 'button', { type: 'button', textContent: label }), actionId);
    if (actionId && !SHOT_PASS_THROUGH.has(actionId)) lockInShot(item);
    item.addEventListener('click', event => {
      if (actionId && shotLocksAction(actionId)) return;
      onChoose(event);
    });
    return giveMenuIcon(item, iconName);
  };
  // The Agent card: a host that offers a chat fills it (studio-agent-chat.js). Without one there is no card, no menu row and no data attribute.
  const agentPanel = createAgentPanel({
    documentReference,
    createElement,
    createIcon,
    createIconButton,
    watchScrollFade,
    host: globalThis.crucibleShell?.agentChat,
    root,
    readPreferences: () => preferences,
    setPreference: (name, value) => setPreference(name, value),
    applyPreferences: () => applyPreferences(),
    showPanelMinimized: (...argumentsList) => showPanelMinimized(...argumentsList),
    syncMenuToggles: () => syncMenuToggles(),
    onStep: nodeId => showAgentEdit({ nodeIds: [nodeId] }),
    setInspectorCollapsed: collapsed => setInspectorCollapsed(collapsed),
    hideHistory: () => setHistoryShown(false, { remember: false }),
  });
  // Whether the History panel is shown, and the edits it last drew, so a notification that changed no edit draws nothing.
  let historyShown = false;
  let renderedHistoryKey = '';
  const menuToggles = [];
  const syncMenuToggles = () => menuToggles.forEach(({ item, isOn }) => item.setAttribute('aria-checked', isOn() ? 'true' : 'false'));
  const createMenuToggle = (label, actionId, onChoose, isOn, iconName) => {
    const item = createMenuItem(label, actionId, () => {
      onChoose();
      syncMenuToggles();
    }, iconName);
    item.setAttribute('role', 'menuitemcheckbox');
    menuToggles.push({ item, isOn });
    return item;
  };
  const createMenuPopover = (popoverId, ...items) => createElement(documentReference, 'div', {
    id: popoverId,
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  }, ...items);
  // Snapping is a state, not a tool: the magnet turns it on or off, the button under it names what it snaps to.
  const snapTargetOf = id => SNAP_TARGETS.find(target => target.id === id) ?? SNAP_TARGETS[0];
  const snapToggleButton = createKeyedIconButton('snap', () => `Snapping ${preferences.snapEnabled ? 'on' : 'off'} (${keyLabel(keymap, 'snap.toggle')})`, {
    dataset: { snapToggle: 'true' },
    attributes: { 'aria-pressed': preferences.snapEnabled ? 'true' : 'false' },
  });
  const snapTargetButton = createIconButton(documentReference, snapTargetOf(preferences.snapTarget).icon, `Snap to ${snapTargetOf(preferences.snapTarget).label}`, {
    dataset: { snapTargetButton: 'true' },
    attributes: { popovertarget: 'crucible-studio-pop-snap', 'aria-haspopup': 'menu' },
  });
  const snapTargetItems = SNAP_TARGETS.map(target => {
    const item = createMenuItem(target.label, '', () => {
      setPreferences({ snapTarget: target.id, snapEnabled: true });
      announce(`Snapping to ${target.label}`);
    }, target.icon);
    item.dataset.snapTarget = target.id;
    item.setAttribute('role', 'menuitemcheckbox');
    return item;
  });
  const snapPopover = createMenuPopover('crucible-studio-pop-snap', ...snapTargetItems);
  function syncSnapUi() {
    const target = snapTargetOf(preferences.snapTarget);
    snapToggleButton.setAttribute('aria-pressed', preferences.snapEnabled ? 'true' : 'false');
    setButtonIcon(snapToggleButton, 'snap', `Snapping ${preferences.snapEnabled ? 'on' : 'off'} (${keyLabel(keymap, 'snap.toggle')})`);
    setButtonIcon(snapTargetButton, target.icon, `Snap to ${target.label}`);
    for (const item of snapTargetItems) {
      item.setAttribute('aria-checked', item.dataset.snapTarget === target.id ? 'true' : 'false');
    }
  }
  snapToggleButton.addEventListener('click', () => toggleSnapping());
  function toggleSnapping() {
    setPreference('snapEnabled', !preferences.snapEnabled);
    announce(preferences.snapEnabled ? `Snapping on, to ${snapTargetOf(preferences.snapTarget).label}` : 'Snapping off');
  }
  const fileMenuButton = createMenuButton('File', 'crucible-studio-pop-new');
  const editMenuButton = createMenuButton('Edit', 'crucible-studio-pop-edit');
  const viewMenuButton = createMenuButton('View', 'crucible-studio-pop-view');
  const aiSyncMenuButton = createMenuButton('Agent', 'crucible-studio-pop-sync', { 'aria-label': 'Work with an AI agent' });
  const helpMenuButton = createMenuButton('Help', 'crucible-studio-pop-help');
  const showView = presetName => {
    controller.setCameraViewPreset(presetName);
    announce(`${presetName[0].toUpperCase()}${presetName.slice(1)} view`);
  };
  const menuContext = {
    controller,
    announce: (message, target, kind, options) => announce(message, target, kind, options),
    announceError: message => announceError(message),
    root,
    agentPanel,
    selectInspectorTab: tab => selectInspectorTab(tab),
  };
  function buildRegisteredMenuPopover(popoverId, menuName, coreEntries) {
    const entries = [...coreEntries, ...registeredStudioMenuEntries(menuName)]
      .filter(entry => entry.isVisible?.(menuContext) !== false)
      .sort((first, second) => first.order - second.order);
    const items = entries.map(entry => {
      if (entry.element) return entry.element;
      const item = entry.kind === 'toggle'
        ? createMenuToggle(entry.label, entry.actionId ?? '', () => entry.onChoose(menuContext), () => entry.isOn(menuContext), entry.icon)
        : createMenuItem(entry.label, entry.actionId ?? '', () => entry.onChoose(menuContext), entry.icon);
      return entry.lockInShot ? lockInShot(item) : item;
    });
    return createMenuPopover(popoverId, ...items);
  }
  const editUndoItem = createMenuItem('Undo', 'edit.undo', () => undoButton.click(), 'undo');
  const editRedoItem = createMenuItem('Redo', 'edit.redo', () => redoButton.click(), 'redo');
  // History is a panel in the right column; this row shows it and moves focus to the edit the scene shows.
  const historyItem = createMenuItem('History', '', () => showHistoryPanel(), 'history');
  const editPopover = buildRegisteredMenuPopover('crucible-studio-pop-edit', 'edit', [
    { order: 10, element: editUndoItem },
    { order: 20, element: editRedoItem },
    { order: 30, element: historyItem },
    { order: 40, label: 'Copy', actionId: 'edit.copy', icon: 'duplicate', onChoose: () => copySelection() },
    { order: 50, label: 'Paste', actionId: 'edit.paste', icon: 'clipboard', onChoose: () => pasteCopy() },
    { order: 60, label: 'Duplicate', actionId: 'edit.duplicate', icon: 'duplicateObject', onChoose: () => duplicateSelection() },
    { order: 70, label: 'Join', actionId: 'edit.join', icon: 'duplicate', onChoose: () => joinSelection() },
    { order: 80, label: 'Parent', actionId: 'edit.parent', icon: 'node', onChoose: () => parentSelection() },
    { order: 90, label: 'Clear parent', actionId: 'edit.clearParent', icon: 'deselect', onChoose: () => clearParentSelection() },
    { order: 100, label: 'Delete', actionId: 'edit.delete', icon: 'remove', onChoose: () => deleteButton.click() },
    { order: 110, label: 'Rename', actionId: 'edit.rename', icon: 'text', onChoose: () => renameActiveObjectFromMenu() },
    { order: 120, label: 'Deselect', actionId: 'edit.deselect', icon: 'deselect', onChoose: () => controller.selectNode(null) },
    { order: 130, label: 'Hide', actionId: 'edit.hide', icon: 'eyeOff', onChoose: () => hideSelection() },
    { order: 140, label: 'Show all', actionId: 'edit.showAll', icon: 'eye', onChoose: () => showAllHidden() },
    { order: 150, label: 'Reset position', actionId: 'edit.resetPosition', icon: 'translate', onChoose: () => resetSelectionTransform('translation') },
    { order: 160, label: 'Reset rotation', actionId: 'edit.resetRotation', icon: 'rotate', onChoose: () => resetSelectionTransform('rotation') },
    { order: 170, label: 'Reset scale', actionId: 'edit.resetScale', icon: 'scale', onChoose: () => resetSelectionTransform('scale') },
    { order: 180, label: 'Settings…', actionId: 'settings.open', icon: 'settings', onChoose: () => settings.open() },
  ]);
  // A right click on an object, in the viewport or in the Scene list, opens the actions on that object where the
  // pointer is. The rows are the Edit menu's own, so a key learned in one place works in the other.
  const applyMenus = createApplyMenus({
    createMenuPopover,
    createMenuItem,
    controller,
    announce: message => announce(message),
    announceError: message => announceError(message),
    getMeshEditor: () => meshEditor,
    openPopoverAtMenuPoint: popover => openPopoverAt(popover, ...(lastObjectMenuPoint ?? [0, 0])),
  });
  const objectPopover = buildRegisteredMenuPopover('crucible-studio-pop-object', 'object', [
    { order: 10, label: 'Frame', actionId: 'view.frame', icon: 'frame', onChoose: () => flyToSelection() },
    { order: 20, label: 'Rename', actionId: 'edit.rename', icon: 'text', onChoose: () => renameActiveObjectFromMenu() },
    { order: 30, label: 'Duplicate', actionId: 'edit.duplicate', icon: 'duplicateObject', onChoose: () => duplicateSelection() },
    { order: 40, label: 'Hide', actionId: 'edit.hide', icon: 'eyeOff', onChoose: () => hideSelection() },
    { order: 50, label: 'Reset position', actionId: 'edit.resetPosition', icon: 'translate', onChoose: () => resetSelectionTransform('translation') },
    { order: 60, label: 'Reset rotation', actionId: 'edit.resetRotation', icon: 'rotate', onChoose: () => resetSelectionTransform('rotation') },
    { order: 70, label: 'Reset scale', actionId: 'edit.resetScale', icon: 'scale', onChoose: () => resetSelectionTransform('scale') },
    { order: 80, element: applyMenus.applyRow },
    { order: 90, element: applyMenus.originRow },
    { order: 100, label: 'Delete', actionId: 'edit.delete', icon: 'remove', onChoose: () => deleteButton.click() },
  ]);
  let lastObjectMenuPoint = null;
  function openPopoverAt(popover, clientX, clientY) {
    const windowWidth = documentReference.defaultView?.innerWidth ?? 1280;
    const windowHeight = documentReference.defaultView?.innerHeight ?? 800;
    popover.togglePopover?.(false);
    popover.style.left = `${Math.round(Math.max(8, Math.min(clientX, windowWidth - 256)))}px`;
    popover.style.right = 'auto';
    // In the lower half the menu hangs from the pointer and grows upward, so it stays on screen at any height.
    const opensUpward = clientY > windowHeight / 2;
    popover.style.top = opensUpward ? 'auto' : `${Math.round(clientY)}px`;
    popover.style.bottom = opensUpward ? `${Math.round(Math.max(8, windowHeight - clientY))}px` : 'auto';
    const opening = popoverOpeningStyle({ opensUpward });
    popover.style.setProperty('--studio-popover-origin', opening.origin);
    popover.style.setProperty('--studio-popover-shift', opening.shift);
    popover.showPopover?.();
  }
  const meshMenus = createMeshMenus({
    createMenuPopover,
    createMenuItem,
    controller,
    getCanvas: () => canvas,
    openPopoverAt,
    getMeshEditor: () => meshEditor,
    separateMeshSelection: () => separateMeshSelection(),
    onStartTool: kind => startFaceTool(kind),
    onTopologyApplied: () => {
      syncUi();
      requestFrame();
    },
  });
  // No menu while an object is in hand: a Ctrl press on a Mac is a right click, and it would open this over the move.
  function openObjectMenu(clientX, clientY) {
    if (controller.dragging || modalTransform) return;
    lastObjectMenuPoint = [clientX, clientY];
    openPopoverAt(objectPopover, clientX, clientY);
  }
  function selectedTargets() {
    return controller.selectedNodeIds.length > 0 ? controller.selectedNodeIds : (controller.selectedNodeId ? [controller.selectedNodeId] : []);
  }
  function hideSelection() {
    const targets = selectedTargets();
    if (targets.length === 0) return;
    controller.updateNodesTransform(targets, { visible: false });
    announce(`Hidden. ${keyLabel(keymap, 'edit.showAll')} shows everything again`);
  }
  function showAllHidden() {
    const hiddenNodes = controller.exportRecipe().nodes.filter(node => node.visible === false);
    if (hiddenNodes.length === 0) {
      announce('Nothing is hidden');
      return;
    }
    controller.updateNodesTransform(hiddenNodes.map(node => node.id), { visible: true });
    announce(`Showing ${hiddenNodes.length} hidden ${hiddenNodes.length === 1 ? 'object' : 'objects'}`);
  }
  function resetSelectionTransform(part) {
    const targets = selectedTargets();
    if (targets.length === 0) return;
    controller.updateNodesTransform(targets, { [part]: [...TRANSFORM_AT_REST[part]] });
    announce(`${TRANSFORM_PART_WORDS[part]} reset`);
  }
  // Shown only while a motion track drives the camera: off means the viewport looks around on its own.
  const sceneCameraToggle = lockInShot(createMenuToggle('Animated camera', '', () => {
    if (viewingShot()) return;
    if (controller.freeView) {
      controller.lookThroughSceneCamera();
      return;
    }
    const camera = controller.viewCamera;
    controller.moveViewportCamera({ eye: [...camera.eye], target: [...camera.target] });
  }, () => !controller.freeView, 'camera'));
  const viewPopover = buildRegisteredMenuPopover('crucible-studio-pop-view', 'view', [
    { order: 10, label: 'Front view', actionId: 'view.front', onChoose: () => showView('front') },
    { order: 20, label: 'Right view', actionId: 'view.right', onChoose: () => showView('right') },
    { order: 30, label: 'Top view', actionId: 'view.top', onChoose: () => showView('top') },
    { order: 40, label: 'Perspective / Orthographic', actionId: 'view.projection', icon: 'camera', onChoose: () => controller.toggleCameraProjection() },
    { order: 50, label: 'Frame the selection', actionId: 'view.frame', icon: 'frame', onChoose: () => flyToSelection() },
    { order: 60, kind: 'toggle', label: 'Grid', icon: 'grid', lockInShot: true, onChoose: () => gridButton.click(), isOn: () => gridVisible },
    { order: 70, element: sceneCameraToggle },
    { order: 80, kind: 'toggle', label: 'Scene and Properties', icon: 'panels', onChoose: () => toggleDocksButton.click(), isOn: () => root.dataset.outlinerCollapsed !== 'true' || root.dataset.inspectorCollapsed !== 'true' },
    { order: 90, kind: 'toggle', label: 'History', icon: 'history', onChoose: () => setHistoryShown(!historyShown), isOn: () => historyShown },
    ...(agentPanel ? [{ order: 100, kind: 'toggle', label: 'Agent', actionId: 'view.agent', icon: 'chat', onChoose: () => agentPanel.toggle(), isOn: () => agentPanel.shown }] : []),
    { order: 110, kind: 'toggle', label: 'Properties', actionId: 'view.properties', icon: 'settings', onChoose: () => setInspectorCollapsed(root.dataset.inspectorCollapsed !== 'true'), isOn: () => root.dataset.inspectorCollapsed !== 'true' },
  ]);
  // A row that switches something shows whether it is on each time its menu opens.
  viewPopover.addEventListener('toggle', () => {
    sceneCameraToggle.hidden = !controller.cameraDriven;
    syncMenuToggles();
  });
  syncMenuToggles();
  const helpPopover = buildRegisteredMenuPopover('crucible-studio-pop-help', 'help', [
    { order: 10, label: 'Keyboard shortcuts', actionId: 'help.shortcuts', icon: 'keyboard', onChoose: () => showShortcutsSheet(helpMenuButton) },
    { order: 20, label: 'Documentation', icon: 'book', onChoose: () => openStudioGuide({ openExternal, windowReference: documentReference.defaultView }) },
    { order: 30, label: 'Set up Studio…', icon: 'settings', onChoose: () => openSetup() },
    { order: 40, label: 'Save diagnostics report', icon: 'saveAs', onChoose: () => saveDiagnosticsReport() },
  ]);

  const newPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-new',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  });

  const addPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-add',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  });
  // A shape or light of the add menu leads with its picture; a shape without one keeps its label alone.
  const giveEntryIcon = (button, iconName) => {
    if (iconName) {
      button.prepend(createIcon(documentReference, iconName));
    }
  };
  const addPrimitiveButtonFor = primitiveType => {
    const addPrimitiveButton = createElement(documentReference, 'button', { type: 'button', textContent: primitiveLabel(primitiveType) });
    giveEntryIcon(addPrimitiveButton, STUDIO_PRIMITIVE_ICONS[primitiveType]);
    addPrimitiveButton.addEventListener('click', async () => {
      addPopover.hidePopover?.();
      try {
        await loadAgentSceneModules({ geometries: [primitiveGeometrySpec(primitiveType).geometry] });
        const created = controller.addPrimitive(primitiveType);
        announceSuccess(`Added ${created.label}`);
      } catch (error) {
        announceError(error.message);
      }
    });
    return addPrimitiveButton;
  };
  // The shapes come in groups (Mesh, Text, then Light) with a gap between them and no captions; a screen reader hears each group's name.
  const primitiveGrids = STUDIO_PRIMITIVE_GROUPS.map(group => createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-popover-grid', attributes: { role: 'group', 'aria-label': group.label } },
    ...group.primitives.map(addPrimitiveButtonFor),
  ));
  const addPointLightButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Point light' });
  const addSpotLightButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Spot light' });
  const addAreaLightButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Area light' });
  // The new light is selected, so its panel opens with it, as a new mesh's does.
  const addLightFromMenu = (lightType, countLabel) => {
    addPopover.hidePopover?.();
    try {
      const count = controller.addSceneLight(lightType);
      selectInspectorTab('look');
      announce(`${countLabel}: ${count}`);
    } catch (error) {
      announceError(error.message);
    }
  };
  giveEntryIcon(addPointLightButton, STUDIO_LIGHT_ICONS.point);
  giveEntryIcon(addSpotLightButton, STUDIO_LIGHT_ICONS.spot);
  giveEntryIcon(addAreaLightButton, STUDIO_LIGHT_ICONS.area);
  addPointLightButton.addEventListener('click', () => addLightFromMenu('point', 'Point lights'));
  addSpotLightButton.addEventListener('click', () => addLightFromMenu('spot', 'Spot lights'));
  addAreaLightButton.addEventListener('click', () => addLightFromMenu('area', 'Area lights'));
  const lightGrid = createElement(documentReference, 'div', { className: 'crucible-studio-popover-grid', attributes: { role: 'group', 'aria-label': 'Light' } }, addPointLightButton, addSpotLightButton, addAreaLightButton);
  // The tree controls of the inspector load the first time a node that grows a tree is selected, so their code stays out of the core entry.
  let treeToolsPromise = null;
  const loadTreeTools = () => {
    treeToolsPromise ??= import('./studio-trees.js');
    return treeToolsPromise;
  };
  addPopover.append(...primitiveGrids, lightGrid);

  const syncStatusNote = createElement(documentReference, 'p', {
    className: 'crucible-studio-popover-note',
    textContent: activeFilePath ? `Watching: ${activeFilePath}` : 'Save the scene to a file and the agent can edit it while you watch.',
  });
  const autoReloadButton = createElement(documentReference, 'button', {
    type: 'button',
    textContent: 'Reload when the agent edits',
    attributes: { 'aria-pressed': 'true' },
  });
  autoReloadButton.addEventListener('click', () => {
    autoReloadWatch = !autoReloadWatch;
    autoReloadButton.setAttribute('aria-pressed', autoReloadWatch ? 'true' : 'false');
    syncWatchNote();
    announce(autoReloadWatch ? 'Auto-reload enabled' : 'Auto-reload paused');
  });
  const copyPromptButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Copy a prompt for the agent' });
  function agentPromptText() {
    const target = activeFilePath ?? activeFileName;
    return `Edit Crucible scene "${target}" (format crucible.scene v1, currently at revision ${controller.scene.revision}, selected node: ${controller.selectedNodeId ?? 'none'}). Save JSON updates directly back to this path.`;
  }

  /** Copies the prompt; when the browser refuses, shows it in the recipe dialog instead. Resolves true only when it was copied. */
  async function copyAgentPrompt({ announceResult = true } = {}) {
    const promptText = agentPromptText();
    try {
      await navigator.clipboard.writeText(promptText);
      if (announceResult) {
        announceSuccess('Copied AI prompt to clipboard');
      }
      return true;
    } catch {
      openImportDialog(promptText);
      return false;
    }
  }
  copyPromptButton.addEventListener('click', () => {
    aiSyncPopover.hidePopover?.();
    copyAgentPrompt();
  });
  giveMenuIcon(autoReloadButton);
  giveMenuIcon(copyPromptButton, 'duplicate');
  const aiSyncPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-sync',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  }, syncStatusNote, autoReloadButton, copyPromptButton);

  const editJsonButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Recipe JSON' });
  giveMenuIcon(openButton, 'open');
  if (importButton) giveMenuIcon(importButton, 'add');
  giveMenuIcon(saveButton, 'save');
  giveMenuIcon(saveAsButton, 'saveAs');
  giveMenuIcon(editJsonButton, 'code');
  // The rows come in three groups, set apart by space: starting and opening, saving, then importing and exporting.
  const startMenuGroup = item => {
    item.dataset.groupStart = 'true';
    return item;
  };
  const recentChevron = createIcon(documentReference, 'chevron');
  recentChevron.dataset.recentChevron = 'true';
  const openRecentButton = giveMenuIcon(createElement(
    documentReference,
    'button',
    { type: 'button', disabled: true, dataset: { keepsMenu: 'true' }, attributes: { 'aria-expanded': 'false', 'aria-controls': 'crucible-studio-recent-list' } },
    createElement(documentReference, 'span', { textContent: 'Open recent' }),
    recentChevron,
  ), 'recent');
  const recentList = createElement(documentReference, 'div', { id: 'crucible-studio-recent-list', className: 'crucible-studio-recent-list', hidden: true, attributes: { role: 'group', 'aria-label': 'Recent scenes' } });
  const exportRows = [createMenuItem('Export…', '', () => selectWorkspace('export'), 'export')];
  const importAndExportRows = [...(importButton ? [importButton] : []), ...exportRows, editJsonButton];
  newPopover.prepend(
    createMenuItem('New scene…', '', () => openNewScene(), 'newScene'),
    openButton,
    openRecentButton,
    recentList,
    startMenuGroup(saveButton),
    saveAsButton,
    startMenuGroup(importAndExportRows[0]),
    ...importAndExportRows.slice(1),
  );
  for (const popoverElement of [newPopover, addPopover, editPopover, objectPopover, ...meshMenus.popovers, applyMenus.applyPopover, applyMenus.originPopover, viewPopover, helpPopover, snapPopover]) {
    popoverElement.addEventListener('click', event => {
      const clickedButton = event.target.closest?.('button');
      if (clickedButton && !clickedButton.dataset.keepsMenu) popoverElement.hidePopover?.();
    });
  }

  const { workspaceButtons, workspaceList } = createWorkspaceTabBar({
    documentReference,
    createElement,
    createIcon,
    wireRovingFocusFallback,
    workspaces: STUDIO_WORKSPACES,
    onSelectWorkspace: workspaceId => selectWorkspace(workspaceId),
  });

  const menubarElement = createElement(
    documentReference,
    'header',
    { className: 'crucible-studio-menubar', attributes: { 'aria-label': 'Studio' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-island' },
      createElement(
        documentReference,
        homeHref ? 'a' : 'span',
        homeHref
          ? { className: 'crucible-studio-brand', href: homeHref, attributes: { 'aria-label': 'Crucible home' } }
          : { className: 'crucible-studio-brand' },
        buildBrandMarkSvg(documentReference),
      ),
      createElement(
        documentReference,
        'nav',
        { className: 'crucible-studio-menus', attributes: { 'aria-label': 'Menus' } },
        fileMenuButton,
        editMenuButton,
        viewMenuButton,
        aiSyncMenuButton,
        helpMenuButton,
      ),
    ),
    workspaceList,
    createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
    createElement(documentReference, 'div', { className: 'crucible-studio-island' }, filePill, watchPill),
    newPopover,
    addPopover,
    aiSyncPopover,
    editPopover,
    objectPopover,
    ...meshMenus.popovers,
    applyMenus.applyPopover,
    applyMenus.originPopover,
    viewPopover,
    helpPopover,
    snapPopover,
  );

  // A hover switch is instant: the bar says so while one menu hides and the next shows, a style read makes the browser
  // settle both in that state, and the mark is gone in the same task, so no frame or throttled tab can leave it set.
  const flushStyle = element => documentReference.defaultView?.getComputedStyle?.(element)?.opacity;
  const switchMenubarMenu = (outgoingPopover, incomingPopover, showIncoming) => {
    menubarElement.dataset.switching = 'true';
    outgoingPopover.hidePopover?.();
    showIncoming();
    flushStyle(incomingPopover);
    delete menubarElement.dataset.switching;
  };
  // With one menu open, moving over the next one opens it, as a desktop menu bar does.
  const menuPairs = [[fileMenuButton, newPopover], [editMenuButton, editPopover], [viewMenuButton, viewPopover], [aiSyncMenuButton, aiSyncPopover], [helpMenuButton, helpPopover]];
  for (const [menuButton, menuPopover] of menuPairs) {
    menuButton.addEventListener('pointerenter', () => {
      const openPair = menuPairs.find(([, otherPopover]) => otherPopover !== menuPopover && otherPopover.matches?.(':popover-open'));
      if (openPair) {
        switchMenubarMenu(openPair[1], menuPopover, () => menuPopover.showPopover?.());
      }
    });
  }
  // A menu button stays marked while its menu is open, as it is under the pointer.
  for (const [menuButton, menuPopover] of menuPairs) {
    menuPopover.addEventListener('toggle', event => menuButton.setAttribute('aria-expanded', event.newState === 'open' ? 'true' : 'false'));
  }

  function bindPopoverAnchor(triggerButton, popoverElement, { beside = false, topOffset = 8 } = {}) {
    popoverElement.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const rectangle = (typeof triggerButton === 'function' ? triggerButton() : triggerButton).getBoundingClientRect();
      const viewportWidth = documentReference.defaultView?.innerWidth ?? 1280;
      const viewportHeight = documentReference.defaultView?.innerHeight ?? 800;
      const wantedLeft = beside ? rectangle.right + 16 : rectangle.left - 5;
      const wantedTop = beside ? rectangle.top - topOffset : rectangle.bottom + 14;
      const clampedLeft = Math.max(8, Math.min(wantedLeft, Math.max(8, viewportWidth - 256)));
      const clampedTop = Math.max(8, Math.min(wantedTop, Math.max(8, viewportHeight - 300)));
      // A trigger in the right half opens towards the left, so the menu never leaves the window.
      const opensLeftward = !beside && rectangle.left > viewportWidth / 2;
      popoverElement.style.left = opensLeftward ? 'auto' : `${Math.round(clampedLeft)}px`;
      popoverElement.style.right = opensLeftward ? `${Math.round(Math.max(8, viewportWidth - rectangle.right - 5))}px` : 'auto';
      // A menu beside a trigger in the lower half hangs from its foot and grows upward, so a tall menu stays on screen
      // without its height being known before it opens.
      const opensUpward = beside && rectangle.top > viewportHeight / 2;
      popoverElement.style.top = opensUpward ? 'auto' : `${Math.round(clampedTop)}px`;
      popoverElement.style.bottom = opensUpward ? `${Math.round(Math.max(8, viewportHeight - rectangle.bottom - 8))}px` : 'auto';
      const opening = popoverOpeningStyle({ beside, opensLeftward, opensUpward });
      popoverElement.style.setProperty('--studio-popover-origin', opening.origin);
      popoverElement.style.setProperty('--studio-popover-shift', opening.shift);
    });
  }
  bindPopoverAnchor(fileMenuButton, newPopover);
  bindPopoverAnchor(editMenuButton, editPopover);
  bindPopoverAnchor(viewMenuButton, viewPopover);
  bindPopoverAnchor(helpMenuButton, helpPopover);
  let addMenuAnchor = addMenuButton;
  addMenuButton.addEventListener('click', () => { addMenuAnchor = addMenuButton; });
  bindPopoverAnchor(() => addMenuAnchor, addPopover, { beside: true });
  bindPopoverAnchor(aiSyncMenuButton, aiSyncPopover);
  // The menu's top edge is the top edge of the button that opens it.
  bindPopoverAnchor(snapTargetButton, snapPopover, { beside: true, topOffset: 0 });

  // Left Outliner + Material Palette Dock
  const outlinerSearch = createElement(documentReference, 'input', { type: 'search', placeholder: 'Find an object', attributes: { 'aria-label': 'Filter the scene list' } });
  const filterRow = createElement(documentReference, 'label', { className: 'crucible-studio-filter', hidden: true }, createIcon(documentReference, 'search'), outlinerSearch);
  const filterToggleButton = createIconButton(documentReference, 'search', 'Find an object in the scene', { attributes: { 'aria-pressed': 'false', 'aria-expanded': 'false' } });
  const sceneAddButton = createIconButton(documentReference, 'add', 'Add to the scene', { attributes: { popovertarget: 'crucible-studio-pop-add' } });
  sceneAddButton.addEventListener('click', () => { addMenuAnchor = sceneAddButton; });
  const outlinerTree = createElement(documentReference, 'div', { className: 'crucible-studio-tree crucible-studio-scroll', attributes: { role: 'tree', 'aria-label': 'Scene hierarchy' } });
  const outlinerDrag = createOutlinerParentDrag({
    outlinerTree,
    controller,
    announce: message => announceSuccess(message),
    announceError: message => announceError(message),
    isEditingName: () => Boolean(activeNameEditor),
  });
  watchScrollFade(outlinerTree);
  const swatchContainer = createElement(documentReference, 'div', { className: 'crucible-studio-swatches crucible-studio-scroll' });
  const newMaterialQuickButton = createIconButton(documentReference, 'add', 'New material', { className: 'crucible-studio-swatch-add' });
  newMaterialQuickButton.addEventListener('click', () => {
    const created = controller.createMaterial({ assignToNodeIds: selectedTargets() });
    selectInspectorTab('material');
    announceSuccess(`Created ${created.id}`);
  });

  const sceneMinimizeButton = createIconButton(documentReference, 'minimize', 'Minimize Scene', { attributes: { 'aria-expanded': 'true' } });
  sceneMinimizeButton.addEventListener('click', () => setPreference('sceneMinimized', !preferences.sceneMinimized));
  const propertiesMinimizeButton = createIconButton(documentReference, 'minimize', 'Minimize Properties', { attributes: { 'aria-expanded': 'true' } });
  // With several objects selected the panels follow the active one; the head says how many there are.
  const selectionCountLabel = createElement(documentReference, 'span');
  const selectionCountElement = createElement(documentReference, 'span', { className: 'crucible-studio-selection-count', attributes: { hidden: '' } }, createIcon(documentReference, 'select'), selectionCountLabel);
  propertiesMinimizeButton.addEventListener('click', () => (agentPanel?.holdsRoom ? agentPanel.setOpenInShortWindow(false) : setPreference('propertiesMinimized', !preferences.propertiesMinimized)));

  const outlinerDock = createElement(
    documentReference,
    'aside',
    { className: 'crucible-studio-dock crucible-studio-outliner', attributes: { 'aria-label': 'Scene outliner' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-dock-head' },
      createElement(documentReference, 'span', { className: 'crucible-studio-dock-title' }, createIcon(documentReference, 'scene'), createElement(documentReference, 'span', { textContent: 'Scene' })),
      createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
      filterToggleButton,
      sceneAddButton,
      sceneMinimizeButton,
    ),
    filterRow,
    outlinerTree,
    createElement(documentReference, 'div', { className: 'crucible-studio-palette-section' }, swatchContainer, newMaterialQuickButton),
  );
  outlinerSearch.addEventListener('input', () => syncUi());
  // The filter box stays out of the way until its button is pressed; closing it clears the filter, so a closed box
  // never hides rows.
  function setFilterOpen(open) {
    filterRow.hidden = !open;
    filterToggleButton.setAttribute('aria-pressed', open ? 'true' : 'false');
    filterToggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      outlinerSearch.focus?.();
      return;
    }
    if (outlinerSearch.value !== '') {
      outlinerSearch.value = '';
      syncUi();
    }
  }
  filterToggleButton.addEventListener('click', () => setFilterOpen(filterRow.hidden));
  outlinerSearch.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setFilterOpen(false);
    filterToggleButton.focus?.();
  });

  // Center Viewport
  const viewportElement = createElement(documentReference, 'div', { className: 'crucible-studio-viewport' });
  const canvas = suppliedCanvas ?? createElement(documentReference, 'canvas', {
    className: 'crucible-studio-canvas',
    tabIndex: 0,
    attributes: { 'aria-label': '3D viewport. Click to select, drag to orbit, scroll to zoom.' },
  });
  if (!canvas.id) {
    canvas.id = `crucible-studio-canvas-${Math.random().toString(36).slice(2, 8)}`;
  }
  // Each Studio on a page gets its own filter, so two of them never share one outline region.
  const gizmoSvg = createSvgElement(documentReference, 'svg', { class: 'crucible-studio-gizmo', 'aria-hidden': 'true', 'data-silhouette-filter': `${SILHOUETTE_FILTER_ID}-${canvas.id.split('-').pop()}` });
  const maskFilterId = `${gizmoSvg.getAttribute('data-silhouette-filter')}-mask`;
  const maskFilterSvg = createMaskFilterSvg(documentReference, maskFilterId);
  const createSelectionMask = () => createOutlineMask({
    documentReference,
    className: 'crucible-studio-selection-mask',
    mount: maskCanvas => {
      maskCanvas.style.filter = `url(#${maskFilterId})`;
      gizmoSvg.before(maskCanvas);
    },
    onRestored: () => requestFrame(),
  });
  const outlineMask = createSelectionMask();
  // Over the first mask: the active object alone, when it is dense and others are selected, so its true shape gets its own width.
  const activeOutlineMask = createSelectionMask();
  const statusRegion = createElement(documentReference, 'p', { className: 'crucible-studio-status', attributes: { role: 'status' } });
  const hintBar = createElement(documentReference, 'div', { className: 'crucible-studio-hintbar' });
  const dropOverlay = createElement(documentReference, 'div', { className: 'crucible-studio-drop-overlay', textContent: canImport ? 'Drop a scene.json, GLB, HDR or image' : 'Drop a scene.json to open it' });

  // The box keeps its text through its exit so the fade has something to show; screen readers get the text at once.
  function clearStatus() {
    clearTimeout(statusExitTimer);
    statusRegion.textContent = '';
    delete statusRegion.dataset.state;
    statusRegion.removeAttribute('data-outcome');
  }

  function hideStatus() {
    statusRegion.dataset.state = 'out';
    const computedStyle = documentReference.defaultView?.getComputedStyle?.(statusRegion);
    const exitMilliseconds = longestTransitionMilliseconds(computedStyle?.transitionDuration);
    if (exitMilliseconds === 0) {
      clearStatus();
      return;
    }
    statusExitTimer = setTimeout(clearStatus, exitMilliseconds + STATUS_EXIT_SLACK_MILLISECONDS);
  }

  statusRegion.addEventListener('transitionend', event => {
    if (event.propertyName === 'opacity' && statusRegion.dataset.state === 'out') {
      clearStatus();
    }
  });

  // The outcome picks the mark the notice leads with: success, warning, error or the plain info. An error may be passed whole;
  // its text is marked selectable so a person can copy it. A quiet message is still announced to a screen reader but draws no
  // box: Export reports each save on its own result line.
  function announce(message, durationMilliseconds = STATUS_DEFAULT_MILLISECONDS, outcome = 'info', { quiet = false } = {}) {
    clearTimeout(statusTimer);
    clearTimeout(statusExitTimer);
    const isError = message instanceof Error;
    const text = isError ? message.message : message;
    if (!text) {
      clearStatus();
      return;
    }
    const shownOutcome = isError ? 'error' : outcome;
    const noticeIcon = createIcon(documentReference, STUDIO_NOTICE_ICONS[shownOutcome]);
    const noticeText = createElement(documentReference, 'span', { textContent: text });
    if (shownOutcome === 'error') noticeText.className = 'crucible-studio-selectable';
    statusRegion.replaceChildren(noticeIcon, noticeText);
    statusRegion.setAttribute('data-outcome', shownOutcome);
    if (quiet) statusRegion.setAttribute('data-quiet', 'true');
    else statusRegion.removeAttribute('data-quiet');
    statusRegion.dataset.state = 'in';
    statusTimer = setTimeout(hideStatus, durationMilliseconds);
  }

  const announceError = (message, durationMilliseconds = STATUS_DEFAULT_MILLISECONDS) => announce(message, durationMilliseconds, 'error');
  const announceSuccess = message => announce(message, STATUS_DEFAULT_MILLISECONDS, 'success');
  const announceWarning = message => announce(message, STATUS_DEFAULT_MILLISECONDS, 'warning');

  // Viewport Top-Left Toolbar (Modern Web Guidance: toolbar pattern)
  const toolLabels = { select: 'Select', translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
  const toolButtons = STUDIO_TOOLS.map(tool => createKeyedIconButton(tool, () => `${toolLabels[tool]} (${keyLabel(keymap, TOOL_ACTION_BY_TOOL[tool])})`, {
    dataset: { tool },
    attributes: { 'aria-pressed': tool === controller.tool ? 'true' : 'false' },
  }));
  toolButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (meshEditor?.active) {
        announce('Edit mode moves the selection; leave it with Tab to rotate or scale.');
        return;
      }
      controller.setTool(button.dataset.tool);
    });
  });

  const MESH_MODE_PLURALS = Object.freeze({ vertex: 'vertices', edge: 'edges', face: 'faces' });
  let shownMeshMode = null;
  const MESH_MODES = Object.freeze([
    { mode: 'vertex', icon: 'meshVertex', label: 'Vertex', action: 'mesh.vertexMode' },
    { mode: 'edge', icon: 'meshEdge', label: 'Edge', action: 'mesh.edgeMode' },
    { mode: 'face', icon: 'meshFace', label: 'Face', action: 'mesh.faceMode' },
  ]);
  const meshModeButtons = MESH_MODES.map(({ mode, icon, label, action }) => createKeyedIconButton(icon, () => `${label} ${keyLabel(keymap, action)}`, {
    dataset: { meshMode: mode },
    attributes: { 'aria-pressed': 'false' },
  }));
  meshModeButtons.forEach(button => {
    button.addEventListener('click', () => chooseMeshMode(button.dataset.meshMode));
  });
  // The object item is how edit mode ends: it is never the active one while the group is on screen.
  const meshObjectButton = createKeyedIconButton('node', () => `Object mode (${keyLabel(keymap, 'mesh.leave')})`, { dataset: { meshObject: 'true' }, attributes: { 'aria-pressed': 'false' } });
  meshObjectButton.addEventListener('click', () => leaveMeshEdit());
  // Shown only while edit mode is on, so the group itself says which mode the viewport is in.
  const meshModeGroup = createElement(documentReference, 'div', { className: 'crucible-studio-group', hidden: true, dataset: { meshGroup: 'true' }, attributes: { role: 'group', 'aria-label': 'Mesh selection' } }, meshObjectButton, ...meshModeButtons);

  // Proportional editing: the toggle and the popover that sets its curve and size. They sit in the mesh group, shown while editing; the
  // settings and the popover are made with the editor (studio-proportional.js loads on the first Tab).
  const PROPORTIONAL_POPOVER_ID = 'crucible-studio-pop-proportional';
  const proportionalButton = createKeyedIconButton('proportional', () => `Proportional editing (${keyLabel(keymap, 'mesh.proportional')})`, { dataset: { proportional: 'toggle' }, attributes: { 'aria-pressed': 'false' } });
  const proportionalMenuButton = createIconButton(documentReference, 'chevron', 'Falloff and size of proportional editing', { dataset: { proportional: 'menu' }, attributes: { popovertarget: PROPORTIONAL_POPOVER_ID } });
  proportionalButton.addEventListener('click', () => toggleProportional());
  const meshToolsButton = createIconButton(documentReference, 'more', 'Mesh tools', { dataset: { meshTools: 'true' }, attributes: { popovertarget: 'crucible-studio-pop-mesh-tools', 'aria-haspopup': 'menu' } });
  bindPopoverAnchor(meshToolsButton, meshMenus.meshToolsPopover, { beside: true });
  meshModeGroup.append(proportionalButton, proportionalMenuButton, meshToolsButton);

  const undoButton = createKeyedIconButton('undo', () => `Undo (${keyLabel(keymap, 'edit.undo')})`, { attributes: { 'aria-disabled': 'true' } });
  const redoButton = createKeyedIconButton('redo', () => `Redo (${keyLabel(keymap, 'edit.redo')})`, { attributes: { 'aria-disabled': 'true' } });
  const duplicateButton = createKeyedIconButton('duplicateObject', () => `Duplicate (${lastKeyLabel(keymap, 'edit.duplicate')})`);
  const deleteButton = createIconButton(documentReference, 'remove', 'Delete (Del)');
  const frameButton = createKeyedIconButton('frame', () => `Frame in view (${keyLabel(keymap, 'view.frame')})`);
  const toggleDocksButton = createIconButton(documentReference, 'panels', 'Show or hide the panels', { attributes: { 'aria-pressed': 'true' } });
  const gridButton = createIconButton(documentReference, 'grid', 'Show or hide the grid', { attributes: { 'aria-pressed': 'true' } });
  // View state, not an edit: it never reaches the recipe or the undo history, and every edit-mode pick and select obeys it.
  let seeThrough = false;
  const seeThroughButton = createKeyedIconButton('seeThrough', () => `See through the surface (${keyLabel(keymap, 'view.seeThrough')})`, { attributes: { 'aria-pressed': 'false' } });
  function setSeeThrough(enabled) {
    seeThrough = Boolean(enabled);
    seeThroughButton.setAttribute('aria-pressed', seeThrough ? 'true' : 'false');
    meshEditor?.setSeeThrough(seeThrough);
    requestFrame();
  }
  seeThroughButton.addEventListener('click', () => {
    if (seeThroughButton.hidden || viewingShot()) return;
    setSeeThrough(!seeThrough);
    announce(seeThrough ? 'See-through on' : 'See-through off');
  });
  gridButton.addEventListener('click', () => {
    if (viewingShot()) return;
    setPreference('gridVisible', !gridVisible);
    announce(gridVisible ? 'Grid shown' : 'Grid hidden');
  });

  undoButton.addEventListener('click', () => {
    if (undoButton.getAttribute('aria-disabled') === 'true') return;
    if (controller.undo()) announce('Undid edit');
  });
  redoButton.addEventListener('click', () => {
    if (redoButton.getAttribute('aria-disabled') === 'true') return;
    if (controller.redo()) announce('Redid edit');
  });
  duplicateButton.addEventListener('click', () => {
    if (duplicateButton.getAttribute('aria-disabled') === 'true') return;
    try {
      const cloned = controller.duplicateSelected();
      announceDuplicated(cloned);
    } catch (error) {
      announceError(error.message);
    }
  });
  deleteButton.addEventListener('click', () => {
    if (deleteButton.getAttribute('aria-disabled') === 'true') return;
    try {
      deleteSelection();
    } catch (error) {
      announceError(error.message);
    }
  });
  frameButton.addEventListener('click', () => {
    flyToSelection();
    announce('Framed selection');
  });
  toggleDocksButton.addEventListener('click', () => {
    const collapsed = root.dataset.outlinerCollapsed === 'true' && root.dataset.inspectorCollapsed === 'true';
    setOutlinerCollapsed(!collapsed);
    setInspectorCollapsed(!collapsed);
  });

  const toolGroup = createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Transform tool' } }, ...toolButtons);
  const snapGroup = createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Snapping' } }, snapToggleButton, snapTargetButton);
  const toolbarElement = createElement(
    documentReference,
    'div',
    {
      className: 'crucible-studio-toolbar crucible-studio-island',
      attributes: { role: 'toolbar', focusgroup: 'toolbar wrap', 'aria-orientation': 'vertical', 'aria-label': 'Tools', 'aria-controls': canvas.id },
    },
    toolGroup,
    snapGroup,
    meshModeGroup,
    createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Edit the scene' } }, addMenuButton, undoButton, redoButton),
    // Above the line: what changes the scene. Below it: what only shows or hides parts of Studio.
    createElement(documentReference, 'div', { className: 'crucible-studio-toolbar-rule', attributes: { role: 'separator', 'aria-orientation': 'horizontal' } }),
    createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Show or hide' } }, gridButton, seeThroughButton, toggleDocksButton),
  );
  wireRovingFocusFallback(toolbarElement, [...toolButtons, snapToggleButton, snapTargetButton, addMenuButton, undoButton, redoButton, gridButton, seeThroughButton, toggleDocksButton], { vertical: true });

  // Viewport Top-Right 3D View Widget
  const viewPresetButtons = ['front', 'right', 'top', 'isometric'].map(preset => {
    const shortLabels = { front: 'Front', right: 'Right', top: 'Top', isometric: 'Iso' };
    const button = createElement(documentReference, 'button', { type: 'button', textContent: shortLabels[preset], dataset: { view: preset } });
    button.addEventListener('click', () => {
      controller.setCameraViewPreset(preset);
      announce(`${shortLabels[preset]} view`);
    });
    return button;
  });
  const projectionPillButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Perspective', attributes: { 'aria-pressed': 'false' } });
  projectionPillButton.addEventListener('click', () => {
    const camera = controller.toggleCameraProjection();
    announce(camera.projection === 'orthographic' ? 'Orthographic view' : 'Perspective view');
  });
  const viewCubeElement = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-viewcube', attributes: { role: 'group', 'aria-label': 'Camera view presets' } },
    createElement(documentReference, 'div', { className: 'crucible-studio-viewcube-row' }, ...viewPresetButtons),
    projectionPillButton,
  );

  const viewWidget = createViewWidget(documentReference, {
    onPickView: view => {
      controller.setCameraViewPreset(view);
      announce(`${view[0].toUpperCase()}${view.slice(1)} view`);
    },
  });
  const readoutCamera = createElement(documentReference, 'span');
  const readoutSelection = createElement(documentReference, 'span', { className: 'crucible-studio-readout-selection' });
  const readout = createElement(documentReference, 'div', { className: 'crucible-studio-readout', attributes: { 'aria-hidden': 'true' } }, readoutCamera, readoutSelection);
  const agentPresence = createAgentPresence(documentReference, { controller, requestDraw: () => requestFrame(), isReducedMotion: () => motionIsReduced() });
  const pausedNotice = createPausedPictureNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
    reload: () => documentReference.defaultView?.location?.reload?.(),
  });
  const postPassPlanner = createPostPassPlanner({ loadRenderPasses: renderPassesLoader, requestFrame: () => requestFrame() });
  const postPassNotice = createPostPassNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
  });
  const bakeMark = createBakeMark({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
  });
  const draftNotice = createDraftNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
    onRestore: () => restoreDraft(),
    onDiscard: () => discardDraft(),
  });
  const numpadNotice = createNumberPadNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
    onSwitch: () => {
      numpadNotice.hide();
      setPreferences({ numberPad: true, numberPadNoticeShown: true });
      announce('View keys moved to the number pad');
    },
    onKeep: () => {
      numpadNotice.hide();
    },
  });
  const stopWatchingDiagnostics = watchStudioDiagnostics(studioDiagnostics, { windowReference: documentReference.defaultView, canvas });
  const stopWatchingContextLoss = watchContextLoss(canvas, { onLost: pauseForContextLoss, onRestored: recoverFromContextLoss });
  const exportFrameGuide = createElement(documentReference, 'div', { className: 'crucible-studio-export-guide', attributes: { 'aria-hidden': 'true' } });
  viewportElement.append(canvas, exportFrameGuide, maskFilterSvg, gizmoSvg, agentPresence.element, viewWidget.element, readout, hintBar, statusRegion, bakeMark.element, dropOverlay, pausedNotice.element, postPassNotice.element, draftNotice.element, numpadNotice.element);

  // Right Inspector Dock (Modern Web Guidance: tabs pattern)
  const inspectorTabs = registeredStudioTabs();
  const workspaces = registeredStudioWorkspaces(BASE_STUDIO_WORKSPACES);
  const tabButtons = inspectorTabs.map(tab => createIconButton(documentReference, tab.icon, tab.label, {
    id: `crucible-studio-tab-${tab.id}`,
    dataset: { tab: tab.id },
    attributes: {
      'aria-selected': tab.id === controller.activeTab ? 'true' : 'false',
      ...(tab.id === controller.activeTab ? { focusgroupstart: '' } : {}),
    },
  }));
  const tabListElement = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-tablist', attributes: { focusgroup: 'tablist nomemory', 'aria-label': 'Inspector tabs' } },
    ...tabButtons,
  );
  if (!('focusGroup' in HTMLElement.prototype)) {
    tabListElement.setAttribute('role', 'tablist');
    tabButtons.forEach(button => button.setAttribute('role', 'tab'));
  }

  // Tab 1: Object Panel
  const nodeLabelInput = createElement(documentReference, 'input', { type: 'text', placeholder: 'Node label', attributes: { 'aria-label': 'Node label' } });
  const nodeParentSelect = createElement(documentReference, 'select', { attributes: { 'aria-label': 'Parent node' } });
  const visibleToggle = createIconButton(documentReference, 'eye', 'Hide');
  const castShadowToggle = createElement(documentReference, 'button', { type: 'button', textContent: 'Casts shadow', attributes: { 'aria-pressed': 'true' } });
  const receiveShadowToggle = createElement(documentReference, 'button', { type: 'button', textContent: 'Receives shadow', attributes: { 'aria-pressed': 'true' } });

  const applyNodeTargets = patch => {
    const targets = selectedTargets();
    if (targets.length === 1) controller.updateNodeTransform(targets[0], patch);
    else if (targets.length > 1) controller.updateNodesTransform(targets, patch);
  };
  const vectorPatchFor = (values, axisIndex, { locked = false } = {}) => (
    selectedTargets().length > 1 && !locked ? values.map((component, index) => (index === axisIndex ? component : null)) : values
  );

  nodeLabelInput.addEventListener('change', () => {
    if (!controller.selectedNodeId) return;
    const checked = validateNodeLabel(nodeLabelInput.value);
    if (!checked.ok) {
      announce(checked.reason);
      nodeLabelInput.value = selectedNodeLabel();
      return;
    }
    applyNodeTargets({ label: checked.value });
  });
  nodeParentSelect.addEventListener('change', () => {
    if (!controller.selectedNodeId || nodeParentSelect.value === MIXED_SELECT_VALUE) return;
    try {
      applyNodeTargets({ parent: nodeParentSelect.value || null });
    } catch (error) {
      announceError(error.message);
      syncUi();
    }
  });
  visibleToggle.addEventListener('click', () => {
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    if (node) applyNodeTargets({ visible: !(node.visible ?? true) });
  });
  castShadowToggle.addEventListener('click', () => {
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    if (node) applyNodeTargets({ castShadow: !(node.castShadow ?? true) });
  });
  receiveShadowToggle.addEventListener('click', () => {
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    if (node) applyNodeTargets({ receiveShadow: !(node.receiveShadow ?? true) });
  });

  const positionRow = createVectorRow(documentReference, 'Position', (values, axisIndex, extra) => {
    if (controller.selectedNodeId) applyNodeTargets({ translation: vectorPatchFor(values, axisIndex, extra) });
  }, { sensitivity: 0.015, getLengthUnit: () => preferences.lengthUnit });
  const rotationRow = createVectorRow(documentReference, 'Rotation °', (values, axisIndex, extra) => {
    if (controller.selectedNodeId) applyNodeTargets({ rotationDegrees: vectorPatchFor(values, axisIndex, extra) });
  }, { sensitivity: 0.5 });
  const scaleRow = createVectorRow(documentReference, 'Scale', (values, axisIndex, extra) => {
    if (controller.selectedNodeId && values.every(component => component === null || component > 0.001)) {
      applyNodeTargets({ scale: vectorPatchFor(values, axisIndex, extra) });
    }
  }, { sensitivity: 0.01, minimumComponent: 0.02, lockToggle: true });

  // The tree rows are built the first time a node that grows a tree is selected.
  const treeSection = createElement(documentReference, 'div', { className: 'crucible-studio-tree-section' });
  let treeInspector = null;
  let treeInspectorLoading = false;
  function syncTreeInspector(selectedNode) {
    if (treeInspector) {
      treeInspector.sync(selectedNode);
      return;
    }
    if (!selectedNode?.vegetation || treeInspectorLoading) return;
    treeInspectorLoading = true;
    loadTreeTools().then(treeTools => {
      treeInspector = treeTools.createTreeInspector({ documentReference, createElement, createSliderField, controller, announce });
      treeSection.append(treeInspector.element);
      treeInspector.sync(controller.exportRecipe().nodes.find(node => node.id === controller.selectedNodeId));
    }).catch(error => announceError(error.message)).finally(() => {
      treeInspectorLoading = false;
    });
  }

  const shapeSettings = createShapeSettings({ documentReference, createElement, createPropertyLine, controller, announce: announceError });

  const nodeEmptyPrompt = createElement(documentReference, 'p', {
    className: 'crucible-studio-panel-empty',
    textContent: 'Select an object in the viewport or Scene list to edit its transform and settings.',
    hidden: true,
  });
  const nodeControls = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-controls' },
    createElement(documentReference, 'div', { className: 'crucible-studio-name-row' }, nodeLabelInput, visibleToggle, frameButton, duplicateButton, deleteButton),
    treeSection,
    shapeSettings.element,
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Parent' }), nodeParentSelect),
    positionRow.container,
    rotationRow.container,
    scaleRow.container,
    createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, castShadowToggle, receiveShadowToggle),
  );
  const nodePanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body' },
    nodeEmptyPrompt,
    nodeControls,
  );

  // Tab 2: Material Panel
  const materialSelect = createElement(documentReference, 'select', { attributes: { 'aria-label': 'Assigned material' } });
  materialSelect.addEventListener('change', () => {
    const targets = selectedTargets();
    if (targets.length > 0 && materialSelect.value && materialSelect.value !== MIXED_SELECT_VALUE) {
      try {
        if (targets.length === 1) controller.assignNodeMaterial(targets[0], materialSelect.value);
        else controller.assignNodesMaterial(targets, materialSelect.value);
      } catch (error) {
        announceError(error.message);
      }
    }
  });
  const activeMaterialIds = () => {
    const targets = new Set(selectedTargets());
    const nodes = controller.exportRecipe().nodes;
    const ids = [...new Set(nodes.filter(node => targets.has(node.id) && node.geometry !== undefined && node.material).map(node => node.material))];
    if (ids.length > 0) return ids;
    const fallback = materialSelect.value && materialSelect.value !== MIXED_SELECT_VALUE ? materialSelect.value : null;
    return fallback ? [fallback] : [];
  };
  const applyMaterialsPatch = patchOrFactory => {
    const ids = activeMaterialIds();
    if (ids.length === 0) return;
    if (ids.length === 1 && typeof patchOrFactory !== 'function') controller.updateMaterial(ids[0], patchOrFactory);
    else controller.updateMaterials(ids, patchOrFactory);
  };
  const materialPresetChips = Object.entries(STUDIO_MATERIAL_PRESETS).map(([presetKey, preset]) => {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: preset.label, dataset: { preset: presetKey } });
    button.addEventListener('click', () => {
      const ids = activeMaterialIds();
      if (ids.length > 0) {
        if (ids.length === 1) controller.applyMaterialPreset(ids[0], presetKey);
        else controller.applyMaterialsPreset(ids, presetKey);
        announce(`Applied ${preset.label} preset`);
      }
    });
    return button;
  });
  const colorInput = createElement(documentReference, 'input', { type: 'color', value: '#cccccc', attributes: { 'aria-label': 'Base color' } });
  const emissiveColorInput = createElement(documentReference, 'input', { type: 'color', value: '#000000', attributes: { 'aria-label': 'Emissive color' } });
  const colorMixedTag = createElement(documentReference, 'output', { className: 'crucible-studio-mixed-tag', hidden: true });
  const emissiveMixedTag = createElement(documentReference, 'output', { className: 'crucible-studio-mixed-tag', hidden: true });
  colorInput.addEventListener('input', () => applyMaterialsPatch({ hexColor: colorInput.value }));
  emissiveColorInput.addEventListener('input', () => applyMaterialsPatch({ emissiveHex: emissiveColorInput.value }));
  const roughnessField = createSliderField(documentReference, 'Roughness', { min: 0.02, max: 1, step: 0.02, value: 0.5 }, value => applyMaterialsPatch({ roughness: value }));
  const metallicField = createSliderField(documentReference, 'Metallic', { min: 0, max: 1, step: 0.02, value: 0 }, value => applyMaterialsPatch({ metallic: value }));
  const clearcoatField = createSliderField(documentReference, 'Clearcoat', { min: 0, max: 1, step: 0.02, value: 0 }, value => {
    applyMaterialsPatch(material => (material.clearcoatRoughness === undefined ? { clearcoat: value, clearcoatRoughness: DEFAULT_CLEARCOAT_ROUGHNESS } : { clearcoat: value }));
  });
  const clearcoatRoughnessField = createSliderField(documentReference, 'Clearcoat roughness', { min: 0, max: 1, step: 0.02, value: 0 }, value => applyMaterialsPatch({ clearcoatRoughness: value }));
  const doubleSidedToggle = createElement(documentReference, 'button', { type: 'button', textContent: 'Double sided', attributes: { 'aria-pressed': 'false' } });
  doubleSidedToggle.addEventListener('click', () => {
    const ids = activeMaterialIds();
    if (ids.length === 0) return;
    const activeNode = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    const activeId = activeNode?.material ?? ids[0];
    const material = controller.exportRecipe().materials.find(candidate => candidate.id === activeId);
    applyMaterialsPatch({ doubleSided: !(material?.doubleSided ?? false) });
  });
  const opacityField = createSliderField(documentReference, 'Opacity', { min: 0.05, max: 1, step: 0.02, value: 1 }, value => applyMaterialsPatch({ opacity: value }));
  const emissionField = createSliderField(documentReference, 'Emission', { min: 0, max: 12, step: 0.1, value: 0 }, value => applyMaterialsPatch({ emission: value }));
  const colorField = createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'div', { className: 'crucible-studio-field-head' }, createElement(documentReference, 'span', { textContent: 'Color' }), colorMixedTag), colorInput);
  const emissiveField = createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'div', { className: 'crucible-studio-field-head' }, createElement(documentReference, 'span', { textContent: 'Glow color' }), emissiveMixedTag), emissiveColorInput);
  const faceMaterialPanel = createFaceMaterialPanel({ documentReference, createElement, controller, getMeshEditor: () => meshEditor, announceError, onAssigned: () => updateMeshSelectionView() });
  const materialEmptyPrompt = createElement(documentReference, 'p', {
    className: 'crucible-studio-panel-empty',
    textContent: 'Select an object with a material, or pick a swatch in Scene.',
    hidden: true,
  });
  const materialControls = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-controls' },
    faceMaterialPanel.element,
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Material' }), materialSelect),
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Presets' }), createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, ...materialPresetChips)),
    colorField,
    roughnessField.container,
    metallicField.container,
    clearcoatField.container,
    clearcoatRoughnessField.container,
    opacityField.container,
    emissionField.container,
    emissiveField,
    createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, doubleSidedToggle),
  );
  const materialPanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body' },
    materialEmptyPrompt,
    materialControls,
  );

  // Tab 3: Look Panel
  const setupButtons = LIGHTING_SETUP_NAMES.map(setup => {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: setup, dataset: { setup }, attributes: { 'aria-pressed': 'false' } });
    button.addEventListener('click', () => controller.updateLook({ environment: { setup } }));
    return button;
  });
  // The light the selection names, or the sun when no light is selected; the camera has its own panel in the Camera tab.
  const propertyBuilders = { createElement, createIcon, createVectorRow, createSunPad };
  // Which property groups are folded is a preference of the person, kept with the others and shared by every panel.
  const propertyGroups = {
    isOpen: (groupId, openByDefault) => preferences.propertyGroupsOpen[groupId] ?? openByDefault,
    setOpen: (groupId, open) => setPreference('propertyGroupsOpen', { ...preferences.propertyGroupsOpen, [groupId]: open }),
  };
  const createLookPanel = (resolveKey, panelOptions = {}) => createPropertyPanel({ documentReference, controller, announce, builders: propertyBuilders, resolveKey, groups: propertyGroups, prepareRecipe, catalogNames: catalog.names, getLengthUnit: () => preferences.lengthUnit, ...panelOptions });
  const selectedLightKey = () => (/^(point|spot|area):/u.test(controller.selectedObjectKey ?? '') ? controller.selectedObjectKey : null);
  // Only the first group of a tab starts open, so the tab opens on one screen of rows.
  const lightPanel = createLookPanel(() => selectedLightKey() ?? 'sun', { opensFirstGroup: true });
  const worldPanel = createLookPanel(() => 'world');
  const shadowPanel = createLookPanel(() => 'shadow');
  const qualityPanel = createLookPanel(() => 'quality');
  // The world, shadow and quality groups describe the whole scene, so a selected light's panel takes the tab alone.
  const scenePanels = [worldPanel, shadowPanel, qualityPanel];
  const viewTransformSelect = createElement(
    documentReference,
    'select',
    { attributes: { 'aria-label': 'View transform' } },
    ...VIEW_TRANSFORM_NAMES.map(name => createElement(documentReference, 'option', { value: name, textContent: choiceDisplayLabel(name) })),
  );
  viewTransformSelect.addEventListener('change', async () => {
    const viewTransform = viewTransformSelect.value;
    await loadAgentSceneModules({ environment: { viewTransform } });
    controller.updateLook({ environment: { viewTransform } });
  });

  // The color look is the first row of the Film group.
  const effectsPanel = createLookPanel(() => 'effects', { leadingRows: { film: createPropertyLine(documentReference, createElement, 'Color look', viewTransformSelect) } });
  const lookPanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body crucible-studio-panel-rows' },
    createElement(documentReference, 'div', { className: 'crucible-studio-chips crucible-studio-chips-row', attributes: { role: 'group', 'aria-label': 'Lighting setup' } }, ...setupButtons),
    lightPanel.element,
    worldPanel.element,
    effectsPanel.element,
    shadowPanel.element,
    qualityPanel.element,
  );

  // Tab 4: Camera Panel
  const lensChips = STUDIO_LENS_PRESETS.map(millimetres => {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: `${millimetres} mm`, dataset: { focal: String(millimetres) }, attributes: { 'aria-pressed': 'false' } });
    button.addEventListener('click', () => controller.setCameraLensMillimetres(millimetres));
    return button;
  });
  const lensChipRow = createElement(documentReference, 'div', { className: 'crucible-studio-chips crucible-studio-chips-row', attributes: { role: 'group', 'aria-label': 'Lens presets' } }, ...lensChips);
  const cameraPanel = createLookPanel(() => 'camera', { opensFirstGroup: true, leadingRows: { lens: lensChipRow } });
  const bookmarkNameInput = createElement(documentReference, 'input', { type: 'text', placeholder: 'Shot name', attributes: { 'aria-label': 'Shot name', maxlength: '24' } });
  const saveBookmarkButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Save shot' });
  const bookmarkListElement = createElement(documentReference, 'div', { className: 'crucible-studio-bookmark-list' });
  saveBookmarkButton.addEventListener('click', async () => {
    const name = bookmarkNameInput.value.trim().replace(/\s+/g, '-') || `shot-${controller.listBookmarks().length + 1}`;
    try {
      await loadAgentSceneModules({ timeline: { shots: [] } });
      controller.saveBookmark(name);
      bookmarkNameInput.value = '';
      announceSuccess(`Saved view ${name}`);
    } catch (error) {
      announceError(error.message);
    }
  });
  const cameraPanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body crucible-studio-panel-rows' },
    viewCubeElement,
    cameraPanel.element,
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-property-section crucible-studio-shots-group' },
      createElement(documentReference, 'div', { className: 'crucible-studio-property-heading', textContent: 'Shots' }),
      createElement(documentReference, 'div', { className: 'crucible-studio-property-rows' }, createElement(documentReference, 'div', { className: 'crucible-studio-bookmark-row' }, bookmarkNameInput, saveBookmarkButton), bookmarkListElement),
    ),
  );

  // The scene a set of facts and a result line were made from: a change to the scene makes both stale.
  let exportFactsSceneKey = null;
  let exportResultSceneKey = null;
  const panelContext = {
    documentReference,
    controller,
    announce,
    announceError,
    builders: { createElement, createIcon, createIconButton, createVectorRow },
    inlinePanels: { node: nodePanelBody, material: materialPanelBody, look: lookPanelBody, camera: cameraPanelBody },
    syncLookPanels: () => syncLookPanels(),
    syncCameraPanel: () => cameraPanel.sync(),
  };
  const panelInstances = {};
  const panelsByTab = {};
  for (const tab of inspectorTabs) {
    const created = tab.createPanel(panelContext);
    const instance = created && typeof created === 'object' && 'element' in created ? created : { element: created };
    panelInstances[tab.id] = instance;
    const body = tab.bodyClassName
      ? createElement(documentReference, 'div', { className: tab.bodyClassName }, instance.element)
      : instance.element;
    const isInitial = tab.id === controller.activeTab;
    panelsByTab[tab.id] = createElement(documentReference, 'div', {
      id: `crucible-studio-panel-${tab.id}`,
      ...(isInitial ? { tabIndex: 0 } : {}),
      attributes: {
        role: 'tabpanel',
        'aria-labelledby': `crucible-studio-tab-${tab.id}`,
        ...(isInitial ? {} : { hidden: 'until-found' }),
      },
    }, body);
  }
  const exportPanel = panelInstances.export;
  if (exportPanel) {
    exportPanel.sync = () => syncExportFacts();
  }

  const workspaceTabController = createWorkspaceTabController({
    root,
    controller,
    workspaces,
    workspaceButtons,
    tabButtons,
    tabListElement,
    panelsByTab,
    outlinerDock,
    getExportPanel: () => exportPanel,
    getMeshEditor: () => meshEditor,
    leaveMeshEdit: () => leaveMeshEdit(),
    showInspectorTitle: exporting => showInspectorTitle(exporting),
    syncPropertyPanels: () => syncPropertyPanels(),
    requestFrame: () => requestFrame(),
    getToolbarControls: () => ({ toolButtons, toolGroup, snapToggleButton, snapTargetButton, snapGroup, addMenuButton, seeThroughButton, shotLockedControls, gridButton }),
    preferenceStorage,
    getFileContext: () => ({ filePath: activeFilePath, fileName: activeFileName }),
  });
  const selectInspectorTab = workspaceTabController.selectInspectorTab;
  const selectWorkspace = workspaceTabController.selectWorkspace;
  const persistCurrentWorkspaceTab = workspaceTabController.persistCurrent;
  const restoreSavedWorkspaceTab = workspaceTabController.restoreForFile;
  tabButtons.forEach(button => {
    button.addEventListener('click', () => selectInspectorTab(button.dataset.tab));
  });
  for (const [tab, panel] of Object.entries(panelsByTab)) {
    panel.addEventListener('beforematch', () => selectInspectorTab(tab));
  }
  wireRovingFocusFallback(tabListElement, tabButtons, {
    followFocus: true,
    onSelect: button => selectInspectorTab(button.dataset.tab),
  });

  const inspectorTitle = createElement(documentReference, 'span', { className: 'crucible-studio-dock-title' });
  function showInspectorTitle(exporting) {
    inspectorTitle.replaceChildren(createIcon(documentReference, exporting ? 'export' : 'settings'), createElement(documentReference, 'span', { textContent: exporting ? 'Export' : 'Properties' }));
  }
  showInspectorTitle(false);
  const panelsElement = createElement(documentReference, 'div', { className: 'crucible-studio-panels crucible-studio-scroll' }, ...inspectorTabs.map(tab => panelsByTab[tab.id]));
  watchScrollFade(panelsElement);
  const inspectorElement = createElement(
    documentReference,
    'aside',
    { className: 'crucible-studio-dock crucible-studio-inspector', attributes: { 'aria-label': 'Scene inspector' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-dock-head' },
      inspectorTitle,
      selectionCountElement,
      createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
      propertiesMinimizeButton,
    ),
    tabListElement,
    panelsElement,
  );

  // The History panel: the edits in the order they were made, oldest at the top, so a recording reads downward. The row of the
  // edit the scene shows is filled and strong; the edits after it (undone, still redoable) are dimmed and stay clickable.
  const historyMinimizeButton = createIconButton(documentReference, 'minimize', 'Minimize History', { attributes: { 'aria-expanded': 'true' } });
  historyMinimizeButton.addEventListener('click', () => setPreference('historyMinimized', !preferences.historyMinimized));
  const historyList = createElement(documentReference, 'div', { className: 'crucible-studio-history-list crucible-studio-scroll', attributes: { role: 'list', 'aria-label': 'Edits' } });
  watchScrollFade(historyList);
  const historyDock = createElement(
    documentReference,
    'aside',
    { className: 'crucible-studio-dock crucible-studio-history', attributes: { 'aria-label': 'History' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-dock-head' },
      createElement(documentReference, 'span', { className: 'crucible-studio-dock-title' }, createIcon(documentReference, 'history'), createElement(documentReference, 'span', { textContent: 'History' })),
      createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
      historyMinimizeButton,
    ),
    historyList,
  );
  const historyRowButtons = () => Array.from(historyList.children);
  const currentHistoryRow = () => historyRowButtons().find(row => row.getAttribute('aria-current') === 'step');

  function createHistoryRow({ name, detail, position, state }) {
    const row = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-history-row',
      dataset: { label: name, state, position: String(position) },
      tabIndex: state === 'current' ? 0 : -1,
      attributes: { role: 'listitem', ...(state === 'current' ? { 'aria-current': 'step' } : {}), ...(state === 'undone' ? { 'aria-description': 'Undone' } : {}) },
    },
    createElement(documentReference, 'span', { className: 'crucible-studio-history-mark', attributes: { 'aria-hidden': 'true' } }),
    createIcon(documentReference, name === 'Start' ? 'history' : editIconName(name)),
    createElement(documentReference, 'span', { className: 'crucible-studio-history-name', textContent: name }));
    if (detail) {
      row.append(createElement(documentReference, 'span', { className: 'crucible-studio-history-detail', textContent: detail }));
    }
    row.title = detail ? `${name}  ${detail}` : name;
    row.addEventListener('click', () => {
      controller.goToHistoryPosition(position);
      syncHistoryPanel();
      currentHistoryRow()?.focus?.({ preventScroll: true });
      revealHistoryRow(historyRowButtons().indexOf(currentHistoryRow()));
      announce(position === 0 ? 'Back to the start' : `Went to ${name}`);
    });
    return row;
  }

  function syncHistoryPanel() {
    if (!historyShown) return;
    const { labels, details, position, reachesStart } = controller.history;
    const renderKey = JSON.stringify([position, labels, details, reachesStart]);
    if (renderKey === renderedHistoryKey) return;
    renderedHistoryKey = renderKey;
    const stateOf = editPosition => (editPosition === position ? 'current' : editPosition < position ? 'done' : 'undone');
    const rows = [];
    if (reachesStart) {
      rows.push({ name: 'Start', detail: '', position: 0, state: stateOf(0) });
    }
    labels.forEach((name, index) => rows.push({ name, detail: details[index], position: index + 1, state: stateOf(index + 1) }));
    const hadFocus = historyList.contains(documentReference.activeElement);
    historyList.replaceChildren(...rows.map(createHistoryRow));
    fitHistoryListToWholeRows();
    const current = currentHistoryRow();
    revealHistoryRow(historyRowButtons().indexOf(current), { preferLast: true });
    if (hadFocus) current?.focus?.({ preventScroll: true });
  }

  // The list is as tall as a whole number of rows and scrolls a whole row at a time, so no row is ever cut in half. It shows at
  // most six rows, and at most a third of the column, so Properties keeps the rest; a compact window shows four.
  const HISTORY_MOST_ROWS = 6;
  const HISTORY_COMPACT_ROWS = 4;
  function historyRowMetrics() {
    const firstRow = historyList.firstElementChild;
    const rowHeight = firstRow?.getBoundingClientRect().height ?? 0;
    if (!(rowHeight > 0)) return null;
    const style = documentReference.defaultView.getComputedStyle(historyList);
    const gap = parseFloat(style.rowGap) || 0;
    return { gap, padding: parseFloat(style.paddingTop) || 0, pitch: rowHeight + gap };
  }
  function fitHistoryListToWholeRows() {
    const metrics = historyRowMetrics();
    if (!metrics) {
      historyList.style.maxBlockSize = '';
      return;
    }
    const { gap, padding, pitch } = metrics;
    let rows = HISTORY_MOST_ROWS;
    if (root.dataset.compact === 'true') {
      rows = HISTORY_COMPACT_ROWS;
    } else {
      const columnStyle = documentReference.defaultView.getComputedStyle(sideColumn);
      const columnHeight = sideColumn.getBoundingClientRect().height - (parseFloat(columnStyle.paddingTop) || 0) - (parseFloat(columnStyle.paddingBottom) || 0);
      const headHeight = historyDock.querySelector('.crucible-studio-dock-head').getBoundingClientRect().height;
      const borders = 2;
      // A third of the column at most, and what is left after the Scene card (30% at most) and the 240 px Properties keeps.
      const sceneHeight = Math.min(outlinerDock.getBoundingClientRect().height, columnHeight * 0.3);
      const propertiesHeight = root.dataset.inspectorCollapsed === 'true' ? 0 : root.dataset.inspectorMinimized === 'true' ? inspectorElement.getBoundingClientRect().height : 240;
      const cardGaps = (parseFloat(columnStyle.rowGap) || 0) * 2;
      const cardRoom = Math.min(columnHeight / 3, columnHeight - sceneHeight - propertiesHeight - cardGaps);
      const room = cardRoom - headHeight - borders - padding * 2;
      rows = Math.max(1, Math.min(rows, Math.floor((room + gap) / pitch)));
    }
    historyList.style.maxBlockSize = `${rows * pitch - gap + padding * 2}px`;
  }
  // The room changed (a resize, a card minimized): cut the list to whole rows again and keep the current row in view.
  function refitHistoryList() {
    fitHistoryListToWholeRows();
    revealHistoryRow(historyRowButtons().indexOf(currentHistoryRow()), { preferLast: true });
  }
  // Scrolls to a row boundary that keeps the row at `index` in view: the newest rows when `preferLast` and the current row fits with them.
  function revealHistoryRow(index, { preferLast = false } = {}) {
    const metrics = historyRowMetrics();
    if (!metrics || index < 0) return;
    const { gap, padding, pitch } = metrics;
    const visibleRows = Math.max(1, Math.round((historyList.clientHeight - padding * 2 + gap) / pitch));
    let firstVisible = Math.round(historyList.scrollTop / pitch);
    if (preferLast) firstVisible = Math.max(0, historyRowButtons().length - visibleRows);
    if (index < firstVisible) firstVisible = index;
    if (index > firstVisible + visibleRows - 1) firstVisible = index - visibleRows + 1;
    historyList.scrollTop = firstVisible * pitch;
  }

  // Up and Down move between rows, Home and End go to the ends; Enter and Space press the focused row like any button.
  historyList.addEventListener('keydown', event => {
    const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
    const rows = historyRowButtons();
    const index = rows.indexOf(documentReference.activeElement);
    let target = null;
    if (step !== undefined && index >= 0) target = rows[Math.max(0, Math.min(rows.length - 1, index + step))];
    if (event.key === 'Home') target = rows[0];
    if (event.key === 'End') target = rows[rows.length - 1];
    if (!target) return;
    event.preventDefault();
    for (const row of rows) row.tabIndex = row === target ? 0 : -1;
    target.focus?.({ preventScroll: true });
    revealHistoryRow(rows.indexOf(target));
  });

  // Showing is remembered with the other view preferences. In a compact window the panel starts closed like the others.
  function setHistoryShown(shown, { remember = true } = {}) {
    historyShown = shown;
    root.dataset.historyCollapsed = shown ? 'false' : 'true';
    renderedHistoryKey = '';
    // In a compact window the two cards would cover each other, so showing one puts the other away; the panels button or
    // View > Properties brings Properties back and puts History away.
    if (shown && root.dataset.compact === 'true') setInspectorCollapsed(true);
    if (shown && agentPanel?.takesTurns) agentPanel.setShown(false, { remember: false });
    if (remember) setPreference('historyVisible', shown);
    syncHistoryPanel();
    syncMenuToggles();
  }
  function showHistoryPanel() {
    setHistoryShown(true);
    currentHistoryRow()?.focus?.();
  }
  root.dataset.historyCollapsed = 'true';

  // Bottom Timeline & Telemetry Bar
  const playTooltip = isPlaying => `${isPlaying ? 'Pause' : 'Play'} (${keyLabel(keymap, 'animate.play')})`;
  const playButton = createIconButton(documentReference, 'play', playTooltip(false), { attributes: { 'aria-pressed': 'false' } });
  const keyframeButton = createKeyedIconButton('keyframe', () => `Add a keyframe here (${lastKeyLabel(keymap, 'animate.keyframe')})`);
  const autoKeyButton = createIconButton(documentReference, 'autoKey', 'Auto-key', { attributes: { 'aria-pressed': controller.autoKey ? 'true' : 'false' } });
  const timeOutput = createElement(documentReference, 'output', { textContent: '0.00 s' });
  const scrubInput = createElement(documentReference, 'input', { type: 'range', min: '0', max: '4', step: '0.02', value: '0', attributes: { 'aria-label': 'Timeline scrub' } });
  const keysElement = createElement(documentReference, 'div', { className: 'crucible-studio-keys' });
  const trackElement = createElement(documentReference, 'div', { className: 'crucible-studio-track' }, scrubInput, keysElement);
  const quickBookmarksRow = createElement(documentReference, 'div', { className: 'crucible-studio-shots' });
  const fileInput = createElement(documentReference, 'input', { type: 'file', accept: '.json,application/json', hidden: true });
  const importInput = createElement(documentReference, 'input', { type: 'file', accept: '.glb,.hdr,.png,.jpg,.jpeg,.webp', hidden: true });

  playButton.addEventListener('click', () => {
    if (!hasAnimatedData(controller.exportRecipe())) {
      announceWarning(`Add a keyframe first (${lastKeyLabel(keymap, 'animate.keyframe')})`);
      return;
    }
    selectWorkspace('animate');
    playing = !playing;
    lastFrameTime = 0;
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    setButtonIcon(playButton, playing ? 'pause' : 'play', playTooltip(playing));
    if (playing) requestFrame();
  });
  keyframeButton.addEventListener('click', async () => {
    selectWorkspace('animate');
    try {
      await loadAgentSceneModules({ motion: { duration: 1, tracks: [] } });
      controller.insertNodeKeyframe();
      announce(`Keyframed at ${controller.motionTime.toFixed(2)} s`);
    } catch (error) {
      announceError(error.message);
    }
  });
  autoKeyButton.addEventListener('click', () => controller.setAutoKey(!controller.autoKey));
  scrubInput.addEventListener('input', () => {
    const seconds = Number(scrubInput.value);
    if (hasAnimatedData(controller.exportRecipe())) {
      controller.setMotionTime(seconds);
    }
  });
  const keyMarkers = createKeyMarkers({
    documentReference,
    controller,
    keysElement,
    trackElement,
    announce,
    isDeleteKey: event => findKeymapAction(keymap, event, 'normal')?.actionId === 'edit.delete',
    fallbackFocus: keyframeButton,
  });

  const bottomElement = createElement(
    documentReference,
    'footer',
    { className: 'crucible-studio-bottombar crucible-studio-island', attributes: { 'aria-label': 'Timeline' } },
    createElement(documentReference, 'div', { className: 'crucible-studio-scrub' }, playButton, keyframeButton, autoKeyButton, trackElement, timeOutput),
    quickBookmarksRow,
  );

  // Native Dialogs (Modern Web Guidance: native <dialog>, aria-labelledby, form method="dialog", returnValue reset)
  const dialogHeading = createElement(documentReference, 'h2', { id: 'crucible-studio-json-title', textContent: 'Recipe JSON' });
  dialogHeading.prepend(createIcon(documentReference, 'code'));
  const dialogTextarea = createElement(documentReference, 'textarea', { rows: 14, autofocus: true, attributes: { 'aria-label': 'Scene recipe JSON' } });
  const dialogFileButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Load file…' });
  const dialogCloseButton = createElement(documentReference, 'button', { type: 'submit', value: 'close', textContent: 'Close' });
  const dialogApplyButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-primary-btn', textContent: 'Apply JSON' });
  leadWithActionIcon(dialogFileButton, createIcon(documentReference, STUDIO_ACTION_ICONS.loadFile), STUDIO_ACTION_ICONS.loadFile);
  leadWithActionIcon(dialogApplyButton, createIcon(documentReference, STUDIO_ACTION_ICONS.applyJson), STUDIO_ACTION_ICONS.applyJson);
  const recipeDialog = createElement(
    documentReference,
    'dialog',
    { attributes: { 'aria-labelledby': 'crucible-studio-json-title', closedby: 'any' } },
    dialogHeading,
    dialogTextarea,
    createElement(documentReference, 'form', { method: 'dialog', className: 'crucible-studio-dialog-actions' }, dialogFileButton, dialogCloseButton, dialogApplyButton),
  );
  recipeDialog.addEventListener('close', () => {
    recipeDialog.returnValue = '';
  });

  function openImportDialog(initialText = '') {
    dialogTextarea.value = initialText || JSON.stringify(controller.exportRecipe(), null, 2);
    recipeDialog.showModal();
  }

  dialogFileButton.addEventListener('click', () => {
    recipeDialog.close('file');
    fileInput.click();
  });
  dialogApplyButton.addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(dialogTextarea.value);
      await prepareRecipe(parsed);
      controller.loadRecipe(parsed);
      // Apply is one undo step and asks nothing, but the scene now differs from its file, so it counts as changed.
      isDirty = true;
      syncFileBanner();
      recipeDialog.close('apply');
      announceSuccess('Recipe applied');
    } catch (error) {
      announceError(error.message);
    }
  });

  const shortcutsHeading = createElement(documentReference, 'h2', { id: 'crucible-studio-shortcuts-title', textContent: 'Studio keyboard shortcuts' });
  shortcutsHeading.prepend(createIcon(documentReference, 'keyboard'));
  const shortcutsCloseButton = createIconButton(documentReference, 'close', 'Close the shortcuts');
  const shortcutsGrid = createElement(documentReference, 'div', { className: 'crucible-studio-shortcuts crucible-studio-fade-scroll' });
  // One block per area, each with its icon and a row for every key of the active keymap, in two columns of about equal height.
  const createShortcutGroup = group => createElement(
    documentReference,
    'section',
    { className: 'crucible-studio-shortcut-group', dataset: { group: group.title } },
    createElement(documentReference, 'h3', {}, createIcon(documentReference, group.icon), createElement(documentReference, 'span', { textContent: group.title })),
    ...group.rows.map(({ keys, label }) => createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-shortcut-item' },
      createElement(documentReference, 'span', { textContent: label }),
      createElement(documentReference, 'span', { className: 'crucible-studio-shortcut-keys', textContent: keys }),
    )),
  );
  function fillShortcutsGrid() {
    const columnCount = sheetColumnCount(documentReference.defaultView?.innerWidth ?? 1280);
    shortcutsDialog.dataset.columns = String(columnCount);
    const columns = balanceSheetColumns(shortcutSheetGroups(keymap, { omittedActionIds: agentPanel ? [] : ['view.agent'] }), columnCount);
    shortcutsGrid.replaceChildren(...columns.map(columnGroups => createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-shortcut-column' },
      ...columnGroups.map(createShortcutGroup),
    )));
  }
  const shortcutsDialog = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-shortcuts-dialog', attributes: { 'aria-labelledby': 'crucible-studio-shortcuts-title', closedby: 'any' } },
    createElement(documentReference, 'div', { className: 'crucible-studio-shortcuts-head' }, shortcutsHeading, shortcutsCloseButton),
    shortcutsGrid,
  );
  fillShortcutsGrid();
  const syncShortcutsFade = watchScrollFades(shortcutsGrid);
  shortcutsCloseButton.addEventListener('click', () => shortcutsDialog.close());
  // The sheet opened from the Help menu gives the focus back to that button when it closes.
  let shortcutsFocusTarget = null;
  function showShortcutsSheet(returnFocusTo = null) {
    shortcutsFocusTarget = returnFocusTo;
    fillShortcutsGrid();
    shortcutsDialog.showModal();
    syncShortcutsFade();
  }
  shortcutsDialog.addEventListener('close', () => {
    shortcutsDialog.returnValue = '';
    shortcutsFocusTarget?.focus?.();
    shortcutsFocusTarget = null;
  });

  const settings = createStudioSettings({
    documentReference,
    createElement,
    createIcon,
    shell: globalThis.crucibleShell,
    onChange: (name, value) => setPreference(name, value),
    onReset: () => {
      const previousLengthUnit = preferences.lengthUnit;
      preferences = normalizeStudioPreferences({ setupDone: preferences.setupDone });
      storePreferences();
      applyPreferences();
      if (preferences.lengthUnit !== previousLengthUnit) {
        refreshLengthUnits();
      }
      announce('Settings reset');
    },
    onRunSetup: () => {
      settings.dialog.close();
      openSetup();
    },
    onOpenShortcuts: () => {
      settings.dialog.close();
      shortcutsDialog.showModal();
    },
    keyboard: {
      getKeymap: () => keymap,
      getPresetId: () => preferences.keymap,
      getNumberPad: () => preferences.numberPad,
      getOverrides: () => preferences.keyOverrides[preferences.keymap] ?? {},
      onOverridesChange: presetOverrides => setPreference('keyOverrides', withPresetOverrides(preferences.keyOverrides, preferences.keymap, presetOverrides)),
    },
  });
  const settingsDialog = settings.dialog;

  const setup = createStudioSetup({
    documentReference,
    createElement,
    createIcon,
    readPreferences: () => preferences,
    changePreferences: changes => setPreferences(changes),
    describeHardware: detectedHardware,
    viewportSettingsForTier,
    agentPromptText,
    copyAgentPrompt,
    // A host page (the desktop app) may offer its own built-in agent; the setup's AI agent step then offers its sign-in.
    builtInAgent: globalThis.crucibleShell?.builtInAgent,
    account: globalThis.crucibleShell?.account,
    onClose: () => {
      if (!preferences.setupDone) setPreference('setupDone', true);
    },
  });
  function openSetup() {
    setup.open();
  }

  function storePreferences() {
    if (preferenceStorage) {
      saveStudioPreferences(preferenceStorage, preferences);
    }
  }

  // Puts the preferences into effect and shows them in the Settings dialog.
  function applyPreferences() {
    if (keymapSignature() !== appliedKeymap) {
      appliedKeymap = keymapSignature();
      keymap = keymapOf();
      refreshKeyLabels();
    }
    settings.refreshKeyboard();
    controller.setInteractionSettings({
      moveSnapStep: preferences.moveSnapStep,
      rotateSnapDegrees: preferences.rotateSnapDegrees,
      gizmoPixels: STUDIO_GIZMO_PIXELS[preferences.gizmoSize],
      snapEnabled: preferences.snapEnabled,
      snapTarget: preferences.snapTarget,
      lengthUnit: preferences.lengthUnit,
    });
    syncSnapUi();
    applyTheme();
    applyPerformance();
    if (preferences.numberPad) numpadNotice.hide();
    if (setup.dialog.open) setup.refresh();
    root.dataset.motion = preferences.motion;
    root.dataset.readout = preferences.readoutVisible ? 'on' : 'off';
    root.dataset.viewWidget = preferences.viewWidgetVisible ? 'on' : 'off';
    // Floating panels lie over a scene that fills the window. Docked ones take the window's edges and the viewport
    // is the room they leave, measured again on the next frame, so the scene keeps its proportions.
    root.dataset.floating = preferences.panelsFloating ? 'true' : 'false';
    if (!preferences.agentCursorVisible) {
      agentPresence.hide();
    }
    setGridVisible(preferences.gridVisible);
    showPanelSizes(preferences);
    showPanelMinimized(sceneMinimizeButton, 'outlinerMinimized', 'Scene', preferences.sceneMinimized);
    showPanelMinimized(propertiesMinimizeButton, 'inspectorMinimized', 'Properties', preferences.propertiesMinimized || Boolean(agentPanel?.holdsRoom));
    showPanelMinimized(historyMinimizeButton, 'historyMinimized', 'History', preferences.historyMinimized);
    refitHistoryList();
    agentPanel?.syncCard();
    for (const [name, control] of settings.controls) {
      if (STUDIO_PREFERENCE_CHOICES[name]) control.value = String(preferences[name]);
      else control.checked = preferences[name];
    }
  }

  // Every place that names a key, written again for the keymap now in force: menu rows, tooltips, the shortcuts dialog and the hint bar.
  function refreshKeyLabels() {
    for (const { element, actionId } of menuKeyViews) setShortcutLabel(element, keyLabel(keymap, actionId));
    for (const { button, iconName, describe } of keyTooltipViews) setButtonIcon(button, iconName, describe());
    const viewTitles = { front: ['Front view', 'view.front'], right: ['Right view', 'view.right'], top: ['Top view', 'view.top'], isometric: ['Isometric view', null] };
    for (const button of viewPresetButtons) {
      const [labelText, actionId] = viewTitles[button.dataset.view];
      const shortcut = actionId ? keyLabel(keymap, actionId) : '';
      button.title = shortcut ? `${labelText} (${shortcut})` : labelText;
    }
    const projectionShortcut = keyLabel(keymap, 'view.projection');
    projectionPillButton.title = projectionShortcut ? `Perspective / Orthographic (${projectionShortcut})` : 'Perspective / Orthographic';
    setButtonIcon(playButton, playing ? 'pause' : 'play', playTooltip(playing));
    fillShortcutsGrid();
    syncHintBar();
  }

  // A forced theme is a data-theme on the root, which the tokens and the dialogs inside it follow. System leaves it off,
  // so the page's own colour scheme decides, as it always did.
  let appliedTheme = null;
  function resolvedTheme() {
    if (preferences.theme !== 'system') return preferences.theme;
    const systemIsDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return systemIsDark ? 'dark' : 'light';
  }
  function applyTheme() {
    if (preferences.theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = preferences.theme;
    }
    if (preferences.theme !== appliedTheme) {
      appliedTheme = preferences.theme;
      onThemeChange?.(resolvedTheme());
    }
  }
  // While the preference is System the page's colour scheme decides, so a flip of the operating system's scheme is
  // reported to the host the same way a change of the preference is. A forced theme ignores the system.
  const systemSchemeQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function onSystemSchemeChange() {
    if (preferences.theme === 'system') {
      onThemeChange?.(resolvedTheme());
    }
  }
  systemSchemeQuery?.addEventListener?.('change', onSystemSchemeChange);

  // What the browser says about this computer, read once. A live renderer's context is asked first so no second
  // WebGL context is made; otherwise a short-lived one is.
  let detectedHardwareResult = null;
  function detectedHardware() {
    if (detectedHardwareResult) return detectedHardwareResult;
    let glContext = renderer?.context ?? null;
    let probeCanvas = null;
    if (!glContext) {
      probeCanvas = documentReference.createElement('canvas');
      glContext = typeof probeCanvas.getContext === 'function' ? probeCanvas.getContext('webgl2') ?? probeCanvas.getContext('webgl') : null;
    }
    detectedHardwareResult = detectStudioHardware(gatherStudioHardwareInputs({ glContext, windowReference: documentReference.defaultView ?? window }));
    if (probeCanvas) glContext?.getExtension?.('WEBGL_lose_context')?.loseContext();
    return detectedHardwareResult;
  }

  // What the viewport draws with on this screen for a tier. Only the viewport changes: the scene recipe never hears of it.
  // A `pixelRatio` or `samples` in rendererOptions wins over the tier.
  function viewportSettingsForTier(tier) {
    const settings = studioViewportSettingsFor(tier, window.devicePixelRatio);
    return { pixelRatio: rendererOptions.pixelRatio ?? settings.pixelRatio, samples: rendererOptions.samples ?? settings.samples };
  }

  function chosenTier() {
    const detectedTier = preferences.performance === 'automatic' ? detectedHardware().tier : null;
    return resolveStudioPerformanceTier(preferences.performance, detectedTier);
  }

  // A new pixel ratio is set on the live renderer. A new sample count is fixed when a renderer is built, so the renderer
  // is dropped and ensureRenderer makes the next one, as it does when a scene first needs depth.
  let rendererSamples = null;
  function applyPerformance() {
    if (!renderer || !Number.isFinite(renderer.pixelRatio)) return;
    const wanted = viewportSettingsForTier(chosenTier());
    const current = { pixelRatio: renderer.pixelRatio, samples: suppliedRenderer ? wanted.samples : rendererSamples };
    const change = rendererChangeFor(current, wanted);
    if (change === 'recreate') {
      renderer.dispose();
      renderer = null;
      requestFrame();
    } else if (change === 'resize') {
      renderer.pixelRatio = wanted.pixelRatio;
      renderer.resize();
    }
  }

  function refreshLengthUnits() {
    selectionReadoutStale = true;
    syncUi();
    cameraPanel.sync();
    syncLookPanels();
    syncViewportAids();
    syncHintBar();
  }

  // Saves several preferences as one change, so a drag that resizes two cards is one write.
  function setPreferences(changes) {
    for (const name of Object.keys(changes)) {
      if (!(name in STUDIO_PREFERENCE_DEFAULTS)) {
        throw new RangeError(`Unknown Studio preference "${String(name)}". Use one of ${Object.keys(STUDIO_PREFERENCE_DEFAULTS).join(', ')}.`);
      }
    }
    const previousLengthUnit = preferences.lengthUnit;
    preferences = normalizeStudioPreferences({ ...preferences, ...changes });
    storePreferences();
    applyPreferences();
    if (preferences.lengthUnit !== previousLengthUnit) {
      refreshLengthUnits();
    }
  }

  function setPreference(name, value) {
    setPreferences({ [name]: value });
    return preferences[name];
  }

  workspaceTabController.initialize(preferences.startWorkspace);
  // The panel column and its grips live in their own module; Studio gives it the saved preferences and a way to save changes.
  const { sideColumn, showPanelSizes } = createPanelGrips({
    documentReference,
    createElement,
    root,
    outlinerDock,
    inspectorElement,
    agentDock: agentPanel?.dock,
    readPreferences: () => preferences,
    changePreferences: setPreferences,
  });

  function showPanelMinimized(button, datasetName, panelName, minimized) {
    root.dataset[datasetName] = minimized ? 'true' : 'false';
    setButtonIcon(button, minimized ? 'expand' : 'minimize', minimized ? `Expand ${panelName}` : `Minimize ${panelName}`);
    button.setAttribute('aria-expanded', minimized ? 'false' : 'true');
  }

  sideColumn.append(historyDock);
  setHistoryShown(preferences.historyVisible, { remember: false });
  agentPanel?.mount(sideColumn);
  applyPreferences();
  root.append(viewportElement, menubarElement, toolbarElement, sideColumn, bottomElement, fileInput, importInput, recipeDialog, shortcutsDialog, settingsDialog, setup.dialog);
  container.append(root);

  function syncWatchNote() {
    syncStatusNote.textContent = activeFilePath
      ? `Watching ${activeFilePath} (${autoReloadWatch ? 'auto-reload on' : 'paused'}).`
      : 'Save the scene to a file and the agent can edit it while you watch.';
  }

  // The name shrinks with an ellipsis at its end; the type after it never does, so a long name still shows what kind of file it is.
  function renderFilePillName() {
    const { stem, suffix } = splitFileName(activeFileName, activeFileSuffix);
    filePill.replaceChildren(
      createElement(documentReference, 'span', { className: 'crucible-studio-filepill-name', textContent: stem }),
      createElement(documentReference, 'span', { className: 'crucible-studio-filepill-suffix', textContent: suffix }),
    );
  }

  function syncFileBanner() {
    renderFilePillName();
    filePill.dataset.dirty = isDirty ? 'true' : 'false';
    filePill.title = activeFilePath ?? activeFileName;
    watchPill.hidden = !activeFilePath;
    syncWatchNote();
    if (onDirtyChange) {
      onDirtyChange({ filePath: activeFilePath, fileName: activeFileName, dirty: isDirty });
    }
  }

  function triggerBlobDownload(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = createElement(documentReference, 'a', { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveDiagnosticsReport() {
    const reportText = `${JSON.stringify(studioDiagnostics.report(), null, 2)}
`;
    triggerBlobDownload(reportText, 'crucible-studio-diagnostics.json', 'application/json');
    announceSuccess('Saved the diagnostics report');
  }

  // The still is the scene's own shot without the editor's aids. The Export workspace draws the viewport the same way, so what it shows is what gets saved.
  function drawingTheShot() {
    return capturingStill || viewingShot();
  }

  function capturePngDataUrl() {
    // Nothing draws while the context is gone, so a still taken then would be a blank picture.
    if (contextLost) throw new Error(CONTEXT_LOST_MESSAGE);
    // A still has the light and flush ranks a fresh build has, so any pending bake or flush finishes first.
    controller.settleBake();
    controller.scene.settleFlush?.();
    bakeMark.show(controller.bakePending);
    capturingStill = true;
    try {
      renderPass();
      return canvas.toDataURL('image/png');
    } finally {
      capturingStill = false;
      requestFrame();
    }
  }

  function setGridVisible(visible) {
    const changed = gridVisible !== Boolean(visible);
    gridVisible = Boolean(visible);
    gridButton.setAttribute('aria-pressed', gridVisible ? 'true' : 'false');
    if (changed) {
      requestFrame();
    }
  }

  // Measured only after a change: the bounds walk every vertex of the selection.
  function describeSelection() {
    const described = describeSelectedObject();
    return described !== '' && meshEditor?.active ? `Edit ${MESH_MODE_PLURALS[meshEditor.mode]}, ${described}` : described;
  }

  function describeSelectedObject() {
    const selectedId = controller.selectedNodeId;
    const bounds = selectedId ? controller.nodeBounds(selectedId) : null;
    if (!bounds) {
      return '';
    }
    const selectedNode = controller.exportRecipe().nodes.find(node => node.id === selectedId);
    return `${selectedNode?.label ?? selectedId} | ${describeBounds(bounds, preferences.lengthUnit)}`;
  }

  function syncViewportAids() {
    const camera = controller.viewCamera;
    viewWidget.update(camera);
    const gridStep = gridLayout({ visibleHeight: cameraVisibleHeight(camera), viewportHeight: controller.viewportHeight, target: camera.target, eye: camera.projection === 'orthographic' ? undefined : camera.eye }).step;
    readoutCamera.textContent = gridVisible ? `${describeCamera(camera)} | Grid ${describeGridStep(gridStep)}` : describeCamera(camera);
    if (controller.activeTab === 'export') syncExportFacts();
    if (selectionReadoutStale) {
      selectionReadoutStale = false;
      readoutSelection.textContent = describeSelection();
    }
  }

  function exportGlbBytes() {
    return exportGlb(controller.scene.parts);
  }

  async function buildWebPackPayload() {
    const { stillRecipe, stripped } = buildPackReadyRecipe(controller.exportRecipe());
    await prepareRecipe(stillRecipe);
    const stillScene = createAgentScene(stillRecipe, {}, { assets: catalog.pool, sequenceFrames: catalog.pool });
    const environment = stillScene.environment;
    const shaderModules = agentSceneModulesNeeded(stillRecipe).filter(name => Object.hasOwn(PACK_SHADER_MODULES, name));
    for (const moduleName of agentSceneModulesNeeded(stillRecipe)) {
      if (Object.hasOwn(PACK_UNSUPPORTED_MODULES, moduleName)) {
        stripped.push(PACK_UNSUPPORTED_MODULES[moduleName]);
      }
    }
    checkImageBudget(stillScene.parts);
    const packBytes = encodePackOrRefuse(encodePack, {
      shaderModules,
      camera: stillScene.camera,
      environment,
      environmentMap: packedSkyOf(environment),
      effects: stillScene.effects,
      shadowBounds: resolveAgentShadow(fitAgentShadow(stillScene.shadow, stillScene.parts), environment.lightDirection),
      parts: stillScene.parts.map(part => ({
        name: part.name,
        geometry: part.geometry,
        material: part.material,
        matrix: part.matrix,
      })),
    });
    const posterDataUrl = capturePngDataUrl();
    const title = activeFileName.replace(/\.(scene\.)?json$/i, '') || 'Crucible scene';
    return { packBytes, posterDataUrl, title, stripped };
  }

  // `agent` says whether an AI agent made this edit: true, false, or { name }. Left out, a reload of the watched file counts as one.
  async function loadExternalTextFile(text, { filePath = null, fileName = 'scene.json', recordUndo = true, agent } = {}) {
    const parsed = JSON.parse(text);
    const madeByAgent = agent ?? (filePath !== null && filePath === activeFilePath);
    const agentLabel = assertAgentName(madeByAgent?.name ?? defaultAgentName);
    const recipeBefore = madeByAgent ? controller.exportRecipe() : null;
    // A host or a watched-file reload does not ask first: the scene it replaces stays one undo step away, and this says so.
    const replacedUnsavedChanges = isDirty && recordUndo;
    await prepareRecipe(parsed);
    controller.loadRecipe(parsed, { recordUndo });
    if (madeByAgent) {
      showAgentEdit({ name: agentLabel, ...diffRecipeNodes(recipeBefore, controller.exportRecipe()) });
    } else {
      agentPresence.hide();
    }
    const sameOpenFile = filePath !== null && filePath === activeFilePath;
    cancelNameEditing();
    activeFilePath = filePath;
    activeFileName = fileName;
    activeFileSuffix = extensionOf(fileName);
    renameWaitsForSave = false;
    isDirty = false;
    if (!madeByAgent && !sameOpenFile) {
      restoreSavedWorkspaceTab(activeFilePath, activeFileName);
    }
    syncFileBanner();
    if (replacedUnsavedChanges) announce('Replaced unsaved changes. Undo brings them back.');
  }

  // The New scene chooser, the unsaved-changes question and the recent list load on first use, so Studio's entry stays small.
  let newSceneDialogs = null;
  let newSceneDialogsPromise = null;
  function loadNewSceneDialogs() {
    newSceneDialogsPromise ??= import('./studio-new-scene.js').then(module => {
      newSceneDialogs = module.createNewSceneDialogs({ documentReference, createElement, createIcon });
      root.append(...newSceneDialogs.dialogs);
      return newSceneDialogs;
    });
    return newSceneDialogsPromise;
  }

  // File handles keep a file reopenable where the browser has them; elsewhere the recent list keeps a bounded copy of the recipe.
  const canKeepFileHandles = () => typeof documentReference.defaultView?.showOpenFilePicker === 'function' && Boolean(documentReference.defaultView?.indexedDB);
  let recentScenesPromise = null;
  function loadRecentScenes() {
    recentScenesPromise ??= import('./studio-recent-scenes.js').then(module => module.createRecentScenes({
      storage: preferenceStorage,
      handleStore: canKeepFileHandles() ? module.createIndexedDbHandleStore(documentReference.defaultView.indexedDB) : null,
      host: desktop?.recentScenes ?? null,
    }));
    return recentScenesPromise;
  }

  async function rememberFile({ name, text, handle = null, filePath = null }) {
    try {
      const recentScenes = await loadRecentScenes();
      await recentScenes.remember(handle ? { name, handle } : { name, text, filePath });
    } catch {
      // The recent list is a convenience: a scene that cannot be listed is still open.
    }
  }

  // A scene that is in the recent list keeps showing under its current name after a rename. A scene that never was in the list stays out of it.
  async function renameRecentEntry(previousFileName) {
    try {
      const recentScenes = await loadRecentScenes();
      const previousEntries = (await recentScenes.list()).filter(entry => entry.name === previousFileName);
      if (previousEntries.length === 0) return;
      await recentScenes.remember({ name: activeFileName, text: `${JSON.stringify(controller.exportRecipe(), null, 2)}
`, filePath: activeFilePath });
      for (const entry of previousEntries) await recentScenes.remove(entry.id);
    } catch {
      // The recent list is a convenience: a rename that cannot be listed is still done.
    }
  }

  /** Asks what to do with unsaved changes before a scene is replaced. Resolves true when it is safe to go on. */
  async function confirmReplaceScene() {
    if (!isDirty) return true;
    const { askUnsavedChanges } = await loadNewSceneDialogs();
    const choice = await askUnsavedChanges(activeFileName);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      await performSaveFile({ forceAs: false });
      // A cancelled save leaves the scene unsaved, so the scene stays.
      return !isDirty;
    }
    return true;
  }

  // Asked twice (a menu click and a host call), it is one chooser and one answer.
  let openingNewScene = null;
  function openNewScene() {
    openingNewScene ??= startNewScene().finally(() => {
      openingNewScene = null;
    });
    return openingNewScene;
  }

  async function startNewScene() {
    const { chooseTemplate } = await loadNewSceneDialogs();
    const templateKey = await chooseTemplate();
    if (!templateKey || !(await confirmReplaceScene())) return;
    try {
      const recipe = buildTemplateRecipe(templateKey);
      await prepareRecipe(recipe);
      controller.loadRecipe(recipe);
      cancelNameEditing();
      activeFilePath = null;
      activeFileName = `${templateKey}.scene.json`;
      renameWaitsForSave = false;
      activeFileSuffix = '';
      isDirty = false;
      discardDraft();
      syncFileBanner();
      announce(`New ${STUDIO_TEMPLATES[templateKey].label}`);
    } catch (error) {
      announceError(error.message);
    }
  }

  function setRecentExpanded(expanded) {
    recentList.hidden = !expanded;
    openRecentButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  async function refreshRecentList() {
    let entries = [];
    try {
      entries = await (await loadRecentScenes()).list();
    } catch {
      entries = [];
    }
    openRecentButton.disabled = entries.length === 0;
    const rows = entries.map(entry => {
      const row = giveMenuIcon(createElement(
        documentReference,
        'button',
        { type: 'button', title: entry.name, dataset: { recentId: entry.id } },
        createElement(documentReference, 'span', { className: 'crucible-studio-recent-name', textContent: entry.name }),
      ));
      row.addEventListener('click', () => openRecentScene(entry.id));
      return row;
    });
    const clearRow = giveMenuIcon(createElement(documentReference, 'button', { type: 'button', textContent: 'Clear recent', dataset: { clearRecent: 'true' } }), 'remove');
    clearRow.addEventListener('click', async () => {
      try {
        await (await loadRecentScenes()).clear();
        announce('Cleared the recent list');
      } catch (error) {
        announceError(error.message);
      }
      refreshRecentList();
    });
    recentList.replaceChildren(...rows, clearRow);
    if (entries.length === 0) setRecentExpanded(false);
  }
  openRecentButton.addEventListener('click', () => setRecentExpanded(recentList.hidden));
  newPopover.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') refreshRecentList();
  });

  async function openRecentScene(id) {
    try {
      const recentScenes = await loadRecentScenes();
      if (!(await confirmReplaceScene())) return;
      const opened = await recentScenes.open(id);
      await loadExternalTextFile(opened.text, { filePath: opened.filePath ?? null, fileName: opened.fileName });
      discardDraft();
      announceSuccess(`Opened ${opened.fileName}`);
      rememberFile({ name: opened.fileName, text: opened.text, handle: opened.handle, filePath: opened.filePath });
    } catch (error) {
      announceError(error.message);
      refreshRecentList();
    }
  }

  async function openPickedFile({ text, fileName, filePath = null, handle = null, verb = 'Opened' }) {
    if (!(await confirmReplaceScene())) return;
    try {
      await loadExternalTextFile(text, { filePath, fileName });
      discardDraft();
      announceSuccess(`${verb} ${fileName}`);
      rememberFile({ name: fileName, text, handle, filePath });
    } catch (error) {
      announceError(error.message);
    }
  }

  // One name is edited at a time; opening another, or loading another file, closes the one that is open without applying it.
  let activeNameEditor = null;
  let renameWaitsForSave = false;
  let renameNoticeShown = false;

  function cancelNameEditing() {
    activeNameEditor?.cancel();
  }

  // A list that rebuilt the row of an open field answers the field as a click away would. Not inside the rebuild itself:
  // the answer may change the scene, which syncs the list again.
  function closeDetachedNameEditor() {
    queueMicrotask(() => activeNameEditor?.closeIfDetached());
  }

  function startNameEditing(options) {
    if (activeNameEditor?.isBusy) return null;
    cancelNameEditing();
    const editor = openNameEditor({
      documentReference,
      createElement,
      createIcon,
      ...options,
      onClose: detail => {
        if (activeNameEditor === editor) activeNameEditor = null;
        options.onClose?.(detail);
      },
    });
    activeNameEditor = editor;
    return editor;
  }

  // The name is not part of the recipe, so a rename does not mark the scene as changed. It goes to the next save and to the draft.
  // A host that can rename the file on disk is asked to, and it must refuse to overwrite; without one the old file stays as it is.
  async function applySceneRename(newFileName) {
    if (newFileName === activeFileName) return null;
    const pathAtStart = activeFilePath;
    const previousFileName = activeFileName;
    if (activeFilePath && desktop?.renameScene) {
      const response = await desktop.renameScene({ filePath: activeFilePath, fileName: newFileName });
      // Another file was opened while the host worked: its answer is about the old one.
      if (activeFilePath !== pathAtStart) return null;
      if (response?.exists) return { error: 'A file with this name already exists' };
      if (response?.error) return { error: String(response.error) };
      if (response?.canceled) return null;
      activeFilePath = response?.filePath ?? activeFilePath;
      activeFileName = response?.fileName ?? newFileName;
      announceSuccess('Renamed');
    } else {
      activeFileName = newFileName;
      renameWaitsForSave = Boolean(activeFilePath);
      if (!renameNoticeShown) {
        renameNoticeShown = true;
        announceSuccess('Renamed. Saved under this name next time.');
      }
    }
    activeFileSuffix = splitFileName(activeFileName, activeFileSuffix).suffix;
    if (isDirty) {
      clearTimeout(draftTimer);
      writeDraftNow();
    }
    syncFileBanner();
    persistCurrentWorkspaceTab();
    await renameRecentEntry(previousFileName);
    return null;
  }

  // Under the name the reason would cover the top of the Scene panel when that panel sits below the name: it moves left, by the
  // width of the overlap and 8 px of air, onto the viewport.
  function reasonShiftClearOfScenePanel() {
    const outliner = root.querySelector('.crucible-studio-outliner');
    const outlinerBox = outliner?.getBoundingClientRect();
    if (!outlinerBox || outlinerBox.width === 0) return 0;
    return Math.max(0, Math.ceil(filePill.getBoundingClientRect().right - outlinerBox.left + 8));
  }

  // The reason sits beside the name when the bar has room between the workspace tabs and the name, and under it otherwise.
  function startSceneRename({ byKeyboard = false } = {}) {
    const { stem, suffix } = splitFileName(activeFileName, activeFileSuffix);
    const openedAs = { filePath: activeFilePath, fileName: activeFileName };
    startNameEditing({
      anchor: filePill,
      text: stem,
      suffix,
      className: 'crucible-studio-filename-editor',
      placement: filePill.getBoundingClientRect().left - workspaceList.getBoundingClientRect().right >= ERROR_BESIDE_NAME_MIN_GAP ? 'beside' : 'below',
      reasonShift: reasonShiftClearOfScenePanel(),
      label: 'Rename scene',
      validate: text => validateFileStem(text, suffix),
      isStale: () => activeFilePath !== openedAs.filePath || activeFileName !== openedAs.fileName,
      onCommit: value => applySceneRename(`${value}${suffix}`),
      // Focus goes back to the name for a person on the keyboard; after a click it would only draw a ring.
      onClose: ({ trigger }) => {
        if (byKeyboard && (trigger === 'enter' || trigger === 'escape')) filePill.focus();
      },
    });
  }
  // A click made by Enter or Space on the focused name has no detail; a mouse click has one.
  filePill.addEventListener('click', event => startSceneRename({ byKeyboard: event.detail === 0 }));

  async function performOpenFile() {
    if (desktop?.openFile) {
      const picked = await desktop.openFile();
      if (!picked || picked.canceled) return;
      await openPickedFile({ text: picked.text, fileName: picked.fileName, filePath: picked.filePath });
      return;
    }
    if (canKeepFileHandles()) {
      try {
        const [handle] = await documentReference.defaultView.showOpenFilePicker({ types: [{ description: 'Crucible scene', accept: { 'application/json': ['.json'] } }] });
        const file = await handle.getFile();
        await openPickedFile({ text: await file.text(), fileName: file.name, handle });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        // A page that may not use the picker (a frame, a blocked permission) falls back to the file input.
      }
    }
    fileInput.click();
  }

  async function performSaveFile({ forceAs = false } = {}) {
    const recipeText = `${JSON.stringify(controller.exportRecipe(), null, 2)}\n`;
    if (desktop?.saveFile && desktop?.saveFileAs) {
      const response = forceAs || !activeFilePath || renameWaitsForSave
        ? await desktop.saveFileAs({ text: recipeText, suggestedName: activeFileName })
        : await desktop.saveFile({ filePath: activeFilePath, text: recipeText });
      if (!response || response.canceled) return;
      activeFilePath = response.filePath;
      activeFileName = response.fileName;
      activeFileSuffix = extensionOf(response.fileName);
      renameWaitsForSave = false;
      isDirty = false;
      discardDraft();
      persistCurrentWorkspaceTab();
      syncFileBanner();
      rememberFile({ name: activeFileName, text: recipeText, filePath: activeFilePath });
      announceSuccess(`Saved ${activeFileName}`);
      return;
    }
    triggerBlobDownload(recipeText, activeFileName, 'application/json');
    isDirty = false;
    discardDraft();
    persistCurrentWorkspaceTab();
    syncFileBanner();
    rememberFile({ name: activeFileName, text: recipeText });
    announceSuccess(`Downloaded ${activeFileName}`);
  }

  openButton.addEventListener('click', () => performOpenFile());
  saveButton.addEventListener('click', () => performSaveFile({ forceAs: false }));
  saveAsButton.addEventListener('click', () => performSaveFile({ forceAs: true }));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await openPickedFile({ text: await file.text(), fileName: file.name, verb: 'Loaded' });
  });

  // The import code loads on the first import; an import is one undo step, and a refusal says what to do and changes nothing.
  async function importFileIntoScene(file) {
    if (!canImport) {
      announceWarning(NO_STORE_MESSAGE);
      return;
    }
    try {
      const { importFile, importMessageDuration } = await import('./studio-import.js');
      const message = await importFile(file, { catalog, controller, prepareRecipe });
      announce(message, importMessageDuration(message, STATUS_DEFAULT_MILLISECONDS));
    } catch (error) {
      const { importMessageDuration } = await import('./studio-import.js');
      announceError(error.message, importMessageDuration(error.message, STATUS_DEFAULT_MILLISECONDS));
    }
  }

  importButton?.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (file) await importFileIntoScene(file);
  });

  // Each action says what it wrote under its button: the file, and its size. A refused or failed export says why instead. A line
  // is true of the scene it was written from, and a new run of the same action clears it first.
  function reportExport(kindId, { fileName, detail }) {
    exportResultSceneKey = currentSceneKey();
    exportPanel.showResult(kindId, { ok: true, text: [fileName, ...detail].join(', ') });
  }

  function reportExportFailure(kindId, error) {
    announce(error.message, undefined, 'error', { quiet: true });
    exportResultSceneKey = currentSceneKey();
    exportPanel.showResult(kindId, { ok: false, text: error.message });
  }

  exportPanel.onAction('image', async () => {
    try {
      const dataUrl = capturePngDataUrl();
      const baseName = activeFileName.replace(/\.(scene\.)?json$/i, '') || 'crucible-render';
      const detail = [`${canvas.width} × ${canvas.height}`, formatFileSize(dataUrlByteLength(dataUrl))];
      if (desktop?.savePng) {
        const response = await desktop.savePng({ dataUrl, suggestedName: `${baseName}.png` });
        if (!response?.canceled) {
          announce(`Saved ${response.fileName}`, undefined, 'success', { quiet: true });
          reportExport('image', { fileName: response.fileName, detail });
        }
        return;
      }
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
      triggerBlobDownload(bytes, `${baseName}.png`, 'image/png');
      announce('Saved PNG still', undefined, 'success', { quiet: true });
      reportExport('image', { fileName: `${baseName}.png`, detail });
    } catch (error) {
      reportExportFailure('image', error);
    }
  });

  exportPanel.onAction('model', async () => {
    try {
      const glbBytes = exportGlbBytes();
      const baseName = activeFileName.replace(/\.(scene\.)?json$/i, '') || 'crucible-scene';
      const detail = [formatFileSize(glbBytes.byteLength)];
      if (desktop?.saveGlb) {
        const response = await desktop.saveGlb({ bytes: glbBytes, suggestedName: `${baseName}.glb` });
        if (!response?.canceled) {
          announce(`Exported ${response.fileName}`, undefined, 'success', { quiet: true });
          reportExport('model', { fileName: response.fileName, detail });
        }
        return;
      }
      triggerBlobDownload(glbBytes, `${baseName}.glb`, 'model/gltf-binary');
      announce('Exported GLB mesh', undefined, 'success', { quiet: true });
      reportExport('model', { fileName: `${baseName}.glb`, detail });
    } catch (error) {
      reportExportFailure('model', error);
    }
  });

  exportPanel.onAction('pack', async () => {
    try {
      const payload = await buildWebPackPayload();
      const detail = [formatFileSize(payload.packBytes.byteLength)];
      if (desktop?.packWebBundle) {
        const response = await desktop.packWebBundle(payload);
        if (!response?.canceled) {
          const note = payload.stripped.length ? ` (static snapshot, omitted ${payload.stripped[0]})` : '';
          announce(`Packed web bundle to ${response.outDir}${note}`, undefined, 'success', { quiet: true });
          // The host writes a folder or a file of its own choosing: show the name it returns, not the one a browser download would carry.
          reportExport('pack', { fileName: lastPathName(response.fileName ?? response.outDir), detail });
        }
        return;
      }
      triggerBlobDownload(payload.packBytes, `${payload.title}.pack`, 'application/octet-stream');
      announce('Downloaded scene.pack', undefined, 'success', { quiet: true });
      reportExport('pack', { fileName: `${payload.title}.pack`, detail });
    } catch (error) {
      reportExportFailure('pack', error);
    }
  });

  editJsonButton.addEventListener('click', () => {
    openImportDialog();
  });

  // Renderer Lifecycle
  // Volume fog reads scene depth, which the viewport otherwise does without. A scene that turns fog on gets a renderer
  // with a depth target, built once; it stays for the scenes after it.
  function sceneNeedsDepth() {
    const environment = controller.scene.environment;
    return Boolean(environment.volumeFog?.density > 0 || environment.localVolumes?.length || sceneHasPostPasses(controller.scene));
  }

  // The renderer takes its floor at construction, so a floor that appears or goes (a part now forms one, the ground was
  // switched off) rebuilds it. The rule walks every part's bounds, so it runs once per scene revision, never per frame.
  function sceneWantsFloor() {
    const scene = controller.scene;
    if (floorDecision.scene !== scene || floorDecision.revision !== scene.revision) {
      floorDecision = { scene, revision: scene.revision, drawsFloor: studioDrawsFloor(scene.parts, scene.environment) };
    }
    return floorDecision.drawsFloor;
  }

  // The floor's height is fixed with the renderer too. It is fitted to the scene the renderer was built for, so a recipe
  // loaded over that scene is measured once and rebuilds the renderer when its floor belongs elsewhere. Edits inside
  // one scene leave the floor where it is, so moving a part never stalls on a rebuild.
  function loadedSceneMovesFloor() {
    if (!sceneLoadedSinceFloorFit) {
      return false;
    }
    sceneLoadedSinceFloorFit = false;
    return rendererHasFloor && studioFloorHeight(controller.scene.parts) !== rendererFloorHeight;
  }

  function ensureRenderer() {
    const needsDepth = !rendererHasDepth && sceneNeedsDepth();
    if (renderer && !suppliedRenderer && (needsDepth || rendererHasFloor !== sceneWantsFloor() || loadedSceneMovesFloor())) {
      renderer.dispose();
      renderer = null;
    }
    if (renderer) {
      return installPostPasses(renderer);
    }
    const environment = controller.scene.environment;
    rendererHasDepth = sceneNeedsDepth();
    rendererHasFloor = sceneWantsFloor();
    rendererFloorHeight = studioFloorHeight(controller.scene.parts);
    sceneLoadedSinceFloorFit = false;
    const viewportSettings = viewportSettingsForTier(chosenTier());
    rendererSamples = viewportSettings.samples;
    renderer = createRenderer(canvas, controller.scene.parts, {
      hdr: true,
      depth: rendererHasDepth,
      world: environment.world,
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      shadowBounds: resolveAgentShadow(fitAgentShadow(controller.scene.shadow, controller.scene.parts), environment.lightDirection),
      pixelRatio: viewportSettings.pixelRatio,
      samples: viewportSettings.samples,
      ground: rendererHasFloor && viewportFloorPart(rendererFloorHeight),
      ...rendererOptions,
    });
    partSync.reset(controller.scene, controller.scene.topologyRevision);
    return installPostPasses(renderer);
  }

  function syncViewportDimensions() {
    const bounds = viewportElement.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || container.clientWidth || 960));
    const height = Math.max(1, Math.round(bounds.height || container.clientHeight || 540));
    if (width !== controller.viewportWidth || height !== controller.viewportHeight) {
      controller.setViewportSize(width, height);
    }
    if (renderer) {
      renderer.resize();
    }
  }

  // The grid is drawn with the scene so objects hide it, but it is never part of the scene: not picked, saved or exported.
  function partsToDraw() {
    const sceneParts = meshEditor?.active ? meshEditor.partsToDraw(controller.scene.parts) : controller.scene.parts;
    if (!gridVisible || drawingTheShot()) {
      return sceneParts;
    }
    gridParts ??= buildGridParts();
    gridPartsByName ??= new Map(gridParts.map(part => [part.name, part]));
    const camera = controller.viewCamera;
    placeGridParts(gridPartsByName, gridLayout({ visibleHeight: cameraVisibleHeight(camera), viewportHeight: controller.viewportHeight, target: camera.target, eye: camera.eye }));
    return [...sceneParts, ...gridParts];
  }

  // F flies the camera to the framed object instead of jumping there, so the eye can follow where the view went. The
  // flight ends the moment anything else moves the camera (an orbit, a view key, undo, a new file). With reduced motion
  // the view jumps.
  // The one switch for Studio's own motion: the Motion preference, or the system's reduced-motion setting while it follows the system.
  function motionIsReduced() {
    return preferences.motion === 'reduced' || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function stopFlight() {
    if (flightHandle) {
      cancelAnimationFrame(flightHandle);
      flightHandle = 0;
    }
  }

  function flyToSelection() {
    stopFlight();
    if (motionIsReduced() || typeof requestAnimationFrame !== 'function') {
      controller.frameSelection();
      return;
    }
    const camera = controller.viewCamera;
    const from = { eye: [...camera.eye], target: [...camera.target], orthoScale: camera.orthoScale ?? 4 };
    const flownScene = controller.scene;
    const cameraSignature = () => `${controller.viewCamera.eye}|${controller.viewCamera.target}`;
    let lastSignature = cameraSignature();
    const to = controller.frameSelectionPose();
    const mix = (start, end, progress) => start.map((value, axis) => value + (end[axis] - value) * progress);
    let startTime = null;
    const step = timestamp => {
      if (controller.scene !== flownScene || cameraSignature() !== lastSignature) {
        flightHandle = 0;
        return;
      }
      startTime ??= timestamp;
      const elapsed = Math.min(1, (timestamp - startTime) / FLIGHT_MILLISECONDS);
      const progress = 1 - (1 - elapsed) ** 3;
      const patch = elapsed === 1 ? to : { eye: mix(from.eye, to.eye, progress), target: mix(from.target, to.target, progress) };
      if (elapsed < 1 && to.orthoScale !== undefined) {
        patch.orthoScale = from.orthoScale + (to.orthoScale - from.orthoScale) * progress;
      }
      controller.moveViewportCamera(patch);
      lastSignature = cameraSignature();
      flightHandle = elapsed < 1 ? requestAnimationFrame(step) : 0;
    };
    flightHandle = requestAnimationFrame(step);
  }

  function syncRendererParts(activeRenderer) {
    const topology = `${controller.scene.topologyRevision}|${gridVisible && !drawingTheShot()}|${meshEditor?.active ? meshEditor.viewKey : ''}`;
    const revisionKey = `${controller.motionTime}|${controller.scene.motionTime}`;
    const parts = partsToDraw();
    if (partSync.needsReplace(controller.scene, topology)) {
      partSync.replace(activeRenderer, controller.scene, topology, revisionKey, parts);
      return activeRenderer;
    }
    try {
      partSync.update(activeRenderer, revisionKey, parts);
      return activeRenderer;
    } catch (error) {
      if (error instanceof ProgramNotReady) {
        throw error;
      }
      if (!suppliedRenderer && typeof renderer?.dispose === 'function') {
        renderer.dispose();
        renderer = null;
        return ensureRenderer();
      }
      throw error;
    }
  }

  // Only the part sync runs while the context is preparing: it rolls back when a program is not ready, and a frame half drawn would not.
  function syncPartsWithoutStall(activeRenderer) {
    const context = activeRenderer.context;
    if (!deferringLinks || capturingStill || !context) {
      return syncRendererParts(activeRenderer);
    }
    setPreparing(context, true);
    try {
      return syncRendererParts(activeRenderer);
    } finally {
      setPreparing(context, false);
    }
  }

  function programStillLinking() {
    if (!awaitedProgram) {
      return false;
    }
    if (renderer?.context === awaitedProgram.context && !renderer.disposed && !isLinkComplete(awaitedProgram.context, awaitedProgram.program)) {
      return true;
    }
    awaitedProgram = null;
    return false;
  }

  // Asks the driver every few milliseconds, off the frame, and draws the waiting scene the moment the program is linked.
  function drawWhenLinked() {
    clearTimeout(awaitedProgramTimer);
    awaitedProgramTimer = setTimeout(() => {
      if (programStillLinking()) {
        drawWhenLinked();
        return;
      }
      requestFrame();
    }, 8);
  }

  function drawSceneFrame() {
    const activeRenderer = syncPartsWithoutStall(ensureRenderer());
    const environment = controller.scene.environment;
    const effects = controller.scene.effects;
    const shadow = fitAgentShadow(controller.scene.shadow, controller.scene.parts);
    const shadowKey = JSON.stringify([environment.lightDirection, shadow]);
    if (renderedShadowKey !== shadowKey) {
      activeRenderer.shadowBounds = resolveAgentShadow(shadow, environment.lightDirection);
      activeRenderer.shadowsDirty = true;
      renderedShadowKey = shadowKey;
    }
    activeRenderer.world = environment.world;
    // The renderer fills a frame's missing environment fields from the environment it holds. Left as the one it was
    // built with, a field the opened recipe does not set (its view transform, its look) kept the previous scene's value.
    const frameEnvironment = { ...environment, map: agentEnvironmentMap(environment) };
    activeRenderer.environment = frameEnvironment;
    // A still is the scene's own shot, so it keeps the animated camera even while the viewport looks around freely.
    const frameCamera = drawingTheShot() ? controller.scene.camera : controller.viewCamera;
    renderWithPostPasses(activeRenderer, {
      ...frameCamera,
      ...(drawingTheShot() ? {} : viewportClipPlanes(frameCamera)),
      environment: frameEnvironment,
      effects,
      exposure: effects.exposure,
      time: controller.motionTime,
      lines: environment.lines,
    });
  }

  // A pass that fails to compile is refused and the frame is drawn again without it, so one bad pass never pauses the picture.
  function renderWithPostPasses(activeRenderer, frame) {
    while (true) {
      const plan = postPassPlanner.resolve(activeRenderer, controller.scene);
      let drawingObjectIds = false;
      try {
        if (plan.needsObjectIds) {
          drawingObjectIds = true;
          activeRenderer.render({ ...frame, pass: 'objectId', previousCamera: undefined });
          drawingObjectIds = false;
        }
        activeRenderer.render(frame);
        postPassNotice.show(plan.notDrawn);
        return;
      } catch (error) {
        // A frame that is still linking its programs must reach the caller untouched.
        const refused = !(error instanceof ProgramNotReady)
          && (postPassPlanner.refuseFailedPass(error, controller.scene)
            || (drawingObjectIds && postPassPlanner.refuseObjectPasses(activeRenderer, error)));
        if (!refused) {
          throw error;
        }
      }
    }
  }

  function drawAgentOutline() {
    const outline = agentPresence.place();
    if (outline) {
      gizmoSvg.append(createSvgElement(documentReference, 'polygon', {
        class: 'crucible-studio-agent-outline',
        stroke: agentPresence.color,
        points: outline.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' '),
      }));
    }
  }

  // Points the named agent cursor at each object an edit touched and says what changed.
  function showAgentEdit({ name = defaultAgentName, nodeIds = [], removedNodeIds = [], otherChange = false } = {}) {
    const label = assertAgentName(name);
    if (preferences.agentCursorVisible) {
      agentPresence.show({ name: label, nodeIds });
    }
    announce(describeAgentEdit(label, { nodeIds, removedNodeIds, otherChange }));
  }

  // The saved shot has no handles, outlines, marks or agent pointer, so none of them is built while Export is open.
  function clearEditorOverlays() {
    gizmoSvg.replaceChildren();
    outlineMask.draw(null, controller.viewportWidth, controller.viewportHeight);
    activeOutlineMask.draw(null, controller.viewportWidth, controller.viewportHeight);
  }

  function renderPass() {
    if (contextLost) {
      return;
    }
    insideDraw = true;
    try {
      syncViewportDimensions();
      drawSceneFrame();
      if (viewingShot()) {
        clearEditorOverlays();
      } else {
        renderGizmoMarkup(documentReference, gizmoSvg, controller, outlineMask, activeOutlineMask, { hideSelectionOutline: Boolean(meshEditor?.active), clearRadius: meshEditor?.active ? meshEditor.selectionScreenRadius() : null });
        if (!drawingTheShot()) {
          renderSceneObjectMarks(documentReference, gizmoSvg, controller);
        }
        drawAgentOutline();
        if (meshEditor?.active && !drawingTheShot()) meshEditor.draw(documentReference, gizmoSvg);
        appendSnapMarker(documentReference, gizmoSvg, controller.snapMarker());
      }
      syncViewportAids();
    } finally {
      insideDraw = false;
    }
  }

  // A frame that fails pauses the picture with a notice instead of ending the loop in silence; the next requested frame tries again.
  function renderScheduledPass() {
    if (programStillLinking()) {
      return true;
    }
    deferringLinks = true;
    try {
      renderPass();
      if (!contextLost) {
        pausedNotice.hide();
      }
      return true;
    } catch (error) {
      if (error instanceof ProgramNotReady) {
        awaitedProgram = { context: renderer.context, program: error.program };
        drawWhenLinked();
        return true;
      }
      pausedNotice.show(describeFrameFailure(error), frameFailureReason(error));
      return false;
    } finally {
      deferringLinks = false;
    }
  }

  // The scene, selection and camera stay in the controller. Only what the renderer holds is rebuilt, from the current scene.
  function recoverFromContextLoss() {
    contextLost = false;
    partSync.reset();
    renderedShadowKey = null;
    pausedNotice.hide();
    requestFrame();
  }

  function pauseForContextLoss() {
    contextLost = true;
    if (frameHandle) {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    }
    releaseRendererOfLostContext();
    pausedNotice.show(CONTEXT_LOST_MESSAGE);
  }

  // A renderer is released while its context is gone, when the browser ignores every delete. Releasing it after the
  // context is back would delete objects of the old context, and that error would fail the first upload of the new one.
  function releaseRendererOfLostContext() {
    if (suppliedRenderer || !renderer) {
      return;
    }
    try {
      renderer.dispose();
    } catch {
      // The lost context has nothing left to free, so a failed dispose changes nothing.
    }
    renderer = null;
  }

  function requestFrame() {
    if (frameHandle || contextLost || !isVisible || documentReference.hidden) {
      return;
    }
    frameHandle = requestAnimationFrame(timestamp => {
      frameHandle = 0;
      if (contextLost || !isVisible || documentReference.hidden) {
        return;
      }
      if (playing) {
        const deltaSeconds = lastFrameTime ? Math.min(0.05, (timestamp - lastFrameTime) / 1000) : 0;
        lastFrameTime = timestamp;
        const recipe = controller.exportRecipe();
        const duration = recipe.motion?.duration ?? 4;
        const nextTime = duration > 0 ? (controller.motionTime + deltaSeconds) % duration : 0;
        if (hasAnimatedData(recipe)) {
          controller.setMotionTime(roundValue(nextTime, 1000));
        } else {
          playing = false;
          syncUi();
        }
      } else {
        lastFrameTime = timestamp;
      }
      const drawn = renderScheduledPass();
      if (drawn && playing && !frameHandle) {
        requestFrame();
      }
    });
  }

  // UI Synchronization
  let lastTreeKey = '';
  let lastSwatchesKey = '';
  let lastPressedMaterialId;
  let lastBookmarksKey = '';
  let lastParentOptionsKey = '';

  // The camera and the lights are not recipe nodes: a row selects the object the controller keeps beside the node selection.
  function createSceneObjectRow(object) {
    const selected = object.key === controller.selectedObjectKey;
    const iconName = SCENE_OBJECT_ICONS[object.kind];
    const badge = createIcon(documentReference, iconName);
    badge.setAttribute('class', 'crucible-studio-icon crucible-studio-tree-badge');
    badge.setAttribute('data-shape', iconName);
    const selectButton = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-tree-select' },
      badge,
      createElement(documentReference, 'span', { className: 'crucible-studio-tree-label', textContent: object.label }),
    );
    selectButton.addEventListener('click', () => selectSceneObjectAndShowItsPanel(object.key));
    return createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-tree-row', dataset: { selected: selected ? 'true' : 'false', sceneObject: object.key }, attributes: { role: 'treeitem', 'aria-selected': selected ? 'true' : 'false' } },
      selectButton,
    );
  }

  // The Look and Camera tabs show the camera, the sun or a light while one is selected. A mesh picked after that
  // gets its own tab, so the Properties card never keeps describing the object that was left. The Camera tab has
  // nothing to say about a mesh, so a pick made from it always opens the mesh.
  function selectNodeAndShowItsPanel(select) {
    const leftSceneObject = controller.selectedObjectKey !== null;
    const tabBefore = controller.activeTab;
    select();
    if (!controller.selectedNodeId) return;
    if (tabBefore === 'camera') selectInspectorTab('node');
    else if (leftSceneObject && tabBefore === 'look') selectInspectorTab('material');
  }

  function selectAllNodes() {
    selectNodeAndShowItsPanel(() => controller.selectAll());
  }

  function invertNodeSelection() {
    selectNodeAndShowItsPanel(() => controller.invertSelection());
  }

  function selectSceneObjectAndShowItsPanel(key) {
    controller.selectSceneObject(key);
    selectInspectorTab(key === 'camera' ? 'camera' : 'look');
  }

  // One Scene list row per node or scene object, kept between syncs: an edit builds only the rows whose content changed.
  const outlinerRows = new Map();
  let lastTreeStructureKey = '';

  function selectedNodeLabel() {
    const selectedNode = controller.exportRecipe().nodes.find(node => node.id === controller.selectedNodeId);
    return selectedNode ? (selectedNode.label ?? selectedNode.id) : '';
  }

  // Renames one node's label from its row. The id stays, so labels may repeat; the change is one undo step like any edit.
  function startNodeRename(nodeId, { byKeyboard = false } = {}) {
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === nodeId);
    const row = outlinerRows.get(`node:${nodeId}`);
    if (!node || !row) return;
    const anchor = row.element.children[0];
    const eyeButton = row.element.children[1];
    const editor = startNameEditing({
      anchor,
      coverOnly: true,
      // The field is laid over the label alone, from the label's own start to the eye button, so the icon and the eye stay.
      onOpen: opened => {
        const rowBox = row.element.getBoundingClientRect();
        const labelBox = anchor.querySelector('.crucible-studio-tree-label').getBoundingClientRect();
        const eyeBox = eyeButton.getBoundingClientRect();
        opened.element.style.insetInlineStart = `${labelBox.left - rowBox.left}px`;
        opened.element.style.insetInlineEnd = `${Math.max(0, rowBox.right - eyeBox.left)}px`;
      },
      text: node.label ?? node.id,
      label: `Rename ${node.label ?? node.id}`,
      validate: validateNodeLabel,
      isStale: () => !controller.exportRecipe().nodes.some(candidate => candidate.id === nodeId),
      onCommit: value => {
        if (value !== (node.label ?? node.id)) controller.updateNodeTransform(nodeId, { label: value });
        return null;
      },
      onClose: ({ trigger }) => {
        if (byKeyboard && (trigger === 'enter' || trigger === 'escape')) outlinerRows.get(`node:${nodeId}`)?.element.children[0]?.focus({ preventScroll: true });
      },
    });
    if (!editor) return;
  }

  // F2 and the Rename rows of the menus: the active object. The camera, the sun and the lights keep the names Studio gives them.
  function renameActiveObject({ byKeyboard = false } = {}) {
    const nodeId = controller.selectedNodeId;
    if (!nodeId) {
      if (controller.selectedObjectKey) announce('The camera, the sun and lights keep their names.');
      return;
    }
    if (root.dataset.outlinerCollapsed === 'true') setOutlinerCollapsed(false);
    if (!outlinerRows.has(`node:${nodeId}`)) {
      outlinerSearch.value = '';
      syncUi();
    }
    outlinerRows.get(`node:${nodeId}`)?.element.scrollIntoView?.({ block: 'nearest' });
    startNodeRename(nodeId, { byKeyboard });
  }

  // A menu row closes its menu after its own handler, and closing gives focus back to the menu button, which would end a field
  // opened by then. The field opens once the menu is closed and the focus has settled.
  function renameActiveObjectFromMenu() {
    setTimeout(() => renameActiveObject(), 0);
  }

  // A shot is keyed by its name, so the rename goes through the controller, which refuses a name that is taken.
  function startShotRename(shotName, anchor) {
    startNameEditing({
      anchor,
      text: shotName,
      label: `Rename shot ${shotName}`,
      validate: text => validateShotName(text, controller.listBookmarks().map(shot => shot.name).filter(name => name !== shotName)),
      isStale: () => !controller.listBookmarks().some(shot => shot.name === shotName),
      onCommit: value => {
        if (value !== shotName) controller.renameBookmark(shotName, value);
        return null;
      },
      onClose: ({ trigger }) => {
        if (trigger === 'escape') anchor.focus();
      },
    });
  }

  function createNodeRow(node, depth, iconName) {
    const badge = createIcon(documentReference, iconName);
    badge.setAttribute('class', 'crucible-studio-icon crucible-studio-tree-badge');
    badge.setAttribute('data-shape', iconName);
    const selectButton = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-tree-select', dataset: { hidden: node.visible === false ? 'true' : 'false' } },
      badge,
      createElement(documentReference, 'span', { className: 'crucible-studio-tree-label', textContent: node.label ?? node.id }),
    );
    selectButton.style.paddingLeft = `${4 + depth * 12}px`;
    selectButton.addEventListener('click', event => {
      // Shift or Ctrl (Command) adds the row to the selection or takes it out, as in the viewport; a plain click replaces.
      const toggles = event.shiftKey || event.ctrlKey || event.metaKey;
      selectNodeAndShowItsPanel(() => (toggles ? controller.selectNodes([node.id], { mode: 'toggle' }) : controller.selectNode(node.id)));
    });
    selectButton.addEventListener('contextmenu', event => {
      event.preventDefault();
      selectNodeAndShowItsPanel(() => controller.selectNode(node.id));
      openObjectMenu(event.clientX, event.clientY);
    });
    selectButton.addEventListener('dblclick', () => {
      controller.selectNode(node.id);
      startNodeRename(node.id);
    });
    const hidden = node.visible === false;
    const eyeButton = createIconButton(documentReference, hidden ? 'eyeOff' : 'eye', `${hidden ? 'Show' : 'Hide'} ${node.label ?? node.id}`, {
      className: 'crucible-studio-tree-eye',
      dataset: { hidden: hidden ? 'true' : 'false' },
    });
    eyeButton.addEventListener('click', () => controller.updateNodeTransform(node.id, { visible: !(node.visible ?? true) }));
    const element = createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-tree-row', dataset: { selected: 'false' }, attributes: { role: 'treeitem', 'aria-selected': 'false' } },
      selectButton,
      eyeButton,
    );
    outlinerDrag.bindRow(element, node.id);
    return { element, badge, appliedFill: '' };
  }

  // Every selected row is marked selected; the active one, the node the panels follow, also carries aria-current and a stronger tint.
  function setOutlinerRowSelected(row, selected, active = selected) {
    const selectedText = selected ? 'true' : 'false';
    if (row.element.dataset.selected !== selectedText) {
      row.element.dataset.selected = selectedText;
      row.element.setAttribute('aria-selected', selectedText);
    }
    const activeText = selected && active ? 'true' : 'false';
    if (row.element.dataset.active !== activeText) {
      row.element.dataset.active = activeText;
      if (activeText === 'true') {
        row.element.setAttribute('aria-current', 'true');
      } else {
        row.element.removeAttribute('aria-current');
      }
    }
  }

  function setOutlinerRowFill(row, fill) {
    if (row.appliedFill === fill) {
      return;
    }
    row.appliedFill = fill;
    row.badge.style.fill = fill;
  }

  // Indexes of the longest run of values that keeps rising: the rows of that run are already in the right order.
  function longestRisingRun(values) {
    const tails = [];
    const tailIndexAtLength = [];
    const previousIndex = new Array(values.length).fill(-1);
    values.forEach((value, index) => {
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (tails[middle] < value) low = middle + 1;
        else high = middle;
      }
      tails[low] = value;
      tailIndexAtLength[low] = index;
      previousIndex[index] = low > 0 ? tailIndexAtLength[low - 1] : -1;
    });
    const run = new Set();
    for (let index = tails.length ? tailIndexAtLength[tails.length - 1] : -1; index >= 0; index = previousIndex[index]) {
      run.add(index);
    }
    return run;
  }

  // Puts the wanted rows in the list in order. Stale rows leave first. The rows already in the list that keep their relative
  // order stay where they are; every other row is inserted before the row that follows it. A row that stays is never
  // detached, since that would drop its keyboard focus and hover.
  function placeOutlinerRows(rowElements) {
    const wanted = new Set(rowElements);
    for (const child of [...outlinerTree.children]) {
      if (!wanted.has(child)) {
        child.remove();
      }
    }
    const positions = new Map([...outlinerTree.children].map((child, index) => [child, index]));
    const inList = rowElements.filter(element => positions.has(element));
    const stays = new Set([...longestRisingRun(inList.map(element => positions.get(element)))].map(index => inList[index]));
    let following = null;
    for (let index = rowElements.length - 1; index >= 0; index -= 1) {
      const element = rowElements[index];
      if (!stays.has(element)) {
        outlinerTree.insertBefore(element, following);
      }
      following = element;
    }
  }

  // A rebuilt row is a new element: the button that had focus is found again by node id, so the keyboard stays where it was.
  function focusedOutlinerButton() {
    const active = documentReference.activeElement;
    if (!active) {
      return null;
    }
    for (const [rowKey, row] of outlinerRows) {
      const buttonIndex = [...row.element.children].indexOf(active);
      if (buttonIndex >= 0) {
        return { rowKey, buttonIndex, element: active };
      }
    }
    return null;
  }

  function restoreOutlinerFocus(focused) {
    if (!focused || documentReference.activeElement === focused.element) {
      return;
    }
    outlinerRows.get(focused.rowKey)?.element.children[focused.buttonIndex]?.focus({ preventScroll: true });
  }

  function renderOutliner(recipe) {
    const queryText = outlinerSearch.value.trim().toLowerCase();
    const materialColors = new Map(recipe.materials.map(material => [material.id, linearRgbToHex(material.color)]));
    const geometriesById = new Map(recipe.geometries.map(geometry => [geometry.id, geometry]));
    const ordered = depthSortedNodes(recipe.nodes).filter(({ node }) => {
      if (!queryText) return true;
      return (node.label ?? node.id).toLowerCase().includes(queryText) || node.id.toLowerCase().includes(queryText);
    });
    const sceneObjects = controller.listSceneObjects().filter(object => !queryText || object.label.toLowerCase().includes(queryText) || object.key.includes(queryText));
    const selectedNodeIdSet = new Set(controller.selectedNodeIds);
    const wantedRows = [
      ...sceneObjects.map(object => ({
        rowKey: `object:${object.key}`,
        contentKey: `${object.kind}:${object.label}`,
        selected: object.key === controller.selectedObjectKey,
        fill: '',
        build: () => ({ element: createSceneObjectRow(object), badge: null, appliedFill: '' }),
      })),
      ...ordered.map(({ node, depth }) => {
        const iconName = treeIconName(node, geometriesById);
        return {
          rowKey: `node:${node.id}`,
          contentKey: `${depth}:${node.label ?? ''}:${node.visible ?? true}:${iconName}`,
          selected: selectedNodeIdSet.has(node.id),
          active: node.id === controller.selectedNodeId,
          fill: node.material && materialColors.has(node.material) ? materialColors.get(node.material) : '',
          build: () => createNodeRow(node, depth, iconName),
        };
      }),
    ];
    const treeKey = `${queryText}|${wantedRows.map(wanted => `${wanted.rowKey}:${wanted.contentKey}:${wanted.selected}:${wanted.active ?? wanted.selected}:${wanted.fill}`).join('|')}`;
    if (treeKey === lastTreeKey) {
      return;
    }
    lastTreeKey = treeKey;
    const focused = focusedOutlinerButton();
    const savedScrollTop = outlinerTree.scrollTop;
    const previousRows = new Map(outlinerRows);
    outlinerRows.clear();
    for (const wanted of wantedRows) {
      const previous = previousRows.get(wanted.rowKey);
      const row = previous?.contentKey === wanted.contentKey ? previous : { ...wanted.build(), contentKey: wanted.contentKey };
      setOutlinerRowSelected(row, wanted.selected, wanted.active);
      if (row.badge) setOutlinerRowFill(row, wanted.fill);
      outlinerRows.set(wanted.rowKey, row);
    }
    const structureKey = wantedRows.map(wanted => `${wanted.rowKey}:${wanted.contentKey}`).join('|');
    if (structureKey === lastTreeStructureKey) {
      return;
    }
    lastTreeStructureKey = structureKey;
    placeOutlinerRows([...outlinerRows.values()].map(row => row.element));
    closeDetachedNameEditor();
    restoreOutlinerFocus(focused);
    fitTreeToWholeRows();
    // Rows added or removed above the one the browser snapped to would move the list; it stays where the person left it.
    if (outlinerTree.scrollTop !== savedScrollTop) {
      outlinerTree.scrollTop = savedScrollTop;
    }
  }

  // The swatches are rebuilt only when a material was added, removed or recoloured; moving the pressed state to another
  // swatch touches two buttons. The strip scrolls to the pressed swatch at the end of the sync, only when it moved.
  let swatchScrollWanted = false;

  function renderPaletteSwatches(recipe, boundMaterialId) {
    const swatchesKey = recipe.materials.map(material => `${material.id}:${linearRgbToHex(material.color)}`).join('|');
    if (swatchesKey !== lastSwatchesKey) {
      lastSwatchesKey = swatchesKey;
      swatchScrollWanted = true;
      swatchContainer.replaceChildren(...recipe.materials.map(material => {
        const hex = linearRgbToHex(material.color);
        const swatch = createElement(documentReference, 'button', {
          type: 'button',
          className: 'crucible-studio-swatch-btn',
          title: material.id,
          attributes: { 'aria-pressed': 'false', 'aria-label': `Material ${material.id}` },
        });
        swatch.style.background = hex;
        swatch.addEventListener('click', () => {
          if (meshEditor?.active) {
            assignSwatchMaterialInEditMode({ meshEditor, materialId: material.id, onAssigned: () => updateMeshSelectionView() });
            selectInspectorTab('material');
            return;
          }
          const targets = selectedTargets();
          if (targets.length > 0) {
            try {
              if (targets.length === 1) controller.assignNodeMaterial(targets[0], material.id);
              else controller.assignNodesMaterial(targets, material.id);
            } catch {
              // group node has no geometry; still open material tab
            }
          }
          selectInspectorTab('material');
        });
        return swatch;
      }));
      lastPressedMaterialId = undefined;
    }
    if (boundMaterialId === lastPressedMaterialId) {
      return;
    }
    lastPressedMaterialId = boundMaterialId;
    swatchScrollWanted = true;
    recipe.materials.forEach((material, index) => {
      const pressed = material.id === boundMaterialId ? 'true' : 'false';
      const swatch = swatchContainer.children[index];
      if (swatch.getAttribute('aria-pressed') !== pressed) {
        swatch.setAttribute('aria-pressed', pressed);
      }
    });
  }

  // The strip is one row that scrolls sideways; the swatch of the selected node stays inside it.
  function scrollPressedSwatchIntoView() {
    if (!swatchScrollWanted) {
      return;
    }
    swatchScrollWanted = false;
    const pressedSwatch = [...swatchContainer.children].find(swatch => swatch.getAttribute('aria-pressed') === 'true');
    if (!pressedSwatch || !Number.isFinite(pressedSwatch.offsetLeft)) {
      return;
    }
    const swatchStart = pressedSwatch.offsetLeft;
    const swatchEnd = swatchStart + pressedSwatch.offsetWidth;
    if (swatchStart < swatchContainer.scrollLeft) {
      swatchContainer.scrollLeft = swatchStart - 4;
    } else if (swatchEnd > swatchContainer.scrollLeft + swatchContainer.clientWidth) {
      swatchContainer.scrollLeft = swatchEnd - swatchContainer.clientWidth + 4;
    }
  }

  // The Scene list shows whole rows only: when it scrolls, its rows grow by a pixel or two until a whole number of them fills it.
  // The natural row height comes from one measurement that holds until something that sets it changes: the list's own height
  // (read live), the kind of the first row (a camera row or a node row), the fonts, the window size, or the first row's own
  // size (watched). An edit that changes the rows then costs one read of the list's scroll height, taken after the rows are
  // placed, which the next frame needs anyway.
  let treeFitMeasure = null;
  let appliedTreeRowSize = '';
  let watchedFirstRow = null;

  function isSceneObjectRow(row) {
    return row.dataset.sceneObject !== undefined;
  }

  function measureTreeFit() {
    const view = documentReference.defaultView;
    outlinerTree.style.removeProperty('--studio-tree-row-size');
    appliedTreeRowSize = '';
    const firstRow = outlinerTree.firstElementChild;
    if (!firstRow || !(outlinerTree.clientHeight > 0)) {
      return null;
    }
    const treeStyle = view.getComputedStyle(outlinerTree);
    return {
      clientHeight: outlinerTree.clientHeight,
      paddingTop: parseFloat(treeStyle.paddingTop),
      paddingBottom: parseFloat(treeStyle.paddingBottom),
      rowPitch: firstRow.offsetHeight + TREE_ROW_GAP_PIXELS,
      firstRowIsSceneObject: isSceneObjectRow(firstRow),
    };
  }

  function setTreeRowSize(rowSize) {
    if (rowSize === appliedTreeRowSize) {
      return;
    }
    appliedTreeRowSize = rowSize;
    if (rowSize) {
      outlinerTree.style.setProperty('--studio-tree-row-size', rowSize);
    } else {
      outlinerTree.style.removeProperty('--studio-tree-row-size');
    }
  }

  // The first row's own size changes with the root font size even when the list's box does not.
  function watchFirstTreeRow() {
    const firstRow = outlinerTree.firstElementChild;
    if (!resizeObserver || firstRow === watchedFirstRow) {
      return;
    }
    if (watchedFirstRow) resizeObserver.unobserve?.(watchedFirstRow);
    watchedFirstRow = firstRow;
    if (firstRow) resizeObserver.observe(firstRow);
  }

  function treeFitMeasureIsCurrent() {
    const firstRow = outlinerTree.firstElementChild;
    return Boolean(treeFitMeasure)
      && outlinerTree.clientHeight === treeFitMeasure.clientHeight
      && isSceneObjectRow(firstRow) === treeFitMeasure.firstRowIsSceneObject;
  }

  function fitTreeToWholeRows({ remeasure = false } = {}) {
    const view = documentReference.defaultView;
    if (!view?.getComputedStyle || !outlinerTree.style?.removeProperty) {
      return;
    }
    watchFirstTreeRow();
    if (remeasure || !outlinerTree.firstElementChild || !treeFitMeasureIsCurrent()) {
      treeFitMeasure = measureTreeFit();
    }
    if (!treeFitMeasure) {
      return;
    }
    if (outlinerTree.scrollHeight <= outlinerTree.clientHeight) {
      setTreeRowSize('');
      return;
    }
    const { clientHeight, paddingTop, paddingBottom, rowPitch } = treeFitMeasure;
    const rowSpace = clientHeight - paddingTop - paddingBottom;
    const wholeRows = Math.max(1, Math.floor((rowSpace + TREE_ROW_GAP_PIXELS) / rowPitch));
    const stretchedRowSize = (rowSpace + TREE_ROW_GAP_PIXELS) / wholeRows - TREE_ROW_GAP_PIXELS;
    setTreeRowSize(`${stretchedRowSize}px`);
  }

  function refitTreeToWholeRows() {
    fitTreeToWholeRows({ remeasure: true });
  }

  // A locked row says so with the keyframe mark beside its title, the mark the property panel puts on a driven field.
  const lockedRowMarks = new Map();
  function lockedRowMark(row) {
    if (!lockedRowMarks.has(row)) {
      const mark = createElement(documentReference, 'span', {
        className: 'crucible-studio-driven-mark',
        attributes: { role: 'img', 'aria-label': 'Animated by a track' },
      }, createIcon(documentReference, 'keyframe'));
      row.container.querySelector('.crucible-studio-field-head').firstElementChild.append(mark);
      lockedRowMarks.set(row, mark);
    }
    return lockedRowMarks.get(row);
  }

  function setRowLockedByTrack(row, lockedByTrack) {
    row.setDisabled(lockedByTrack);
    row.container.dataset.driven = lockedByTrack ? 'true' : 'false';
    row.container.title = lockedByTrack ? 'Animated by a track. Turn on Auto-key to edit.' : '';
    if (lockedByTrack || lockedRowMarks.has(row)) {
      lockedRowMark(row).hidden = !lockedByTrack;
    }
  }

  function syncUi() {
    const recipe = controller.exportRecipe();
    toolButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.tool === controller.tool ? 'true' : 'false'));
    const editingMesh = Boolean(meshEditor?.active);
    root.dataset.meshEdit = editingMesh ? 'true' : 'false';
    meshModeGroup.hidden = !editingMesh;
    proportionalButton.setAttribute('aria-pressed', editingMesh && meshEditor.proportional?.enabled ? 'true' : 'false');
    const meshMode = editingMesh ? meshEditor.mode : null;
    if (meshMode !== shownMeshMode) {
      shownMeshMode = meshMode;
      selectionReadoutStale = true;
    }
    meshModeButtons.forEach(button => button.setAttribute('aria-pressed', editingMesh && button.dataset.meshMode === meshEditor.mode ? 'true' : 'false'));
    undoButton.setAttribute('aria-disabled', controller.canUndo ? 'false' : 'true');
    redoButton.setAttribute('aria-disabled', controller.canRedo ? 'false' : 'true');
    editUndoItem.setAttribute('aria-disabled', controller.canUndo ? 'false' : 'true');
    editRedoItem.setAttribute('aria-disabled', controller.canRedo ? 'false' : 'true');
    syncHistoryPanel();
    const selectedNode = recipe.nodes.find(node => node.id === controller.selectedNodeId) ?? null;
    const hasNode = Boolean(selectedNode);
    const selectedCount = controller.selectedNodeIds.length;
    selectionCountElement.hidden = selectedCount < 2;
    selectionCountLabel.textContent = `${selectedCount} selected`;
    duplicateButton.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    frameButton.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    deleteButton.setAttribute('aria-disabled', hasNode || selectedObjectIsDeletable() ? 'false' : 'true');

    renderOutliner(recipe);

    const selectedIds = controller.selectedNodeIds;
    const parentOptionsKey = `${selectedIds.join(',')}|${recipe.nodes.map(node => `${node.id}:${node.label ?? ''}`).join('|')}`;
    if (parentOptionsKey !== lastParentOptionsKey) {
      lastParentOptionsKey = parentOptionsKey;
      const excludedParents = new Set(selectedIds);
      nodeParentSelect.replaceChildren(
        createElement(documentReference, 'option', { value: '', textContent: 'Scene root' }),
        ...recipe.nodes
          .filter(node => !excludedParents.has(node.id) && !node.assetPart)
          .map(node => createElement(documentReference, 'option', { value: node.id, textContent: node.label ?? node.id })),
      );
      materialSelect.replaceChildren(
        ...recipe.materials.map(material => createElement(documentReference, 'option', { value: material.id, textContent: material.id })),
      );
    }

    const selectionSummary = summarizeNodeSelection(recipe, selectedIds, controller.selectedNodeId, {
      animatedNodeProperties: controller.animatedNodeProperties,
      nodePose: controller.nodePose,
      quaternionToEulerDegrees,
      linearRgbToHex,
    });
    syncObjectAndMaterialPanels({
      recipe,
      controller,
      summary: selectionSummary,
      documentReference,
      createElement,
      degreePrecision: DEGREE_PRECISION,
      linearRgbToHex,
      setButtonIcon,
      setRowLockedByTrack,
      syncTreeInspector,
      shapeSettings,
      renderPaletteSwatches,
      controls: {
        nodeEmptyPrompt, nodeControls, nodeLabelInput, nodeParentSelect, visibleToggle, castShadowToggle, receiveShadowToggle,
        positionRow, rotationRow, scaleRow, materialEmptyPrompt, materialControls, materialSelect, colorInput, colorMixedTag, colorField,
        emissiveColorInput, emissiveMixedTag, emissiveField, roughnessField, metallicField,
        clearcoatField, clearcoatRoughnessField, doubleSidedToggle, opacityField, emissionField,
      },
    });
    faceMaterialPanel.sync();

    const environment = recipe.environment ?? {};
    const activeSetup = environment.setup ?? 'daylight';
    setupButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.setup === activeSetup ? 'true' : 'false'));
    viewTransformSelect.value = environment.viewTransform ?? 'aces';

    const camera = controller.scene.camera;
    const isOrthographic = camera.projection === 'orthographic';
    projectionPillButton.textContent = isOrthographic ? 'Orthographic' : 'Perspective';
    // The pill names the projection in use, so it is always the active chip of its row.
    projectionPillButton.setAttribute('aria-pressed', 'true');
    const activeViewChip = matchingViewChip(camera);
    viewPresetButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.view === activeViewChip ? 'true' : 'false'));
    const lensFocalLength = cameraFocalLengthMillimetres(camera, { aspect: controller.viewportWidth / controller.viewportHeight });
    lensChips.forEach(chip => chip.setAttribute('aria-pressed', !isOrthographic && Math.abs(Number(chip.dataset.focal) - lensFocalLength) <= LENS_CHIP_TOLERANCE_MILLIMETRES ? 'true' : 'false'));

    const bookmarks = controller.listBookmarks();
    const bookmarksKey = bookmarks.map(shot => shot.name).join('|');
    if (bookmarksKey !== lastBookmarksKey) {
      lastBookmarksKey = bookmarksKey;
      bookmarkListElement.replaceChildren(...bookmarks.map(shot => {
        const applyButton = createElement(documentReference, 'button', { type: 'button', textContent: shot.name });
        const removeButton = createElement(documentReference, 'button', { type: 'button', textContent: '×', attributes: { 'aria-label': `Remove bookmark ${shot.name}` } });
        // The second click of a double click only starts the rename: the shot is applied once.
        applyButton.addEventListener('click', event => {
          if (event.detail > 1) return;
          controller.applyBookmark(shot.name);
        });
        applyButton.addEventListener('dblclick', () => startShotRename(shot.name, applyButton));
        removeButton.addEventListener('click', () => controller.removeBookmark(shot.name));
        return createElement(documentReference, 'div', { className: 'crucible-studio-bookmark-row' }, applyButton, removeButton);
      }));
      closeDetachedNameEditor();
      quickBookmarksRow.replaceChildren(...bookmarks.slice(0, 5).map(shot => {
        const pill = createElement(documentReference, 'button', { type: 'button', textContent: shot.name, title: `Jump to shot ${shot.name}` });
        pill.addEventListener('click', () => controller.applyBookmark(shot.name));
        return pill;
      }));
    }

    const duration = recipe.motion?.duration ?? 4;
    const animated = hasAnimatedData(recipe);
    scrubInput.max = String(Math.max(0.1, duration));
    scrubInput.value = String(controller.motionTime);
    scrubInput.disabled = !animated;
    playButton.setAttribute('aria-disabled', animated ? 'false' : 'true');
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    setButtonIcon(playButton, playing ? 'pause' : 'play', playTooltip(playing));
    timeOutput.textContent = `${controller.motionTime.toFixed(1)} / ${duration.toFixed(1)} s`;
    autoKeyButton.setAttribute('aria-pressed', controller.autoKey ? 'true' : 'false');
    keyMarkers.sync(Math.max(0.1, duration));
    syncPropertyPanels();
    syncHintBar();
    syncFileBanner();
    scrollPressedSwatchIntoView();
  }

  // Only the panel in view is redrawn: orbiting the viewport notifies a change many times a second.
  function syncPropertyPanels() {
    panelInstances[controller.activeTab]?.sync?.();
  }

  // What each export will hold. The picture's size follows the window, so it is read each frame; the model and the pack follow the
  // scene and are worked out once for each revision of it, and only while Export is open. A kind that cannot be saved says why.
  // A scene always has a camera (the controller refuses one without), so only the parts can be missing.
  function currentSceneKey() {
    const scene = controller.scene;
    return `${scene.topologyRevision}|${scene.revision}`;
  }

  function syncExportFacts() {
    const scene = controller.scene;
    exportPanel.showFacts('image', [{ frame: [canvas.width, canvas.height] }, { text: `${canvas.width} × ${canvas.height}` }]);
    const sceneKey = currentSceneKey();
    if (exportFactsSceneKey === sceneKey) return;
    exportFactsSceneKey = sceneKey;
    if (exportResultSceneKey !== null && exportResultSceneKey !== sceneKey) {
      exportPanel.clearResults();
      exportResultSceneKey = null;
    }
    const partCount = scene.parts.length;
    const noParts = partCount === 0;
    exportPanel.setBlocked('model', noParts);
    exportPanel.setBlocked('pack', noParts);
    if (noParts) {
      const reason = [{ icon: 'warning', text: 'No parts to save' }];
      exportPanel.showFacts('model', reason);
      exportPanel.showFacts('pack', reason);
      return;
    }
    const partsFact = { text: `${partCount} ${partCount === 1 ? 'part' : 'parts'}` };
    const triangleCount = Math.round(scene.parts.reduce((count, part) => count + (part.geometry?.indices?.length ?? 0) / 3, 0));
    exportPanel.showFacts('model', [partsFact, { text: `${triangleCount.toLocaleString('en-US')} triangles` }]);
    try {
      const { stripped } = buildPackReadyRecipe(controller.exportRecipe());
      exportPanel.showFacts('pack', [partsFact, ...stripped.map(name => ({ icon: 'warning', text: `${name} left out` }))]);
    } catch (error) {
      exportPanel.showFacts('pack', [{ icon: 'warning', text: error.message }]);
    }
  }

  function syncLookPanels() {
    lightPanel.sync();
    effectsPanel.sync();
    const lightSelected = selectedLightKey() !== null;
    for (const panel of scenePanels) {
      panel.element.hidden = lightSelected;
      if (!lightSelected) panel.sync();
    }
  }

  // While a key holds the object, the bar names the keys that act on it; a handle drag shows only how far it has gone.
  function syncHintBar() {
    if (!modalTransform) {
      hintBar.textContent = liveDeltaLabel;
      return;
    }
    const chip = (keys, word) => createElement(
      documentReference,
      'span',
      { className: 'crucible-studio-hint-chip' },
      createElement(documentReference, 'kbd', { textContent: keys }),
      word,
    );
    const lockedAxes = (modalTransform.locked && modalTransform.axis) || '';
    const axisChips = MODAL_AXES.map(axis => {
      const key = createElement(documentReference, 'kbd', { textContent: keyLabel(keymap, `modal.axis${axis.toUpperCase()}`), dataset: { axis } });
      key.setAttribute('aria-pressed', lockedAxes.includes(axis) ? 'true' : 'false');
      return key;
    });
    const typedUnit = modalTransform.tool === 'translate' ? ` ${preferences.lengthUnit}` : MODAL_TYPED_UNITS[modalTransform.tool];
    const typedReadout = modalTransform.typed === ''
      ? []
      : [createElement(documentReference, 'span', { className: 'crucible-studio-hint-typed', textContent: `= ${modalTransform.typed}${typedUnit}` })];
    hintBar.replaceChildren(
      createElement(documentReference, 'span', { className: 'crucible-studio-hint-delta', textContent: (liveDeltaLabel || MODAL_TOOL_WORDS[modalTransform.tool]).replace(/^SCREEN/, MODAL_TOOL_WORDS.translate) }),
      ...typedReadout,
      createElement(documentReference, 'span', { className: 'crucible-studio-hint-chip' }, ...axisChips, 'axis'),
      chip('Click', 'place'),
      chip(keyLabel(keymap, 'modal.cancel'), 'cancel'),
    );
  }

  // Blender's G, R and S: the key picks the object up under the pointer, with no handle to aim at. X, Y or Z keeps
  // it on that axis of the object, a click or Enter places it and Esc or a right click puts it back.
  function modalFreeAxis(tool) {
    return tool === 'rotate' ? controller.axisFacingView() : MODAL_FREE_AXIS[tool];
  }

  function beginModalDrag(axis, locked) {
    controller.beginGizmoDrag(axis, modalTransform.startX, modalTransform.startY);
    modalTransform.axis = axis;
    modalTransform.locked = locked;
    const typedAmount = typedModalAmount();
    if (typedAmount !== null) {
      controller.setGizmoTypedAmount(typedAmount);
    } else if (modalTransform.lastX !== modalTransform.startX || modalTransform.lastY !== modalTransform.startY) {
      controller.updateGizmoDrag(modalTransform.lastX, modalTransform.lastY, { ctrlKey: modalTransform.ctrlKey });
    }
  }

  function onModalPointerMove(event) {
    const coordinates = localCoordinates(event);
    modalTransform.lastX = coordinates.x;
    modalTransform.lastY = coordinates.y;
    modalTransform.ctrlKey = event.ctrlKey;
    controller.updateGizmoDrag(coordinates.x, coordinates.y, { ctrlKey: event.ctrlKey });
  }

  // Ctrl held or let go flips snapping for the move in hand at once, without waiting for the pointer to move.
  function replayDragWithCtrl(ctrlKey) {
    if (!controller.dragging) return;
    if (modalTransform) {
      modalTransform.ctrlKey = ctrlKey;
      controller.updateGizmoDrag(modalTransform.lastX, modalTransform.lastY, { ctrlKey });
    } else if (pointerState?.mode === 'gizmo') {
      pointerState.ctrlKey = ctrlKey;
      controller.updateGizmoDrag(pointerState.lastX, pointerState.lastY, { ctrlKey });
    }
  }

  // The press that places or cancels belongs to the move: it must not also orbit, select or press a button under it.
  function onModalPointerDown(event) {
    event.preventDefault();
    event.stopPropagation();
    swallowClick = event.button === 0;
    swallowContextMenu = event.button === 2;
    finishModalTransform(event.button === 0);
  }

  // The browser still sends the click and the context menu that follow that press: neither may reach what lies under
  // the pointer, such as a Delete button or the object's own menu.
  function onModalContextMenu(event) {
    if (modalTransform || swallowContextMenu) {
      event.preventDefault();
      event.stopPropagation();
      swallowContextMenu = false;
    }
  }

  function onModalClick(event) {
    if (swallowClick) {
      event.preventDefault();
      event.stopPropagation();
      swallowClick = false;
    }
  }

  // A press outside a held move starts something new: nothing is left to swallow from the move before it.
  function onAnyPointerDown() {
    if (!modalTransform) {
      swallowClick = false;
      swallowContextMenu = false;
    }
  }

  function onModalBlur() {
    finishModalTransform(false);
  }

  // The window losing focus during a handle drag: the key-up of Ctrl will never arrive, so the drag goes on as if it were up.
  function onWindowBlur() {
    if (pointerState?.mode === 'gizmo') replayDragWithCtrl(false);
  }

  function startModalTransform(tool) {
    if (modalTransform || pointerState || !viewportPointer || !controller.selectedNodeId) {
      return false;
    }
    stopFlight();
    modalTransform = {
      tool,
      axis: null,
      locked: false,
      typed: '',
      startX: viewportPointer.x,
      startY: viewportPointer.y,
      lastX: viewportPointer.x,
      lastY: viewportPointer.y,
      ctrlKey: false,
    };
    root.dataset.modal = tool;
    try {
      beginModalDrag(modalFreeAxis(tool), false);
    } catch (error) {
      modalTransform = null;
      delete root.dataset.modal;
      if (!meshEditor?.active) throw error;
      announceError(error.message);
      return false;
    }
    documentReference.addEventListener('pointermove', onModalPointerMove);
    documentReference.addEventListener('pointerdown', onModalPointerDown, true);
    documentReference.defaultView?.addEventListener?.('blur', onModalBlur);
    syncHintBar();
    return true;
  }

  function finishModalTransform(confirmed) {
    if (!modalTransform) {
      return;
    }
    const finishedTool = modalTransform.tool;
    modalTransform = null;
    delete root.dataset.modal;
    documentReference.removeEventListener('pointermove', onModalPointerMove);
    documentReference.removeEventListener('pointerdown', onModalPointerDown, true);
    documentReference.defaultView?.removeEventListener?.('blur', onModalBlur);
    if (confirmed) {
      controller.endGizmoDrag();
    } else if (controller.cancelGizmoDrag()) {
      announce(`${MODAL_TOOL_WORDS[finishedTool]} cancelled`);
    }
    syncHintBar();
  }

  // The same axis key again lets the object go free; another one moves the lock there. The move restarts from where
  // the key picked the object up, so a placed move is still one undo step.
  function lockModalAxis(requestedAxis) {
    // A turn goes around one axis, so the plane across an axis means that axis.
    const axis = modalTransform.tool === 'rotate' ? MODAL_AXIS_ACROSS_PLANE[requestedAxis] ?? requestedAxis : requestedAxis;
    const release = modalTransform.locked && modalTransform.axis === axis;
    // No axis while the drag is swapped: the change this cancel reports must not read as the object being let go.
    modalTransform.axis = null;
    controller.cancelGizmoDrag();
    beginModalDrag(release ? modalFreeAxis(modalTransform.tool) : axis, !release);
    syncHintBar();
  }

  // The number typed so far, or null while it is not one yet (nothing, "-" or "."): the pointer then sets the amount.
  function typedModalAmount() {
    const amount = Number(modalTransform.typed);
    if (modalTransform.typed === '' || !Number.isFinite(amount)) {
      return null;
    }
    return modalTransform.tool === 'translate' ? lengthFromUnit(amount, preferences.lengthUnit) : amount;
  }

  // Numeric input: digits, a point and a minus sign build the amount, Backspace takes the last one back.
  function typeModalAmount(event) {
    const current = modalTransform.typed;
    let next = current;
    if (event.key === 'Backspace') {
      next = current.slice(0, -1);
    } else if (event.key === '-') {
      next = current.startsWith('-') ? current.slice(1) : `-${current}`;
    } else if (/^[0-9.]$/.test(event.key)) {
      next = current + event.key;
    } else {
      return false;
    }
    if (!MODAL_TYPED_PATTERN.test(next) || next.split('.').length > 2 || next.length > 12) {
      return true;
    }
    modalTransform.typed = next;
    controller.setGizmoTypedAmount(typedModalAmount());
    syncHintBar();
    return true;
  }

  function handleModalKey(event) {
    if (event.key === 'Shift' || event.key === 'Control') {
      return;
    }
    event.preventDefault();
    // A key held down repeats: it may not flip the lock or swap the tool. Ctrl+Z is not the Z axis because the
    // modal bindings carry no Ctrl.
    if (event.repeat) {
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && typeModalAmount(event)) {
      return;
    }
    const match = findKeymapAction(keymap, event, 'modal');
    if (!match) {
      return;
    }
    const { actionId } = match;
    if (actionId === 'modal.cancel') {
      finishModalTransform(false);
    } else if (actionId === 'modal.place') {
      finishModalTransform(true);
    } else if (MODAL_AXIS_BY_ACTION[actionId]) {
      lockModalAxis(MODAL_AXIS_BY_ACTION[actionId]);
    } else if (MODAL_TOOL_BY_ACTION[actionId] !== modalTransform.tool) {
      finishModalTransform(false);
      pickUpWithTool(MODAL_TOOL_BY_ACTION[actionId]);
    }
  }

  function pickUpWithTool(tool) {
    controller.setTool(tool);
    startModalTransform(tool);
  }

  // Viewport Interaction: Gizmo Drag, Pick, Orbit, Pan, Zoom, File Drop
  function localCoordinates(event) {
    const bounds = viewportElement.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  // The handle under the pointer lights up before it is pressed. The handles are redrawn as the camera moves, so the
  // SVG remembers which one it is and the stylesheet does the lighting.
  const clearHoveredHandle = () => {
    if (pointerState?.mode !== 'gizmo') delete gizmoSvg.dataset.hoverAxis;
  };
  gizmoSvg.addEventListener('pointermove', event => {
    const axis = event.target?.getAttribute?.('data-gizmo-axis');
    if (axis) gizmoSvg.dataset.hoverAxis = axis;
    else clearHoveredHandle();
  });
  gizmoSvg.addEventListener('pointerout', clearHoveredHandle);
  gizmoSvg.addEventListener('pointerleave', clearHoveredHandle);

  let suppressGizmoContextMenu = false;

  // First among the handle listeners: in Maya and Cinema 4D Alt and a button navigate even over a handle.
  gizmoSvg.addEventListener('pointerdown', event => {
    const mode = findMouseNavigation(keymap, event);
    if (mode === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    beginCameraDrag(event, mode, true, viewportElement);
  });

  gizmoSvg.addEventListener('pointerdown', event => {
    const axis = event.target?.getAttribute?.('data-gizmo-axis');
    if (!axis || (event.button ?? 0) !== 0 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const coordinates = localCoordinates(event);
    gizmoSvg.dataset.hoverAxis = axis;
    try {
      controller.beginGizmoDrag(axis, coordinates.x, coordinates.y);
    } catch (error) {
      // Edit mode refuses a move it could not write down before the pointer moves, and says why.
      if (!meshEditor?.active) throw error;
      announceError(error.message);
      return;
    }
    pointerState = { mode: 'gizmo', pointerId: event.pointerId, lastX: coordinates.x, lastY: coordinates.y, ctrlKey: event.ctrlKey };
    viewportElement.setPointerCapture?.(event.pointerId);
  });

  // The handles lie over the selected object, so a right click on one opens that object's menu unless a right-drag pan just ran.
  gizmoSvg.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (suppressGizmoContextMenu) {
      suppressGizmoContextMenu = false;
      return;
    }
    if (findMouseNavigation(keymap, { button: 2, altKey: event.altKey }) !== null) return;
    if (controller.selectedNodeId) {
      openObjectMenu(event.clientX, event.clientY);
    }
  });

  // A press on a light or the sun selects it; with the move tool a light then follows the pointer in the plane through it that faces the view.
  gizmoSvg.addEventListener('pointerdown', event => {
    const key = event.target?.getAttribute?.('data-scene-object');
    if (!key || (event.button ?? 0) !== 0 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    selectSceneObjectAndShowItsPanel(key);
    const object = controller.listSceneObjects().find(candidate => candidate.key === key);
    const movable = object.position !== null && key !== 'camera';
    if (!movable || controller.tool !== 'translate') return;
    const coordinates = localCoordinates(event);
    const camera = controller.viewCamera;
    const normal = camera.target.map((component, axis) => component - camera.eye[axis]);
    const normalLength = Math.hypot(...normal);
    const planeNormal = normal.map(component => component / normalLength);
    const grabbed = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), object.position, planeNormal);
    if (!grabbed) return;
    pointerState = {
      mode: 'light',
      key,
      planeNormal,
      planePoint: object.position,
      grabOffset: object.position.map((component, axis) => component - grabbed[axis]),
      pointerId: event.pointerId,
    };
    viewportElement.setPointerCapture?.(event.pointerId);
  });

  // A camera drag: orbit, pan or zoom. `keymapNavigation` marks one a keymap asked for (Alt and a button), which never also picks.
  function beginCameraDrag(event, mode, keymapNavigation, captureElement) {
    const coordinates = localCoordinates(event);
    pointerState = {
      mode,
      keymapNavigation,
      startX: coordinates.x,
      startY: coordinates.y,
      lastX: coordinates.x,
      lastY: coordinates.y,
      moved: false,
      pointerId: event.pointerId,
    };
    captureElement.setPointerCapture?.(event.pointerId);
  }

  function targetPassesThroughViewport(target, { checkScroll = false } = {}) {
    for (let node = target; node && node !== viewportElement && node.tagName; node = node.parentNode) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a' || tag === 'dialog') return false;
      if (node.getAttribute?.('popover') !== null || node.getAttribute?.('data-view') !== null) return false;
      const classes = String(node.className ?? '').split(/\s+/);
      if (classes.some(name => name === 'crucible-studio-dock' || name === 'crucible-studio-popover' || name === 'crucible-studio-view-widget' || name === 'crucible-studio-paused' || name === 'crucible-studio-draft' || name === 'crucible-studio-pass-notice')) {
        return false;
      }
      if (checkScroll) {
        const style = documentReference.defaultView?.getComputedStyle?.(node);
        const overflow = `${style?.overflowX ?? ''}${style?.overflowY ?? ''}`;
        if (/auto|scroll/.test(overflow) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return false;
      }
    }
    return true;
  }

  viewportElement.addEventListener('pointerdown', event => {
    if (viewingShot()) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if (!targetPassesThroughViewport(event.target)) return;
    const keymapMode = findMouseNavigation(keymap, event);
    const defaultMode = event.shiftKey || event.button === 2 || event.button === 1 ? 'pan' : 'orbit';
    beginCameraDrag(event, keymapMode ?? defaultMode, keymapMode !== null, event.target === canvas ? canvas : viewportElement);
  });

  viewportElement.addEventListener('pointermove', event => {
    if (!pointerState) return;
    const coordinates = localCoordinates(event);
    if (pointerState.mode === 'gizmo') {
      pointerState.lastX = coordinates.x;
      pointerState.lastY = coordinates.y;
      pointerState.ctrlKey = event.ctrlKey;
      controller.updateGizmoDrag(coordinates.x, coordinates.y, { ctrlKey: event.ctrlKey });
      return;
    }
    if (pointerState.mode === 'light') {
      dragLight(coordinates);
      return;
    }
    const deltaX = coordinates.x - pointerState.lastX;
    const deltaY = coordinates.y - pointerState.lastY;
    if (Math.hypot(coordinates.x - pointerState.startX, coordinates.y - pointerState.startY) > 4) {
      pointerState.moved = true;
    }
    pointerState.lastX = coordinates.x;
    pointerState.lastY = coordinates.y;
    if (!pointerState.moved) return;
    if (pointerState.mode === 'pan') {
      controller.orbitCamera({ panX: -deltaX * 0.002, panY: deltaY * 0.002 });
    } else if (pointerState.mode === 'zoom') {
      controller.orbitCamera({ zoomScale: Math.min(1.5, Math.max(0.5, 1 - (deltaX - deltaY) * 0.005)) });
    } else {
      controller.orbitCamera({ deltaAzimuth: -deltaX * 0.008, deltaElevation: deltaY * 0.008 });
    }
  });

  function dragLight(coordinates) {
    const { key, planeNormal, planePoint, grabOffset } = pointerState;
    if (!planeNormal) return;
    const hit = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), planePoint, planeNormal);
    if (!hit) return;
    controller.beginUndoGroup();
    try {
      controller.moveSceneObject(key, hit.map((component, axis) => component + grabOffset[axis]));
    } catch (error) {
      pointerState.planeNormal = null;
      announceError(error.message);
    }
  }

  function finishPointer(event) {
    if (!pointerState) return;
    const finished = pointerState;
    pointerState = null;
    if (finished.moved && event.button === 2) {
      suppressGizmoContextMenu = true;
    }
    if (finished.mode === 'light') {
      controller.endUndoGroup();
      return;
    }
    if (finished.mode === 'gizmo') {
      delete gizmoSvg.dataset.hoverAxis;
      controller.endGizmoDrag();
      return;
    }
    if (!finished.moved && !finished.keymapNavigation) {
      const coordinates = localCoordinates(event);
      if (meshEditor?.active) {
        if ((event.button ?? 0) === 0) {
          if (event.altKey) {
            meshEditor.pickLoop(coordinates.x, coordinates.y, { ring: event.ctrlKey || event.metaKey, additive: event.shiftKey });
          } else {
            meshEditor.pick(coordinates.x, coordinates.y, { additive: event.shiftKey });
          }
          syncUi();
          requestFrame();
        } else if (event.button === 2 && !meshEditor.circleSelecting && !meshEditor.boxSelecting) {
          const { clientX, clientY } = event;
          setTimeout(() => meshMenus.openToolsAt(clientX, clientY), 0);
        }
      } else {
        // Shift or Ctrl (Command) with a left click adds the object under the pointer to the selection, or takes it out.
        const mode = (event.button ?? 0) === 0 && (event.shiftKey || event.ctrlKey || event.metaKey) ? 'toggle' : 'replace';
        selectNodeAndShowItsPanel(() => controller.pickAt(coordinates.x, coordinates.y, { mode }));
        // A right press that did not drag picked what is under it: an object there gets its menu. It opens after
        // this release has been handled, because the release itself closes any open menu.
        if (event.button === 2 && controller.selectedNodeId) {
          const { clientX, clientY } = event;
          setTimeout(() => openObjectMenu(clientX, clientY), 0);
        }
      }
    }
  }
  viewportElement.addEventListener('pointermove', event => {
    viewportPointer = localCoordinates(event);
  });
  viewportElement.addEventListener('pointerleave', () => {
    viewportPointer = null;
  });
  documentReference.addEventListener('contextmenu', onModalContextMenu, true);
  documentReference.addEventListener('click', onModalClick, true);
  documentReference.addEventListener('pointerdown', onAnyPointerDown, true);
  viewportElement.addEventListener('pointerup', finishPointer);
  viewportElement.addEventListener('pointercancel', finishPointer);
  viewportElement.addEventListener('contextmenu', event => event.preventDefault());
  viewportElement.addEventListener('wheel', event => {
    if (!targetPassesThroughViewport(event.target, { checkScroll: true })) return;
    event.preventDefault();
    if (viewingShot()) return;
    if (faceToolInput?.handleWheel(event)) return;
    if (meshEditor?.circleSelecting) {
      meshEditor.wheelCircleBrush(event.deltaY, event.deltaMode);
      requestFrame();
      return;
    }
    if (meshEditor?.holdingMove && meshEditor.proportional?.enabled) {
      meshEditor.proportional.resize(event.deltaY < 0 ? 1 : -1);
      return;
    }
    stopFlight();
    controller.orbitCamera({ zoomScale: 1 + Math.max(-0.35, Math.min(0.35, event.deltaY * 0.0012 * (preferences.zoomDirection === 'inverted' ? -1 : 1))) });
  }, { passive: false });

  viewportElement.addEventListener('dragover', event => {
    event.preventDefault();
    viewportElement.dataset.dropActive = 'true';
  });
  viewportElement.addEventListener('dragleave', () => {
    delete viewportElement.dataset.dropActive;
  });
  viewportElement.addEventListener('drop', async event => {
    event.preventDefault();
    delete viewportElement.dataset.dropActive;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      await importFileIntoScene(file);
      return;
    }
    await openPickedFile({ text: await file.text(), fileName: file.name, filePath: file.path || null, verb: 'Loaded' });
  });

  // A slider or a switch keeps the focus after a click, but nothing is typed into it, so only the keys it moves with stay its own.
  const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  const SWITCH_KEYS = new Set([...SLIDER_KEYS, 'Enter', ' ']);
  const SWITCH_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'color']);

  function isEditableTarget(target, key) {
    const tag = target?.tagName?.toLowerCase?.();
    if (tag === 'input' && target.type === 'range') {
      return SLIDER_KEYS.has(key);
    }
    if (tag === 'input' && SWITCH_INPUT_TYPES.has(target.type)) {
      return SWITCH_KEYS.has(key);
    }
    return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
  }

  function selectedObjectIsDeletable() {
    return controller.selectedObjectKey !== null && controller.selectedObjectKey !== 'camera' && controller.selectedObjectKey !== 'sun';
  }

  function deleteSelection() {
    if (selectedObjectIsDeletable()) {
      const label = controller.listSceneObjects().find(object => object.key === controller.selectedObjectKey)?.label ?? 'light';
      controller.deleteSceneObject(controller.selectedObjectKey);
      announce(`Deleted ${label}`);
      return;
    }
    const deletedCount = controller.selectionRoots().length;
    controller.deleteSelected();
    announce(deletedCount > 1 ? `Deleted ${deletedCount} objects` : 'Deleted node');
  }

  function announceDuplicated(activeCopy) {
    const copyCount = controller.selectedNodeIds.length;
    announce(copyCount > 1 ? `Duplicated ${copyCount} objects` : `Duplicated to ${activeCopy.label}`);
  }

  function duplicateSelection() {
    if (controller.selectedNodeId) {
      const cloned = controller.duplicateSelected();
      announceDuplicated(cloned);
    }
  }

  function copySelection() {
    if (!controller.selectedNodeId) return;
    const copyCount = controller.selectedNodeIds.length;
    controller.copySelected();
    announceSuccess(copyCount > 1 ? `Copied ${copyCount} objects` : 'Copied');
  }

  function pasteCopy() {
    if (!controller.canPaste) return;
    try {
      const pasted = controller.pasteCopy();
      const pastedCount = controller.selectedNodeIds.length;
      announceSuccess(pastedCount > 1 ? `Pasted ${pastedCount} objects` : `Pasted ${pasted.label}`);
    } catch (error) {
      announceError(error.message);
    }
  }

  // Text the person selected on the page belongs to the browser's own copy.
  function pageTextIsSelected() {
    const selection = documentReference.defaultView?.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && selection.toString() !== '');
  }

  function toggleProportional() {
    const settings = meshEditor?.proportional;
    if (!settings) return;
    settings.toggle();
    announce(settings.enabled ? 'Proportional editing on' : 'Proportional editing off');
  }

  function loadMeshEditor() {
    meshEditorLoad ??= Promise.all([import('./studio-mesh-edit.js'), import('./studio-proportional.js'), import('./studio-mesh-tool.js')]).then(([{ createMeshEditor }, { createProportionalSettings, createProportionalPopover }, { createFaceToolInput }]) => {
      let proportionalPopover = null;
      const proportional = createProportionalSettings({
        onChange: () => {
          proportionalPopover?.sync();
          // A radius or curve changed while a move is held: the hill follows it under the pointer.
          meshEditor?.reweighDrag();
          syncUi();
          requestFrame();
        },
      });
      proportionalPopover = createProportionalPopover({ documentReference, settings: proportional, popoverId: PROPORTIONAL_POPOVER_ID });
      root.append(proportionalPopover.popover);
      bindPopoverAnchor(proportionalMenuButton, proportionalPopover.popover, { beside: true });
      meshEditor = createMeshEditor({ controller, announce, getRenderer: () => renderer, proportional });
      meshEditor.setSeeThrough(seeThrough);
      faceToolInput = createFaceToolInput({ documentReference, editor: meshEditor, localCoordinates, onChange: updateMeshSelectionView });
      return meshEditor;
    });
    return meshEditorLoad;
  }

  // The second Tab pressed while the editor is still loading takes the first one back.
  let meshEnterPending = false;

  // Ctrl+J: the other selected objects join the active one (the last picked), one undo step. Shapes become meshes first.
  async function joinSelection() {
    const activeId = controller.selectedNodeId;
    const otherIds = controller.selectedNodeIds.filter(nodeId => nodeId !== activeId);
    if (!activeId || otherIds.length === 0) {
      announce('Select two or more objects to join. The one picked last keeps the result.');
      return;
    }
    const { meshGeometryOfPrimitive } = await import('./studio-mesh-edit.js');
    const operations = planJoinOperations(controller.exportRecipe(), activeId, otherIds, meshGeometryOfPrimitive);
    try {
      controller.applyImportOperations(operations, { selectNodeId: activeId, detail: { kind: 'topology', nodeId: activeId } });
      announce(`Joined ${otherIds.length + 1} objects into ${activeId}`);
    } catch (error) {
      announce(error.message);
    }
  }

  function parentSelection() {
    const activeId = controller.selectedNodeId;
    const childIds = controller.selectedNodeIds.filter(nodeId => nodeId !== activeId);
    if (!activeId || childIds.length === 0) {
      announce('Select two or more objects to parent. The one picked last becomes the parent.');
      return;
    }
    try {
      const result = controller.reparentNodes(childIds, activeId);
      if (result.changed > 0) announceSuccess(`Parented ${result.changed} ${result.changed === 1 ? 'object' : 'objects'} to ${activeId}`);
    } catch (error) {
      announceError(error.message);
    }
  }

  function clearParentSelection() {
    const recipe = controller.exportRecipe();
    const byId = new Map(recipe.nodes.map(node => [node.id, node]));
    const parentedIds = controller.selectedNodeIds.filter(nodeId => byId.get(nodeId)?.parent);
    if (parentedIds.length === 0) {
      announce('Select an object with a parent to clear first.');
      return;
    }
    try {
      const result = controller.reparentNodes(parentedIds, null);
      if (result.changed > 0) announceSuccess(`Cleared parent for ${result.changed} ${result.changed === 1 ? 'object' : 'objects'}`);
    } catch (error) {
      announceError(error.message);
    }
  }

  function separateMeshSelection() {
    meshEditor?.separateSelection();
    updateMeshSelectionView();
  }

  function openSeparateMenu() {
    meshMenus.openMeshMenu(meshMenus.separatePopover);
  }

  async function enterMeshEdit() {
    if (viewingShot()) return;
    if (meshEnterPending) {
      meshEnterPending = false;
      return;
    }
    meshEnterPending = true;
    const pressedOnNodeId = controller.selectedNodeId;
    const editor = await loadMeshEditor();
    const converted = editor.conversionOf(pressedOnNodeId);
    if (converted) await loadAgentSceneModules({ geometries: [converted] }).catch(error => announceError(error.message));
    if (!meshEnterPending) return;
    meshEnterPending = false;
    // The generator code that was loaded belongs to the object Tab was pressed on: another selection by now gets nothing.
    if (editor.active || controller.selectedNodeId !== pressedOnNodeId) return;
    if (root.dataset.workspace !== 'build') selectWorkspace('build');
    editor.enter();
    updateMeshSelectionView();
  }

  function leaveMeshEdit() {
    faceToolInput?.cancel();
    if (controller.dragging) pointerState = null;
    stopWatchingCircleFocus();
    meshEditor?.leave();
    updateMeshSelectionView();
  }

  // Esc puts a drag back, else ends circle select, else clears the selection, else leaves edit mode.
  function escapeMeshEdit() {
    if (controller.dragging) {
      controller.cancelGizmoDrag();
      pointerState = null;
    } else if (meshEditor.circleSelecting) {
      endCircleSelect();
    } else if (meshEditor.boxSelecting) {
      cancelBoxSelect();
    } else if (!meshEditor.clearSelection()) {
      stopWatchingCircleFocus();
      meshEditor.leave();
    }
    updateMeshSelectionView();
  }

  // Circle select (C): left drag paints the selection, middle drag or Shift paints the deselection, the wheel
  // resizes the brush, right click or Esc ends it. The brush owns the viewport pointer until then, so the camera keys it.
  let circlePaint = null;

  // The brush also ends when the window loses focus or the page is hidden, so it is not still armed on return.
  const circleFocusWindow = documentReference.defaultView;
  let watchingCircleFocus = false;

  function endCircleSelectWhenAway() {
    if (!meshEditor?.circleSelecting) {
      stopWatchingCircleFocus();
      return;
    }
    endCircleSelect();
  }

  function endCircleSelectWhenHidden() {
    if (documentReference.hidden) endCircleSelectWhenAway();
  }

  function startWatchingCircleFocus() {
    if (watchingCircleFocus) return;
    watchingCircleFocus = true;
    circleFocusWindow?.addEventListener?.('blur', endCircleSelectWhenAway);
    documentReference.addEventListener('visibilitychange', endCircleSelectWhenHidden);
  }

  function stopWatchingCircleFocus() {
    if (!watchingCircleFocus) return;
    watchingCircleFocus = false;
    circleFocusWindow?.removeEventListener?.('blur', endCircleSelectWhenAway);
    documentReference.removeEventListener('visibilitychange', endCircleSelectWhenHidden);
  }

  function endCircleSelect() {
    stopWatchingCircleFocus();
    circlePaint = null;
    meshEditor.endCircleSelect();
    updateMeshSelectionView();
  }

  function circleSelectOwnsPointer(event) {
    if (!meshEditor?.circleSelecting || controller.dragging) return false;
    return event.target === canvas || gizmoSvg.contains(event.target);
  }

  function paintCircleAt(event, deselect) {
    const coordinates = localCoordinates(event);
    meshEditor.paintCircle(coordinates.x, coordinates.y, { deselect });
    updateMeshSelectionView();
  }

  viewportElement.addEventListener('pointerdown', event => {
    if (!circleSelectOwnsPointer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.button ?? 0;
    if (button === 2) return;
    circlePaint = { pointerId: event.pointerId, deselect: button === 1 || event.shiftKey };
    viewportElement.setPointerCapture?.(event.pointerId);
    paintCircleAt(event, circlePaint.deselect);
  }, true);

  viewportElement.addEventListener('pointermove', event => {
    if (!meshEditor?.circleSelecting) return;
    if (circlePaint) {
      paintCircleAt(event, circlePaint.deselect);
      return;
    }
    const coordinates = localCoordinates(event);
    meshEditor.moveCircle(coordinates.x, coordinates.y);
    requestFrame();
  });

  const finishCirclePaint = event => {
    if (circlePaint?.pointerId !== event.pointerId) return;
    circlePaint = null;
    viewportElement.releasePointerCapture?.(event.pointerId);
  };
  viewportElement.addEventListener('pointerup', finishCirclePaint);
  viewportElement.addEventListener('pointercancel', finishCirclePaint);

  // Box select (B): one left drag over the viewport selects what lies inside the rectangle, then the key is spent.
  let boxDrag = null;

  // Escape or B again drops a box that is being dragged, so letting go of the button afterwards selects nothing.
  function cancelBoxSelect() {
    if (boxDrag) viewportElement.releasePointerCapture?.(boxDrag.pointerId);
    boxDrag = null;
    meshEditor.endBoxSelect();
  }

  function boxRectangleOf(event) {
    const { x, y } = localCoordinates(event);
    return { left: Math.min(boxDrag.x, x), right: Math.max(boxDrag.x, x), top: Math.min(boxDrag.y, y), bottom: Math.max(boxDrag.y, y) };
  }

  viewportElement.addEventListener('pointerdown', event => {
    const ownsPointer = meshEditor?.boxSelecting && !controller.dragging && (event.button ?? 0) === 0 && (event.target === canvas || gizmoSvg.contains(event.target));
    if (!ownsPointer) return;
    event.preventDefault();
    event.stopPropagation();
    boxDrag = { ...localCoordinates(event), pointerId: event.pointerId };
    viewportElement.setPointerCapture?.(event.pointerId);
  }, true);

  viewportElement.addEventListener('pointermove', event => {
    if (boxDrag?.pointerId !== event.pointerId) return;
    meshEditor.previewBox(boxRectangleOf(event));
    requestFrame();
  });

  viewportElement.addEventListener('pointerup', event => {
    if (boxDrag?.pointerId !== event.pointerId || !meshEditor?.boxSelecting) return;
    const { left, top, right, bottom } = boxRectangleOf(event);
    boxDrag = null;
    viewportElement.releasePointerCapture?.(event.pointerId);
    meshEditor.selectInRectangle(left, top, right, bottom, { additive: event.shiftKey });
    meshEditor.endBoxSelect();
    updateMeshSelectionView();
  });

  // Right click leaves circle select instead of opening a menu.
  viewportElement.addEventListener('contextmenu', event => {
    if (!meshEditor?.circleSelecting) return;
    event.preventDefault();
    event.stopPropagation();
    endCircleSelect();
  }, true);

  // E, I, Ctrl+B and Ctrl+R hold the mesh tool at the pointer; with the pointer outside the viewport the middle stands in.
  function startFaceTool(kind) {
    if (meshEditor?.circleSelecting) endCircleSelect();
    if (meshEditor?.boxSelecting) cancelBoxSelect();
    const bounds = viewportElement.getBoundingClientRect();
    faceToolInput.start(kind, viewportPointer ?? { x: bounds.width / 2, y: bounds.height / 2 });
  }

  function updateMeshSelectionView() {
    syncUi();
    requestFrame();
  }

  function chooseMeshMode(mode) {
    meshEditor.setMode(mode);
    updateMeshSelectionView();
  }

  // Tab is also how the keyboard moves between controls, so it enters edit mode only from the page or the canvas.
  function tabBelongsToViewport(target) {
    return !target || target === documentReference || target === documentReference.body || target === documentReference.documentElement || target === canvas;
  }

  // In edit mode these keys of the normal context still work; every other one would act on the whole object.
  const MESH_EDIT_PASS_THROUGH = new Set(['edit.undo', 'edit.redo', 'file.open', 'file.save', 'file.saveAs', 'settings.open', 'help.shortcuts', 'snap.toggle', 'view.frame', 'view.front', 'view.right', 'view.top', 'view.projection', 'view.properties', 'view.agent', 'view.seeThrough']);
  const preventDefaultThen = action => event => {
    event.preventDefault();
    action(event);
  };
  const meshKeyHandlers = {
    'mesh.leave': preventDefaultThen(leaveMeshEdit),
    'mesh.escape': preventDefaultThen(escapeMeshEdit),
    'mesh.vertexMode': () => chooseMeshMode('vertex'),
    'mesh.edgeMode': () => chooseMeshMode('edge'),
    'mesh.faceMode': () => chooseMeshMode('face'),
    'mesh.deleteMenu': preventDefaultThen(() => meshMenus.openMeshMenu(meshMenus.meshDeletePopover)),
    'mesh.mergeMenu': preventDefaultThen(() => meshMenus.openMeshMenu(meshMenus.meshMergePopover)),
    'mesh.makeFace': () => {
      meshEditor.makeFace();
      updateMeshSelectionView();
    },
    // Alt+A and Ctrl+I have browser actions of their own (the menu bar, page info).
    'mesh.selectNone': preventDefaultThen(() => {
      meshEditor.selectNone();
      updateMeshSelectionView();
    }),
    'mesh.invertSelection': preventDefaultThen(() => {
      meshEditor.invertSelection();
      updateMeshSelectionView();
    }),
    'mesh.circleSelect': () => {
      if (meshEditor.circleSelecting) {
        endCircleSelect();
        return;
      }
      if (meshEditor.beginCircleSelect()) startWatchingCircleFocus();
      updateMeshSelectionView();
    },
    // L under the pointer; Ctrl+L and Ctrl+Plus or Minus have browser actions of their own (the address bar, the zoom).
    'mesh.selectLinked': () => {
      if (viewportPointer) meshEditor.selectLinkedAt(viewportPointer.x, viewportPointer.y);
      updateMeshSelectionView();
    },
    'mesh.selectLinkedSelection': preventDefaultThen(() => {
      meshEditor.selectLinkedFromSelection();
      updateMeshSelectionView();
    }),
    'mesh.growSelection': preventDefaultThen(() => {
      meshEditor.growSelection();
      updateMeshSelectionView();
    }),
    'mesh.shrinkSelection': preventDefaultThen(() => {
      meshEditor.shrinkSelection();
      updateMeshSelectionView();
    }),
    'mesh.proportional': () => toggleProportional(),
    'mesh.boxSelect': () => {
      if (meshEditor.boxSelecting) {
        cancelBoxSelect();
      } else {
        meshEditor.beginBoxSelect();
        announce('Drag a rectangle over what to select. Shift adds to the selection.');
      }
      updateMeshSelectionView();
    },
    'mesh.separate': preventDefaultThen(openSeparateMenu),
  };
  for (const kind of ['extrude', 'inset', 'bevel', 'loopCut']) {
    meshKeyHandlers[`mesh.${kind}`] = event => {
      event.preventDefault();
      startFaceTool(kind);
    };
  }

  // Handlers of the normal context by action id. A handler calls preventDefault for the keys the browser would
  // otherwise use itself (save, open, copy, undo and so on).
  const keyHandlers = {
    'tool.select': () => controller.setTool('select'),
    // Tab is also how the keyboard moves between controls, so Shift+Tab snaps only from the page or the canvas.
    // With the canvas focused, the keys go to the area under the pointer: Shift+Tab with the pointer elsewhere
    // is the browser's way back out of the canvas.
    'snap.toggle': event => {
      const canvasHasFocus = event.target === canvas;
      if (event.key === 'Tab' && (canvasHasFocus ? viewportPointer === null : !tabBelongsToViewport(event.target))) return;
      event.preventDefault();
      toggleSnapping();
    },
    'add.open': () => addMenuButton.click(),
    'edit.copy': event => {
      if (pageTextIsSelected()) return;
      event.preventDefault();
      copySelection();
    },
    'edit.paste': event => {
      if (pageTextIsSelected()) return;
      event.preventDefault();
      pasteCopy();
    },
    'edit.duplicate': (event, binding) => {
      if (binding.ctrl) event.preventDefault();
      duplicateSelection();
    },
    'edit.join': preventDefaultThen(joinSelection),
    'edit.parent': preventDefaultThen(parentSelection),
    'edit.clearParent': preventDefaultThen(clearParentSelection),
    'edit.delete': event => {
      if (!controller.selectedNodeId && !selectedObjectIsDeletable()) return;
      event.preventDefault();
      deleteSelection();
    },
    'edit.rename': preventDefaultThen(() => renameActiveObject({ byKeyboard: true })),
    'edit.deselect': () => {
      if (controller.selectedNodeId || controller.selectedObjectKey) controller.selectNode(null);
    },
    // A plain letter has no browser action to stop; Ctrl+I and Alt+A do (page info, the menu bar).
    'select.all': () => selectAllNodes(),
    'select.none': preventDefaultThen(() => controller.selectNode(null)),
    'select.invert': preventDefaultThen(invertNodeSelection),
    'edit.apply': event => {
      // Ctrl+A is also the page's select all: outside Studio, and in its text fields, the page keeps it.
      if (!selectAllEventBelongsToStudio(event)) return;
      event.preventDefault();
      if (!controller.selectedNodeId) return;
      const box = canvas.getBoundingClientRect();
      lastObjectMenuPoint = [box.left + box.width / 2, box.top + box.height / 2];
      openPopoverAt(applyMenus.applyPopover, ...lastObjectMenuPoint);
    },
    'edit.hide': (event, binding) => {
      if (binding.ctrl) event.preventDefault();
      hideSelection();
    },
    'edit.showAll': preventDefaultThen(showAllHidden),
    'edit.undo': preventDefaultThen(() => controller.undo()),
    'edit.redo': preventDefaultThen(() => controller.redo()),
    'view.frame': () => flyToSelection(),
    'view.projection': () => controller.toggleCameraProjection(),
    'view.seeThrough': preventDefaultThen(() => seeThroughButton.click()),
    'view.properties': preventDefaultThen(() => setInspectorCollapsed(root.dataset.inspectorCollapsed !== 'true')),
    'view.agent': event => {
      if (!agentPanel) return;
      event.preventDefault();
      agentPanel.toggle();
    },
    'animate.keyframe': () => keyframeButton.click(),
    'animate.play': preventDefaultThen(() => playButton.click()),
    'file.open': preventDefaultThen(performOpenFile),
    'file.save': preventDefaultThen(() => performSaveFile({ forceAs: false })),
    'file.saveAs': preventDefaultThen(() => performSaveFile({ forceAs: true })),
    'settings.open': preventDefaultThen(() => settings.open()),
    'help.shortcuts': () => showShortcutsSheet(),
    'mesh.enter': event => {
      if (!controller.selectedNodeId || !tabBelongsToViewport(event.target)) return;
      event.preventDefault();
      enterMeshEdit();
    },
  };
  for (const [actionId, tool] of Object.entries(PICK_UP_TOOL_BY_ACTION)) {
    // Blender's keys pick the object up; Maya's and Cinema 4D's only choose the tool, whose handles then appear.
    keyHandlers[actionId] = () => (keymap.toolKeysGrab ? pickUpWithTool(tool) : controller.setTool(tool));
  }
  for (const [actionId, part] of Object.entries(TRANSFORM_PART_BY_ACTION)) {
    keyHandlers[actionId] = event => {
      event.preventDefault();
      resetSelectionTransform(part);
    };
  }
  for (const [actionId, viewPreset] of Object.entries(VIEW_PRESET_BY_ACTION)) {
    keyHandlers[actionId] = () => {
      controller.setCameraViewPreset(viewPreset);
      announce(`${viewPreset[0].toUpperCase()}${viewPreset.slice(1)} view`);
    };
  }

  const onWindowKeyDown = async event => {
    if (!root.isConnected) return;
    if (faceToolInput?.handleKey(event)) return;
    if (modalTransform) {
      handleModalKey(event);
      return;
    }
    if (isEditableTarget(event.target, event.key)) return;
    // Esc or a key pressed over an open mesh menu belongs to the menu, not to edit mode.
    if (meshMenus.isOpen()) return;
    const editingMesh = Boolean(meshEditor?.active);
    const { match, fromMeshContext } = resolveStudioKeyAction(keymap, event, editingMesh, findKeymapAction, MESH_EDIT_PASS_THROUGH);
    const dialogIsOpen = recipeDialog.open || shortcutsDialog.open || settingsDialog.open || setup.dialog.open || Boolean(newSceneDialogs?.dialogs.some(dialog => dialog.open));
    if (!event.repeat && !dialogIsOpen && isNumpadKeyEvent(event) && !preferences.numberPad && !preferences.numberPadNoticeShown) {
      setPreferences({ numberPadNoticeShown: true });
      numpadNotice.show();
    }
    if (!match || (dialogIsOpen && !match.binding.ctrl)) return;
    if (shotLocksAction(match.actionId)) {
      if (match.binding.ctrl) event.preventDefault();
      return;
    }
    if (fromMeshContext) {
      meshKeyHandlers[match.actionId](event, match.binding);
      return;
    }
    if (editingMesh && !MESH_EDIT_PASS_THROUGH.has(match.actionId)) {
      if (match.binding.ctrl) event.preventDefault();
      return;
    }
    keyHandlers[match.actionId](event, match.binding);
  };
  // The last kind of input decides whether a menu animates: a menu opened from the keyboard is a shortcut and appears at once.
  // One keydown listener serves both, so the page keeps the single listener it always had.
  const onKeyDown = event => {
    blockPageSelectAll(event);
    if (!isModifierKey(event.key)) root.dataset.input = 'keyboard';
    if (event.key === 'Control' && !event.repeat) replayDragWithCtrl(true);
    onWindowKeyDown(event);
  };
  const onKeyUp = event => {
    if (event.key === 'Control') replayDragWithCtrl(false);
  };
  const onPointerInput = event => {
    root.dataset.input = 'pointer';
    pointerStartedInStudio = (event.composedPath?.() ?? []).includes(root);
  };
  // Select all is Studio's own, never the browser's: outside a text field it would highlight the page, in any mode and over any dialog.
  // Studio can sit inside someone else's page, so the host page keeps select all unless the event comes from Studio: its root is on the
  // event's path (composedPath also sees through a shadow root), or focus fell to the body after the last click landed in Studio.
  // A text field or an opted-in block anywhere on the path keeps it for its own text.
  let pointerStartedInStudio = false;
  const blockPageSelectAll = event => {
    const isLetterA = event.key?.toLowerCase() === 'a' || event.code === 'KeyA';
    const isSelectAll = isLetterA && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (!isSelectAll || !selectAllEventBelongsToStudio(event)) return;
    event.preventDefault();
  };
  function selectAllEventBelongsToStudio(event) {
    if (!root.isConnected) return false;
    const path = event.composedPath?.() ?? [event.target];
    const focusFellToBody = path[0] === documentReference.body && pointerStartedInStudio;
    if (!path.includes(root) && !focusFellToBody) return false;
    return !path.some(node => isEditableTarget(node, 'a') || node?.closest?.('.crucible-studio-selectable'));
  }
  documentReference.addEventListener('keydown', onKeyDown);
  documentReference.addEventListener('keyup', onKeyUp);
  documentReference.defaultView?.addEventListener?.('blur', onWindowBlur);
  documentReference.addEventListener('pointerdown', onPointerInput, true);

  const onVisibilityChange = () => {
    if (!documentReference.hidden && isVisible) requestFrame();
  };
  documentReference.addEventListener('visibilitychange', onVisibilityChange);

  function setOutlinerCollapsed(collapsed) {
    root.dataset.outlinerCollapsed = collapsed ? 'true' : 'false';
    toggleDocksButton.setAttribute('aria-pressed', root.dataset.outlinerCollapsed === 'false' || root.dataset.inspectorCollapsed === 'false' ? 'true' : 'false');
    requestFrame();
  }

  function setInspectorCollapsed(collapsed) {
    root.dataset.inspectorCollapsed = collapsed ? 'true' : 'false';
    if (!collapsed && root.dataset.compact === 'true' && historyShown) setHistoryShown(false, { remember: false });
    if (!collapsed && agentPanel?.takesTurns && agentPanel.shown) agentPanel.setShown(false, { remember: false });
    toggleDocksButton.setAttribute('aria-pressed', root.dataset.outlinerCollapsed === 'false' || root.dataset.inspectorCollapsed === 'false' ? 'true' : 'false');
    requestFrame();
  }

  // The draft follows the edits a moment after they stop. The first edit made while the notice offers the older draft
  // answers it: the person carries on with the current scene, so the notice closes and the draft follows the new work.
  let draftTimer = 0;

  function writeDraftNow() {
    draftTimer = 0;
    saveStudioDraft(preferenceStorage, controller.exportRecipe(), activeFileName, {
      workspace: root.dataset.workspace,
      activeTab: controller.activeTab,
    });
  }

  function scheduleDraftSave() {
    if (draftNotice.visible) {
      draftNotice.hide();
      announce('Kept your current scene; the older draft was replaced by your new edits');
    }
    if (draftTimer) return;
    draftTimer = setTimeout(writeDraftNow, DRAFT_SAVE_DELAY_MILLISECONDS);
  }

  // A window that closes or goes to the background may never run the timer, so the edit still waiting is written at once.
  function flushDraftSave() {
    if (!draftTimer) return;
    clearTimeout(draftTimer);
    writeDraftNow();
  }
  const flushDraftWhenHidden = () => {
    if (documentReference.hidden) flushDraftSave();
  };
  documentReference.addEventListener('visibilitychange', flushDraftWhenHidden);
  documentReference.defaultView?.addEventListener?.('pagehide', flushDraftSave);

  // Forgets the draft: the scene was saved, or the person chose another scene on purpose.
  function discardDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    clearStudioDraft(preferenceStorage);
    draftNotice.hide();
  }

  async function restoreDraft() {
    const draft = loadStudioDraft(preferenceStorage);
    draftNotice.hide();
    if (!draft) return;
    try {
      await prepareRecipe(draft.recipe);
      controller.loadRecipe(draft.recipe);
      if (draft.workspace && workspaces.some(workspace => workspace.id === draft.workspace)) {
        const targetWorkspace = workspaces.find(workspace => workspace.id === draft.workspace);
        const targetTab = draft.activeTab && targetWorkspace.tabs.includes(draft.activeTab) ? draft.activeTab : targetWorkspace.tabs[0];
        selectWorkspace(targetWorkspace.id, targetTab);
      }
      isDirty = true;
      syncFileBanner();
      announceSuccess('Restored the unsaved changes');
    } catch (error) {
      clearStudioDraft(preferenceStorage);
      announceError(`The saved draft could not be restored: ${error.message}`);
    }
  }

  function offerDraft() {
    const draft = loadStudioDraft(preferenceStorage);
    if (draft && draftDiffersFrom(draft, controller.exportRecipe())) {
      draftNotice.show(draft.fileName);
    }
  }

  handleChange = detail => {
    bakeMark.show(controller.bakePending);
    // The deferred near-coplanar search settled (#2905): the parts to draw changed with no edit, so the idle viewport redraws once.
    if (detail.kind === 'flush') {
      requestFrame();
      return;
    }
    if (meshEditor?.active && ['undo', 'redo', 'load', 'topology', 'selection', 'pick'].includes(detail.kind)) {
      meshEditor.refresh();
    }
    selectionReadoutStale = true;
    if (activeNameEditor?.isStale()) cancelNameEditing();
    if (detail.kind === 'load') {
      sceneLoadedSinceFloorFit = true;
    }
    // The object a key is holding is gone or no longer the selection: let go without touching the new scene.
    if (modalTransform && modalTransform.axis && !controller.dragging) {
      finishModalTransform(false);
    }
    if (detail.deltaLabel !== undefined) {
      liveDeltaLabel = detail.deltaLabel;
    }
    if (['topology', 'transform', 'transformCommit', 'motion', 'material', 'look', 'bookmark', 'undo', 'redo'].includes(detail.kind) || (detail.kind === 'camera' && detail.edited)) {
      isDirty = true;
      scheduleDraftSave();
    }
    syncUi();
    if (detail.kind === 'tab' || insideDraw) return;
    requestFrame();
  };

  // Below the compact width the panels start closed, so the scene keeps the screen.
  function syncCompactLayout() {
    const compact = root.clientWidth > 0 && root.clientWidth < COMPACT_WIDTH;
    if ((root.dataset.compact === 'true') === compact) {
      return;
    }
    root.dataset.compact = compact ? 'true' : 'false';
    setOutlinerCollapsed(compact);
    setInspectorCollapsed(compact);
    setHistoryShown(compact ? false : preferences.historyVisible, { remember: false });
  }
  syncCompactLayout();
  agentPanel?.syncRoom();

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      syncCompactLayout();
      agentPanel?.syncRoom();
      refitHistoryList();
      refitTreeToWholeRows();
      requestFrame();
    });
    resizeObserver.observe(viewportElement);
    resizeObserver.observe(outlinerTree);
  }
  documentReference.fonts?.addEventListener?.('loadingdone', refitTreeToWholeRows);
  documentReference.defaultView?.addEventListener?.('resize', refitTreeToWholeRows);
  if (typeof IntersectionObserver === 'function') {
    intersectionObserver = new IntersectionObserver(entries => {
      isVisible = entries.some(entry => entry.isIntersecting);
      if (isVisible) requestFrame();
    }, { threshold: 0.01 });
    intersectionObserver.observe(viewportElement);
  }

  // Initial Draw
  syncUi();
  renderPass();

  const ready = pendingRecipe
    ? prepareRecipe(pendingRecipe).then(() => {
      controller.loadRecipe(pendingRecipe, { recordUndo: false });
      isDirty = false;
      syncFileBanner();
    }).catch(error => {
      announceError(error.message);
      throw error;
    })
    : Promise.resolve();
  // A host that does not await `ready` still sees the reason in the status line.
  ready.catch(() => {});
  ready.then(offerDraft, () => {});

  return {
    get controller() { return controller; },
    get scene() { return controller.scene; },
    get renderer() { return renderer; },
    get dirty() { return isDirty; },
    /** Settles when the recipe createStudio was given is on screen; it waits only for a recipe that names catalog files. */
    ready,
    exportRecipe: () => controller.exportRecipe(),
    /** What went wrong and what was slow, in numbers and messages only: never the recipe, node names or file names. */
    diagnostics: {
      report: () => studioDiagnostics.report(),
      entries: () => studioDiagnostics.entries(),
    },
    /** Synchronous: the recipe's catalog files must be loaded already. `openRecipe` loads them first. */
    loadRecipe: (recipeInput, options) => controller.loadRecipe(recipeInput, options),
    async openRecipe(recipeInput, options) {
      await prepareRecipe(recipeInput);
      return controller.loadRecipe(recipeInput, options);
    },
    loadExternalTextFile,
    showAgentEdit,
    setGridVisible,
    get gridVisible() { return gridVisible; },
    setSeeThrough,
    get seeThrough() { return seeThrough; },
    setPreference,
    get preferences() { return { ...preferences }; },
    /** Opens the first-run setup, one step a page. Studio never opens it on its own. */
    openSetup,
    /** Opens the New scene chooser, as File > New scene does. Resolves when the chosen scene is on screen, or the person cancelled. */
    openNewScene,
    get setupDone() { return preferences.setupDone; },
    selectNode: nodeId => controller.selectNode(nodeId),
    setTool: tool => controller.setTool(tool),
    get activeWorkspace() { return root.dataset.workspace; },
    setWorkspace: (workspace, tab) => selectWorkspace(workspace, tab),
    setActiveTab: tab => selectInspectorTab(tab),
    pickAt: (pixelX, pixelY, options) => controller.pickAt(pixelX, pixelY, options),
    selectNodes: (nodeIds, options) => controller.selectNodes(nodeIds, options),
    selectAll: () => controller.selectAll(),
    invertSelection: () => controller.invertSelection(),
    get selectedNodeIds() { return controller.selectedNodeIds; },
    setOutlinerCollapsed,
    setInspectorCollapsed,
    capturePngDataUrl,
    exportGlbBytes,
    buildWebPackPayload,
    shouldAutoReloadExternal() {
      return autoReloadWatch;
    },
    setFileContext({ filePath, fileName, dirty }) {
      if (filePath !== undefined || fileName !== undefined) {
        cancelNameEditing();
        renameWaitsForSave = false;
      }
      if (filePath !== undefined) activeFilePath = filePath;
      if (fileName !== undefined) {
        activeFileName = fileName;
        activeFileSuffix = extensionOf(fileName);
      }
      if (dirty !== undefined) isDirty = Boolean(dirty);
      syncFileBanner();
    },
    renderNow() {
      renderPass();
    },
    dispose() {
      clearTimeout(draftTimer);
      clearTimeout(statusTimer);
      clearTimeout(statusExitTimer);
      clearTimeout(awaitedProgramTimer);
      agentPresence.dispose();
      agentPanel?.dispose();
      settings.dispose();
      systemSchemeQuery?.removeEventListener?.('change', onSystemSchemeChange);
      if (frameHandle) cancelAnimationFrame(frameHandle);
      stopFlight();
      finishModalTransform(false);
      stopWatchingCircleFocus();
      faceToolInput?.dispose();
      documentReference.removeEventListener('contextmenu', onModalContextMenu, true);
      documentReference.removeEventListener('click', onModalClick, true);
      documentReference.removeEventListener('pointerdown', onAnyPointerDown, true);
      documentReference.removeEventListener('keydown', onKeyDown);
      documentReference.removeEventListener('keyup', onKeyUp);
      documentReference.defaultView?.removeEventListener?.('blur', onWindowBlur);
      documentReference.removeEventListener('pointerdown', onPointerInput, true);
      documentReference.removeEventListener('visibilitychange', onVisibilityChange);
      documentReference.removeEventListener('visibilitychange', flushDraftWhenHidden);
      documentReference.defaultView?.removeEventListener?.('pagehide', flushDraftSave);
      stopWatchingContextLoss();
      stopWatchingDiagnostics();
      pausedNotice.hide();
      documentReference.fonts?.removeEventListener?.('loadingdone', refitTreeToWholeRows);
      documentReference.defaultView?.removeEventListener?.('resize', refitTreeToWholeRows);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      controller.dispose();
      outlineMask.dispose();
      activeOutlineMask.dispose();
      renderer?.dispose();
      catalog.dispose();
      root.remove();
    },
  };
}
