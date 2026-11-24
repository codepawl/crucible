// Camera effects stay off in every preset; a recipe turns them on with a blur above zero or a shutter above zero.
const CAMERA_OFF = Object.freeze({ depthOfField: Object.freeze({ blur: 0, focusDistance: 5 }), motionBlur: Object.freeze({ shutter: 0 }) });

export const EFFECT_PRESETS = Object.freeze({
  neutral: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 1, contrast: 1, temperature: 0, vignette: 0, grain: 0, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0, threshold: 1, radius: 1 }) }),
  cinematic: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 0.88, contrast: 1.08, temperature: 0.08, vignette: 0.16, grain: 0.012, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0.25, threshold: 1, radius: 1.5 }) }),
  vivid: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 1.15, contrast: 1.03, temperature: 0, vignette: 0.06, grain: 0, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0.3, threshold: 0.9, radius: 1.2 }) }),
});

function numberInRange(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

/** True when the final output gets the dither of one 8-bit step (#3258). Off unless a recipe sets `effects.dither: true`: it adds no light and no colour noise, but it makes PNG and MP4 files 2 to 4 times larger. The renderer asks only this. */
export function isDitherActive(effects) {
  return effects?.dither === true;
}

export const BLOOM_STRENGTH_MAX = 8;
export const BLOOM_RADIUS_MAX = 16;
// One blur pair spreads a glow cleanly up to this tap spacing (in half-resolution texels); a wider radius repeats the pair.
const BLOOM_STEP_LIMIT = 6;

/** How many horizontal and vertical blur pairs a bloom radius needs, and the tap spacing of each. A radius up to 6 is one pair at its own spacing, so every radius the old cap allowed (4) draws as before; a wider one adds pairs, because blur widths add in quadrature (#3283). */
export function bloomBlurPlan(radius) {
  const pairs = Math.max(1, Math.ceil((radius / BLOOM_STEP_LIMIT) ** 2 - 1e-9));
  return { pairs, step: radius / Math.sqrt(pairs) };
}

/** True when effects ask for a bloom pass. Strength 0 means bloom off: no extraction, blur or composite pass runs for it (#2025). The renderer asks only this. */
export function isBloomActive(effects) {
  return effects?.bloom?.strength > 0;
}

function bloomKeepsHue(value) {
  if (value === undefined || typeof value === 'boolean') return value === true;
  throw new TypeError(`Bloom keepHue must be true or false, got ${JSON.stringify(value)}.`);
}

export function resolveEffects(effects = {}) {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw new Error('Effects must be an object.');
  const bloom = effects.bloom ?? {};
  if (!bloom || typeof bloom !== 'object' || Array.isArray(bloom)) throw new Error('Bloom must be an object.');
  const depthOfField = effects.depthOfField ?? {};
  const motionBlur = effects.motionBlur ?? {};
  if (typeof depthOfField !== 'object' || Array.isArray(depthOfField)) throw new Error('Depth of field must be an object.');
  if (typeof motionBlur !== 'object' || Array.isArray(motionBlur)) throw new Error('Motion blur must be an object.');
  if (effects.dither !== undefined && typeof effects.dither !== 'boolean') throw new Error('Dither must be true or false: true stops gradient banding, false (default) keeps flat colour.');
  return {
    // `dither` appears only when it is on, so a scene that leaves it alone resolves and exports as before.
    ...(effects.dither === true ? { dither: true } : {}),
    depthOfField: {
      blur: numberInRange(depthOfField.blur, 0, 0, 1, 'Depth of field blur'),
      focusDistance: numberInRange(depthOfField.focusDistance, 5, 0.01, 100000, 'Depth of field focus distance'),
    },
    // `objects` (0 to 1, how much of each part's own motion to smear) appears only when set, so a scene without it resolves as before.
    motionBlur: { shutter: numberInRange(motionBlur.shutter, 0, 0, 0.5, 'Motion blur shutter'),
      ...(motionBlur.objects !== undefined && numberInRange(motionBlur.objects, 0, 0, 1, 'Motion blur objects') > 0 ? { objects: motionBlur.objects } : {}) },
    saturation: numberInRange(effects.saturation, 1, 0, 2, 'Saturation'),
    contrast: numberInRange(effects.contrast, 1, 0.1, 2, 'Contrast'),
    temperature: numberInRange(effects.temperature, 0, -1, 1, 'Temperature'),
    vignette: numberInRange(effects.vignette, 0, 0, 1, 'Vignette'),
    grain: numberInRange(effects.grain, 0, 0, 0.1, 'Grain'),
    ambientOcclusion: numberInRange(effects.ambientOcclusion, 0, 0, 1, 'Ambient occlusion'),
    ambientOcclusionRadius: numberInRange(effects.ambientOcclusionRadius, 0.5, 0.01, 100, 'Ambient occlusion radius'),
    bloom: {
      strength: numberInRange(bloom.strength, 0, 0, BLOOM_STRENGTH_MAX, 'Bloom strength'),
      threshold: numberInRange(bloom.threshold, 1, 0, 10, 'Bloom threshold'),
      radius: numberInRange(bloom.radius, 1, 0.1, BLOOM_RADIUS_MAX, 'Bloom radius'),
      // Opt-in: absent unless true, so every scene that does not ask resolves, and draws, as before (#3326).
      ...(bloomKeepsHue(bloom.keepHue) ? { keepHue: true } : {}),
    },
  };
}
