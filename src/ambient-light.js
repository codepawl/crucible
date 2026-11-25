// The colours of the two fill lights and of the flat ambient light, read from environment.fillColor and environment.ambientColor.
// One leaf module so the recipe reader (agent-look.js) and the renderer's lighting state (lighting.js) accept the same shapes.

// What the shader used before fillColor existed, outside world mode: a cool key-side fill and a pale blue-white one.
export const DEFAULT_FILL_COLORS = Object.freeze([Object.freeze([0.8, 2.0, 1.8]), Object.freeze([0.6, 0.7, 0.8])]);

/**
 * `fillColor` is one [r, g, b] for both fill lights or two of them, one per light. Returns [first, second].
 * `readVector(value, minimum, maximum, label)` validates one colour and returns it; its error names the field.
 */
export function fillColorsFrom(value, label, readVector) {
  const perLight = Array.isArray(value) && value.length === 2 && value.every(Array.isArray);
  if (perLight) return value.map((color, index) => readVector(color, 0, 100, `${label}[${index}]`));
  if (Array.isArray(value) && value.length === 3 && !value.some(Array.isArray)) {
    const color = readVector(value, 0, 100, label);
    return [color, color];
  }
  throw new TypeError(`${label} must be one colour [r, g, b] for both fill lights, or two colours [[r, g, b], [r, g, b]], one per fill light; got ${JSON.stringify(value)}`);
}

/**
 * `ambientColor` is one [r, g, b] or { sky: [r, g, b], ground: [r, g, b] } (surfaces facing up take the sky colour, down the ground colour).
 * Returns { sky, ground } where ground is null for the single colour.
 */
export function ambientColorsFrom(value, label, readVector) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (!value.sky || !value.ground || Object.keys(value).length !== 2) {
      throw new TypeError(`${label} as an object needs exactly "sky" and "ground", each [r, g, b]; got ${JSON.stringify(value)}`);
    }
    return { sky: readVector(value.sky, 0, 10, `${label}.sky`), ground: readVector(value.ground, 0, 10, `${label}.ground`) };
  }
  return { sky: readVector(value, 0, 10, label), ground: null };
}

/** `ambientMix`: 0 keeps the environment's own diffuse light, 1 lights with the flat ambient colour alone. */
export function ambientMixFrom(value, label, hasAmbientColor) {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    throw new RangeError(`${label} must be a number from 0 to 1 (0 keeps the HDRI diffuse light, 1 uses ambientColor alone); got ${JSON.stringify(value)}`);
  }
  if (value > 0 && !hasAmbientColor) throw new TypeError(`${label} ${value} needs environment.ambientColor: pass [r, g, b], or { sky, ground }, such as [0.64, 0.63, 0.68]`);
  return value;
}
