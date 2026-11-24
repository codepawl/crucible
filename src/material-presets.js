// Named material presets for blocky scenes (Roblox-style parts that carry a material name and a colour).
// A preset only fills material fields the recipe leaves out, so it is the same material a hand-written recipe would
// describe: patterns, roughness, emission and opacity. The part colour tints the base: patterns are grey ramps, so
// `color` sets their hue, and a preset without `color` falls back to its own tint.
// Pattern `size` is metres per repeat after node scale, so a 4 m and a 40 m part show the same grain size.

export const MATERIAL_PRESET_NAMES = Object.freeze(['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick']);

const MATERIAL_PRESETS = Object.freeze({
  smoothPlastic: Object.freeze({
    color: Object.freeze([0.7, 0.7, 0.7]), roughness: 0.28, metallic: 0,
    note: 'Smooth, slightly glossy solid colour with no pattern.',
  }),
  wood: Object.freeze({
    color: Object.freeze([0.75, 0.48, 0.25]), roughness: 0.8, metallic: 0,
    pattern: Object.freeze({ type: 'wood', size: 0.6, count: 12, bump: 0.35, colors: Object.freeze([[0.5, 0.5, 0.5], [1, 1, 1]]) }),
    note: 'Wood grain, one repeat per 0.6 m, tinted by color.',
  }),
  grass: Object.freeze({
    color: Object.freeze([0.3, 0.6, 0.18]), roughness: 1, metallic: 0,
    pattern: Object.freeze({ type: 'noise', size: 0.5, count: 12, bump: 0.5, colors: Object.freeze([[0.55, 0.55, 0.55], [1, 1, 1]]) }),
    note: 'Mottled turf for a solid block, one repeat per 0.5 m; it does not sway (the grass tag is for blades).',
  }),
  neon: Object.freeze({
    color: Object.freeze([0.2, 1, 0.9]), roughness: 0.4, metallic: 0, emission: 1.5,
    note: 'Glows in color (emission 1.5, bright enough to pass the bloom threshold). The glow halo comes from effects.bloom (on by default, strength 0.12): raise it for a stronger halo.',
  }),
  glass: Object.freeze({
    color: Object.freeze([0.85, 0.95, 1]), roughness: 0.04, metallic: 0, opacity: 0.3,
    note: 'Clear blended pane, opacity 0.3 and roughness 0.04, tinted by color.',
  }),
  brick: Object.freeze({
    color: Object.freeze([0.75, 0.35, 0.25]), roughness: 0.9, metallic: 0,
    pattern: Object.freeze({ type: 'bricks', size: 1, count: 4, bump: 1, colors: Object.freeze([[0.6, 0.6, 0.6], [0.95, 0.95, 0.95], [0.8, 0.8, 0.8]]) }),
    note: 'Courses of bricks, 4 across per 1 m repeat, mortar paler than the brick, tinted by color.',
  }),
});

export function materialPresetSummary() {
  return Object.fromEntries(MATERIAL_PRESET_NAMES.map(name => {
    const { note, ...fields } = MATERIAL_PRESETS[name];
    return [name, { ...fields, note }];
  }));
}

/**
 * Returns the material input with the preset's fields filled in under the fields the recipe already sets.
 * `fail` builds the error, so the message style stays the one of the scene contract.
 */
export function applyMaterialPreset(value, fail) {
  if (value.preset === undefined) return value;
  if (typeof value.preset !== 'string' || !Object.hasOwn(MATERIAL_PRESETS, value.preset)) {
    throw fail(value.preset, `one of ${MATERIAL_PRESET_NAMES.join(', ')}, or remove preset`);
  }
  const { note, ...fields } = MATERIAL_PRESETS[value.preset];
  const { preset, ...own } = value;
  const expanded = { ...own };
  for (const [field, fallback] of Object.entries(fields)) {
    if (expanded[field] !== undefined) continue;
    expanded[field] = structuredClone(fallback);
  }
  return expanded;
}
