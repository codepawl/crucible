import { invalidField } from './field-error.js';
import { registerShaderFeatureCode, layerTextureSupport } from './shader-registry.js';
import { MATERIAL_LAYER_STATE_LENGTH } from './material-layers.js';

// Shader code for the toon material option. It lives outside shaders.js so a scene without banded light never carries it:
// the renderer asks for the `toon` feature only when a part has `toon` above 0, or when the line art addon turns on a
// default for every material (line-art.js).
//
// toonLight turns the cosine of a light into steps. Each light the material receives is stepped on its own, so a
// scene with a sun and a lamp shows two sets of bands. `materialToon` is the step count of the material and
// `toonDefault` the count for a material that sets none; 0 in both leaves the smooth light. The edge between steps is
// 0.02 of the light range wide, which antialiases without derivatives (those are undefined in the light loops).
//
// A material with `toonColors` has one colour per step, darkest first. toonStepColor picks the colour of the step the
// light falls in, blending with the step below across the same narrow edge, and illuminate multiplies the light by it in
// place of the grey step level, so the darkest step can be a tint rather than black. The side facing away from a light
// gets no direct light at all, so it shows the ambient light.
//
// `toonEdge` picks the edge between steps: 0 the soft edge (default), 1 a hard step, 2 a hard step after an ordered
// Bayer 4 by 4 threshold moves each pixel's light by up to half a step either way, so the edge becomes a pattern of pixels.

const TOON_SOFTNESS = '0.02';

export const MAX_TOON_STEPS = 8;

export const TOON_RIM_DEFAULTS = Object.freeze({
  color: Object.freeze([1, 1, 1]),
  strength: 1,
  power: 3,
});

export const TOON_RIM_LIMITS = Object.freeze({
  color: Object.freeze([0, 4]),
  strength: Object.freeze([0, 4]),
  power: Object.freeze([0.5, 12]),
});

export const TOON_BASE_DEFAULTS = Object.freeze({
  color: Object.freeze([0.65, 0.82, 1]),
  strength: 0.5,
});

export const TOON_BASE_LIMITS = Object.freeze({
  color: Object.freeze([0, 4]),
  strength: Object.freeze([0, 2]),
});

const TOON_RIM_FIELDS = Object.freeze(['color', 'strength', 'power']);
const TOON_BASE_FIELDS = Object.freeze(['color', 'strength']);
const normalizedRimValues = new WeakSet();
const normalizedBaseValues = new WeakSet();

function requirePlainObject(value, path, example) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, `an object, such as ${example}`, TypeError);
  }
}

function rejectUnknownFields(value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${path}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

function readColorTriple(value, path, fallback, [minimum, maximum]) {
  if (value === undefined) return Object.freeze([...fallback]);
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalidField(path, value, `three linear RGB numbers from ${minimum} to ${maximum}, such as [${fallback.join(', ')}]`, TypeError);
  }
  const channels = value.map((component, index) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw invalidField(`${path}[${index}]`, component, `a finite number from ${minimum} to ${maximum}`, TypeError);
    }
    if (component < minimum || component > maximum) {
      throw invalidField(`${path}[${index}]`, component, `a number from ${minimum} to ${maximum}`);
    }
    return component;
  });
  return Object.freeze(channels);
}

function readBoundedNumber(value, path, fallback, [minimum, maximum]) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidField(path, value, `a finite number from ${minimum} to ${maximum}, such as ${fallback}`, TypeError);
  }
  if (value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return value;
}

function requireToonSteps(toon, field) {
  if (toon !== undefined && !(toon > 0)) {
    throw invalidField(field, toon, `toon above 0 on the material (got toon ${toon ?? 0}); set toon to 6 or remove ${field}`);
  }
}

/** Validates a material `toonRim` object and returns a frozen normalized copy. */
export function normalizeToonRim(value, toon) {
  requireToonSteps(toon, 'toonRim');
  if (normalizedRimValues.has(value)) return value;
  requirePlainObject(value, 'toonRim', '{ color: [1, 0.98, 0.92], strength: 1.5, power: 3 }');
  rejectUnknownFields(value, 'toonRim', TOON_RIM_FIELDS);
  const normalized = Object.freeze({
    color: readColorTriple(value.color, 'toonRim.color', TOON_RIM_DEFAULTS.color, TOON_RIM_LIMITS.color),
    strength: readBoundedNumber(value.strength, 'toonRim.strength', TOON_RIM_DEFAULTS.strength, TOON_RIM_LIMITS.strength),
    power: readBoundedNumber(value.power, 'toonRim.power', TOON_RIM_DEFAULTS.power, TOON_RIM_LIMITS.power),
  });
  normalizedRimValues.add(normalized);
  return normalized;
}

/** Validates a material `toonBase` object and returns a frozen normalized copy. */
export function normalizeToonBase(value, toon) {
  requireToonSteps(toon, 'toonBase');
  if (normalizedBaseValues.has(value)) return value;
  requirePlainObject(value, 'toonBase', '{ color: [0.65, 0.82, 1], strength: 0.5 }');
  rejectUnknownFields(value, 'toonBase', TOON_BASE_FIELDS);
  const normalized = Object.freeze({
    color: readColorTriple(value.color, 'toonBase.color', TOON_BASE_DEFAULTS.color, TOON_BASE_LIMITS.color),
    strength: readBoundedNumber(value.strength, 'toonBase.strength', TOON_BASE_DEFAULTS.strength, TOON_BASE_LIMITS.strength),
  });
  normalizedBaseValues.add(normalized);
  return normalized;
}

/** Copies and validates `toonColors`, `toonRim`, and `toonBase` fields onto a normalized material. */
export function copyToon(source, target, vector) {
  if (source.toonColors !== undefined) {
    target.toonColors = Array.isArray(source.toonColors)
      ? Object.freeze(source.toonColors.map((color, index) => Object.freeze(vector(color, 3, `toonColors[${index}]`))))
      : source.toonColors;
  }
  const toonSteps = target.toon ?? 0;
  if (source.toonRim !== undefined && source.toonRim !== null) {
    target.toonRim = normalizeToonRim(source.toonRim, toonSteps);
  }
  if (source.toonBase !== undefined && source.toonBase !== null) {
    target.toonBase = normalizeToonBase(source.toonBase, toonSteps);
  }
}

function smoothstepRange(edgeLow, edgeHigh, value) {
  const unit = Math.min(1, Math.max(0, (value - edgeLow) / (edgeHigh - edgeLow)));
  return unit * unit * (3 - 2 * unit);
}

function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length <= 0) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/** CPU reference for the sun-gated Fresnel rim factor in `toonRim`. */
export function toonRimFactor(normal, viewDirection, sunDirection, power = TOON_RIM_DEFAULTS.power) {
  const unitNormal = normalizeVector(normal);
  const unitView = normalizeVector(viewDirection);
  const unitSun = normalizeVector(sunDirection);
  const normalView = Math.max(dotProduct(unitNormal, unitView), 0);
  const grazing = Math.max(1 - normalView, 0);
  const fresnel = Math.pow(grazing, power);
  const sunGate = smoothstepRange(-0.15, 0.55, dotProduct(unitNormal, unitSun));
  return fresnel * sunGate;
}

/** CPU reference for the downward normal factor in `toonBase`. */
export function toonBaseFactor(worldNormalY) {
  return smoothstepRange(0.1, 0.75, -worldNormalY);
}

/** CPU reference RGB contribution of `toonRim` at a shading point. */
export function evaluateToonRim(normal, viewDirection, sunDirection, rim) {
  if (!rim) return [0, 0, 0];
  const normalized = normalizeToonRim(rim);
  if (normalized.strength <= 0) return [0, 0, 0];
  const factor = toonRimFactor(normal, viewDirection, sunDirection, normalized.power) * normalized.strength;
  return normalized.color.map(channel => channel * factor);
}

/** CPU reference RGB contribution of `toonBase` for a downward normal Y component. */
export function evaluateToonBase(worldNormalY, base) {
  if (!base) return [0, 0, 0];
  const normalized = normalizeToonBase(base);
  if (normalized.strength <= 0) return [0, 0, 0];
  const factor = toonBaseFactor(worldNormalY) * normalized.strength;
  return normalized.color.map(channel => channel * factor);
}

const TOON_DECLARATIONS = `uniform float materialToon;
uniform float toonDefault;
uniform float materialToonColored;
uniform vec3 materialToonColors[${MAX_TOON_STEPS}];
uniform float materialToonEdge;
uniform vec4 materialToonRim;
uniform float materialToonRimPower;
uniform vec4 materialToonBase;
const float BAYER_4[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float toonScaledLight(float light, float bands) {
  float scaled = clamp(light, 0.0, 1.0) * bands;
  if (materialToonEdge < 1.5) return scaled;
  ivec2 cell = ivec2(mod(gl_FragCoord.xy, 4.0));
  float threshold = (BAYER_4[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  return clamp(scaled + threshold, 0.0, bands);
}
float toonStepEdge(float scaled, float band, float bands) {
  if (materialToonEdge > 0.5) return scaled > band ? 1.0 : 0.0;
  return smoothstep(0.0, ${TOON_SOFTNESS} * bands, scaled - band);
}
float toonLight(float light) {
  float bands = materialToon > 0.0 ? materialToon : toonDefault;
  if (bands <= 0.0) return light;
  float scaled = toonScaledLight(light, bands);
  float band = floor(scaled);
  return (band + toonStepEdge(scaled, band, bands)) / bands;
}
vec3 toonStepColor(float light) {
  float scaled = toonScaledLight(light, materialToon);
  float band = floor(scaled);
  int top = int(min(band, materialToon - 1.0));
  if (top == 0) return materialToonColors[0];
  float blend = band >= materialToon ? 1.0 : toonStepEdge(scaled, band, materialToon);
  return mix(materialToonColors[top - 1], materialToonColors[top], blend);
}
`;

const TOON_WORLD_LIGHT = `  if (materialToonRim.a > 0.0) {
    vec3 toonSunDirection = normalize(lightDirection);
    float toonRimFresnel = pow(max(1.0 - max(dot(normal, viewDirection), 0.0), 0.0), materialToonRimPower);
    float toonRimSunGate = smoothstep(-0.15, 0.55, dot(normal, toonSunDirection));
    radiance += materialToonRim.rgb * (materialToonRim.a * toonRimFresnel * toonRimSunGate);
  }
  if (materialToonBase.a > 0.0) {
    float toonBaseMask = smoothstep(0.1, 0.75, -normalize(worldNormal).y);
    radiance += materialToonBase.rgb * (materialToonBase.a * toonBaseMask);
  }
`;

registerShaderFeatureCode('toon', Object.freeze({
  declarations: TOON_DECLARATIONS,
  illuminateReflectance: `  if (materialToonColored > 0.5) {
    radiance *= toonStepColor(normalLight);
    normalLight = 1.0;
  } else {
    normalLight = toonLight(normalLight);
  }
`,
  worldLight: TOON_WORLD_LIGHT,
}));

const TOON_COLORS_STATE_INDEX = MATERIAL_LAYER_STATE_LENGTH - 2;
const TOON_EDGE_STATE_INDEX = MATERIAL_LAYER_STATE_LENGTH - 1;
const parsedColorsByState = new Map();

function toonColorValues(colorsState) {
  if (!parsedColorsByState.has(colorsState)) {
    const values = new Float32Array(MAX_TOON_STEPS * 3);
    values.set(JSON.parse(colorsState).flat());
    parsedColorsByState.set(colorsState, values);
  }
  return parsedColorsByState.get(colorsState);
}

function uniformOf(renderer, name) {
  renderer.uniforms[name] ??= renderer.context.getUniformLocation(renderer.program, name);
  return renderer.uniforms[name];
}

function bindToonRimAndBase(renderer, material) {
  const { context } = renderer;
  if (typeof context.uniform4f !== 'function') return;
  const rim = material?.toonRim ? normalizeToonRim(material.toonRim) : null;
  const base = material?.toonBase ? normalizeToonBase(material.toonBase) : null;
  if (rim) {
    context.uniform4f(uniformOf(renderer, 'materialToonRim'), rim.color[0], rim.color[1], rim.color[2], rim.strength);
    context.uniform1f(uniformOf(renderer, 'materialToonRimPower'), rim.power);
  } else {
    context.uniform4f(uniformOf(renderer, 'materialToonRim'), 0, 0, 0, 0);
    context.uniform1f(uniformOf(renderer, 'materialToonRimPower'), TOON_RIM_DEFAULTS.power);
  }
  if (base) {
    context.uniform4f(uniformOf(renderer, 'materialToonBase'), base.color[0], base.color[1], base.color[2], base.strength);
  } else {
    context.uniform4f(uniformOf(renderer, 'materialToonBase'), 0, 0, 0, 0);
  }
}

// Other optional features also bind per batch, so this keeps whatever was registered first.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures?.has('toon')) return;
  const colorsState = layerState[TOON_COLORS_STATE_INDEX];
  renderer.context.uniform1f(uniformOf(renderer, 'materialToonColored'), colorsState ? 1 : 0);
  if (colorsState) renderer.context.uniform3fv(uniformOf(renderer, 'materialToonColors'), toonColorValues(colorsState));
  renderer.context.uniform1f(uniformOf(renderer, 'materialToonEdge'), layerState[TOON_EDGE_STATE_INDEX]);
  bindToonRimAndBase(renderer, batch?.parts?.[0]?.material);
};
