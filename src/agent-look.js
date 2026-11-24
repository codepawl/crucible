import { lightLimitAdvice } from './light-limit-advice.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { MINIMUM_SPOT_ANGLE, MAXIMUM_SPOT_ANGLE, spotAngleExpectation } from './spot-angle-advice.js';
import { mat4 } from 'gl-matrix';
import { sceneBoundsOfParts } from './near-plane-fit.js';
import { createLightingState, updateLightingState, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS, MAXIMUM_SPECULAR_ANTI_ALIASING } from './lighting.js';
import { normalizeWetness, normalizePuddles } from './wetness.js';
import { resolveEffects } from './effects.js';
import { resolveVolumeFog } from './volumetric.js';
import { resolveFogDetail } from './fog-field.js';
import { resolveLocalVolumesWith } from './local-volume-resolve.js';
import { LIQUID_OPTICS, resolveLiquidOptics } from './liquid-optics.js';
import { createLightingSetupMap, createCatalogEnvironmentMap, lightingSetupFields, setupMapShowsBackground } from './lighting-setups.js';
import { agentSceneModule } from './agent-scene-modules.js';
import { splitHdriSun } from './hdri.js';
import { lightShapeSupport, postStepSupport } from './shader-registry.js';
import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from './view-transform-names.js';
import { BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES, isEnvironmentReference, isCubeLookReference } from './look-catalog.js';
import { DEFAULT_LIGHTING_SETUP, LIGHTING_SETUP_NAMES, DEFAULT_AMBIENT_OCCLUSION } from './agent-scene-capabilities.js';

// Grid volumes resolve in the volumeGrid module, which loads when a recipe names shape "grid".
function resolveGridVolumeOnDemand(input, resolved, label) {
  return agentSceneModule('volumeGrid').resolveGridVolume(input, resolved, label);
}

// The emission ramp of a local volume resolves in the volumeRamp module, which loads when a recipe names emissionRamp.
function resolveEmissionRampOnDemand(input, shape, label) {
  return agentSceneModule('volumeRamp').resolveEmissionRamp(input, shape, label);
}

// The longest list in a look is the longest light list.
const MAX_LOOK_ARRAY_ENTRIES = Math.max(MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS);

const ENVIRONMENT_FIELDS = [
  'world', 'ground', 'setup', 'hdri', 'keyFromHdri', 'environmentIntensity', 'environmentRotation', 'lightDirection', 'keyColor', 'keyIntensity', 'fillIntensity', 'ambientIntensity', 'ambientColor', 'environmentDiffuseScale', 'skybox',
  'daylight', 'pointLights', 'spotLights', 'areaLights', 'skyTop', 'skyBottom', 'fogColor', 'fogDensity', 'volumeFog', 'localVolumes', 'liquid', 'shadowCascades', 'keyAffects', 'objectReflections', 'floorSkyTrace', 'sunBounce', 'specularAntiAliasing', 'sunAngularRadius', 'lines', 'resolveCoplanar', 'viewTransform', 'look', 'wind', 'sky', 'wetness', 'puddles',
];
const EFFECT_FIELDS = ['exposure', 'saturation', 'contrast', 'temperature', 'vignette', 'grain', 'dither', 'ambientOcclusion', 'ambientOcclusionRadius', 'bloom', 'depthOfField', 'motionBlur'];
const SHADOW_FIELDS = ['target', 'extent', 'distance', 'near', 'far', 'hard'];
const POINT_LIGHT_FIELDS = ['position', 'color', 'intensity', 'radius', 'range', 'castShadow', 'softFalloff', 'affects', 'parent'];
const SPOT_LIGHT_FIELDS = ['position', 'direction', 'angle', 'penumbra', 'color', 'intensity', 'radius', 'range', 'castShadow', 'softFalloff', 'ies', 'affects', 'parent'];
const AREA_LIGHT_FIELDS = ['position', 'direction', 'up', 'width', 'height', 'color', 'intensity', 'castShadow', 'ies', 'portal', 'affects', 'parent', 'face', 'faceOffset'];
const VOLUME_VECTOR_FIELDS = ['minimum', 'maximum', 'color', 'ambient', 'drift'];
const VOLUME_NUMBER_FIELDS = ['density', 'steps', 'anisotropy', 'noiseAmount', 'noiseScale', 'maxDistance', 'shadowAmbient', 'heightFalloff', 'detailOctaves', 'detailAmount', 'warp', 'contrast', 'profileSoftness', 'keyScattering', 'scatterOctaves', 'multiScatter', 'multiExtinction', 'multiAnisotropy', 'keyTransmittance', 'surfaceTransmittance', 'beamRadius'];
export const VOLUME_FOG_FIELDS = Object.freeze([...VOLUME_VECTOR_FIELDS, ...VOLUME_NUMBER_FIELDS]);
const BLOOM_FIELDS = ['strength', 'threshold', 'radius', 'keepHue'];
// Effect group fields that take true or false instead of a number.
const FLAG_GROUP_FIELDS = new Set(['keepHue']);
const DEPTH_OF_FIELD_FIELDS = ['blur', 'focusDistance'];
const MOTION_BLUR_FIELDS = ['shutter', 'objects'];
/** The nested effect groups set-effects merges field by field, with the fields each accepts. */
export const EFFECT_GROUP_FIELDS = Object.freeze({ bloom: BLOOM_FIELDS, depthOfField: DEPTH_OF_FIELD_FIELDS, motionBlur: MOTION_BLUR_FIELDS });
const MAXIMUM_SHADOW_CASCADES = 4;
const MAXIMUM_AFFECTED_NODES = 1024;

// Only a light that is linked carries the field, so recipes without links keep their exported shape.
function affectsFrom(light, label) {
  if (light.affects === undefined) {
    return {};
  }
  const names = light.affects;
  if (!Array.isArray(names) || names.length > MAXIMUM_AFFECTED_NODES || names.some(name => typeof name !== 'string' || name.length < 1 || name.length > 128)) {
    throw new TypeError(`${label} affects must be a list of at most ${MAXIMUM_AFFECTED_NODES} node IDs.`);
  }
  return { affects: [...names] };
}

function shadowCascadesFrom(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_SHADOW_CASCADES) {
    throw new RangeError(`environment.shadowCascades must be an integer from 1 to ${MAXIMUM_SHADOW_CASCADES}, or 0 for the single shadow map.`);
  }
  return value;
}

/** Whether any light of the environment is limited to a list of nodes. */
export function environmentLinksLights(environment) {
  const lights = [...(environment.pointLights ?? []), ...(environment.spotLights ?? []), ...(environment.areaLights ?? [])];
  return environment.keyAffects !== undefined || lights.some(light => light.affects !== undefined);
}


function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain JSON object.`);
  }
}

function knownKeys(value, fields, label) {
  plainObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${String(key)}. Use ${fields.join(', ')}.`);
    }
  }
}

// Domain resolvers accept ordinary values. Copy descriptors first so accessors never execute.
// A grid sequence (environment.localVolumes[].frames) may list as many names as local-volume-grid.js allows; keep this in step with VOLUME_GRID_SEQUENCE_MAX_FRAMES.
const MAX_FRAME_NAMES = 512;

function copiedJson(input, depth = 0, ancestors = new Set(), arrayLimit = MAX_LOOK_ARRAY_ENTRIES) {
  if (depth > 32) {
    throw new RangeError('Look JSON nesting exceeds 32 levels.');
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isFinite(Math.fround(input))) {
      throw new TypeError('Look JSON numbers must be finite Float32 values.');
    }
    return input;
  }
  if (!input || typeof input !== 'object' || ancestors.has(input)) {
    throw new TypeError('Look must contain acyclic plain JSON data.');
  }
  const array = Array.isArray(input);
  if (array && (Object.getPrototypeOf(input) !== Array.prototype || input.length > arrayLimit)) {
    throw new TypeError(`Look JSON arrays must be ordinary arrays with at most ${arrayLimit} entries.`);
  }
  if (!array) {
    plainObject(input, 'Look');
  }
  ancestors.add(input);
  const result = array ? [] : {};
  for (const key of Reflect.ownKeys(input)) {
    if (array && key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || key === '__proto__') {
      throw new TypeError('Look JSON keys must be ordinary strings.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Look JSON accessors and hidden fields are unsupported.');
    }
    if (array && key !== String(result.length)) {
      throw new TypeError('Look JSON arrays must be dense without extra fields.');
    }
    result[key] = copiedJson(descriptor.value, depth + 1, ancestors, key === 'frames' ? MAX_FRAME_NAMES : MAX_LOOK_ARRAY_ENTRIES);
  }
  if (array && result.length !== input.length) {
    throw new TypeError('Look JSON arrays cannot contain trailing holes.');
  }
  ancestors.delete(input);
  return result;
}

function exampleInRange(minimum, maximum) {
  if (minimum <= 1 && maximum >= 1) return '1';
  return String(minimum > 0 ? minimum : maximum);
}

function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) ||
      value < minimum || value > maximum) {
    const unbounded = minimum < -1e30 && maximum > 1e30;
    throw invalidField(label, value, unbounded ? 'a finite number, such as 0.5' : `a number from ${minimum} to ${maximum}, such as ${exampleInRange(minimum, maximum)}`);
  }
  return value;
}

function vectorInRange(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    const example = exampleInRange(minimum, maximum);
    throw invalidField(label, value, `an array of three numbers from ${minimum} to ${maximum}, such as [${example}, ${example}, ${example}]`, TypeError);
  }
  return value.map((component, index) => numberInRange(component, minimum, maximum, `${label}[${index}]`));
}

function fallback(value, defaultValue) {
  return value === undefined ? defaultValue : value;
}

function directionFrom(value, label = 'lightDirection') {
  const direction = vectorInRange(value, -1e6, 1e6, label);
  const length = Math.hypot(...direction);
  if (length < 1e-6) {
    throw invalidField(label, direction, 'a direction that is not all zero, such as [0, -1, 0]');
  }
  return { direction, unitDirection: direction.map(component => component / length) };
}

function lightListFrom(value, maximum, name) {
  const lights = fallback(value, []);
  if (!Array.isArray(lights) || lights.length > maximum) {
    const advice = Array.isArray(lights) ? `; ${lightLimitAdvice(name.split('.').pop())}` : '';
    throw invalidField(name, Array.isArray(lights) ? `${lights.length} entries` : lights, `an array of at most ${maximum} lights, such as []${advice}`);
  }
  return lights;
}

function rangeFrom(light) {
  const range = numberInRange(fallback(light.range, 0), 0, 1e6, 'range');
  if (range !== 0 && range < 0.001) {
    throw invalidField('range', range, '0 for unlimited, or at least 0.001, such as 10');
  }
  return range;
}

// A light carries castShadow or softFalloff (an oriented disk, as Blender's Soft Falloff) only when true, so recipes without them keep their exported shape.
function lightFlagFrom(light, name) {
  const flag = fallback(light[name], false);
  if (typeof flag !== 'boolean') {
    throw invalidField(name, flag, 'true or false', TypeError);
  }
  return flag ? { [name]: flag } : {};
}

const shadowFieldFrom = light => lightFlagFrom(light, 'castShadow');
const softFalloffFieldFrom = light => lightFlagFrom(light, 'softFalloff');

// A portal is a rect area light that marks a window: Cook draws sky light through it and it emits nothing itself.
function portalFieldFrom(light) {
  const flag = fallback(light.portal, false);
  if (typeof flag !== 'boolean') {
    throw invalidField('portal', flag, 'true to mark a window (a rect area light with width and height above 0), or false', TypeError);
  }
  return flag ? { portal: true } : {};
}

// With a parent the position is an offset in the parent's space, [0, 0, 0] (the parent's origin) when left out.
function positionFrom(light) {
  return vectorInRange(light.parent !== undefined && light.position === undefined ? [0, 0, 0] : light.position, -1e6, 1e6, 'position');
}

// parent, face and faceOffset belong to the lazy light-parenting module, which a recipe that names one loads first.
function parentingFieldsFrom(light, shape) {
  if (light.parent === undefined && light.face === undefined && light.faceOffset === undefined) return { parentFields: {}, surface: {} };
  const parenting = agentSceneModule('lightParenting');
  return { parentFields: parenting.parentFieldFrom(light), surface: shape === 'area' ? parenting.surfaceFieldsFrom(light, numberInRange) : {} };
}

function pointLightFrom(light) {
  knownKeys(light, POINT_LIGHT_FIELDS, 'point light');
  return {
    position: positionFrom(light),
    ...parentingFieldsFrom(light, 'point').parentFields,
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'intensity'),
    radius: numberInRange(fallback(light.radius, 0.05), 0.001, 1e6, 'radius'),
    range: rangeFrom(light),
    ...shadowFieldFrom(light),
    ...softFalloffFieldFrom(light),
    ...affectsFrom(light, 'point light'),
  };
}

// The cone angle is in radians, so a range error names the unit instead of a bare range an agent reads as degrees.
function spotAngleFrom(value) {
  try {
    return numberInRange(value, MINIMUM_SPOT_ANGLE, MAXIMUM_SPOT_ANGLE, 'angle');
  } catch {
    throw invalidField('angle', value, spotAngleExpectation(value));
  }
}

function spotLightFrom(light) {
  knownKeys(light, SPOT_LIGHT_FIELDS, 'spot light');
  return {
    position: positionFrom(light),
    ...parentingFieldsFrom(light, 'spot').parentFields,
    direction: directionFrom(light.direction, 'direction').direction,
    angle: spotAngleFrom(fallback(light.angle, Math.PI / 4)),
    penumbra: numberInRange(fallback(light.penumbra, 0.15), 0, 1, 'penumbra'),
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'intensity'),
    radius: numberInRange(fallback(light.radius, 0.05), 0.001, 1e6, 'radius'),
    range: rangeFrom(light),
    ...shadowFieldFrom(light),
    ...softFalloffFieldFrom(light),
    ...affectsFrom(light, 'spot light'),
  };
}

function areaLightFrom(light) {
  knownKeys(light, AREA_LIGHT_FIELDS, 'area light');
  const { parentFields, surface } = parentingFieldsFrom(light, 'area');
  const resolved = {
    ...(surface.face === undefined ? {
      position: positionFrom(light),
      direction: directionFrom(light.direction, 'direction').direction,
      width: numberInRange(light.width, 0.001, 1e4, 'width'),
      height: numberInRange(light.height, 0.001, 1e4, 'height'),
    } : {}),
    ...parentFields,
    ...surface,
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'intensity'),
  };
  if (light.up !== undefined) resolved.up = directionFrom(light.up, 'up').direction;
  return { ...resolved, ...portalFieldFrom(light), ...affectsFrom(light, 'area light') };
}

function volumeFogFrom(input = {}) {
  knownKeys(input, VOLUME_FOG_FIELDS, 'volumeFog');
  for (const field of VOLUME_VECTOR_FIELDS) {
    if (Object.hasOwn(input, field)) {
      vectorInRange(input[field], -1e5, 1e5, `volumeFog.${field}`);
    }
  }
  for (const field of VOLUME_NUMBER_FIELDS) {
    if (Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `volumeFog.${field}`);
    }
  }
  const resolved = resolveVolumeFog(input);
  resolveFogDetail(resolved);
  return copiedJson(resolved);
}

/** The fields a physical sky fills from its sun and haze that a recipe may still set itself: its own value wins over the sky's. */
export const SKY_OVERRIDABLE_FIELDS = Object.freeze(['keyColor', 'fogColor', 'fogDensity']);

function environmentFrom(input = {}) {
  knownKeys(input, ENVIRONMENT_FIELDS, 'environment');
  const world = fallback(input.world, false);
  if (typeof world !== 'boolean') {
    throw invalidField('environment.world', world, 'true or false', TypeError);
  }
  const setup = fallback(input.setup, DEFAULT_LIGHTING_SETUP);
  if (!LIGHTING_SETUP_NAMES.includes(setup)) {
    throw invalidField('environment.setup', setup, `one of ${LIGHTING_SETUP_NAMES.join(', ')}`);
  }
  const defaults = lightingSetupFields(setup);
  const environment = {
    world,
    setup,
    environmentIntensity: numberInRange(fallback(input.environmentIntensity, 1), 0, 100, 'environment.environmentIntensity'),
    environmentRotation: numberInRange(fallback(input.environmentRotation, 0), -100, 100, 'environment.environmentRotation'),
    lightDirection: directionFrom(fallback(input.lightDirection, defaults.lightDirection), 'environment.lightDirection').direction,
    keyColor: vectorInRange(fallback(input.keyColor, defaults.keyColor), 0, 1000, 'environment.keyColor'),
    keyIntensity: numberInRange(fallback(input.keyIntensity, defaults.keyIntensity), 0, 100, 'environment.keyIntensity'),
    fillIntensity: numberInRange(fallback(input.fillIntensity, defaults.fillIntensity), 0, 100, 'environment.fillIntensity'),
    ambientIntensity: numberInRange(fallback(input.ambientIntensity, defaults.ambientIntensity), 0, 100, 'environment.ambientIntensity'),
    daylight: numberInRange(fallback(input.daylight, 1), 0, 100, 'environment.daylight'),
    pointLights: lightListFrom(input.pointLights, MAX_POINT_LIGHTS, 'environment.pointLights').map((light, index) => withFieldPrefix(`environment.pointLights[${index}]`, () => pointLightFrom(light))),
    skyTop: vectorInRange(fallback(input.skyTop, defaults.skyTop), 0, 1, 'environment.skyTop'),
    skyBottom: vectorInRange(fallback(input.skyBottom, defaults.skyBottom), 0, 1, 'environment.skyBottom'),
    fogColor: vectorInRange(fallback(input.fogColor, [0.35, 0.43, 0.43]), 0, 1, 'environment.fogColor'),
    fogDensity: input.fogDensity === undefined || input.fogDensity === null ? null : numberInRange(input.fogDensity, 0, 10, 'environment.fogDensity'),
    volumeFog: volumeFogFrom(input.volumeFog),
  };
  // Optional so recipes without these fields keep their exported shape.
  if (input.ground !== undefined) {
    if (typeof input.ground !== 'boolean') {
      throw invalidField('environment.ground', input.ground, 'true or false', TypeError);
    }
    environment.ground = input.ground;
  }
  if (input.objectReflections !== undefined) {
    if (typeof input.objectReflections !== 'boolean') {
      throw invalidField('environment.objectReflections', input.objectReflections, 'true or false', TypeError);
    }
    environment.objectReflections = input.objectReflections;
  }
  // `false` opts out of the floor sky trace that src/floor-sky-visibility.js gives sun-lit closed rooms.
  if (input.floorSkyTrace !== undefined) {
    if (typeof input.floorSkyTrace !== 'boolean') {
      throw invalidField('environment.floorSkyTrace', input.floorSkyTrace, 'true or false', TypeError);
    }
    environment.floorSkyTrace = input.floorSkyTrace;
  }
  // Flat diffuse light added to the environment's (a Roblox OutdoorAmbient) and a scale on all of the environment's diffuse light (EnvironmentDiffuseScale); both absent keeps the exported shape and the picture.
  if (input.ambientColor !== undefined) {
    environment.ambientColor = vectorInRange(input.ambientColor, 0, 10, 'environment.ambientColor');
  }
  if (input.environmentDiffuseScale !== undefined) {
    environment.environmentDiffuseScale = numberInRange(input.environmentDiffuseScale, 0, 100, 'environment.environmentDiffuseScale');
  }
  // Six face images as the sky (src/skybox.js); the module checks the faces and loads on demand. null clears it.
  if (input.skybox !== undefined && input.skybox !== null) {
    if (input.hdri || input.sky) {
      throw invalidField('environment.skybox', 'set beside hdri or sky', 'a skybox alone: it is the sky, so remove "hdri" or "sky", or remove "skybox"');
    }
    environment.skybox = copiedJson(agentSceneModule('skybox').resolveSkybox(input.skybox, invalidField));
  }
  // Scales the light the sunlit patches of a sun-lit closed room bounce on (src/sun-bounce.js); 0 turns it off.
  if (input.sunBounce !== undefined) {
    if (!Number.isFinite(input.sunBounce) || input.sunBounce < 0) {
      throw invalidField('environment.sunBounce', input.sunBounce, 'a number of 0 or more, such as 1', TypeError);
    }
    environment.sunBounce = input.sunBounce;
  }
  // Strength of the specular anti-aliasing that widens highlights where normals or normal map detail change within a pixel (src/lighting.js); 0 turns it off.
  if (input.specularAntiAliasing !== undefined) {
    environment.specularAntiAliasing = numberInRange(input.specularAntiAliasing, 0, MAXIMUM_SPECULAR_ANTI_ALIASING, 'environment.specularAntiAliasing');
  }
  // Wet ground (src/wetness.js): wetness darkens porous surfaces and lowers their roughness, puddles pool sky-mirroring water; both are off when absent.
  if (input.wetness !== undefined) environment.wetness = normalizeWetness(input.wetness);
  if (input.puddles !== undefined) environment.puddles = normalizePuddles(input.puddles);
  // Outlines and line geometry; null clears them. The module checks the fields and loads on demand.
  if (input.lines !== undefined && input.lines !== null) {
    environment.lines = copiedJson(agentSceneModule('lineArt').resolveLineArt(input.lines));
  }
  if (input.resolveCoplanar !== undefined) {
    if (input.resolveCoplanar !== 'offset' && input.resolveCoplanar !== false) {
      throw invalidField('environment.resolveCoplanar', input.resolveCoplanar, "'offset' or false", TypeError);
    }
    environment.resolveCoplanar = input.resolveCoplanar;
  }
  if (input.spotLights !== undefined) {
    environment.spotLights = lightListFrom(input.spotLights, MAX_SPOT_LIGHTS, 'environment.spotLights').map((light, index) => withFieldPrefix(`environment.spotLights[${index}]`, () => spotLightFrom(light)));
  }
  if (input.areaLights !== undefined) {
    environment.areaLights = lightListFrom(input.areaLights, MAX_AREA_LIGHTS, 'environment.areaLights').map((light, index) => withFieldPrefix(`environment.areaLights[${index}]`, () => areaLightFrom(light)));
  }
  // Optional like the lights above, so a recipe without local volumes keeps its exported shape.
  if (input.localVolumes !== undefined) {
    environment.localVolumes = copiedJson(resolveLocalVolumesWith(resolveGridVolumeOnDemand, input.localVolumes, 'environment.localVolumes', resolveEmissionRampOnDemand));
  }
  if (input.shadowCascades !== undefined) {
    environment.shadowCascades = shadowCascadesFrom(input.shadowCascades);
  }
  if (input.wind !== undefined && input.wind !== null) environment.wind = agentSceneModule('vegetation').normalizeWind(input.wind);
  // A catalog HDRI replaces the procedural sky map. The setup still supplies the key light: set keyIntensity 0 when the HDRI has its own sun.
  if (input.hdri !== undefined && input.hdri !== null) {
    if (typeof input.hdri !== 'string' || !isEnvironmentReference(input.hdri)) {
      throw invalidField('environment.hdri', input.hdri, `one of ${BUNDLED_ENVIRONMENT_NAMES.join(', ')} or the 64-character ID of a .hdr file in the asset catalog`);
    }
    environment.hdri = input.hdri;
  }
  // The key light takes the HDRI's sun when the scene is built (agentEnvironmentKey), since the HDRI data loads after the recipe is checked.
  if (input.keyFromHdri !== undefined) {
    if (typeof input.keyFromHdri !== 'boolean') {
      throw invalidField('environment.keyFromHdri', input.keyFromHdri, 'true or false', TypeError);
    }
    if (input.keyFromHdri && !environment.hdri) {
      throw invalidField('environment.keyFromHdri', input.keyFromHdri, 'false, or true together with environment.hdri: set "hdri" to a catalog HDRI that has a sun');
    }
    if (input.keyFromHdri && input.sky) {
      throw invalidField('environment.keyFromHdri', input.keyFromHdri, 'false while environment.sky is set: the physical sky has its own sun, so remove "sky" or remove "keyFromHdri"');
    }
    environment.keyFromHdri = input.keyFromHdri;
  }
  if (input.viewTransform !== undefined) {
    if (!VIEW_TRANSFORM_NAMES.includes(input.viewTransform)) {
      throw invalidField('environment.viewTransform', input.viewTransform, `one of ${VIEW_TRANSFORM_NAMES.join(', ')}`);
    }
    environment.viewTransform = input.viewTransform;
  }
  if (input.look !== undefined && input.look !== null) {
    if (!LOOK_NAMES.includes(input.look) && !isCubeLookReference(input.look)) {
      throw invalidField('environment.look', input.look, `one of ${[...LOOK_NAMES, ...BUNDLED_CUBE_LOOK_NAMES].join(', ')} or the 64-character ID of a .cube file in the asset catalog`);
    }
    environment.look = input.look;
  }
  if (input.keyAffects !== undefined) {
    environment.keyAffects = affectsFrom({ affects: input.keyAffects }, 'environment keyAffects').affects;
  }
  if (input.liquid !== undefined) {
    knownKeys(input.liquid, Object.keys(LIQUID_OPTICS), 'liquid');
    environment.liquid = copiedJson(resolveLiquidOptics(copiedJson(input.liquid)));
  }
  if (input.sky !== undefined && input.sky !== null) {
    // The sky derives these from its sun; a value written beside the sky is a choice and stays.
    const explicit = Object.fromEntries(SKY_OVERRIDABLE_FIELDS.filter(field => input[field] !== undefined && input[field] !== null).map(field => [field, environment[field]]));
    agentSceneModule('physicalSky').applyPhysicalSky(input.sky, environment, invalidField);
    Object.assign(environment, explicit);
  }
  lightShapeSupport.normalize?.(input, environment);
  updateLightingState(createLightingState(), (environment.areaLights?.some(light => light.face !== undefined) ? agentSceneModule('lightParenting').withStandInLights(environment) : environment), { world });
  return environment;
}

/**
 * Setup-derived fields come with the setup name, so switching setups never keeps the old key light.
 * Fields in the patch itself still win.
 */
export function environmentPatchWithSetup(patch) {
  if (patch.setup === undefined) {
    return patch;
  }
  return { ...lightingSetupFields(patch.setup), ...patch };
}

const hdriSunSplits = new WeakMap();

// The HDRI of an environment that sets keyFromHdri, with its sun split out as splitHdriSun does for a scene file (#2875).
// Cached by map, so the pixel scan runs once for each map that createCatalogEnvironmentMap hands back.
function hdriSunSplit(environment) {
  const source = createCatalogEnvironmentMap(environment.hdri, { intensity: environment.environmentIntensity, rotation: environment.environmentRotation, showBackground: environment.world });
  if (!hdriSunSplits.has(source)) {
    hdriSunSplits.set(source, splitHdriSun(source));
  }
  const split = hdriSunSplits.get(source);
  if (!split) {
    throw new Error(`environment.keyFromHdri found no distinct sun in the HDRI ${environment.hdri.slice(0, 16)}: its brightest spot is not 20 times the sky average, as on an overcast sky. Pick an HDRI with a visible sun, or remove keyFromHdri and set lightDirection, keyColor and keyIntensity yourself.`);
  }
  return split;
}

function keysFromHdri(environment) {
  return Boolean(environment.keyFromHdri && environment.hdri && !environment.sky);
}

/**
 * The environment with its key light moved to the sun of its HDRI when `keyFromHdri` is set (`lightDirection`, `keyColor`
 * and `keyIntensity` from the sun, as a scene file takes them); any other environment is returned as it is. The HDRI must
 * be registered already, as for agentEnvironmentMap.
 */
export function agentEnvironmentKey(environment) {
  return keysFromHdri(environment) ? { ...environment, ...hdriSunSplit(environment).environment } : environment;
}

/** The procedural environment map that lights a normalized environment; the same object returns while inputs hold. */
export function agentEnvironmentMap(environment) {
  if (environment.skybox) {
    return agentSceneModule('skybox').createSkyboxMap(environment);
  }
  if (environment.sky) {
    return agentSceneModule('physicalSky').createPhysicalSkyMap(environment);
  }
  if (keysFromHdri(environment)) {
    return hdriSunSplit(environment).map;
  }
  if (environment.hdri) {
    return createCatalogEnvironmentMap(environment.hdri, { intensity: environment.environmentIntensity, rotation: environment.environmentRotation, showBackground: environment.world });
  }
  return createLightingSetupMap(environment.setup, {
    intensity: environment.environmentIntensity,
    rotation: environment.environmentRotation,
    showBackground: setupMapShowsBackground(environment),
  });
}

function effectsFrom(input = {}) {
  knownKeys(input, [...EFFECT_FIELDS, ...postStepSupport.fields], 'effects');
  const groupFields = { bloom: BLOOM_FIELDS, depthOfField: DEPTH_OF_FIELD_FIELDS, motionBlur: MOTION_BLUR_FIELDS };
  for (const field of EFFECT_FIELDS) {
    if (!(field in groupFields) && field !== 'dither' && Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `effects.${field}`);
    }
  }
  const groups = {};
  for (const [group, fields] of Object.entries(groupFields)) {
    groups[group] = fallback(input[group], {});
    knownKeys(groups[group], fields, group);
    for (const field of fields) {
      if (!Object.hasOwn(groups[group], field)) continue;
      if (FLAG_GROUP_FIELDS.has(field)) {
        if (typeof groups[group][field] !== 'boolean') throw new TypeError(`${group}.${field} must be true or false, got ${JSON.stringify(groups[group][field])}.`);
      } else {
        numberInRange(groups[group][field], -Number.MAX_VALUE, Number.MAX_VALUE, `${group}.${field}`);
      }
    }
  }
  const ambientOcclusion = fallback(input.ambientOcclusion, DEFAULT_AMBIENT_OCCLUSION);
  const resolved = resolveEffects({ ...input, ambientOcclusion, ...groups, bloom: { strength: 0.12, threshold: 1, radius: 1, ...groups.bloom } });
  return { ...resolved, exposure: numberInRange(fallback(input.exposure, 1), 0.01, 16, 'exposure'), ...postStepSupport.resolve?.(input) };
}

function shadowFrom(input = {}) {
  knownKeys(input, SHADOW_FIELDS, 'shadow');
  const shadow = {
    target: vectorInRange(fallback(input.target, [0, 1, 0]), -1e6, 1e6, 'shadow target'),
    extent: numberInRange(fallback(input.extent, 3.5), 0.01, 1e5, 'shadow extent'),
    distance: numberInRange(fallback(input.distance, 8), 0.01, 1e6, 'shadow distance'),
    near: numberInRange(fallback(input.near, 0.1), 0.001, 1e6, 'shadow near'),
    far: numberInRange(fallback(input.far, 15), 0.001, 1e6, 'shadow far'),
  };
  if (Math.fround(shadow.near) >= Math.fround(shadow.far)) {
    throw new RangeError('Shadow needs near < far at Float32 precision.');
  }
  if (input.hard !== undefined && typeof input.hard !== 'boolean') {
    throw new RangeError('shadow hard must be true or false. Pass hard: true for one-texel sun shadow edges, or leave it out for the soft filter.');
  }
  return input.hard ? { ...shadow, hard: true } : shadow;
}

function shadowBoundsFrom(shadow, direction) {
  const { unitDirection } = directionFrom(direction);
  const eye = shadow.target.map((component, axis) => component + unitDirection[axis] * shadow.distance);
  if (!eye.every(component => Number.isFinite(Math.fround(component))) ||
      eye.every((component, axis) => Math.fround(component) === Math.fround(shadow.target[axis]))) {
    throw new RangeError('Shadow eye and target must remain finite and distinguishable at Float32 precision.');
  }
  const up = Math.abs(unitDirection[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const view = mat4.lookAt(mat4.create(), eye, shadow.target, up);
  const projection = mat4.ortho(mat4.create(), -shadow.extent, shadow.extent, -shadow.extent, shadow.extent, shadow.near, shadow.far);
  const combined = mat4.multiply(mat4.create(), projection, view);
  for (const matrix of [view, projection, combined]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Shadow view, projection, and combined matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return { eye, target: [...shadow.target], up, extent: shadow.extent, near: shadow.near, far: shadow.far, ...(shadow.hard ? { hard: true } : {}) };
}

// A recipe that leaves `shadow` out gets a 7 m wide view around [0, 1, 0], and a bigger scene has no shadow data beyond it, so the sun reaches
// whatever lies outside (a sealed room 8 m wide came out as bright as one with a window, #1359). Such a scene gets a view fitted to its bounds, a
// little wider than they are. A scene wider than the largest view (the default world view's half width, 65 m) keeps the view as it was.
const SHADOW_FIT_PADDING = 1.1;
const LARGEST_FITTED_SHADOW_EXTENT = 65;
// A ground plane under a small subject must not stretch the view: a 1 m object on a 50 m plane would get a 40 m view and shadow texels 6 times
// larger than the default view gives it. A horizontal slab wider than this and at most 15 percent as thick as it is wide (bounds carry about 5 percent padding on each side) is left out of the fit
// when anything else is left (a room's 8 m floor stays in).
const GROUND_PLANE_MINIMUM_WIDTH = 10;
const GROUND_PLANE_THICKNESS_RATIO = 0.15;

function isGroundPlane(part) {
  const bounds = sceneBoundsOfParts([part]);
  if (!bounds) return false;
  const [width, height, depth] = bounds.maximum.map((value, axis) => value - bounds.minimum[axis]);
  const horizontal = Math.max(width, depth);
  return horizontal > GROUND_PLANE_MINIMUM_WIDTH && height <= horizontal * GROUND_PLANE_THICKNESS_RATIO;
}

function fitBoundsOf(parts) {
  const subjects = parts.filter(part => !isGroundPlane(part));
  return sceneBoundsOfParts(subjects.length > 0 ? subjects : parts);
}

/** The shadow a scene should use: the recipe's own when it set one, else a view fitted to the parts when they outgrow the default one. */
export function fitAgentShadow(shadow, parts) {
  const defaults = shadowFrom({});
  const isDefault = Object.keys(defaults).every(key => JSON.stringify(shadow[key]) === JSON.stringify(defaults[key]));
  if (!isDefault) return shadow;
  const bounds = sceneBoundsOfParts(parts) && fitBoundsOf(parts);
  if (!bounds) return shadow;
  const radius = Math.hypot(...bounds.maximum.map((value, axis) => value - bounds.minimum[axis])) / 2;
  const extent = radius * SHADOW_FIT_PADDING;
  if (!(extent > defaults.extent && extent <= LARGEST_FITTED_SHADOW_EXTENT)) return shadow;
  const target = bounds.maximum.map((value, axis) => (value + bounds.minimum[axis]) / 2);
  return { target, extent, distance: extent * 2.4, near: 1, far: extent * 5, ...(shadow.hard ? { hard: true } : {}) };
}

/** Derive a detached directional shadow projector from validated ordinary JSON. */
export function resolveAgentShadow(inputShadow = {}, inputDirection = [-3, 6, 4]) {
  const shadow = shadowFrom(copiedJson(inputShadow));
  const direction = copiedJson(inputDirection);
  return shadowBoundsFrom(shadow, direction);
}

/** Normalize the complete look without mutating caller input or sharing default arrays. */
export function normalizeAgentLook(input = {}) {
  knownKeys(input, ['environment', 'effects', 'shadow'], 'look');
  const copied = copiedJson(input);
  const environment = environmentFrom(copied.environment);
  const effects = effectsFrom(copied.effects);
  const shadow = shadowFrom(copied.shadow);
  shadowBoundsFrom(shadow, environment.lightDirection);
  return { environment, effects, shadow };
}
