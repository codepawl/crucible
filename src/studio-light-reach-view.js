import { createSvgElement } from './studio-svg.js';
import { ensureLightReachStyles } from './studio-light-reach-styles.js';
import { sceneSphereOf } from './studio-sun-mark.js';
import {
  areaGroundFootprint,
  areaLightReach,
  pointGroundFootprint,
  pointLightReach,
  spotGroundFootprint,
  spotLightReach,
  sphereSilhouette,
  sunReach,
} from './studio-light-reach.js';

// Draws how far and how wide the selected light shines over the viewport. The look is still being chosen, so the
// drawing comes in three styles behind one switch (`?lightReach=wire|volume|footprint`, and `?sunArrow=parallel|single`
// for the sun); the geometry in studio-light-reach.js is the same for all of them.
export const LIGHT_REACH_STYLES = Object.freeze(['wire', 'volume', 'footprint']);
export const SUN_ARROW_FORMS = Object.freeze(['parallel', 'single']);
const LIGHT_FIELDS = Object.freeze({ point: 'pointLights', spot: 'spotLights', area: 'areaLights' });

/** The style choices a page address asks for; anything else falls back to the first choice. */
export function readLightReachOptions(search = globalThis.location?.search ?? '') {
  const parameters = new URLSearchParams(search);
  const pick = (name, choices) => (choices.includes(parameters.get(name)) ? parameters.get(name) : choices[0]);
  return { style: pick('lightReach', LIGHT_REACH_STYLES), sunArrow: pick('sunArrow', SUN_ARROW_FORMS) };
}

let pageOptions = null;
function currentOptions() {
  pageOptions ??= readLightReachOptions();
  return pageOptions;
}

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

/** The convex outline of a set of screen points (monotone chain). */
export function convexHull(points) {
  const sorted = [...points].sort((first, second) => first.x - second.x || first.y - second.y);
  if (sorted.length < 3) {
    return sorted;
  }
  const turn = (origin, first, second) => (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  const chain = ordered => {
    const hull = [];
    for (const point of ordered) {
      while (hull.length >= 2 && turn(hull.at(-2), hull.at(-1), point) <= 0) {
        hull.pop();
      }
      hull.push(point);
    }
    hull.pop();
    return hull;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

function fillPathData(project, fill) {
  const projected = fill.points.map(project);
  if (projected.some(point => !point.visible)) {
    return null;
  }
  const outline = fill.hull ? convexHull(projected) : projected;
  return outline.length < 3 ? null : `${pathDataOfRuns([outline])} Z`;
}

function appendPath(documentReference, layer, className, pathData, attributes = {}) {
  if (pathData) {
    layer.push(createSvgElement(documentReference, 'path', { class: className, d: pathData, ...attributes }));
  }
}

function lightDrawing(kind, light, context) {
  if (kind === 'point') {
    const reach = pointLightReach(light, context.sceneRadius);
    const silhouette = sphereSilhouette(reach.center, reach.rangeRadius, context.eye);
    const source = sphereSilhouette(reach.center, reach.sourceRadius, context.eye);
    return {
      lines: [{ role: 'main', polylines: [...reach.axisCircles, silhouette].filter(Boolean) }, { role: 'source', polylines: [source].filter(Boolean) }],
      fills: silhouette ? [{ points: silhouette }] : [],
      ground: pointGroundFootprint(light, context.sceneRadius),
      footprintBody: [],
    };
  }
  if (kind === 'spot') {
    const reach = spotLightReach(light, context.sceneRadius);
    return {
      lines: [{ role: 'main', polylines: [reach.rim, ...reach.edgeLines] }, { role: 'soft', polylines: [reach.innerRim] }],
      fills: [{ points: [reach.apex, ...reach.rim], hull: true }],
      ground: spotGroundFootprint(light, context.sceneRadius),
      footprintBody: [],
    };
  }
  const reach = areaLightReach(light);
  const bodyLines = [{ role: 'main', polylines: [reach.rectangle, ...reach.normalArrow] }];
  return {
    lines: bodyLines,
    fills: [{ points: reach.rectangle }],
    ground: areaGroundFootprint(light, context.sceneRadius),
    footprintBody: bodyLines,
  };
}

function appendLines(documentReference, layer, project, lineGroups, extraClass = '') {
  for (const group of lineGroups) {
    const runs = group.polylines.flatMap(polyline => projectPolylineRuns(project, polyline));
    appendPath(documentReference, layer, `crucible-studio-light-reach-line${extraClass}`, pathDataOfRuns(runs), { 'data-role': group.role });
  }
}

function appendGroundPatch(documentReference, layer, project, drawing, light, { filled, withLink }) {
  const { outline, center } = drawing.ground;
  if (outline.length === 0) {
    return;
  }
  if (filled) {
    appendPath(documentReference, layer, 'crucible-studio-light-reach-fill', fillPathData(project, { points: outline }));
  }
  appendLines(documentReference, layer, project, [{ role: filled ? 'main' : 'faint', polylines: [outline] }]);
  if (withLink) {
    appendLines(documentReference, layer, project, [{ role: 'link', polylines: [[light.position, center]] }]);
  }
}

function drawSelectedLight(documentReference, layer, project, kind, light, context) {
  const drawing = lightDrawing(kind, light, context);
  if (context.options.style === 'footprint') {
    appendGroundPatch(documentReference, layer, project, drawing, light, { filled: true, withLink: true });
    appendLines(documentReference, layer, project, drawing.footprintBody);
    return;
  }
  if (context.options.style === 'volume') {
    for (const fill of drawing.fills) {
      appendPath(documentReference, layer, 'crucible-studio-light-reach-fill', fillPathData(project, fill));
    }
  }
  appendLines(documentReference, layer, project, drawing.lines);
}

function drawSun(documentReference, layer, project, sunObject, context) {
  const reach = sunReach(context.bounds, sunObject.direction);
  const indicator = context.options.sunArrow === 'single' ? reach.singleArrow : reach.parallelArrows.flat();
  appendLines(documentReference, layer, project, [{ role: 'main', polylines: [reach.ring, ...indicator] }]);
}

/**
 * The reach of the selected light or sun, drawn under the marks. Unselected lights draw nothing, except in the
 * footprint style where each shows a faint outline of its lit patch on the ground.
 */
export function renderLightReach(documentReference, gizmoSvg, controller, sceneObjects, options = currentOptions()) {
  const selectedKey = controller.selectedObjectKey;
  const footprintForAll = options.style === 'footprint';
  if (!footprintForAll && !selectedKey) {
    return;
  }
  const bounds = controller.sceneBounds();
  const context = { options, bounds, sceneRadius: sceneSphereOf(bounds).radius, eye: controller.viewCamera.eye };
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
    if (selected) {
      drawSelectedLight(documentReference, layer, project, object.kind, light, context);
    } else if (footprintForAll) {
      appendGroundPatch(documentReference, layer, project, lightDrawing(object.kind, light, context), light, { filled: false, withLink: false });
    }
  }
  if (layer.length === 0) {
    return;
  }
  ensureLightReachStyles(documentReference);
  const group = createSvgElement(documentReference, 'g', { class: 'crucible-studio-light-reach', 'data-style': options.style });
  group.append(...layer);
  gizmoSvg.append(group);
}
