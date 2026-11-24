// Screen-space march of a refracted ray against the opaque scene's depth. Glass refracts the picture behind it, but a picture has no
// distance: to know which surface the bent ray reaches, the liquid pass marches the ray through the depth buffer of the opaque pass,
// finds the first step that lies behind the stored surface, narrows it with a binary search and reads the colour at that pixel.
// A ray that leaves the screen, or never goes behind anything (the sky), misses; the shader then reads the scene at the last point of the
// ray that is still on the screen: the sky it ends in, or the picture's edge. Only a ray that never reaches the screen at all falls back
// to a short fixed reach along it (SCENE_REACH_PER_THICKNESS in glass-ball-lens.js).
// The GLSL below follows the JavaScript reference line by line, so a test of the reference covers the shader.

/** The march samples this many points along the ray, spaced closer together near its start. */
export const MARCH_STEPS = 32;
/** After the first point behind a surface is found, the gap to the point before it is halved this many times. */
export const REFINE_STEPS = 6;
/** The ray is followed this many thicknesses of the glass body from where it leaves the glass (a thickness of 0 is never marched). */
export const MARCH_REACH_PER_THICKNESS = 16;

/** The distance along the ray of march point `step` (0 to stepCount): the steps grow with the square, so a nearby backdrop is sampled finely. */
export function marchDistance(step, stepCount, maximumDistance) {
  const fraction = step / stepCount;
  return maximumDistance * fraction * fraction;
}

/** Whether a ray point with this buffer depth lies behind a stored surface. A reversed buffer holds 1 at the near plane and 0 far away. */
export function isBehindSurface(rayDepth, storedDepth, reversed) {
  return reversed ? rayDepth < storedDepth : rayDepth > storedDepth;
}

/**
 * The scale and bias that turn a clip-space z / w into the value the depth buffer stores: a reversed buffer keeps 0..1 as is,
 * the standard one maps -1..1 to 0..1.
 */
export function depthMapping(reversed) {
  return reversed ? { scale: 1, bias: 0 } : { scale: 0.5, bias: 0.5 };
}

function pointAlong(origin, direction, distance) {
  return [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance];
}

/**
 * Marches a ray through a depth buffer.
 * `project(point)` returns { x, y, depth } (screen position 0..1, buffer depth) or null behind the camera; `sceneDepth(x, y)` returns the
 * stored depth at a screen position. Returns { hit: true, distance, x, y } at the first surface the ray goes behind. A miss returns
 * { hit: false, x, y } at the last point of the ray that was on the screen (null when not even the first step is on the screen).
 */
export function marchSceneDepth({ origin, direction, maximumDistance, project, sceneDepth, reversed, steps = MARCH_STEPS, refineSteps = REFINE_STEPS }) {
  const probe = distance => {
    const projected = project(pointAlong(origin, direction, distance));
    if (!projected || projected.x < 0 || projected.x > 1 || projected.y < 0 || projected.y > 1) return null;
    return { x: projected.x, y: projected.y, behind: isBehindSurface(projected.depth, sceneDepth(projected.x, projected.y), reversed) };
  };
  let previousDistance = 0;
  let lastOnScreen = null;
  for (let step = 1; step <= steps; step++) {
    const distance = marchDistance(step, steps, maximumDistance);
    const current = probe(distance);
    if (!current) return lastOnScreen;
    if (current.behind) {
      let nearDistance = previousDistance;
      let farDistance = distance;
      let hit = current;
      for (let refine = 0; refine < refineSteps; refine++) {
        const middleDistance = (nearDistance + farDistance) * 0.5;
        const middle = probe(middleDistance);
        if (middle?.behind) {
          farDistance = middleDistance;
          hit = middle;
        } else {
          nearDistance = middleDistance;
        }
      }
      return { hit: true, distance: farDistance, x: hit.x, y: hit.y };
    }
    previousDistance = distance;
    lastOnScreen = { hit: false, x: current.x, y: current.y };
  }
  return lastOnScreen;
}

/**
 * Where on the screen the shader reads the opaque colour for a glass fragment: the marched hit; on a miss, the last point of the ray still
 * on the screen; when not even the first step is on the screen, the point `fallbackReach` metres along the ray (null when that point
 * is behind the camera, where the shader keeps the fragment's own position).
 */
export function refractedScreenPosition({ origin, direction, maximumDistance, fallbackReach, project, sceneDepth, reversed }) {
  const hit = marchSceneDepth({ origin, direction, maximumDistance, project, sceneDepth, reversed });
  if (hit) return { x: hit.x, y: hit.y, marched: hit.hit };
  const fallback = project(pointAlong(origin, direction, fallbackReach));
  return fallback ? { x: fallback.x, y: fallback.y, marched: false } : null;
}

// Returns the screen position of the hit (xy) and 1 in z; on a miss the last on-screen position and 0.5 in z; z = 0 when not even the
// first step is on the screen. `sceneDepth` holds the opaque pass's depth, in the buffer's own convention: depthMapping.z is 1 for a
// reversed buffer.
export const glassDepthMarchGlsl = `
const int MARCH_STEPS = ${MARCH_STEPS};
const int REFINE_STEPS = ${REFINE_STEPS};
const float MARCH_REACH_PER_THICKNESS = ${MARCH_REACH_PER_THICKNESS.toFixed(1)};

// Fills the screen position and buffer depth of a world point; false behind the camera or off the screen.
bool marchProject(vec3 point, out vec2 screenPosition, out float bufferDepth) {
  vec4 clip = viewProjection * vec4(point, 1.0);
  if (clip.w <= 0.0) return false;
  vec3 ndc = clip.xyz / clip.w;
  screenPosition = ndc.xy * 0.5 + 0.5;
  bufferDepth = ndc.z * depthMapping.x + depthMapping.y;
  return screenPosition.x >= 0.0 && screenPosition.x <= 1.0 && screenPosition.y >= 0.0 && screenPosition.y <= 1.0;
}

bool marchIsBehind(highp sampler2D depthTexture, vec3 point, out vec2 screenPosition, out bool onScreen) {
  float bufferDepth;
  onScreen = marchProject(point, screenPosition, bufferDepth);
  if (!onScreen) return false;
  float stored = texelFetch(depthTexture, ivec2(screenPosition * resolution), 0).r;
  return depthMapping.z > 0.5 ? bufferDepth < stored : bufferDepth > stored;
}

// Marches against any depth texture in the buffer's convention. Returns (hit position xy, 1 for a hit or 0.5 for a miss, the distance of the
// hit along the ray); z = 0 when not even the first step is on the screen.
vec4 marchDepthTexture(highp sampler2D depthTexture, vec3 origin, vec3 direction, float maximumDistance) {
  float previousDistance = 0.0;
  vec4 lastOnScreen = vec4(0.0);
  for (int stepIndex = 1; stepIndex <= MARCH_STEPS; stepIndex++) {
    float fraction = float(stepIndex) / float(MARCH_STEPS);
    float rayDistance = maximumDistance * fraction * fraction;
    vec2 position;
    bool onScreen;
    bool behind = marchIsBehind(depthTexture, origin + direction * rayDistance, position, onScreen);
    if (!onScreen) return lastOnScreen;
    if (behind) {
      float nearDistance = previousDistance;
      float farDistance = rayDistance;
      vec2 hit = position;
      for (int refine = 0; refine < REFINE_STEPS; refine++) {
        float middleDistance = (nearDistance + farDistance) * 0.5;
        vec2 middle;
        bool middleOnScreen;
        if (marchIsBehind(depthTexture, origin + direction * middleDistance, middle, middleOnScreen)) {
          farDistance = middleDistance;
          hit = middle;
        } else {
          nearDistance = middleDistance;
        }
      }
      return vec4(hit, 1.0, farDistance);
    }
    previousDistance = rayDistance;
    lastOnScreen = vec4(position, 0.5, rayDistance);
  }
  return lastOnScreen;
}

vec3 marchSceneDepth(vec3 origin, vec3 direction, float maximumDistance) {
  return marchDepthTexture(sceneDepth, origin, direction, maximumDistance).xyz;
}
`;
