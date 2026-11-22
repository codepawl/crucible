// The recipe material fields of scanned texture sets. Kept apart from texture-set-names.js (file name rules, capability text) because the
// scene core imports these few names and must not carry the rest.

/** The map roles a texture set holds, with the recipe field that takes each one's catalog image ID. */
export const TEXTURE_MAP_FIELD_BY_ROLE = Object.freeze({
  color: 'colorMap',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metallic: 'metallicMap',
  occlusion: 'occlusionMap',
  height: 'heightMap',
});

export const TEXTURE_MAP_FIELDS = Object.freeze(Object.values(TEXTURE_MAP_FIELD_BY_ROLE));
export const NORMAL_CONVENTIONS = Object.freeze(['opengl', 'directx']);
/** Every material field of this feature: the six maps, the set that fills them and the normal convention. */
export const TEXTURE_SET_RECIPE_FIELDS = Object.freeze([...TEXTURE_MAP_FIELDS, 'textureSet', 'normalConvention']);
