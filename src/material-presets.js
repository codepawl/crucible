// Named material presets for blocky scenes (Roblox-style parts that carry a material name and a colour).
// A preset only fills material fields the recipe leaves out, so it is the same material a hand-written recipe would
// describe: patterns, roughness, emission and opacity. The part colour tints the base: patterns are grey ramps, so
// `color` sets their hue, and a preset without `color` falls back to its own tint.
// Pattern `size` is metres per repeat after node scale, so a 4 m and a 40 m part show the same grain size.

export const MATERIAL_PRESET_NAMES = Object.freeze(['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick']);

// Sparse upright blades: Voronoi cells squeezed four times along u so each is a tall sliver, kept only where the cell's random
// value passes a threshold (the rest is bare turf), each a sharpened dome that is bright at the core and dark at the rim, over a
// slow mottle. The ramp is grey from dark turf to bright blade tips, so the part colour tints it without turning it into fabric.
const BLADE_POSITION = Object.freeze({ mul: Object.freeze([Object.freeze({ uv: 'both' }), Object.freeze({ vec: Object.freeze([4, 1, 1]) })]) });
const BLADE_CELLS = Object.freeze({ voronoi: Object.freeze({ scale: 6, output: 'cell', at: BLADE_POSITION }) });
const BLADE_DOME = Object.freeze({ invert: Object.freeze({ voronoi: Object.freeze({ scale: 6, output: 'distance', at: BLADE_POSITION }) }) });
const BLADE_SHAPE = Object.freeze({ mul: Object.freeze([
  Object.freeze({ smoothstep: Object.freeze([0.3, 0.45, BLADE_CELLS]) }),
  Object.freeze({ pow: Object.freeze([BLADE_DOME, 2]) }),
]) });
const GRASS_TONE = Object.freeze({ add: Object.freeze([
  Object.freeze({ add: Object.freeze([0.2, Object.freeze({ mul: Object.freeze([Object.freeze({ noise: Object.freeze({ scale: 4, octaves: 2 }) }), 0.2]) })]) }),
  Object.freeze({ mul: Object.freeze([BLADE_SHAPE, 0.85]) }),
]) });
const GRASS_PATTERN = Object.freeze({
  type: 'graph', size: 0.6, bump: 1.1,
  graph: Object.freeze({
    color: Object.freeze({ ramp: Object.freeze({
      value: Object.freeze({ clamp: Object.freeze([GRASS_TONE, 0, 1]) }),
      stops: Object.freeze([Object.freeze([0, Object.freeze([0.1, 0.1, 0.1])]), Object.freeze([1, Object.freeze([1, 1, 1])])]),
    }) }),
    height: BLADE_SHAPE,
  }),
});

// Neon panel: the base colour map is near black so lighting adds no pastel wash, and emission is brightest in a band along the
// edge of each face (a lit tube frame) with a calmer face inside. The bright band is what the bloom pass lifts into a halo; a
// uniformly bright face bloomed far less in measurements (the halo came from pixels well above the threshold at the edge).
// The distance from the face centre is the larger of |u - 0.5| and |v - 0.5|; u and v are shifted by half a repeat so one repeat
// of `size` metres is centred on the part when the part is as wide as `size`.
const PANEL_DISTANCE = Object.freeze({ max: Object.freeze([
  Object.freeze({ abs: Object.freeze({ sub: Object.freeze([Object.freeze({ fract: Object.freeze({ add: Object.freeze([Object.freeze({ uv: 'u' }), 0.5]) }) }), 0.5]) }) }),
  Object.freeze({ abs: Object.freeze({ sub: Object.freeze([Object.freeze({ fract: Object.freeze({ add: Object.freeze([Object.freeze({ uv: 'v' }), 0.5]) }) }), 0.5]) }) }),
]) });
const NEON_PATTERN = Object.freeze({
  type: 'graph', size: 1,
  graph: Object.freeze({
    color: 0.12,
    emission: Object.freeze({ ramp: Object.freeze({
      value: PANEL_DISTANCE,
      stops: Object.freeze([[0, 1.1], [0.28, 1.1], [0.38, 4], [0.5, 4]].map(stop => Object.freeze(stop))),
    }) }),
  }),
});

// Glass edge light: Schlick's Fresnel as a factor of emission, so the faces seen at a grazing angle catch a bright edge.
const GLASS_EDGE_PATTERN = Object.freeze({
  type: 'graph', size: 1,
  graph: Object.freeze({ emission: Object.freeze({ mul: Object.freeze([Object.freeze({ fresnel: Object.freeze({ ior: 1.5 }) }), 6]) }) }),
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
    note: 'Short turf with sparse upright blades, bright at the core and dark at the rim, one repeat per 0.6 m, tinted by color.',
  }),
  neon: Object.freeze({
    color: Object.freeze([0.2, 1, 0.9]), roughness: 0.4, metallic: 0, emission: 1.5, glowsInColor: true,
    pattern: NEON_PATTERN,
    note: 'A glowing panel: emission 1.5 times a map with a bright tube frame along the edge of each face (4) and a calmer face inside (1.1), in a saturated version of the part colour (emissiveColor) over a near-black base. Pair it with effects.bloom { strength 1, threshold 0.8, radius 3 } for the halo and a point light of the same colour near it for the spill; the default bloom is faint. Set pattern.size to the part width for one frame per face.',
  }),
  glass: Object.freeze({
    color: Object.freeze([0.85, 0.95, 1]), roughness: 0.03, metallic: 0, opacity: 0.55, clearcoat: 1,
    transmission: 0.9, ior: 1.5, thickness: 0.05, pattern: GLASS_EDGE_PATTERN,
    note: 'Blended pane, opacity 0.55, that refracts what is behind it (transmission 0.9, ior 1.5, thickness 0.05), with a clear coat that mirrors the sky and a Fresnel edge light, tinted by color.',
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
