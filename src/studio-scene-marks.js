import { createSvgElement } from './studio-svg.js';
import { studioIconPath } from './studio-icons.js';
import {
  EDGE_POINTER_CHEVRON_BASE_DISTANCE,
  EDGE_POINTER_CHEVRON_HEIGHT,
  EDGE_POINTER_CHEVRON_TIP_DISTANCE,
  EDGE_POINTER_DISC_RADIUS,
  EDGE_POINTER_STROKE_WIDTH,
  EDGE_POINTER_UNDERSTROKE_EXTRA,
  edgePointerPlacement, screenPointOfWorldPoint } from './studio-edge-pointer.js';
import { renderLightReach } from './studio-light-reach-view.js';
import {
  aimDirectionFromHit,
  areaHeightFromHit,
  areaReachHandles,
  areaWidthFromHit,
  pointRangeFromHit,
  pointReachHandles,
  spotAngleFromHit,
  spotRangeFromHit,
  spotReachHandles,
} from './studio-light-reach.js';
import { markIsOnFarSide, sunAnglesUnderRay, sunMarkPosition, sunMarkSphereOf, sunRayEnd } from './studio-sun-mark.js';
import { sceneSphereOf } from './studio-sun-mark.js';

// The marks over the viewport for the lights and the sun, and the drags that move them.
export const SCENE_OBJECT_ICONS = Object.freeze({ camera: 'camera', sun: 'sun', point: 'pointLight', spot: 'spotLight', area: 'areaLight' });
const SCENE_OBJECT_MARK_RADIUS = 13;
// The disc of a mark is translucent, so the sun ray starts this far past its edge instead of showing through the glyph.
export const SUN_RAY_GAP_FROM_MARK = 5;
const REACH_LIGHT_FIELDS = Object.freeze({ point: 'pointLights', spot: 'spotLights', area: 'areaLights' });
const REACH_HANDLE_PROPERTY = Object.freeze({
  aim: 'direction',
  range: 'range',
  angle: 'angle',
  'area-width': 'width',
  'area-height': 'height',
});

/** Where a ray meets the plane through a point with a normal, or null when it runs parallel or the plane lies behind it. */
export function intersectPlane(ray, planePoint, planeNormal) {
  const facing = ray.direction.reduce((sum, component, axis) => sum + component * planeNormal[axis], 0);
  if (Math.abs(facing) < 1e-6) {
    return null;
  }
  const distance = planePoint.reduce((sum, component, axis) => sum + (component - ray.origin[axis]) * planeNormal[axis], 0) / facing;
  return distance > 0 ? ray.origin.map((component, axis) => component + ray.direction[axis] * distance) : null;
}

function sceneObjectMarkPosition(object, controller) {
  return object.kind === 'sun' ? sunMarkPosition(controller.sceneBounds(), object.direction) : object.position;
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

/** Where the sun ray starts on screen: on the line to its end, just outside the mark's disc; null when the end lies inside that clearance. */
export function sunRayStartOutsideMark(markCentre, rayEnd) {
  const clearance = SCENE_OBJECT_MARK_RADIUS + SUN_RAY_GAP_FROM_MARK;
  const deltaX = rayEnd.x - markCentre.x;
  const deltaY = rayEnd.y - markCentre.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length <= clearance) {
    return null;
  }
  return { x: markCentre.x + (deltaX / length) * clearance, y: markCentre.y + (deltaY / length) * clearance };
}

function appendSunRay(documentReference, gizmoSvg, controller, object, projected, selected) {
  const end = controller.projectWorldPoint(sunRayEnd(controller.sceneBounds(), object.direction));
  if (!end.visible) {
    return;
  }
  const start = sunRayStartOutsideMark(projected, end);
  if (!start) {
    return;
  }
  gizmoSvg.append(createSvgElement(documentReference, 'line', {
    class: 'crucible-studio-scene-mark-ray',
    'data-selected': selected ? 'true' : 'false',
    x1: start.x.toFixed(1),
    y1: start.y.toFixed(1),
    x2: end.x.toFixed(1),
    y2: end.y.toFixed(1),
  }));
}

// The viewport's own overlays and the panels that float over it: a pointer on the edge keeps clear of them.
const OVERLAY_SELECTORS = [
  '.crucible-studio-view-widget',
  '.crucible-studio-readout',
  '.crucible-studio-hintbar',
  '.crucible-studio-status',
  '.crucible-studio-bake-mark',
  '.crucible-studio-island',
  '.crucible-studio-dock',
];

function overlayRectangles(gizmoSvg) {
  const studioRoot = gizmoSvg.closest?.('.crucible-studio');
  const origin = gizmoSvg.getBoundingClientRect?.();
  if (!studioRoot || !origin) {
    return [];
  }
  return OVERLAY_SELECTORS
    .flatMap(selector => [...studioRoot.querySelectorAll(selector)])
    .map(overlay => overlay.getBoundingClientRect?.())
    .filter(rectangle => rectangle && rectangle.width > 0 && rectangle.height > 0)
    .map(rectangle => ({
      left: rectangle.left - origin.left,
      top: rectangle.top - origin.top,
      right: rectangle.right - origin.left,
      bottom: rectangle.bottom - origin.top,
    }));
}

// The mark's own disc and glyph a little smaller, with a chevron on the rim that points toward the mark. The disc, the
// glyph and the chevron take the press; data-edge-pointer tells the press handler to select without dragging.
function appendEdgePointer(documentReference, gizmoSvg, object, placement, selected) {
  const pointer = createSvgElement(documentReference, 'g', {
    class: 'crucible-studio-scene-mark crucible-studio-edge-pointer',
    'data-selected': selected ? 'true' : 'false',
    transform: `translate(${placement.x.toFixed(1)} ${placement.y.toFixed(1)})`,
  });
  const pointerAttributes = { 'data-scene-object': object.key, 'data-edge-pointer': 'true' };
  const glyphScale = (0.75 * EDGE_POINTER_DISC_RADIUS) / SCENE_OBJECT_MARK_RADIUS;
  const glyphOffset = (-12 * glyphScale).toFixed(2);
  const disc = createSvgElement(documentReference, 'circle', { r: EDGE_POINTER_DISC_RADIUS, class: 'crucible-studio-scene-mark-disc', ...pointerAttributes, style: 'stroke: var(--studio-trace-edge); stroke-width: 1.5' });
  const glyph = createSvgElement(documentReference, 'path', {
    d: studioIconPath(SCENE_OBJECT_ICONS[object.kind]),
    transform: `translate(${glyphOffset} ${glyphOffset}) scale(${glyphScale.toFixed(3)})`,
    // The glyph is scaled down, so its stroke is set in its own units to land on the chevron's weight.
    style: `stroke-width: ${(EDGE_POINTER_STROKE_WIDTH / glyphScale).toFixed(2)}`,
    ...pointerAttributes,
  });
  const chevronPath = [
    `M ${EDGE_POINTER_CHEVRON_BASE_DISTANCE} ${-EDGE_POINTER_CHEVRON_HEIGHT / 2}`,
    `L ${EDGE_POINTER_CHEVRON_TIP_DISTANCE} 0`,
    `L ${EDGE_POINTER_CHEVRON_BASE_DISTANCE} ${EDGE_POINTER_CHEVRON_HEIGHT / 2}`,
  ].join(' ');
  // The chevron sits over the scene, not on the disc: a dark under-stroke under a light one (accent when selected) reads on pale and dark surfaces.
  const chevronAttributes = {
    d: chevronPath,
    transform: `rotate(${placement.angle.toFixed(1)})`,
    'stroke-linejoin': 'round',
    ...pointerAttributes,
  };
  const chevronUnderstroke = createSvgElement(documentReference, 'path', {
    ...chevronAttributes,
    class: 'crucible-studio-edge-pointer-chevron-understroke',
    style: `stroke: var(--studio-trace-edge); stroke-width: ${EDGE_POINTER_STROKE_WIDTH + EDGE_POINTER_UNDERSTROKE_EXTRA}`,
  });
  const chevron = createSvgElement(documentReference, 'path', {
    ...chevronAttributes,
    class: 'crucible-studio-edge-pointer-chevron',
    style: `stroke: ${selected ? 'var(--studio-accent)' : 'var(--studio-trace)'}; stroke-width: ${EDGE_POINTER_STROKE_WIDTH}`,
  });
  const tooltip = createSvgElement(documentReference, 'title');
  tooltip.textContent = `${object.label} (out of view)`;
  pointer.append(disc, glyph, chevronUnderstroke, chevron, tooltip);
  gizmoSvg.append(pointer);
}

function appendEdgePointerWhenOutOfView(documentReference, gizmoSvg, controller, object, screenPoint, selected) {
  const placement = edgePointerPlacement({
    point: screenPoint,
    width: controller.viewportWidth,
    height: controller.viewportHeight,
    obstacles: overlayRectangles(gizmoSvg),
  });
  if (placement) {
    appendEdgePointer(documentReference, gizmoSvg, object, placement, selected);
  }
}

/** One mark per light and one for the sun, with a pointer on the viewport's edge for a sun out of view; the scene camera is drawn only while the view looks away from it. */
export function renderSceneObjectMarks(documentReference, gizmoSvg, controller) {
  const width = controller.viewportWidth;
  const height = controller.viewportHeight;
  const sceneObjects = controller.listSceneObjects();
  renderLightReach(documentReference, gizmoSvg, controller, sceneObjects);
  for (const object of sceneObjects) {
    if (object.kind === 'camera' && !controller.freeView) {
      continue;
    }
    const projected = screenPointOfWorldPoint(controller, sceneObjectMarkPosition(object, controller));
    const selected = object.key === controller.selectedObjectKey;
    if (!projected.visible || projected.x < 0 || projected.x > width || projected.y < 0 || projected.y > height) {
      if (object.kind === 'sun') {
        appendEdgePointerWhenOutOfView(documentReference, gizmoSvg, controller, object, projected, selected);
      }
      continue;
    }
    // A selected sun shows its direction arrow, which the short stub would only repeat.
    if (object.kind === 'sun' && !selected) {
      appendSunRay(documentReference, gizmoSvg, controller, object, projected, selected);
    }
    appendSceneObjectMark(documentReference, gizmoSvg, object, projected, selected);
  }
}

// The sun turns about the middle of the scene. The sphere it slides over and the half of it the mark sits on are fixed at the press, so the drag neither shifts under the pointer nor jumps to the other half.
function beginSunDrag(controller, sunObject, pointerId, announceError) {
  if (controller.describeSceneObject('sun').drivenProperties.has('direction')) {
    announceError('The sun direction is animated by a motion track or driver, so turning it would not show. Remove that motion or edit its keyframes.');
    return null;
  }
  const sunSphere = sunMarkSphereOf(controller.sceneBounds());
  const markPoint = sunMarkPosition(controller.sceneBounds(), sunObject.direction);
  const farSide = markIsOnFarSide(markPoint, sunSphere, controller.viewCamera.eye);
  return { mode: 'light', key: 'sun', sunSphere, farSide, pointerId };
}

function viewPlaneNormalOf(controller) {
  const camera = controller.viewCamera;
  const normal = camera.target.map((component, axis) => component - camera.eye[axis]);
  const normalLength = Math.hypot(...normal);
  return normalLength > 1e-6 ? normal.map(component => component / normalLength) : [0, 0, -1];
}

// A light follows the pointer in the plane through it that faces the view.
function beginLightDrag(controller, object, coordinates, pointerId) {
  const planeNormal = viewPlaneNormalOf(controller);
  const grabbed = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), object.position, planeNormal);
  if (!grabbed) {
    return null;
  }
  return {
    mode: 'light',
    key: object.key,
    planeNormal,
    planePoint: object.position,
    grabOffset: object.position.map((component, axis) => component - grabbed[axis]),
    pointerId,
  };
}

function liveLightOf(controller, key) {
  const [kind, indexText] = key.split(':');
  const field = REACH_LIGHT_FIELDS[kind];
  return field ? controller.scene.environment?.[field]?.[Number(indexText)] ?? null : null;
}

/**
 * Starts a drag on a light-reach handle (`aim`, `range`, `angle`, `area-width`, `area-height`, `sun-direction`), or
 * returns null and reports why when an animated property locks that field.
 */
export function beginLightReachDrag(controller, object, handleKind, coordinates, pointerId, announceError) {
  if (!object || !(handleKind in REACH_HANDLE_PROPERTY) && handleKind !== 'sun-direction') {
    return null;
  }
  if (object.key === 'sun' && handleKind === 'sun-direction') {
    const sunDrag = beginSunDrag(controller, object, pointerId, announceError);
    return sunDrag ? { ...sunDrag, reachHandle: 'sun-direction' } : null;
  }
  const propertyName = REACH_HANDLE_PROPERTY[handleKind];
  if (controller.describeSceneObject(object.key).drivenProperties.has(propertyName)) {
    announceError(`The ${object.key} light ${propertyName} is animated by a motion track or driver, so an edit would not show. Remove that motion or edit its keyframes.`);
    return null;
  }
  const light = liveLightOf(controller, object.key);
  if (!light) {
    return null;
  }
  const sceneRadius = sceneSphereOf(controller.sceneBounds()).radius;
  const eye = controller.viewCamera.eye;
  const viewNormal = viewPlaneNormalOf(controller);
  let planePoint = [0, 0, 0];
  let planeNormal = [0, 1, 0];
  let areaFrame = null;
  if (object.kind === 'point') {
    const handles = pointReachHandles(light, sceneRadius, eye);
    planePoint = handles.rangeHandle;
  } else if (object.kind === 'spot') {
    const handles = spotReachHandles(light, sceneRadius, eye);
    planePoint = handles.aimOnGround ? [0, 0, 0] : handles.aimHandle;
    planeNormal = handles.aimOnGround ? [0, 1, 0] : viewNormal;
  } else if (object.kind === 'area') {
    const handles = areaReachHandles(light, sceneRadius, eye);
    if (handleKind === 'aim') {
      planePoint = handles.aimOnGround ? [0, 0, 0] : handles.aimHandle;
      planeNormal = handles.aimOnGround ? [0, 1, 0] : viewNormal;
    } else {
      planePoint = light.position;
      planeNormal = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), light.position, handles.frame.normal)
        ? handles.frame.normal
        : viewNormal;
      areaFrame = handles.frame;
    }
  }
  return {
    mode: 'light',
    key: object.key,
    kind: object.kind,
    reachHandle: handleKind,
    planePoint,
    planeNormal,
    areaFrame,
    pointerId,
  };
}

function patchForReachHit(dragState, light, hitPoint) {
  if (dragState.reachHandle === 'aim') {
    return aimDirectionFromHit(light.position, hitPoint);
  }
  if (dragState.reachHandle === 'range') {
    return dragState.kind === 'point'
      ? pointRangeFromHit(light.position, hitPoint)
      : spotRangeFromHit(light.position, hitPoint);
  }
  if (dragState.reachHandle === 'angle') {
    return spotAngleFromHit(light, hitPoint);
  }
  if (dragState.reachHandle === 'area-width' && dragState.areaFrame) {
    return areaWidthFromHit(light.position, dragState.areaFrame.right, hitPoint);
  }
  if (dragState.reachHandle === 'area-height' && dragState.areaFrame) {
    return areaHeightFromHit(light.position, dragState.areaFrame.height, hitPoint);
  }
  return null;
}

/**
 * The pointer state a press on a scene object starts, or null when nothing drags: the camera does not, a light drags
 * in a plane and the sun over a sphere. A drag that is refused tells why through announceError.
 */
export function beginSceneObjectDrag(controller, object, coordinates, pointerId, announceError) {
  if (object.key === 'sun') {
    return beginSunDrag(controller, object, pointerId, announceError);
  }
  const movable = object.position !== null && object.key !== 'camera';
  return movable ? beginLightDrag(controller, object, coordinates, pointerId) : null;
}

/** Handles a left-button press on a scene object mark or light-reach handle, selecting it and starting a drag if allowed. */
export function handleSceneObjectPointerDown(controller, event, coordinates, selectSceneObject, announceError) {
  const reachHandle = event.target?.getAttribute?.('data-light-reach-handle');
  const key = reachHandle
    ? event.target?.getAttribute?.('data-reach-object')
    : event.target?.getAttribute?.('data-scene-object');
  if (!key || (event.button ?? 0) !== 0 || event.shiftKey || event.altKey) {
    return null;
  }
  event.preventDefault();
  event.stopPropagation();
  selectSceneObject(key);
  const object = controller.listSceneObjects().find(candidate => candidate.key === key);
  if (reachHandle && object) {
    return beginLightReachDrag(controller, object, reachHandle, coordinates, event.pointerId, announceError);
  }
  if (controller.tool !== 'translate' || event.target.hasAttribute('data-edge-pointer')) {
    return null;
  }
  return beginSceneObjectDrag(controller, object, coordinates, event.pointerId, announceError);
}

function dragSun(controller, dragState, coordinates) {
  controller.beginUndoGroup();
  controller.setSunAngles(sunAnglesUnderRay(controller.screenRay(coordinates.x, coordinates.y), dragState.sunSphere, { farSide: dragState.farSide }));
}

/** Follows the pointer while dragging a light-reach handle; the whole drag is one undo step. */
export function dragLightReach(controller, dragState, coordinates, announceError) {
  if (dragState.sunSphere) {
    dragSun(controller, dragState, coordinates);
    return;
  }
  if (!dragState.planeNormal) {
    return;
  }
  const hitPoint = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), dragState.planePoint, dragState.planeNormal);
  if (!hitPoint) {
    return;
  }
  const light = liveLightOf(controller, dragState.key);
  if (!light) {
    return;
  }
  const patch = patchForReachHit(dragState, light, hitPoint);
  if (!patch) {
    return;
  }
  controller.beginUndoGroup();
  try {
    controller.updateSceneLight(dragState.key, patch);
  } catch (error) {
    dragState.planeNormal = null;
    announceError(error.message);
  }
}

/** Follows the pointer with the scene object or light-reach handle a drag began on; the whole drag is one undo step. */
export function dragSceneObject(controller, dragState, coordinates, announceError) {
  if (dragState.reachHandle) {
    dragLightReach(controller, dragState, coordinates, announceError);
    return;
  }
  if (dragState.sunSphere) {
    dragSun(controller, dragState, coordinates);
    return;
  }
  const { key, planeNormal, planePoint, grabOffset } = dragState;
  if (!planeNormal) return;
  const hit = intersectPlane(controller.screenRay(coordinates.x, coordinates.y), planePoint, planeNormal);
  if (!hit) return;
  controller.beginUndoGroup();
  try {
    controller.moveSceneObject(key, hit.map((component, axis) => component + grabOffset[axis]));
  } catch (error) {
    dragState.planeNormal = null;
    announceError(error.message);
  }
}
