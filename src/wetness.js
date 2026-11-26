import { invalidField } from './field-error.js';
import { puddleFillLevel } from './wetness-shader.js';

// Wet ground from one environment value: `environment.wetness` (0 to 1) darkens porous surfaces and lowers their roughness,
// and `environment.puddles` pools flat water that mirrors the sky, on at most a quarter of the ground (PUDDLE_SHARE_CAP). Both are absent by default, and a scene without them
// compiles none of the wetness shader (src/wetness-shader.js). The realtime rasterizer draws it; the path tracers do not.

export const WETNESS_RANGE = /* @__PURE__ */ Object.freeze([0, 1]);
/** The share of the ground that standing water covers at coverage 1 and wetness 1: the rest stays road, so puddles never flood it. */
export const PUDDLE_SHARE_CAP = 0.25;
export const PUDDLE_SOURCES = /* @__PURE__ */ Object.freeze(['height', 'cavity', 'mask']);
export const PUDDLE_DEFAULTS = /* @__PURE__ */ Object.freeze({ coverage: 0.5, from: 'height' });

const PUDDLE_FIELDS = ['coverage', 'from', 'mask'];

/** Validate `environment.wetness` and return it. */
export function normalizeWetness(value) {
  if (typeof value !== 'number' || !(value >= WETNESS_RANGE[0] && value <= WETNESS_RANGE[1])) {
    throw invalidField('environment.wetness', value, 'a number from 0 (dry) to 1 (soaked), such as 0.5 for damp ground; null clears it', TypeError);
  }
  return value;
}

/** Validate `environment.puddles` and return a frozen copy with the defaults filled in. */
export function normalizePuddles(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField('environment.puddles', value, 'an object such as {"coverage": 0.5, "from": "height"}; null clears it', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!PUDDLE_FIELDS.includes(key)) {
      throw invalidField(`environment.puddles.${key}`, value[key], `one of the fields ${PUDDLE_FIELDS.join(', ')}; remove ${key}`, TypeError);
    }
  }
  const coverage = value.coverage ?? PUDDLE_DEFAULTS.coverage;
  if (typeof coverage !== 'number' || !(coverage >= 0 && coverage <= 1)) {
    throw invalidField('environment.puddles.coverage', value.coverage, 'a number from 0 (no puddles) to 1 (a quarter of the ground under water), such as 0.5', TypeError);
  }
  const from = value.from ?? PUDDLE_DEFAULTS.from;
  if (!PUDDLE_SOURCES.includes(from)) {
    throw invalidField('environment.puddles.from', from, 'one of "height", "cavity", or "mask"', TypeError);
  }
  const mask = value.mask;
  if (from === 'mask') {
    if (typeof mask !== 'string' || !/^[a-f0-9]{64}$/i.test(mask)) {
      throw invalidField('environment.puddles.mask', mask, '64 hexadecimal chars (catalog ID, no URLs)', TypeError);
    }
    return Object.freeze({ coverage, from, mask: mask.toLowerCase() });
  }
  if (mask !== undefined) {
    throw invalidField('environment.puddles.mask', mask, 'nothing when from is not "mask"', TypeError);
  }
  return Object.freeze({ coverage, from });
}

/**
 * How wet the surface looks for a wetness value: the first half of the range does most of the work (0.5 gives 0.75), because
 * a scan of wet asphalt is already dark and glossy once it is damp. Wet ground goes from dry to soaked on this curve.
 */
export function wetnessResponse(wetness) {
  return 1 - (1 - wetness) * (1 - wetness);
}

/** The share of the ground under standing water: the cap times the coverage times the wetness squared, so damp ground gets a few puddles. */
export function puddleShare(wetness, coverage) {
  return PUDDLE_SHARE_CAP * coverage * wetness * wetness;
}

/**
 * The four numbers the wetness shader reads: the wetness response, the fill level that floods the share of the ground
 * (0 when there are no puddles), a slot the renderer fills with its keep-out box count and one for the ground plane height.
 */
export function wetnessUniformValues(environment) {
  const wetness = environment.wetness ?? 0;
  const share = puddleShare(wetness, environment.puddles?.coverage ?? 0);
  return [wetnessResponse(wetness), share > 0 ? puddleFillLevel(share) : 0, 0, 0];
}
