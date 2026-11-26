// Where the optional GLSL and JavaScript of the renderer's features is registered. Addon modules import this small
// module, not shaders.js, so an addon that only registers its code does not carry the renderer's whole shader text.

// A feature that is not in the list above has its GLSL in another module, so a scene that never uses it does not carry
// it. That module calls registerShaderFeatureCode on import, with blocks of GLSL that createFragmentShader splices in:
// declarations, illuminateReflectance, illuminateSpecular, coatReset and mainSetup, each ending in a newline, normalUv
// (a suffix on the normal map's UV, as in `textureUV * scale + offset`), and the
// one-line linkSun (a factor on the sun) with linkPoint, linkSpot and linkArea (statements that skip a light for a part).
// A feature that replaces the sun shadow defines shadowVisibility as a macro in its declarations.
export const registeredFeatureCode = new Map();

// material-layer-shaders.js sets bind(renderer, layerMaps): it binds the textures of material.layerMaps for one batch.
export const layerTextureSupport = {};

// water-reflection.js sets bind(renderer, uniforms, batch): it binds the mirror picture for a batch the liquid pass draws.
export const liquidWaterSupport = {};

// reflection-probes.js sets bind(renderer, uniforms, batch) and finish(renderer, uniforms): a batch the liquid pass draws reflects its probe.
export const liquidProbeSupport = {};

// view-transform-shader.js sets apply(source, kind, viewTransform, hasLook), bindLook(renderer, program) and dispose(renderer).
export const viewTransformShader = {};

// light-profile.js sets profile(ies), the 16 samples of a profile as an array. light-shapes.js sets update(state, spotLights, areaLights, environment) and normalize(input, environment): the lighting state and
// recipe hooks for area light shadows, IES profiles and the sun angle. update sets state.extraFeatures and state.bind.
export const lightShapeSupport = {};

// post-steps.js sets fields (the effects it adds to the look) and resolve(effects), which returns those effects resolved.
export const postStepSupport = { fields: [] };

// texture-update.js sets update(renderer, descriptor, update): the body of renderer.updateTexture.
export const textureUpdateSupport = {};

// replace-textured-parts.js sets begin(renderer) for replaceParts; it returns settle(previousBatches, nextBatches), which rolls back when called with no arguments.
export const texturedReplaceSupport = {};

// bloom-pyramid.js sets ensureTargets, releaseTargets, draw: the progressive mip pyramid for bloom.
export const bloomPyramidSupport = {};

// splat-shader.js sets the JavaScript half of the splat ground material: validate, textureBytes, resolveSize,
// packParameters and buildPixels. The renderer calls them only for a material with layers.
const splatSupport = {};

/**
 * The texture units of the splat samplers. Unit 13 belongs to the tinted shadow map, a 2D sampler, so no splat sampler sits on
 * it: an array sampler there makes every draw fail (#2272) and the weight mask would replace the tint texture (#2688).
 * The packed array sits on unit 17, past the irradiance grid on 16: WebGL2 allows units up to MAX_COMBINED_TEXTURE_IMAGE_UNITS
 * (at least 32) while the fragment shader reads at most MAX_TEXTURE_IMAGE_UNITS samplers.
 */
export const SPLAT_UNITS = Object.freeze({ splatColor: 11, splatNormal: 12, splatMask: 14, splatPacked: 17 });

/**
 * The parallax height map sits on the first unit after every registered one: the irradiance grid (a sampler3D) on 16 and the splat array
 * on 17, so a scene that has both with a height-mapped material never binds two sampler types to one unit. Derived from SPLAT_UNITS, the
 * highest, so a unit added there moves it (tests/sampler-units.test.js checks it against every unit constant in src/).
 */
export const HEIGHT_MAP_UNIT = Math.max(...Object.values(SPLAT_UNITS)) + 1;

/** The name of the parallax relief feature: its code is the lazy height-parallax-shader module. */
export const HEIGHT_MAP_FEATURE = 'heightMap';

export function registerSplatSupport(functions) {
  Object.assign(splatSupport, functions);
}

export function requireSplatSupport() {
  if (!splatSupport.validate) {
    throw new Error("Splat layers need their code: add import '@codepawlhq/crucible/addons/splat-shader'.");
  }
  return splatSupport;
}

/** Register the GLSL of an optional feature. Called by the module that holds it, on import. */
export function registerShaderFeatureCode(feature, slots) {
  registeredFeatureCode.set(feature, slots);
}

// height-parallax-shader.js sets rewrite(source), the main fragment shader's own source with every map read through the shifted UV,
// state(material, proceduralTags), the [heightMap, depth, fade, steps] of a material that draws its heightMap, and bind(context, uniforms, state, texture).
export const heightParallaxSupport = {};

/** The parallax code, or the error that names the import (the feature's own GLSL registers with it). */
export function requireHeightParallaxSupport() {
  requireFeatureCode(HEIGHT_MAP_FEATURE);
  return heightParallaxSupport;
}

// The addon that registers each feature's code; a feature not listed here is registered by material-layer-shaders.
const FEATURE_ADDONS = { heightMap: 'height-parallax-shader', splat: 'splat-shader', liquid: 'liquid-shader', worldMaterials: 'world-material-shader', subsurface: 'subsurface-shader', volumeFog: 'fog-shader', linearOutput: 'linear-output-shader', autoExposure: 'post-steps', keepHue: 'post-steps', retro: 'retro-shader', waterGlint: 'glitter-shader', surfaceCover: 'surface-cover' };

export function requireFeatureCode(feature) {
  if (typeof feature !== 'string' || feature.length === 0) {
    throw new Error(`A material snippet needs its registered feature name. Fix: pass the snippet through normalizeMaterialSnippet, or use material.snippet.feature from the normalized snippet.`);
  }
  const slots = registeredFeatureCode.get(feature);
  if (!slots) {
    const addon = FEATURE_ADDONS[feature] ?? 'material-layer-shaders';
    throw new Error(`The ${feature} feature needs its shader code: add import '@codepawlhq/crucible/addons/${addon}' (a recipe: await loadAgentSceneModules(recipe)).`);
  }
  return slots;
}


/** Value of `material.tag` in the instance data; the vegetation addon adds `impostor`. */
export const materialTags = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9, unlit: 10, liquid: 11, foam: 12 };

// Functions from source to source that startProgram applies to every shader before compiling it; the vegetation addon adds its card code here.
export const shaderTransforms = [];

/** The most morph targets one draw applies at once; the morph shader's weight array has this length. */
export const MAX_MORPH_TARGETS = 64;

/** The most morph targets one geometry stores. A draw applies the MAX_MORPH_TARGETS with the largest weights. */
export const MAX_STORED_MORPH_TARGETS = 256;

// skinning.js and morph.js set the JavaScript half of skinned and morphed parts: validation, texture layout and packing.
// The renderer calls them only for a part with a skin or morph targets, so a renderer without those parts never carries them.
export const deformationSupport = {};

export function registerDeformationSupport(functions) {
  Object.assign(deformationSupport, functions);
}

export function requireDeformationSupport(requiredFunction, file) {
  if (!deformationSupport[requiredFunction]) {
    throw new Error(`Skinned and morphed parts need their code: import ${file}, or a module that makes the pose (createSkinPose, createMorphPose, the glTF loader).`);
  }
  return deformationSupport;
}
