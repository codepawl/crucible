// Named material presets for blocky scenes (Roblox-style parts that carry a material name and a colour).
// A preset only fills material fields the recipe leaves out, so it is the same material a hand-written recipe would
// describe: patterns, roughness, emission and opacity. The part colour tints the base: patterns are grey ramps, so
// `color` sets their hue, and a preset without `color` falls back to its own tint.
// Pattern `size` is metres per repeat after node scale, so a 4 m and a 40 m part show the same grain size.

export const MATERIAL_PRESET_NAMES = Object.freeze(['smoothPlastic', 'wood', 'grass', 'glass', 'brick']);

// Sparse upright blades: Voronoi cells squeezed four times along u so each is a tall sliver, kept only where the cell's random
// value passes a threshold (the rest is bare turf), each a sharpened dome that is bright at the core and dark at the rim, over a
// slow mottle. Voronoi wraps every 1 of its input, so squeezing u repeats the pattern four times along u per tile: the tile is 5 m,
// so the repeat is 1.25 m, wider than a 1.2 m part, and a stretch along v would draw a hard line where the tile ends.
// The ramp is grey from dark turf to bright blade tips, so the part colour tints it without turning it into fabric.
const BLADE_POSITION = Object.freeze({ mul: Object.freeze([Object.freeze({ uv: 'both' }), Object.freeze({ vec: Object.freeze([4, 1, 1]) })]) });
const BLADE_CELLS = Object.freeze({ voronoi: Object.freeze({ scale: 50, output: 'cell', at: BLADE_POSITION }) });
const BLADE_DOME = Object.freeze({ invert: Object.freeze({ voronoi: Object.freeze({ scale: 50, output: 'distance', at: BLADE_POSITION }) }) });
// The gap between the nearest and second nearest point is 0 on the line between two cells; fading each blade to 0 there keeps the
// height continuous across the line (a blade next to bare turf used to step, and the normal map drew that step as a dark hairline).
const BLADE_GAP = Object.freeze({ voronoi: Object.freeze({ scale: 50, output: 'edge', at: BLADE_POSITION }) });
const BLADE_PRESENCE = Object.freeze({ mul: Object.freeze([
  Object.freeze({ smoothstep: Object.freeze([0.3, 0.45, BLADE_CELLS]) }),
  Object.freeze({ smoothstep: Object.freeze([0, 0.2, BLADE_GAP]) }),
]) });
const BLADE_SHAPE = Object.freeze({ mul: Object.freeze([BLADE_PRESENCE, Object.freeze({ pow: Object.freeze([BLADE_DOME, 2]) })]) });
const GRASS_TONE = Object.freeze({ add: Object.freeze([
  Object.freeze({ add: Object.freeze([0.36, Object.freeze({ mul: Object.freeze([Object.freeze({ noise: Object.freeze({ scale: 10, octaves: 2 }) }), 0.12]) })]) }),
  Object.freeze({ mul: Object.freeze([BLADE_SHAPE, 0.7]) }),
]) });
const GRASS_PATTERN = Object.freeze({
  type: 'graph', size: 5, bump: 0.9,
  graph: Object.freeze({
    color: Object.freeze({ ramp: Object.freeze({
      value: Object.freeze({ clamp: Object.freeze([GRASS_TONE, 0, 1]) }),
      stops: Object.freeze([Object.freeze([0, Object.freeze([0.2, 0.2, 0.2])]), Object.freeze([1, Object.freeze([1, 1, 1])])]),
    }) }),
    height: BLADE_SHAPE,
  }),
});

// Glass edge light: Schlick's Fresnel of a near-1 ior is about 0 face-on and rises only within a few pixels of a silhouette,
// so with a large emission factor it draws a thin bright rim and leaves the face clear. The factor is the `emission` field,
// not a number in the graph, because the graph's emission map is a texture that clamps at 1. Glaze drops emission on a
// material with transmission above 0 (#3279), so the preset has none and shows the backdrop through its opacity instead.
const GLASS_EDGE_PATTERN = Object.freeze({
  type: 'graph', size: 1,
  graph: Object.freeze({ emission: Object.freeze({ fresnel: Object.freeze({ ior: 1.01 }) }) }),
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
    color: Object.freeze([0.18, 0.5, 0.08]), roughness: 1, metallic: 0,
    pattern: GRASS_PATTERN,
    note: 'Short turf with sparse upright blades, bright at the core and dark at the rim, one repeat per 1.25 m across, so a part under 1.2 m shows no repeat, tinted by color.',
  }),
  glass: Object.freeze({
    color: Object.freeze([0.5, 0.8, 0.93]), roughness: 0.03, metallic: 0, opacity: 0.8, clearcoat: 1,
    emission: 7, pattern: GLASS_EDGE_PATTERN,
    note: 'Blended pane, opacity 0.8, that shows the backdrop through a tint, with a clear coat that mirrors the sky and a thin bright rim at the silhouette (Fresnel of ior 1.01 times emission 7, which keeps every channel under 255), tinted by color. It does not refract: set transmission, ior and thickness yourself for a bend, and the rim goes dark with transmission above 0.',
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
  const { note, ...fields } = MATERIAL_PRESETS[value.preset];
  const { preset, ...own } = value;
  const expanded = { ...own };
  for (const [field, fallback] of Object.entries(fields)) {
    if (expanded[field] === undefined) expanded[field] = structuredClone(fallback);
  }
  return expanded;
}
