// The exit of a view ray from a closed glass shape, found from the shape's own back surface. The liquid pass draws the back faces of closed
// transmissive parts into a small target (their depth and outward normal); a glass fragment bends its ray at the front, marches that inside
// ray against the back-face depth to find where it leaves, reads the normal there and bends it a second time. Any closed mesh works, not
// only a ball. A shape with no back face (a glass cap) leaves the target empty, the march misses and the shader keeps the thickness
// heuristic of glass-ball-lens.js.
// The GLSL below follows the JavaScript reference line by line, so a test of the reference covers the shader.
import { marchSceneDepth } from './glass-depth-march.js';
import { refractDirection } from './glass-ball-lens.js';

/** The inside ray is followed this many thicknesses of the glass body: a chord of a convex body never exceeds its widest extent. */
export const BACK_REACH_PER_THICKNESS = 1.5;

const scale = (vector, factor) => [vector[0] * factor, vector[1] * factor, vector[2] * factor];
const add = (first, second) => [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
const normalize = vector => scale(vector, 1 / Math.hypot(...vector));

/**
 * Whether a glass part draws into the back-face target: closed glass with a thickness. A cap whose medium continues behind it
 * (`mediumContinues`) has no back face to find and keeps the open-cap thickness path of #3207.
 */
export function drawsBackFaces({ transmission, thickness, mediumContinues }) {
  return transmission > 0 && thickness > 0 && mediumContinues !== true;
}

/**
 * Where the view ray leaves a closed glass shape and in which direction, or null when the back surface is not found.
 * `normal` faces the viewer, `viewDirection` points from the surface to the eye. `project(point)` and `backDepth(x, y)` are as in
 * marchSceneDepth, with the depth of the back faces; `backNormal(x, y)` returns the outward normal of the back face at a screen position.
 */
export function backFaceExit({ position, normal, viewDirection, indexOfRefraction, thickness, project, backDepth, backNormal, reversed }) {
  const incident = scale(viewDirection, -1);
  const inside = refractDirection(incident, normal, 1 / indexOfRefraction) ?? incident;
  const hit = marchSceneDepth({ origin: position, direction: inside, maximumDistance: thickness * BACK_REACH_PER_THICKNESS, project, sceneDepth: backDepth, reversed });
  if (!hit?.hit) return null;
  const outward = backNormal(hit.x, hit.y);
  if (!outward || Math.hypot(...outward) < 0.5) return null;
  const exitPosition = add(position, scale(inside, hit.distance));
  // The normal given to the second refraction faces back into the glass.
  const refracted = refractDirection(inside, scale(normalize(outward), -1), indexOfRefraction);
  // Total internal reflection at the exit: the ray does not leave here, so the caller keeps the ball lens estimate.
  if (!refracted) return null;
  const direction = normalize(refracted);
  return { exitPosition, direction };
}

export const glassBackFaceGlsl = `
// Depth and outward normal of the back faces of the closed glass parts (glass-back-face.js); glassBackEnabled is 0 when the frame has none.
uniform highp sampler2D glassBackDepth;
uniform highp sampler2D glassBackNormal;
uniform float glassBackEnabled;
// 1 while the back faces are drawn: the fragment writes its outward normal (n * 0.5 + 0.5, alpha 1) and nothing else.
uniform float glassBackPass;
const float BACK_REACH_PER_THICKNESS = ${BACK_REACH_PER_THICKNESS.toFixed(1)};

// False when the inside ray finds no back face or is totally reflected at the exit; the caller then keeps the thickness heuristic.
bool glassBackFaceRay(vec3 position, vec3 normal, vec3 viewDirection, float indexOfRefraction, float thickness, out vec3 exitPosition, out vec3 direction) {
  vec3 incident = -viewDirection;
  vec3 inside = refract(incident, normal, 1.0 / indexOfRefraction);
  if (dot(inside, inside) < 0.5) inside = incident;
  vec4 hit = marchDepthTexture(glassBackDepth, position, inside, thickness * BACK_REACH_PER_THICKNESS);
  if (hit.z < 0.75) return false;
  vec4 encoded = texelFetch(glassBackNormal, ivec2(hit.xy * resolution), 0);
  if (encoded.a < 0.5) return false;
  vec3 outward = encoded.xyz * 2.0 - 1.0;
  exitPosition = position + inside * hit.w;
  direction = refract(inside, -normalize(outward), indexOfRefraction);
  if (dot(direction, direction) < 0.5) return false;
  direction = normalize(direction);
  return true;
}
`;
