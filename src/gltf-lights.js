import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';

const MAX_LIGHT_INTENSITY = 1e5;
const MAX_KEY_COLOR = 1000;
const MIN_SPOT_ANGLE = 0.01;
const MAX_SPOT_ANGLE = Math.PI / 2 - 0.01;
const DEFAULT_OUTER_CONE_ANGLE = Math.PI / 4;
const MIN_LIGHT_RANGE = 0.001;
// The sun's half-angle a directional light may carry in extras.sunAngularRadius (the range scene_set_sun accepts).
const MIN_SUN_ANGULAR_RADIUS = 0.0005;
const MAX_SUN_ANGULAR_RADIUS = 0.2;

function lightLabel(definition, index) {
  return definition.name ? `"${definition.name}"` : `light ${index}`;
}

function unitVector(vector) {
  const length = Math.hypot(...vector);
  return length > 0 && Number.isFinite(length) ? vector.map(value => value / length) : null;
}

function validColor(color) {
  return Array.isArray(color) && color.length === 3 && color.every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

function spotCone(definition) {
  const outer = definition.spot?.outerConeAngle ?? DEFAULT_OUTER_CONE_ANGLE;
  const inner = definition.spot?.innerConeAngle ?? 0;
  if (!Number.isFinite(outer) || !Number.isFinite(inner) || inner < 0 || inner >= outer || outer > Math.PI / 2) return null;
  const angle = Math.min(Math.max(outer, MIN_SPOT_ANGLE), MAX_SPOT_ANGLE);
  // The renderer blends the cone edge like Blender: penumbra is the share of the outer angle the fade covers.
  return { angle, penumbra: (outer - inner) / outer };
}

/** The sun's half-angle in radians that an exporter wrote to a directional light's extras, or undefined when it wrote none or a bad one. */
function readSunAngularRadius(definition, label, warnings) {
  const radius = definition.extras?.sunAngularRadius;
  if (radius === undefined) return undefined;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < MIN_SUN_ANGULAR_RADIUS || radius > MAX_SUN_ANGULAR_RADIUS) {
    warnings.push(`Ignored the sun size of ${label}: extras.sunAngularRadius must be a half-angle in radians from ${MIN_SUN_ANGULAR_RADIUS} to ${MAX_SUN_ANGULAR_RADIUS}.`);
    return undefined;
  }
  return radius;
}

/**
 * Maps KHR_lights_punctual onto the renderer's existing light options. Point lights and spot lights go to
 * pointLights and spotLights up to the renderer's limits. glTF intensity is candela for both, as in the renderer.
 * The renderer has one directional key light, so the first directional light sets keyColor and lightDirection, and
 * sunAngularRadius when its extras carry one (the soft edge of the sun's shadow).
 * A file with lights also returns fillIntensity 0, and keyIntensity 0 when it has no directional light.
 * Every light that does not fit is skipped with a warning.
 * @param {object} document the glTF JSON
 * @param {{ nodeIndex: number, matrix: ArrayLike<number> }[]} lightNodes nodes that reference a light, with their column-major world matrix
 * @returns {{ lights: object, warnings: string[] }} lights is a partial environment: pointLights, spotLights, keyColor, lightDirection, keyIntensity, fillIntensity
 */
export function readPunctualLights(document, lightNodes) {
  const definitions = document.extensions?.KHR_lights_punctual?.lights ?? [];
  const warnings = [];
  const pointLights = [];
  const spotLights = [];
  let key = null;
  for (const { nodeIndex, matrix } of lightNodes) {
    const lightIndex = document.nodes[nodeIndex].extensions.KHR_lights_punctual.light;
    const definition = definitions[lightIndex];
    if (!definition) {
      warnings.push(`Skipped the light of node ${nodeIndex}: KHR_lights_punctual has no light ${lightIndex}.`);
      continue;
    }
    const label = lightLabel(definition, lightIndex);
    const color = definition.color ?? [1, 1, 1];
    const intensity = definition.intensity ?? 1;
    if (!validColor(color) || !Number.isFinite(intensity) || intensity < 0) {
      warnings.push(`Skipped ${label}: its color or intensity is invalid.`);
      continue;
    }
    const position = [matrix[12], matrix[13], matrix[14]];
    // A scaled node stretches the matrix column, so the direction is rebuilt as a unit vector.
    const towardLight = unitVector([matrix[8], matrix[9], matrix[10]]);
    if (!towardLight && (definition.type === 'spot' || definition.type === 'directional')) {
      warnings.push(`Skipped ${label}: node ${nodeIndex} scales the light's direction to zero, so it points nowhere.`);
      continue;
    }
    const clampedIntensity = Math.min(intensity, MAX_LIGHT_INTENSITY);
    if (clampedIntensity !== intensity) warnings.push(`Clamped the intensity of ${label} to ${MAX_LIGHT_INTENSITY}.`);
    if (definition.type === 'directional') {
      if (key) {
        warnings.push(`Skipped directional ${label}: the renderer has one directional key light, already taken by ${key.label}.`);
        continue;
      }
      const scaled = color.map(value => Math.min(value * intensity, MAX_KEY_COLOR));
      const sunAngularRadius = readSunAngularRadius(definition, label, warnings);
      key = { label, keyColor: scaled, lightDirection: towardLight, keyIntensity: 1, sunAngularRadius };
      continue;
    }
    if (definition.type !== 'point' && definition.type !== 'spot') {
      warnings.push(`Skipped ${label}: light type ${definition.type} is not point, spot or directional.`);
      continue;
    }
    if (definition.range !== undefined && !Number.isFinite(definition.range)) {
      warnings.push(`Ignored the range of ${label}: it is not a number.`);
    }
    const range = Number.isFinite(definition.range) ? Math.max(definition.range, MIN_LIGHT_RANGE) : 0;
    const light = { position, color, intensity: clampedIntensity, range };
    if (definition.type === 'point') {
      if (pointLights.length >= MAX_POINT_LIGHTS) {
        warnings.push(`Skipped point ${label}: the renderer draws at most ${MAX_POINT_LIGHTS} point lights.`);
        continue;
      }
      pointLights.push(light);
      continue;
    }
    const cone = spotCone(definition);
    if (!cone) {
      warnings.push(`Skipped spot ${label}: its cone angles are invalid.`);
      continue;
    }
    if (spotLights.length >= MAX_SPOT_LIGHTS) {
      warnings.push(`Skipped spot ${label}: the renderer draws at most ${MAX_SPOT_LIGHTS} spot lights.`);
      continue;
    }
    spotLights.push({ ...light, direction: towardLight.map(value => -value), ...cone });
  }
  const lights = {};
  if (pointLights.length) lights.pointLights = pointLights;
  if (spotLights.length) lights.spotLights = spotLights;
  if (key) {
    lights.keyColor = key.keyColor;
    lights.lightDirection = key.lightDirection;
    lights.keyIntensity = key.keyIntensity;
    if (key.sunAngularRadius !== undefined) lights.sunAngularRadius = key.sunAngularRadius;
  } else if (pointLights.length || spotLights.length) {
    lights.keyIntensity = 0;
  }
  // A file that lights itself brings no studio light: the renderer's own key and fill lights are lamps the file does not
  // have, and they brighten and wash out the picture next to three.js and Cycles (#1178).
  if (Object.keys(lights).length) lights.fillIntensity = 0;
  return { lights, warnings };
}
