import { agentGroundPlacement } from './agent-ground.js';
import { formatLengthTuple } from './studio-units.js';

// Working aids for the Studio viewport: a ground grid with the world axes, a view widget that shows where the camera
// looks and snaps to the main views, and a readout of the camera and the selection. None of them is part of the scene.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// The renderer draws its own floor at 0.019 m, so the grid has to sit above that to show. Up close it stays within 3 mm
// of it, or the lines would cut a visible notch into the base of anything that rests on the ground; from far away the
// gap grows with the view, or the depth buffer could no longer tell the lines from the floor.
const GRID_FLOOR_HEIGHT = 0.019;
const GRID_MINIMUM_LIFT = 0.0022;
const GRID_LIFT_PIXELS = 0.25;
// The grid is three sheets of square cells, each ten times coarser than the one before. Each sheet is a textured quad: the
// lines are in a texture, so the graphics card thins and fades them with distance instead of leaving sparkling dots
// near the horizon, which is what lines drawn as geometry did.
const GRID_SHEETS = 3;
// Cells either side of the middle of a sheet. The quad carries the cell count in its own texture coordinates.
const GRID_SHEET_REACH = 512;
// A line is one texel of its texture, so a texture of S texels draws lines 1/S of a cell wide. A sheet has one quad per
// size and shows the one whose line is closest to a pixel wide at the camera target.
const GRID_TEXTURE_SIZES = Object.freeze([32, 64, 128, 256, 512, 1024]);
const GRID_WIDEST_LINE_PIXELS = 1.5;
const GRID_LOWEST_EYE_SHARE = 0.04;
// How strong a line of the finest sheet is at most, and how strong every tenth line is.
const GRID_FINE_OPACITY = 0.24;
const GRID_COARSE_OPACITY = 0.42;
const GRID_LINE_COLOR = Object.freeze([0.62, 0.62, 0.68]);
const GRID_AXIS_PIXELS = 1.5;
const GRID_AXIS_TEXTURE_SIZE = 256;
const GRID_AXIS_OPACITY = 0.8;
const GRID_AXIS_COLORS = Object.freeze({ x: [0.93, 0.38, 0.32], z: [0.28, 0.6, 1] });
// About this many fine steps fit the height of the view before the grid moves to the next step.
const GRID_STEPS_IN_VIEW = 4;
const GRID_PARKED_HEIGHT = -1e5;
const DEFAULT_GRID_VIEW = Object.freeze({ visibleHeight: 5, viewportHeight: 720, target: [0, 0.5, 0] });
const VIEWPORT_NEAR_SHARE = 100;
const VIEWPORT_FAR_REACH = 80;
const VIEWPORT_FLOOR_REACH = 40000;
const WIDGET_SIZE = 76;
const WIDGET_REACH = 26;

export const GRID_PART_PREFIX = 'studio-grid-';
export const AXIS_COLORS = Object.freeze({ x: '#ee7a6c', y: '#5fc48a', z: '#5ea8ff' });
const AXIS_VECTORS = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
// The view each end of an axis snaps to. Looking up from below has no preset, so the low end of Y only shows.
const AXIS_VIEWS = Object.freeze({ x: ['right', 'left'], y: ['top', null], z: ['front', 'back'] });

/** How much of the world the camera sees from top to bottom at its target, in metres. The grid sizes itself from it. */
export function cameraVisibleHeight(camera) {
  if (camera.projection === 'orthographic') {
    return camera.orthoScale ?? 4;
  }
  const distance = Math.hypot(camera.eye[0] - camera.target[0], camera.eye[1] - camera.target[1], camera.eye[2] - camera.target[2]);
  if (Number.isFinite(camera.focalLength)) {
    return (distance * 24) / camera.focalLength;
  }
  return 2 * distance * Math.tan(((camera.fov ?? 45) * Math.PI) / 360);
}

/**
 * Where the grid goes for a view: `{ step, sheets, lines }`. The step is 1 m up close and grows tenfold as the camera
 * pulls back (10 m, 100 m), the way Blender's floor does. `sheets` places every textured quad, each
 * `{ id, translation, scale, opacity }`: per sheet one quad is shown and the others are put away. As the next step
 * comes closer the finest sheet fades out and the middle one drops to the strength the finest started at, so a step
 * change moves no line and changes no brightness. `lines` places the two axis lines, which are textured strips as
 * well. The grid follows the camera target in whole cells.
 */
export function gridLayout({ visibleHeight, viewportHeight, target, eye } = DEFAULT_GRID_VIEW) {
  const level = Math.log10(Math.max(1e-3, visibleHeight) / GRID_STEPS_IN_VIEW);
  const step = 10 ** Math.floor(level);
  const blend = level - Math.floor(level);
  const pixel = visibleHeight / Math.max(1, viewportHeight);
  const lift = Math.max(GRID_MINIMUM_LIFT, pixel * GRID_LIFT_PIXELS);
  const height = GRID_FLOOR_HEIGHT + lift;
  // What a line of each sheet should add up to, and from it what each sheet draws: a coarser line lies on top of the
  // finer ones that share its place.
  // The finest lines hold most of their strength through the step and drop away at the end of it.
  const fineOpacity = GRID_FINE_OPACITY * (1 - blend ** 3);
  const middleTotal = GRID_COARSE_OPACITY - (GRID_COARSE_OPACITY - GRID_FINE_OPACITY) * blend ** 3;
  const opacities = [fineOpacity, 1 - (1 - middleTotal) / (1 - fineOpacity), 1 - (1 - GRID_COARSE_OPACITY) / (1 - middleTotal)];
  // A camera low over the floor sees the ground just in front of it much closer than its target, and a line sized for
  // the target would be many pixels wide there. With `eye` given, lines are sized for a point between the two.
  const viewDistance = eye ? Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]) : 0;
  const nearShare = viewDistance > 0 ? Math.sqrt(Math.min(1, Math.max(GRID_LOWEST_EYE_SHARE, Math.abs(eye[1] - GRID_FLOOR_HEIGHT) / viewDistance))) : 1;
  const sheets = [];
  for (let sheetIndex = 0; sheetIndex < GRID_SHEETS; sheetIndex += 1) {
    const spacing = step * 10 ** sheetIndex;
    const cellPixels = spacing / pixel;
    const shownSize = GRID_TEXTURE_SIZES.find(size => cellPixels / size <= GRID_WIDEST_LINE_PIXELS * nearShare) ?? GRID_TEXTURE_SIZES.at(-1);
    for (const size of GRID_TEXTURE_SIZES) {
      const id = `${GRID_PART_PREFIX}sheet${sheetIndex}-${size}`;
      if (size !== shownSize) {
        sheets.push({ id, translation: [0, GRID_PARKED_HEIGHT, 0], scale: [1e-3, 1, 1e-3], opacity: 0 });
        continue;
      }
      sheets.push({
        id,
        translation: [Math.round(target[0] / spacing) * spacing, height, Math.round(target[2] / spacing) * spacing],
        scale: [spacing, 1, spacing],
        opacity: opacities[sheetIndex],
      });
    }
  }
  const axisLength = GRID_SHEET_REACH * 2 * step * 10 ** (GRID_SHEETS - 1);
  // An axis strip is one texture cell wide and its line one texel of it, so the strip is this much wider than the line.
  const axisWidth = pixel * GRID_AXIS_PIXELS * nearShare * GRID_AXIS_TEXTURE_SIZE;
  const lines = [
    { id: `${GRID_PART_PREFIX}axis-x`, translation: [Math.round(target[0] / step) * step, height + lift * 0.5, 0], scale: [axisLength, 1, axisWidth] },
    { id: `${GRID_PART_PREFIX}axis-z`, translation: [0, height + lift * 0.5, Math.round(target[2] / step) * step], scale: [axisWidth, 1, axisLength] },
  ];
  return { step, sheets, lines };
}

// The picture of one cell: white everywhere, opaque along two edges and clear inside, so the tiled cells draw a grid.
// With `rowsOnly` only the first row is opaque, which draws the one line of an axis strip.
function gridCellImage(size, rowsOnly = false) {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (row !== 0 && (rowsOnly || column !== 0)) {
        data[(row * size + column) * 4 + 3] = 0;
      }
    }
  }
  return typeof ImageData === 'function' ? new ImageData(data, size, size) : { width: size, height: size, data };
}

/**
 * The grid as renderer parts: for each sheet one quad per line texture, then the X axis strip in red and the Z axis
 * strip in blue. They are built here and not from a recipe, because a recipe cannot carry a generated texture.
 * `imageOf(size, rowsOnly)` supplies the picture of one cell.
 */
export function buildGridParts(imageOf = gridCellImage) {
  const reach = GRID_SHEET_REACH;
  const geometry = {
    positions: new Float32Array([-reach, 0, -reach, -reach, 0, reach, reach, 0, reach, reach, 0, -reach]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([-reach, -reach, -reach, reach, reach, reach, reach, -reach]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const images = new Map(GRID_TEXTURE_SIZES.map(size => [size, imageOf(size, false)]));
  const sheetMaterial = (color, opacity, image) => ({ color: [...color], metallic: 0, roughness: 1, emission: 0, tag: 'unlit', alphaMode: 'blend', opacity, doubleSided: true, map: { image, colorSpace: 'linear' } });
  const parkedMatrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, GRID_PARKED_HEIGHT, 0, 1]);
  const parts = [];
  for (let sheetIndex = 0; sheetIndex < GRID_SHEETS; sheetIndex += 1) {
    for (const size of GRID_TEXTURE_SIZES) {
      parts.push({
        name: `${GRID_PART_PREFIX}sheet${sheetIndex}-${size}`,
        geometry,
        matrix: parkedMatrix(),
        material: sheetMaterial(GRID_LINE_COLOR, 0, images.get(size)),
        castShadow: false,
        receiveShadow: false,
        depthLayer: 1,
      });
    }
  }
  // An axis strip lies half a cell either side of its axis, with the line of the texture in the middle of it.
  const axisImage = imageOf(GRID_AXIS_TEXTURE_SIZE, true);
  // The second texture coordinate runs across the strip: along z for the X axis and along x for the Z axis.
  const strip = alongX => ({
    positions: new Float32Array([-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5]),
    normals: geometry.normals,
    uvs: alongX ? new Float32Array([0, -0.5, 0, 0.5, 1, 0.5, 1, -0.5]) : new Float32Array([0, -0.5, 1, -0.5, 1, 0.5, 0, 0.5]),
    indices: geometry.indices,
  });
  for (const axis of ['x', 'z']) {
    parts.push({
      name: `${GRID_PART_PREFIX}axis-${axis}`,
      geometry: strip(axis === 'x'),
      matrix: parkedMatrix(),
      material: sheetMaterial(GRID_AXIS_COLORS[axis], GRID_AXIS_OPACITY, axisImage),
      castShadow: false,
      receiveShadow: false,
      depthLayer: 2,
    });
  }
  return parts;
}

/**
 * The near and far planes the viewport draws with. They follow how far the camera has pulled back: a scene camera that
 * stops at 120 m would cut the floor, the grid and every object away once the view is further out than that, and
 * leave a frame of plain background.
 */
export function viewportClipPlanes(camera) {
  const distance = Math.hypot(camera.eye[0] - camera.target[0], camera.eye[1] - camera.target[1], camera.eye[2] - camera.target[2]);
  return {
    near: Math.max(camera.near ?? 0.1, distance / VIEWPORT_NEAR_SHARE),
    far: Math.max(camera.far ?? 100, distance * VIEWPORT_FAR_REACH),
  };
}

/**
 * Whether the viewport draws its own floor. It follows the preview's rule (src/agent-ground.js): no floor when the recipe
 * turns the ground off or a part of it already forms one. An empty scene keeps the floor. Give it scene parts only.
 */
export function studioDrawsFloor(parts, environment) {
  if (parts.length === 0) {
    return true;
  }
  return agentGroundPlacement(parts, environment) !== null;
}

/** The floor of the viewport as a renderer part. It reaches the horizon at any zoom the camera allows, so its edge never shows. */
export function viewportFloorPart(floorHeight) {
  const reach = VIEWPORT_FLOOR_REACH;
  return {
    name: 'Studio floor',
    geometry: {
      positions: new Float32Array([-reach, floorHeight, -reach, -reach, floorHeight, reach, reach, floorHeight, reach, reach, floorHeight, -reach]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.04, 0.05, 0.06], metallic: 0, roughness: 1, emission: 0, tag: 'floor' },
  };
}

/** Moves the grid parts to a layout. Each part keeps its geometry and material; its matrix is rewritten in place, and a sheet also takes its opacity. */
export function placeGridParts(partsByName, layout) {
  for (const line of [...layout.sheets, ...layout.lines]) {
    const part = partsByName.get(line.id);
    const matrix = part?.matrix;
    if (!matrix) {
      continue;
    }
    if (line.opacity !== undefined) {
      part.material.opacity = line.opacity;
    }
    matrix.fill(0);
    matrix[0] = line.scale[0];
    matrix[5] = line.scale[1];
    matrix[10] = line.scale[2];
    matrix[12] = line.translation[0];
    matrix[13] = line.translation[1];
    matrix[14] = line.translation[2];
    matrix[15] = 1;
  }
}

/** The grid step as the readout shows it, such as "10 cm", "1 m" or "100 m". */
export function describeGridStep(step) {
  if (step >= 1000) {
    return `${Math.round(step / 1000)} km`;
  }
  if (step >= 1) {
    return `${Math.round(step)} m`;
  }
  return step >= 0.01 ? `${Math.round(step * 100)} cm` : `${Math.round(step * 1000)} mm`;
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/**
 * Where the six axis ends fall for a camera, as seen on screen: `x` and `y` from -1 to 1 (y grows downward) and
 * `depth` from -1 (pointing away) to 1 (pointing at the viewer). Sorted far to near, so the near ends draw last.
 */
export function axisWidgetEnds(camera) {
  const forward = normalize([camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]]);
  const right = normalize(cross(forward, camera.up ?? [0, 1, 0]));
  const up = cross(right, forward);
  const ends = [];
  for (const axis of Object.keys(AXIS_VECTORS)) {
    for (const sign of [1, -1]) {
      const direction = AXIS_VECTORS[axis].map(component => component * sign);
      ends.push({
        axis,
        positive: sign === 1,
        view: AXIS_VIEWS[axis][sign === 1 ? 0 : 1],
        x: dot(direction, right),
        y: -dot(direction, up),
        depth: -dot(direction, forward),
      });
    }
  }
  return ends.sort((first, second) => first.depth - second.depth);
}

function svgElement(documentReference, tagName, attributes) {
  const element = documentReference.createElementNS(SVG_NAMESPACE, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

/** The view widget: the three world axes as the camera sees them. Clicking an end calls `onPickView` with its view name. */
export function createViewWidget(documentReference, { onPickView }) {
  const widget = svgElement(documentReference, 'svg', {
    class: 'crucible-studio-view-widget',
    viewBox: `0 0 ${WIDGET_SIZE} ${WIDGET_SIZE}`,
    role: 'group',
    'aria-label': 'View direction',
  });
  const centre = WIDGET_SIZE / 2;
  let lastKey = '';

  function update(camera) {
    const ends = axisWidgetEnds(camera);
    const key = ends.map(end => `${end.axis}${end.positive ? '+' : '-'}${end.x.toFixed(2)},${end.y.toFixed(2)}`).join('|');
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    const marks = [];
    for (const end of ends) {
      const x = centre + end.x * WIDGET_REACH;
      const y = centre + end.y * WIDGET_REACH;
      const color = AXIS_COLORS[end.axis];
      if (end.positive) {
        marks.push(svgElement(documentReference, 'line', { x1: centre, y1: centre, x2: x.toFixed(1), y2: y.toFixed(1), stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
      }
      const knob = svgElement(documentReference, 'circle', {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: end.positive ? 8.5 : 6,
        fill: end.positive ? color : 'var(--studio-panel)',
        stroke: color,
        'stroke-width': 1.5,
        'data-axis-end': `${end.positive ? '+' : '-'}${end.axis}`,
      });
      marks.push(knob);
      if (end.view) {
        knob.setAttribute('data-view', end.view);
        knob.setAttribute('role', 'button');
        knob.setAttribute('aria-label', `${end.view[0].toUpperCase()}${end.view.slice(1)} view`);
        knob.addEventListener('click', () => onPickView(end.view));
      }
      if (end.positive) {
        const letter = svgElement(documentReference, 'text', { x: x.toFixed(1), y: (y + 3.6).toFixed(1), 'text-anchor': 'middle', class: 'crucible-studio-view-letter' });
        letter.textContent = end.axis.toUpperCase();
        marks.push(letter);
      }
    }
    widget.replaceChildren(...marks);
  }

  return { element: widget, update };
}

/** The camera half of the readout, such as "Perspective | 50 mm" or "Orthographic". */
export function describeCamera(camera) {
  if (camera.projection === 'orthographic') {
    return 'Orthographic';
  }
  return Number.isFinite(camera.focalLength) ? `Perspective | ${Math.round(camera.focalLength)} mm` : `Perspective | ${Math.round(camera.fov ?? 45)}°`;
}

/** The selection half of the readout: the object's size in the chosen length unit, width × height × depth. */
export function describeBounds(bounds, lengthUnit = 'm') {
  return formatLengthTuple(bounds.size, lengthUnit);
}
