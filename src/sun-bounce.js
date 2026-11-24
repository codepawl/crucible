import { buildWorld, cosineDirection, hashUnit, radicalInverse, sceneScale } from './light-bake.js';
import { createTracer } from './ray-query.js';
import { CLOSED_ROOM_SHARE, partMatrixLookup } from './closed-room.js';
import { fittedClosedRoomShare } from './fitted-closed-room.js';
import { sampleShellSurfaces } from './sun-bounce-shell.js';
import { partDiffuseAlbedo } from './ground-bounce.js';
import { MAX_POINT_LIGHTS } from './light-limits.js';
import { requireFiniteInRange } from './modeling-limits.js';

// Light a sunlit patch sends on to the rest of a closed room. The patches are found once, when the scene is prepared: surfaces
// of the room are sampled, the samples the sun reaches (a shadow ray) and that sit inside the room (most of a short cosine ray
// fan hits something) are grouped into a few patches by position and facing, and each patch becomes a point light just above
// it. Its flux is the sun's irradiance times the lit area times the surface's albedo, per colour channel, spread over the
// half space the patch looks into. A wall near a patch then gets more of it than a wall across the room, and a red carpet
// bounces red. It adds no shader code and nothing to the core entry; the cost is one trace when the parts are prepared, and
// one more point light for each patch in every frame.

export const SUN_BOUNCE_PATCH_LIGHTS = 6;
export const SUN_BOUNCE_SAMPLES = 20_000;
// The first pass only finds which triangles an enclosed, lit sample lands on.
const COARSE_SAMPLES = 5000;
const ROOM_RAYS = 16;
// Share of the room rays that must hit something for a lit sample to count as inside the room (a roof's outer side hits nothing).
const ENCLOSED_SHARE = 0.75;
const CLUSTER_PASSES = 6;
// The light stands this many patch radii above its patch: close enough to light the patch's own surroundings, high enough not to
// brighten the patch itself much.
const LIFT_IN_RADII = 1;
// Fitted against Cycles on the reference halls (docs/lighting.md); environment.sunBounce multiplies it.
export const SUN_BOUNCE_GAIN = 0.3;
// The strength a scene gets when it sets no `environment.sunBounce`.
export const DEFAULT_SUN_BOUNCE = 1;
// The shell's lights are scaled per scene (`shellBounceScale`), within these bounds, so that a room's walls and ceiling get the
// light the sunlit patches' power bounces around it (#2771).
export const SUN_BOUNCE_SHELL_SCALE_RANGE = Object.freeze([0.25, 32]);
// A light is not counted as nearer to a point than this share of the room's depth, or a light beside a wall would decide the scale.
const SHELL_NEAREST_LIGHT_SHARE = 0.05;
// The mean cosine of the light that reaches a surface from a point light over a room's faces.
const SHELL_MEAN_COSINE = 0.5;
// A light closer than this share of the scene to a surface blows up as 1/d^2 into a hard speck, so a patch with less free space in front is left out.
const MINIMUM_LIFT_SHARE = 0.03;
const KEY_THRESHOLD = 1e-3;
// A light's intensity is capped at this, so a larger strength only blows the frame out.
const MAXIMUM_STRENGTH = 1e5;
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke']);

function isBounceSurface(part) {
  return !['blend', 'add'].includes(part.material?.alphaMode) && !((part.material?.emission ?? 0) > 0) && !EXCLUDED_TAGS.has(part.material?.tag);
}

function sunOf(environment) {
  const keyColor = environment.keyColor ?? [1, 1, 1];
  const keyIntensity = environment.keyIntensity ?? 1;
  const length = Math.hypot(...environment.lightDirection);
  return { irradiance: keyColor.map(channel => channel * keyIntensity), direction: environment.lightDirection.map(component => component / length) };
}

function hasSun(environment) {
  const keyColor = environment.keyColor ?? [1, 1, 1];
  return Boolean(environment.lightDirection) && (environment.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]) > KEY_THRESHOLD;
}

// Lit, enclosed samples of the room's surfaces (position, outward normal and the flux the sample reflects, per channel) and the
// tracer that found them. A coarse pass first finds the triangles an enclosed, lit sample lands on; the fine pass then spends
// its samples there, so a lawn outside a window does not take nearly all of them.
function sampleLitSurfaces(parts, sun) {
  const world = buildWorld(parts);
  const tracer = createTracer(world);
  const offset = sceneScale(world.positions) * 1e-4;
  const { positions, indices, triangleOwner } = world;
  const albedoOfPart = parts.map(part => partDiffuseAlbedo(part.material ?? {}));
  const triangleCount = indices.length / 3;
  const corner = (triangle, slot, axis) => positions[indices[triangle * 3 + slot] * 3 + axis];
  const normals = new Float32Array(triangleCount * 3);
  const areas = new Float32Array(triangleCount);
  const facesSun = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const edgeOne = [0, 1, 2].map(axis => corner(triangle, 1, axis) - corner(triangle, 0, axis));
    const edgeTwo = [0, 1, 2].map(axis => corner(triangle, 2, axis) - corner(triangle, 0, axis));
    const cross = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const length = Math.hypot(...cross);
    if (length < 1e-12) continue;
    areas[triangle] = length / 2;
    for (let axis = 0; axis < 3; axis++) normals[triangle * 3 + axis] = cross[axis] / length;
    const cosine = normals[triangle * 3] * sun.direction[0] + normals[triangle * 3 + 1] * sun.direction[1] + normals[triangle * 3 + 2] * sun.direction[2];
    if (cosine > 0 && isBounceSurface(parts[triangleOwner[triangle]])) facesSun[triangle] = 1;
  }
  const fan = [0, 0, 0];

  // About `count` samples over the triangles of `domain`, by area; only the lit ones inside the room are kept.
  function drawSamples(domain, count) {
    let domainArea = 0;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      if (domain[triangle]) domainArea += areas[triangle];
    }
    const samples = [];
    if (domainArea === 0) return samples;
    const sampleArea = domainArea / count;
    let carried = 0;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      if (!domain[triangle]) continue;
      const normal = [normals[triangle * 3], normals[triangle * 3 + 1], normals[triangle * 3 + 2]];
      const cosine = normal[0] * sun.direction[0] + normal[1] * sun.direction[1] + normal[2] * sun.direction[2];
      carried += areas[triangle] / sampleArea;
      for (let slot = 0; carried >= 1; slot++, carried -= 1) {
        let firstWeight = hashUnit(triangle, slot, 1);
        let secondWeight = hashUnit(triangle, slot, 2);
        if (firstWeight + secondWeight > 1) {
          firstWeight = 1 - firstWeight;
          secondWeight = 1 - secondWeight;
        }
        const point = [0, 1, 2].map(axis => corner(triangle, 0, axis) + firstWeight * (corner(triangle, 1, axis) - corner(triangle, 0, axis)) + secondWeight * (corner(triangle, 2, axis) - corner(triangle, 0, axis)));
        const origin = point.map((value, axis) => value + normal[axis] * offset);
        if (tracer.trace(origin[0], origin[1], origin[2], sun.direction[0], sun.direction[1], sun.direction[2], Infinity, true).nearestTriangle >= 0) continue;
        let blocked = 0;
        for (let ray = 0; ray < ROOM_RAYS; ray++) {
          cosineDirection(normal, (ray + 0.5) / ROOM_RAYS, radicalInverse(ray + 1), fan);
          if (tracer.trace(origin[0], origin[1], origin[2], fan[0], fan[1], fan[2], Infinity, true).nearestTriangle >= 0) blocked++;
        }
        if (blocked / ROOM_RAYS < ENCLOSED_SHARE) continue;
        const albedo = albedoOfPart[triangleOwner[triangle]];
        samples.push({ triangle, point, normal, flux: sun.irradiance.map((channel, index) => channel * cosine * sampleArea * albedo[index]) });
      }
    }
    return samples;
  }

  const roomTriangles = new Uint8Array(triangleCount);
  for (const sample of drawSamples(facesSun, COARSE_SAMPLES)) roomTriangles[sample.triangle] = 1;
  return { samples: drawSamples(roomTriangles, SUN_BOUNCE_SAMPLES), tracer };
}

function luminanceOf(flux) {
  return flux[0] + flux[1] + flux[2];
}

// Groups samples into `count` patches by position and facing (weighted by flux), starting from the farthest-apart heavy samples.
function clusterSamples(samples, count, scale) {
  const features = samples.map(sample => [...sample.point, ...sample.normal.map(component => component * scale)]);
  const distance = (first, second) => first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0);
  const centres = [features[samples.reduce((best, sample, index) => (luminanceOf(sample.flux) > luminanceOf(samples[best].flux) ? index : best), 0)]];
  const nearest = features.map(feature => distance(feature, centres[0]));
  while (centres.length < count) {
    let best = 0;
    for (let index = 1; index < samples.length; index++) {
      if (nearest[index] * luminanceOf(samples[index].flux) > nearest[best] * luminanceOf(samples[best].flux)) best = index;
    }
    if (nearest[best] === 0) break;
    centres.push(features[best]);
    features.forEach((feature, index) => { nearest[index] = Math.min(nearest[index], distance(feature, features[best])); });
  }
  const assignment = new Int32Array(samples.length);
  for (let pass = 0; pass < CLUSTER_PASSES; pass++) {
    const sums = centres.map(() => ({ weight: 0, total: new Array(6).fill(0) }));
    features.forEach((feature, index) => {
      let closest = 0;
      for (let centre = 1; centre < centres.length; centre++) {
        if (distance(feature, centres[centre]) < distance(feature, centres[closest])) closest = centre;
      }
      assignment[index] = closest;
      const weight = luminanceOf(samples[index].flux);
      sums[closest].weight += weight;
      feature.forEach((value, axis) => { sums[closest].total[axis] += value * weight; });
    });
    sums.forEach((sum, centre) => {
      if (sum.weight > 0) centres[centre] = sum.total.map(value => value / sum.weight);
    });
  }
  return centres.map((centre, index) => samples.filter((sample, sampleIndex) => assignment[sampleIndex] === index)).filter(group => group.length > 0);
}

// `freeDistanceOf(point, normal)` is how far the space in front of a patch is clear, from the triangles or from the room shell.
function lightOfPatch(group, strength, freeDistanceOf, sceneSize) {
  const flux = [0, 0, 0];
  const centre = [0, 0, 0];
  const facing = [0, 0, 0];
  let weight = 0;
  for (const sample of group) {
    const sampleWeight = luminanceOf(sample.flux);
    weight += sampleWeight;
    for (let axis = 0; axis < 3; axis++) {
      flux[axis] += sample.flux[axis];
      centre[axis] += sample.point[axis] * sampleWeight;
      facing[axis] += sample.normal[axis] * sampleWeight;
    }
  }
  const facingLength = Math.hypot(...facing) || 1;
  const normal = facing.map(component => component / facingLength);
  const middle = centre.map(component => component / weight);
  const radius = Math.sqrt(group.reduce((total, sample) => total + luminanceOf(sample.flux) * sample.point.reduce((sum, value, axis) => sum + (value - middle[axis]) ** 2, 0), 0) / weight);
  const freeDistance = freeDistanceOf(middle, normal);
  const minimumLift = sceneSize * MINIMUM_LIFT_SHARE;
  if (freeDistance / 2 < minimumLift) return null;
  const lift = Math.max(Math.min(radius * LIFT_IN_RADII, freeDistance / 2), minimumLift);
  // Spread over the half space in front of the patch: intensity = flux / (2 pi).
  const intensity = flux.map(channel => (strength * SUN_BOUNCE_GAIN * channel) / (2 * Math.PI));
  const peak = Math.max(...intensity, 1e-9);
  return { position: middle.map((value, axis) => value + normal[axis] * lift), color: intensity.map(channel => Math.min(channel / peak, 1)), intensity: Math.min(peak, 1e5), radius: lift };
}

// The empty-handed answers of findSunBounceLights, said in words (`report.reason`).
export const SUN_BOUNCE_REASONS = Object.freeze({
  'no strength': 'sunBounce is 0 or no lights were asked for',
  'no sun': 'the scene has no sun (a key light with a colour, an intensity and a direction)',
  'baked light': 'a part already carries a light map or an irradiance grid, and that baked light wins',
  'open scene': 'the scene is not a closed room, which is where sunlit patches bounce light on',
  'too many triangles': "the scene is past the light bake's triangle limit",
  'no lit surface': 'no surface of the room is both reached by the sun and inside the room',
});

function fewerThanAsked(report, reason, detail = SUN_BOUNCE_REASONS[reason]) {
  if (report) Object.assign(report, { reason, detail });
  return [];
}

// For the checks that stop a search: says why in `report` and returns null.
function leftOut(report, reason) {
  fewerThanAsked(report, reason);
  return null;
}

function spanOf(samples) {
  return Math.max(...[0, 1, 2].map(axis => Math.max(...samples.map(sample => sample.point[axis])) - Math.min(...samples.map(sample => sample.point[axis]))), 1e-3);
}

function lightsOfSamples(samples, { strength, maximumLights, freeDistanceOf }) {
  const sceneSize = spanOf(samples);
  return clusterSamples(samples, maximumLights, sceneSize).map(group => lightOfPatch(group, strength, freeDistanceOf, sceneSize)).filter(Boolean);
}

/**
 * The point lights that stand for the sunlit patches of a closed room: `[]` when the scene has no sun, is not a closed room,
 * is drawn with a bake or has no lit, enclosed surface. `strength` multiplies every light (`environment.sunBounce`).
 * `maximumLights` caps how many patches there are. A scene past the light bake's triangle limit gets no patches by default
 * (`largeScenes: 'skip'`); `largeScenes: 'proxy'` finds them on the room shell of its occupancy grid instead
 * (src/sun-bounce-shell.js), so the same scene gives the same lights whatever its mesh density (#2771). A `report` object,
 * when given, gets `reason` (a key of SUN_BOUNCE_REASONS) and `detail` for every answer without lights, and `method`
 * ('triangles' or 'shell') when it found some, so a caller can say why a scene stayed dark.
 */
export function findSunBounceLights(parts, environment, { strength = 1, maximumLights = SUN_BOUNCE_PATCH_LIGHTS, report = null, largeScenes = 'skip' } = {}) {
  if (largeScenes !== 'skip' && largeScenes !== 'proxy') throw new RangeError(`findSunBounceLights largeScenes must be 'skip' or 'proxy', got ${largeScenes}`);
  const room = roomLitBySun('findSunBounceLights', parts, environment, { strength, maximumLights, report });
  if (!room) return [];
  const { surfaces, sun } = room;
  let sampled;
  try {
    sampled = sampleLitSurfaces(surfaces, sun);
  } catch (error) {
    // Only a size limit is an expected miss; any other error is a bug and must surface.
    if (!(error instanceof RangeError)) throw error;
    if (largeScenes === 'skip') return fewerThanAsked(report, 'too many triangles', `${error.message} Pass largeScenes: 'proxy' to find the patches on the room shell instead.`);
    return lightsOfShell(surfaces, sun, { strength, maximumLights, report });
  }
  const { samples, tracer } = sampled;
  if (samples.length === 0) return fewerThanAsked(report, 'no lit surface');
  if (report) report.method = 'triangles';
  const probeOffset = spanOf(samples) * 1e-3;
  const freeDistanceOf = (point, normal) => probeOffset + tracer.trace(point[0] + normal[0] * probeOffset, point[1] + normal[1] * probeOffset, point[2] + normal[2] * probeOffset, normal[0], normal[1], normal[2], Infinity, false).nearestDistance;
  return lightsOfSamples(samples, { strength, maximumLights, freeDistanceOf });
}

// What the two ways of finding patches share: the scene must be a closed room a sun lights, drawn without a bake. Null (and `report` says why) when it is not.
function roomLitBySun(label, parts, environment, { strength, maximumLights, report }) {
  requireFiniteInRange(label, 'strength', strength, 0, MAXIMUM_STRENGTH);
  if (strength <= 0 || maximumLights <= 0) return leftOut(report, 'no strength');
  if (!hasSun(environment)) return leftOut(report, 'no sun');
  if (parts.some(part => part.material?.lightMap || part.material?.irradianceGrid)) return leftOut(report, 'baked light');
  const share = fittedClosedRoomShare(parts, partMatrixLookup(parts));
  if (share === null || share < CLOSED_ROOM_SHARE) return leftOut(report, 'open scene');
  return { surfaces: parts.filter(isBounceSurface), sun: sunOf(environment) };
}

/**
 * findSunBounceLights on the room shell of the occupancy grid, whatever the triangle count: the lights depend on the geometry
 * alone, so the same room gives the same lights at any mesh density (#2771). Same options and report.
 */
export function findSunBounceLightsOnShell(parts, environment, { strength = 1, maximumLights = SUN_BOUNCE_PATCH_LIGHTS, report = null } = {}) {
  const room = roomLitBySun('findSunBounceLightsOnShell', parts, environment, { strength, maximumLights, report });
  return room ? lightsOfShell(room.surfaces, room.sun, { strength, maximumLights, report }) : [];
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}

// Half of the room's bounced light comes from the patch lights, half from one light under the ceiling: a patch light stands low and
// near the sunlit patch, and the ceiling and the far walls would stay dark.
const PATCH_SHARE_OF_ROOM_LIGHT = 0.35;
const CEILING_LIGHT_HEIGHT_SHARE = 0.55;
const CEILING_LIGHT_RADIUS = 0.5;

/**
 * The irradiance the room's inside gets from the light its sunlit patches bounce. The power they reflect, `P` (the sum of their
 * flux), spreads over the inside, `A` (the area of the shell faces that pass the room test), and what it bounces on again
 * adds up to 1 / (1 - albedo): `P / (A (1 - albedo))`. Nothing in it is fitted to a scene.
 */
export function roomIrradiance(samples, interior) {
  const power = samples.reduce((total, sample) => total + (sample.flux[0] + sample.flux[1] + sample.flux[2]) / 3, 0);
  return interior.area > 0 ? power / (interior.area * (1 - Math.min(interior.meanAlbedo, 0.95))) : 0;
}

// The median over the points of the room's inside of the irradiance `lights` give (`sum(intensity / distance^2)` times the mean cosine).
function medianLightIrradiance(lights, interior) {
  const depth = spanOf(interior.points.map(point => ({ point })));
  const nearest = (depth * SHELL_NEAREST_LIGHT_SHARE) ** 2;
  const delivered = interior.points.map(point => lights.reduce((total, light) => total + (light.intensity * SHELL_MEAN_COSINE) / Math.max(nearest, light.position.reduce((sum, value, axis) => sum + (value - point[axis]) ** 2, 0)), 0));
  return median(delivered);
}

function ceilingLight(interior) {
  const heights = interior.points.map(point => point[1]);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  const count = interior.points.length;
  const middle = [0, 2].map(axis => interior.points.reduce((total, point) => total + point[axis], 0) / count);
  return { position: [middle[0], low + (high - low) * CEILING_LIGHT_HEIGHT_SHARE, middle[1]], color: [1, 1, 1], intensity: 1, radius: CEILING_LIGHT_RADIUS };
}

/**
 * The factor by which the patch lights are multiplied, and the ceiling light, so that together they deliver `roomIrradiance` at the
 * median point of the room's inside: `target / median irradiance of the lights`, within SUN_BOUNCE_SHELL_SCALE_RANGE. A room with
 * few lit patches or large walls gets less than one with many. Returns `{ scale, ceiling }`; the ceiling light is null when the room has no inside.
 */
export function shellBounceLights(patchLights, samples, interior) {
  const [minimum, maximum] = SUN_BOUNCE_SHELL_SCALE_RANGE;
  const target = roomIrradiance(samples, interior);
  if (patchLights.length === 0 || interior.points.length === 0 || !(target > 0)) return { scale: 1, ceiling: null };
  const given = medianLightIrradiance(patchLights, interior);
  const scale = given > 0 ? Math.min(maximum, Math.max(minimum, (PATCH_SHARE_OF_ROOM_LIGHT * target) / given)) : 1;
  const unit = ceilingLight(interior);
  const unitGiven = medianLightIrradiance([unit], interior);
  const ceilingIntensity = unitGiven > 0 ? Math.min(1e5, ((1 - PATCH_SHARE_OF_ROOM_LIGHT) * target) / unitGiven) : 0;
  return { scale, ceiling: { ...unit, intensity: ceilingIntensity } };
}

function lightsOfShell(surfaces, sun, { strength, maximumLights, report }) {
  const { samples, freeDistanceOf, interior } = sampleShellSurfaces(surfaces, sun, { roomRays: ROOM_RAYS, enclosedShare: ENCLOSED_SHARE });
  if (samples.length === 0) return fewerThanAsked(report, 'no lit surface');
  const patches = lightsOfSamples(samples, { strength, maximumLights: Math.max(1, maximumLights - 1), freeDistanceOf });
  const { scale, ceiling } = shellBounceLights(patches, samples, interior);
  if (report) Object.assign(report, { method: 'shell', shellScale: scale });
  const lights = patches.map(light => scaledLight(light, scale));
  return ceiling && ceiling.intensity > 0 && maximumLights > 1 ? [...lights, scaledLight(ceiling, strength)] : lights;
}

const lightsOfParts = new WeakMap();

/**
 * The environment with the sunlit patches' lights added to its point lights. `environment.sunBounce` (default 1) scales
 * them; 0 returns the environment itself. The patches are found once for these parts and this sun and kept.
 * `largeScenes: 'proxy'` finds them on the room shell for a scene past the bake's triangle limit (see findSunBounceLights).
 * A `report` object gets what findSunBounceLights reports, or `reason` 'no strength' / 'no sun' when nothing was looked for.
 */
export function withSunBounce(parts, environment, { largeScenes = 'skip', report = null } = {}) {
  const strength = requireFiniteInRange('withSunBounce', 'environment.sunBounce', environment.sunBounce ?? DEFAULT_SUN_BOUNCE, 0, MAXIMUM_STRENGTH);
  if (strength <= 0 || !hasSun(environment)) {
    if (report) Object.assign(report, strength <= 0 ? { reason: 'no strength', detail: SUN_BOUNCE_REASONS['no strength'] } : { reason: 'no sun', detail: SUN_BOUNCE_REASONS['no sun'] });
    return environment;
  }
  const existing = environment.pointLights ?? [];
  const room = Math.min(SUN_BOUNCE_PATCH_LIGHTS, MAX_POINT_LIGHTS - existing.length);
  const key = JSON.stringify([parts.length, environment.keyColor, environment.keyIntensity, environment.lightDirection, room, largeScenes]);
  let remembered = lightsOfParts.get(parts);
  if (remembered?.key !== key) {
    const found = {};
    remembered = { key, found, lights: findSunBounceLights(parts, environment, { strength: 1, maximumLights: room, report: found, largeScenes }), scaled: new Map() };
    if (found.reason === 'too many triangles' || found.reason === 'no lit surface') console.warn(`Sun bounce left out: ${found.detail}`);
    lightsOfParts.set(parts, remembered);
  }
  if (report) Object.assign(report, remembered.found);
  if (remembered.lights.length === 0) return environment;
  if (!remembered.scaled.has(strength)) {
    remembered.scaled.set(strength, remembered.lights.map(light => scaledLight(light, strength)));
  }
  return { ...environment, pointLights: [...existing, ...remembered.scaled.get(strength)] };
}

function scaledLight(light, strength) {
  const peak = light.intensity * strength;
  return { ...light, intensity: Math.min(peak, 1e5) };
}
