import { directionToSunAngles } from './studio-controller.js';

// The sun has no place in the scene, so its mark stands at a fixed world point: out from the middle of the whole scene,
// on the side the light comes from. Orbiting, panning and zooming never move it; only the scene and the sun do.
export const SUN_MARK_DISTANCE_FACTOR = 1.3;
export const SUN_MARK_RAY_SHARE = 0.25;
// Used when the scene has no geometry yet, so the mark still has somewhere to stand.
export const SUN_MARK_FALLBACK_RADIUS = 4;
export const SUN_MARK_MINIMUM_RADIUS = 0.5;
// The sun panel's pad keeps the sun in this band, so a drag in the viewport does too.
export const SUN_MINIMUM_ELEVATION_DEGREES = 4;
export const SUN_MAXIMUM_ELEVATION_DEGREES = 88;

const SCENE_CENTRE_WHEN_EMPTY = [0, 0, 0];

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

function pointAlong(origin, direction, distance) {
  return origin.map((component, axis) => component + direction[axis] * distance);
}

/** The sphere around the whole scene: its centre and the radius of the box's diagonal. An empty scene gets the fallback. */
export function sceneSphereOf(bounds) {
  if (!bounds) {
    return { center: [...SCENE_CENTRE_WHEN_EMPTY], radius: SUN_MARK_FALLBACK_RADIUS };
  }
  const center = bounds.min.map((component, axis) => (component + bounds.max[axis]) / 2);
  const halfDiagonal = Math.hypot(...subtract(bounds.max, bounds.min)) / 2;
  return { center, radius: Math.max(SUN_MARK_MINIMUM_RADIUS, halfDiagonal) };
}

/** The sphere the sun mark slides over while it is dragged: centred on the scene, through the mark. */
export function sunMarkSphereOf(bounds) {
  const scene = sceneSphereOf(bounds);
  return { center: scene.center, radius: scene.radius * SUN_MARK_DISTANCE_FACTOR };
}

/** The fixed world point of the sun mark for the scene's bounds and the unit direction toward the sun. */
export function sunMarkPosition(bounds, direction) {
  const sphere = sunMarkSphereOf(bounds);
  return pointAlong(sphere.center, direction, sphere.radius);
}

/** The far end of the sun's ray: it leaves the mark and points back toward the scene centre. */
export function sunRayEnd(bounds, direction) {
  const mark = sunMarkPosition(bounds, direction);
  const rayLength = sceneSphereOf(bounds).radius * SUN_MARK_RAY_SHARE;
  return pointAlong(mark, direction, -rayLength);
}

/** Whether the mark lies on the half of the sphere turned away from the eye, so a drag keeps to that half and does not jump to the front. */
export function markIsOnFarSide(markPoint, sphere, eye) {
  return dot(subtract(markPoint, sphere.center), subtract(markPoint, eye)) > 0;
}

/**
 * The point of a sphere under a pointer ray: where it enters, or with farSide where it leaves. A ray that misses the
 * sphere takes the point of the sphere nearest to it (on its silhouette), so a drag that strays off keeps turning instead of stalling.
 */
export function pointOnSphereUnderRay(ray, sphere, { farSide = false } = {}) {
  const toCentre = subtract(sphere.center, ray.origin);
  const alongRay = dot(toCentre, ray.direction);
  const closestOnRay = pointAlong(ray.origin, ray.direction, alongRay);
  const offsetFromCentre = subtract(closestOnRay, sphere.center);
  const missDistance = Math.hypot(...offsetFromCentre);
  if (missDistance >= sphere.radius) {
    return pointAlong(sphere.center, normalize(offsetFromCentre), sphere.radius);
  }
  const halfChord = Math.sqrt(sphere.radius * sphere.radius - missDistance * missDistance);
  const nearDistance = alongRay - halfChord;
  const hitDistance = farSide || nearDistance < 0 ? alongRay + halfChord : nearDistance;
  return pointAlong(ray.origin, ray.direction, hitDistance);
}

/** The sun angles a drag asks for: toward the pointer's point on the sphere, kept in the pad's elevation band. */
export function sunAnglesUnderRay(ray, sphere, { farSide = false } = {}) {
  const hit = pointOnSphereUnderRay(ray, sphere, { farSide });
  const angles = directionToSunAngles(subtract(hit, sphere.center));
  const elevationDegrees = Math.max(SUN_MINIMUM_ELEVATION_DEGREES, Math.min(SUN_MAXIMUM_ELEVATION_DEGREES, angles.elevationDegrees));
  return { azimuthDegrees: angles.azimuthDegrees, elevationDegrees };
}
