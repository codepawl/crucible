// A mark that is out of view gets a pointer on the viewport's edge. This module only does the geometry: where on the edge
// the pointer stands and which way it points, so any scene mark (the sun today, the lights later) can use it.

// The pointer is a disc with a ring, and a chevron that starts a little beyond the ring so all of it shows. Sizes in pixels.
export const EDGE_POINTER_DISC_RADIUS = 10;
export const EDGE_POINTER_STROKE_WIDTH = 1.5;
// The chevron's dark under-stroke is this much wider than its light stroke, so it reads on pale and dark surfaces.
export const EDGE_POINTER_UNDERSTROKE_EXTRA = 2;
export const EDGE_POINTER_CHEVRON_HEIGHT = 12;
export const EDGE_POINTER_CHEVRON_DEPTH = 6;
const EDGE_POINTER_RING_OUTER_RADIUS = EDGE_POINTER_DISC_RADIUS + EDGE_POINTER_STROKE_WIDTH / 2;
const EDGE_POINTER_CHEVRON_CLEARANCE_FROM_RING = 2;
// Where the chevron's path starts and ends along its direction, measured from the pointer's centre.
export const EDGE_POINTER_CHEVRON_BASE_DISTANCE = EDGE_POINTER_RING_OUTER_RADIUS + EDGE_POINTER_CHEVRON_CLEARANCE_FROM_RING + EDGE_POINTER_UNDERSTROKE_EXTRA / 2;
export const EDGE_POINTER_CHEVRON_TIP_DISTANCE = EDGE_POINTER_CHEVRON_BASE_DISTANCE + EDGE_POINTER_CHEVRON_DEPTH;
// The outermost point of the pointer: the chevron's tip with its under-stroke.
export const EDGE_POINTER_OUTERMOST_DISTANCE = EDGE_POINTER_CHEVRON_TIP_DISTANCE + EDGE_POINTER_UNDERSTROKE_EXTRA / 2;
// The gap between the outermost point and the viewport's edge it faces (the 8 px spacing step).
export const EDGE_POINTER_EDGE_GAP = 8;
// The distance from the viewport's edge to the pointer's centre.
export const EDGE_POINTER_INSET = EDGE_POINTER_OUTERMOST_DISTANCE + EDGE_POINTER_EDGE_GAP;
// Half the side of the square the pointer needs kept free of overlays.
export const EDGE_POINTER_CLEAR_RADIUS = EDGE_POINTER_OUTERMOST_DISTANCE + 4;

const SLIDE_STEP_PIXELS = 2;
const BEHIND_EYE_EPSILON = 1e-6;
const POINTING_UP_WHEN_UNDECIDED = { x: 0, y: -1 };

function subtract(first, second) {
  return first.map((component, axis) => component - second[axis]);
}

function dot(first, second) {
  return first.reduce((sum, component, axis) => sum + component * second[axis], 0);
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

/**
 * Where a world point lands on the screen, with whether it lies behind the eye. The projection has no answer for a point
 * behind the eye, so such a point is projected as its mirror through the eye; that lands the opposite way round the
 * centre, which edgePointerPlacement undoes when it sees behind: true.
 */
export function screenPointOfWorldPoint(controller, worldPoint) {
  const camera = controller.viewCamera;
  const forward = normalize(subtract(camera.target, camera.eye));
  const alongView = dot(subtract(worldPoint, camera.eye), forward);
  const behindEye = camera.projection !== 'orthographic' && alongView <= BEHIND_EYE_EPSILON;
  if (!behindEye) {
    return { ...controller.projectWorldPoint(worldPoint), behind: false };
  }
  const mirroredThroughEye = worldPoint.map((component, axis) => 2 * camera.eye[axis] - component);
  const { x, y } = controller.projectWorldPoint(mirroredThroughEye);
  return { x, y, visible: false, behind: true };
}

function isInsideViewport(point, width, height) {
  return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
}

function unitDirectionFromCentre(point, centre) {
  const mirrorSign = point.behind ? -1 : 1;
  const direction = { x: (point.x - centre.x) * mirrorSign, y: (point.y - centre.y) * mirrorSign };
  const length = Math.hypot(direction.x, direction.y);
  if (length < 1e-9) {
    return POINTING_UP_WHEN_UNDECIDED;
  }
  return { x: direction.x / length, y: direction.y / length };
}

function pointWhereRayLeavesRectangle(centre, direction, halfWidth, halfHeight) {
  const reachAlongX = direction.x === 0 ? Infinity : halfWidth / Math.abs(direction.x);
  const reachAlongY = direction.y === 0 ? Infinity : halfHeight / Math.abs(direction.y);
  const reach = Math.min(reachAlongX, reachAlongY);
  return { x: centre.x + direction.x * reach, y: centre.y + direction.y * reach };
}

// The rectangle's outline as one number, clockwise from its top left corner, so a pointer can slide round a corner.
function outlineLength(rectangle) {
  return 2 * (rectangle.right - rectangle.left) + 2 * (rectangle.bottom - rectangle.top);
}

function outlinePositionOf(point, rectangle) {
  const width = rectangle.right - rectangle.left;
  const height = rectangle.bottom - rectangle.top;
  const distances = [
    { side: 'top', distance: Math.abs(point.y - rectangle.top) },
    { side: 'right', distance: Math.abs(point.x - rectangle.right) },
    { side: 'bottom', distance: Math.abs(point.y - rectangle.bottom) },
    { side: 'left', distance: Math.abs(point.x - rectangle.left) },
  ];
  const nearest = distances.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best)).side;
  if (nearest === 'top') return point.x - rectangle.left;
  if (nearest === 'right') return width + (point.y - rectangle.top);
  if (nearest === 'bottom') return width + height + (rectangle.right - point.x);
  return 2 * width + height + (rectangle.bottom - point.y);
}

function pointAtOutlinePosition(position, rectangle) {
  const width = rectangle.right - rectangle.left;
  const height = rectangle.bottom - rectangle.top;
  const total = outlineLength(rectangle);
  const wrapped = ((position % total) + total) % total;
  if (wrapped <= width) return { x: rectangle.left + wrapped, y: rectangle.top };
  if (wrapped <= width + height) return { x: rectangle.right, y: rectangle.top + (wrapped - width) };
  if (wrapped <= 2 * width + height) return { x: rectangle.right - (wrapped - width - height), y: rectangle.bottom };
  return { x: rectangle.left, y: rectangle.bottom - (wrapped - 2 * width - height) };
}

function isBlocked(point, obstacles, clearRadius) {
  return obstacles.some(obstacle => point.x + clearRadius > obstacle.left
    && point.x - clearRadius < obstacle.right
    && point.y + clearRadius > obstacle.top
    && point.y - clearRadius < obstacle.bottom);
}

// The free spot on the outline nearest to where the pointer wants to stand; it stays put when nothing on the outline is free.
function nearestFreePoint(wanted, rectangle, obstacles, clearRadius) {
  if (obstacles.length === 0 || !isBlocked(wanted, obstacles, clearRadius)) {
    return wanted;
  }
  const total = outlineLength(rectangle);
  if (total <= 0) {
    return wanted;
  }
  const wantedPosition = outlinePositionOf(wanted, rectangle);
  for (let slide = SLIDE_STEP_PIXELS; slide <= total / 2; slide += SLIDE_STEP_PIXELS) {
    for (const sign of [1, -1]) {
      const candidate = pointAtOutlinePosition(wantedPosition + sign * slide, rectangle);
      if (!isBlocked(candidate, obstacles, clearRadius)) {
        return candidate;
      }
    }
  }
  return wanted;
}

/**
 * Where the pointer for an out-of-view mark stands and which way its chevron points, or null while the mark is in view.
 * point is the mark's screen point ({ x, y, visible, behind } from screenPointOfWorldPoint); obstacles are rectangles
 * ({ left, top, right, bottom }) the pointer keeps clear of by sliding along the edge. The angle is in degrees,
 * 0 pointing right and growing clockwise as the screen's y axis runs down, and it points along the line from the
 * viewport's centre to the mark.
 */
export function edgePointerPlacement({ point, width, height, inset = EDGE_POINTER_INSET, clearRadius = EDGE_POINTER_CLEAR_RADIUS, obstacles = [] }) {
  const inView = !point.behind && point.visible !== false && isInsideViewport(point, width, height);
  if (inView) {
    return null;
  }
  const centre = { x: width / 2, y: height / 2 };
  const direction = unitDirectionFromCentre(point, centre);
  const rectangle = {
    left: Math.min(inset, centre.x),
    top: Math.min(inset, centre.y),
    right: Math.max(width - inset, centre.x),
    bottom: Math.max(height - inset, centre.y),
  };
  const halfWidth = (rectangle.right - rectangle.left) / 2;
  const halfHeight = (rectangle.bottom - rectangle.top) / 2;
  const wanted = pointWhereRayLeavesRectangle(centre, direction, halfWidth, halfHeight);
  const free = nearestFreePoint(wanted, rectangle, obstacles, clearRadius);
  return { x: free.x, y: free.y, angle: (Math.atan2(direction.y, direction.x) * 180) / Math.PI };
}
