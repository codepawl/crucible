import { mat4 } from 'gl-matrix';
import { requireFiniteInRange } from './modeling-limits.js';

// Far beyond any scene, and small enough that squaring it stays finite.
const MAXIMUM_COORDINATE = 1e100;
const DEFAULT_SUN_DIRECTION = [-3, 6, 4];
const SHADOW_VIEWS = {
  world: { distance: 75, target: [0, 2, -10], extent: 65, near: 1, far: 220 },
  studio: { distance: 7.2, target: [0, 1, 0], extent: 3.5, near: 0.1, far: 15 },
};

// The fitted view covers the casters' bounding sphere with this much room to spare.
const FIT_PADDING = 1.1;
// The extent snaps up to a quarter octave and the target to an eighth of the extent, so a part that moves a little
// keeps the same shadow view instead of making its shadow edges crawl.
const EXTENT_STEPS_PER_OCTAVE = 4;
const TARGET_STEPS_PER_EXTENT = 8;

/**
 * The world shadow view fitted to `bounds` (`{ minimum, maximum }` of the shadow casters), or null when the fixed
 * world view is already as tight: the depth bias grows with the view, and the 130 m world view's bias (about 22 cm)
 * let the sun through walls thinner than that (issue #1695). A scene as large as the fixed view keeps it unchanged.
 * The far plane reaches well past the casters so a low sun still finds the ground their shadows fall on.
 */
export function fitWorldShadowView(bounds) {
  if (!bounds) return null;
  const size = bounds.maximum.map((value, axis) => value - bounds.minimum[axis]);
  const radius = Math.hypot(size[0], size[1], size[2]) / 2;
  if (!(radius > 0)) return null;
  const extent = 2 ** (Math.ceil(Math.log2(radius * FIT_PADDING) * EXTENT_STEPS_PER_OCTAVE) / EXTENT_STEPS_PER_OCTAVE);
  if (extent >= SHADOW_VIEWS.world.extent) return null;
  const step = extent / TARGET_STEPS_PER_EXTENT;
  const target = bounds.maximum.map((value, axis) => Math.round((value + bounds.minimum[axis]) / 2 / step) * step);
  return { distance: extent * 2.4, target, extent, near: extent * 0.2, far: extent * 64 };
}

/**
 * The sun's shadow view for whatever `shadowBounds` leaves out. The eye sits on the sun's side of the target, so
 * shadows fall the way the shading says the light travels. A `shadowBounds.eye` still wins. `fittedView`, from
 * fitWorldShadowView, replaces the fixed world view.
 */
export function resolveShadowLight(world, lightDirection, shadowBounds = {}, fittedView = null) {
  const { distance, ...view } = fittedView ?? SHADOW_VIEWS[world ? 'world' : 'studio'];
  const target = shadowBounds.target ?? view.target;
  if (lightDirection != null) {
    requireFiniteInRange('resolveShadowLight', 'lightDirection', Array.from(lightDirection), -MAXIMUM_COORDINATE, MAXIMUM_COORDINATE);
  }
  const requested = lightDirection ?? DEFAULT_SUN_DIRECTION;
  const direction = Math.hypot(requested[0], requested[1], requested[2]) > 1e-6 ? requested : DEFAULT_SUN_DIRECTION;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const eye = target.map((value, axis) => value + (direction[axis] / length) * distance);
  return { ...view, eye, ...shadowBounds, target };
}

// How far the 9 tap filter (taps 2.5 texels apart, plus the bilinear blend) reaches from its centre, in shadow texels.
const FILTER_REACH_TEXELS = 3.5;
// A hard shadow (`light.hard`) reads one texel, and the other readers of the bias (the tint map, subsurface thickness) blend 2 by 2.
const HARD_REACH_TEXELS = 2;

/**
 * The depth bias the sun shadow needs per unit of slope (tan of the angle between the surface normal and the sun), in
 * the shadow map's 0 to 1 depth. It is the world distance the depth changes across the filter on a 45 degree slope,
 * `extent * 2 / mapSize * FILTER_REACH_TEXELS`, divided by `far - near`, so the same scene gives the same bias in metres
 * for any depth range. `light` is the result of `resolveShadowLight`.
 */
/** Writes the sun shadow map's world-to-clip matrix for a resolved light (from resolveShadowLight) into `out`: the orthographic box the shadow pass draws. */
export function writeShadowLightMatrix(out, light) {
  const lightView = mat4.lookAt(mat4.create(), light.eye, light.target, light.up ?? [0, 1, 0]);
  mat4.ortho(out, -light.extent, light.extent, -light.extent, light.extent, light.near, light.far);
  return mat4.multiply(out, out, lightView);
}

export function shadowBiasPerSlope(light, mapSize) {
  requireFiniteInRange('shadowBiasPerSlope', 'mapSize and light.extent', [mapSize, light.extent], Number.MIN_VALUE, MAXIMUM_COORDINATE);
  requireFiniteInRange('shadowBiasPerSlope', 'light.far - light.near', light.far - light.near, Number.MIN_VALUE, MAXIMUM_COORDINATE);
  const texelWorldSize = (light.extent * 2) / mapSize;
  return (texelWorldSize * (light.hard ? HARD_REACH_TEXELS : FILTER_REACH_TEXELS)) / (light.far - light.near);
}

const DEFAULT_SHADOW_MAP_SIZE = 2048;
const LARGE_SHADOW_MAP_SIZE = 4096;
const LARGE_SHADOW_EXTENT = 1000;

/** The side of the sun's depth map in texels: a view that covers more than a kilometre either side gets the larger map. */
export function sunShadowMapSize(extent) {
  return extent > LARGE_SHADOW_EXTENT ? LARGE_SHADOW_MAP_SIZE : DEFAULT_SHADOW_MAP_SIZE;
}
