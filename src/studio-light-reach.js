import { sceneSphereOf, sunMarkPosition } from './studio-sun-mark.js';

// How far and how wide each light shines, as world-space polylines made from its properties alone.
//
// Recipe meaning, as the renderer reads it (src/lighting.js):
// - spot `angle` is the HALF angle of the outer cone in radians (0.01 up to just under a quarter turn);
// - spot `penumbra` is the share of the cone's cosine span the fade covers: the cone is full strength inside the angle
//   whose cosine is cos(angle) + (1 - cos(angle)) * penumbra, so 0 is a hard edge and 1 fades from the axis;
// - point and spot `range` is the distance where the light is cut off, in scene units; 0 or missing means unlimited.
// - area lights are a width x height rectangle facing `direction`, with `up` fixing which way the height runs.

/** Radius of the ring and of the reach drawn for a light with no range, as a multiple of the scene radius. */
export const UNLIMITED_RANGE_SCENE_RADIUS_FACTOR = 1.5;
export const CIRCLE_SEGMENT_COUNT = 64;
export const GROUND_FOOTPRINT_SAMPLE_COUNT = 96;
export const SUN_PARALLEL_ARROW_COUNT = 5;
const SUN_PARALLEL_ARROW_SPREAD = 0.55;
const SUN_PARALLEL_ARROW_LENGTH_SHARE = 0.5;
const ARROW_HEAD_SHARE = 0.22;
const AREA_NORMAL_ARROW_SHARE = 0.5;
const SPOT_EDGE_LINE_COUNT = 4;
const GROUND_HEIGHT = 0;
const TINY_LENGTH = 1e-9;

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

/** The outline of a ball as seen from the eye: a circle facing the eye, or null when the eye is inside the ball. */
export function sphereSilhouette(center, radius, eye) {
  const toEye = subtract(eye, center);
  const distance = Math.hypot(...toEye);
  if (distance <= radius) {
    return null;
  }
  const facing = scale(toEye, 1 / distance);
  const silhouetteRadius = radius * Math.sqrt(1 - (radius * radius) / (distance * distance));
  const silhouetteCenter = pointAlong(center, facing, (radius * radius) / distance);
  const [firstAxis, secondAxis] = planeAxesOf(facing);
  return circlePolyline(silhouetteCenter, firstAxis, secondAxis, silhouetteRadius);
}

/** An arrow from one point to another as polylines: the shaft and two crossed barbs at the tip. */
export function arrowPolylines(from, to) {
  const shaft = subtract(to, from);
  const length = Math.hypot(...shaft);
  if (length < TINY_LENGTH) {
    return [];
  }
  const direction = scale(shaft, 1 / length);
  const [firstAxis, secondAxis] = planeAxesOf(direction);
  const headLength = length * ARROW_HEAD_SHARE;
  const base = pointAlong(to, direction, -headLength);
  const barb = axis => [pointAlong(base, axis, headLength * 0.5), to, pointAlong(base, axis, -headLength * 0.5)];
  return [[from, to], barb(firstAxis), barb(secondAxis)];
}

/** A point light: its range as three axis-plane circles, the radius of the source, and the range for a facing circle. */
export function pointLightReach(light, sceneRadius) {
  const center = [...light.position];
  const rangeRadius = effectiveRange(light.range ?? 0, sceneRadius);
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return {
    center,
    rangeRadius,
    sourceRadius: light.radius ?? 0.05,
    axisCircles: [[0, 1], [1, 2], [2, 0]].map(([first, second]) => circlePolyline(center, axes[first], axes[second], rangeRadius)),
  };
}

/** A spot light: the cone out to its range, the rim at the far end, four edge lines and the rim where the fade begins. */
export function spotLightReach(light, sceneRadius) {
  const apex = [...light.position];
  const axis = normalize(light.direction);
  const halfAngle = light.angle ?? Math.PI / 4;
  const length = effectiveRange(light.range ?? 0, sceneRadius);
  const [firstAxis, secondAxis] = planeAxesOf(axis);
  const rimAt = angle => ({
    center: pointAlong(apex, axis, length * Math.cos(angle)),
    radius: length * Math.sin(angle),
  });
  const outer = rimAt(halfAngle);
  const cosineOuter = Math.cos(halfAngle);
  const innerHalfAngle = Math.acos(Math.min(1, cosineOuter + (1 - cosineOuter) * (light.penumbra ?? 0.15)));
  const inner = rimAt(innerHalfAngle);
  const edgeLines = [];
  for (let edge = 0; edge < SPOT_EDGE_LINE_COUNT; edge += 1) {
    const turn = (edge / SPOT_EDGE_LINE_COUNT) * Math.PI * 2;
    const sideways = add(scale(firstAxis, Math.cos(turn)), scale(secondAxis, Math.sin(turn)));
    edgeLines.push([apex, add(outer.center, scale(sideways, outer.radius))]);
  }
  return {
    apex,
    axis,
    halfAngle,
    innerHalfAngle,
    length,
    rimCenter: outer.center,
    rimRadius: outer.radius,
    innerRimRadius: inner.radius,
    rim: circlePolyline(outer.center, firstAxis, secondAxis, outer.radius),
    innerRim: circlePolyline(inner.center, firstAxis, secondAxis, inner.radius),
    edgeLines,
  };
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
export function areaLightReach(light) {
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
  return {
    center,
    normal,
    corners,
    rectangle: [...corners, corners[0]],
    normalArrow: arrowPolylines(center, pointAlong(center, normal, arrowLength)),
  };
}

/** The sun's whole-scene ring and its two direction indicators; `direction` is the unit vector toward the sun. */
export function sunReach(bounds, direction) {
  const scene = sceneSphereOf(bounds);
  const [firstAxis, secondAxis] = planeAxesOf(direction);
  const arrowLength = scene.radius * SUN_PARALLEL_ARROW_LENGTH_SHARE;
  const offsets = [[0, 0]];
  for (let arrow = 0; arrow < SUN_PARALLEL_ARROW_COUNT - 1; arrow += 1) {
    const turn = (arrow / (SUN_PARALLEL_ARROW_COUNT - 1)) * Math.PI * 2;
    offsets.push([Math.cos(turn) * SUN_PARALLEL_ARROW_SPREAD, Math.sin(turn) * SUN_PARALLEL_ARROW_SPREAD]);
  }
  const parallelArrows = offsets.map(([first, second]) => {
    const middle = add(scene.center, add(scale(firstAxis, first * scene.radius), scale(secondAxis, second * scene.radius)));
    return arrowPolylines(pointAlong(middle, direction, arrowLength / 2), pointAlong(middle, direction, -arrowLength / 2));
  });
  return {
    center: scene.center,
    radius: scene.radius,
    ring: circlePolyline(scene.center, firstAxis, secondAxis, scene.radius),
    parallelArrows,
    singleArrow: arrowPolylines(sunMarkPosition(bounds, direction), scene.center),
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
  if (direction[1] >= -1e-9) {
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
  const points = [];
  for (let sample = 0; sample < GROUND_FOOTPRINT_SAMPLE_COUNT; sample += 1) {
    const turn = (sample / GROUND_FOOTPRINT_SAMPLE_COUNT) * Math.PI * 2;
    const sideways = add(scale(firstAxis, Math.cos(turn)), scale(secondAxis, Math.sin(turn)));
    const edgeRay = add(scale(axis, Math.cos(halfAngle)), scale(sideways, Math.sin(halfAngle)));
    const hit = groundPointAt(apex, edgeRay, reach);
    if (hit) {
      points.push(hit);
    }
    const groundDirection = [Math.cos(turn), 0, Math.sin(turn)];
    const rangeRadius = Math.sqrt(reach * reach - height * height);
    const onRangeCircle = [apex[0] + groundDirection[0] * rangeRadius, GROUND_HEIGHT, apex[2] + groundDirection[2] * rangeRadius];
    const towardPoint = normalize(subtract(onRangeCircle, apex));
    if (dot(towardPoint, axis) >= Math.cos(halfAngle)) {
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
