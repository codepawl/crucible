import { registerShaderFeatureCode, layerTextureSupport } from './shader-registry.js';
import {
  SNIPPET_LIMITS, requireKnownFields, validateShaderSnippet, validateSnippetUniforms, snippetUniformDeclarations, mapShaderInfoLog,
} from './shader-snippet-validator.js';

// Material fragment hook: a bounded GLSL function that changes colour and alpha, or discards, for the surfaces of one
// material. The core renderer carries three small seams for it (a feature per distinct snippet, the `surfaceHook` slot of
// the main fragment shader, and the `depthVertex` and `depthFragment` rewrites of the shadow shader). Everything else lives
// here, in a lazy chunk. The main pass runs the hook before the render-pass output, so the ID pass sees the discard, and the
// shadow pass runs the same hook, so a discarded fragment casts no shadow.

/** Names the engine provides to a snippet; a uniform cannot take one. */
export const MATERIAL_SNIPPET_INPUTS = Object.freeze(['materialHook', 'waterHook', 'snippetMask']);
const SNIPPET_FIELDS = ['fragment', 'uniforms', 'mask', 'feature'];
const MATERIAL_HOOK_PATTERN = /\bvoid\s+materialHook\s*\(\s*inout\s+vec3\s+[A-Za-z_]\w*\s*,\s*inout\s+float\s+[A-Za-z_]\w*\s*,\s*vec2\s+[A-Za-z_]\w*\s*,\s*vec3\s+[A-Za-z_]\w*\s*(?:,\s*float\s+[A-Za-z_]\w*\s*)?\)\s*\{/;
// The water entry runs after lighting on water surfaces only; the engine declares the WaterInputs struct for it.
const WATER_HOOK_PATTERN = /\bvoid\s+waterHook\s*\(\s*inout\s+vec3\s+[A-Za-z_]\w*\s*,\s*WaterInputs\s+[A-Za-z_]\w*\s*\)\s*\{/;
const WATER_INPUTS_FIELDS = 'vec3 normal; vec3 view; float foam; float depthBelow; float time; float lit;';
const ENTRY_FUNCTION = Object.freeze({
  pattern: new RegExp(`${MATERIAL_HOOK_PATTERN.source}|${WATER_HOOK_PATTERN.source}`),
  example: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) { } (add , float time to animate) or void waterHook(inout vec3 color, WaterInputs water) { } (or both)',
});

/** What scene_capabilities reports under materialSnippet; it lives here so the scene entry does not carry the text. */
export const MATERIAL_SNIPPET_CAPABILITIES = Object.freeze({
  fields: 'material.snippet { fragment (defines void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition[, float time])), uniforms, mask: "map" }; null clears it',
  inputs: 'color (albedo after the map), alpha (map alpha), uv, worldPosition; snippetMask (the material map, with mask "map"); discard; time (seconds, the frame time of stills and video, as waterHook gets it) when materialHook declares a fifth float parameter',
  waterHook: 'void waterHook(inout vec3 color, WaterInputs water) on tag "water" only, after lighting, before fog and tone mapping. color is the lit linear radiance, in and out. water.normal (shading normal with ripples), water.view (surface to eye), water.foam (0 to 1, the ocean foam mask), water.depthBelow (metres to the floor below; 0 for now), water.time (seconds), water.lit (key light facing times shadow, 0 to 1)',
  uniforms: 'as postPasses.uniforms',
  rules: 'as postPasses.rules',
  limits: Object.freeze({ maxBytes: SNIPPET_LIMITS.maxBytes, maxUniforms: SNIPPET_LIMITS.maxUniforms }),
  notes: 'Runs in the colour, shadow (a discarded fragment casts no shadow; color starts white there) and ID passes. alpha cuts only with alphaMode "mask"; discard always. Rasterizer only. A compile error returns renderError with snippet line numbers. docs/user-passes.md',
});

/**
 * Checks a material's snippet and returns it normalized and frozen: uniforms as { name: { type, value } }, plus the `feature`
 * the renderer compiles it under. `hasMap` says whether the material has a map or a pattern for `mask` to read.
 */
export function normalizeMaterialSnippet(input, { hasMap = false } = {}) {
  requireKnownFields(input, SNIPPET_FIELDS, 'snippet');
  const source = validateShaderSnippet(input.fragment, { label: 'Material snippet fragment', requiredFunction: ENTRY_FUNCTION }).source;
  const uniforms = validateSnippetUniforms(input.uniforms, { label: 'Material snippet', reservedNames: MATERIAL_SNIPPET_INPUTS });
  if (input.mask !== undefined && input.mask !== 'map') {
    throw new RangeError('Material snippet mask must be "map". Fix: the mask is the material\'s own map or pattern; load the image as the material map.');
  }
  if (input.mask !== undefined && !hasMap) {
    throw new RangeError('Material snippet mask needs a map. Fix: give the material a map or a pattern, or remove mask.');
  }
  const mask = input.mask === 'map';
  if (!mask && /(?<![.\w])snippetMask(?!\w)/.test(source)) {
    throw new RangeError('Material snippet fragment uses snippetMask without a mask. Fix: add "mask": "map" to the snippet and give the material a map.');
  }
  // The recipe keeps a normalized snippet as it is, so it normalizes again: `feature` is derived, and an incoming one is replaced.
  const snippet = Object.freeze({ feature: featureName(source, uniforms, mask), fragment: source, uniforms: Object.freeze(uniforms), ...(mask ? { mask: 'map' } : {}) });
  registerSnippetFeature(snippet);
  return snippet;
}

// FNV-1a over the code and the declared uniform types: two materials with the same code share one compiled function.
function featureName(fragment, uniforms, mask) {
  let hash = 0x811c9dc5;
  for (const character of `${fragment}\n${snippetUniformDeclarations(uniforms)}\n${mask}`) {
    hash = Math.imul(hash ^ character.codePointAt(0), 0x01000193) >>> 0;
  }
  return `s${hash.toString(16).padStart(8, '0')}`;
}

// Names declared at the top of the snippet (functions and constants), found by reading the text outside braces and parentheses.
function topLevelNames(code) {
  const outside = [];
  let depth = 0;
  for (const character of code) {
    if (character === '{') {
      depth++;
      outside.push('\n');
    } else if (character === '}') {
      depth--;
    } else if (depth === 0) {
      outside.push(character);
    }
  }
  const text = outside.join('').replace(/\([^()]*\)/g, ' ').replace(/\([^()]*\)/g, ' ');
  const declaration = /(?:^|[;\s])(?:const\s+)?(?:float|int|bool|void|[ibu]?vec[234]|mat[234])(?:\[\d*\])?\s+([A-Za-z_]\w*)(?:\s*\[\d*\])?\s*(?=[=;,]|\s*$|\n)/gm;
  return [...text.matchAll(declaration)].map(match => match[1]);
}

function replaceName(code, name, replacement) {
  return code.replace(new RegExp(`(?<![.\\w])${name}(?!\\w)`, 'g'), () => replacement);
}

// The snippet's functions, constants and uniforms get the feature's prefix, so two materials can use the same names.
function prefixedCode(snippet) {
  const prefix = `u67_${snippet.feature}_`;
  let code = snippet.fragment;
  const names = new Set([...topLevelNames(code), ...Object.keys(snippet.uniforms), 'WaterInputs']);
  for (const name of names) code = replaceName(code, name, `${prefix}${name}`);
  const declarations = snippetUniformDeclarations(Object.fromEntries(Object.entries(snippet.uniforms).map(([name, uniform]) => [`${prefix}${name}`, uniform])));
  return { code, declarations, prefix, hook: `${prefix}materialHook`, waterHook: `${prefix}waterHook`, waterInputs: `${prefix}WaterInputs` };
}

const DEPTH_FRAGMENT_HEAD = 'void main() {\n  if (alphaMasked < 0.5) return;\n  float alpha = materialOpacity;\n  if (hasBaseMap > 0.5) alpha *= texture(baseMap, mapUV(hasBaseMap)).a;\n';
const DEPTH_CODE_MARK = '// u67 material hook code\n';
const DEPTH_CALL_MARK = '  // u67 material hook calls\n';
// Same inputs as the colour pass: white colour, the map alpha, the uv and the world position the vertex shader passes on.
const DEPTH_FRAGMENT_BODY = `void main() {
  vec3 hookColor = vec3(1.0);
  float hookAlpha = hasBaseMap > 0.5 ? texture(baseMap, mapUV(hasBaseMap)).a : 1.0;
${DEPTH_CALL_MARK}  if (alphaMasked < 0.5) return;
  float alpha = materialOpacity * hookAlpha;
`;

function insertAfter(text, marker, addition) {
  return text.replace(marker, () => marker + addition);
}

// The shadow vertex shader passes the world position on, which the hook takes as its fourth input.
function patchDepthVertex(source) {
  if (source.includes('snippetWorld')) return source;
  return source
    .replace('out vec2 textureUV;', () => 'out vec2 textureUV;\nout vec3 snippetWorld;')
    .replace('textureUV = uv;', () => 'textureUV = uv;\n  snippetWorld = world.xyz;');
}

// A materialHook with a fifth `float` parameter gets the frame time; the four-argument form keeps working unchanged.
function hookTakesTime(fragment) {
  return /\bvoid\s+materialHook\s*\([^)]*,\s*float\s+[A-Za-z_]\w*\s*\)/.test(fragment);
}

function registerSnippetFeature(snippet) {
  const { code, declarations, hook, waterHook, waterInputs } = prefixedCode(snippet);
  const flag = `u67_${snippet.feature}`;
  const hasMaterialHook = MATERIAL_HOOK_PATTERN.test(snippet.fragment);
  const hasWaterHook = WATER_HOOK_PATTERN.test(snippet.fragment);
  const waterStruct = hasWaterHook ? `struct ${waterInputs} { ${WATER_INPUTS_FIELDS} };\n` : '';
  const mainCode = replaceName(`uniform float ${flag};\n${declarations}\n${waterStruct}${code}\n`, 'snippetMask', 'baseMap');
  const timeArgument = hookTakesTime(snippet.fragment) ? ', time' : '';
  const call = `if (${flag} > 0.5) ${hook}(hookColor, hookAlpha, textureUV, snippetWorld${timeArgument});\n`;
  // The water values are locals of the main shader; the renderer compiles the world material code in for a snippet with a water hook.
  const waterArguments = `${waterInputs}(normal, viewDirection, waterFoam, 0.0, time, clamp(dot(normal, normalize(lightDirection)), 0.0, 1.0) * visibility)`;
  registerShaderFeatureCode(snippet.feature, Object.freeze({
    libraries: mainCode,
    ...(hasMaterialHook ? { surfaceHook: `  if (${flag} > 0.5) ${hook}(color, textureAlpha, textureUV, worldPosition${timeArgument});\n` } : {}),
    ...(hasWaterHook ? { waterHook: `  if (TAG_WATER && ${flag} > 0.5) ${waterHook}(radiance, ${waterArguments});\n` } : {}),
    depth: (source) => {
      if (!hasMaterialHook) return source;
      if (source.includes('lightProjection * world')) return patchDepthVertex(source);
      let text = source;
      if (!text.includes(DEPTH_CALL_MARK)) {
        text = text.replace('in vec2 textureUV;', () => 'in vec2 textureUV;\nin vec3 snippetWorld;\nuniform float time;')
          .replace(DEPTH_FRAGMENT_HEAD, () => `${DEPTH_CODE_MARK}${DEPTH_FRAGMENT_BODY}`);
      }
      return insertAfter(insertAfter(text, DEPTH_CODE_MARK, mainCode), DEPTH_CALL_MARK, `  ${call}`);
    },
  }));
  registered.set(snippet.feature, { flag, snippet });
}

const registered = new Map();

function setUniformValue(context, location, { type, value }) {
  if (location === null) return;
  if (type === 'float') context.uniform1f(location, value);
  else if (type === 'int') context.uniform1i(location, value);
  else if (type === 'vec2') context.uniform2fv(location, value);
  else if (type === 'vec3') context.uniform3fv(location, value);
  else context.uniform4fv(location, value);
}

// Sets the on/off flag of every snippet this renderer compiled, and the uniform values of the batch material. Materials with identical code share one feature, so the values come from the material, never from the registry.
function bindSnippets(renderer, program, locations, batch) {
  const context = renderer.context;
  const activeSnippet = batch.parts[0].material.snippet;
  const active = activeSnippet?.feature;
  for (const feature of renderer.shaderFeatures) {
    const entry = registered.get(feature);
    if (!entry) continue;
    const locationOf = (name) => {
      locations[name] ??= context.getUniformLocation(program, name);
      return locations[name];
    };
    context.uniform1f(locationOf(entry.flag), feature === active ? 1 : 0);
    if (feature !== active) continue;
    for (const [name, uniform] of Object.entries(activeSnippet.uniforms)) {
      setUniformValue(context, locationOf(`u67_${feature}_${name}`), uniform);
    }
  }
}

// Other optional features also bind per batch, so this keeps whatever was registered first.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindSnippets(renderer, renderer.program, renderer.uniforms, batch);
};

// The shadow pass: the same flags and uniforms on the depth program, and the map on unit 1 when the snippet reads it.
layerTextureSupport.bindDepth = (renderer, batch) => {
  renderer.depthSnippetUniforms ??= {};
  bindSnippets(renderer, renderer.depthProgram, renderer.depthSnippetUniforms, batch);
  if (batch.parts[0].material.snippet?.mask) {
    renderer.context.activeTexture(renderer.context.TEXTURE0 + 1);
    renderer.context.bindTexture(renderer.context.TEXTURE_2D, batch.textures[0]);
  }
};

const PROBE_HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D snippetMask;
out vec4 u67_output;
`;
const waterStructDeclaration = (fragment) => (WATER_HOOK_PATTERN.test(fragment) ? `struct WaterInputs { ${WATER_INPUTS_FIELDS} };
` : '');

function probeFooter(fragment) {
  const timeArgument = hookTakesTime(fragment) ? ', 1.5' : '';
  const materialCall = MATERIAL_HOOK_PATTERN.test(fragment) ? `materialHook(color, alpha, vec2(0.5), vec3(0.0)${timeArgument});` : '';
  const waterCall = WATER_HOOK_PATTERN.test(fragment) ? 'waterHook(color, WaterInputs(vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), 0.5, 0.0, 0.0, 1.0));' : '';
  return `\nvoid main() { vec3 color = vec3(0.5); float alpha = 1.0; ${materialCall} ${waterCall} u67_output = vec4(color, alpha); }\n`;
}

function newProbeContext() {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  return canvas.getContext('webgl2');
}

/**
 * Compiles each distinct snippet of the parts alone, before the renderer builds its programs, so a compile error names the
 * snippet's own line and the running renderer stays untouched. Throws an Error that carries the mapped log.
 */
export function probeMaterialSnippets(parts, createContext = newProbeContext) {
  const snippets = new Map();
  for (const part of parts) {
    const { snippet } = part.material;
    if (snippet && !snippets.has(snippet.feature)) snippets.set(snippet.feature, { snippet, parts: [] });
    if (snippet) snippets.get(snippet.feature).parts.push(part.name);
  }
  if (snippets.size === 0) return;
  const context = createContext();
  if (!context) return;
  try {
    for (const { snippet, parts: users } of snippets.values()) {
      const header = `${PROBE_HEADER}${waterStructDeclaration(snippet.fragment)}${snippetUniformDeclarations(snippet.uniforms)}\n`;
      const shader = context.createShader(context.FRAGMENT_SHADER);
      context.shaderSource(shader, `${header}${snippet.fragment}${probeFooter(snippet.fragment)}`);
      context.compileShader(shader);
      const compiled = context.getShaderParameter(shader, context.COMPILE_STATUS);
      const log = compiled ? '' : context.getShaderInfoLog(shader);
      context.deleteShader(shader);
      if (!compiled) {
        const mapped = mapShaderInfoLog(log, { headerLines: header.split('\n').length - 1, snippet: snippet.fragment });
        const names = users.slice(0, 3).join(', ');
        throw new Error(`Material snippet (used by ${names}${users.length > 3 ? ', ...' : ''}) failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.\n${mapped}`);
      }
    }
  } finally {
    context.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
