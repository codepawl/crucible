// Glass that bends light at two interfaces, the way a ball lens does. The liquid shader treats the body behind a glass fragment as a
// sphere tangent to the surface: the view ray bends where it enters, crosses a chord of the sphere and bends again where it leaves,
// so a thick sphere magnifies and inverts what lies behind it, as the path tracer shows. A flat pane (an infinite radius) leaves the
// ray parallel, shifted sideways by the pane, and a thin-walled surface (thickness 0) leaves it alone.
// The GLSL below follows the JavaScript reference line by line, so a test of the reference covers the shader.

/** The estimated radius of curvature never goes below this share of the thickness (a fragment on a silhouette edge reads a tiny radius). */
export const MINIMUM_RADIUS_PER_THICKNESS = 0.5;
/** A flat surface has no curvature; its radius is capped here, in thicknesses, so the sphere centre stays a finite number. */
export const MAXIMUM_RADIUS_PER_THICKNESS = 1000;

/**
 * How far behind the exit point the shader reads the scene when the depth march misses (the ray leaves the screen or reaches the sky), in
 * thicknesses. A quarter of the thickness (half a radius of a ball) keeps what sits close behind the glass upright and magnified.
 * A march that hits (glass-depth-march.js) replaces this guess with the real surface.
 */
export const SCENE_REACH_PER_THICKNESS = 0.25;

const subtract = (first, second) => [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
const add = (first, second) => [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
const scale = (vector, factor) => [vector[0] * factor, vector[1] * factor, vector[2] * factor];
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
/** The sphere exit gives way to the slab exit over this much of the ratio of the sphere chord to the slab chord, above 1. */
export const SPHERE_SLAB_BLEND_BAND = 0.5;
const smoothstep = (low, high, value) => {
  const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A curved surface is a small ball only when its radius is a large share of the body behind it (a ball's radius is half its depth, 0.5).
 * Below this share of the body depth the curvature is a bevel or fillet on a much larger body and the exit is a slab exit; between the two
 * shares the exits blend. A rounded box with a bevel of 0.12 of its size sits at the low end.
 */
export const BEVEL_RADIUS_SHARE_LOW = 0.15;
export const BEVEL_RADIUS_SHARE_HIGH = 0.3;
/** The body depth is searched this many thicknesses behind the fragment; a miss counts as a body at least that deep. */
export const BODY_REACH_PER_THICKNESS = 8;

/** The share (0 to 1) of the slab exit that a curvature radius earns from the body depth behind it; 0 when the body depth is not a positive finite number (unknown). */
export function bevelSlabShare(radius, bodyDepth) {
  if (!(bodyDepth > 0) || !Number.isFinite(bodyDepth)) return 0;
  return 1 - smoothstep(BEVEL_RADIUS_SHARE_LOW, BEVEL_RADIUS_SHARE_HIGH, radius / bodyDepth);
}
const normalize = vector => scale(vector, 1 / Math.hypot(...vector));

/** GLSL refract(): the bent direction of a unit incident ray at a surface whose normal faces it, or null in total internal reflection. */
export function refractDirection(incident, normal, eta) {
  const cosine = dot(normal, incident);
  const discriminant = 1 - eta * eta * (1 - cosine * cosine);
  if (discriminant < 0) return null;
  return add(scale(incident, eta), scale(normal, -(eta * cosine + Math.sqrt(discriminant))));
}

/** The radius of curvature the shader reads from the screen-space steps of the position and the normal, clamped to a usable range. */
export function curvatureRadius(positionStep, normalStep, thickness) {
  const radius = positionStep / Math.max(normalStep, 1e-5);
  return Math.min(Math.max(radius, thickness * MINIMUM_RADIUS_PER_THICKNESS), thickness * MAXIMUM_RADIUS_PER_THICKNESS);
}

/**
 * Where the view ray leaves a glass body and in which direction.
 * `normal` faces the viewer, `viewDirection` points from the surface to the eye, `thickness` is the extent of the body along the normal.
 * `bodyDepth` is the depth of the whole closed body behind the fragment along the inward normal (glass-back-face.js, glassBodyDepth); with it a small
 * radius next to a large body (a bevel) takes the slab exit instead of bending like a small ball. Leave it out where the body is not known.
 * Returns { exitPosition, direction, samplePosition }: the direction the ray travels after leaving, and the point `thickness * SCENE_REACH_PER_THICKNESS` metres
 * further along it, which is where the shader reads the scene.
 */
export function ballLensExit({ position, normal, viewDirection, indexOfRefraction, radius, thickness, bodyDepth = Number.NaN }) {
  const incident = scale(viewDirection, -1);
  const inside = refractDirection(incident, normal, 1 / indexOfRefraction) ?? incident;
  const cosineInside = Math.max(-dot(inside, normal), 1e-3);
  // A sphere has a chord of 2 R cos; a slab of the given thickness has a path of thickness / cos. The shorter one limits the body.
  const sphereChord = 2 * radius * cosineInside;
  const slabChord = thickness / cosineInside;
  // The ray leaves through the sphere when the chord ends on it, and through the parallel back face of a slab when the thickness ends it first.
  // Where the two chords are equal (the centre of a ball whose thickness is its diameter) a hard switch flipped on the noise of the
  // screen-space radius, so the two exits are blended over a 50% band of the chord ratio (SPHERE_SLAB_BLEND_BAND).
  const slabShare = Math.max(smoothstep(1, 1 + SPHERE_SLAB_BLEND_BAND, sphereChord / slabChord), bevelSlabShare(radius, bodyDepth));
  const center = subtract(position, scale(normal, radius));
  const sphereExit = add(position, scale(inside, sphereChord));
  const slabExit = add(position, scale(inside, slabChord));
  // The normal given to the second refraction faces back into the glass; total internal reflection keeps the inside direction.
  const sphereDirection = refractDirection(inside, scale(normalize(subtract(sphereExit, center)), -1), indexOfRefraction) ?? inside;
  const slabDirection = refractDirection(inside, normal, indexOfRefraction) ?? inside;
  const exitPosition = add(scale(sphereExit, 1 - slabShare), scale(slabExit, slabShare));
  const direction = normalize(add(scale(sphereDirection, 1 - slabShare), scale(slabDirection, slabShare)));
  return { exitPosition, direction, samplePosition: add(exitPosition, scale(direction, thickness * SCENE_REACH_PER_THICKNESS)) };
}

/**
 * The share of the refracted picture that covers the scene: the alpha of a blended glass material, raised by the transmission share.
 * Light that passes through glass replaces what lies behind it, so a refracted picture drawn at low alpha would leave an unrefracted
 * ghost of the same scene underneath (a glTF cornea authored with alpha 0.25 and transmission 1 would show only a quarter of its refraction).
 */
export function glassOutputCoverage(alpha, transmissionShare) {
  return alpha + (1 - alpha) * transmissionShare;
}

export const ballLensGlsl = `
float glassOutputCoverage(float alpha, float transmissionShare) {
  return alpha + (1.0 - alpha) * transmissionShare;
}

const float MINIMUM_RADIUS_PER_THICKNESS = ${MINIMUM_RADIUS_PER_THICKNESS.toFixed(1)};
const float MAXIMUM_RADIUS_PER_THICKNESS = ${MAXIMUM_RADIUS_PER_THICKNESS.toFixed(1)};
const float SPHERE_SLAB_BLEND_BAND = ${SPHERE_SLAB_BLEND_BAND.toFixed(1)};
const float SCENE_REACH_PER_THICKNESS = ${SCENE_REACH_PER_THICKNESS.toFixed(2)};
const float BEVEL_RADIUS_SHARE_LOW = ${BEVEL_RADIUS_SHARE_LOW.toFixed(2)};
const float BEVEL_RADIUS_SHARE_HIGH = ${BEVEL_RADIUS_SHARE_HIGH.toFixed(2)};
const float BODY_REACH_PER_THICKNESS = ${BODY_REACH_PER_THICKNESS.toFixed(1)};

// bodyDepth <= 0 means the body depth is not known (see bevelSlabShare).
float bevelSlabShare(float radius, float bodyDepth) {
  if (bodyDepth <= 0.0) return 0.0;
  return 1.0 - smoothstep(BEVEL_RADIUS_SHARE_LOW, BEVEL_RADIUS_SHARE_HIGH, radius / bodyDepth);
}

float curvatureRadius(float positionStep, float normalStep, float thickness) {
  float radius = positionStep / max(normalStep, 1e-5);
  return min(max(radius, thickness * MINIMUM_RADIUS_PER_THICKNESS), thickness * MAXIMUM_RADIUS_PER_THICKNESS);
}

// Where the view ray leaves a glass body of this thickness and in which direction (see glass-ball-lens.js, ballLensExit).
void ballLensRay(vec3 position, vec3 normal, vec3 viewDirection, float indexOfRefraction, float radius, float thickness, float bodyDepth, out vec3 exitPosition, out vec3 direction) {
  vec3 incident = -viewDirection;
  vec3 inside = refract(incident, normal, 1.0 / indexOfRefraction);
  if (dot(inside, inside) < 0.5) inside = incident;
  float cosineInside = max(-dot(inside, normal), 1e-3);
  float sphereChord = 2.0 * radius * cosineInside;
  float slabChord = thickness / cosineInside;
  float slabShare = max(smoothstep(1.0, 1.0 + SPHERE_SLAB_BLEND_BAND, sphereChord / slabChord), bevelSlabShare(radius, bodyDepth));
  vec3 sphereExit = position + inside * sphereChord;
  vec3 slabExit = position + inside * slabChord;
  vec3 sphereDirection = refract(inside, -normalize(sphereExit - (position - normal * radius)), indexOfRefraction);
  if (dot(sphereDirection, sphereDirection) < 0.5) sphereDirection = inside;
  vec3 slabDirection = refract(inside, normal, indexOfRefraction);
  if (dot(slabDirection, slabDirection) < 0.5) slabDirection = inside;
  exitPosition = mix(sphereExit, slabExit, slabShare);
  direction = normalize(mix(sphereDirection, slabDirection, slabShare));
}
`;
