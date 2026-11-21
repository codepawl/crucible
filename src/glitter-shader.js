import { invalidField } from './field-error.js';
import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Stylized highlights of a water material: `waterGlint: { edge, sparkle }`. Both are off unless the field names them.
//   edge:    the sun glint redrawn with a hard edge: the soft lobe is taken out and the glint lobe is cut at `threshold` (0 to 1 of its peak), so the highlight is a flat
//            shape with a clean border that follows the waves, as Blinn-Phong specular followed by a step.
//   sparkle: glitter on the sun path. The water is cut into cells `size` metres wide. Each cell holds a tiny facet that tilts with the
//            wave under it and turns over time; it lights up when its mirror direction falls within `threshold` (cosine) of the
//            sun, so sparkles twinkle as the camera, the waves and the clock move, and none appear on the side away from the sun.
//            `density` is the share of cells that carry a facet, `shape` is a four-point star (the default) or a round dot.
// The GLSL lives here, outside world-material-shader.js, so a scene without the field never compiles it: the renderer asks for the
// `waterGlint` feature only when a part has the field, and importing this module (or loadAgentSceneModules) registers it.
// The code runs in the worldFinal slot, after the water mirror and refraction have been mixed, so the light is not mixed away.

export const WATER_GLINT_LIMITS = Object.freeze({
  edgeThreshold: Object.freeze({ minimum: 0.05, maximum: 0.95, default: 0.4 }),
  intensity: Object.freeze({ minimum: 0, maximum: 4, default: 1 }),
  density: Object.freeze({ minimum: 0, maximum: 1, default: 0.35 }),
  size: Object.freeze({ minimum: 0.02, maximum: 2, default: 0.12 }),
  sparkleThreshold: Object.freeze({ minimum: 0.9, maximum: 0.9999, default: 0.985 }),
  twinkle: Object.freeze({ minimum: 0, maximum: 8, default: 1 }),
});
export const WATER_GLINT_SHAPES = Object.freeze(['dot', 'star']);
const WATER_GLINT_FIELDS = ['edge', 'sparkle'];
const EDGE_FIELDS = ['threshold', 'intensity'];
const SPARKLE_FIELDS = ['density', 'size', 'threshold', 'shape', 'twinkle', 'intensity'];

const DECLARATIONS = `uniform vec4 waterGlintEdge;
uniform vec4 waterGlintSparkle;
uniform vec2 waterGlintLook;
float waterGlintHash(vec2 cell, float salt) {
  vec3 seed = fract(vec3(cell.xyx + salt) * 0.1031);
  seed += dot(seed, seed.yzx + 33.33);
  return fract((seed.x + seed.y) * seed.z);
}
// The sun glint lobe of the water surface, as the physical glint draws it.
float waterGlintLobe(vec3 surfaceNormal, vec3 viewDirection, vec3 sunDirection, float lostVariance) {
  vec3 halfVector = normalize(sunDirection + viewDirection);
  float sharpness = 1.0 / (1.0 / 500.0 + 0.35 * lostVariance);
  return pow(max(dot(surfaceNormal, halfVector), 0.0), sharpness);
}
// Glitter at a water position: 1 inside a sparkle shape whose facet mirrors the sun, 0 elsewhere. The facet normal is the wave
// normal at the cell centre (the wind ripples' slope there, moving with time) plus a tilt that turns around the vertical; that
// makes the lit cells shift with the waves and the camera. A cell under two pixels fades out, so far water does not shimmer.
float waterGlintSparkles(vec3 surfaceNormal, vec3 viewDirection, vec3 sunDirection, vec2 positionDx, vec2 positionDy) {
  float footprint = length(abs(positionDx) + abs(positionDy));
  float cellSize = waterGlintSparkle.y;
  float cellPixels = cellSize / max(footprint, 0.00001);
  float visible = smoothstep(1.5, 4.0, cellPixels);
  vec2 scaled = worldPosition.xz / cellSize;
  float edgeWidth = max(fwidth(scaled.x) + fwidth(scaled.y), 0.0001);
  if (visible <= 0.0) return 0.0;
  vec2 cell = floor(scaled);
  if (waterGlintHash(cell, 0.0) < 1.0 - waterGlintSparkle.x) return 0.0;
  vec2 offset = (vec2(waterGlintHash(cell, 1.0), waterGlintHash(cell, 2.0)) - 0.5) * 0.4;
  vec2 local = fract(scaled) - 0.5 - offset;
  float shape;
  if (waterGlintLook.x > 0.5) {
    float arm = min(abs(local.x), abs(local.y));
    float reach = 1.0 - smoothstep(0.1, 0.28 + edgeWidth, length(local));
    shape = reach * (1.0 - smoothstep(0.012, 0.03 + edgeWidth, arm));
    shape = max(shape, 1.0 - smoothstep(0.05 - edgeWidth, 0.05 + edgeWidth, length(local)));
  } else {
    shape = 1.0 - smoothstep(0.2 - edgeWidth, 0.2 + edgeWidth, length(local));
  }
  if (shape <= 0.0) return 0.0;
  vec2 centre = (cell + 0.5 + offset) * cellSize;
  float lost;
  vec2 slope = waterDetailSlope(centre, positionDx, positionDy, lost);
  vec2 pixelSlope = waterDetailSlope(worldPosition.xz, positionDx, positionDy, lost);
  vec3 smoothNormal = normalize(surfaceNormal - vec3(pixelSlope.x, 0.0, pixelSlope.y));
  float turn = 6.2831853 * (waterGlintHash(cell, 3.0) + time * waterGlintLook.y * (0.4 + waterGlintHash(cell, 4.0)));
  float tilt = 0.3 * sqrt(waterGlintHash(cell, 5.0));
  vec3 facet = normalize(smoothNormal + vec3(slope.x, 0.0, slope.y) + vec3(cos(turn), 0.0, sin(turn)) * tilt);
  float alignment = dot(reflect(-viewDirection, facet), sunDirection);
  float lit = step(waterGlintSparkle.z, alignment);
  return shape * lit * visible * (0.6 + 0.4 * waterGlintHash(cell, 6.0));
}
`;

const FINAL = `  if (TAG_WATER && (waterGlintEdge.x > 0.0 || waterGlintSparkle.w > 0.0)) {
    vec3 glintSun = normalize(lightDirection);
    vec3 glintTint = vec3(1.0, 0.92, 0.78) * keyResponse * (1.0 - waterFoam) * step(0.0, glintSun.y);
    if (waterGlintEdge.x > 0.0) {
      float lobe = waterGlintLobe(normal, viewDirection, glintSun, waterLostVariance);
      float edgeWidth = 1.5 * fwidth(lobe) + 0.01;
      // The physical glint drawn by the water code is taken out first, so the flat shape replaces the soft lobe instead of hiding in it.
      float glintFresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normalize(glintSun + viewDirection), viewDirection), 0.0), 5.0);
      radiance = max(radiance - vec3(1.0, 0.9, 0.7) * lobe * (0.5 + 40.0 * glintFresnel) * 6.0 * keyResponse * (1.0 - waterFoam), vec3(0.0));
      radiance += glintTint * smoothstep(waterGlintEdge.x - edgeWidth, waterGlintEdge.x + edgeWidth, lobe) * waterGlintEdge.y * 4.0;
    }
    if (waterGlintSparkle.w > 0.0) {
      radiance += glintTint * waterGlintSparkles(normal, viewDirection, glintSun, dFdx(worldPosition.xz), dFdy(worldPosition.xz)) * waterGlintSparkle.w * 12.0 * visibility;
    }
  }
`;

registerShaderFeatureCode('waterGlint', Object.freeze({ declarations: DECLARATIONS, worldFinal: FINAL }));

// Sends the glint settings of the batch about to draw; a batch without the field switches both parts off.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures?.has('waterGlint')) return;
  const { context, uniforms } = renderer;
  uniforms.waterGlintEdge ??= context.getUniformLocation(renderer.program, 'waterGlintEdge');
  uniforms.waterGlintSparkle ??= context.getUniformLocation(renderer.program, 'waterGlintSparkle');
  uniforms.waterGlintLook ??= context.getUniformLocation(renderer.program, 'waterGlintLook');
  const { edge, sparkle } = batch.waterGlint ?? {};
  context.uniform4f(uniforms.waterGlintEdge, edge?.threshold ?? 0, edge?.intensity ?? 0, 0, 0);
  context.uniform4f(uniforms.waterGlintSparkle, sparkle?.density ?? 0, sparkle?.size ?? 1, sparkle?.threshold ?? 1, sparkle?.intensity ?? 0);
  context.uniform2f(uniforms.waterGlintLook, sparkle?.shape === 'star' ? 1 : 0, sparkle?.twinkle ?? 0);
};

function requireObject(value, path, example) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, `an object, such as ${example}`, TypeError);
  }
}

function rejectUnknownKeys(value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${path}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

function numberWithin(value, path, { minimum, maximum, default: fallback }) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !(resolved >= minimum && resolved <= maximum)) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

function normalizeEdge(value) {
  requireObject(value, 'waterGlint.edge', '{ threshold: 0.4, intensity: 1 }');
  rejectUnknownKeys(value, 'waterGlint.edge', EDGE_FIELDS);
  const { edgeThreshold, intensity } = WATER_GLINT_LIMITS;
  return Object.freeze({
    threshold: numberWithin(value.threshold, 'waterGlint.edge.threshold', edgeThreshold),
    intensity: numberWithin(value.intensity, 'waterGlint.edge.intensity', intensity),
  });
}

function normalizeSparkle(value) {
  requireObject(value, 'waterGlint.sparkle', '{ density: 0.35, size: 0.12, shape: "star" }');
  rejectUnknownKeys(value, 'waterGlint.sparkle', SPARKLE_FIELDS);
  const shape = value.shape ?? 'star';
  if (!WATER_GLINT_SHAPES.includes(shape)) {
    throw invalidField('waterGlint.sparkle.shape', value.shape, `one of ${WATER_GLINT_SHAPES.join(', ')}, such as "star"`);
  }
  const limits = WATER_GLINT_LIMITS;
  return Object.freeze({
    density: numberWithin(value.density, 'waterGlint.sparkle.density', limits.density),
    size: numberWithin(value.size, 'waterGlint.sparkle.size', limits.size),
    threshold: numberWithin(value.threshold, 'waterGlint.sparkle.threshold', limits.sparkleThreshold),
    shape,
    twinkle: numberWithin(value.twinkle, 'waterGlint.sparkle.twinkle', limits.twinkle),
    intensity: numberWithin(value.intensity, 'waterGlint.sparkle.intensity', limits.intensity),
  });
}

/**
 * Validates a material `waterGlint` field and returns a frozen copy with every option of the parts it names filled in. A part left
 * out stays off. The field is for the water tag only; the recipe copier checks that.
 */
export function normalizeWaterGlint(value) {
  requireObject(value, 'waterGlint', '{ sparkle: { shape: "star" }, edge: { threshold: 0.4 } }');
  rejectUnknownKeys(value, 'waterGlint', WATER_GLINT_FIELDS);
  if (value.edge === undefined && value.sparkle === undefined) {
    throw invalidField('waterGlint', value, 'at least one of edge { threshold: 0.4 } or sparkle { shape: "star" }; remove waterGlint for the plain glint', TypeError);
  }
  const result = {};
  if (value.edge !== undefined) result.edge = normalizeEdge(value.edge);
  if (value.sparkle !== undefined) result.sparkle = normalizeSparkle(value.sparkle);
  return Object.freeze(result);
}
