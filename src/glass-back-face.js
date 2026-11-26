// The exit of a view ray from a closed glass shape, found from the shape's own back surface. The liquid pass draws the back faces of closed
// transmissive parts into a small target (their depth and outward normal); a glass fragment bends its ray at the front, marches that inside
// ray against the back-face depth to find where it leaves, reads the normal there and bends it a second time. Any closed mesh works, not
// only a ball. A shape with no back face (a glass cap) leaves the target empty, the march misses and the shader keeps the thickness
// heuristic of glass-ball-lens.js.
// The target keeps the nearest back face per pixel, so with one closed shape inside another it holds the inner shape's back face where the outer
// ray needs its own. Only then (glassShellsNested) a second target keeps the farthest back face per pixel, every back face carries the
// identifier of the glass instance that drew it (in the alpha), and a ray takes its exit from the first layer that holds its own shape's back
// face. Single shells and shells that merely overlap keep the nearest back face, as before (#3340).
// The GLSL below follows the JavaScript reference line by line, so a test of the reference covers the shader.
import { marchSceneDepth } from './glass-depth-march.js';
import { BODY_REACH_PER_THICKNESS, refractDirection } from './glass-ball-lens.js';

/** The inside ray is followed this many thicknesses of the glass body: a chord of a convex body never exceeds its widest extent. */
export const BACK_REACH_PER_THICKNESS = 1.5;

/** Identifiers run 1 to 254 (alpha 0 means nothing was drawn and RGBA8 has 255 steps); instance 254 of a frame reuses 1, which only restores the older behaviour. */
export const BACK_IDENTIFIER_COUNT = 254;

/** The identifier of instance `instanceIndex` of a batch whose first instance is number `firstInstance` among the frame's closed glass instances. */
export function backIdentifier(firstInstance, instanceIndex) {
  return ((firstInstance + instanceIndex) % BACK_IDENTIFIER_COUNT) + 1;
}

/** More shells than this are not compared pair by pair; the frame then keeps the single back-face layer. */
export const SHELL_PAIR_LIMIT = 64;

const ORIENTED_CONTAINMENT_EPSILON = 1e-5;

const boxContains = (outer, inner) => [0, 1, 2].every(axis => outer.minimum[axis] <= inner.minimum[axis] && inner.maximum[axis] <= outer.maximum[axis]);

// When both shells carry oriented bounds (`matrix`, `inverseMatrix`, `localMinimum`, `localMaximum`), transform all 8 corners of
// `inner` into `outer`'s local space so a small shell sitting in the corner of a rotated box's world AABB is not marked nested (#3411).
function orientedBoxContains(outer, inner) {
  const inverse = outer.inverseMatrix;
  const matrix = inner.matrix;
  if (!inverse || !matrix || !outer.localMinimum || !outer.localMaximum || !inner.localMinimum || !inner.localMaximum) return true;
  const { localMinimum: outerMin, localMaximum: outerMax } = outer;
  const { localMinimum: innerMin, localMaximum: innerMax } = inner;
  for (let corner = 0; corner < 8; corner++) {
    const localX = corner & 1 ? innerMax[0] : innerMin[0];
    const localY = corner & 2 ? innerMax[1] : innerMin[1];
    const localZ = corner & 4 ? innerMax[2] : innerMin[2];
    const worldX = matrix[0] * localX + matrix[4] * localY + matrix[8] * localZ + matrix[12];
    const worldY = matrix[1] * localX + matrix[5] * localY + matrix[9] * localZ + matrix[13];
    const worldZ = matrix[2] * localX + matrix[6] * localY + matrix[10] * localZ + matrix[14];
    const inX = inverse[0] * worldX + inverse[4] * worldY + inverse[8] * worldZ + inverse[12];
    const inY = inverse[1] * worldX + inverse[5] * worldY + inverse[9] * worldZ + inverse[13];
    const inZ = inverse[2] * worldX + inverse[6] * worldY + inverse[10] * worldZ + inverse[14];
    if (inX < outerMin[0] - ORIENTED_CONTAINMENT_EPSILON || inX > outerMax[0] + ORIENTED_CONTAINMENT_EPSILON) return false;
    if (inY < outerMin[1] - ORIENTED_CONTAINMENT_EPSILON || inY > outerMax[1] + ORIENTED_CONTAINMENT_EPSILON) return false;
    if (inZ < outerMin[2] - ORIENTED_CONTAINMENT_EPSILON || inZ > outerMax[2] + ORIENTED_CONTAINMENT_EPSILON) return false;
  }
  return true;
}

/**
 * Whether one closed glass shell lies inside another, so the nearest back face per pixel is the inner shell's where the outer ray needs its own
 * and a second layer (the farthest back face) is worth drawing. `shells` hold world boxes `{ minimum, maximum }` and optional oriented bounds; a
 * shell counts as inside another when its oriented box fits inside the other's. Overlapping shells that do not nest stay on the single layer: an exact
 * exit there makes the picture worse, because the raster draws the larger shell's front over the smaller one (#3340). A frame with one shell,
 * or more than SHELL_PAIR_LIMIT, needs no second layer.
 */
export function glassShellsNested(shells) {
  if (shells.length < 2 || shells.length > SHELL_PAIR_LIMIT) return false;
  return shells.some((inner, innerIndex) => shells.some((outer, outerIndex) => innerIndex !== outerIndex && boxContains(outer, inner) && orientedBoxContains(outer, inner)));
}

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
 * Finds the back face this ray leaves its shape through. With no `farthest` layer (one shell, or shells that overlap without nesting) it is
 * the nearest back face, whichever shell drew it. With a `farthest` layer (one shell inside another) it is the first layer whose back face
 * was drawn by the shape the ray entered. Returns the hit and its layer's normal reader, or null.
 */
function ownBackFace({ shapeIdentifier, nearest, farthest, position, inside, thickness, project, reversed }) {
  const layers = farthest ? [nearest, farthest] : [nearest];
  for (const layer of layers) {
    const hit = marchSceneDepth({ origin: position, direction: inside, maximumDistance: thickness * BACK_REACH_PER_THICKNESS, project, sceneDepth: layer.backDepth, reversed });
    if (!hit?.hit) return null;
    const identifier = layer.backIdentifierAt(hit.x, hit.y);
    // Nothing was drawn here: no other layer holds this ray's exit either.
    if (!identifier) return null;
    if (!farthest || identifier === shapeIdentifier) return { hit, backNormal: layer.backNormal };
  }
  return null;
}

/**
 * Where the view ray leaves a closed glass shape and in which direction, or null when the back surface is not found.
 * `normal` faces the viewer, `viewDirection` points from the surface to the eye. `project(point)` is as in marchSceneDepth. `nearest` is the layer
 * of the nearest back faces and `farthest` the optional layer of the farthest ones (given only when one shell is inside another), each
 * `{ backDepth(x, y), backNormal(x, y), backIdentifierAt(x, y) }`: the depth of the back faces, their outward normal and the identifier of the
 * instance that drew them. With a `farthest` layer the exit must come from the back face of `shapeIdentifier` (the shape the ray entered);
 * without a layer holding it the caller keeps the ball lens estimate.
 */
export function backFaceExit({ shapeIdentifier, nearest, farthest, position, normal, viewDirection, indexOfRefraction, thickness, project, reversed }) {
  const incident = scale(viewDirection, -1);
  const inside = refractDirection(incident, normal, 1 / indexOfRefraction) ?? incident;
  const found = ownBackFace({ shapeIdentifier, nearest, farthest, position, inside, thickness, project, reversed });
  if (!found) return null;
  const { hit, backNormal } = found;
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

/**
 * How deep the closed body behind a glass fragment is: the distance from the fragment to the nearest back face along the inward normal (the
 * axis the ball lens model puts the sphere centre on), found by marching that ray against the back-face depth. The view ray would end on the
 * side wall for a fragment on the bevel next to it and read a shallow body there. Returns NaN where no back face is drawn at the fragment's pixel (an
 * open cap or a pane, so the body is unknown) and `thickness * BODY_REACH_PER_THICKNESS` where the march does not reach one (a body at
 * least that deep). `project` is as in marchSceneDepth; `nearest` is as in backFaceExit.
 */
export function glassBodyDepth({ position, normal, thickness, nearest, project, reversed }) {
  const screen = project(position);
  if (!screen || !nearest.backIdentifierAt(screen.x, screen.y)) return Number.NaN;
  const reach = thickness * BODY_REACH_PER_THICKNESS;
  const hit = marchSceneDepth({ origin: position, direction: scale(normal, -1), maximumDistance: reach, project, sceneDepth: nearest.backDepth, reversed });
  return hit?.hit ? hit.distance : reach;
}

export const glassBackFaceGlsl = `
// Depth and outward normal of the back faces of the closed glass parts (glass-back-face.js); glassBackEnabled is 0 when the frame has none.
uniform highp sampler2D glassBackDepth;
uniform highp sampler2D glassBackNormal;
uniform float glassBackEnabled;
// The farthest back face per pixel, drawn only while one closed shell is inside another (glassBackFarEnabled is 1); the outer shell finds its exit here.
uniform highp sampler2D glassBackFarDepth;
uniform highp sampler2D glassBackFarNormal;
uniform float glassBackFarEnabled;
// 1 while the back faces are drawn: the fragment writes its outward normal (n * 0.5 + 0.5) and its identifier / 255 in the alpha, nothing else.
uniform float glassBackPass;
// The glass instance being drawn is number glassBackFirst (its batch's first instance among the frame's closed glass) plus its instance index.
uniform float glassBackFirst;
float glassBackIdentifier() {
  return mod(glassBackFirst + instanceEmission.w, ${BACK_IDENTIFIER_COUNT}.0) + 1.0;
}
const float BACK_REACH_PER_THICKNESS = ${BACK_REACH_PER_THICKNESS.toFixed(1)};

// How deep the closed body behind this fragment is along the inward normal (glassBodyDepth above); 0 where no back face is drawn at this pixel.
float glassBodyDepth(vec3 position, vec3 normal, float thickness) {
  vec4 encoded = texelFetch(glassBackNormal, ivec2(gl_FragCoord.xy), 0);
  if (encoded.a < 0.5 / 255.0) return 0.0;
  float reach = thickness * BODY_REACH_PER_THICKNESS;
  vec4 hit = marchDepthTexture(glassBackDepth, position, -normal, reach);
  return hit.z > 0.75 ? hit.w : reach;
}

// False when the inside ray finds no back face or is totally reflected at the exit; the caller then keeps the thickness heuristic.
bool glassBackFaceRay(vec3 position, vec3 normal, vec3 viewDirection, float indexOfRefraction, float thickness, out vec3 exitPosition, out vec3 direction) {
  vec3 incident = -viewDirection;
  vec3 inside = refract(incident, normal, 1.0 / indexOfRefraction);
  if (dot(inside, inside) < 0.5) inside = incident;
  float reach = thickness * BACK_REACH_PER_THICKNESS;
  float own = glassBackIdentifier();
  vec4 hit = marchDepthTexture(glassBackDepth, position, inside, reach);
  if (hit.z < 0.75) return false;
  vec4 encoded = texelFetch(glassBackNormal, ivec2(hit.xy * resolution), 0);
  // Alpha is the identifier / 255, 0 where nothing was drawn.
  if (encoded.a < 0.5 / 255.0) return false;
  // Without a second layer the nearest back face is the exit, whichever shell drew it; with one it must be this shell's own.
  if (glassBackFarEnabled > 0.5 && abs(encoded.a * 255.0 - own) > 0.5) {
    // The nearest back face is another shell's: this shell's own is in the farthest layer.
    hit = marchDepthTexture(glassBackFarDepth, position, inside, reach);
    if (hit.z < 0.75) return false;
    encoded = texelFetch(glassBackFarNormal, ivec2(hit.xy * resolution), 0);
    if (encoded.a < 0.5 / 255.0 || abs(encoded.a * 255.0 - own) > 0.5) return false;
  }
  vec3 outward = encoded.xyz * 2.0 - 1.0;
  exitPosition = position + inside * hit.w;
  direction = refract(inside, -normalize(outward), indexOfRefraction);
  if (dot(direction, direction) < 0.5) return false;
  direction = normalize(direction);
  return true;
}
`;

/** Overlapping non-nested closed glass draws in at most this many screen-resolved depth layers. */
export const MAX_GLASS_REFRACTION_LAYERS = 8;

/** Screen-space NDC rectangle `[left, right] x [bottom, top]` of a world-space shell AABB, or `{ visible: false }` if off-screen. */
export function projectedShellBounds(shell, viewProjection) {
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? shell.maximum[0] : shell.minimum[0];
    const y = corner & 2 ? shell.maximum[1] : shell.minimum[1];
    const z = corner & 4 ? shell.maximum[2] : shell.minimum[2];
    const clipW = viewProjection[3] * x + viewProjection[7] * y + viewProjection[11] * z + viewProjection[15];
    // A corner at or behind the near plane makes perspective division invalid, so treat the shell as covering the view.
    if (clipW <= 1e-4) return { left: -1, right: 1, bottom: -1, top: 1, visible: true };
    const ndcX = (viewProjection[0] * x + viewProjection[4] * y + viewProjection[8] * z + viewProjection[12]) / clipW;
    const ndcY = (viewProjection[1] * x + viewProjection[5] * y + viewProjection[9] * z + viewProjection[13]) / clipW;
    if (ndcX < left) left = ndcX;
    if (ndcX > right) right = ndcX;
    if (ndcY < bottom) bottom = ndcY;
    if (ndcY > top) top = ndcY;
  }
  return { left, right, bottom, top, visible: right > -1 && left < 1 && top > -1 && bottom < 1 };
}

/** True when two visible projected shell boxes overlap on screen. */
export function screenRectsOverlap(first, second) {
  return first.visible && second.visible && first.left < second.right && second.left < first.right && first.bottom < second.top && second.bottom < first.top;
}

/**
 * Splits overlapping, non-nested closed glass shells into back-to-front layers so each front shell can refract the resolved color
 * and depth of shells behind it. Returns null when the fast single-pass path already handles the frame (0/1 shells, no screen
 * overlap, nested shells handled by glassShellsNested, or more than SHELL_PAIR_LIMIT shells).
 */
export function planGlassRefractionLayers(shells, viewProjection, eye) {
  if (!Array.isArray(shells) || shells.length < 2 || shells.length > SHELL_PAIR_LIMIT || !viewProjection || !eye) return null;
  if (glassShellsNested(shells)) return null;
  const bounds = shells.map(shell => projectedShellBounds(shell, viewProjection));
  let anyOverlap = false;
  for (let first = 0; first < bounds.length && !anyOverlap; first++) {
    for (let second = first + 1; second < bounds.length; second++) {
      if (screenRectsOverlap(bounds[first], bounds[second])) {
        anyOverlap = true;
        break;
      }
    }
  }
  if (!anyOverlap) return null;
  const ordered = shells.map((shell, index) => {
    const centerX = (shell.minimum[0] + shell.maximum[0]) * 0.5 - eye[0];
    const centerY = (shell.minimum[1] + shell.maximum[1]) * 0.5 - eye[1];
    const centerZ = (shell.minimum[2] + shell.maximum[2]) * 0.5 - eye[2];
    return { shell, bound: bounds[index], index, distanceSquared: centerX * centerX + centerY * centerY + centerZ * centerZ };
  }).sort((first, second) => second.distanceSquared - first.distanceSquared || first.index - second.index);
  const layers = [];
  for (const entry of ordered) {
    let lastBlocking = -1;
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
      if (layers[layerIndex].some(placed => screenRectsOverlap(entry.bound, placed.bound))) {
        lastBlocking = layerIndex;
      }
    }
    const targetLayer = Math.min(lastBlocking + 1, MAX_GLASS_REFRACTION_LAYERS - 1);
    if (!layers[targetLayer]) layers[targetLayer] = [];
    layers[targetLayer].push(entry);
  }
  if (layers.length < 2) return null;
  return layers.map(layer => layer.map(entry => entry.shell));
}
