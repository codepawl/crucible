import { createImage } from './material-texture-kit.js';
import { geometryBoundingSphere } from './render-culling.js';
import { HEIGHT_MAP_UNIT, lightShapeSupport, registerShaderFeatureCode, shaderTransforms } from './shader-registry.js';
import { WET_SHORE_MINIMUM_SOFTNESS } from './wetness-shader.js';

// Cavity and mask puddle sources (extension of src/wetness.js). Kept out of the core bundle so scenes that stay dry
// or use only `from: "height"` pay zero bytes and compile the exact same shader as before.

export const PUDDLE_MASK_UNIT = HEIGHT_MAP_UNIT + 1;
export const PUDDLE_CAVITY_FEATURE = 'puddleCavity';
export const PUDDLE_MASK_FEATURE = 'puddleMask';

const PUDDLE_SOURCE_IDS = Object.freeze({ height: 0, cavity: 1, mask: 2 });
const ASSET_ID = /^[a-f0-9]{64}$/;
const CLAMP_TO_EDGE = 33071;
const FLAT_THICKNESS_RATIO = 0.02;
const LEVEL_TOLERANCE = 0.05;

const registeredMasks = new Map();
const maskDescriptors = new Map();
const rawFrameDescriptors = new WeakMap();
const programLocations = new WeakMap();
const rendererBoundsCache = new WeakMap();

const PUDDLE_DEPTH_ANCHOR = '      float puddleDepth = wetBasin(worldPosition, detailFade) - wetnessState.y - 6.0 * (worldPosition.y - wetnessState.w) - 0.3 * (1.0 - smoothstep(0.2, 1.0, clearance));';
const EDGE_WIDTH_ANCHOR = `      float edgeWidth = max(2.0 * fwidth(puddleDepth), ${WET_SHORE_MINIMUM_SOFTNESS});`;

/** Registers a decoded catalog mask image (`{ width, height, data }`) under its 64-character asset ID. */
export function registerPuddleMask(id, decoded) {
  if (typeof id !== 'string') return;
  const normalized = id.toLowerCase();
  if (!ASSET_ID.test(normalized) || !decoded) return;
  registeredMasks.set(normalized, decoded);
}

/** Registers a mask ID from a decoded sequence/catalog pool (`Map`) when present. */
export function registerMaskFromPool(id, pool) {
  if (typeof id !== 'string' || !pool) return;
  const normalized = id.toLowerCase();
  const decoded = pool.get(normalized);
  if (decoded) registerPuddleMask(normalized, decoded);
}

function partWorldBounds(part) {
  if (part.skin || part.morph || part.crowd || !part.matrix) return null;
  const box = geometryBoundingSphere(part.geometry);
  const matrix = part.matrix;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? box.maximum[0] : box.minimum[0];
    const y = corner & 2 ? box.maximum[1] : box.minimum[1];
    const z = corner & 4 ? box.maximum[2] : box.minimum[2];
    for (let axis = 0; axis < 3; axis++) {
      const world = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], world);
      maximum[axis] = Math.max(maximum[axis], world);
    }
  }
  return [...minimum, ...maximum].every(Number.isFinite) ? { minimum, maximum } : null;
}

/** World XZ footprint `[minX, minZ, maxX, maxZ]` of the ground plane for mapping `environment.puddles.mask`. */
export function groundMaskBounds(parts) {
  let widestFootprint = 0;
  let widestBounds = null;
  const entries = [];
  for (const part of parts) {
    const bounds = partWorldBounds(part);
    if (!bounds) continue;
    const widthX = bounds.maximum[0] - bounds.minimum[0];
    const widthZ = bounds.maximum[2] - bounds.minimum[2];
    const footprint = widthX * widthZ;
    const wider = Math.max(widthX, widthZ);
    const flat = wider > 0 && (bounds.maximum[1] - bounds.minimum[1]) <= wider * FLAT_THICKNESS_RATIO;
    entries.push({ bounds, footprint, flat });
    if (footprint > widestFootprint) {
      widestFootprint = footprint;
      widestBounds = bounds;
    }
  }
  if (!widestBounds) return [-1, -1, 1, 1];
  const groundHeight = widestBounds.maximum[1];
  let minX = widestBounds.minimum[0];
  let minZ = widestBounds.minimum[2];
  let maxX = widestBounds.maximum[0];
  let maxZ = widestBounds.maximum[2];
  for (const { bounds, flat } of entries) {
    if (!flat || Math.abs(bounds.maximum[1] - groundHeight) > LEVEL_TOLERANCE) continue;
    minX = Math.min(minX, bounds.minimum[0]);
    minZ = Math.min(minZ, bounds.minimum[2]);
    maxX = Math.max(maxX, bounds.maximum[0]);
    maxZ = Math.max(maxZ, bounds.maximum[2]);
  }
  if (maxX <= minX) {
    minX -= 1;
    maxX += 1;
  }
  if (maxZ <= minZ) {
    minZ -= 1;
    maxZ += 1;
  }
  return [minX, minZ, maxX, maxZ];
}

function cachedMaskBounds(renderer) {
  const parts = renderer.fitParts ?? [];
  const cached = rendererBoundsCache.get(renderer);
  if (cached && cached.parts === parts) return cached.bounds;
  const bounds = groundMaskBounds(parts);
  rendererBoundsCache.set(renderer, { parts, bounds });
  return bounds;
}

function resolveMaskDescriptor(mask) {
  if (typeof mask === 'string') {
    const normalized = mask.toLowerCase();
    const frame = registeredMasks.get(normalized);
    if (!frame) {
      throw new Error(`environment.puddles.mask (${normalized.slice(0, 12)}) was not loaded. The host decodes catalog images before createAgentScene or apply (or call registerPuddleMask).`);
    }
    const cached = maskDescriptors.get(normalized);
    if (cached && cached.frame === frame) return cached.descriptor;
    const descriptor = { image: createImage(frame.data, frame.width, frame.height), colorSpace: 'linear', wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE };
    maskDescriptors.set(normalized, { frame, descriptor });
    return descriptor;
  }
  if (mask && typeof mask === 'object') {
    if (mask.image) return mask;
    if (Number.isInteger(mask.width) && Number.isInteger(mask.height) && mask.data) {
      let descriptor = rawFrameDescriptors.get(mask);
      if (!descriptor) {
        descriptor = { image: createImage(mask.data, mask.width, mask.height), colorSpace: 'linear', wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE };
        rawFrameDescriptors.set(mask, descriptor);
      }
      return descriptor;
    }
  }
  throw new TypeError('environment.puddles.mask must be a loaded 64-character catalog image ID or texture descriptor.');
}

function locationsFor(context, program) {
  let locations = programLocations.get(program);
  if (!locations) {
    locations = {
      source: context.getUniformLocation(program, 'puddleSource'),
      mask: context.getUniformLocation(program, 'puddleMask'),
      bounds: context.getUniformLocation(program, 'puddleMaskBounds'),
    };
    programLocations.set(program, locations);
  }
  return locations;
}

function bindPuddleSource(renderer, environment) {
  if (!renderer.shaderFeatures?.has(PUDDLE_CAVITY_FEATURE) && !renderer.shaderFeatures?.has(PUDDLE_MASK_FEATURE)) return;
  const context = renderer.context;
  const locations = locationsFor(context, renderer.program);
  const from = environment.puddles?.from ?? 'height';
  if (locations.source !== null) {
    context.uniform1f(locations.source, PUDDLE_SOURCE_IDS[from] ?? 0);
  }
  if (locations.mask !== null) {
    const activeMask = from === 'mask' && environment.puddles?.mask !== undefined;
    const texture = activeMask ? renderer.createTexture(resolveMaskDescriptor(environment.puddles.mask)) : renderer.whiteTexture;
    context.uniform1i(locations.mask, PUDDLE_MASK_UNIT);
    context.activeTexture(context.TEXTURE0 + PUDDLE_MASK_UNIT);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.activeTexture(context.TEXTURE0);
    if (locations.bounds !== null) {
      const [minX, minZ, maxX, maxZ] = cachedMaskBounds(renderer);
      context.uniform4f(locations.bounds, minX, minZ, maxX, maxZ);
    }
  }
}

function cavitySnippet(parallaxed) {
  const aoSampleRead = parallaxed
    ? 'mappedSample(occlusionMap, hasOcclusionMap).r'
    : '(BOX_MAPPED ? sampleBox(occlusionMap) : texture(occlusionMap, mapUV(hasOcclusionMap))).r';
  return `        if (USES_OCCLUSION_MAP) {
          float aoSample = mix(1.0, ${aoSampleRead}, occlusionStrength);
          float aoCavity = smoothstep(0.05, 0.65, 1.0 - aoSample);
          float macroBasin = wetBasin(worldPosition, detailFade) - 0.5;
          puddleSignal = mix(0.25, 0.95, aoCavity) + 0.14 * macroBasin;
          puddleEdgeCap = 0.12;
        } else {
          float stoneCrevice = smoothstep(0.62, 0.25, stoneHeight);
          float splatCrevice = smoothstep(0.95, 0.60, splatCavity);
          float skyCrevice = smoothstep(0.95, 0.55, vertexSkyVisibility);
          float fallbackCrevice = max(splatCrevice, skyCrevice);
          puddleSignal = 0.75 * wetBasin(worldPosition, detailFade) + 0.35 * stoneCrevice + 0.35 * fallbackCrevice - 0.12;
        }`;
}

function puddleDepthReplacement(hasCavity, hasMask, parallaxed) {
  const branches = [];
  if (hasMask) {
    branches.push(`      if (puddleSource > 1.5) {
        vec2 maskUv = clamp((worldPosition.xz - puddleMaskBounds.xy) / max(puddleMaskBounds.zw - puddleMaskBounds.xy, vec2(0.0001)), 0.0, 1.0);
        puddleSignal = texture(puddleMask, maskUv).r;
        puddleEdgeCap = 0.12;
      }`);
  }
  if (hasCavity) {
    const head = branches.length > 0 ? ' else if (puddleSource > 0.5) {' : '      if (puddleSource > 0.5) {';
    branches.push(`${head}\n${cavitySnippet(parallaxed)}\n      }`);
  }
  const heightBranch = `${branches.length > 0 ? ' else {\n' : ''}        puddleSignal = wetBasin(worldPosition, detailFade);${branches.length > 0 ? '\n      }' : ''}`;
  return `      float puddleSignal = 0.0;
      float puddleEdgeCap = 1.0;
${branches.join('')}${heightBranch}
      float puddleDepth = puddleSignal - wetnessState.y - 6.0 * (worldPosition.y - wetnessState.w) - 0.3 * (1.0 - smoothstep(0.2, 1.0, clearance));`;
}

/** Rewrites a compiled fragment shader that carries `puddleCavity` or `puddleMask` to dispatch across puddle sources. */
export function rewriteWetnessPuddles(source) {
  const hasCavity = source.includes('#define PUDDLE_CAVITY');
  const hasMask = source.includes('uniform sampler2D puddleMask;');
  if ((!hasCavity && !hasMask) || !source.includes(PUDDLE_DEPTH_ANCHOR)) return source;
  const parallaxed = source.includes('vec4 mappedSample(');
  const withUniform = source.replace('uniform vec4 wetnessState;', () => 'uniform vec4 wetnessState;\nuniform float puddleSource;');
  const withDepth = withUniform.replace(PUDDLE_DEPTH_ANCHOR, () => puddleDepthReplacement(hasCavity, hasMask, parallaxed));
  return withDepth.replace(EDGE_WIDTH_ANCHOR, () => `      float edgeWidth = clamp(2.0 * fwidth(puddleDepth), ${WET_SHORE_MINIMUM_SOFTNESS}, puddleEdgeCap);`);
}

function updatePuddleSource(state, environment) {
  const puddles = environment?.puddles;
  const from = puddles?.from ?? 'height';
  if (from === 'mask') {
    const wetness = environment.wetness ?? 0;
    const coverage = puddles?.coverage ?? 0;
    state.wetnessState[1] = wetness > 0 && coverage > 0 ? 0.95 - 0.8 * coverage * wetness * wetness : 0;
  }
  const previousFeatures = state.extraFeatures ?? [];
  const previousBind = state.bind;
  if (state.wetness > 0 && state.wetnessState[1] > 0) {
    const feature = from === 'cavity' ? PUDDLE_CAVITY_FEATURE : from === 'mask' ? PUDDLE_MASK_FEATURE : null;
    if (feature && !previousFeatures.includes(feature)) {
      state.extraFeatures = [...previousFeatures, feature];
    }
  }
  state.bind = renderer => {
    previousBind?.(renderer);
    bindPuddleSource(renderer, environment);
  };
}

let baseLightUpdate = lightShapeSupport.update;

function combinedLightUpdate(state, spotLights, areaLights, environment) {
  if (baseLightUpdate) {
    baseLightUpdate(state, spotLights, areaLights, environment);
  } else {
    state.extraFeatures = undefined;
    state.bind = undefined;
  }
  updatePuddleSource(state, environment);
}

registerShaderFeatureCode(PUDDLE_CAVITY_FEATURE, Object.freeze({
  declarations: '#define PUDDLE_CAVITY 1\n',
}));
registerShaderFeatureCode(PUDDLE_MASK_FEATURE, Object.freeze({
  declarations: 'uniform sampler2D puddleMask;\nuniform vec4 puddleMaskBounds;\n',
}));
shaderTransforms.push(rewriteWetnessPuddles);
Object.defineProperty(lightShapeSupport, 'update', {
  configurable: true,
  enumerable: true,
  get() {
    return combinedLightUpdate;
  },
  set(value) {
    if (value !== combinedLightUpdate) baseLightUpdate = value;
  },
});
