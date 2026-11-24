// Studio proportional editing: while it is on, a held move in edit mode takes the vertices around the picked ones along, by
// a curve that fades to nothing at a radius. The settings, the popover that sets them and the circle that shows the radius
// live here, so studio.js only adds the toggle and the wheel. The move itself is the `translate` edit with a `falloff`,
// the same one a recipe or an agent writes (src/mesh-ops.js), so the log replays the hill the person shaped.

import { FALLOFF_CURVES } from './mesh-ops.js';

export const PROPORTIONAL_CURVES = Object.freeze([
  Object.freeze({ id: 'smooth', label: 'Smooth' }),
  Object.freeze({ id: 'sphere', label: 'Round' }),
  Object.freeze({ id: 'root', label: 'Root' }),
  Object.freeze({ id: 'sharp', label: 'Sharp' }),
  Object.freeze({ id: 'linear', label: 'Linear' }),
  Object.freeze({ id: 'constant', label: 'Flat' }),
]);

export const PROPORTIONAL_DEFAULT_RADIUS = 0.5;
export const PROPORTIONAL_MIN_RADIUS = 0.01;
export const PROPORTIONAL_MAX_RADIUS = 100;
// One wheel notch grows or shrinks the radius by this factor.
export const PROPORTIONAL_WHEEL_FACTOR = 1.15;
// A move that is not whole faces names its vertices in the edit, so the list stays short enough to read in a recipe.
export const MAX_PROPORTIONAL_SEEDS = 256;

const CIRCLE_SEGMENTS = 64;
const CURVE_IDS = PROPORTIONAL_CURVES.map(curve => curve.id);

function roundRadius(radius) {
  return Number(Math.min(PROPORTIONAL_MAX_RADIUS, Math.max(PROPORTIONAL_MIN_RADIUS, radius)).toPrecision(3));
}

/**
 * The proportional settings of one Studio: on or off, the radius in the mesh's own units and the curve. `onChange` runs
 * after each change, so the toggle, the popover and a held move all follow.
 */
export function createProportionalSettings({ onChange = () => {} } = {}) {
  let enabled = false;
  let radius = PROPORTIONAL_DEFAULT_RADIUS;
  let curve = 'smooth';

  function setEnabled(value) {
    enabled = Boolean(value);
    onChange();
  }

  function setRadius(value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The proportional radius is ${value}: pass a number above 0, up to ${PROPORTIONAL_MAX_RADIUS}.`);
    }
    radius = roundRadius(value);
    onChange();
  }

  function setCurve(value) {
    if (!CURVE_IDS.includes(value)) {
      throw new RangeError(`The proportional curve is "${value}": pass one of ${CURVE_IDS.join(', ')}.`);
    }
    curve = value;
    onChange();
  }

  // Wheel up (a positive step) widens the reach, wheel down narrows it.
  function resize(steps) {
    setRadius(radius * PROPORTIONAL_WHEEL_FACTOR ** steps);
  }

  return Object.freeze({
    get enabled() { return enabled; },
    get radius() { return radius; },
    get curve() { return curve; },
    setEnabled,
    toggle: () => setEnabled(!enabled),
    setRadius,
    setCurve,
    resize,
    /** The `falloff` field of the edit this move writes, or null while proportional editing is off. */
    falloff: () => (enabled ? { radius, curve } : null),
  });
}

/**
 * The outline of the reach as an SVG path: a circle of `worldRadius` around `centre` in the plane that faces the camera,
 * so it reads as a round brush from any view. `viewDirection` points from the camera into the scene. Returns '' when the
 * centre is behind the camera.
 */
export function proportionalCirclePath(centre, worldRadius, viewDirection, project) {
  const upGuess = Math.abs(viewDirection[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalized(cross(viewDirection, upGuess));
  const up = cross(right, viewDirection);
  let path = '';
  for (let step = 0; step < CIRCLE_SEGMENTS; step += 1) {
    const angle = (step / CIRCLE_SEGMENTS) * Math.PI * 2;
    const point = project([0, 1, 2].map(axis => centre[axis] + worldRadius * (Math.cos(angle) * right[axis] + Math.sin(angle) * up[axis])));
    if (!point.visible) return '';
    path += `${step === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }
  return `${path}Z`;
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalized(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(component => component / length);
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// A curve drawn as the weight it gives at each distance: 1 at the picked vertex, 0 at the radius.
function curveGlyph(documentReference, curveId, curveFunction) {
  const svg = documentReference.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('class', 'crucible-studio-curve-glyph');
  svg.setAttribute('aria-hidden', 'true');
  let path = '';
  for (let step = 0; step <= 12; step += 1) {
    const distance = step / 12;
    const weight = curveFunction(distance);
    path += `${step === 0 ? 'M' : 'L'}${(2 + distance * 20).toFixed(2)} ${(14 - weight * 12).toFixed(2)}`;
  }
  const line = documentReference.createElementNS(SVG_NAMESPACE, 'path');
  line.setAttribute('d', path);
  svg.append(line);
  svg.dataset.curve = curveId;
  return svg;
}

/**
 * The popover of the viewport bar: the curve as a short list of drawn shapes and the size as a slider. Returns the element
 * and a `sync()` that rewrites it from the settings (the wheel changes the radius too).
 */
export function createProportionalPopover({ documentReference, settings, popoverId }) {
  const popover = documentReference.createElement('div');
  popover.id = popoverId;
  popover.className = 'crucible-studio-popover crucible-studio-proportional-popover';
  popover.setAttribute('popover', 'auto');

  const curveGroup = documentReference.createElement('div');
  curveGroup.className = 'crucible-studio-curve-list';
  curveGroup.setAttribute('role', 'group');
  curveGroup.setAttribute('aria-label', 'Falloff');
  const curveButtons = PROPORTIONAL_CURVES.map(({ id, label }) => {
    const button = documentReference.createElement('button');
    button.type = 'button';
    button.dataset.proportionalCurve = id;
    const name = documentReference.createElement('span');
    name.textContent = label;
    button.append(curveGlyph(documentReference, id, FALLOFF_CURVES[id]), name);
    button.addEventListener('click', () => settings.setCurve(id));
    return button;
  });
  curveGroup.append(...curveButtons);

  const sizeRow = documentReference.createElement('label');
  sizeRow.className = 'crucible-studio-proportional-size';
  const sizeName = documentReference.createElement('span');
  sizeName.textContent = 'Size';
  const slider = documentReference.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.001';
  slider.dataset.proportionalSize = 'true';
  const readout = documentReference.createElement('output');
  sizeRow.append(sizeName, slider, readout);
  // The slider runs on a log scale: the same distance on it is the same share of the radius, at 0.05 or at 50.
  const logMinimum = Math.log(PROPORTIONAL_MIN_RADIUS);
  const logSpan = Math.log(PROPORTIONAL_MAX_RADIUS) - logMinimum;
  slider.addEventListener('input', () => settings.setRadius(Math.exp(logMinimum + Number(slider.value) * logSpan)));

  popover.append(curveGroup, sizeRow);

  function sync() {
    for (const button of curveButtons) button.setAttribute('aria-pressed', button.dataset.proportionalCurve === settings.curve ? 'true' : 'false');
    const position = (Math.log(settings.radius) - logMinimum) / logSpan;
    if (documentReference.activeElement !== slider) slider.value = String(position);
    slider.setAttribute('aria-valuetext', `${settings.radius}`);
    readout.textContent = String(settings.radius);
  }
  sync();
  return { popover, sync };
}
