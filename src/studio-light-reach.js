import { sceneSphereOf, sunMarkPosition } from './studio-sun-mark.js';

// How far and how wide each light shines on the ground, plus the handle positions and drag math to edit it there.
//
// Recipe meaning, as the renderer reads it (src/lighting.js):
// - spot `angle` is the HALF angle of the outer cone in radians (0.01 up to just under a quarter turn);
// - point and spot `range` is the distance where the light is cut off, in scene units; 0 or missing means unlimited;
// - area lights are a width x height rectangle facing `direction`, with `up` fixing which way the height runs.

/** Radius of the ring and of the reach drawn for a light with no range, as a multiple of the scene radius. */
export const UNLIMITED_RANGE_SCENE_RADIUS_FACTOR = 1.5;
export const CIRCLE_SEGMENT_COUNT = 64;
export const GROUND_FOOTPRINT_SAMPLE_COUNT = 180;
// The sun's ring clears the objects by this share of the scene's horizontal radius.
export const SUN_RING_CLEARANCE = 1.1;
export const MIN_LIGHT_RANGE = 0.25;
export const MAX_LIGHT_RANGE = 200;
export const MIN_SPOT_HALF_ANGLE = 0.05;
export const MAX_SPOT_HALF_ANGLE = Math.PI / 2 - 0.05;
export const MIN_AREA_SIZE = 0.1;
export const MAX_AREA_SIZE = 100;

// The single arrow covers this share of the way from the sun mark to the scene centre, so it stops well short of the objects.
const SUN_SINGLE_ARROW_TRAVEL_SHARE = 0.55;
const ARROW_HEAD_SHARE = 0.22;
const AREA_NORMAL_ARROW_SHARE = 0.5;
const GROUND_HEIGHT = 0;
const TINY_LENGTH = 1e-9;
const CORNER_BISECTION_STEPS = 40;
const MIN_AIM_DISTANCE = 1e-4;
const GROUND_RANGE_MARGIN = 0.05;

function clampNumber(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function subtract(first, second) {
  return first.map((component, axis) => component - second[axis]);
}

function add(first, second) {
  return first.map((component, axis) => component + second[axis]);
}

function scale(vector, factor) {
  return vector.map(component => component * factor);
}

function dot(first, second) {
  return first.reduce((sum, component, axis) => sum + component * second[axis], 0);
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return length < TINY_LENGTH ? [0, 1, 0] : scale(vector, 1 / length);
}

function pointAlong(origin, direction, distance) {
  return add(origin, scale(direction, distance));
}

function horizontalSideDirection(axis, eye, center) {
  const horizontalLength = Math.hypot(axis[0], axis[2]);
  if (horizontalLength > 1e-6) {
    const forward = [axis[0] / horizontalLength, 0, axis[2] / horizontalLength];
    return { forward, side: [-forward[2], 0, forward[0]] };
  }
  if (eye && center) {
    const awayX = center[0] - eye[0];
    const awayZ = center[2] - eye[2];
    const awayLength = Math.hypot(awayX, awayZ);
    if (awayLength > 1e-6) {
      const side = [-awayZ / awayLength, 0, awayX / awayLength];
      return { forward: [awayX / awayLength, 0, awayZ / awayLength], side };
    }
  }
  return { forward: [0, 0, 1], side: [1, 0, 0] };
}

function extremePointAlong(points, origin, direction) {
  let bestPoint = points[0];
  let bestProjection = -Infinity;
  for (const point of points) {
    const projection = dot(subtract(point, origin), direction);
    if (projection > bestProjection) {
      bestProjection = projection;
      bestPoint = point;
    }
  }
  return bestPoint;
}

/** Two unit vectors that span the plane perpendicular to a unit direction. */
export function planeAxesOf(direction) {
  const reference = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const first = normalize(cross(reference, direction));
  return [first, normalize(cross(direction, first))];
}

/** A closed polyline (the first point repeats at the end) around a centre in the plane of two unit axes. */
export function circlePolyline(center, firstAxis, secondAxis, radius, segmentCount = CIRCLE_SEGMENT_COUNT) {
  const points = [];
  for (let step = 0; step <= segmentCount; step += 1) {
    const turn = (step / segmentCount) * Math.PI * 2;
    points.push(add(center, add(scale(firstAxis, Math.cos(turn) * radius), scale(secondAxis, Math.sin(turn) * radius))));
  }
  return points;
}

/** The distance a light with this range reaches: its range, or a named share of the scene when it has none. */
export function effectiveRange(range, sceneRadius) {
  return range > 0 ? range : sceneRadius * UNLIMITED_RANGE_SCENE_RADIUS_FACTOR;
}

/**
 * An arrow from one point to another as polylines: the shaft and one open head. With the eye given the head opens
 * across the view, so it reads as a clean arrowhead; without it the head opens to an arbitrary side.
 */
export function arrowPolylines(from, to, eye = null) {
  const shaft = subtract(to, from);
  const length = Math.hypot(...shaft);
  if (length < TINY_LENGTH) {
    return [];
  }
  const direction = scale(shaft, 1 / length);
  const acrossView = eye ? cross(direction, subtract(eye, to)) : [0, 0, 0];
  const side = Math.hypot(...acrossView) > 1e-6 ? normalize(acrossView) : planeAxesOf(direction)[0];
  const headLength = length * ARROW_HEAD_SHARE;
  const base = pointAlong(to, direction, -headLength);
  return [[from, to], [pointAlong(base, side, headLength * 0.5), to, pointAlong(base, side, -headLength * 0.5)]];
}

/** The right and height axes of an area light's rectangle, from its facing and up. */
export function areaLightFrame(light) {
  const normal = normalize(light.direction);
  const up = normalize(light.up ?? [0, 1, 0]);
  let right = cross(up, normal);
  if (Math.hypot(...right) < 1e-6) {
    right = cross([0, 0, 1], normal);
  }
  right = normalize(right);
  return { normal, right, height: normalize(cross(normal, right)) };
}

/** An area light: the rectangle of its size facing its direction, and a short arrow out of the lit side. */
export function areaLightReach(light, eye = null) {
  const center = [...light.position];
  const { normal, right, height } = areaLightFrame(light);
  const halfRight = scale(right, light.width / 2);
  const halfHeight = scale(height, light.height / 2);
  const corners = [
    subtract(subtract(center, halfRight), halfHeight),
    subtract(add(center, halfRight), halfHeight),
    add(add(center, halfRight), halfHeight),
    add(subtract(center, halfRight), halfHeight),
  ];
  const arrowLength = Math.max(light.width, light.height) * AREA_NORMAL_ARROW_SHARE;
  const normalTip = pointAlong(center, normal, arrowLength);
  return {
    center,
    normal,
    corners,
    rectangle: [...corners, corners[0]],
    normalArrow: arrowPolylines(center, normalTip, eye),
    normalTip,
  };
}

/**
 * The sun's whole-scene ring and its single direction arrow; `direction` is the unit vector toward the sun.
 * The ring lies flat on the ground under the scene, so it reads the same from any view.
 */
export function sunReach(bounds, direction, eye = null) {
  const scene = sceneSphereOf(bounds);
  const groundY = bounds ? bounds.min[1] : GROUND_HEIGHT;
  const ringRadius = bounds
    ? (Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) / 2) * SUN_RING_CLEARANCE
    : scene.radius;
  const ringCenter = [scene.center[0], groundY, scene.center[2]];
  const mark = sunMarkPosition(bounds, direction);
  const singleArrowTip = add(mark, scale(subtract(scene.center, mark), SUN_SINGLE_ARROW_TRAVEL_SHARE));
  return {
    center: ringCenter,
    radius: ringRadius,
    ring: circlePolyline(ringCenter, [1, 0, 0], [0, 0, 1], ringRadius),
    singleArrow: arrowPolylines(mark, singleArrowTip, eye),
    singleArrowTip,
  };
}

/** The circle where a point light's range ball meets the ground; the outline is empty when the ball does not reach it. */
export function pointGroundFootprint(light, sceneRadius) {
  const height = light.position[1] - GROUND_HEIGHT;
  const rangeRadius = effectiveRange(light.range ?? 0, sceneRadius);
  if (height < 0 || height >= rangeRadius) {
    return { outline: [], center: null };
  }
  const foot = [light.position[0], GROUND_HEIGHT, light.position[2]];
  const outline = circlePolyline(foot, [1, 0, 0], [0, 0, 1], Math.sqrt(rangeRadius * rangeRadius - height * height));
  return { outline, center: foot };
}

function groundPointAt(apex, direction, reach) {
  if (direction[1] >= -TINY_LENGTH) {
    return null;
  }
  const distance = (apex[1] - GROUND_HEIGHT) / -direction[1];
  return distance <= reach ? pointAlong(apex, direction, distance) : null;
}

function orderAroundCentroid(points) {
  const centroid = scale(points.reduce((sum, point) => add(sum, point), [0, 0, 0]), 1 / points.length);
  const turnOf = point => Math.atan2(point[2] - centroid[2], point[0] - centroid[0]);
  return { centroid, ordered: [...points].sort((first, second) => turnOf(first) - turnOf(second)) };
}

/** The last edge ray that still reaches the ground in range between one that does and one that does not: the corner where the cone edge meets the range circle. */
function cornerBetween(edgeHitAt, reachingTurn, missingTurn) {
  let reaching = reachingTurn;
  let missing = missingTurn;
  for (let step = 0; step < CORNER_BISECTION_STEPS; step += 1) {
    const middle = (reaching + missing) / 2;
    if (edgeHitAt(middle)) {
      reaching = middle;
    } else {
      missing = middle;
    }
  }
  return edgeHitAt(reaching);
}

/**
 * Where a spot's lit cone meets the ground (y = 0), cut at its range. The patch is convex, so its outline is the
 * conic found along the cone's edge rays that reach the ground in range, plus the arc of the range circle that
 * lies inside the cone where the edge rays do not reach (a cone that stops short or opens past the horizon).
 * Returns { outline, center }; the outline is empty when the light misses the ground.
 */
export function spotGroundFootprint(light, sceneRadius) {
  const apex = light.position;
  const height = apex[1] - GROUND_HEIGHT;
  const reach = effectiveRange(light.range ?? 0, sceneRadius);
  const nothing = { outline: [], center: null };
  if (height <= 0 || height >= reach) {
    return nothing;
  }
  const axis = normalize(light.direction);
  const halfAngle = light.angle ?? Math.PI / 4;
  const [firstAxis, secondAxis] = planeAxesOf(axis);
  const edgeHitAt = turn => {
    const sideways = add(scale(firstAxis, Math.cos(turn)), scale(secondAxis, Math.sin(turn)));
    const edgeRay = add(scale(axis, Math.cos(halfAngle)), scale(sideways, Math.sin(halfAngle)));
    return groundPointAt(apex, edgeRay, reach);
  };
  const rangeRadius = Math.sqrt(reach * reach - height * height);
  const points = [];
  for (let sample = 0; sample < GROUND_FOOTPRINT_SAMPLE_COUNT; sample += 1) {
    const turn = (sample / GROUND_FOOTPRINT_SAMPLE_COUNT) * Math.PI * 2;
    const hit = edgeHitAt(turn);
    if (hit) {
      points.push(hit);
    }
    const nextTurn = ((sample + 1) / GROUND_FOOTPRINT_SAMPLE_COUNT) * Math.PI * 2;
    if (Boolean(hit) !== Boolean(edgeHitAt(nextTurn))) {
      points.push(cornerBetween(edgeHitAt, hit ? turn : nextTurn, hit ? nextTurn : turn));
    }
    const onRangeCircle = [apex[0] + Math.cos(turn) * rangeRadius, GROUND_HEIGHT, apex[2] + Math.sin(turn) * rangeRadius];
    if (dot(normalize(subtract(onRangeCircle, apex)), axis) >= Math.cos(halfAngle)) {
      points.push(onRangeCircle);
    }
  }
  if (points.length < 3) {
    return nothing;
  }
  const { centroid, ordered } = orderAroundCentroid(points);
  return { outline: [...ordered, ordered[0]], center: centroid };
}

/** The patch an area light's rectangle lights straight along its direction: its corners carried to the ground. */
export function areaGroundFootprint(light, sceneRadius) {
  const { corners, normal } = areaLightReach(light);
  const reach = effectiveRange(0, sceneRadius);
  const hits = corners.map(corner => groundPointAt(corner, normal, reach));
  if (hits.some(hit => hit === null)) {
    return { outline: [], center: null };
  }
  const center = scale(hits.reduce((sum, hit) => add(sum, hit), [0, 0, 0]), 1 / hits.length);
  return { outline: [...hits, hits[0]], center };
}

/** The ground footprint and edge handle for a point light's range. */
export function pointReachHandles(light, sceneRadius, eye = null) {
  const ground = pointGroundFootprint(light, sceneRadius);
  const reach = effectiveRange(light.range ?? 0, sceneRadius);
  if (ground.outline.length > 0) {
    const height = light.position[1] - GROUND_HEIGHT;
    const groundRadius = Math.sqrt(reach * reach - height * height);
    let handleDirection = [0, 0, 1];
    if (eye) {
      const towardEye = [eye[0] - ground.center[0], 0, eye[2] - ground.center[2]];
      const towardLength = Math.hypot(towardEye[0], towardEye[2]);
      if (towardLength > 1e-6) {
        handleDirection = [towardEye[0] / towardLength, 0, towardEye[2] / towardLength];
      }
    }
    return { ground, rangeHandle: add(ground.center, scale(handleDirection, groundRadius)), planeY: GROUND_HEIGHT };
  }
  return {
    ground,
    rangeHandle: [light.position[0] + reach, light.position[1], light.position[2]],
    planeY: light.position[1],
  };
}

/** The ground footprint and drag handles (aim, cone angle, range) for a spot light. */
export function spotReachHandles(light, sceneRadius, eye = null) {
  const ground = spotGroundFootprint(light, sceneRadius);
  const axis = normalize(light.direction);
  const reach = effectiveRange(light.range ?? 0, sceneRadius);
  const aimHit = groundPointAt(light.position, axis, reach);
  const aimHandle = aimHit ?? ground.center ?? pointAlong(light.position, axis, reach * 0.5);
  const aimOnGround = Boolean(aimHit || ground.center);
  if (ground.outline.length === 0) {
    return { ground, aimHandle, aimOnGround, angleHandle: null, rangeHandle: pointAlong(light.position, axis, reach) };
  }
  const anchor = aimHit ?? ground.center;
  const { forward, side } = horizontalSideDirection(axis, eye, anchor);
  return {
    ground,
    aimHandle,
    aimOnGround: true,
    angleHandle: extremePointAlong(ground.outline, anchor, side),
    rangeHandle: extremePointAlong(ground.outline, anchor, forward),
  };
}

/** The rectangle, ground footprint and drag handles (aim, width, height) for an area light. */
export function areaReachHandles(light, sceneRadius, eye = null) {
  const body = areaLightReach(light, eye);
  const ground = areaGroundFootprint(light, sceneRadius);
  const frame = areaLightFrame(light);
  const aimOnGround = ground.outline.length > 0;
  return {
    body,
    ground,
    frame,
    aimHandle: aimOnGround ? ground.center : body.normalTip,
    aimOnGround,
    widthHandle: pointAlong(body.center, frame.right, light.width / 2),
    heightHandle: pointAlong(body.center, frame.height, light.height / 2),
  };
}

/** New point-light range patch from dragging its range handle to a world point. */
export function pointRangeFromHit(lightPosition, hitPoint) {
  const verticalOffset = Math.abs(lightPosition[1] - hitPoint[1]);
  const minimumRange = verticalOffset > TINY_LENGTH ? Math.max(MIN_LIGHT_RANGE, verticalOffset + GROUND_RANGE_MARGIN) : MIN_LIGHT_RANGE;
  const rawRange = Math.hypot(...subtract(hitPoint, lightPosition));
  return { range: clampNumber(rawRange, minimumRange, MAX_LIGHT_RANGE) };
}

/** New light facing direction patch from dragging an aim handle to a world point. */
export function aimDirectionFromHit(lightPosition, hitPoint) {
  const offset = subtract(hitPoint, lightPosition);
  const distance = Math.hypot(...offset);
  if (distance < MIN_AIM_DISTANCE) {
    return null;
  }
  return { direction: scale(offset, 1 / distance) };
}

/** New spot-light half-angle patch from dragging its angle handle to a world point. */
export function spotAngleFromHit(light, hitPoint) {
  const offset = subtract(hitPoint, light.position);
  const distance = Math.hypot(...offset);
  if (distance < MIN_AIM_DISTANCE) {
    return null;
  }
  const cosine = clampNumber(dot(scale(offset, 1 / distance), normalize(light.direction)), -1, 1);
  return { angle: clampNumber(Math.acos(cosine), MIN_SPOT_HALF_ANGLE, MAX_SPOT_HALF_ANGLE) };
}

/** New spot-light range patch from dragging its range handle to a world point. */
export function spotRangeFromHit(lightPosition, hitPoint) {
  const verticalOffset = Math.abs(lightPosition[1] - hitPoint[1]);
  const minimumRange = verticalOffset > TINY_LENGTH ? Math.max(MIN_LIGHT_RANGE, verticalOffset + GROUND_RANGE_MARGIN) : MIN_LIGHT_RANGE;
  const rawRange = Math.hypot(...subtract(hitPoint, lightPosition));
  return { range: clampNumber(rawRange, minimumRange, MAX_LIGHT_RANGE) };
}

/** New area-light width patch from dragging its width handle to a point in the light plane. */
export function areaWidthFromHit(lightPosition, rightAxis, hitPoint) {
  const halfWidth = Math.abs(dot(subtract(hitPoint, lightPosition), rightAxis));
  return { width: clampNumber(halfWidth * 2, MIN_AREA_SIZE, MAX_AREA_SIZE) };
}

/** New area-light height patch from dragging its height handle to a point in the light plane. */
export function areaHeightFromHit(lightPosition, heightAxis, hitPoint) {
  const halfHeight = Math.abs(dot(subtract(hitPoint, lightPosition), heightAxis));
  return { height: clampNumber(halfHeight * 2, MIN_AREA_SIZE, MAX_AREA_SIZE) };
}
