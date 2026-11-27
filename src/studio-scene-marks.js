import { createSvgElement } from './studio-svg.js';
import { studioIconPath } from './studio-icons.js';
import { EDGE_POINTER_CHEVRON_REACH, EDGE_POINTER_DISC_RADIUS, edgePointerPlacement, screenPointOfWorldPoint } from './studio-edge-pointer.js';
import { markIsOnFarSide, sunAnglesUnderRay, sunMarkPosition, sunMarkSphereOf, sunRayEnd } from './studio-sun-mark.js';

// The marks over the viewport for the lights and the sun, and the drags that move them.
export const SCENE_OBJECT_ICONS = Object.freeze({ camera: 'camera', sun: 'sun', point: 'pointLight', spot: 'spotLight', area: 'areaLight' });
const SCENE_OBJECT_MARK_RADIUS = 13;

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

function appendSunRay(documentReference, gizmoSvg, controller, object, projected, selected) {
  const end = controller.projectWorldPoint(sunRayEnd(controller.sceneBounds(), object.direction));
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
  const disc = createSvgElement(documentReference, 'circle', { r: EDGE_POINTER_DISC_RADIUS, class: 'crucible-studio-scene-mark-disc', ...pointerAttributes });
  const glyph = createSvgElement(documentReference, 'path', {
    d: studioIconPath(SCENE_OBJECT_ICONS[object.kind]),
    transform: `translate(${glyphOffset} ${glyphOffset}) scale(${glyphScale.toFixed(3)})`,
    ...pointerAttributes,
  });
  const chevronTip = EDGE_POINTER_DISC_RADIUS + EDGE_POINTER_CHEVRON_REACH - 1;
  const chevron = createSvgElement(documentReference, 'path', {
    d: `M ${chevronTip - 5} -4.5 L ${chevronTip} 0 L ${chevronTip - 5} 4.5`,
    transform: `rotate(${placement.angle.toFixed(1)})`,
    class: 'crucible-studio-edge-pointer-chevron',
    // The chevron sits over the dark viewport, not on the disc, so like the sun's ray it takes the trace colours in both themes.
    style: `stroke: ${selected ? 'var(--studio-accent)' : 'var(--studio-trace)'}; stroke-width: 2.2; filter: drop-shadow(0 0 1px var(--studio-trace-edge)) drop-shadow(0 0 1.5px var(--studio-trace-edge))`,
    ...pointerAttributes,
  });
  const tooltip = createSvgElement(documentReference, 'title');
  tooltip.textContent = `${object.label} (out of view)`;
  pointer.append(disc, glyph, chevron, tooltip);
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
  for (const object of controller.listSceneObjects()) {
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
    if (object.kind === 'sun') {
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

// A light follows the pointer in the plane through it that faces the view.
function beginLightDrag(controller, object, coordinates, pointerId) {
  const camera = controller.viewCamera;
  const normal = camera.target.map((component, axis) => component - camera.eye[axis]);
  const normalLength = Math.hypot(...normal);
  const planeNormal = normal.map(component => component / normalLength);
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

function dragSun(controller, dragState, coordinates) {
  controller.beginUndoGroup();
  controller.setSunAngles(sunAnglesUnderRay(controller.screenRay(coordinates.x, coordinates.y), dragState.sunSphere, { farSide: dragState.farSide }));
}

/** Follows the pointer with the scene object a drag began on; the whole drag is one undo step. */
export function dragSceneObject(controller, dragState, coordinates, announceError) {
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
