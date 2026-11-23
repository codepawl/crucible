// Procedural material patterns in a pack. A pattern is baked to texture images when the recipe is built (src/material-patterns.js);
// the pack stores those images like any other texture, so the page needs no pattern code and `pattern` itself is not packed.
// This module imports nothing from agent-scene: it only reshapes a recipe and the built materials.

// Texture edge in texels a packed pattern may have, tried in order. Each pattern bakes up to three images (colour, normal,
// roughness and metal), and 256 is a quarter of the texels of the 512 default.
export const PACK_PATTERN_RESOLUTIONS = Object.freeze([512, 256]);
const DEFAULT_PATTERN_RESOLUTION = 512;

function hasPattern(recipe) {
  return (recipe.materials ?? []).some(material => material.pattern);
}

/** The recipe with every pattern baked at most `resolution` texels wide (a pattern already smaller keeps its size). */
export function recipeWithPatternResolution(recipe, resolution) {
  if (!hasPattern(recipe)) return recipe;
  return {
    ...recipe,
    materials: recipe.materials.map(material => {
      if (!material.pattern) return material;
      const own = material.pattern.resolution ?? DEFAULT_PATTERN_RESOLUTION;
      return { ...material, pattern: { ...material.pattern, resolution: Math.min(own, resolution) } };
    }),
  };
}

/**
 * The material as plain data for the pack: every field read once (so the baked textures exist) and without `pattern`,
 * because the runtime samples the textures and never evaluates the pattern.
 */
export function packedMaterial(material) {
  if (!material || !material.pattern) return material;
  const plain = {};
  for (const key of Object.keys(material)) {
    if (key === 'pattern') continue;
    plain[key] = material[key];
  }
  return plain;
}
