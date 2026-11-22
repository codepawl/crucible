/**
 * Realism checks: the measurable reasons a render looks fake. Each finding has the shape of `agent-diagnostics.js`
 * (kind, severity, target, message, fix), so `recipeDiagnostics` can list them next to the other diagnostics and
 * `scene_review` with `checks: "realism"` can group them by check. Thresholds and sources are in docs/agent-review.md.
 */

/** Linear luminance a plain surface may have. The low end is Epic's darkest recommended base colour, sRGB 30, which is 0.013 linear (charcoal is about 0.04). The high end is fresh snow on the PBR charts, about 0.8 to 0.9. */
export const ALBEDO_RANGE = Object.freeze({ minimum: 0.013, maximum: 0.9 });

// A metal's base colour is its reflectance at normal incidence, which is high by design, so metals are not checked.
const METAL_EXEMPT_AT = 0.5;
const SNOW_TOKENS = new Set(['snow', 'snowy', 'snowfield', 'snowdrift', 'frost']);
const GROUND_TOKENS = new Set(['ground', 'rock', 'rocks', 'rocky', 'grass', 'wood', 'wooden', 'soil', 'dirt', 'mud', 'bark']);
const METAL_TOKENS = new Set(['metal', 'metallic', 'steel', 'iron', 'brass', 'copper', 'gold', 'silver', 'chrome', 'aluminium', 'aluminum', 'bronze']);
// Tags whose colour is the surface albedo. The others tint light (water, liquid, foam) or are drawn as given (unlit).
const ALBEDO_TAGS = new Set(['surface', 'grass', 'foliage']);

export const FIX_BY_CHECK = Object.freeze({
  'albedo-out-of-range': `Keep the base colour between ${ALBEDO_RANGE.minimum} and ${ALBEDO_RANGE.maximum} in linear light (charcoal to fresh snow), and change the light instead.`,
  'metallic-on-dielectric': 'Set metallic to 0 on ground, rock, grass and wood; metallic is for bare metal.',
});

export function finding(kind, target, message, fix) {
  return { kind, severity: 'warning', target, message, fix };
}

/** Lowercase words of an id or label: "RockyGround_02" gives rocky and ground. */
function nameTokens(name) {
  if (typeof name !== 'string') return [];
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function linearLuminance([red, green, blue]) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function drawsItsOwnColour(material) {
  return material.pattern !== undefined || material.map !== undefined || material.transmission > 0 || material.emission > 0;
}

function isAlbedoChecked(material) {
  const tag = material.tag ?? 'surface';
  const metallic = material.metallic ?? 0;
  const tokens = nameTokens(material.id);
  return ALBEDO_TAGS.has(tag) && metallic < METAL_EXEMPT_AT && !drawsItsOwnColour(material)
    && Array.isArray(material.color) && !tokens.some(token => SNOW_TOKENS.has(token));
}

/** One warning per plain surface whose linear base colour is darker than charcoal or brighter than fresh snow. */
export function albedoDiagnostics(recipe) {
  return (recipe.materials ?? []).filter(isAlbedoChecked).flatMap(material => {
    const luminance = linearLuminance(material.color);
    const side = luminance < ALBEDO_RANGE.minimum ? 'darker than charcoal' : luminance > ALBEDO_RANGE.maximum ? 'brighter than fresh snow' : null;
    if (side === null) return [];
    return [finding('albedo-out-of-range', material.id,
      `Material ${material.id} has a linear base colour luminance of ${luminance.toFixed(3)}, ${side} (real surfaces sit from ${ALBEDO_RANGE.minimum} to ${ALBEDO_RANGE.maximum}).`,
      `${FIX_BY_CHECK['albedo-out-of-range']} Set it with scene_apply set-material, or name the material snow if it is snow.`)];
  });
}

function nodeNamesByMaterial(recipe) {
  const names = new Map();
  for (const node of recipe.nodes ?? []) {
    if (node.material === undefined) continue;
    const known = names.get(node.material) ?? [];
    known.push(node.id, node.label);
    names.set(node.material, known);
  }
  return names;
}

/** One warning per ground, rock, grass or wood material (by name, by a node that uses it or by its grass tag) with metallic above 0. */
export function metallicOnDielectricDiagnostics(recipe) {
  const namesByMaterial = nodeNamesByMaterial(recipe);
  return (recipe.materials ?? []).flatMap(material => {
    if (!(material.metallic > 0)) return [];
    const names = [material.id, ...(namesByMaterial.get(material.id) ?? [])];
    const tokens = names.flatMap(nameTokens);
    const isGroundLike = material.tag === 'grass' || tokens.some(token => GROUND_TOKENS.has(token));
    if (!isGroundLike || tokens.some(token => METAL_TOKENS.has(token))) return [];
    return [finding('metallic-on-dielectric', material.id,
      `Material ${material.id} is ground, rock, grass or wood but has metallic ${material.metallic}. These do not conduct, so a metallic surface renders as mirror-dark and shiny.`,
      `${FIX_BY_CHECK['metallic-on-dielectric']} Set it with scene_apply set-material.`)];
  });
}

/** Both material checks, for `recipeDiagnostics`. */
export function realismDiagnostics(recipe) {
  return [...albedoDiagnostics(recipe), ...metallicOnDielectricDiagnostics(recipe)];
}
