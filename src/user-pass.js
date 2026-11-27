import { fullscreenVertex } from './gl-program.js';
import { backendFor } from './glaze-backend.js';
import {
  SNIPPET_LIMITS, requireKnownFields, validateShaderSnippet, validateSnippetUniforms, snippetUniformDeclarations, mapShaderInfoLog,
} from './shader-snippet-validator.js';
import { MAXIMUM_MASK_PARTS, resolveObjectNames, objectIdentifierSlots, unbindMask } from './post-mask.js';
import { normalizeNeeds, needInputNames, normalizeLuts, passInputDeclarations, missingNeedMessage, createPassInputs } from './user-pass-inputs.js';

// User post-process passes: fragment snippets that run on the finished frame, after the stock effects, the grade and the
// view transform, as the last step before the canvas. The core renderer carries nothing for them. installUserPasses wraps
// resolveFrame, copies the finished frame into a texture, runs each pass in order and draws the last one to the canvas.
// A snippet is checked by shader-snippet-validator.js before it is ever compiled.

/** Names the engine provides to a snippet; a uniform cannot take one. */
const ORIGIN = Object.freeze([0, 0, 0]);
export const USER_PASS_INPUTS = Object.freeze(['sceneColor', 'sceneDepth', 'resolution', 'time', 'cameraEye', 'depthAt', 'worldPointAt', 'worldNormalAt', 'pixelFootprintAt', 'worldFootprintAt', 'bandLimitedLine', 'objectSlotAt', 'sceneObjectIds', 'userPass']);
export const USER_PASS_SCALE = Object.freeze({ min: 0.05, max: 1 });
const PASS_NAME_PATTERN = /^[a-z][A-Za-z0-9-]{0,31}$/;
const PASS_FIELDS = ['name', 'fragment', 'uniforms', 'scale', 'offset', 'objects', 'needs', 'luts'];
const ENTRY_FUNCTION = Object.freeze({ pattern: /\bvec4\s+userPass\s*\(\s*vec2\s+[A-Za-z_]\w*\s*\)\s*\{/, example: 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv); }' });

/**
 * Checks a list of passes and returns it normalized: uniforms as { name: { type, value } }, scale filled in. Throws on the
 * first problem with a message that names the pass, the line and column, and a fix.
 */
export function normalizeUserPasses(input) {
  if (!Array.isArray(input)) throw new TypeError('postPasses must be an array of { name, fragment, uniforms, scale }. Fix: send [] to clear it.');
  if (input.length > SNIPPET_LIMITS.maxPasses) {
    throw new RangeError(`postPasses holds ${input.length} passes; the limit is ${SNIPPET_LIMITS.maxPasses}. Fix: merge passes, or draw several effects in one fragment.`);
  }
  const names = new Set();
  return input.map((entry, index) => {
    requireKnownFields(entry, PASS_FIELDS, `postPasses[${index}]`);
    if (typeof entry.name !== 'string' || !PASS_NAME_PATTERN.test(entry.name)) {
      throw new RangeError(`postPasses[${index}].name must match ${PASS_NAME_PATTERN}. Fix: a lowercase letter, then letters, digits or hyphens, 32 characters at most.`);
    }
    if (names.has(entry.name)) throw new RangeError(`Pass name "${entry.name}" is used twice. Fix: give each pass its own name.`);
    names.add(entry.name);
    const scale = entry.scale ?? 1;
    if (typeof scale !== 'number' || !(scale >= USER_PASS_SCALE.min && scale <= USER_PASS_SCALE.max)) {
      throw new RangeError(`Post pass "${entry.name}" scale must be between ${USER_PASS_SCALE.min} and ${USER_PASS_SCALE.max}. Fix: 0.25 renders at a quarter of the width and height.`);
    }
    let offset;
    if (entry.offset !== undefined) {
      if (!Array.isArray(entry.offset) || entry.offset.length !== 2 || !entry.offset.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new RangeError(`Post pass "${entry.name}" offset must be [x, y] of finite numbers in pass pixels.`);
      }
      offset = [entry.offset[0], entry.offset[1]];
    }
    const fragmentLabel = `Post pass "${entry.name}" fragment`;
    const { source } = validateShaderSnippet(entry.fragment, { label: fragmentLabel, requiredFunction: ENTRY_FUNCTION });
    const needs = entry.needs === undefined ? [] : normalizeNeeds(entry.needs, `postPasses[${index}]`);
    const missing = missingNeedMessage(source, needs, fragmentLabel);
    if (missing) throw new RangeError(missing);
    const uniforms = validateSnippetUniforms(entry.uniforms, { label: `Post pass "${entry.name}"`, reservedNames: [...USER_PASS_INPUTS, ...needInputNames(needs)] });
    const normalized = { name: entry.name, fragment: entry.fragment, uniforms, scale };
    if (offset !== undefined) normalized.offset = offset;
    if (entry.objects !== undefined) normalized.objects = resolveObjectNames(entry.objects, `postPasses[${index}].objects`);
    if (entry.needs !== undefined) normalized.needs = needs;
    if (entry.luts !== undefined) {
      const reservedNames = [...USER_PASS_INPUTS, ...needInputNames(needs), ...Object.keys(uniforms)];
      normalized.luts = normalizeLuts(entry.luts, { label: `postPasses[${index}]`, reservedNames });
    }
    return normalized;
  });
}

/** What the recipe field postPassesAntialias accepts. "fxaa" (the default when passes exist) smooths the edges the passes drew; "off" keeps their pixels exactly. */
export const USER_PASS_ANTIALIAS_MODES = Object.freeze(['fxaa', 'off']);

/** Checks the recipe field postPassesAntialias; undefined means the default, "fxaa". */
export function normalizePostPassesAntialias(input) {
  if (input === undefined || input === null) return 'fxaa';
  if (!USER_PASS_ANTIALIAS_MODES.includes(input)) {
    throw new RangeError(`postPassesAntialias must be one of ${USER_PASS_ANTIALIAS_MODES.map(mode => `"${mode}"`).join(', ')}, got ${JSON.stringify(input)}. Fix: "fxaa" smooths the lines the passes draw, "off" keeps their pixels exact (dither, pixel art).`);
  }
  return input;
}

/**
 * The draw order of one frame: every pass in order, then one edge antialias step after the last pass. The step only runs when
 * the mode is "fxaa" and the last pass renders at full size, since a pass at a smaller scale is enlarged into hard pixels on purpose.
 */
export function planUserPassSteps(passes, antialias = 'fxaa') {
  const steps = passes.map(pass => ({ kind: 'pass', name: pass.name, scale: pass.scale }));
  const last = passes[passes.length - 1];
  if (last && last.scale === 1 && normalizePostPassesAntialias(antialias) === 'fxaa') steps.push({ kind: 'antialias' });
  return steps;
}

/** What scene_capabilities reports under postPasses; it lives here so the scene entry does not carry the text. */
export const USER_PASS_CAPABILITIES = Object.freeze({
  fields: 'name, fragment (defines vec4 userPass(vec2 uv)), uniforms, scale 0.05-1 (1), objects (1-16 part names), needs (normal, objectId, albedo, emission), luts (up to 4 palettes)',
  needs: 'needs adds exact G-buffer reads, one extra scene draw each, none when absent: normalAt(uv) (world normal, vec3(0) in the sky), objectIdAt(uv) (raw 24-bit part ID as int, 0 = background, no 16-part cap), albedoAt(uv), emissionAt(uv) (vec3, 8-bit). Nearest sampling, silhouettes stay exact. A snippet that calls one without listing it is refused',
  luts: 'luts: { name: { colors: ["#rrggbb", ...] } } (one row, or a list of rows) or { width, height, pixels } (base64 RGBA8); at most 4 textures, 256 x 16 each, inline data only. Read with texture(name, uv) or texelFetch(name, ivec2(x, y), 0); nearest, clamped',
  inputs: 'sceneColor, sceneDepth (sampler2D), resolution (vec2, this pass), time (s; the motion time when the frame has one, else the renderer time), depthAt(uv), worldPointAt(uv), worldNormalAt(uv, from depth), pixelFootprintAt(uv) (vec2, world size of one pixel along screen x and y, 0 in sky), worldFootprintAt(uv, direction) (how far dot(worldPointAt, direction) changes over one pixel), bandLimitedLine(coordinate, pitch, width, footprint) (coverage 0-1 of repeating lines averaged over footprint), objectSlotAt(uv) (position of the part under uv in the pass objects list, or -1); gl_FragCoord',
  uniforms: 'a number is float, [x,y(,z(,w))] is vec2-4, {type:"int",value} is int; name ^[a-z][A-Za-z0-9]{0,31}$',
  rules: 'no # lines, while, do, uniform/layout declarations, gl_ names but gl_FragCoord, or u67_ names; for loops only as for (int i = 0; i < N; i++) { } with literal bounds, 64 iterations at most, loop work under 4096',
  limits: Object.freeze({ maxPasses: SNIPPET_LIMITS.maxPasses, maxBytes: SNIPPET_LIMITS.maxBytes, maxUniforms: SNIPPET_LIMITS.maxUniforms, maxLoopIterations: SNIPPET_LIMITS.maxLoopIterations, maxLoopWork: SNIPPET_LIMITS.maxLoopWork }),
  antialias: 'recipe postPassesAntialias "fxaa" (default) | "off": one edge smoothing pass after the last pass when it has scale 1; "off" for dither and pixel art',
  notes: 'Passes run in order on the finished frame; scale under 1 renders smaller and enlarges with nearest filtering. A compile error returns the log with snippet line numbers (renderError); the scene stays. Stills and render jobs apply them; the path tracer does not. docs/user-passes.md',
});

/** What scene_inspect reports for each pass. */
export function describeUserPasses(passes) {
  return passes.map(pass => ({
    name: pass.name,
    scale: pass.scale,
    ...(pass.objects ? { objects: pass.objects } : {}),
    ...(pass.needs?.length ? { needs: pass.needs } : {}),
    ...(pass.luts ? { luts: Object.entries(pass.luts).map(([name, { width, height }]) => `${name}:${width}x${height}`) } : {}),
    uniforms: Object.entries(pass.uniforms).map(([name, { type }]) => `${name}:${type}`),
    fragmentBytes: pass.fragment.length,
  }));
}

// The footprint helpers in the header below. Pixel footprint: how far one pixel of this pass reaches on the surface, so a pattern drawn by the pass can be filtered.
// A neighbour that is sky or off screen does not count, and the smaller of the two steps wins, so a depth edge or a
// silhouette does not stretch the footprint across the gap.
// Lines of the given width repeating every pitch along coordinate, averaged over footprint (all in the same units).
// Exact for a box filter while a pixel is narrower than a third of the pitch; wider than that it fades to the mean coverage.
const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 textureCoordinate;
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform mat4 u67_inverseViewProjection;
uniform vec2 resolution;
uniform float time;
uniform vec3 cameraEye;
uniform sampler2D sceneObjectIds;
uniform int u67_objectCount;
uniform int u67_objectIds[${MAXIMUM_MASK_PARTS}];
uniform int u67_objectSlots[${MAXIMUM_MASK_PARTS}];
out vec4 u67_output;
float depthAt(vec2 uv) { return texture(sceneDepth, uv).r; }
vec3 worldPointAt(vec2 uv) {
  vec4 point = u67_inverseViewProjection * vec4(uv * 2.0 - 1.0, depthAt(uv) * 2.0 - 1.0, 1.0);
  return point.xyz / point.w;
}
// Which entry of the pass objects list is under uv: -1 for the background, a part not in the list, or a pass with no objects.
int objectSlotAt(vec2 uv) {
  if (u67_objectCount == 0) return -1;
  vec3 idBytes = floor(texelFetch(sceneObjectIds, ivec2(uv * vec2(textureSize(sceneObjectIds, 0))), 0).rgb * 255.0 + 0.5);
  int identifier = int(idBytes.r + idBytes.g * 256.0 + idBytes.b * 65536.0);
  for (int slot = 0; slot < ${MAXIMUM_MASK_PARTS}; slot++) {
    if (slot >= u67_objectCount) break;
    if (u67_objectIds[slot] == identifier) return u67_objectSlots[slot];
  }
  return -1;
}
// Normal from the depth buffer: the cross product of the smaller step in x and in y, facing the camera.
vec3 worldNormalAt(vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(sceneDepth, 0));
  vec3 center = worldPointAt(uv);
  vec3 right = worldPointAt(uv + vec2(texel.x, 0.0)) - center;
  vec3 left = center - worldPointAt(uv - vec2(texel.x, 0.0));
  vec3 up = worldPointAt(uv + vec2(0.0, texel.y)) - center;
  vec3 down = center - worldPointAt(uv - vec2(0.0, texel.y));
  vec3 normal = cross(dot(right, right) < dot(left, left) ? right : left, dot(up, up) < dot(down, down) ? up : down);
  float size = length(normal);
  return size > 1e-12 ? normal / size : vec3(0.0, 1.0, 0.0);
}
bool u67_isSurface(vec2 uv) {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && depthAt(uv) < 1.0;
}
vec3 u67_pixelStep(vec2 uv, vec2 pixelOffset) {
  vec3 center = worldPointAt(uv);
  bool hasForward = u67_isSurface(uv + pixelOffset);
  bool hasBackward = u67_isSurface(uv - pixelOffset);
  vec3 forward = hasForward ? worldPointAt(uv + pixelOffset) - center : vec3(0.0);
  vec3 backward = hasBackward ? center - worldPointAt(uv - pixelOffset) : vec3(0.0);
  if (!hasForward) return backward;
  if (!hasBackward) return forward;
  return dot(forward, forward) < dot(backward, backward) ? forward : backward;
}
vec2 pixelFootprintAt(vec2 uv) {
  if (!u67_isSurface(uv)) return vec2(0.0);
  vec2 pixel = 1.0 / resolution;
  return vec2(length(u67_pixelStep(uv, vec2(pixel.x, 0.0))), length(u67_pixelStep(uv, vec2(0.0, pixel.y))));
}
float worldFootprintAt(vec2 uv, vec3 direction) {
  if (!u67_isSurface(uv)) return 0.0;
  vec2 pixel = 1.0 / resolution;
  return length(vec2(dot(u67_pixelStep(uv, vec2(pixel.x, 0.0)), direction), dot(u67_pixelStep(uv, vec2(0.0, pixel.y)), direction)));
}
float bandLimitedLine(float coordinate, float pitch, float width, float footprint) {
  float safePitch = max(pitch, 1e-6);
  float filterWidth = max(footprint, 1e-6);
  float distanceToLine = abs(fract(coordinate / safePitch + 0.5) - 0.5) * safePitch;
  float overlap = max(0.0, min(distanceToLine + 0.5 * filterWidth, 0.5 * width) - max(distanceToLine - 0.5 * filterWidth, -0.5 * width));
  float sharp = clamp(overlap / filterWidth, 0.0, 1.0);
  float mean = clamp(width / safePitch, 0.0, 1.0);
  return mix(sharp, mean, smoothstep(0.33, 1.0, filterWidth / safePitch));
}
`;
// Edge antialias after the last pass, after FXAA 3.11: it finds the edge direction from the luma of the 3x3 neighbourhood, walks
// along the edge to its ends (16 texels each way) and blends toward the steeper side by the pixel's place along the edge, or by
// the neighbourhood contrast for one-pixel features. The input is read texel by texel.
const antialiasFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
out vec4 outputColor;
float lumaOf(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
vec4 fetchAt(ivec2 base, ivec2 offset, ivec2 size) { return texelFetch(sourceTexture, clamp(base + offset, ivec2(0), size - 1), 0); }
void main() {
  ivec2 size = textureSize(sourceTexture, 0);
  ivec2 base = ivec2(textureCoordinate * vec2(size));
  vec4 centerSample = fetchAt(base, ivec2(0), size);
  vec4 north = fetchAt(base, ivec2(0, 1), size);
  vec4 south = fetchAt(base, ivec2(0, -1), size);
  vec4 east = fetchAt(base, ivec2(1, 0), size);
  vec4 west = fetchAt(base, ivec2(-1, 0), size);
  vec4 northEast = fetchAt(base, ivec2(1, 1), size);
  vec4 northWest = fetchAt(base, ivec2(-1, 1), size);
  vec4 southEast = fetchAt(base, ivec2(1, -1), size);
  vec4 southWest = fetchAt(base, ivec2(-1, -1), size);
  float lumaCenter = lumaOf(centerSample.rgb);
  float lumaNorth = lumaOf(north.rgb);
  float lumaSouth = lumaOf(south.rgb);
  float lumaEast = lumaOf(east.rgb);
  float lumaWest = lumaOf(west.rgb);
  float lumaHighest = max(lumaCenter, max(max(lumaNorth, lumaSouth), max(lumaEast, lumaWest)));
  float lumaLowest = min(lumaCenter, min(min(lumaNorth, lumaSouth), min(lumaEast, lumaWest)));
  float range = lumaHighest - lumaLowest;
  if (range < max(0.0312, lumaHighest * 0.125)) {
    outputColor = centerSample;
    return;
  }
  float lumaNorthEast = lumaOf(northEast.rgb);
  float lumaNorthWest = lumaOf(northWest.rgb);
  float lumaSouthEast = lumaOf(southEast.rgb);
  float lumaSouthWest = lumaOf(southWest.rgb);
  float variationAcrossColumns = abs(lumaNorthWest + lumaNorthEast - 2.0 * lumaNorth) + 2.0 * abs(lumaWest + lumaEast - 2.0 * lumaCenter) + abs(lumaSouthWest + lumaSouthEast - 2.0 * lumaSouth);
  float variationAcrossRows = abs(lumaNorthWest + lumaSouthWest - 2.0 * lumaWest) + 2.0 * abs(lumaNorth + lumaSouth - 2.0 * lumaCenter) + abs(lumaNorthEast + lumaSouthEast - 2.0 * lumaEast);
  bool horizontalEdge = variationAcrossRows >= variationAcrossColumns;
  float lumaFirst = horizontalEdge ? lumaSouth : lumaWest;
  float lumaSecond = horizontalEdge ? lumaNorth : lumaEast;
  bool firstIsSteeper = abs(lumaFirst - lumaCenter) >= abs(lumaSecond - lumaCenter);
  ivec2 acrossStep = horizontalEdge ? (firstIsSteeper ? ivec2(0, -1) : ivec2(0, 1)) : (firstIsSteeper ? ivec2(-1, 0) : ivec2(1, 0));
  ivec2 alongStep = horizontalEdge ? ivec2(1, 0) : ivec2(0, 1);
  vec4 across = fetchAt(base, acrossStep, size);
  float gradient = abs((firstIsSteeper ? lumaFirst : lumaSecond) - lumaCenter);
  float localAverage = 0.5 * (lumaOf(across.rgb) + lumaCenter);
  bool centerBelowAverage = lumaCenter < localAverage;
  // Walk both ways along the edge until the pair of pixels stops straddling it; the pixel's place along the edge sets the blend.
  float distancePositive = 0.0;
  float distanceNegative = 0.0;
  bool endPositive = false;
  bool endNegative = false;
  bool belowPositive = false;
  bool belowNegative = false;
  for (int step = 1; step <= 16; step++) {
    if (!endPositive) {
      ivec2 at = base + alongStep * step;
      float pairAverage = 0.5 * (lumaOf(fetchAt(at, ivec2(0), size).rgb) + lumaOf(fetchAt(at, acrossStep, size).rgb));
      endPositive = abs(pairAverage - localAverage) >= gradient * 0.25;
      belowPositive = pairAverage < localAverage;
      distancePositive = float(step);
    }
    if (!endNegative) {
      ivec2 at = base - alongStep * step;
      float pairAverage = 0.5 * (lumaOf(fetchAt(at, ivec2(0), size).rgb) + lumaOf(fetchAt(at, acrossStep, size).rgb));
      endNegative = abs(pairAverage - localAverage) >= gradient * 0.25;
      belowNegative = pairAverage < localAverage;
      distanceNegative = float(step);
    }
  }
  bool positiveIsNearer = distancePositive < distanceNegative;
  float nearestDistance = min(distancePositive, distanceNegative);
  bool nearestEndMatches = (positiveIsNearer ? belowPositive : belowNegative) != centerBelowAverage;
  float edgeLength = distancePositive + distanceNegative;
  float edgeOffset = nearestEndMatches ? 0.5 - nearestDistance / edgeLength : 0.0;
  vec4 average = (2.0 * (north + south + east + west) + northEast + northWest + southEast + southWest + 4.0 * centerSample) / 16.0;
  float subpixel = clamp(abs(lumaOf(average.rgb) - lumaCenter) / range, 0.0, 1.0);
  subpixel = smoothstep(0.0, 1.0, subpixel);
  subpixel = subpixel * subpixel * 0.75;
  outputColor = mix(centerSample, across, max(edgeOffset, subpixel));
}`;

// uvScale and uvOffset are 1 and 0 except for a pass below scale 1 on a pixel grid, where they place its blocks on the grid lattice.
const FRAGMENT_FOOTER = '\nuniform vec2 u67_uvScale;\nuniform vec2 u67_uvOffset;\nvoid main() { u67_output = userPass(textureCoordinate * u67_uvScale + u67_uvOffset); }\n';
const FULL_FRAME_PLACEMENT = Object.freeze({ uvScale: [1, 1], uvOffset: [0, 0] });

/** The full fragment source of a normalized pass, and how many lines come before the snippet. */
export function buildPassFragment(pass) {
  const { source: snippet } = validateShaderSnippet(pass.fragment, { label: `Post pass "${pass.name}" fragment`, requiredFunction: ENTRY_FUNCTION });
  const header = `${FRAGMENT_HEADER}${passInputDeclarations(pass)}${snippetUniformDeclarations(pass.uniforms)}\n`;
  return { source: `${header}${snippet}${FRAGMENT_FOOTER}`, headerLines: header.split('\n').length - 1, snippet };
}

const copyFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform vec2 u67_offset;
out vec4 outputColor;
void main() { outputColor = texture(sourceTexture, textureCoordinate - u67_offset / vec2(textureSize(sourceTexture, 0))); }`;

/** Block origin shifted so a pixel-grid pass enlarged output shifts by `offset` pass pixels (+gl_FragCoord). */
export function enlargedBlockOrigin(origin, size, offset) {
  if (!offset) return origin;
  return [origin[0] - offset[0] * size, origin[1] - offset[1] * size];
}

// Enlarges a pass drawn on a block lattice back to the grid size: each grid pixel takes the block it falls in.
const blockEnlargeFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform float blockSize;
uniform vec2 blockOrigin;
out vec4 outputColor;
void main() {
  ivec2 block = ivec2(floor((floor(gl_FragCoord.xy) + blockOrigin) / blockSize));
  outputColor = texelFetch(sourceTexture, clamp(block, ivec2(0), textureSize(sourceTexture, 0) - 1), 0);
}`;

function createTarget(backend, width, height) {
  // Nearest, so a pass rendered at a lower scale is enlarged into hard pixels by whatever reads it.
  const target = backend.createFramebufferTarget({ width, height, hdr: false, linear: false, clamp: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('Post pass framebuffer allocation failed. Fix: lower the pass scale or the render size.');
  }
  return { texture: target.colorTexture, framebuffer: target.framebuffer, width, height };
}

function setUniformValue(backend, location, { type, value }) {
  if (type === 'float') backend.uniform1f(location, value);
  else if (type === 'int') backend.uniform1i(location, value);
  else if (type === 'vec2') backend.uniform2fv(location, value);
  else if (type === 'vec3') backend.uniform3fv(location, value);
  else backend.uniform4fv(location, value);
}

function compilationError(pass, error, built) {
  const log = error.message.replace(/^Shader (compilation|linking) failed: /, '');
  const mapped = mapShaderInfoLog(log, { headerLines: built.headerLines, snippet: built.snippet });
  return new Error(`Post pass "${pass.name}" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.\n${mapped}`);
}

/**
 * Adds user passes to a renderer. `renderer.userPasses.set(passes)` takes the list `normalizeUserPasses` accepts (a bare
 * number is a float, an array a vec2 to vec4); `set([])` removes them. A pass reads `sceneColor` (the finished frame, or the
 * previous pass), `sceneDepth` (needs depth: true on the renderer; reads 1 without it), `resolution` (this pass's size in
 * pixels), `time`, and the helpers depthAt, worldPointAt and worldNormalAt (a normal derived from the depth). Setting new
 * uniform values does not recompile; a new fragment does, on the next frame, and a compile failure throws from that frame.
 */
export function installUserPasses(renderer) {
  if (renderer.userPasses) return renderer;
  const backend = backendFor(renderer);
  const state = { passes: [], key: '[]', antialias: 'fxaa', entries: [], capture: null, copy: null, smooth: null };
  const builtByPass = new WeakMap();
  const inputs = createPassInputs(renderer, backend);

  function releaseEntryTarget(entry) {
    for (const slot of ['target', 'enlarged']) {
      if (!entry[slot]) continue;
      backend.deleteTexture(entry[slot].texture);
      backend.deleteFramebuffer(entry[slot].framebuffer);
      entry[slot] = null;
    }
  }

  function releaseEntry(entry) {
    releaseEntryTarget(entry);
    backend.deleteProgram(entry.program);
  }

  function releaseTargets() {
    if (state.capture) backend.deleteTexture(state.capture.texture);
    state.capture = null;
    state.entries.forEach(entry => releaseEntryTarget(entry));
    inputs.releaseCaptures();
  }

  function dispose() {
    releaseTargets();
    inputs.dispose();
    state.entries.forEach(entry => backend.deleteProgram(entry.program));
    state.entries = [];
    if (state.copy) backend.deleteProgram(state.copy.program);
    state.copy = null;
    if (state.smooth) backend.deleteProgram(state.smooth.program);
    state.smooth = null;
    if (state.enlarge) backend.deleteProgram(state.enlarge.program);
    state.enlarge = null;
  }

  // One compiled program per pass, rebuilt only when its fragment or its uniform declarations change.
  function compiledEntries() {
    state.entries.slice(state.passes.length).forEach(entry => releaseEntry(entry));
    state.entries.length = Math.min(state.entries.length, state.passes.length);
    state.passes.forEach((pass, index) => {
      if (!builtByPass.has(pass)) builtByPass.set(pass, buildPassFragment(pass));
      const built = builtByPass.get(pass);
      const entry = state.entries[index];
      if (entry?.source === built.source) {
        entry.pass = pass;
        return;
      }
      let program;
      try {
        program = backend.compileProgram(fullscreenVertex, built.source);
      } catch (error) {
        throw compilationError(pass, error, built);
      }
      if (entry) releaseEntry(entry);
      const names = ['sceneColor', 'sceneDepth', 'sceneObjectIds', 'u67_objectCount', 'u67_objectIds', 'u67_objectSlots', 'u67_inverseViewProjection', 'u67_uvScale', 'u67_uvOffset', 'resolution', 'time', 'cameraEye', 'sceneNormal', 'sceneAlbedo', 'sceneEmission', ...Object.keys(pass.luts ?? {}), ...Object.keys(pass.uniforms)];
      state.entries[index] = {
        pass, source: built.source, program, target: null,
        locations: Object.fromEntries(names.map(name => [name, backend.uniformLocation(program, name)])),
      };
    });
    return state.entries;
  }

  function effectiveAntialias() {
    return renderer.pixelGrid?.active ? 'off' : state.antialias;
  }

  function captureFinishedFrame(width, height) {
    if (state.capture && (state.capture.width !== width || state.capture.height !== height)) {
      backend.deleteTexture(state.capture.texture);
      state.capture = null;
    }
    // A copy from the canvas needs a texture format the canvas has: without an alpha channel it has none either.
    const withAlpha = backend.hasCanvasAlpha();
    // On a pixel grid (src/pixel-grid.js) the passes read hard pixels and never smooth the edges they draw.
    state.capture ??= { texture: backend.createDataTexture2D({ width, height, format: withAlpha ? 'rgba8' : 'rgb8', linear: !renderer.pixelGrid?.active, clamp: true }), width, height };
    backend.copyFramebufferToTexture(null, state.capture.texture, width, height);
    return state.capture.texture;
  }

  function targetFor(entry, width, height) {
    if (entry.target && (entry.target.width !== width || entry.target.height !== height)) releaseEntryTarget(entry);
    entry.target ??= createTarget(backend, width, height);
    return entry.target;
  }

  function drawPass(entry, inputTexture, width, height, frame, placement = FULL_FRAME_PLACEMENT, framebuffer = null) {
    const { locations, pass } = entry;
    backend.beginFullscreenPass(framebuffer, width, height, entry.program);
    backend.uniform2fv(locations.u67_uvScale, placement.uvScale);
    backend.uniform2fv(locations.u67_uvOffset, placement.uvOffset);
    backend.bindTextureUnit(0, inputTexture);
    backend.uniform1i(locations.sceneColor, 0);
    backend.bindTextureUnit(1, renderer.depthTexture ?? renderer.whiteTexture);
    backend.uniform1i(locations.sceneDepth, 1);
    backend.uniformMatrix4fv(locations.u67_inverseViewProjection, renderer.inverseViewProjection);
    backend.uniform2f(locations.resolution, placement.resolution?.[0] ?? width, placement.resolution?.[1] ?? height);
    backend.uniform1f(locations.time, frame.passTime ?? frame.time ?? 0);
    backend.uniform3fv(locations.cameraEye, frame.eye ?? ORIGIN);
    for (const [name, uniform] of Object.entries(pass.uniforms)) setUniformValue(backend, locations[name], uniform);
    const { identifiers, slots } = pass.objects ? objectIdentifierSlots(renderer, pass.objects) : { identifiers: [], slots: [] };
    backend.uniform1i(locations.u67_objectCount, identifiers.length);
    if (identifiers.length > 0) {
      const padded = new Int32Array(MAXIMUM_MASK_PARTS);
      padded.set(identifiers);
      backend.uniform1iv(locations.u67_objectIds, padded);
      const paddedSlots = new Int32Array(MAXIMUM_MASK_PARTS);
      paddedSlots.set(slots);
      backend.uniform1iv(locations.u67_objectSlots, paddedSlots);
    }
    // Before the object IDs: making a texture binds it to the active unit.
    inputs.bind(pass, locations);
    const readsObjectIds = identifiers.length > 0 || Boolean(pass.needs?.includes('objectId'));
    if (readsObjectIds) {
      const objectIdTexture = renderer.passSupport?.texture;
      if (!objectIdTexture) {
        throw new Error('A user pass with objects or needs: ["objectId"] requires the objectId pass first. Call renderer.render({ ...frame, pass: "objectId" }) before renderer.render(frame).');
      }
      backend.bindTextureUnit(2, objectIdTexture);
      backend.uniform1i(locations.sceneObjectIds, 2);
    }
    backend.drawFullscreenTriangles();
    // The next frame draws into the object ID target, so it must not stay bound as a texture.
    if (readsObjectIds) unbindMask(backend);
  }

  function drawTextureToCanvas(slot, fragment, texture, width, height, offset = null, framebuffer = null) {
    if (!state[slot]) {
      const program = backend.compileProgram(fullscreenVertex, fragment);
      state[slot] = { program, texture: backend.uniformLocation(program, 'sourceTexture'), offset: backend.uniformLocation(program, 'u67_offset') };
    }
    backend.beginFullscreenPass(framebuffer, width, height, state[slot].program);
    backend.bindTextureUnit(0, texture);
    backend.uniform1i(state[slot].texture, 0);
    if (state[slot].offset) backend.uniform2f(state[slot].offset, offset?.[0] ?? 0, offset?.[1] ?? 0);
    backend.drawFullscreenTriangles();
  }

  // On a pixel grid a pass below scale 1 draws one pixel per whole block of grid pixels (1 / scale, rounded), on the lattice that
  // moves with the snapped camera, so its blocks stay on the same geometry while the camera pans. Null off the grid, or at one pixel.
  function gridBlock(pass) {
    if (!renderer.pixelGrid?.active || pass.scale === 1) return null;
    const size = Math.round(1 / pass.scale);
    return size > 1 ? { size, origin: renderer.pixelGrid.latticeOrigin(size) } : null;
  }

  function enlargedTarget(entry, width, height) {
    if (entry.enlarged && (entry.enlarged.width !== width || entry.enlarged.height !== height)) {
      backend.deleteTexture(entry.enlarged.texture);
      backend.deleteFramebuffer(entry.enlarged.framebuffer);
      entry.enlarged = null;
    }
    entry.enlarged ??= createTarget(backend, width, height);
    return entry.enlarged;
  }

  // Block j covers grid pixels j * size - origin up to the next block; the pass reads uv at the block centre and reports the block
  // count as its resolution. Then each grid pixel takes its block again, into a grid-sized target or onto the canvas.
  function drawBlockPass(entry, inputTexture, width, height, frame, block, toCanvas) {
    const { size, origin } = block;
    const effectiveOrigin = enlargedBlockOrigin(origin, size, entry.pass.offset);
    const columns = Math.ceil((width + origin[0]) / size);
    const rows = Math.ceil((height + origin[1]) / size);
    const target = targetFor(entry, columns, rows);
    // An even block has no middle pixel: its centre is a pixel edge, where nearest sampling could take either side, so it reads the
    // pixel just before the centre.
    const centring = size % 2 === 0 ? 0.5 : 0;
    drawPass(entry, inputTexture, columns, rows, frame, {
      uvScale: [columns * size / width, rows * size / height],
      uvOffset: [-(origin[0] + centring) / width, -(origin[1] + centring) / height],
      resolution: [width / size, height / size],
    }, target.framebuffer);
    const output = toCanvas ? null : enlargedTarget(entry, width, height);
    if (!state.enlarge) {
      const program = backend.compileProgram(fullscreenVertex, blockEnlargeFragment);
      state.enlarge = { program, uniforms: Object.fromEntries(['sourceTexture', 'blockSize', 'blockOrigin'].map(name => [name, backend.uniformLocation(program, name)])) };
    }
    backend.beginFullscreenPass(output?.framebuffer ?? null, width, height, state.enlarge.program);
    backend.bindTextureUnit(0, target.texture);
    backend.uniform1i(state.enlarge.uniforms.sourceTexture, 0);
    backend.uniform1f(state.enlarge.uniforms.blockSize, size);
    backend.uniform2fv(state.enlarge.uniforms.blockOrigin, effectiveOrigin);
    backend.drawFullscreenTriangles();
    return output?.texture ?? null;
  }

  function runPasses(frame) {
    const { width, height } = renderer.canvas;
    const entries = compiledEntries();
    backend.setFullscreenState();
    const steps = planUserPassSteps(entries.map(entry => entry.pass), effectiveAntialias());
    const antialiasLast = steps[steps.length - 1].kind === 'antialias';
    let input = captureFinishedFrame(width, height);
    let drewToCanvas = false;
    let finalOffset = null;
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1;
      const offset = entry.pass.offset;
      const hasOffset = Boolean(offset && (offset[0] !== 0 || offset[1] !== 0));
      const block = gridBlock(entry.pass);
      if (block) {
        drewToCanvas = isLast && !antialiasLast;
        input = drawBlockPass(entry, input, width, height, frame, block, drewToCanvas);
        finalOffset = null;
        return;
      }
      // On the grid a pass that rounds to one pixel per block runs at the grid size.
      const fullSize = entry.pass.scale === 1 || Boolean(renderer.pixelGrid?.active);
      const directToCanvas = isLast && fullSize && !antialiasLast && !hasOffset;
      const passWidth = fullSize ? width : Math.max(1, Math.round(width * entry.pass.scale));
      const passHeight = fullSize ? height : Math.max(1, Math.round(height * entry.pass.scale));
      const target = directToCanvas ? null : targetFor(entry, passWidth, passHeight);
      drawPass(entry, input, passWidth, passHeight, frame, FULL_FRAME_PLACEMENT, target?.framebuffer ?? null);
      if (hasOffset && (!isLast || antialiasLast)) {
        const enlarged = enlargedTarget(entry, width, height);
        drawTextureToCanvas('copy', copyFragment, target.texture, width, height, offset, enlarged.framebuffer);
        input = enlarged.texture;
        finalOffset = null;
      } else {
        input = target?.texture;
        finalOffset = hasOffset ? offset : null;
      }
      drewToCanvas = directToCanvas;
    });
    if (antialiasLast) drawTextureToCanvas('smooth', antialiasFragment, input, width, height);
    else if (!drewToCanvas) drawTextureToCanvas('copy', copyFragment, input, width, height, finalOffset);
    inputs.prune(state.passes);
  }

  // A pass that lists `needs` or `objects` reads render passes drawn from this frame's camera, so they are drawn here before the lit frame unless the host already drew `objectId`.
  let objectIdDrawn = false;
  const render = renderer.render;
  renderer.render = function renderWithPassInputs(frame, ...rest) {
    if (frame?.pass) {
      const result = render.call(this, frame, ...rest);
      objectIdDrawn = frame.pass === 'objectId';
      return result;
    }
    const drawsLitFrame = state.passes.length > 0 && !frame?.reflectionTarget && !this.benchmark;
    if (drawsLitFrame) {
      try {
        inputs.draw(passFrame => render.call(this, passFrame, ...rest), frame, state.passes, { objectIdDrawn });
      } finally {
        objectIdDrawn = false;
      }
    }
    return render.call(this, frame, ...rest);
  };

  const resolveFrame = renderer.resolveFrame;
  renderer.resolveFrame = function resolveFrameWithUserPasses(frame, ...rest) {
    resolveFrame.call(this, frame, ...rest);
    if (state.passes.length > 0 && !this.benchmark) runPasses(frame);
  };
  // Only the lifecycle: the passes run after the final draw, not between the stock stages.
  renderer.postStages.push({ name: 'User passes', apply: () => null, releaseTargets, dispose });
  renderer.userPasses = {
    set(passes) {
      const key = JSON.stringify(passes);
      if (key === state.key) return;
      state.passes = normalizeUserPasses(passes);
      state.key = key;
    },
    /** "fxaa" (default) or "off": whether one edge smoothing step follows the last pass. */
    setAntialias(mode) {
      state.antialias = normalizePostPassesAntialias(mode);
    },
    get passes() {
      return structuredClone(state.passes);
    },
  };
  return renderer;
}
