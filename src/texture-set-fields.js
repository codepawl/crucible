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
/** The UV transform fields: scale, offset and rotation of every map together, and the metres one tile covers. */
export const UV_TRANSFORM_FIELDS = Object.freeze(['uvScale', 'uvOffset', 'uvRotation', 'worldScale']);

/** Bounds of the UV transform fields, shared by the recipe check and the MCP schema. */
export const UV_TRANSFORM_LIMITS = Object.freeze({ scale: [0.001, 10000], offset: [-10000, 10000], rotation: [-360, 360], worldScale: [0.001, 100000] });

/**
 * The parallax fields of a material with a heightMap: the depth in metres of a texel at 0 (heightScale; absent or 0 leaves the
 * map undrawn), the distance in metres where the relief has faded back to plain normal mapping, and the ray steps. Shared by the
 * recipe check, the MCP schema and the renderer.
 */
export const HEIGHT_PARALLAX_FIELDS = Object.freeze(['heightScale', 'heightFade', 'heightSteps']);
export const HEIGHT_PARALLAX_LIMITS = Object.freeze({ scale: [0, 0.5], fade: [0.1, 1000], steps: [4, 32] });
export const HEIGHT_PARALLAX_DEFAULTS = Object.freeze({ fade: 12, steps: 16 });

/** Every material field of this feature: the six maps, the set that fills them, the normal convention, the parallax fields and the UV transform. */
export const TEXTURE_SET_RECIPE_FIELDS = Object.freeze([...TEXTURE_MAP_FIELDS, 'textureSet', 'normalConvention', ...HEIGHT_PARALLAX_FIELDS, ...UV_TRANSFORM_FIELDS]);
