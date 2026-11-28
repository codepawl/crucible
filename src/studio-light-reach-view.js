import { createSvgElement } from './studio-svg.js';
import { ensureLightReachStyles } from './studio-light-reach-styles.js';
import { sceneSphereOf } from './studio-sun-mark.js';
import {
  areaGroundFootprint,
  areaReachHandles,
  pointGroundFootprint,
  pointReachHandles,
  spotGroundFootprint,
  spotReachHandles,
  sunReach,
} from './studio-light-reach.js';

// Draws each light's lit ground footprint (in full with drag handles when selected, faint otherwise) and the selected
// sun's ground ring with a single direction arrow over the Studio viewport.
const LIGHT_FIELDS = Object.freeze({ point: 'pointLights', spot: 'spotLights', area: 'areaLights' });
const HANDLE_DOT_RADIUS = 4;
const HANDLE_HIT_RADIUS = 10;

/** The runs of screen points a world polyline draws as, cut wherever a point is behind the camera. */
export function projectPolylineRuns(project, polyline) {
  const runs = [];
  let run = [];
  for (const worldPoint of polyline) {
    const projected = project(worldPoint);
    if (projected.visible) {
      run.push(projected);
      continue;
    }
    if (run.length > 1) {
      runs.push(run);
    }
    run = [];
  }
  if (run.length > 1) {
    runs.push(run);
  }
  return runs;
}

function pathDataOfRuns(runs) {
  return runs.map(run => run.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')).join(' ');
}

function fillPathData(project, points) {
  const projected = points.map(project);
  if (projected.some(point => !point.visible)) {
    return null;
  }
  return projected.length < 3 ? null : `${pathDataOfRuns([projected])} Z`;
}

function appendPath(documentReference, layer, className, pathData, attributes = {}) {
  if (pathData) {
    layer.push(createSvgElement(documentReference, 'path', { class: className, d: pathData, ...attributes }));
  }
}

function appendLines(documentReference, layer, project, lineGroups) {
  for (const group of lineGroups) {
    const runs = group.polylines.flatMap(polyline => projectPolylineRuns(project, polyline));
    appendPath(documentReference, layer, 'crucible-studio-light-reach-line', pathDataOfRuns(runs), { 'data-role': group.role });
  }
}

function appendHandle(documentReference, layer, project, worldPoint, key, handleKind, label) {
  if (!worldPoint) {
    return;
  }
  const screenPoint = project(worldPoint);
  if (!screenPoint.visible) {
    return;
  }
  const cx = screenPoint.x.toFixed(1);
  const cy = screenPoint.y.toFixed(1);
  const handleAttributes = { 'data-reach-object': key, 'data-light-reach-handle': handleKind };
  layer.push(createSvgElement(documentReference, 'circle', {
    class: 'crucible-studio-light-reach-handle-dot',
    cx,
    cy,
    r: HANDLE_DOT_RADIUS,
    ...handleAttributes,
  }));
  const hitCircle = createSvgElement(documentReference, 'circle', {
    class: 'crucible-studio-light-reach-hit',
    cx,
    cy,
    r: HANDLE_HIT_RADIUS,
    'aria-label': label,
    ...handleAttributes,
  });
  const title = createSvgElement(documentReference, 'title');
  title.textContent = label;
  hitCircle.append(title);
  layer.push(hitCircle);
}

function appendGroundOutline(documentReference, layer, project, outline, filled) {
  if (outline.length === 0) {
    return;
  }
  if (filled) {
    appendPath(documentReference, layer, 'crucible-studio-light-reach-fill', fillPathData(project, outline));
  }
  appendLines(documentReference, layer, project, [{ role: filled ? 'main' : 'faint', polylines: [outline] }]);
}

function drawSelectedPointLight(documentReference, layer, project, key, light, context) {
  const { ground, rangeHandle } = pointReachHandles(light, context.sceneRadius, context.eye);
  appendGroundOutline(documentReference, layer, project, ground.outline, true);
  if (ground.center) {
    appendLines(documentReference, layer, project, [{ role: 'link', polylines: [[light.position, ground.center]] }]);
  }
  appendHandle(documentReference, layer, project, rangeHandle, key, 'range', 'Drag to adjust light range');
}

function drawSelectedSpotLight(documentReference, layer, project, key, light, context) {
  const { ground, aimHandle, angleHandle, rangeHandle } = spotReachHandles(light, context.sceneRadius, context.eye);
  appendGroundOutline(documentReference, layer, project, ground.outline, true);
  if (aimHandle) {
    appendLines(documentReference, layer, project, [{ role: 'link', polylines: [[light.position, aimHandle]] }]);
  }
  appendHandle(documentReference, layer, project, aimHandle, key, 'aim', 'Drag to aim spot light');
  appendHandle(documentReference, layer, project, angleHandle, key, 'angle', 'Drag to adjust spot cone angle');
  appendHandle(documentReference, layer, project, rangeHandle, key, 'range', 'Drag to adjust spot range');
}

function drawSelectedAreaLight(documentReference, layer, project, key, light, context) {
  const { body, ground, aimHandle, widthHandle, heightHandle } = areaReachHandles(light, context.sceneRadius, context.eye);
  appendGroundOutline(documentReference, layer, project, ground.outline, true);
  if (ground.center) {
    appendLines(documentReference, layer, project, [{ role: 'link', polylines: [[light.position, ground.center]] }]);
  }
  appendLines(documentReference, layer, project, [{ role: 'main', polylines: [body.rectangle, ...body.normalArrow] }]);
  appendHandle(documentReference, layer, project, aimHandle, key, 'aim', 'Drag to aim area light');
  appendHandle(documentReference, layer, project, widthHandle, key, 'area-width', 'Drag to adjust area width');
  appendHandle(documentReference, layer, project, heightHandle, key, 'area-height', 'Drag to adjust area height');
}

function drawUnselectedFootprint(documentReference, layer, project, kind, light, sceneRadius) {
  const footprint = kind === 'point'
    ? pointGroundFootprint(light, sceneRadius)
    : kind === 'spot'
      ? spotGroundFootprint(light, sceneRadius)
      : areaGroundFootprint(light, sceneRadius);
  appendGroundOutline(documentReference, layer, project, footprint.outline, false);
}

function drawSun(documentReference, layer, project, sunObject, context) {
  const reach = sunReach(context.bounds, sunObject.direction, context.eye);
  appendLines(documentReference, layer, project, [{ role: 'sun', polylines: [reach.ring, ...reach.singleArrow] }]);
  const arrowRuns = reach.singleArrow.flatMap(polyline => projectPolylineRuns(project, polyline));
  appendPath(documentReference, layer, 'crucible-studio-light-reach-hit', pathDataOfRuns(arrowRuns), {
    'data-reach-object': 'sun',
    'data-light-reach-handle': 'sun-direction',
    'aria-label': 'Drag to turn sun',
  });
  appendHandle(documentReference, layer, project, reach.singleArrowTip, 'sun', 'sun-direction', 'Drag to turn sun');
}

/**
 * The reach of every light and the selected sun over the viewport. Selected lights draw a filled ground footprint and
 * drag handles; unselected lights draw a faint ground outline; a selected sun draws its scene ring and single arrow.
 */
export function renderLightReach(documentReference, gizmoSvg, controller, sceneObjects) {
  const selectedKey = controller.selectedObjectKey;
  const bounds = controller.sceneBounds();
  const context = { bounds, sceneRadius: sceneSphereOf(bounds).radius, eye: controller.viewCamera.eye };
  const project = controller.worldPointProjector();
  const environment = controller.scene.environment ?? {};
  const layer = [];
  for (const object of sceneObjects) {
    const selected = object.key === selectedKey;
    if (object.kind === 'sun' && selected) {
      drawSun(documentReference, layer, project, object, context);
    }
    const field = LIGHT_FIELDS[object.kind];
    const light = field ? environment[field]?.[Number(object.key.split(':')[1])] : null;
    if (!light) {
      continue;
    }
    if (!selected) {
      drawUnselectedFootprint(documentReference, layer, project, object.kind, light, context.sceneRadius);
      continue;
    }
    if (object.kind === 'point') {
      drawSelectedPointLight(documentReference, layer, project, object.key, light, context);
    } else if (object.kind === 'spot') {
      drawSelectedSpotLight(documentReference, layer, project, object.key, light, context);
    } else {
      drawSelectedAreaLight(documentReference, layer, project, object.key, light, context);
    }
  }
  if (layer.length === 0) {
    return;
  }
  ensureLightReachStyles(documentReference);
  const group = createSvgElement(documentReference, 'g', { class: 'crucible-studio-light-reach', 'data-style': 'footprint' });
  group.append(...layer);
  gizmoSvg.append(group);
}
