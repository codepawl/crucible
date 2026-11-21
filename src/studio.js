import { CRUCIBLE_MARK_LAYERS, CRUCIBLE_MARK_VIEW_BOX } from './studio-brand-mark.js';
import { applyProjection } from './camera.js';
import { createAgentScene, loadAgentSceneModules } from './agent-scene.js';
import { agentEnvironmentMap, fitAgentShadow, resolveAgentShadow } from './agent-look.js';
import { agentSceneModulesNeeded } from './agent-scene-modules.js';
import { LIGHTING_SETUP_NAMES } from './agent-scene-capabilities.js';
import { VIEW_TRANSFORM_NAMES } from './view-transform-names.js';
import { CrucibleRenderer, studioFloorHeight } from './renderer.js';
import { exportGlb } from './export.js';
import { encodePack } from './scene-pack-format.js';
import { encodePackOrRefuse } from './studio-pack-refusal.js';
import { PACK_SHADER_MODULES, PACK_UNSUPPORTED_MODULES } from './scene-pack-shaders.js';
import { STUDIO_CSS } from './studio-styles.js';
import { findKeymapAction, formatShortcutKeys, keyLabel, resolveKeymap, SHORTCUT_ROWS } from './studio-keymap.js';
import { createStudioCatalog } from './studio-catalog.js';
import { createStudioSetup } from './studio-setup.js';
import { detectStudioHardware, gatherStudioHardwareInputs, rendererChangeFor, resolveStudioPerformanceTier, studioViewportSettingsFor } from './studio-hardware.js';
import {
  STUDIO_GIZMO_PIXELS,
  STUDIO_PREFERENCE_CHOICES,
  STUDIO_PREFERENCE_DEFAULTS,
  loadStudioPreferences,
  normalizeStudioPreferences,
  saveStudioPreferences,
} from './studio-preferences.js';
import { createPanelGrips } from './studio-panel-grips.js';
import { studioIconPath } from './studio-icons.js';
import { createPropertyLine, createPropertyPanel } from './studio-property-panel.js';
import { cameraFocalLengthMillimetres, choiceDisplayLabel } from './studio-properties.js';
import { AXIS_COLORS, buildGridParts, cameraVisibleHeight, createViewWidget, describeBounds, describeCamera, describeGridStep, gridLayout, placeGridParts, viewportClipPlanes, viewportFloorPart } from './studio-viewport-aids.js';
// The grid is textured, and replaceParts takes a textured part only with this module loaded.
import './replace-textured-parts.js';
import { clearStudioDraft, createDraftNotice, DRAFT_SAVE_DELAY_MILLISECONDS, draftDiffersFrom, loadStudioDraft, saveStudioDraft } from './studio-draft.js';
import { CONTEXT_LOST_MESSAGE, createPausedPictureNotice, describeFrameFailure, watchContextLoss } from './studio-context-loss.js';
import { assertAgentName, createAgentPresence, DEFAULT_AGENT_NAME, describeAgentEdit, diffRecipeNodes } from './studio-agent-presence.js';
import {
  STUDIO_LENS_PRESETS,
  STUDIO_MATERIAL_PRESETS,
  STUDIO_PRIMITIVE_GROUPS,
  STUDIO_PRIMITIVES,
  primitiveGeometrySpec,
  STUDIO_TABS,
  STUDIO_TEMPLATES,
  STUDIO_TOOLS,
  STUDIO_VIEW_PRESETS,
  buildTemplateRecipe,
} from './studio-templates.js';
import {
  createStudioController,
  hasAnimatedData,
  linearRgbToHex,
  quaternionToEulerDegrees,
  roundValue,
} from './studio-controller.js';

export {
  STUDIO_LENS_PRESETS,
  STUDIO_MATERIAL_PRESETS,
  STUDIO_PRIMITIVE_GROUPS,
  STUDIO_PRIMITIVES,
  STUDIO_TABS,
  STUDIO_TEMPLATES,
  STUDIO_TOOLS,
  STUDIO_VIEW_PRESETS,
  buildTemplateRecipe,
  createStudioController,
};

const AXIS_NAMES = Object.freeze(['x', 'y', 'z']);
const DEGREE_PRECISION = 100;
const ROUND_PRECISION = 10000;
const LENS_CHIP_TOLERANCE_MILLIMETRES = 0.5;
// A view chip is active while the camera looks along its direction, within about two degrees; a free orbit matches none.
const VIEW_CHIP_DIRECTIONS = Object.freeze({ front: [0, 0, 1], right: [1, 0, 0], top: [0.002, 1, 0.002], isometric: [1, 0.72, 1] });
const VIEW_CHIP_MINIMUM_COSINE = 0.9995;
// A tree row is 28px high with a 1px gap; the Scene list stretches its rows a little so a whole number of them fills it.
const TREE_ROW_GAP_PIXELS = 1;

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
// The work runs left to right: build the scene, give it its look, then set it in motion. Each workspace shows only the
// panels its step needs.
const STUDIO_WORKSPACES = Object.freeze([
  Object.freeze({ id: 'build', label: 'Build', icon: 'node', tabs: Object.freeze(['node']) }),
  Object.freeze({ id: 'look', label: 'Look', icon: 'material', tabs: Object.freeze(['material', 'look']) }),
  Object.freeze({ id: 'animate', label: 'Animate', icon: 'play', tabs: Object.freeze(['camera', 'node']) }),
]);
const DEFAULT_CLEARCOAT_ROUGHNESS = 0.08;
const PRIMITIVE_LABELS =Object.freeze({ icoSphere: 'Icosphere' });
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
  style.textContent = STUDIO_CSS;
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
  icon.append(createSvgElement(documentReference, 'path', { d: studioIconPath(iconName) }));
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

function createVectorRow(documentReference, title, onInput, { sensitivity = 0.02, minimumComponent = -Infinity, lockToggle = null, axisNames = AXIS_NAMES, accessibleTitle = title, onGestureStart, onGestureEnd } = {}) {
  let latestValues = axisNames.map(() => 0);
  let locked = false;
  let disabled = false;
  const inputs = axisNames.map(axis => createElement(documentReference, 'input', {
    type: 'number',
    step: '0.05',
    attributes: { 'aria-label': `${accessibleTitle} ${axis.toUpperCase()}` },
  }));

  function emitEditedAxis(axisIndex, rawNumeric) {
    const clamped = Math.max(minimumComponent, rawNumeric);
    if (locked && latestValues[axisIndex] > 0) {
      const ratio = clamped / latestValues[axisIndex];
      const scaled = latestValues.map(component => Math.max(minimumComponent, component * ratio));
      onInput(scaled, axisIndex);
      return;
    }
    const parsed = inputs.map((field, index) => (index === axisIndex ? clamped : Number(field.value)));
    if (parsed.every(Number.isFinite)) {
      onInput(parsed, axisIndex);
    }
  }

  inputs.forEach((input, axisIndex) => {
    input.addEventListener('change', () => {
      const numeric = Number(input.value);
      if (Number.isFinite(numeric)) {
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
      scrubState = { startX: event.clientX, startValue: Number(inputs[axisIndex].value) || 0 };
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
        input.value = String(roundValue(values[index] ?? 0, precision));
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
const SILHOUETTE_EDGE_PIXELS = 1.5;

// Draws the edge of the selected object's shape on screen: the triangles are filled as one shape, and a filter keeps
// only the ring just outside it, so no line crosses the inside of the object.
function appendSelectionSilhouette(documentReference, gizmoSvg, triangles) {
  const filterId = gizmoSvg.getAttribute('data-silhouette-filter') ?? SILHOUETTE_FILTER_ID;
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
  const margin = SILHOUETTE_EDGE_PIXELS + 2;
  const filter = createSvgElement(documentReference, 'filter', {
    id: filterId,
    filterUnits: 'userSpaceOnUse',
    x: (left - margin).toFixed(1),
    y: (top - margin).toFixed(1),
    width: (right - left + margin * 2).toFixed(1),
    height: (bottom - top + margin * 2).toFixed(1),
  });
  filter.append(
    createSvgElement(documentReference, 'feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: SILHOUETTE_EDGE_PIXELS, result: 'grown' }),
    createSvgElement(documentReference, 'feComposite', { in: 'grown', in2: 'SourceAlpha', operator: 'out', result: 'edge' }),
    createSvgElement(documentReference, 'feFlood', { class: 'crucible-studio-silhouette-colour', result: 'colour' }),
    createSvgElement(documentReference, 'feComposite', { in: 'colour', in2: 'edge', operator: 'in' }),
  );
  const definitions = createSvgElement(documentReference, 'defs');
  definitions.append(filter);
  gizmoSvg.append(definitions, createSvgElement(documentReference, 'path', {
    class: 'crucible-studio-selection-silhouette',
    d: pathData,
    filter: `url(#${filterId})`,
  }));
}

// How far from a handle a press still takes it, in pixels: the drawn handle stays thin, the area that answers is wide.
const GIZMO_HIT_LINE_WIDTH = 22;
const GIZMO_HIT_TIP_RADIUS = 16;
const GIZMO_HIT_ORIGIN_RADIUS = 13;

// The unseen areas go in first, so every drawn handle lies above them and a press on a drawn handle is still its own.
function appendGizmoHitAreas(documentReference, gizmoSvg, handles, tool) {
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
  for (const axis of AXIS_NAMES) {
    const tip = handles.axes[axis];
    if (!tip.visible) continue;
    gizmoSvg.append(
      createSvgElement(documentReference, 'line', {
        x1: origin.x.toFixed(1),
        y1: origin.y.toFixed(1),
        x2: tip.x.toFixed(1),
        y2: tip.y.toFixed(1),
        'stroke-linecap': 'round',
        ...hitAttributes(axis),
      }),
      hitDisc(tip, GIZMO_HIT_TIP_RADIUS, axis),
    );
  }
  gizmoSvg.append(hitDisc(origin, GIZMO_HIT_ORIGIN_RADIUS, tool === 'scale' ? 'uniform' : tool === 'snap' ? 'surface' : 'screen'));
}

function renderGizmoMarkup(documentReference, gizmoSvg, controller) {
  gizmoSvg.replaceChildren();
  const width = controller.viewportWidth;
  const height = controller.viewportHeight;
  gizmoSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const silhouette = controller.selectionSilhouette();
  const outline = silhouette ? null : controller.selectionOutline();
  if (silhouette) {
    appendSelectionSilhouette(documentReference, gizmoSvg, silhouette);
  } else if (outline) {
    gizmoSvg.append(createSvgElement(documentReference, 'polygon', {
      class: 'crucible-studio-selection-outline',
      points: outline.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' '),
    }));
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
    appendGizmoHitAreas(documentReference, gizmoSvg, handles, tool);
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

  if (tool === 'translate') {
    const planeColors = { xy: '#5ea8ff', xz: '#5fc48a', yz: '#ee7a6c' };
    for (const planeAxis of ['xy', 'xz', 'yz']) {
      const corners = handles.planes[planeAxis];
      if (!corners || corners.some(point => !point.visible)) continue;
      gizmoSvg.append(createSvgElement(documentReference, 'polygon', {
        points: corners.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
        fill: planeColors[planeAxis],
        'fill-opacity': '0.24',
        stroke: planeColors[planeAxis],
        'stroke-width': '1.2',
        'data-gizmo-axis': planeAxis,
      }));
    }
  }

  for (const axis of AXIS_NAMES) {
    const tip = handles.axes[axis];
    if (!tip.visible) continue;
    gizmoSvg.append(createSvgElement(documentReference, 'line', {
      x1: origin.x.toFixed(1),
      y1: origin.y.toFixed(1),
      x2: tip.x.toFixed(1),
      y2: tip.y.toFixed(1),
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
      const arrowPoints = tool === 'translate' ? arrowHeadPoints(origin, tip) : null;
      const handleAttributes = { fill: AXIS_COLORS[axis], stroke: 'none', 'stroke-linejoin': 'round', 'data-gizmo-axis': axis };
      gizmoSvg.append(arrowPoints
        ? createSvgElement(documentReference, 'polygon', { points: arrowPoints, 'data-gizmo-shape': 'arrow', ...handleAttributes })
        : createSvgElement(documentReference, 'circle', { cx: tip.x.toFixed(1), cy: tip.y.toFixed(1), r: '7', ...handleAttributes }));
    }
  }

  gizmoSvg.append(createSvgElement(documentReference, 'circle', {
    cx: origin.x.toFixed(1),
    cy: origin.y.toFixed(1),
    r: '6.5',
    fill: tool === 'snap' ? '#5fc48a' : 'var(--studio-text)',
    stroke: 'var(--studio-bg)',
    'stroke-width': '2',
    'data-gizmo-axis': tool === 'scale' ? 'uniform' : tool === 'snap' ? 'surface' : 'screen',
  }));
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
    for (const envField of ['sky', 'hdri', 'spotLights', 'areaLights', 'shadowCascades', 'sunAngularRadius', 'lines']) {
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
const MODAL_AXIS_BY_ACTION = Object.freeze({ 'modal.axisX': 'x', 'modal.axisY': 'y', 'modal.axisZ': 'z' });
const MODAL_TOOL_BY_ACTION = Object.freeze({ 'modal.translate': 'translate', 'modal.rotate': 'rotate', 'modal.scale': 'scale' });
const PICK_UP_TOOL_BY_ACTION = Object.freeze({ 'tool.translate': 'translate', 'tool.rotate': 'rotate', 'tool.scale': 'scale' });
const MODAL_FREE_AXIS = Object.freeze({ translate: 'screen', scale: 'uniform' });
const MODAL_TOOL_WORDS = Object.freeze({ translate: 'Move', rotate: 'Rotate', scale: 'Scale' });
const TRANSFORM_PART_BY_ACTION = Object.freeze({ 'edit.resetPosition': 'translation', 'edit.resetRotation': 'rotation', 'edit.resetScale': 'scale' });
const TRANSFORM_AT_REST = Object.freeze({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const TRANSFORM_PART_WORDS = Object.freeze({ translation: 'Position', rotation: 'Rotation', scale: 'Scale' });
const VIEW_PRESET_BY_ACTION = Object.freeze({ 'view.front': 'front', 'view.right': 'right', 'view.top': 'top' });

// One row of the Settings dialog each: the preference, what the row is called and, for a choice, how a value reads.
const STUDIO_SETTING_ROWS = Object.freeze([
  ['moveSnapStep', 'Move snap step', value => `${value} m`],
  ['rotateSnapDegrees', 'Rotate snap angle', value => `${value}°`],
  ['gizmoSize', 'Handle size', value => value[0].toUpperCase() + value.slice(1)],
  ['startWorkspace', 'Open in', value => value[0].toUpperCase() + value.slice(1)],
  ['theme', 'Theme', value => value[0].toUpperCase() + value.slice(1)],
  ['performance', 'Performance', value => value[0].toUpperCase() + value.slice(1)],
  ['gridVisible', 'Grid'],
  ['readoutVisible', 'Camera and size readout'],
  ['viewWidgetVisible', 'Axis widget'],
  ['agentCursorVisible', 'Agent cursor'],
  ['panelsFloating', 'Floating panels'],
]);

function browserPreferenceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
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
} = {}) {
  const catalog = createStudioCatalog(catalogHooks);
  let preferences = normalizeStudioPreferences({ ...loadStudioPreferences(preferenceStorage), ...suppliedPreferences });
  if (!container || typeof container.append !== 'function') {
    throw new TypeError('createStudio requires a DOM container element.');
  }
  const documentReference = container.ownerDocument;
  const defaultAgentName = assertAgentName(initialAgentName);
  injectStudioStyles(documentReference);

  // A recipe with catalog scans or an HDRI needs its files fetched first. Studio opens on the template meanwhile and
  // swaps the recipe in when `ready` settles, so createStudio itself stays synchronous.
  const pendingRecipe = suppliedRecipe && !suppliedScene && catalog.needsLoading(suppliedRecipe) ? suppliedRecipe : null;
  const initialRecipe = pendingRecipe ? buildTemplateRecipe(template) : suppliedRecipe ?? (suppliedScene ? null : buildTemplateRecipe(template));
  const initialScene = suppliedScene ?? createAgentScene(initialRecipe);
  let handleChange = () => {};
  const controller = createStudioController({ scene: initialScene, assets: catalog.pool, onChange: detail => handleChange(detail) });

  async function prepareRecipe(recipe) {
    await loadAgentSceneModules(recipe);
    await catalog.prepare(recipe);
  }

  let activeFilePath = initialWatchedPath;
  let activeFileName = initialFileName;
  let isDirty = false;
  let autoReloadWatch = true;
  let renderer = suppliedRenderer ?? null;
  let rendererHasDepth = false;
  let renderedScene = initialScene;
  let renderedTopology = initialScene.topologyRevision;
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
  let pointerState = null;
  let viewportPointer = null;
  let modalTransform = null;
  let swallowContextMenu = false;
  let swallowClick = false;
  let statusTimer = 0;
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
  const filePill = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-filepill', textContent: activeFileName, attributes: { popovertarget: 'crucible-studio-pop-new' } });
  const watchPill = createElement(documentReference, 'span', {
    className: 'crucible-studio-watch-pill',
    hidden: !activeFilePath,
    title: 'Reloads when the agent edits this file',
    attributes: { role: 'img', 'aria-label': 'Reloads when the agent edits this file' },
  });
  const keymap = resolveKeymap();
  const openButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Open…', dataset: { shortcut: keyLabel(keymap, 'file.open') } });
  const saveButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Save', dataset: { shortcut: keyLabel(keymap, 'file.save') } });
  const saveAsButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Save as…', dataset: { shortcut: keyLabel(keymap, 'file.saveAs') } });
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
  // One row of a menu: its icon, what it does, and its key on the right.
  const createMenuItem = (label, shortcut, onChoose, iconName) => {
    const item = createElement(documentReference, 'button', { type: 'button', textContent: label, dataset: shortcut ? { shortcut } : {} });
    item.addEventListener('click', onChoose);
    return giveMenuIcon(item, iconName);
  };
  const menuToggles = [];
  const syncMenuToggles = () => menuToggles.forEach(({ item, isOn }) => item.setAttribute('aria-checked', isOn() ? 'true' : 'false'));
  const createMenuToggle = (label, shortcut, onChoose, isOn, iconName) => {
    const item = createMenuItem(label, shortcut, () => {
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
  const fileMenuButton = createMenuButton('File', 'crucible-studio-pop-new');
  const editMenuButton = createMenuButton('Edit', 'crucible-studio-pop-edit');
  const viewMenuButton = createMenuButton('View', 'crucible-studio-pop-view');
  const aiSyncMenuButton = createMenuButton('Agent', 'crucible-studio-pop-sync', { 'aria-label': 'Work with an AI agent' });
  const helpMenuButton = createMenuButton('Help', 'crucible-studio-pop-help');
  const showView = presetName => {
    controller.setCameraViewPreset(presetName);
    announce(`${presetName[0].toUpperCase()}${presetName.slice(1)} view`);
  };
  const editPopover = createMenuPopover(
    'crucible-studio-pop-edit',
    createMenuItem('Undo', keyLabel(keymap, 'edit.undo'), () => undoButton.click(), 'undo'),
    createMenuItem('Redo', keyLabel(keymap, 'edit.redo'), () => redoButton.click(), 'redo'),
    createMenuItem('Copy', keyLabel(keymap, 'edit.copy'), () => copySelection(), 'duplicate'),
    createMenuItem('Paste', keyLabel(keymap, 'edit.paste'), () => pasteCopy(), 'duplicate'),
    createMenuItem('Duplicate', keyLabel(keymap, 'edit.duplicate'), () => duplicateSelection(), 'duplicate'),
    createMenuItem('Delete', keyLabel(keymap, 'edit.delete'), () => deleteButton.click(), 'remove'),
    createMenuItem('Deselect', keyLabel(keymap, 'edit.deselect'), () => controller.selectNode(null)),
    createMenuItem('Hide', keyLabel(keymap, 'edit.hide'), () => hideSelection(), 'eyeOff'),
    createMenuItem('Show all', keyLabel(keymap, 'edit.showAll'), () => showAllHidden(), 'eye'),
    createMenuItem('Reset position', keyLabel(keymap, 'edit.resetPosition'), () => resetSelectionTransform('translation'), 'translate'),
    createMenuItem('Reset rotation', keyLabel(keymap, 'edit.resetRotation'), () => resetSelectionTransform('rotation'), 'rotate'),
    createMenuItem('Reset scale', keyLabel(keymap, 'edit.resetScale'), () => resetSelectionTransform('scale'), 'scale'),
    createMenuItem('Settings…', keyLabel(keymap, 'settings.open'), () => settingsDialog.showModal(), 'settings'),
  );
  // A right click on an object, in the viewport or in the Scene list, opens the actions on that object where the
  // pointer is. The rows are the Edit menu's own, so a key learned in one place works in the other.
  const objectPopover = createMenuPopover(
    'crucible-studio-pop-object',
    createMenuItem('Frame', keyLabel(keymap, 'view.frame'), () => flyToSelection(), 'frame'),
    createMenuItem('Duplicate', keyLabel(keymap, 'edit.duplicate'), () => duplicateSelection(), 'duplicate'),
    createMenuItem('Hide', keyLabel(keymap, 'edit.hide'), () => hideSelection(), 'eyeOff'),
    createMenuItem('Reset position', keyLabel(keymap, 'edit.resetPosition'), () => resetSelectionTransform('translation'), 'translate'),
    createMenuItem('Reset rotation', keyLabel(keymap, 'edit.resetRotation'), () => resetSelectionTransform('rotation'), 'rotate'),
    createMenuItem('Reset scale', keyLabel(keymap, 'edit.resetScale'), () => resetSelectionTransform('scale'), 'scale'),
    createMenuItem('Delete', keyLabel(keymap, 'edit.delete'), () => deleteButton.click(), 'remove'),
  );
  function openObjectMenu(clientX, clientY) {
    const windowWidth = documentReference.defaultView?.innerWidth ?? 1280;
    const windowHeight = documentReference.defaultView?.innerHeight ?? 800;
    objectPopover.togglePopover?.(false);
    objectPopover.style.left = `${Math.round(Math.max(8, Math.min(clientX, windowWidth - 256)))}px`;
    objectPopover.style.right = 'auto';
    // In the lower half the menu hangs from the pointer and grows upward, so it stays on screen at any height.
    const opensUpward = clientY > windowHeight / 2;
    objectPopover.style.top = opensUpward ? 'auto' : `${Math.round(clientY)}px`;
    objectPopover.style.bottom = opensUpward ? `${Math.round(Math.max(8, windowHeight - clientY))}px` : 'auto';
    objectPopover.showPopover?.();
  }
  function hideSelection() {
    if (!controller.selectedNodeId) return;
    controller.updateNodeTransform(controller.selectedNodeId, { visible: false });
    announce(`Hidden. ${keyLabel(keymap, 'edit.showAll')} shows everything again`);
  }
  function showAllHidden() {
    const hiddenNodes = controller.exportRecipe().nodes.filter(node => node.visible === false);
    if (hiddenNodes.length === 0) {
      announce('Nothing is hidden');
      return;
    }
    controller.beginUndoGroup();
    for (const node of hiddenNodes) {
      controller.updateNodeTransform(node.id, { visible: true });
    }
    controller.endUndoGroup();
    announce(`Showing ${hiddenNodes.length} hidden ${hiddenNodes.length === 1 ? 'object' : 'objects'}`);
  }
  function resetSelectionTransform(part) {
    if (!controller.selectedNodeId) return;
    controller.updateNodeTransform(controller.selectedNodeId, { [part]: [...TRANSFORM_AT_REST[part]] });
    announce(`${TRANSFORM_PART_WORDS[part]} reset`);
  }
  // Shown only while a motion track drives the camera: off means the viewport looks around on its own.
  const sceneCameraToggle = createMenuToggle('Animated camera', '', () => {
    if (controller.freeView) {
      controller.lookThroughSceneCamera();
      return;
    }
    const camera = controller.viewCamera;
    controller.moveViewportCamera({ eye: [...camera.eye], target: [...camera.target] });
  }, () => !controller.freeView, 'camera');
  const viewPopover = createMenuPopover(
    'crucible-studio-pop-view',
    createMenuItem('Front view', keyLabel(keymap, 'view.front'), () => showView('front')),
    createMenuItem('Right view', keyLabel(keymap, 'view.right'), () => showView('right')),
    createMenuItem('Top view', keyLabel(keymap, 'view.top'), () => showView('top')),
    createMenuItem('Perspective / Orthographic', keyLabel(keymap, 'view.projection'), () => controller.toggleCameraProjection(), 'camera'),
    createMenuItem('Frame the selection', keyLabel(keymap, 'view.frame'), () => flyToSelection(), 'frame'),
    createMenuToggle('Grid', '', () => gridButton.click(), () => gridVisible, 'grid'),
    sceneCameraToggle,
    createMenuToggle('Scene and Properties', '', () => toggleDocksButton.click(), () => root.dataset.outlinerCollapsed !== 'true' || root.dataset.inspectorCollapsed !== 'true', 'panels'),
    createMenuToggle('Properties', keyLabel(keymap, 'view.properties'), () => setInspectorCollapsed(root.dataset.inspectorCollapsed !== 'true'), () => root.dataset.inspectorCollapsed !== 'true', 'settings'),
  );
  // A row that switches something shows whether it is on each time its menu opens.
  viewPopover.addEventListener('toggle', () => {
    sceneCameraToggle.hidden = !controller.cameraDriven;
    syncMenuToggles();
  });
  syncMenuToggles();
  const helpPopover = createMenuPopover(
    'crucible-studio-pop-help',
    createMenuItem('Keyboard shortcuts', keyLabel(keymap, 'help.shortcuts'), () => shortcutsDialog.showModal(), 'keyboard'),
    createMenuItem('Set up Studio…', '', () => openSetup(), 'settings'),
  );
  const exportMenuButton = createElement(
    documentReference,
    'button',
    { type: 'button', className: 'crucible-studio-primary-btn', attributes: { popovertarget: 'crucible-studio-pop-export' } },
    createIcon(documentReference, 'export'),
    createElement(documentReference, 'span', { textContent: 'Export' }),
  );

  const newPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-new',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  });
  for (const [templateKey, spec] of Object.entries(STUDIO_TEMPLATES)) {
    const templateButton = createElement(documentReference, 'button', { type: 'button', textContent: spec.label, title: spec.description });
    templateButton.addEventListener('click', async () => {
      newPopover.hidePopover?.();
      const recipe = buildTemplateRecipe(templateKey);
      await prepareRecipe(recipe);
      controller.loadRecipe(recipe);
      activeFilePath = null;
      activeFileName = `${templateKey}.scene.json`;
      isDirty = false;
      discardDraft();
      syncFileBanner();
      announce(`New ${spec.label}`);
    });
    newPopover.append(giveMenuIcon(templateButton));
  }

  const addPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-add',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  });
  const addPrimitiveButtonFor = primitiveType => {
    const addPrimitiveButton = createElement(documentReference, 'button', { type: 'button', textContent: primitiveLabel(primitiveType) });
    addPrimitiveButton.addEventListener('click', async () => {
      addPopover.hidePopover?.();
      try {
        await loadAgentSceneModules({ geometries: [primitiveGeometrySpec(primitiveType).geometry] });
        const created = controller.addPrimitive(primitiveType);
        announce(`Added ${created.label}`);
      } catch (error) {
        announce(error.message);
      }
    });
    return addPrimitiveButton;
  };
  // The shapes come in groups with a gap between them and no captions; a screen reader hears each group's name.
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
      announce(error.message);
    }
  };
  addPointLightButton.addEventListener('click', () => addLightFromMenu('point', 'Point lights'));
  addSpotLightButton.addEventListener('click', () => addLightFromMenu('spot', 'Spot lights'));
  addAreaLightButton.addEventListener('click', () => addLightFromMenu('area', 'Area lights'));
  const lightGrid = createElement(documentReference, 'div', { className: 'crucible-studio-popover-grid', attributes: { role: 'group', 'aria-label': 'Lights' } }, addPointLightButton, addSpotLightButton, addAreaLightButton);
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
  async function copyAgentPrompt() {
    const promptText = agentPromptText();
    try {
      await navigator.clipboard.writeText(promptText);
      announce('Copied AI prompt to clipboard');
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

  const exportPngButton = createElement(documentReference, 'button', { type: 'button', textContent: 'PNG image' });
  const exportGlbButton = createElement(documentReference, 'button', { type: 'button', textContent: 'GLB model' });
  const exportPackButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Web pack' });
  const editJsonButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Recipe JSON' });
  const exportPopover = createElement(documentReference, 'div', {
    id: 'crucible-studio-pop-export',
    className: 'crucible-studio-popover',
    attributes: { popover: 'auto' },
  }, exportPngButton, exportGlbButton, exportPackButton);
  giveMenuIcon(openButton, 'open');
  giveMenuIcon(saveButton, 'save');
  giveMenuIcon(saveAsButton, 'saveAs');
  giveMenuIcon(editJsonButton, 'code');
  giveMenuIcon(exportPngButton, 'image');
  giveMenuIcon(exportGlbButton, 'node');
  giveMenuIcon(exportPackButton, 'globe');
  newPopover.prepend(
    openButton,
    saveButton,
    saveAsButton,
    editJsonButton,
    createMenuItem('Export PNG image', '', () => exportPngButton.click(), 'image'),
    createMenuItem('Export GLB model', '', () => exportGlbButton.click(), 'node'),
    createMenuItem('Export web pack', '', () => exportPackButton.click(), 'globe'),
    createElement(documentReference, 'p', { className: 'crucible-studio-popover-note', textContent: 'New scene' }),
  );
  for (const popoverElement of [newPopover, addPopover, exportPopover, editPopover, objectPopover, viewPopover, helpPopover]) {
    popoverElement.addEventListener('click', event => {
      if (event.target.closest?.('button')) popoverElement.hidePopover?.();
    });
  }

  const workspaceButtons = STUDIO_WORKSPACES.map(workspace => createElement(
    documentReference,
    'button',
    { type: 'button', dataset: { workspace: workspace.id }, attributes: { role: 'tab', 'aria-selected': 'false', 'aria-label': workspace.label } },
    createIcon(documentReference, workspace.icon),
    createElement(documentReference, 'span', { className: 'crucible-studio-workspace-label', textContent: workspace.label }),
  ));
  const workspaceList = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-island crucible-studio-workspaces', attributes: { role: 'tablist', 'aria-label': 'Workspace' } },
    ...workspaceButtons,
  );
  workspaceButtons.forEach(button => {
    button.addEventListener('click', () => selectWorkspace(button.dataset.workspace));
  });
  wireRovingFocusFallback(workspaceList, workspaceButtons, {
    followFocus: true,
    onSelect: button => selectWorkspace(button.dataset.workspace),
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
    createElement(documentReference, 'div', { className: 'crucible-studio-island' }, filePill, watchPill, exportMenuButton),
    newPopover,
    addPopover,
    aiSyncPopover,
    exportPopover,
    editPopover,
    objectPopover,
    viewPopover,
    helpPopover,
  );

  // With one menu open, moving over the next one opens it, as a desktop menu bar does.
  const menuPairs = [[fileMenuButton, newPopover], [editMenuButton, editPopover], [viewMenuButton, viewPopover], [aiSyncMenuButton, aiSyncPopover], [helpMenuButton, helpPopover]];
  for (const [menuButton, menuPopover] of menuPairs) {
    menuButton.addEventListener('pointerenter', () => {
      const openPair = menuPairs.find(([, otherPopover]) => otherPopover !== menuPopover && otherPopover.matches?.(':popover-open'));
      if (openPair) {
        openPair[1].hidePopover?.();
        fileMenuAnchor = menuButton === fileMenuButton ? fileMenuButton : fileMenuAnchor;
        menuPopover.showPopover?.();
      }
    });
  }
  let fileMenuAnchor = filePill;
  filePill.addEventListener('click', () => { fileMenuAnchor = filePill; });
  fileMenuButton.addEventListener('click', () => { fileMenuAnchor = fileMenuButton; });

  function bindPopoverAnchor(triggerButton, popoverElement, { beside = false } = {}) {
    popoverElement.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const rectangle = (typeof triggerButton === 'function' ? triggerButton() : triggerButton).getBoundingClientRect();
      const viewportWidth = documentReference.defaultView?.innerWidth ?? 1280;
      const viewportHeight = documentReference.defaultView?.innerHeight ?? 800;
      const wantedLeft = beside ? rectangle.right + 16 : rectangle.left - 5;
      const wantedTop = beside ? rectangle.top - 8 : rectangle.bottom + 14;
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
    });
  }
  bindPopoverAnchor(() => fileMenuAnchor, newPopover);
  bindPopoverAnchor(editMenuButton, editPopover);
  bindPopoverAnchor(viewMenuButton, viewPopover);
  bindPopoverAnchor(helpMenuButton, helpPopover);
  let addMenuAnchor = addMenuButton;
  addMenuButton.addEventListener('click', () => { addMenuAnchor = addMenuButton; });
  bindPopoverAnchor(() => addMenuAnchor, addPopover, { beside: true });
  bindPopoverAnchor(aiSyncMenuButton, aiSyncPopover);
  bindPopoverAnchor(exportMenuButton, exportPopover);

  // Left Outliner + Material Palette Dock
  const outlinerSearch = createElement(documentReference, 'input', { type: 'search', placeholder: 'Find an object', attributes: { 'aria-label': 'Filter the scene list' } });
  const filterRow = createElement(documentReference, 'label', { className: 'crucible-studio-filter', hidden: true }, createIcon(documentReference, 'search'), outlinerSearch);
  const filterToggleButton = createIconButton(documentReference, 'search', 'Find an object in the scene', { attributes: { 'aria-pressed': 'false', 'aria-expanded': 'false' } });
  const sceneAddButton = createIconButton(documentReference, 'add', 'Add to the scene', { attributes: { popovertarget: 'crucible-studio-pop-add' } });
  sceneAddButton.addEventListener('click', () => { addMenuAnchor = sceneAddButton; });
  const outlinerTree = createElement(documentReference, 'div', { className: 'crucible-studio-tree crucible-studio-scroll', attributes: { role: 'tree', 'aria-label': 'Scene hierarchy' } });
  const swatchContainer = createElement(documentReference, 'div', { className: 'crucible-studio-swatches crucible-studio-scroll' });
  const newMaterialQuickButton = createIconButton(documentReference, 'add', 'New material', { className: 'crucible-studio-swatch-add' });
  newMaterialQuickButton.addEventListener('click', () => {
    const created = controller.createMaterial({ assignToNodeId: controller.selectedNodeId });
    selectInspectorTab('material');
    announce(`Created ${created.id}`);
  });

  const sceneMinimizeButton = createIconButton(documentReference, 'minimize', 'Minimize Scene', { attributes: { 'aria-expanded': 'true' } });
  sceneMinimizeButton.addEventListener('click', () => setPreference('sceneMinimized', !preferences.sceneMinimized));
  const propertiesMinimizeButton = createIconButton(documentReference, 'minimize', 'Minimize Properties', { attributes: { 'aria-expanded': 'true' } });
  propertiesMinimizeButton.addEventListener('click', () => setPreference('propertiesMinimized', !preferences.propertiesMinimized));

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
  const statusRegion = createElement(documentReference, 'p', { className: 'crucible-studio-status', attributes: { role: 'status' } });
  const hintBar = createElement(documentReference, 'div', { className: 'crucible-studio-hintbar' });
  const dropOverlay = createElement(documentReference, 'div', { className: 'crucible-studio-drop-overlay', textContent: 'Drop a scene.json to open it' });

  function announce(message) {
    statusRegion.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusRegion.textContent = '';
    }, 3400);
  }

  // Viewport Top-Left Toolbar (Modern Web Guidance: toolbar pattern)
  const toolLabels = { select: 'Select', translate: 'Move', rotate: 'Rotate', scale: 'Scale', snap: 'Snap' };
  const toolShortcuts = { select: 'Q', translate: 'G', rotate: 'R', scale: 'S', snap: 'T' };
  const toolButtons = STUDIO_TOOLS.map(tool => createIconButton(documentReference, tool, `${toolLabels[tool]} (${toolShortcuts[tool]})`, {
    dataset: { tool },
    attributes: { 'aria-pressed': tool === controller.tool ? 'true' : 'false' },
  }));
  toolButtons.forEach(button => {
    button.addEventListener('click', () => controller.setTool(button.dataset.tool));
  });

  const undoButton = createIconButton(documentReference, 'undo', `Undo (${keyLabel(keymap, 'edit.undo')})`, { attributes: { 'aria-disabled': 'true' } });
  const redoButton = createIconButton(documentReference, 'redo', `Redo (${keyLabel(keymap, 'edit.redo')})`, { attributes: { 'aria-disabled': 'true' } });
  const duplicateButton = createIconButton(documentReference, 'duplicate', `Duplicate (${keyLabel(keymap, 'edit.duplicate', 1)})`);
  const deleteButton = createIconButton(documentReference, 'remove', 'Delete (Del)');
  const frameButton = createIconButton(documentReference, 'frame', `Frame in view (${keyLabel(keymap, 'view.frame')})`);
  const toggleDocksButton = createIconButton(documentReference, 'panels', 'Show or hide the panels', { attributes: { 'aria-pressed': 'true' } });
  const gridButton = createIconButton(documentReference, 'grid', 'Show or hide the grid', { attributes: { 'aria-pressed': 'true' } });
  gridButton.addEventListener('click', () => {
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
      announce(`Duplicated to ${cloned.label}`);
    } catch (error) {
      announce(error.message);
    }
  });
  deleteButton.addEventListener('click', () => {
    if (deleteButton.getAttribute('aria-disabled') === 'true') return;
    try {
      deleteSelection();
    } catch (error) {
      announce(error.message);
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

  const toolbarElement = createElement(
    documentReference,
    'div',
    {
      className: 'crucible-studio-toolbar crucible-studio-island',
      attributes: { role: 'toolbar', focusgroup: 'toolbar wrap', 'aria-orientation': 'vertical', 'aria-label': 'Tools', 'aria-controls': canvas.id },
    },
    createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Transform tool' } }, ...toolButtons),
    createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Edit the scene' } }, addMenuButton, undoButton, redoButton),
    // Above the line: what changes the scene. Below it: what only shows or hides parts of Studio.
    createElement(documentReference, 'div', { className: 'crucible-studio-toolbar-rule', attributes: { role: 'separator', 'aria-orientation': 'horizontal' } }),
    createElement(documentReference, 'div', { className: 'crucible-studio-group', attributes: { role: 'group', 'aria-label': 'Show or hide' } }, gridButton, toggleDocksButton),
  );
  wireRovingFocusFallback(toolbarElement, [...toolButtons, addMenuButton, undoButton, redoButton, gridButton, toggleDocksButton], { vertical: true });

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
  const agentPresence = createAgentPresence(documentReference, { controller, requestDraw: () => requestFrame() });
  const pausedNotice = createPausedPictureNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
    reload: () => documentReference.defaultView?.location?.reload?.(),
  });
  const draftNotice = createDraftNotice({
    documentReference,
    createIcon: iconName => createIcon(documentReference, iconName),
    onRestore: () => restoreDraft(),
    onDiscard: () => discardDraft(),
  });
  const stopWatchingContextLoss = watchContextLoss(canvas, { onLost: pauseForContextLoss, onRestored: recoverFromContextLoss });
  viewportElement.append(canvas, gizmoSvg, agentPresence.element, viewWidget.element, readout, hintBar, statusRegion, dropOverlay, pausedNotice.element, draftNotice.element);

  // Right 4-Tab Inspector Dock (Modern Web Guidance: tabs pattern)
  const tabLabels = { node: 'Object', material: 'Material', look: 'Look', camera: 'Camera' };
  const tabButtons = STUDIO_TABS.map(tab => createIconButton(documentReference, tab, tabLabels[tab], {
    id: `crucible-studio-tab-${tab}`,
    dataset: { tab },
    attributes: {
      'aria-selected': tab === controller.activeTab ? 'true' : 'false',
      ...(tab === controller.activeTab ? { focusgroupstart: '' } : {}),
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

  nodeLabelInput.addEventListener('change', () => {
    if (controller.selectedNodeId) controller.updateNodeTransform(controller.selectedNodeId, { label: nodeLabelInput.value });
  });
  nodeParentSelect.addEventListener('change', () => {
    if (!controller.selectedNodeId) return;
    try {
      controller.updateNodeTransform(controller.selectedNodeId, { parent: nodeParentSelect.value || null });
    } catch (error) {
      announce(error.message);
      syncUi();
    }
  });
  visibleToggle.addEventListener('click', () => {
    if (!controller.selectedNodeId) return;
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    controller.updateNodeTransform(controller.selectedNodeId, { visible: !(node?.visible ?? true) });
  });
  castShadowToggle.addEventListener('click', () => {
    if (!controller.selectedNodeId) return;
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    controller.updateNodeTransform(controller.selectedNodeId, { castShadow: !(node?.castShadow ?? true) });
  });
  receiveShadowToggle.addEventListener('click', () => {
    if (!controller.selectedNodeId) return;
    const node = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    controller.updateNodeTransform(controller.selectedNodeId, { receiveShadow: !(node?.receiveShadow ?? true) });
  });

  const positionRow = createVectorRow(documentReference, 'Position', values => {
    if (controller.selectedNodeId) controller.updateNodeTransform(controller.selectedNodeId, { translation: values });
  }, { sensitivity: 0.015 });
  const rotationRow = createVectorRow(documentReference, 'Rotation °', values => {
    if (controller.selectedNodeId) controller.updateNodeTransform(controller.selectedNodeId, { rotationDegrees: values });
  }, { sensitivity: 0.5 });
  const scaleRow = createVectorRow(documentReference, 'Scale', values => {
    if (controller.selectedNodeId && values.every(component => component > 0.001)) {
      controller.updateNodeTransform(controller.selectedNodeId, { scale: values });
    }
  }, { sensitivity: 0.01, minimumComponent: 0.02, lockToggle: true });

  const nodePanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body' },
    createElement(documentReference, 'div', { className: 'crucible-studio-name-row' }, nodeLabelInput, visibleToggle, frameButton, duplicateButton, deleteButton),
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Parent' }), nodeParentSelect),
    positionRow.container,
    rotationRow.container,
    scaleRow.container,
    createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, castShadowToggle, receiveShadowToggle),
  );

  // Tab 2: Material Panel
  const materialSelect = createElement(documentReference, 'select', { attributes: { 'aria-label': 'Assigned material' } });
  materialSelect.addEventListener('change', () => {
    if (controller.selectedNodeId && materialSelect.value) {
      try {
        controller.assignNodeMaterial(controller.selectedNodeId, materialSelect.value);
      } catch (error) {
        announce(error.message);
      }
    }
  });
  const materialPresetChips = Object.entries(STUDIO_MATERIAL_PRESETS).map(([presetKey, preset]) => {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: preset.label, dataset: { preset: presetKey } });
    button.addEventListener('click', () => {
      const targetNode = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
      const materialId = targetNode?.material ?? materialSelect.value;
      if (materialId) {
        controller.applyMaterialPreset(materialId, presetKey);
        announce(`Applied ${preset.label} preset`);
      }
    });
    return button;
  });
  const activeMaterialId = () => {
    const selected = controller.exportRecipe().nodes.find(candidate => candidate.id === controller.selectedNodeId);
    return selected?.material ?? materialSelect.value;
  };
  const colorInput = createElement(documentReference, 'input', { type: 'color', value: '#cccccc', attributes: { 'aria-label': 'Base color' } });
  const emissiveColorInput = createElement(documentReference, 'input', { type: 'color', value: '#000000', attributes: { 'aria-label': 'Emissive color' } });
  colorInput.addEventListener('input', () => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { hexColor: colorInput.value });
  });
  emissiveColorInput.addEventListener('input', () => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { emissiveHex: emissiveColorInput.value });
  });
  const roughnessField = createSliderField(documentReference, 'Roughness', { min: 0.02, max: 1, step: 0.02, value: 0.5 }, value => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { roughness: value });
  });
  const metallicField = createSliderField(documentReference, 'Metallic', { min: 0, max: 1, step: 0.02, value: 0 }, value => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { metallic: value });
  });
  const clearcoatField = createSliderField(documentReference, 'Clearcoat', { min: 0, max: 1, step: 0.02, value: 0 }, value => {
    const materialId = activeMaterialId();
    if (!materialId) return;
    const material = controller.exportRecipe().materials.find(candidate => candidate.id === materialId);
    // A coat starts glossy, but a roughness the person already chose stays.
    const coatPatch = material?.clearcoatRoughness === undefined ? { clearcoat: value, clearcoatRoughness: DEFAULT_CLEARCOAT_ROUGHNESS } : { clearcoat: value };
    controller.updateMaterial(materialId, coatPatch);
  });
  const clearcoatRoughnessField = createSliderField(documentReference, 'Clearcoat roughness', { min: 0, max: 1, step: 0.02, value: 0 }, value => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { clearcoatRoughness: value });
  });
  const doubleSidedToggle = createElement(documentReference, 'button', { type: 'button', textContent: 'Double sided', attributes: { 'aria-pressed': 'false' } });
  doubleSidedToggle.addEventListener('click', () => {
    const materialId = activeMaterialId();
    if (!materialId) return;
    const material = controller.exportRecipe().materials.find(candidate => candidate.id === materialId);
    controller.updateMaterial(materialId, { doubleSided: !(material?.doubleSided ?? false) });
  });
  const opacityField = createSliderField(documentReference, 'Opacity', { min: 0.05, max: 1, step: 0.02, value: 1 }, value => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { opacity: value });
  });
  const emissionField = createSliderField(documentReference, 'Emission', { min: 0, max: 12, step: 0.1, value: 0 }, value => {
    const materialId = activeMaterialId();
    if (materialId) controller.updateMaterial(materialId, { emission: value });
  });
  const materialPanelBody = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-panel-body' },
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Material' }), materialSelect),
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Presets' }), createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, ...materialPresetChips)),
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Color' }), colorInput),
    roughnessField.container,
    metallicField.container,
    clearcoatField.container,
    clearcoatRoughnessField.container,
    opacityField.container,
    emissionField.container,
    createElement(documentReference, 'div', { className: 'crucible-studio-field' }, createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Glow color' }), emissiveColorInput),
    createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, doubleSidedToggle),
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
  const createLookPanel = (resolveKey, panelOptions = {}) => createPropertyPanel({ documentReference, controller, announce, builders: propertyBuilders, resolveKey, groups: propertyGroups, prepareRecipe, ...panelOptions });
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
      announce(`Saved view ${name}`);
    } catch (error) {
      announce(error.message);
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

  const panelsByTab = {
    node: createElement(documentReference, 'div', { id: 'crucible-studio-panel-node', tabIndex: 0, attributes: { role: 'tabpanel', 'aria-labelledby': 'crucible-studio-tab-node' } }, nodePanelBody),
    material: createElement(documentReference, 'div', { id: 'crucible-studio-panel-material', attributes: { role: 'tabpanel', 'aria-labelledby': 'crucible-studio-tab-material', hidden: 'until-found' } }, materialPanelBody),
    look: createElement(documentReference, 'div', { id: 'crucible-studio-panel-look', attributes: { role: 'tabpanel', 'aria-labelledby': 'crucible-studio-tab-look', hidden: 'until-found' } }, lookPanelBody),
    camera: createElement(documentReference, 'div', { id: 'crucible-studio-panel-camera', attributes: { role: 'tabpanel', 'aria-labelledby': 'crucible-studio-tab-camera', hidden: 'until-found' } }, cameraPanelBody),
  };

  // Opening a panel brings its workspace forward, so nothing changes off screen. The open workspace keeps the panel when it holds it.
  function selectInspectorTab(nextTab) {
    const holdsTab = workspace => workspace.tabs.includes(nextTab);
    const openWorkspace = STUDIO_WORKSPACES.find(workspace => workspace.id === root.dataset.workspace);
    const owner = openWorkspace && holdsTab(openWorkspace) ? openWorkspace : STUDIO_WORKSPACES.find(holdsTab) ?? STUDIO_WORKSPACES[0];
    selectWorkspace(owner.id, nextTab);
  }

  // The workspace is a way of looking at the scene, not part of it: it stays out of the recipe and out of undo.
  function selectWorkspace(nextWorkspace, preferredTab) {
    const workspace = STUDIO_WORKSPACES.find(candidate => candidate.id === nextWorkspace);
    if (!workspace) {
      throw new RangeError(`Unknown Studio workspace "${String(nextWorkspace)}". Use one of ${STUDIO_WORKSPACES.map(candidate => candidate.id).join(', ')}.`);
    }
    const workspaceWasOpen = root.dataset.workspace === workspace.id;
    root.dataset.workspace = workspace.id;
    for (const button of workspaceButtons) {
      button.setAttribute('aria-selected', button.dataset.workspace === workspace.id ? 'true' : 'false');
    }
    for (const button of tabButtons) {
      button.toggleAttribute('hidden', !workspace.tabs.includes(button.dataset.tab));
    }
    tabListElement.toggleAttribute('hidden', workspace.tabs.length < 2);
    // A workspace opens on its first panel; only a call for the workspace already open keeps the panel in view.
    const keptTab = workspaceWasOpen && workspace.tabs.includes(controller.activeTab) ? controller.activeTab : workspace.tabs[0];
    showInspectorTab(preferredTab ?? keptTab);
  }

  function showInspectorTab(nextTab) {
    controller.setActiveTab(nextTab);
    syncPropertyPanels();
    for (const button of tabButtons) {
      const selected = button.dataset.tab === nextTab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.toggleAttribute('focusgroupstart', selected);
    }
    for (const [tab, panel] of Object.entries(panelsByTab)) {
      if (tab === nextTab) {
        panel.removeAttribute('hidden');
        panel.tabIndex = 0;
      } else {
        panel.setAttribute('hidden', 'until-found');
        panel.removeAttribute('tabindex');
      }
    }
  }
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

  const inspectorElement = createElement(
    documentReference,
    'aside',
    { className: 'crucible-studio-dock crucible-studio-inspector', attributes: { 'aria-label': 'Scene inspector' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-dock-head' },
      createElement(documentReference, 'span', { className: 'crucible-studio-dock-title' }, createIcon(documentReference, 'settings'), createElement(documentReference, 'span', { textContent: 'Properties' })),
      createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
      propertiesMinimizeButton,
    ),
    tabListElement,
    createElement(documentReference, 'div', { className: 'crucible-studio-panels crucible-studio-scroll' }, panelsByTab.node, panelsByTab.material, panelsByTab.look, panelsByTab.camera),
  );

  // Bottom Timeline & Telemetry Bar
  const playButton = createIconButton(documentReference, 'play', `Play (${keyLabel(keymap, 'animate.play')})`, { attributes: { 'aria-pressed': 'false' } });
  const keyframeButton = createIconButton(documentReference, 'keyframe', `Add a keyframe here (${keyLabel(keymap, 'animate.keyframe', 1)})`);
  const timeOutput = createElement(documentReference, 'output', { textContent: '0.00 s' });
  const scrubInput = createElement(documentReference, 'input', { type: 'range', min: '0', max: '4', step: '0.02', value: '0', attributes: { 'aria-label': 'Timeline scrub' } });
  const quickBookmarksRow = createElement(documentReference, 'div', { className: 'crucible-studio-shots' });
  const fileInput = createElement(documentReference, 'input', { type: 'file', accept: '.json,application/json', hidden: true });

  playButton.addEventListener('click', () => {
    if (!hasAnimatedData(controller.exportRecipe())) {
      announce(`Add a keyframe first (${keyLabel(keymap, 'animate.keyframe', 1)})`);
      return;
    }
    selectWorkspace('animate');
    playing = !playing;
    lastFrameTime = 0;
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    setButtonIcon(playButton, playing ? 'pause' : 'play', playing ? `Pause (${keyLabel(keymap, 'animate.play')})` : `Play (${keyLabel(keymap, 'animate.play')})`);
    if (playing) requestFrame();
  });
  keyframeButton.addEventListener('click', async () => {
    selectWorkspace('animate');
    try {
      await loadAgentSceneModules({ motion: { duration: 1, tracks: [] } });
      controller.insertNodeKeyframe();
      announce(`Keyframed at ${controller.motionTime.toFixed(2)} s`);
    } catch (error) {
      announce(error.message);
    }
  });
  scrubInput.addEventListener('input', () => {
    const seconds = Number(scrubInput.value);
    if (hasAnimatedData(controller.exportRecipe())) {
      controller.setMotionTime(seconds);
    }
  });

  const bottomElement = createElement(
    documentReference,
    'footer',
    { className: 'crucible-studio-bottombar crucible-studio-island', attributes: { 'aria-label': 'Timeline' } },
    createElement(documentReference, 'div', { className: 'crucible-studio-scrub' }, playButton, keyframeButton, scrubInput, timeOutput),
    quickBookmarksRow,
  );

  // Native Dialogs (Modern Web Guidance: native <dialog>, aria-labelledby, form method="dialog", returnValue reset)
  const dialogHeading = createElement(documentReference, 'h2', { id: 'crucible-studio-json-title', textContent: 'Recipe JSON' });
  const dialogTextarea = createElement(documentReference, 'textarea', { rows: 14, autofocus: true, attributes: { 'aria-label': 'Scene recipe JSON' } });
  const dialogFileButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Load file…' });
  const dialogCloseButton = createElement(documentReference, 'button', { type: 'submit', value: 'close', textContent: 'Close' });
  const dialogApplyButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-primary-btn', textContent: 'Apply JSON' });
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
      recipeDialog.close('apply');
      announce('Recipe applied');
    } catch (error) {
      announce(error.message);
    }
  });

  const shortcutsHeading = createElement(documentReference, 'h2', { id: 'crucible-studio-shortcuts-title', textContent: 'Studio keyboard shortcuts' });
  const shortcutsGrid = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-shortcuts' },
    ...SHORTCUT_ROWS.map(({ keys, label }) => createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-shortcut-item' },
      createElement(documentReference, 'span', { textContent: label }),
      createElement(documentReference, 'kbd', { textContent: formatShortcutKeys(keymap, keys) }),
    )),
  );
  const shortcutsCloseButton = createElement(documentReference, 'button', { type: 'submit', value: 'close', autofocus: true, textContent: 'Done' });
  const shortcutsDialog = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-shortcuts-dialog', attributes: { 'aria-labelledby': 'crucible-studio-shortcuts-title', closedby: 'any' } },
    shortcutsHeading,
    shortcutsGrid,
    createElement(documentReference, 'form', { method: 'dialog', className: 'crucible-studio-dialog-actions' }, shortcutsCloseButton),
  );
  shortcutsDialog.addEventListener('close', () => {
    shortcutsDialog.returnValue = '';
  });

  const settingControls = new Map();
  const settingRows = STUDIO_SETTING_ROWS.map(([name, label, describeChoice]) => {
    const choices = STUDIO_PREFERENCE_CHOICES[name];
    const control = choices
      ? createElement(documentReference, 'select', {}, ...choices.map(choice => createElement(documentReference, 'option', { value: String(choice), textContent: describeChoice(choice) })))
      : createElement(documentReference, 'input', { type: 'checkbox' });
    control.dataset.setting = name;
    control.addEventListener('change', () => {
      setPreference(name, choices ? choices.find(choice => String(choice) === control.value) : control.checked);
    });
    settingControls.set(name, control);
    return createElement(documentReference, 'label', { className: 'crucible-studio-setting' }, createElement(documentReference, 'span', { textContent: label }), control);
  });
  const settingsResetButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Reset' });
  settingsResetButton.addEventListener('click', () => {
    preferences = normalizeStudioPreferences({ setupDone: preferences.setupDone });
    storePreferences();
    applyPreferences();
    announce('Settings reset');
  });
  const settingsDialog = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-settings-dialog', attributes: { 'aria-labelledby': 'crucible-studio-settings-title', closedby: 'any' } },
    createElement(documentReference, 'h2', { id: 'crucible-studio-settings-title', textContent: 'Settings' }),
    createElement(documentReference, 'div', { className: 'crucible-studio-settings' }, ...settingRows),
    createElement(
      documentReference,
      'form',
      { method: 'dialog', className: 'crucible-studio-dialog-actions' },
      settingsResetButton,
      createElement(documentReference, 'button', { type: 'submit', value: 'close', autofocus: true, textContent: 'Done' }),
    ),
  );
  settingsDialog.addEventListener('close', () => {
    settingsDialog.returnValue = '';
  });

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
    controller.setInteractionSettings({
      moveSnapStep: preferences.moveSnapStep,
      rotateSnapDegrees: preferences.rotateSnapDegrees,
      gizmoPixels: STUDIO_GIZMO_PIXELS[preferences.gizmoSize],
    });
    applyTheme();
    applyPerformance();
    if (setup.dialog.open) setup.refresh();
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
    showPanelMinimized(propertiesMinimizeButton, 'inspectorMinimized', 'Properties', preferences.propertiesMinimized);
    for (const [name, control] of settingControls) {
      if (STUDIO_PREFERENCE_CHOICES[name]) control.value = String(preferences[name]);
      else control.checked = preferences[name];
    }
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

  // Saves several preferences as one change, so a drag that resizes two cards is one write.
  function setPreferences(changes) {
    for (const name of Object.keys(changes)) {
      if (!(name in STUDIO_PREFERENCE_DEFAULTS)) {
        throw new RangeError(`Unknown Studio preference "${String(name)}". Use one of ${Object.keys(STUDIO_PREFERENCE_DEFAULTS).join(', ')}.`);
      }
    }
    preferences = normalizeStudioPreferences({ ...preferences, ...changes });
    storePreferences();
    applyPreferences();
  }

  function setPreference(name, value) {
    setPreferences({ [name]: value });
    return preferences[name];
  }

  selectInspectorTab(controller.activeTab);
  if (preferences.startWorkspace !== 'build') {
    selectWorkspace(preferences.startWorkspace);
  }
  // The panel column and its grips live in their own module; Studio gives it the saved preferences and a way to save changes.
  const { sideColumn, showPanelSizes } = createPanelGrips({
    documentReference,
    createElement,
    root,
    outlinerDock,
    inspectorElement,
    readPreferences: () => preferences,
    changePreferences: setPreferences,
  });

  function showPanelMinimized(button, datasetName, panelName, minimized) {
    root.dataset[datasetName] = minimized ? 'true' : 'false';
    setButtonIcon(button, minimized ? 'expand' : 'minimize', minimized ? `Expand ${panelName}` : `Minimize ${panelName}`);
    button.setAttribute('aria-expanded', minimized ? 'false' : 'true');
  }

  applyPreferences();
  root.append(viewportElement, menubarElement, toolbarElement, sideColumn, bottomElement, fileInput, recipeDialog, shortcutsDialog, settingsDialog, setup.dialog);
  container.append(root);

  function syncWatchNote() {
    syncStatusNote.textContent = activeFilePath
      ? `Watching ${activeFilePath} (${autoReloadWatch ? 'auto-reload on' : 'paused'}).`
      : 'Save the scene to a file and the agent can edit it while you watch.';
  }

  function syncFileBanner() {
    filePill.textContent = activeFileName;
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

  function capturePngDataUrl() {
    // Nothing draws while the context is gone, so a still taken then would be a blank picture.
    if (contextLost) {
      throw new Error(CONTEXT_LOST_MESSAGE);
    }
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
    const selectedId = controller.selectedNodeId;
    const bounds = selectedId ? controller.nodeBounds(selectedId) : null;
    if (!bounds) {
      return '';
    }
    const selectedNode = controller.exportRecipe().nodes.find(node => node.id === selectedId);
    return `${selectedNode?.label ?? selectedId} · ${describeBounds(bounds)}`;
  }

  function syncViewportAids() {
    const camera = controller.viewCamera;
    viewWidget.update(camera);
    const gridStep = gridLayout({ visibleHeight: cameraVisibleHeight(camera), viewportHeight: controller.viewportHeight, target: camera.target, eye: camera.projection === 'orthographic' ? undefined : camera.eye }).step;
    readoutCamera.textContent = gridVisible ? `${describeCamera(camera)} · Grid ${describeGridStep(gridStep)}` : describeCamera(camera);
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
    const stillScene = createAgentScene(stillRecipe, {}, { assets: catalog.pool });
    const environment = stillScene.environment;
    const shaderModules = agentSceneModulesNeeded(stillRecipe).filter(name => Object.hasOwn(PACK_SHADER_MODULES, name));
    for (const moduleName of agentSceneModulesNeeded(stillRecipe)) {
      if (Object.hasOwn(PACK_UNSUPPORTED_MODULES, moduleName)) {
        stripped.push(PACK_UNSUPPORTED_MODULES[moduleName]);
      }
    }
    const packBytes = encodePackOrRefuse(encodePack, {
      shaderModules,
      camera: stillScene.camera,
      environment,
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
    await prepareRecipe(parsed);
    controller.loadRecipe(parsed, { recordUndo });
    if (madeByAgent) {
      showAgentEdit({ name: agentLabel, ...diffRecipeNodes(recipeBefore, controller.exportRecipe()) });
    } else {
      agentPresence.hide();
    }
    activeFilePath = filePath;
    activeFileName = fileName;
    isDirty = false;
    syncFileBanner();
  }

  async function performOpenFile() {
    if (desktop?.openFile) {
      const picked = await desktop.openFile();
      if (!picked || picked.canceled) return;
      try {
        await loadExternalTextFile(picked.text, { filePath: picked.filePath, fileName: picked.fileName });
        discardDraft();
        announce(`Opened ${picked.fileName}`);
      } catch (error) {
        announce(error.message);
      }
      return;
    }
    fileInput.click();
  }

  async function performSaveFile({ forceAs = false } = {}) {
    const recipeText = `${JSON.stringify(controller.exportRecipe(), null, 2)}\n`;
    if (desktop?.saveFile && desktop?.saveFileAs) {
      const response = forceAs || !activeFilePath
        ? await desktop.saveFileAs({ text: recipeText, suggestedName: activeFileName })
        : await desktop.saveFile({ filePath: activeFilePath, text: recipeText });
      if (!response || response.canceled) return;
      activeFilePath = response.filePath;
      activeFileName = response.fileName;
      isDirty = false;
      discardDraft();
      syncFileBanner();
      announce(`Saved ${activeFileName}`);
      return;
    }
    triggerBlobDownload(recipeText, activeFileName, 'application/json');
    isDirty = false;
    discardDraft();
    syncFileBanner();
    announce(`Downloaded ${activeFileName}`);
  }

  openButton.addEventListener('click', () => performOpenFile());
  saveButton.addEventListener('click', () => performSaveFile({ forceAs: false }));
  saveAsButton.addEventListener('click', () => performSaveFile({ forceAs: true }));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      await loadExternalTextFile(await file.text(), { filePath: null, fileName: file.name });
      discardDraft();
      announce(`Loaded ${file.name}`);
    } catch (error) {
      announce(error.message);
    }
  });

  exportPngButton.addEventListener('click', async () => {
    exportPopover.hidePopover?.();
    const dataUrl = capturePngDataUrl();
    const baseName = activeFileName.replace(/\.(scene\.)?json$/i, '') || 'crucible-render';
    if (desktop?.savePng) {
      const response = await desktop.savePng({ dataUrl, suggestedName: `${baseName}.png` });
      if (!response?.canceled) announce(`Saved ${response.fileName}`);
      return;
    }
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    triggerBlobDownload(bytes, `${baseName}.png`, 'image/png');
    announce('Saved PNG still');
  });

  exportGlbButton.addEventListener('click', async () => {
    exportPopover.hidePopover?.();
    try {
      const glbBytes = exportGlbBytes();
      const baseName = activeFileName.replace(/\.(scene\.)?json$/i, '') || 'crucible-scene';
      if (desktop?.saveGlb) {
        const response = await desktop.saveGlb({ bytes: glbBytes, suggestedName: `${baseName}.glb` });
        if (!response?.canceled) announce(`Exported ${response.fileName}`);
        return;
      }
      triggerBlobDownload(glbBytes, `${baseName}.glb`, 'model/gltf-binary');
      announce('Exported GLB mesh');
    } catch (error) {
      announce(error.message);
    }
  });

  exportPackButton.addEventListener('click', async () => {
    exportPopover.hidePopover?.();
    try {
      const payload = await buildWebPackPayload();
      if (desktop?.packWebBundle) {
        const response = await desktop.packWebBundle(payload);
        if (!response?.canceled) {
          const note = payload.stripped.length ? ` (static snapshot, omitted ${payload.stripped[0]})` : '';
          announce(`Packed web bundle to ${response.outDir}${note}`);
        }
        return;
      }
      triggerBlobDownload(payload.packBytes, `${payload.title}.pack`, 'application/octet-stream');
      announce('Downloaded scene.pack');
    } catch (error) {
      announce(error.message);
    }
  });

  editJsonButton.addEventListener('click', () => {
    exportPopover.hidePopover?.();
    openImportDialog();
  });

  // Renderer Lifecycle
  // Volume fog reads scene depth, which the viewport otherwise does without. A scene that turns fog on gets a renderer
  // with a depth target, built once; it stays for the scenes after it.
  function sceneNeedsDepth() {
    const environment = controller.scene.environment;
    return Boolean(environment.volumeFog?.density > 0 || environment.localVolumes?.length);
  }

  function ensureRenderer() {
    if (renderer && !suppliedRenderer && !rendererHasDepth && sceneNeedsDepth()) {
      renderer.dispose();
      renderer = null;
    }
    if (renderer) {
      return renderer;
    }
    const environment = controller.scene.environment;
    rendererHasDepth = sceneNeedsDepth();
    const viewportSettings = viewportSettingsForTier(chosenTier());
    rendererSamples = viewportSettings.samples;
    renderer = new CrucibleRenderer(canvas, controller.scene.parts, {
      hdr: true,
      depth: rendererHasDepth,
      world: environment.world,
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      shadowBounds: resolveAgentShadow(fitAgentShadow(controller.scene.shadow, controller.scene.parts), environment.lightDirection),
      pixelRatio: viewportSettings.pixelRatio,
      samples: viewportSettings.samples,
      ground: viewportFloorPart(studioFloorHeight(controller.scene.parts)),
      ...rendererOptions,
    });
    renderedScene = controller.scene;
    renderedTopology = controller.scene.topologyRevision;
    return renderer;
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
    if (!gridVisible || capturingStill) {
      return controller.scene.parts;
    }
    gridParts ??= buildGridParts();
    gridPartsByName ??= new Map(gridParts.map(part => [part.name, part]));
    const camera = controller.viewCamera;
    placeGridParts(gridPartsByName, gridLayout({ visibleHeight: cameraVisibleHeight(camera), viewportHeight: controller.viewportHeight, target: camera.target, eye: camera.eye }));
    return [...controller.scene.parts, ...gridParts];
  }

  // F flies the camera to the framed object instead of jumping there, so the eye can follow where the view went. The
  // flight ends the moment anything else moves the camera (an orbit, a view key, undo, a new file). With reduced motion
  // the view jumps.
  function stopFlight() {
    if (flightHandle) {
      cancelAnimationFrame(flightHandle);
      flightHandle = 0;
    }
  }

  function flyToSelection() {
    stopFlight();
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || typeof requestAnimationFrame !== 'function') {
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
    const topology = `${controller.scene.topologyRevision}|${gridVisible && !capturingStill}`;
    if (renderedScene !== controller.scene || renderedTopology !== topology) {
      activeRenderer.replaceParts(partsToDraw());
      renderedScene = controller.scene;
      renderedTopology = topology;
      return activeRenderer;
    }
    try {
      activeRenderer.updateParts(partsToDraw());
      return activeRenderer;
    } catch (error) {
      if (!suppliedRenderer && typeof renderer?.dispose === 'function') {
        renderer.dispose();
        renderer = null;
        return ensureRenderer();
      }
      throw error;
    }
  }

  function drawSceneFrame() {
    const activeRenderer = syncRendererParts(ensureRenderer());
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
    // A still is the scene's own shot, so it keeps the animated camera even while the viewport looks around freely.
    const frameCamera = capturingStill ? controller.scene.camera : controller.viewCamera;
    activeRenderer.render({
      ...frameCamera,
      ...(capturingStill ? {} : viewportClipPlanes(frameCamera)),
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      effects,
      exposure: effects.exposure,
      time: controller.motionTime,
      lines: environment.lines,
    });
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

  function renderPass() {
    if (contextLost) {
      return;
    }
    insideDraw = true;
    try {
      syncViewportDimensions();
      drawSceneFrame();
      renderGizmoMarkup(documentReference, gizmoSvg, controller);
      if (!capturingStill) {
        renderSceneObjectMarks(documentReference, gizmoSvg, controller);
      }
      drawAgentOutline();
      syncViewportAids();
    } finally {
      insideDraw = false;
    }
  }

  // A frame that fails pauses the picture with a notice instead of ending the loop in silence; the next requested frame tries again.
  function renderScheduledPass() {
    try {
      renderPass();
      if (!contextLost) {
        pausedNotice.hide();
      }
      return true;
    } catch (error) {
      pausedNotice.show(describeFrameFailure(error));
      return false;
    }
  }

  // The scene, selection and camera stay in the controller. Only what the renderer holds is rebuilt, from the current scene.
  function recoverFromContextLoss() {
    contextLost = false;
    renderedScene = null;
    renderedTopology = null;
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

  function selectSceneObjectAndShowItsPanel(key) {
    controller.selectSceneObject(key);
    selectInspectorTab(key === 'camera' ? 'camera' : 'look');
  }

  function renderOutliner(recipe) {
    const queryText = outlinerSearch.value.trim().toLowerCase();
    const materialsById = new Map(recipe.materials.map(material => [material.id, material]));
    const geometriesById = new Map(recipe.geometries.map(geometry => [geometry.id, geometry]));
    const ordered = depthSortedNodes(recipe.nodes).filter(({ node }) => {
      if (!queryText) return true;
      return (node.label ?? node.id).toLowerCase().includes(queryText) || node.id.toLowerCase().includes(queryText);
    });
    const sceneObjects = controller.listSceneObjects().filter(object => !queryText || object.label.toLowerCase().includes(queryText) || object.key.includes(queryText));
    const objectKey = sceneObjects.map(object => `${object.key}:${object.label}`).join(',');
    const treeKey = `${controller.selectedNodeId ?? ''}|${controller.selectedObjectKey ?? ''}|${objectKey}|${queryText}|${ordered.map(({ node, depth }) => `${depth}:${node.id}:${node.label ?? ''}:${node.visible ?? true}:${node.material ?? ''}:${treeIconName(node, geometriesById)}`).join('|')}`;
    if (treeKey === lastTreeKey) {
      return;
    }
    lastTreeKey = treeKey;
    outlinerTree.replaceChildren(...sceneObjects.map(createSceneObjectRow), ...ordered.map(({ node, depth }) => {
      const material = node.material ? materialsById.get(node.material) : null;
      const selected = node.id === controller.selectedNodeId;
      const iconName = treeIconName(node, geometriesById);
      const badge = createIcon(documentReference, iconName);
      badge.setAttribute('class', 'crucible-studio-icon crucible-studio-tree-badge');
      badge.setAttribute('data-shape', iconName);
      if (material) {
        badge.style.fill = linearRgbToHex(material.color);
      }
      const selectButton = createElement(
        documentReference,
        'button',
        { type: 'button', className: 'crucible-studio-tree-select', dataset: { hidden: node.visible === false ? 'true' : 'false' } },
        badge,
        createElement(documentReference, 'span', { className: 'crucible-studio-tree-label', textContent: node.label ?? node.id }),
      );
      selectButton.style.paddingLeft = `${4 + depth * 12}px`;
      selectButton.addEventListener('click', () => selectNodeAndShowItsPanel(() => controller.selectNode(node.id)));
      selectButton.addEventListener('contextmenu', event => {
        event.preventDefault();
        selectNodeAndShowItsPanel(() => controller.selectNode(node.id));
        openObjectMenu(event.clientX, event.clientY);
      });
      selectButton.addEventListener('dblclick', () => {
        controller.selectNode(node.id);
        selectInspectorTab('node');
        nodeLabelInput.focus();
        nodeLabelInput.select();
      });
      const hidden = node.visible === false;
      const eyeButton = createIconButton(documentReference, hidden ? 'eyeOff' : 'eye', `${hidden ? 'Show' : 'Hide'} ${node.label ?? node.id}`, {
        className: 'crucible-studio-tree-eye',
        dataset: { hidden: hidden ? 'true' : 'false' },
      });
      eyeButton.addEventListener('click', () => controller.updateNodeTransform(node.id, { visible: !(node.visible ?? true) }));
      return createElement(
        documentReference,
        'div',
        { className: 'crucible-studio-tree-row', dataset: { selected: selected ? 'true' : 'false' }, attributes: { role: 'treeitem', 'aria-selected': selected ? 'true' : 'false' } },
        selectButton,
        eyeButton,
      );
    }));
    fitTreeToWholeRows();
  }

  function renderPaletteSwatches(recipe, boundMaterialId) {
    const swatchesKey = `${boundMaterialId ?? ''}|${recipe.materials.map(material => `${material.id}:${linearRgbToHex(material.color)}`).join('|')}`;
    if (swatchesKey === lastSwatchesKey) {
      return;
    }
    lastSwatchesKey = swatchesKey;
    swatchContainer.replaceChildren(...recipe.materials.map(material => {
      const hex = linearRgbToHex(material.color);
      const swatch = createElement(documentReference, 'button', {
        type: 'button',
        className: 'crucible-studio-swatch-btn',
        title: material.id,
        attributes: { 'aria-pressed': material.id === boundMaterialId ? 'true' : 'false', 'aria-label': `Material ${material.id}` },
      });
      swatch.style.background = hex;
      swatch.addEventListener('click', () => {
        if (controller.selectedNodeId) {
          try {
            controller.assignNodeMaterial(controller.selectedNodeId, material.id);
          } catch {
            // group node has no geometry; still open material tab
          }
        }
        selectInspectorTab('material');
      });
      return swatch;
    }));
    scrollPressedSwatchIntoView();
    fitTreeToWholeRows();
  }

  // The strip is one row that scrolls sideways; the swatch of the selected node stays inside it.
  function scrollPressedSwatchIntoView() {
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
  function fitTreeToWholeRows() {
    const view = documentReference.defaultView;
    if (!view?.getComputedStyle || !outlinerTree.style?.removeProperty) {
      return;
    }
    outlinerTree.style.removeProperty('--studio-tree-row-size');
    const firstRow = outlinerTree.firstElementChild;
    if (!firstRow || !(outlinerTree.clientHeight > 0) || outlinerTree.scrollHeight <= outlinerTree.clientHeight) {
      return;
    }
    const treeStyle = view.getComputedStyle(outlinerTree);
    const rowSpace = outlinerTree.clientHeight - parseFloat(treeStyle.paddingTop) - parseFloat(treeStyle.paddingBottom);
    const rowPitch = firstRow.offsetHeight + TREE_ROW_GAP_PIXELS;
    const wholeRows = Math.max(1, Math.floor((rowSpace + TREE_ROW_GAP_PIXELS) / rowPitch));
    const stretchedRowSize = (rowSpace + TREE_ROW_GAP_PIXELS) / wholeRows - TREE_ROW_GAP_PIXELS;
    outlinerTree.style.setProperty('--studio-tree-row-size', `${stretchedRowSize}px`);
  }

  function syncUi() {
    const recipe = controller.exportRecipe();
    toolButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.tool === controller.tool ? 'true' : 'false'));
    undoButton.setAttribute('aria-disabled', controller.canUndo ? 'false' : 'true');
    redoButton.setAttribute('aria-disabled', controller.canRedo ? 'false' : 'true');
    const selectedNode = recipe.nodes.find(node => node.id === controller.selectedNodeId) ?? null;
    const hasNode = Boolean(selectedNode);
    duplicateButton.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    frameButton.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    deleteButton.setAttribute('aria-disabled', hasNode || selectedObjectIsDeletable() ? 'false' : 'true');

    renderOutliner(recipe);

    const parentOptionsKey = `${controller.selectedNodeId ?? ''}|${recipe.nodes.map(node => `${node.id}:${node.label ?? ''}`).join('|')}`;
    if (parentOptionsKey !== lastParentOptionsKey) {
      lastParentOptionsKey = parentOptionsKey;
      nodeParentSelect.replaceChildren(
        createElement(documentReference, 'option', { value: '', textContent: 'Scene root' }),
        ...recipe.nodes
          .filter(node => node.id !== controller.selectedNodeId && !node.assetPart)
          .map(node => createElement(documentReference, 'option', { value: node.id, textContent: node.label ?? node.id })),
      );
      materialSelect.replaceChildren(
        ...recipe.materials.map(material => createElement(documentReference, 'option', { value: material.id, textContent: material.id })),
      );
    }

    nodeLabelInput.disabled = !hasNode;
    nodeParentSelect.disabled = !hasNode;
    visibleToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    castShadowToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    receiveShadowToggle.setAttribute('aria-disabled', hasNode ? 'false' : 'true');
    if (selectedNode) {
      nodeLabelInput.value = selectedNode.label ?? selectedNode.id;
      nodeParentSelect.value = selectedNode.parent ?? '';
      setButtonIcon(visibleToggle, selectedNode.visible === false ? 'eyeOff' : 'eye', selectedNode.visible === false ? 'Show' : 'Hide');
      castShadowToggle.setAttribute('aria-pressed', selectedNode.castShadow === false ? 'false' : 'true');
      receiveShadowToggle.setAttribute('aria-pressed', selectedNode.receiveShadow === false ? 'false' : 'true');
    } else {
      nodeLabelInput.value = '';
      nodeParentSelect.value = '';
    }
    positionRow.setValues(selectedNode?.translation ?? [0, 0, 0]);
    rotationRow.setValues(quaternionToEulerDegrees(selectedNode?.rotation ?? [0, 0, 0, 1]), DEGREE_PRECISION);
    scaleRow.setValues(selectedNode?.scale ?? [1, 1, 1]);

    const boundMaterial = selectedNode?.material ? recipe.materials.find(material => material.id === selectedNode.material) : null;
    renderPaletteSwatches(recipe, boundMaterial?.id ?? null);
    const activeMaterial = boundMaterial ?? recipe.materials[0] ?? null;
    const hasMaterial = Boolean(activeMaterial);
    materialSelect.disabled = !hasMaterial;
    colorInput.disabled = !hasMaterial;
    emissiveColorInput.disabled = !hasMaterial;
    roughnessField.input.disabled = !hasMaterial;
    metallicField.input.disabled = !hasMaterial;
    clearcoatField.input.disabled = !hasMaterial;
    clearcoatRoughnessField.input.disabled = !hasMaterial;
    doubleSidedToggle.disabled = !hasMaterial;
    opacityField.input.disabled = !hasMaterial;
    emissionField.input.disabled = !hasMaterial;
    if (activeMaterial) {
      materialSelect.value = activeMaterial.id;
      colorInput.value = linearRgbToHex(activeMaterial.color);
      emissiveColorInput.value = linearRgbToHex(activeMaterial.emissiveColor ?? activeMaterial.color);
      roughnessField.setValue(activeMaterial.roughness ?? 0.5);
      metallicField.setValue(activeMaterial.metallic ?? 0);
      clearcoatField.setValue(activeMaterial.clearcoat ?? 0);
      clearcoatRoughnessField.setValue(activeMaterial.clearcoatRoughness ?? 0);
      doubleSidedToggle.setAttribute('aria-pressed', activeMaterial.doubleSided === true ? 'true' : 'false');
      opacityField.setValue(activeMaterial.opacity ?? 1);
      emissionField.setValue(activeMaterial.emission ?? 0);
    }

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
        applyButton.addEventListener('click', () => controller.applyBookmark(shot.name));
        removeButton.addEventListener('click', () => controller.removeBookmark(shot.name));
        return createElement(documentReference, 'div', { className: 'crucible-studio-bookmark-row' }, applyButton, removeButton);
      }));
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
    setButtonIcon(playButton, playing ? 'pause' : 'play', playing ? `Pause (${keyLabel(keymap, 'animate.play')})` : `Play (${keyLabel(keymap, 'animate.play')})`);
    timeOutput.textContent = `${controller.motionTime.toFixed(1)} / ${duration.toFixed(1)} s`;
    syncPropertyPanels();
    syncHintBar();
    syncFileBanner();
  }

  // Only the panel in view is redrawn: orbiting the viewport notifies a change many times a second.
  function syncPropertyPanels() {
    if (controller.activeTab === 'look') syncLookPanels();
    if (controller.activeTab === 'camera') cameraPanel.sync();
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
    const lockedAxis = modalTransform.locked ? modalTransform.axis : null;
    const axisChips = MODAL_AXES.map(axis => {
      const key = createElement(documentReference, 'kbd', { textContent: keyLabel(keymap, `modal.axis${axis.toUpperCase()}`), dataset: { axis } });
      key.setAttribute('aria-pressed', lockedAxis === axis ? 'true' : 'false');
      return key;
    });
    hintBar.replaceChildren(
      createElement(documentReference, 'span', { className: 'crucible-studio-hint-delta', textContent: (liveDeltaLabel || MODAL_TOOL_WORDS[modalTransform.tool]).replace(/^SCREEN/, MODAL_TOOL_WORDS.translate) }),
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
    if (modalTransform.lastX !== modalTransform.startX || modalTransform.lastY !== modalTransform.startY) {
      controller.updateGizmoDrag(modalTransform.lastX, modalTransform.lastY, { shiftKey: modalTransform.shiftKey });
    }
  }

  function onModalPointerMove(event) {
    const coordinates = localCoordinates(event);
    modalTransform.lastX = coordinates.x;
    modalTransform.lastY = coordinates.y;
    modalTransform.shiftKey = event.shiftKey;
    controller.updateGizmoDrag(coordinates.x, coordinates.y, { shiftKey: event.shiftKey });
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

  function startModalTransform(tool) {
    if (modalTransform || pointerState || !viewportPointer || !controller.selectedNodeId) {
      return false;
    }
    stopFlight();
    modalTransform = {
      tool,
      axis: null,
      locked: false,
      startX: viewportPointer.x,
      startY: viewportPointer.y,
      lastX: viewportPointer.x,
      lastY: viewportPointer.y,
      shiftKey: false,
    };
    root.dataset.modal = tool;
    beginModalDrag(modalFreeAxis(tool), false);
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
  function lockModalAxis(axis) {
    const release = modalTransform.locked && modalTransform.axis === axis;
    // No axis while the drag is swapped: the change this cancel reports must not read as the object being let go.
    modalTransform.axis = null;
    controller.cancelGizmoDrag();
    beginModalDrag(release ? modalFreeAxis(modalTransform.tool) : axis, !release);
    syncHintBar();
  }

  function handleModalKey(event) {
    if (event.key === 'Shift') {
      return;
    }
    event.preventDefault();
    // A key held down repeats: it may not flip the lock or swap the tool. Ctrl+Z is not the Z axis because the
    // modal bindings carry no Ctrl.
    if (event.repeat) {
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

  gizmoSvg.addEventListener('pointerdown', event => {
    const axis = event.target?.getAttribute?.('data-gizmo-axis');
    if (!axis || (event.button ?? 0) !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const coordinates = localCoordinates(event);
    gizmoSvg.dataset.hoverAxis = axis;
    controller.beginGizmoDrag(axis, coordinates.x, coordinates.y);
    pointerState = { mode: 'gizmo', pointerId: event.pointerId };
    viewportElement.setPointerCapture?.(event.pointerId);
  });

  // The handles lie over the selected object, so a right click on one is a right click on that object.
  gizmoSvg.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (controller.selectedNodeId) {
      openObjectMenu(event.clientX, event.clientY);
    }
  });

  // A press on a light or the sun selects it; with the move tool a light then follows the pointer in the plane through it that faces the view.
  gizmoSvg.addEventListener('pointerdown', event => {
    const key = event.target?.getAttribute?.('data-scene-object');
    if (!key || (event.button ?? 0) !== 0) return;
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

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const coordinates = localCoordinates(event);
    pointerState = {
      mode: event.shiftKey || event.button === 2 || event.button === 1 ? 'pan' : 'orbit',
      startX: coordinates.x,
      startY: coordinates.y,
      lastX: coordinates.x,
      lastY: coordinates.y,
      moved: false,
      pointerId: event.pointerId,
    };
    canvas.setPointerCapture?.(event.pointerId);
  });

  viewportElement.addEventListener('pointermove', event => {
    if (!pointerState) return;
    const coordinates = localCoordinates(event);
    if (pointerState.mode === 'gizmo') {
      controller.updateGizmoDrag(coordinates.x, coordinates.y, { shiftKey: event.shiftKey });
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
      announce(error.message);
    }
  }

  function finishPointer(event) {
    if (!pointerState) return;
    const finished = pointerState;
    pointerState = null;
    if (finished.mode === 'light') {
      controller.endUndoGroup();
      return;
    }
    if (finished.mode === 'gizmo') {
      delete gizmoSvg.dataset.hoverAxis;
      controller.endGizmoDrag();
      return;
    }
    if (!finished.moved) {
      const coordinates = localCoordinates(event);
      if (controller.tool === 'snap' && controller.selectedNodeId && event.altKey) {
        controller.snapSelectedToAt(coordinates.x, coordinates.y);
      } else {
        selectNodeAndShowItsPanel(() => controller.pickAt(coordinates.x, coordinates.y));
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
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    stopFlight();
    controller.orbitCamera({ zoomScale: 1 + Math.max(-0.35, Math.min(0.35, event.deltaY * 0.0012)) });
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
    try {
      await loadExternalTextFile(await file.text(), { filePath: file.path || null, fileName: file.name });
      announce(`Loaded ${file.name}`);
    } catch (error) {
      announce(error.message);
    }
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
    controller.deleteSelected();
    announce('Deleted node');
  }

  function duplicateSelection() {
    if (controller.selectedNodeId) {
      const cloned = controller.duplicateSelected();
      announce(`Duplicated to ${cloned.label}`);
    }
  }

  function copySelection() {
    if (!controller.selectedNodeId) return;
    controller.copySelected();
    announce('Copied');
  }

  function pasteCopy() {
    if (!controller.canPaste) return;
    try {
      const pasted = controller.pasteCopy();
      announce(`Pasted ${pasted.label}`);
    } catch (error) {
      announce(error.message);
    }
  }

  // Text the person selected on the page belongs to the browser's own copy.
  function pageTextIsSelected() {
    const selection = documentReference.defaultView?.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && selection.toString() !== '');
  }

  // Handlers of the normal context by action id. A handler calls preventDefault for the keys the browser would
  // otherwise use itself (save, open, copy, undo and so on).
  const keyHandlers = {
    'tool.select': () => controller.setTool('select'),
    'tool.snap': () => controller.setTool('snap'),
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
    'edit.delete': event => {
      if (!controller.selectedNodeId && !selectedObjectIsDeletable()) return;
      event.preventDefault();
      deleteSelection();
    },
    'edit.deselect': () => {
      if (controller.selectedNodeId || controller.selectedObjectKey) controller.selectNode(null);
    },
    'edit.hide': () => hideSelection(),
    'edit.showAll': event => {
      event.preventDefault();
      showAllHidden();
    },
    'edit.undo': event => {
      event.preventDefault();
      controller.undo();
    },
    'edit.redo': event => {
      event.preventDefault();
      controller.redo();
    },
    'view.frame': () => flyToSelection(),
    'view.projection': () => controller.toggleCameraProjection(),
    'view.properties': () => setInspectorCollapsed(root.dataset.inspectorCollapsed !== 'true'),
    'animate.keyframe': () => keyframeButton.click(),
    'animate.play': event => {
      event.preventDefault();
      playButton.click();
    },
    'file.open': event => {
      event.preventDefault();
      performOpenFile();
    },
    'file.save': event => {
      event.preventDefault();
      performSaveFile({ forceAs: false });
    },
    'file.saveAs': event => {
      event.preventDefault();
      performSaveFile({ forceAs: true });
    },
    'settings.open': event => {
      event.preventDefault();
      settingsDialog.showModal();
    },
    'help.shortcuts': () => shortcutsDialog.showModal(),
  };
  for (const [actionId, tool] of Object.entries(PICK_UP_TOOL_BY_ACTION)) {
    keyHandlers[actionId] = () => pickUpWithTool(tool);
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
    if (!root.isConnected) {
      return;
    }
    if (modalTransform) {
      handleModalKey(event);
      return;
    }
    if (isEditableTarget(event.target, event.key)) {
      return;
    }
    const match = findKeymapAction(keymap, event, 'normal');
    if (!match) {
      return;
    }
    // A Ctrl key works over an open dialog; a plain key does not.
    const dialogIsOpen = recipeDialog.open || shortcutsDialog.open || settingsDialog.open;
    if (dialogIsOpen && !match.binding.ctrl) {
      return;
    }
    keyHandlers[match.actionId](event, match.binding);
  };
  documentReference.addEventListener('keydown', onWindowKeyDown);

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
    toggleDocksButton.setAttribute('aria-pressed', root.dataset.outlinerCollapsed === 'false' || root.dataset.inspectorCollapsed === 'false' ? 'true' : 'false');
    requestFrame();
  }

  // The draft follows the edits a moment after they stop. The first edit made while the notice offers the older draft
  // answers it: the person carries on with the current scene, so the notice closes and the draft follows the new work.
  let draftTimer = 0;

  function writeDraftNow() {
    draftTimer = 0;
    saveStudioDraft(preferenceStorage, controller.exportRecipe(), activeFileName);
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
      isDirty = true;
      syncFileBanner();
      announce('Restored the unsaved changes');
    } catch (error) {
      clearStudioDraft(preferenceStorage);
      announce(`The saved draft could not be restored: ${error.message}`);
    }
  }

  function offerDraft() {
    const draft = loadStudioDraft(preferenceStorage);
    if (draft && draftDiffersFrom(draft, controller.exportRecipe())) {
      draftNotice.show(draft.fileName);
    }
  }

  handleChange = detail => {
    selectionReadoutStale = true;
    // The object a key is holding is gone or no longer the selection: let go without touching the new scene.
    if (modalTransform && modalTransform.axis && !controller.dragging) {
      finishModalTransform(false);
    }
    if (detail.deltaLabel !== undefined) {
      liveDeltaLabel = detail.deltaLabel;
    }
    if (['topology', 'transform', 'transformCommit', 'material', 'look', 'undo', 'redo'].includes(detail.kind) || (detail.kind === 'camera' && detail.edited)) {
      isDirty = true;
      scheduleDraftSave();
    }
    syncUi();
    if (detail.kind === 'tab' || insideDraw) return;
    requestFrame();
  };

  // Below the compact width the panels start closed, so the scene keeps the screen.
  function syncCompactLayout() {
    // Between the compact width and this one the menus, the tabs and the file name do not fit on one row, so the file
    // name leaves: it is also the title of the File menu's own rows.
    root.dataset.tight = root.clientWidth > 0 && root.clientWidth < TIGHT_WIDTH ? 'true' : 'false';
    const compact = root.clientWidth > 0 && root.clientWidth < COMPACT_WIDTH;
    if ((root.dataset.compact === 'true') === compact) {
      return;
    }
    root.dataset.compact = compact ? 'true' : 'false';
    setOutlinerCollapsed(compact);
    setInspectorCollapsed(compact);
  }
  syncCompactLayout();

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      syncCompactLayout();
      fitTreeToWholeRows();
      requestFrame();
    });
    resizeObserver.observe(viewportElement);
    resizeObserver.observe(outlinerTree);
  }
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
      announce(error.message);
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
    setPreference,
    get preferences() { return { ...preferences }; },
    /** Opens the first-run setup, one step a page. Studio never opens it on its own. */
    openSetup,
    get setupDone() { return preferences.setupDone; },
    selectNode: nodeId => controller.selectNode(nodeId),
    setTool: tool => controller.setTool(tool),
    setActiveTab: tab => selectInspectorTab(tab),
    pickAt: (pixelX, pixelY) => controller.pickAt(pixelX, pixelY),
    setOutlinerCollapsed,
    setInspectorCollapsed,
    capturePngDataUrl,
    exportGlbBytes,
    buildWebPackPayload,
    shouldAutoReloadExternal() {
      return autoReloadWatch;
    },
    setFileContext({ filePath, fileName, dirty }) {
      if (filePath !== undefined) activeFilePath = filePath;
      if (fileName !== undefined) activeFileName = fileName;
      if (dirty !== undefined) isDirty = Boolean(dirty);
      syncFileBanner();
    },
    renderNow() {
      renderPass();
    },
    dispose() {
      clearTimeout(draftTimer);
      clearTimeout(statusTimer);
      agentPresence.dispose();
      systemSchemeQuery?.removeEventListener?.('change', onSystemSchemeChange);
      if (frameHandle) cancelAnimationFrame(frameHandle);
      stopFlight();
      finishModalTransform(false);
      documentReference.removeEventListener('contextmenu', onModalContextMenu, true);
      documentReference.removeEventListener('click', onModalClick, true);
      documentReference.removeEventListener('pointerdown', onAnyPointerDown, true);
      documentReference.removeEventListener('keydown', onWindowKeyDown);
      documentReference.removeEventListener('visibilitychange', onVisibilityChange);
      documentReference.removeEventListener('visibilitychange', flushDraftWhenHidden);
      documentReference.defaultView?.removeEventListener?.('pagehide', flushDraftSave);
      stopWatchingContextLoss();
      pausedNotice.hide();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      controller.dispose();
      renderer?.dispose();
      catalog.dispose();
      root.remove();
    },
  };
}
