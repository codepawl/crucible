// Named material presets for blocky scenes (Roblox-style parts that carry a material name and a colour).
// A preset only fills material fields the recipe leaves out, so it is the same material a hand-written recipe would
// describe: patterns, roughness, emission and opacity. The part colour tints the base: patterns are grey ramps, so
// `color` sets their hue, and a preset without `color` falls back to its own tint.
// Pattern `size` is metres per repeat after node scale, so a 4 m and a 40 m part show the same grain size.

export const MATERIAL_PRESET_NAMES = Object.freeze(['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick']);

// Short blades: Voronoi cells stretched four times along v, each with its own tone (cell) and a dome of height (distance), over fine noise.
const TUFT_POSITION = Object.freeze({ mul: Object.freeze([Object.freeze({ uv: 'both' }), Object.freeze({ vec: Object.freeze([1, 4, 1]) })]) });
const TUFT_CELLS = Object.freeze({ voronoi: Object.freeze({ scale: 14, output: 'cell', at: TUFT_POSITION }) });
const TUFT_DOME = Object.freeze({ invert: Object.freeze({ voronoi: Object.freeze({ scale: 14, output: 'distance', at: TUFT_POSITION }) }) });
const TUFT_TONE = Object.freeze({ add: Object.freeze([
  Object.freeze({ add: Object.freeze([Object.freeze({ mul: Object.freeze([TUFT_CELLS, 0.45]) }), Object.freeze({ mul: Object.freeze([TUFT_DOME, 0.35]) })]) }),
  Object.freeze({ mul: Object.freeze([Object.freeze({ noise: Object.freeze({ scale: 64 }) }), 0.2]) }),
]) });
const GRASS_PATTERN = Object.freeze({
  type: 'graph', size: 0.5, bump: 1,
  graph: Object.freeze({
    color: Object.freeze({ ramp: Object.freeze({
      value: Object.freeze({ clamp: Object.freeze([TUFT_TONE, 0, 1]) }),
      stops: Object.freeze([Object.freeze([0, Object.freeze([0.28, 0.28, 0.28])]), Object.freeze([1, Object.freeze([1, 1, 1])])]),
    }) }),
    height: Object.freeze({ add: Object.freeze([Object.freeze({ mul: Object.freeze([TUFT_DOME, 0.7]) }), Object.freeze({ mul: Object.freeze([TUFT_CELLS, 0.3]) })]) }),
  }),
});

const MATERIAL_PRESETS = Object.freeze({
  smoothPlastic: Object.freeze({
    color: Object.freeze([0.7, 0.7, 0.7]), roughness: 0.28, metallic: 0,
    note: 'Smooth, slightly glossy solid colour with no pattern.',
  }),
  wood: Object.freeze({
    color: Object.freeze([0.75, 0.48, 0.25]), roughness: 0.8, metallic: 0,
    pattern: Object.freeze({ type: 'wood', size: 0.8, count: 10, bump: 0.6, colors: Object.freeze([[0.25, 0.25, 0.25], [1, 1, 1]]) }),
    note: 'Wood grain, one repeat per 0.8 m, dark rings against light wood, tinted by color.',
  }),
  grass: Object.freeze({
    color: Object.freeze([0.3, 0.6, 0.18]), roughness: 1, metallic: 0,
    pattern: GRASS_PATTERN,
    note: 'Soft turf made of short upright tufts in two tones with some height, one repeat per 0.5 m, tinted by color.',
  }),
  neon: Object.freeze({
    tag: 'unlit', color: Object.freeze([0.2, 1, 0.9]), emission: 1.5, glowsInColor: true,
    note: 'Glows in the part colour (emission 1.5, emissiveColor = color, so the face stays saturated); the halo comes from effects.bloom and needs strength 0.3 or more to show (default 0.12 is faint).',
  }),
  glass: Object.freeze({
    color: Object.freeze([0.85, 0.95, 1]), roughness: 0.04, metallic: 0, opacity: 0.5, clearcoat: 1,
    note: 'Blended pane, opacity 0.5, roughness 0.04 and a clear coat that mirrors the sky, tinted by color.',
  }),
  brick: Object.freeze({
    color: Object.freeze([0.6, 0.14, 0.09]), roughness: 0.9, metallic: 0,
    pattern: Object.freeze({ type: 'bricks', size: 1, count: 4, bump: 1, colors: Object.freeze([[0.6, 0.6, 0.6], [0.95, 0.95, 0.95], [0.8, 0.8, 0.8]]) }),
    note: 'Courses of bricks, 4 across per 1 m repeat, mortar paler than the brick, tinted by color.',
  }),
});

export function materialPresetSummary() {
  return Object.fromEntries(MATERIAL_PRESET_NAMES.map(name => [name, structuredClone(MATERIAL_PRESETS[name])]));
}

/**
 * Returns the material input with the preset's fields filled in under the fields the recipe already sets.
 * `fail` builds the error, so the message style stays the one of the scene contract.
 */
export function applyMaterialPreset(value, fail) {
  if (typeof value.preset !== 'string' || !Object.hasOwn(MATERIAL_PRESETS, value.preset)) {
    throw fail(value.preset, `one of ${MATERIAL_PRESET_NAMES.join(', ')}, or remove preset`);
  }
  const { note, glowsInColor, ...fields } = MATERIAL_PRESETS[value.preset];
  const { preset, ...own } = value;
  const expanded = { ...own };
  for (const [field, fallback] of Object.entries(fields)) {
    if (expanded[field] === undefined) expanded[field] = structuredClone(fallback);
  }
  // Emission defaults to white light, which washes a coloured part out to near white, and tone mapping pales a bright face further:
  // glow in the part colour pushed toward its pure hue (largest channel 1, the others squared down), so the face stays coloured.
  if (glowsInColor && expanded.emissiveColor === undefined) {
    const brightest = Math.max(...expanded.color, 1e-6);
    expanded.emissiveColor = expanded.color.map(channel => (channel / brightest) ** 3);
  }
  return expanded;
}
