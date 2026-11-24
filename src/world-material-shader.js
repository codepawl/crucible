import { resolveWaterMaterial } from './water-presets.js';
import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';
import { causticsDeclarations, resolveWaterCaustics, waterCausticsUniform } from './water-caustics.js';

// Water bodies. A material with the water tag can carry `absorption` (RGB per metre: how fast each colour fades going down) and
// `turbidity` (0 clear to 1 murky: how much light the water scatters into shadows). The largest flat water part of a scene sets
// the water level. Every surface below it is dimmed by Beer-Lambert absorption of the column above it, and its shadows are lifted
// by in-scatter and widened with depth times turbidity (worldVisibility below). Absorption folds the way down and the way back up
// into one coefficient, so a bed `depth` metres down keeps exp(-absorption * depth) of its light.
export { WATER_PRESETS, WATER_DEFAULT_PRESET, WATER_MAXIMUM_ABSORPTION, resolveWaterMaterial } from './water-presets.js';
// A water part counts as one level when it is this flat: thickness against its wider side.
const WATER_MAXIMUM_THICKNESS_RATIO = 0.02;

/** Copies a recipe material's water fields: a water material always carries the resolved absorption, turbidity and preset. */
export function copyWaterFields(value, result, toVector) {
  const given = ['waterPreset', 'absorption', 'turbidity', 'foamEdge', 'foamWidth', 'foamColor', 'foamVeins', 'contactFoam', 'caustics', 'ripples'].filter(field => value[field] !== undefined);
  if (result.tag !== 'water') {
    if (given.length > 0) {
      throw new RangeError(`${given.join(', ')} need the water tag.`);
    }
    return;
  }
  const absorption = value.absorption === undefined ? undefined : toVector(value.absorption, 3, 'absorption');
  Object.assign(result, resolveWaterMaterial({ ...value, absorption }), resolveWaterFoamStyle(value), resolveContactFoam(value, result));
  const caustics = resolveWaterCaustics(value.caustics);
  if (caustics) {
    result.caustics = caustics;
  }
  if (value.ripples !== undefined) {
    result.ripples = resolveWaterRipples(value.ripples);
  }
}

export const WATER_RIPPLE_RANGES = Object.freeze({ strength: [0, 1], speed: [0, 2], windDirection: [-360, 360] });
export const WATER_RIPPLE_DEFAULTS = Object.freeze({ strength: 1, speed: 1 });

/**
 * The detail ripples of a water material, the 0.15 to 3 m wind ripples that break the surface and the sun glint into facets.
 * `strength` 0 to 1 (1 default) scales their height, `speed` 0 to 2 (1 default) scales how fast they travel, and `windDirection` (degrees,
 * as the `ocean` edit's `direction`; unset by default) runs them downwind within about 40 degrees of that direction instead of in all
 * directions. With nothing given the ripples are the ones every water material has always had. A calm, wind-aligned sea does not boil
 * in a film at 24 fps, where fast ripples cross a pixel in a frame.
 */
export function resolveWaterRipples(ripples) {
  if (ripples === null || typeof ripples !== 'object' || Array.isArray(ripples)) {
    throw new TypeError('ripples must be an object such as { "strength": 0.3, "speed": 0.6, "windDirection": 0 }.');
  }
  const unknown = Object.keys(ripples).filter(key => !(key in WATER_RIPPLE_RANGES));
  if (unknown.length > 0) {
    throw new TypeError(`ripples has no field ${unknown.join(', ')}; pass strength, speed or windDirection.`);
  }
  const resolved = { ...WATER_RIPPLE_DEFAULTS, ...ripples };
  for (const [field, [minimum, maximum]] of Object.entries(WATER_RIPPLE_RANGES)) {
    const value = resolved[field];
    if (value === undefined && field === 'windDirection') {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`ripples.${field} must be a number from ${minimum} to ${maximum}, such as ${WATER_RIPPLE_DEFAULTS[field] ?? 0}.`);
    }
  }
  return Object.freeze(resolved);
}

/** The `waterRipples` uniform: strength, speed, 1 when the ripples follow the wind, and the direction they travel in radians. No `ripples` sends the defaults, which is the unchanged look. */
export function waterRipplesUniform(ripples) {
  const strength = ripples?.strength ?? WATER_RIPPLE_DEFAULTS.strength;
  const speed = ripples?.speed ?? WATER_RIPPLE_DEFAULTS.speed;
  if (ripples?.windDirection === undefined) {
    return [strength, speed, 0, 0];
  }
  return [strength, speed, 1, ripples.windDirection * Math.PI / 180];
}

export const WATER_FOAM_EDGES = Object.freeze(['soft', 'hard']);
export const WATER_FOAM_WIDTH_RANGE = Object.freeze([0.25, 4]);
export const WATER_FOAM_VEIN_RANGES = Object.freeze({ amount: [0, 1], scale: [0.25, 4] });
export const WATER_FOAM_VEIN_DEFAULTS = Object.freeze({ amount: 0.6, scale: 1 });

/**
 * The foam veins of a water material: a net of thin foam lines that spreads from a crest and fades away from it. They are sampled on the
 * world position with the same step in every direction, so a cell is as long as it is wide. `amount` 0 (off) to 1 (default 0.6 once
 * `foamVeins` is given) and `scale` 0.25 to 4 (1 default, larger cells are finer). An `amount` of 0 draws nothing.
 */
export function resolveWaterFoamVeins(foamVeins) {
  if (foamVeins === null || typeof foamVeins !== 'object' || Array.isArray(foamVeins)) {
    throw new TypeError('foamVeins must be an object such as { "amount": 0.6, "scale": 1 }.');
  }
  const unknown = Object.keys(foamVeins).filter(key => !(key in WATER_FOAM_VEIN_DEFAULTS));
  if (unknown.length > 0) {
    throw new TypeError(`foamVeins has no field ${unknown.join(', ')}; pass amount or scale.`);
  }
  const resolved = { ...WATER_FOAM_VEIN_DEFAULTS, ...foamVeins };
  for (const [field, [minimum, maximum]] of Object.entries(WATER_FOAM_VEIN_RANGES)) {
    const value = resolved[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`foamVeins.${field} must be a number from ${minimum} to ${maximum}, such as ${WATER_FOAM_VEIN_DEFAULTS[field]}.`);
    }
  }
  return Object.freeze(resolved);
}

/** The foam style fields of a water material: `foamEdge` soft (default, lace) or hard (painted shape), `foamWidth` 0.25 to 4 (default 1) scales how far foam spreads from the crest, `foamColor` three linear numbers from 0 to 1 (default white) tints the foam. Unset fields stay unset. */
export function resolveWaterFoamStyle({ foamEdge, foamWidth, foamColor, foamVeins }) {
  const style = {};
  if (foamEdge !== undefined) {
    if (!WATER_FOAM_EDGES.includes(foamEdge)) {
      throw new RangeError(`foamEdge must be one of ${WATER_FOAM_EDGES.join(', ')}, such as hard.`);
    }
    style.foamEdge = foamEdge;
  }
  if (foamWidth !== undefined) {
    const [minimum, maximum] = WATER_FOAM_WIDTH_RANGE;
    if (!Number.isFinite(foamWidth) || foamWidth < minimum || foamWidth > maximum) {
      throw new RangeError(`foamWidth must be a number from ${minimum} to ${maximum}, such as 1.`);
    }
    style.foamWidth = foamWidth;
  }
  if (foamColor !== undefined) {
    if (!Array.isArray(foamColor) || foamColor.length !== 3 || foamColor.some(component => typeof component !== 'number' || !(component >= 0 && component <= 1))) {
      throw new RangeError('foamColor must be three numbers from 0 to 1, such as [0.8, 0.95, 1].');
    }
    style.foamColor = Object.freeze([...foamColor]);
  }
  if (foamVeins !== undefined) {
    style.foamVeins = resolveWaterFoamVeins(foamVeins);
  }
  return style;
}

export const WATER_FOAM_COLOR_DEFAULT = Object.freeze([1, 1, 1]);
export const CONTACT_FOAM_RANGES = Object.freeze({ width: [1, 64], hardness: [0, 1], noise: [0, 1], drift: [0, 1] });
export const CONTACT_FOAM_DEFAULTS = Object.freeze({ width: 6, hardness: 1, noise: 0.3, drift: 0, rim: true, color: Object.freeze([0.92, 0.95, 0.97]) });

/**
 * The contact foam of a water material: a line where the water meets another surface, from the gap between the water and what lies
 * behind it. `width` is the line's width in screen pixels (1 to 64, 6 default), `hardness` 0 (soft edge) to 1 (a one pixel edge),
 * `noise` 0 to 1 (how much the edge breaks up, 0.3 default), `drift` 0 to 1 (0 default, a static rim; above 0 the rim tears into segments that slide with time), `rim` (true default; false draws no contact line at all) and `color` three numbers from 0 to 1. Only water blended with alphaMode "blend" reads what lies behind it, at any opacity.
 */
export function resolveContactFoam({ contactFoam }, { alphaMode }) {
  if (contactFoam === undefined) {
    return {};
  }
  if (contactFoam === null || typeof contactFoam !== 'object' || Array.isArray(contactFoam)) {
    throw new TypeError('contactFoam must be an object such as { "width": 6, "hardness": 1, "noise": 0.3 }.');
  }
  const unknown = Object.keys(contactFoam).filter(key => !(key in CONTACT_FOAM_DEFAULTS));
  if (unknown.length > 0) {
    throw new TypeError(`contactFoam has no field ${unknown.join(', ')}; pass width, hardness, noise, drift, rim or color.`);
  }
  if (alphaMode !== 'blend') {
    throw new RangeError('contactFoam needs blended water that reads what lies behind it; pass alphaMode "blend".');
  }
  const resolved = { ...CONTACT_FOAM_DEFAULTS, ...contactFoam };
  for (const [field, [minimum, maximum]] of Object.entries(CONTACT_FOAM_RANGES)) {
    const value = resolved[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`contactFoam.${field} must be a number from ${minimum} to ${maximum}, such as ${CONTACT_FOAM_DEFAULTS[field]}.`);
    }
  }
  if (typeof resolved.rim !== 'boolean') {
    throw new TypeError('contactFoam.rim must be true or false, such as true; false draws no contact line.');
  }
  const { color } = resolved;
  if (!Array.isArray(color) || color.length !== 3 || color.some(component => typeof component !== 'number' || !(component >= 0 && component <= 1))) {
    throw new RangeError('contactFoam.color must be three numbers from 0 to 1, such as [0.92, 0.95, 0.97].');
  }
  return { contactFoam: Object.freeze({ ...resolved, color: Object.freeze([...color]) }) };
}

export const WATER_RAMP_COLOR_COUNT = Object.freeze([3, 5]);
const WATER_RAMP_DRIVERS = Object.freeze(['height', 'facing', 'sun']);
const WATER_RAMP_FIELDS = Object.freeze(['colors', 'drivers', 'heightRange', 'steps', 'crestTint']);
const WATER_RAMP_STEPS = Object.freeze(['hard', 'soft']);
const WATER_RAMP_DEFAULT_HEIGHT_RANGE = Object.freeze([-1, 1]);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function srgbByteToLinear(byte) {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** A ramp colour: three linear numbers (0 to 16) whose sRGB encoding is the colour shown, or a `#rrggbb` hex shown as that hex. */
function rampColor(value, name, toVector) {
  if (typeof value === 'string' && HEX_COLOR.test(value)) {
    return Object.freeze([1, 3, 5].map(offset => srgbByteToLinear(Number.parseInt(value.slice(offset, offset + 2), 16))));
  }
  const color = toVector(value, 3, name);
  if (color.some(component => !Number.isFinite(component) || component < 0 || component > 16)) {
    throw new RangeError(`${name} must be three numbers from 0 to 16, such as [0.1, 0.5, 0.6].`);
  }
  return Object.freeze([...color]);
}

function rampDrivers(drivers) {
  const given = drivers ?? { height: 1 };
  const unknown = Object.keys(given).filter(name => !WATER_RAMP_DRIVERS.includes(name));
  if (unknown.length > 0) {
    throw new RangeError(`waterRamp.drivers has no ${unknown.join(', ')}; pass weights for ${WATER_RAMP_DRIVERS.join(', ')}, such as { "height": 1, "sun": 0.5 }.`);
  }
  const weights = WATER_RAMP_DRIVERS.map(name => given[name] ?? 0);
  if (weights.some(weight => !Number.isFinite(weight) || weight < 0 || weight > 1) || weights.every(weight => weight === 0)) {
    throw new RangeError('waterRamp.drivers weights must be numbers from 0 to 1 with at least one above 0, such as { "height": 1, "sun": 0.5 }.');
  }
  return Object.freeze(Object.fromEntries(WATER_RAMP_DRIVERS.map((name, index) => [name, weights[index]])));
}

/**
 * The stylized colour ramp of a water material. `colors` (3 to 5, deep to bright) are picked by a weighted mix of drivers: `height`
 * (world y across `heightRange`, default -1 to 1), `facing` (grazing view, 1 at the horizon) and `sun` (how squarely the wave face meets
 * the sun). `steps` hard (default) keeps flat tones, soft blends them. `crestTint` { color, strength 0-1 } colours the folded crests.
 */
export function resolveWaterRamp(ramp, toVector) {
  if (typeof ramp !== 'object' || ramp === null || Array.isArray(ramp)) {
    throw new RangeError('waterRamp must be an object such as { "colors": [[0.02, 0.2, 0.3], [0.1, 0.6, 0.7], [0.5, 0.95, 0.95]] }.');
  }
  const unknown = Object.keys(ramp).filter(name => !WATER_RAMP_FIELDS.includes(name));
  if (unknown.length > 0) {
    throw new RangeError(`waterRamp has no ${unknown.join(', ')}; use ${WATER_RAMP_FIELDS.join(', ')}.`);
  }
  const [minimumColors, maximumColors] = WATER_RAMP_COLOR_COUNT;
  if (!Array.isArray(ramp.colors) || ramp.colors.length < minimumColors || ramp.colors.length > maximumColors) {
    throw new RangeError(`waterRamp.colors must list ${minimumColors} to ${maximumColors} colours from deep to bright, such as [[0.02, 0.2, 0.3], [0.1, 0.6, 0.7], [0.5, 0.95, 0.95]].`);
  }
  const steps = ramp.steps ?? 'hard';
  if (!WATER_RAMP_STEPS.includes(steps)) {
    throw new RangeError(`waterRamp.steps must be one of ${WATER_RAMP_STEPS.join(', ')}, such as hard.`);
  }
  const heightRange = ramp.heightRange ?? WATER_RAMP_DEFAULT_HEIGHT_RANGE;
  if (!Array.isArray(heightRange) || heightRange.length !== 2 || !heightRange.every(Number.isFinite) || heightRange[0] >= heightRange[1]) {
    throw new RangeError('waterRamp.heightRange must be [low, high] world heights with low below high, such as [-1, 1].');
  }
  const resolved = { colors: Object.freeze(ramp.colors.map((color, index) => rampColor(color, `waterRamp.colors[${index}]`, toVector))), drivers: rampDrivers(ramp.drivers), heightRange: Object.freeze([...heightRange]), steps };
  if (ramp.crestTint !== undefined) {
    const { color, strength = 1, ...extra } = ramp.crestTint ?? {};
    if (color === undefined || Object.keys(extra).length > 0 || !Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError('waterRamp.crestTint must be { "color": [r, g, b], "strength": 0 to 1 }, such as { "color": [0.7, 1, 0.9], "strength": 0.8 }.');
    }
    resolved.crestTint = Object.freeze({ color: rampColor(color, 'waterRamp.crestTint.color', toVector), strength });
  }
  return Object.freeze(resolved);
}

/** Copies a recipe material's `waterRamp`: it needs the water tag. */
export function copyWaterRamp(value, result, toVector) {
  if (value.waterRamp === undefined) {
    return;
  }
  if (result.tag !== 'water') {
    throw new RangeError('waterRamp needs the water tag.');
  }
  result.waterRamp = resolveWaterRamp(value.waterRamp, toVector);
}

function partBounds(part) {
  const { positions } = part.geometry;
  const { matrix } = part;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { minimum, maximum };
}

const boundsCache = new WeakMap();

// A part's bounds are read again only when its matrix changed.
function cachedBounds(part) {
  const cached = boundsCache.get(part);
  if (cached && cached.matrix.every((value, index) => value === part.matrix[index])) {
    return cached.bounds;
  }
  const bounds = partBounds(part);
  boundsCache.set(part, { matrix: Float32Array.from(part.matrix), bounds });
  return bounds;
}

// How many flat water parts the shader tints beneath, each inside its own horizontal footprint.
export const WATER_VOLUME_LIMIT = 8;

let warnedDroppedVolumeCount = 0;

// findWaterBody runs every frame, so a given count of dropped sheets is reported once.
function warnAboutDroppedVolumes(droppedCount) {
  if (droppedCount <= 0 || droppedCount === warnedDroppedVolumeCount) {
    return;
  }
  warnedDroppedVolumeCount = droppedCount;
  console.warn(`Crucible: ${droppedCount} water sheet${droppedCount === 1 ? '' : 's'} beyond the ${WATER_VOLUME_LIMIT} widest keep no underwater tint. Merge small sheets or keep to ${WATER_VOLUME_LIMIT} flat water parts.`);
}

/**
 * The water body of a set of parts, or null: the largest flat part with the water tag sets the level (its top) and the optics.
 * `volumes` lists every flat water part (widest first, up to WATER_VOLUME_LIMIT) with its level and footprint: the tint under
 * the water applies only to a surface inside one of them, so dry ground beside a pond keeps its own colour.
 * A water mesh that is not flat (a stream following the terrain) has no single level, so it sets none.
 */
export function findWaterBody(parts) {
  let best = null;
  const volumes = [];
  for (const part of parts) {
    if (part.material.tag !== 'water') {
      continue;
    }
    const { minimum, maximum } = cachedBounds(part);
    const wider = Math.max(maximum[0] - minimum[0], maximum[2] - minimum[2]);
    const footprint = (maximum[0] - minimum[0]) * (maximum[2] - minimum[2]);
    const flat = wider > 0 && maximum[1] - minimum[1] <= wider * WATER_MAXIMUM_THICKNESS_RATIO;
    if (flat) {
      volumes.push({ footprint, level: maximum[1], minimumX: minimum[0], minimumZ: minimum[2], maximumX: maximum[0], maximumZ: maximum[2] });
    }
    if (flat && (!best || footprint > best.footprint)) {
      best = { footprint, level: maximum[1], material: part.material, refractive: part.material.alphaMode === 'blend' };
    }
  }
  if (!best) {
    return null;
  }
  const { absorption, turbidity } = resolveWaterMaterial(best.material);
  // Only the widest bodies count: the shader holds a fixed number of volumes.
  volumes.sort((first, second) => second.footprint - first.footprint);
  warnAboutDroppedVolumes(volumes.length - WATER_VOLUME_LIMIT);
  return { level: best.level, absorption, turbidity, refractive: best.refractive, caustics: best.material.caustics ?? null, volumes: volumes.slice(0, WATER_VOLUME_LIMIT) };
}

const waterLocations = new WeakMap();
// The texture unit that holds the opaque scene for refraction (the splat mask unit: a scene with water and a splat ground never
// draws both in one batch).
const WATER_SCENE_UNIT = 14;

// The opaque scene is resolved into the renderer's frame texture the first time a blended batch of the frame draws, as the liquid
// pass does, and the water samples it.
function resolveOpaqueScene(renderer, locations) {
  const context = renderer.context;
  const { width, height } = renderer.canvas;
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, renderer.resolveFramebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.activeTexture(context.TEXTURE0 + WATER_SCENE_UNIT);
  context.bindTexture(context.TEXTURE_2D, renderer.frameTexture);
  context.uniform1i(locations.scene, WATER_SCENE_UNIT);
}

const volumeExtents = new Float32Array(WATER_VOLUME_LIMIT * 4);
const volumeLevels = new Float32Array(WATER_VOLUME_LIMIT);

// Sends each water volume's footprint (minimum x and z, maximum x and z) and level; the unused slots stay zero.
function bindWaterVolumes(context, locations, volumes) {
  volumeExtents.fill(0);
  volumeLevels.fill(0);
  volumes.forEach((volume, index) => {
    volumeExtents.set([volume.minimumX, volume.minimumZ, volume.maximumX, volume.maximumZ], index * 4);
    volumeLevels[index] = volume.level;
  });
  context.uniform4fv(locations.volumes, volumeExtents);
  context.uniform4fv(locations.volumeLevels, volumeLevels);
  context.uniform1i(locations.volumeCount, volumes.length);
}

function bindWaterBody(renderer) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  const context = renderer.context;
  let locations = waterLocations.get(renderer);
  if (locations?.program !== renderer.program) {
    locations = { program: renderer.program, body: context.getUniformLocation(renderer.program, 'waterBody'), absorption: context.getUniformLocation(renderer.program, 'waterAbsorption'), scene: context.getUniformLocation(renderer.program, 'waterScene'), volumes: context.getUniformLocation(renderer.program, 'waterVolumes'), volumeLevels: context.getUniformLocation(renderer.program, 'waterVolumeLevels'), volumeCount: context.getUniformLocation(renderer.program, 'waterVolumeCount'), caustics: context.getUniformLocation(renderer.program, 'waterCaustics'), resolved: false };
    waterLocations.set(renderer, locations);
  }
  const waterParts = renderer.batches.flatMap(batch => (batch.parts[0].material.tag === 'water' ? batch.parts : []));
  const body = findWaterBody(waterParts);
  // The mirror and the render passes skip the underwater look: the mirror is clipped above the water, a pass reads raw surface data.
  const active = Boolean(body) && !renderer.renderingPass && !renderer.mirrorCulling;
  // Refraction needs the frame texture, so it is off for a transparent canvas, whose alpha is the picture's own.
  const refracts = active && body.refractive && !renderer.transparent && !renderer.benchmark && Boolean(renderer.frameTexture);
  context.uniform4f(locations.body, active ? body.level : 0, active ? body.turbidity : 0, active ? 1 : 0, refracts ? 1 : 0);
  context.uniform4f(locations.caustics, ...waterCausticsUniform(active ? body.caustics : null));
  bindWaterVolumes(context, locations, active ? body.volumes : []);
  context.uniform3f(locations.absorption, ...(active ? body.absorption : [0, 0, 0]));
  if (!context.isEnabled(context.BLEND)) {
    locations.resolved = false;
  } else if (refracts && !locations.resolved) {
    resolveOpaqueScene(renderer, locations);
    locations.resolved = true;
  }
}

const foamVeinLocations = new WeakMap();

/** Sends the foam veins of a water batch: amount and scale. Amount 0 turns the veins off, which is every batch without `foamVeins`. */
function bindWaterFoamVeins(renderer, batch) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  let location = foamVeinLocations.get(renderer);
  if (location?.program !== renderer.program) {
    location = { program: renderer.program, veins: renderer.context.getUniformLocation(renderer.program, 'waterFoamVeins') };
    foamVeinLocations.set(renderer, location);
  }
  const veins = batch.parts[0].material.foamVeins ?? WATER_FOAM_VEIN_DEFAULTS;
  const amount = batch.parts[0].material.foamVeins ? veins.amount : 0;
  renderer.context.uniform2f(location.veins, amount, veins.scale);
}

/** The `waterContact` uniform: width, hardness, noise and 1 while the rim is drawn. No contact foam, or `rim` false, sends 0 and the shader draws no line. */
export function contactFoamUniform(contact) {
  if (!contact?.rim) {
    return [0, 0, 0, 0];
  }
  return [contact.width, contact.hardness, contact.noise, 1];
}

const rippleLocations = new WeakMap();

/** Sends the detail ripple controls of a water batch. A batch without `ripples` sends strength 1, speed 1 and no wind alignment. */
function bindWaterRipples(renderer, batch) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  let location = rippleLocations.get(renderer);
  if (location?.program !== renderer.program) {
    location = { program: renderer.program, ripples: renderer.context.getUniformLocation(renderer.program, 'waterRipples') };
    rippleLocations.set(renderer, location);
  }
  renderer.context.uniform4f(location.ripples, ...waterRipplesUniform(batch.parts[0].material.ripples));
}

const foamStyleLocations = new WeakMap();

/** Sends the foam style of a water batch: 1 for a hard edge, the width factor and the foam tint (white by default). Other batches get the soft default. */
export function bindWaterFoamStyle(renderer, batch) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  let location = foamStyleLocations.get(renderer);
  if (location?.program !== renderer.program) {
    const { context } = renderer;
    location = { program: renderer.program, style: context.getUniformLocation(renderer.program, 'waterFoamStyle'), color: context.getUniformLocation(renderer.program, 'waterFoamColor'), contact: context.getUniformLocation(renderer.program, 'waterContact'), contactDrift: context.getUniformLocation(renderer.program, 'waterContactDrift'), contactColor: context.getUniformLocation(renderer.program, 'waterContactColor') };
    foamStyleLocations.set(renderer, location);
  }
  const material = batch.parts[0].material;
  renderer.context.uniform2f(location.style, material.foamEdge === 'hard' ? 1 : 0, material.foamWidth ?? 1);
  renderer.context.uniform3f(location.color, ...(material.foamColor ?? WATER_FOAM_COLOR_DEFAULT));
  const contact = material.contactFoam;
  renderer.context.uniform4f(location.contact, ...contactFoamUniform(contact));
  renderer.context.uniform1f(location.contactDrift, contact?.drift ?? 0);
  renderer.context.uniform3f(location.contactColor, ...(contact?.color ?? CONTACT_FOAM_DEFAULTS.color));
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindWaterBody(renderer);
  bindWaterFoamStyle(renderer, batch);
  bindWaterFoamVeins(renderer, batch);
  bindWaterRipples(renderer, batch);
};

// Wind for the foliage (4) and grass (7) tags, shared by the colour and shadow vertex shaders so both
// move identically. It depends only on local position, the card's uv, world position and time.
// The slow sway grows with height and with distance from the model's vertical axis (branch tips swing
// more than the crown centre) but is capped, because bark never moves and leaves must stay near their twigs.
// uv.y is 1 at a leaf's base and 0 at its tip, which drives the faster flutter.

// The GLSL of the world materials: water, foliage, grass, terrain, moss, fire and smoke. A renderer with a part of one of those
// tags (or with moss) needs this module; any other renderer never carries it. shaders.js splices each block at its slot:
// worldFunctions (the noise and moss masks), worldSurface (the surface changes), worldLight (extra light), worldAfterEmission
// (water's reflection) and worldFinal (fire and smoke, which replace the lit colour). Other optional features can use the
// same slots, or stub them out in shaders.js, to leave their code out of renderers that do not draw them.
export const worldMaterialSlots = {
  // The water body (level, turbidity, 1 when a flat water part sets one) and its absorption per metre, sent by bindWaterBody.
  // Shadow of a surface under murky water: the classic shadow map read over a wider disc. A cascaded map is read through
  // its own macro and keeps its filter.
  declarations: `uniform vec4 waterBody;
uniform vec4 waterVolumes[${WATER_VOLUME_LIMIT}];
uniform vec4 waterVolumeLevels[${WATER_VOLUME_LIMIT / 4}];
uniform int waterVolumeCount;
// The surface of the highest water volume whose footprint holds the point and lies above it, or a very low level when none does.
float waterLevelAt(vec3 point) {
  float level = -1.0e9;
  for (int index = 0; index < ${WATER_VOLUME_LIMIT}; index++) {
    if (index >= waterVolumeCount) break;
    vec4 extent = waterVolumes[index];
    bool inside = point.x >= extent.x && point.x <= extent.z && point.z >= extent.y && point.z <= extent.w;
    if (inside && point.y < waterVolumeLevels[index / 4][index % 4]) level = max(level, waterVolumeLevels[index / 4][index % 4]);
  }
  return level;
}
uniform vec2 waterFoamVeins;
uniform vec2 waterFoamStyle;
uniform vec3 waterFoamColor;
uniform vec4 waterContact;
uniform float waterContactDrift;
uniform vec3 waterContactColor;
${causticsDeclarations}
uniform vec4 waterRampHead;
uniform vec3 waterRampWeights;
uniform vec2 waterRampHeightRange;
uniform vec4 waterRampCrest;
uniform vec3 waterRampColors[5];
uniform vec3 waterAbsorption;
uniform sampler2D waterScene;
uniform mat4 viewProjection;
// The frame texture holds the picture as it leaves the shader: scaled by exposure and, outside HDR, tone mapped and encoded.
// The stylized ramp: waterRampHead is (colour count, 1 for soft steps, 0, 0) and waterRampWeights the height, facing and sun weights.
// A hard ramp has a one pixel edge (fwidth) so a band does not crawl.
vec3 waterRampTone(float height, float facing, float sun) {
  float count = waterRampHead.x;
  float heightFraction = clamp((height - waterRampHeightRange.x) / (waterRampHeightRange.y - waterRampHeightRange.x), 0.0, 1.0);
  float driven = dot(waterRampWeights, vec3(heightFraction, facing, sun)) / dot(waterRampWeights, vec3(1.0));
  if (waterRampHead.y > 0.5) {
    float blendPosition = clamp(driven, 0.0, 1.0) * (count - 1.0);
    int lower = int(floor(min(blendPosition, count - 1.001)));
    return mix(waterRampColors[lower], waterRampColors[lower + 1], blendPosition - float(lower));
  }
  float position = clamp(driven, 0.0, 0.9999) * count;
  int band = int(floor(position));
  float edge = smoothstep(0.0, max(fwidth(position), 0.0001), fract(position));
  return band == 0 ? waterRampColors[0] : mix(waterRampColors[band - 1], waterRampColors[band], edge);
}

vec3 waterDecode(vec3 encoded) {
  vec3 linear = encoded;
  if (hdrEnabled < 0.5) {
    vec3 curve = pow(encoded, vec3(2.2));
    vec3 quadratic = 2.51 - 2.43 * curve;
    vec3 slope = 0.03 - 0.59 * curve;
    linear = (-slope + sqrt(max(slope * slope + 4.0 * quadratic * 0.14 * curve, 0.0))) / (2.0 * quadratic);
  }
  return linear / max(exposure, 0.0001);
}
// Refraction (n = 1.33): the view ray bends at the surface and meets the bed at the depth the opaque pass left in the alpha
// channel of everything below the level. The picture around that point is blurred by turbidity times depth. Where nothing
// below the level is seen, the water keeps its own colour (fallback).
vec3 refractedBackground(vec3 fallback, vec3 surfacePosition, vec3 normal, vec3 viewDirection) {
  vec2 size = vec2(textureSize(waterScene, 0));
  vec3 bent = refract(-viewDirection, normal, 0.7519);
  vec2 uv = gl_FragCoord.xy / size;
  float depth = 0.0;
  for (int pass = 0; pass < 2; pass++) {
    float stored = textureLod(waterScene, uv, 0.0).a;
    depth = stored < 0.999 ? (stored - 0.5) / 0.498 * 8.0 : 0.0;
    vec4 clip = viewProjection * vec4(surfacePosition + bent * (depth / max(-bent.y, 0.1)), 1.0);
    uv = clip.xy / clip.w * 0.5 + 0.5;
  }
  float radius = min(waterBody.y * depth * 0.02 * size.y, 48.0);
  vec3 seenColor = vec3(0.0);
  float seen = 0.0;
  for (int tap = 0; tap < 16; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / 16.0) * radius / size;
    vec2 position = uv + offset;
    vec4 sampled = textureLod(waterScene, position, 0.0);
    // A lookup that leaves the picture has nothing to show, so the water keeps its own colour there.
    float inside = all(greaterThan(position, vec2(0.0))) && all(lessThan(position, vec2(1.0))) ? 1.0 : 0.0;
    float below = sampled.a < 0.999 ? inside : 0.0;
    seenColor += waterDecode(sampled.rgb) * below;
    seen += below;
  }
  // Average only the taps that saw something below the water: a tap past the bed edge must not pull the blur toward the water colour.
  return seen > 0.5 ? seenColor / seen : fallback;
}
// Contact foam: a line where the water meets what lies behind it. The opaque pass left the depth below the water level of each
// surface it drew in the alpha channel, so the gap between this water point and the scene point seen through the same pixel is
// known; foam is where that gap, measured in screen pixels, is under the width, so the line keeps one width at any distance.
// waterContact is (width in pixels, hardness, noise, 1 when on); noiseValue is 0 to 1 and breaks the edge up.
float waterContactFoam(vec3 surfacePosition, float noiseValue) {
  if (waterContact.w < 0.5 || waterBody.w < 0.5) return 0.0;
  vec2 size = vec2(textureSize(waterScene, 0));
  float stored = textureLod(waterScene, gl_FragCoord.xy / size, 0.0).a;
  if (stored >= 0.999) return 0.0;
  float sceneDepth = max(stored - 0.5, 0.0) / 0.498 * 8.0;
  float gap = abs(surfacePosition.y - waterBody.x + sceneDepth);
  // A pixel far away spans metres, so a width in pixels alone would foam open water up to the horizon, where the scene behind is deep
  // water, the far plane or the sky. Foam only where the scene is within half a metre of the water surface.
  if (gap > 0.5) return 0.0;
  vec4 above = viewProjection * vec4(surfacePosition + vec3(0.0, 1.0, 0.0), 1.0);
  vec4 here = viewProjection * vec4(surfacePosition, 1.0);
  float pixelsPerMetre = max(abs(above.y / above.w - here.y / here.w) * 0.5 * size.y, 0.001);
  float gapPixels = gap * pixelsPerMetre;
  float edge = waterContact.x * (1.0 + (noiseValue - 0.5) * 2.0 * waterContact.z);
  float softness = mix(0.6 * waterContact.x, 0.0, waterContact.y) + 1.0;
  return 1.0 - smoothstep(edge - softness, edge + softness, gapPixels);
}
#ifndef shadowVisibility
float softShadowVisibility(vec3 normal, float radiusTexels) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float cosine = max(dot(normal, normalize(lightDirection)), 0.05);
  float bias = shadowBiasPerSlope * clamp(sqrt(1.0 - cosine * cosine) / cosine, 0.25, 4.0);
  vec2 texel = 1.0 / vec2(textureSize(shadowMap, 0));
  float lit = 0.0;
  for (int tap = 0; tap < 12; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / 12.0) * radiusTexels;
    lit += texture(shadowMap, vec3(projected.xy + offset * texel, projected.z - bias));
  }
  return lit / 12.0;
}
#endif
// Sunlight under water: in-scatter lifts the shadow (the water scatters light into it) and widens its edge, both with
// turbidity times the depth of the column above the surface.
float underwaterVisibility(float visibility, vec3 normal, float depth) {
  float scattering = waterBody.y * depth;
  float filtered = visibility;
#ifndef shadowVisibility
  if (scattering > 0.03) filtered = softShadowVisibility(normal, 1.5 + min(scattering * 6.0, 8.0));
#endif
  return filtered;
}
`,
  worldVisibility: `  float waterDepth = 0.0;
  vec3 waterTransmittance = vec3(1.0);
  vec3 waterSunTransmittance = vec3(1.0);
  float waterScatterShare = 0.0;
  float waterShadowVisibility = 1.0;
  float waterSurfaceLevel = 0.0;
  if (TAG_WATER) {
    // Only the light that enters the water and comes back is shadowed, and most of what the eye sees comes from deeper than
    // the shadow reaches, so a shadow on the surface is faint. The reflection mixed in later never sees the shadow.
    visibility = mix(visibility, 1.0, 0.7 + 0.2 * waterBody.y);
  } else if (waterBody.z > 0.5 && worldPosition.y < (waterSurfaceLevel = waterLevelAt(worldPosition))) {
    waterDepth = waterSurfaceLevel - worldPosition.y;
    waterTransmittance = exp(-waterAbsorption * waterDepth);
    visibility = underwaterVisibility(visibility, normal, waterDepth);
    waterShadowVisibility = visibility;
    // The sun reaches the bed along the refracted ray, depth / cos(theta) with Snell n = 1.33, so its leg is absorbed over a longer path than the eye's.
    float sunSine = sqrt(max(1.0 - pow(normalize(lightDirection).y, 2.0), 0.0)) / 1.33;
    waterSunTransmittance = exp(-(waterAbsorption + 0.9 * waterBody.y * (1.0 - waterBody.y)) * waterDepth / sqrt(1.0 - sunSine * sunSine));
    waterScatterShare = waterBody.y * (1.0 - exp(-0.4 * waterBody.y * waterDepth));
    if (waterCaustics.z > 0.0) waterSunTransmittance *= causticGain(worldPosition, waterDepth);
  }
  vec3 keyColor = keyColor * waterSunTransmittance;
`,
  // Spliced into the colour and shadow vertex shaders by shaders.js.
  worldVertexWind: `
// Grass bends by how far up the blade a vertex is (uv.y is 1 at the root), so it ignores terrain height. The tip moves a share of the
// blade length (uv.x carries the length in millimetres, see src/grass.js), so one wind bends a 0.12 m lawn and a 0.6 m meadow to the same
// angle. A 0.6 m blade moves as far as it always did.
const float GRASS_WIND_REFERENCE_LENGTH = 0.6;
// Gusts roll across the field as a travelling wave along the wind direction, like the rolling bands in a meadow.
// windHeading turns the wind about the vertical axis, in radians; 0 is the default heading toward +x.
uniform float windHeading;

vec3 grassWind(vec3 worldPoint, vec2 leafUv, float seconds, float strength) {
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float bladeLength = floor(leafUv.x * 0.5) * 0.001;
  float bendWeight = tip * tip * bladeLength / GRASS_WIND_REFERENCE_LENGTH;
  float headingCos = cos(windHeading);
  float headingSin = sin(windHeading);
  vec2 windDirection = vec2(0.94 * headingCos - 0.34 * headingSin, 0.94 * headingSin + 0.34 * headingCos);
  float along = dot(worldPoint.xz, windDirection);
  float gust = 0.5 + 0.5 * sin(along * 0.32 - seconds * 1.7 + 2.0 * sin(worldPoint.x * 0.05 - worldPoint.z * 0.04 + seconds * 0.23));
  float push = (0.3 + 0.7 * gust * gust) * strength;
  float flutter = sin(seconds * 4.7 + worldPoint.x * 2.3 + worldPoint.z * 1.9) * strength;
  vec2 offset = windDirection * (push * 0.42 + flutter * 0.05) + vec2(-windDirection.y, windDirection.x) * flutter * 0.04;
  return vec3(offset.x, -push * 0.14, offset.y) * bendWeight;
}

vec3 windOffset(vec3 localPosition, vec3 worldPoint, vec2 leafUv, float surfaceTag, float seconds, float strength) {
  // Grass without UVs (uv is (-1, -1)) has no blade coordinate, so it keeps the height-based sway below.
  if (surfaceTag == 7.0 && leafUv.x > -0.5) return grassWind(worldPoint, leafUv, seconds, strength);
  if (surfaceTag != 4.0 && surfaceTag != 7.0) return vec3(0.0);
  float heightReach = min(max(localPosition.y + 0.5, 0.0), 2.5);
  float branchReach = 1.0 + 0.3 * min(length(localPosition.xz), 3.0);
  float sway = sin(seconds * 1.2 + worldPoint.z * 0.31 + worldPoint.x * 0.17) * strength * 0.10 * heightReach * branchReach;
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float flutter = sin(seconds * 3.1 + worldPoint.x * 1.7 + worldPoint.z * 1.3 + localPosition.y * 2.0) * strength * 0.08 * tip;
  vec2 heading = vec2(cos(windHeading), sin(windHeading));
  vec2 push = heading * (sway + flutter) + vec2(-heading.y, heading.x) * (flutter * 0.6);
  return vec3(push.x, 0.0, push.y);
}
`,
  worldFunctions: `// Declared with the function that reads it: programs that carry the functions but no water declarations compile it too.
uniform vec4 waterRipples;
float terrainHash(vec2 position) {
  vec3 seed = fract(vec3(position.xyx) * 0.1031);
  seed += dot(seed, seed.yzx + 33.33);
  return fract((seed.x + seed.y) * seed.z);
}

// Value noise and its analytic gradient avoid extra texture fetches for sand relief.
vec3 terrainNoise(vec2 position) {
  vec2 cell = floor(position);
  vec2 fraction = fract(position);
  vec2 blend = fraction * fraction * (3.0 - 2.0 * fraction);
  vec2 derivative = 6.0 * fraction * (1.0 - fraction);
  float lowerLeft = terrainHash(cell);
  float lowerRight = terrainHash(cell + vec2(1.0, 0.0));
  float upperLeft = terrainHash(cell + vec2(0.0, 1.0));
  float upperRight = terrainHash(cell + vec2(1.0, 1.0));
  float lower = mix(lowerLeft, lowerRight, blend.x);
  float upper = mix(upperLeft, upperRight, blend.x);
  return vec3(mix(lower, upper, blend.y),
    mix(lowerRight - lowerLeft, upperRight - upperLeft, blend.y) * derivative.x,
    (upper - lower) * derivative.y);
}

// Wind ripples the mesh is too coarse to carry: eight travelling waves from 3 m down to 0.15 m, about 0.15 rms slope in all, which
// is what breaks a sun glint into facets. The wavelengths step by an irrational ratio and the directions by the golden angle, and
// each wave's phase and strength drift with slow noise, so no pair of waves repeats the same blob pattern over the water. A wave
// stays whole while a pixel is under a fifth of its length and is gone at half (two pixels per wave, the limit of one sample per
// pixel), so far water does not shimmer but keeps every wave a pixel can still show; the slope variance the faded waves
// took with them comes back as lostVariance, to widen the glint instead.
// How much of a wave one pixel still shows, from the pixel's size along the wave's travel (footprint, world units) and the wave's
// wavenumber (radians per unit). A pixel averages the wave over its own width, which scales the wave by sinc(pixel size in
// wavelengths); it is zero at one pixel per wavelength. The averaged amplitude is what a supersampled render converges to, so far
// water keeps the part of each wave a pixel can carry instead of cutting the wave off.
float waterWaveVisibility(float footprint, float wavenumber) {
  float phaseSpan = clamp(footprint * wavenumber * 0.5, 0.0001, 3.14159265);
  return sin(phaseSpan) / phaseSpan;
}

vec2 waterDetailSlope(vec2 position, vec2 positionDx, vec2 positionDy, out float lostVariance) {
  vec2 slope = vec2(0.0);
  lostVariance = 0.0;
  float wavenumber = 2.1;
  float angle = 0.4;
  for (int index = 0; index < 8; index++) {
    if (waterRipples.z > 0.5) {
      // Downwind: a wave travels against its direction vector (the phase grows with time), so turn it half a circle to the wind.
      angle = waterRipples.w + 3.14159265 + (fract(float(index) * 0.618034) - 0.5) * 1.4;
    }
    vec2 direction = vec2(cos(angle), sin(angle));
    float footprint = abs(dot(positionDx, direction)) + abs(dot(positionDy, direction));
    float visible = waterWaveVisibility(footprint, wavenumber);
    float drift = terrainNoise(position * wavenumber * 0.09 + float(index) * 9.17).x - 0.5;
    float strength = 0.15 + 1.7 * terrainNoise(position * wavenumber * 0.06 + float(index) * 23.9 + 4.0).x;
    float phase = dot(position, direction) * wavenumber + time * waterRipples.y * sqrt(9.81 * wavenumber) + float(index) * 1.7 + drift * 5.0;
    float amplitude = 0.085 * pow(wavenumber / 2.1, -0.3) * strength * waterRipples.x;
    slope += direction * cos(phase) * amplitude * visible;
    lostVariance += 0.5 * amplitude * amplitude * (1.0 - visible * visible);
    wavenumber *= 1.7320508;
    angle += 2.399963;
  }
  return slope;
}
`,
  worldMossFunction: `// Moss is its own material over the base, not a tint: fully rough, a soft sheen at grazing angles and light that wraps
// through it. Two masks, as in offline moss shading: a sharp one decides where moss is shaded, and a blurred one lifts
// it into cushions, so its relief never turns into needles. Coverage favours up-facing surfaces.
void mossMasks(vec3 normal, float amount, out float sharpMask, out float softMask) {
  float facing = smoothstep(0.1, 0.7, normal.y);
  vec2 position = worldPosition.xz * 6.0 + worldPosition.y * vec2(2.3, -1.7);
  float patches = terrainNoise(position).x * 0.6 + terrainNoise(position * 2.7 + 5.1).x * 0.4;
  float threshold = 1.0 - amount;
  sharpMask = facing * smoothstep(threshold - 0.035, threshold + 0.035, patches);
  softMask = facing * smoothstep(threshold - 0.22, threshold + 0.18, patches);
}

`,
  worldSurface: `  float waterFoam = 0.0;
  float waterContactShare = 0.0;
  vec3 waterRampRadiance = vec3(0.0);
  float waterRampOwns = 0.0;
  float waterLostVariance = 0.0;
  if (TAG_WATER) {
    // Small ripples tilt the surface's own normal, so a sea mesh keeps its waves; a flat sheet (normal up) gets the same ripples as before.
    vec2 positionDx = dFdx(worldPosition.xz);
    vec2 positionDy = dFdy(worldPosition.xz);
    float swellVisibleX = waterWaveVisibility(abs(positionDx.x) + abs(positionDy.x), 1.4);
    float swellVisibleZ = waterWaveVisibility(abs(positionDx.y) + abs(positionDy.y), 1.8);
    vec3 rippleTilt = vec3(-cos(worldPosition.x * 1.4 + time * 0.8) * 0.035 * swellVisibleX, 0.0, -cos(worldPosition.z * 1.8 - time) * 0.036 * swellVisibleZ);
    float radius = length(worldPosition.xz - waterRipple.xz);
    float age = time - rippleTime;
    float wave = sin(radius * 11.0 - age * 8.0) * exp(-abs(radius - age * 1.4) * 1.5) * exp(-age * 0.7) * step(0.0, age);
    rippleTilt.xz += normalize(worldPosition.xz - waterRipple.xz + 0.001) * wave * 0.07;
    vec2 detailSlope = waterDetailSlope(worldPosition.xz, positionDx, positionDy, waterLostVariance);
    rippleTilt.xz += detailSlope;
    vec3 crestNormal = normal;
    normal = normalize(normal + rippleTilt);
    // The body is deeper at grazing angles; the foam mask (the ocean's, stored as 1 - foam in the sky visibility channel) turns it white.
    // Foam: the mask is the heavy half of the ocean's foam (about 5% of a rough sea). Three octaves of noise stretched along the crest
    // make lace: the core stays bright and solid, the edge dissolves into holes and thin veins, and it grows less opaque outwards.
    // The threshold has a soft band at least one pixel wide (fwidth), so the edge is smooth and does not follow the mesh triangles.
    vec2 crestAcross = normalize(crestNormal.xz + vec2(0.0001));
    vec2 crestAlong = vec2(-crestAcross.y, crestAcross.x);
    vec2 crestPosition = vec2(dot(worldPosition.xz, crestAlong), dot(worldPosition.xz, crestAcross));
    // Where the surface is nearly level (a wake's trail, the top of a swell) the normal's horizontal part is about zero and its direction
    // spins, which fanned the lace out in rays around that point (#3070). The lace there fades to the same noise on fixed axes.
    float crestSteadiness = smoothstep(0.01, 0.05, length(crestNormal.xz));
    float broadLace = mix(terrainNoise(worldPosition.xz * vec2(0.45, 2.4)).x, terrainNoise(crestPosition * vec2(0.45, 2.4)).x, crestSteadiness);
    float midLace = mix(terrainNoise(worldPosition.xz * vec2(1.3, 6.5) + 7.3).x, terrainNoise(crestPosition * vec2(1.3, 6.5) + 7.3).x, crestSteadiness);
    float fineLace = mix(terrainNoise(worldPosition.xz * vec2(3.1, 14.0) + 3.9).x, terrainNoise(crestPosition * vec2(3.1, 14.0) + 3.9).x, crestSteadiness);
    float lace = broadLace * 0.5 + midLace * 0.3 + fineLace * 0.2;
    float foamMask = clamp(2.0 * (1.0 - vertexSkyVisibility) - 1.0, 0.0, 1.0);
    // waterFoamStyle is (hard edge 0 or 1, width): a hard edge draws the mask as a flat painted shape with a one pixel edge and no veins.
    float foamHard = waterFoamStyle.x;
    float foamDensity = foamMask * 1.25 * waterFoamStyle.y + (lace - 0.5) * mix(0.9, 0.3, foamHard);
    float foamBand = mix(0.13, 0.0, foamHard) + 1.5 * fwidth(foamDensity);
    float foamBody = smoothstep(0.5 - foamBand, 0.5 + foamBand, foamDensity) * smoothstep(0.03, 0.25, foamMask);
    float foamVeins = pow(1.0 - abs(2.0 * midLace - 1.0), 3.0) * smoothstep(0.45, 0.9, foamMask) * (1.0 - foamBody) * 0.32 * (1.0 - foamHard);
    waterFoam = mix(max(foamBody * mix(0.5, 1.0, smoothstep(0.3, 0.95, foamMask)) * (0.78 + 0.22 * smoothstep(0.25, 0.75, fineLace * 0.6 + midLace * 0.4)), foamVeins), foamBody, foamHard);
    // waterContactDrift above 0 slides the rim's noise with time and tears the rim into segments: a second noise, slid the other way,
    // closes the rim where it is low. At 0 the rim is the static one.
    float contactNoise = terrainNoise(worldPosition.xz * 1.7 + 11.3).x;
    float contactTear = 1.0;
    if (waterContactDrift > 0.0) {
      contactNoise = terrainNoise(worldPosition.xz * 1.7 + 11.3 + vec2(time * 0.35, time * 0.2)).x;
      float tearNoise = terrainNoise(worldPosition.xz * vec2(1.1, 2.3) + vec2(-time * 0.3, time * 0.12) + 41.7).x;
      contactTear = mix(1.0, smoothstep(0.32, 0.55, tearNoise), waterContactDrift);
    }
    waterContactShare = waterContactFoam(worldPosition, contactNoise) * contactTear;
    waterFoam = max(waterFoam, waterContactShare);
    // waterFoamVeins is (amount, scale). Veins are ridged noise, warped by a second noise, on the world position: one step in every direction
    // and no frame that turns with the surface normal, so a cell is as long as it is wide and does not smear. They read the whole foam group,
    // not only its heavy half that makes the crest cap, so the lace trails out behind the crest: lines thin out and a slow noise breaks them
    // into patches as the foam weight falls, instead of ending on one line along the crest.
    if (waterFoamVeins.x > 0.0) {
      vec2 veinPosition = worldPosition.xz * 4.0 * waterFoamVeins.y;
      vec2 veinWarp = terrainNoise(veinPosition * 0.7 + 17.1).xy - 0.5;
      float veinRidge = 1.0 - abs(2.0 * terrainNoise(veinPosition * 1.6 + veinWarp * 0.9 + 5.7).x - 1.0);
      float veinTrail = smoothstep(0.0, 0.8, clamp(1.0 - vertexSkyVisibility, 0.0, 1.0));
      float veinPatch = terrainNoise(veinPosition * 0.3 + 41.7).x;
      float veinFade = smoothstep(0.0, 0.6, veinTrail * 1.3 - 0.8 * (1.0 - veinPatch));
      float veinLine = smoothstep(1.0 - 0.3 * sqrt(veinTrail) - 0.02 - fwidth(veinRidge), 1.0 - 0.3 * sqrt(veinTrail) + fwidth(veinRidge), veinRidge);
      waterFoam = max(waterFoam, veinLine * veinFade * waterFoamVeins.x);
    }
    float grazing = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    color = mix(color, vec3(0.0137, 0.147, 0.195), grazing * 0.85);
    color = mix(color, mix(vec3(0.92, 0.95, 0.97) * (0.68 + 0.32 * (fineLace * 0.5 + midLace * 0.5)), waterContactColor, waterContactShare), waterFoam);
    roughness = mix(0.16, 0.8, waterFoam);
    if (waterRampHead.x > 0.5) {
      float rampSun = clamp(dot(normal, normalize(lightDirection)), 0.0, 1.0);
      vec3 rampTone = waterRampTone(worldPosition.y, 1.0 - max(dot(normal, viewDirection), 0.0), rampSun);
      float crestEdge = waterRampHead.y > 0.5 ? 0.15 : max(1.5 * fwidth(foamMask), 0.0001);
      float crestAmount = waterRampCrest.w * smoothstep(0.2 - crestEdge, 0.2 + crestEdge, foamMask);
      waterRampRadiance = waterRampRadianceFor(mix(rampTone, waterRampCrest.rgb, crestAmount));
      waterRampOwns = 1.0;
    }
  }
  if (CANOPY_TAG) {
    float leaves = sin(worldPosition.x * 13.0 + sin(worldPosition.y * 9.0)) * sin(worldPosition.z * 11.0 - worldPosition.y * 5.0);
    color *= 0.78 + leaves * 0.16;
    normal = normalize(normal + vec3(sin(worldPosition.z * 12.0), sin(worldPosition.x * 9.0), cos(worldPosition.y * 11.0)) * 0.06);
  }
  if (TAG_TERRAIN) {
    vec2 terrainPosition = worldPosition.xz + worldPosition.y * vec2(0.31, 0.43);
    float footprint = max(fwidth(terrainPosition.x), fwidth(terrainPosition.y));
    vec3 broad = terrainNoise(terrainPosition * 0.32);
    vec3 ridges = terrainNoise(terrainPosition * 3.2 + vec2(5.2, 11.7));
    vec3 grains = terrainNoise(terrainPosition * 32.0 + vec2(17.1, 4.3));
    float ridgeWeight = 1.0 - smoothstep(0.25, 0.8, footprint * 3.2);
    float grainWeight = 1.0 - smoothstep(0.2, 0.7, footprint * 32.0);
    float ridgeColor = 1.0 - abs(ridges.x * 2.0 - 1.0);
    color *= 0.82 + broad.x * 0.26 + (ridgeColor - 0.5) * 0.12 * ridgeWeight + (grains.x - 0.5) * 0.1 * grainWeight;
    vec2 relief = ridges.yz * 0.08 * ridgeWeight + grains.yz * 0.11 * grainWeight;
    vec3 perturbation = vec3(-relief.x, 0.0, -relief.y);
    normal = normalize(normal + perturbation - normal * dot(perturbation, normal));
    roughness = clamp(roughness + (grains.x - 0.5) * 0.06 * grainWeight, 0.075, 1.0);
  }
  if (USES_MOSS) {
    float mossSoft;
    mossMasks(normal, materialMoss.x, mossCover, mossSoft);
    float mossFootprint = length(fwidth(worldPosition));
    vec3 cushion = terrainNoise(worldPosition.xz * 40.0 + worldPosition.y * 13.0);
    float cushionDetail = 1.0 - smoothstep(0.004, 0.03, mossFootprint);
    vec3 cushionTilt = vec3(-cushion.y, 0.0, -cushion.z) * 0.07 * mossSoft * cushionDetail;
    normal = normalize(normal + cushionTilt - normal * dot(cushionTilt, normal));
    mossTone = materialMoss.yzw * (0.7 + 0.6 * cushion.x);
    color = mix(color, mossTone, mossCover);
    roughness = mix(roughness, 1.0, mossCover);
    metallic = mix(metallic, 0.0, mossCover);
  }
`,
  worldLight: `  if (CANOPY_TAG) radiance += color * max(dot(gl_FrontFacing ? -normal : normal, normalize(lightDirection)), 0.0) * 0.5 * keyResponse * mix(visibility, 1.0, 0.7);
  if (mossCover > 0.001) {
    float sheen = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    float wrap = max(dot(normal, normalize(lightDirection)) + 0.5, 0.0) / 1.5;
    radiance += mossTone * (sheen * 0.8 + wrap * 0.35) * keyResponse * visibility * mossCover;
  }
  if (TAG_GRASS) {
    // Sun through thin blades: they glow yellow-green when the camera looks toward the light, most at the thin tips
    // (uv.y runs 1 at the root to 0 at the tip; grass without UVs gets a middle value).
    float towardSun = pow(max(dot(-viewDirection, normalize(lightDirection)), 0.0), 3.0);
    float thinness = textureUV.x > -0.5 ? 1.0 - textureUV.y * 0.8 : 0.6;
    radiance += color * vec3(1.1, 1.25, 0.55) * towardSun * thinness * 1.4 * keyResponse * visibility;
  }
`,
  worldAfterEmission: `  if (waterDepth > 0.0) {
    // The bed's light reaches the eye through the column, dimmed; the water adds the daylight it scattered toward the eye (clear water a little, murky water more), so deep objects fade into the water colour instead of going black.
    vec3 scatteredLight = (keyColor * max(normalize(lightDirection).y, 0.0) * 0.1 + vec3(0.04) * ambientIntensity) * exp(-waterAbsorption * 1.5);
    radiance = radiance * waterTransmittance + scatteredLight * (vec3(1.0) - waterTransmittance) * (0.25 + waterBody.y);
    // Murky water scatters sunlight toward the eye from the column above the bed, and the post shadows that column too, so a shadow keeps a floor of contrast at depth (Cycles keeps about a quarter at 4 m in a river). It never subtracts: the lit side only gains.
    radiance += color * keyResponse / max(waterSunTransmittance, vec3(0.0001)) * max(dot(normal, normalize(lightDirection)), 0.0) * waterShadowVisibility * waterScatterShare * 3.4 * exp(-waterAbsorption);
  }
  if (TAG_WATER) {
    // Fresnel (Schlick, water F0 0.02) of the sky or environment the surface mirrors; foam is rough and reflects little.
    float cosine = max(dot(normal, viewDirection), 0.0);
    float reflectivity = (0.02 + 0.98 * pow(1.0 - cosine, 5.0)) * (1.0 - waterFoam);
    vec3 mirrorDirection = reflect(-viewDirection, normal);
    mirrorDirection.y = max(mirrorDirection.y, 0.02);
    vec3 skyColor = ENVIRONMENT_ENABLED ? surroundingsColor(mirrorDirection, 0.05) : mix(vec3(0.12, 0.24, 0.28), vec3(0.40, 0.63, 0.78), clamp(mirrorDirection.y, 0.0, 1.0)) * daylight;
    radiance = mix(radiance * 0.6 + color * ambientIntensity * daylight * 1.7, skyColor * ambientIntensity, clamp(reflectivity, 0.0, 1.0));
    // A ramp owns the colour: no sky reflection, so the tones stay flat; foam and the sun glint still add on top.
    if (waterRampOwns > 0.5) radiance = waterRampRadiance * (1.0 - waterFoam);
    // Sun glint: a narrow lobe around the mirror direction, the width of open water slopes, bright enough to bloom.
    vec3 halfVector = normalize(normalize(lightDirection) + viewDirection);
    float glintSharpness = 1.0 / (1.0 / 500.0 + 0.35 * waterLostVariance);
    float glintShape = pow(max(dot(normal, halfVector), 0.0), glintSharpness);
    float glintFresnel = 0.02 + 0.98 * pow(1.0 - max(dot(halfVector, viewDirection), 0.0), 5.0);
    radiance += vec3(1.0, 0.9, 0.7) * glintShape * (0.5 + 40.0 * glintFresnel) * 6.0 * keyResponse * (1.0 - waterFoam);
    // The foam pixel was already lit through its foam albedo above, so its own lit add replaces that light instead of piling on it: foam never outshines a white diffuse surface under the same light.
    radiance *= 1.0 - waterFoam;
    radiance += mix(vec3(0.85, 0.9, 0.95), waterContactColor, waterContactShare) * waterFoam * (max(dot(normal, normalize(lightDirection)), 0.0) * keyResponse + 0.35 * daylight * ambientIntensity);
    // foamColor tints everything the foam shows: its diffuse, its lit add and any light the foam pixel picked up on the way. White adds exactly zero, so the default is unchanged.
    radiance *= vec3(1.0) + (waterFoamColor - vec3(1.0)) * waterFoam * (1.0 - waterContactShare);
    if (waterBody.w > 0.5 && alphaMode > 1.5) {
      // Blended water draws its own background: the opaque scene refracted and blurred, not the one behind it unbent.
      radiance = radiance * alpha + refractedBackground(radiance, worldPosition, normal, viewDirection) * (1.0 - alpha);
      alpha = 1.0;
    }
  }
`,
  // The ramp colours are display colours: the radiance a ramp writes is the one the view transform maps back to the colour asked for.
  libraries: `// Radiance that exposure and the view transform turn into the display colour whose sRGB encoding is the asked linear colour.
// Newton steps on the renderer's own curve (ACES, AgX or Neutral), so a ramp stop given as a hex shows as that hex.
vec3 waterRampRadianceFor(vec3 asked) {
  vec3 encoded = mix(asked * 12.92, 1.055 * pow(max(asked, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), asked));
  vec3 target = pow(clamp(encoded, 0.0, 1.0), vec3(2.2));
  vec3 guess = target;
  for (int iteration = 0; iteration < 24; iteration++) {
    vec3 here = toneMap(guess);
    vec3 slope = (toneMap(guess + 0.002) - here) / 0.002;
    guess = max(guess + (target - here) / max(slope, vec3(0.05)), vec3(0.0));
  }
  return guess / max(exposure, 0.0001);
}
`,
  worldFinal: `  // A ramp stands clear of the distance haze, which would shift the colour it was asked to show: a local density of 0 shadows the uniform.
  float fogDensity = waterRampOwns > 0.5 ? 0.0 : fogDensity;
  if (waterDepth > 0.0 && waterBody.w > 0.5 && alphaMode < 0.5) alpha = 0.5 + 0.498 * clamp(waterDepth / 8.0, 0.0, 1.0);
  if (TAG_FIRE) {
    float turbulence = sin(worldPosition.x * 3.0 + time * 4.0) * sin(worldPosition.y * 4.2 - time * 3.0) * sin(worldPosition.z * 3.7);
    float heat = pow(clamp(0.55 + turbulence * 0.5 - explosionProgress * 0.12, 0.0, 1.0), 3.0);
    radiance = mix(vec3(0.22, 0.003, 0.0002), vec3(8.0, 2.8, 0.15), heat) * max(0.2, surface.z * 0.10);
  }
  if (TAG_SMOKE) {
    float turbulence = sin(worldPosition.x * 2.0 + time) * sin(worldPosition.y * 3.3 - time * 0.6);
    radiance = color * (0.22 + turbulence * 0.12) + vec3(0.35, 0.05, 0.005) * max(0.0, 1.0 - explosionProgress) * max(0.0, -normal.y);
  }
`,
};

registerShaderFeatureCode('worldMaterials', worldMaterialSlots);

/**
 * Turns the foliage and grass wind to `radians` about the vertical axis (0 is the default heading toward +x).
 * The renderer never sets windHeading, so the value stays on the main and shadow programs between frames; call this
 * before each render, because a rebuilt program starts at 0. A turned heading marks the shadow map stale.
 */
export function applyWindHeading(renderer, radians) {
  const context = renderer.context;
  for (const program of [renderer.program, renderer.depthProgram]) {
    const location = context.getUniformLocation(program, 'windHeading');
    if (!location) continue;
    context.useProgram(program);
    context.uniform1f(location, radians);
  }
  if (renderer.windHeading !== radians) renderer.shadowsDirty = true;
  renderer.windHeading = radians;
}

const waterRampLocations = new WeakMap();
const NO_RAMP = Object.freeze({ colors: [], drivers: { height: 1, facing: 0, sun: 0 }, heightRange: [-1, 1], steps: 'hard' });
const RAMP_COLOR_SLOTS = WATER_RAMP_COLOR_COUNT[1];

/** Sends the ramp of a water batch; a batch without one sends a colour count of 0, which leaves the water as it was. */
function bindWaterRamp(renderer, batch) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  let locations = waterRampLocations.get(renderer);
  if (locations?.program !== renderer.program) {
    const locate = name => renderer.context.getUniformLocation(renderer.program, name);
    locations = { program: renderer.program, head: locate('waterRampHead'), weights: locate('waterRampWeights'), heightRange: locate('waterRampHeightRange'), crest: locate('waterRampCrest'), colors: locate('waterRampColors') };
    waterRampLocations.set(renderer, locations);
  }
  const ramp = batch.parts[0].material.waterRamp ?? NO_RAMP;
  const context = renderer.context;
  context.uniform4f(locations.head, ramp.colors.length, ramp.steps === 'soft' ? 1 : 0, 0, 0);
  context.uniform3f(locations.weights, ramp.drivers.height, ramp.drivers.facing, ramp.drivers.sun);
  context.uniform2f(locations.heightRange, ...ramp.heightRange);
  context.uniform4f(locations.crest, ...(ramp.crestTint?.color ?? [0, 0, 0]), ramp.crestTint?.strength ?? 0);
  const padding = Array.from({ length: RAMP_COLOR_SLOTS - ramp.colors.length }, () => [0, 0, 0]);
  context.uniform3fv(locations.colors, new Float32Array([...ramp.colors, ...padding].flat()));
}

const bindBeforeRamp = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  bindBeforeRamp?.(renderer, mapState, layerState, batch);
  bindWaterRamp(renderer, batch);
};
