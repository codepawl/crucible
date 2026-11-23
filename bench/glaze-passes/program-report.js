// Runs in the page (#2144): describes the colour fragment program a renderer compiled for a scene.
// It lists the feature defines and which of them still branch on a uniform at run time, the program size before and after the
// driver's translation, and the parts grouped by the runtime gated features they actually use (the groups a per material program would split).
import { shaderFeaturesOfParts } from '../../src/renderer.js';

export const RUNTIME_GATED_FEATURES = ['normalMap', 'baseMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'lightMap', 'boxMapScale', 'moss', 'alphaMode', 'spotLights', 'areaLights', 'sheen', 'clearcoat', 'surfaceWear', 'splat', 'renderPass', 'floor', 'water', 'foliage', 'terrain', 'grass', 'fire', 'smoke', 'unlit'];

export function installColourProgramRecorder() {
  const prototype = WebGL2RenderingContext.prototype;
  const originalSource = prototype.shaderSource;
  const originalAttach = prototype.attachShader;
  const originalLink = prototype.linkProgram;
  const colourSources = new Map();
  const colourPrograms = new Set();
  const records = [];
  prototype.shaderSource = function shaderSource(shader, source) {
    if (source.includes('float shadowVisibility')) colourSources.set(shader, source);
    return originalSource.call(this, shader, source);
  };
  prototype.attachShader = function attachShader(program, shader) {
    if (colourSources.has(shader)) colourPrograms.add(program);
    return originalAttach.call(this, program, shader);
  };
  prototype.linkProgram = function linkProgram(program) {
    originalLink.call(this, program);
    if (!colourPrograms.has(program)) return;
    const shader = this.getAttachedShaders(program).find(candidate => colourSources.has(candidate));
    records.push({ context: this, program, shader, source: colourSources.get(shader) });
  };
  return {
    records,
    uninstall() {
      prototype.shaderSource = originalSource;
      prototype.attachShader = originalAttach;
      prototype.linkProgram = originalLink;
    },
  };
}

function lineCount(text) {
  return text.split('\n').length;
}

export function describeProgram({ context, program, shader, source }) {
  const debugShaders = context.getExtension('WEBGL_debug_shaders');
  const translated = debugShaders ? debugShaders.getTranslatedShaderSource(shader) : '';
  const defineLines = source.split('\n').filter(line => /^#define (USES_|TAG_|FILL_ON|BOX_MAPPED|ENVIRONMENT_ENABLED|LIGHT_SHADING|CANOPY_TAG|SHADOW_IN_FRAGMENT|INSTANCED|VERTEX_COLORS|SURFACE_WEAR)/.test(line));
  const nameOf = line => line.split(' ')[1];
  return {
    sourceLines: lineCount(source),
    translatedLines: translated ? lineCount(translated) : null,
    activeUniforms: context.getProgramParameter(program, context.ACTIVE_UNIFORMS),
    compiledOut: defineLines.filter(line => /\sfalse$/.test(line)).map(nameOf),
    alwaysOn: defineLines.filter(line => /\strue$/.test(line)).map(nameOf),
    gatedByUniform: defineLines.filter(line => !/\s(false|true)$/.test(line)).map(line => line.slice('#define '.length)),
  };
}

export function describeColourPrograms(recorder, parts) {
  const signatures = describeSignatureGroups(parts);
  return recorder.records.map((record, index) => ({ index, ...describeProgram(record), signatures }));
}

export function signatureOfPart(part) {
  const features = shaderFeaturesOfParts([part]);
  return RUNTIME_GATED_FEATURES.filter(feature => features.has(feature)).join('+') || 'none';
}

function describeSignatureGroups(parts) {
  const groups = new Map();
  for (const part of parts) {
    const signature = signatureOfPart(part);
    const group = groups.get(signature) ?? { signature, parts: 0, triangles: 0 };
    group.parts += 1;
    group.triangles += part.geometry.indices.length / 3;
    groups.set(signature, group);
  }
  return [...groups.values()].sort((first, second) => second.triangles - first.triangles);
}
