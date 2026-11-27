import { backendFor } from './glaze-backend.js';
import { RESERVED_WORDS, UNIFORM_NAME_PATTERN, requireKnownFields } from './shader-snippet-validator.js';

// Extra inputs of a user post pass (issue #2954): exact G-buffer passes the pass opts into with `needs`, and read-only palette
// textures (`luts`). Nothing here is in a pass's GLSL unless the pass asks, so a scene that does not opt in compiles the same
// source as before and draws no extra pass.

/** The G-buffer passes a user pass may read: each is the render pass of the same name, drawn without multisampling and read with nearest sampling. */
export const USER_PASS_NEEDS = Object.freeze(['normal', 'objectId', 'albedo', 'emission']);

/** Names a snippet gets for each need; a uniform or palette of the pass may not reuse them. */
const NEED_NAMES = Object.freeze({
  normal: ['normalAt', 'sceneNormal'],
  objectId: ['objectIdAt'],
  albedo: ['albedoAt', 'sceneAlbedo'],
  emission: ['emissionAt', 'sceneEmission'],
});

export const USER_PASS_LUT_LIMITS = Object.freeze({ maxLuts: 4, maxWidth: 256, maxHeight: 16 });
const HEX_COLOR = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

/** Checks `needs` and returns it as a list in canonical order, without duplicates. */
export function normalizeNeeds(needs, label) {
  if (!Array.isArray(needs)) throw new TypeError(`${label}.needs must be a list. Fix: for example ["normal", "objectId"]; the choices are ${USER_PASS_NEEDS.join(', ')}.`);
  for (const need of needs) {
    if (!USER_PASS_NEEDS.includes(need)) throw new RangeError(`${label}.needs has ${JSON.stringify(need)}. Fix: use ${USER_PASS_NEEDS.join(', ')}.`);
  }
  return USER_PASS_NEEDS.filter(need => needs.includes(need));
}

/** The snippet names the engine adds for these needs. */
export function needInputNames(needs = []) {
  return needs.flatMap(need => NEED_NAMES[need]);
}

function bytesToBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

function base64ToBytes(text, where) {
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new TypeError(`${where}.pixels is not valid base64. Fix: send the RGBA bytes as base64, or use "colors".`);
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function colorRow(row, where) {
  if (!Array.isArray(row) || row.length === 0 || row.length > USER_PASS_LUT_LIMITS.maxWidth) {
    throw new RangeError(`${where} must be a list of 1 to ${USER_PASS_LUT_LIMITS.maxWidth} colours. Fix: for example ["#101820", "#f2aa4c"].`);
  }
  return row.flatMap((color, column) => {
    const match = typeof color === 'string' ? HEX_COLOR.exec(color) : null;
    if (!match) throw new TypeError(`${where}[${column}] must be a "#rrggbb" or "#rrggbbaa" colour, got ${JSON.stringify(color)}.`);
    return [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16)).concat(match[2] ? parseInt(match[2], 16) : 255);
  });
}

// Rows of colours, or one flat list that is a single row.
function pixelsFromColors(colors, where) {
  if (!Array.isArray(colors)) throw new TypeError(`${where}.colors must be a list of colours, or a list of such lists (one row each).`);
  const rows = Array.isArray(colors[0]) ? colors : [colors];
  if (rows.length > USER_PASS_LUT_LIMITS.maxHeight) throw new RangeError(`${where}.colors has ${rows.length} rows; the limit is ${USER_PASS_LUT_LIMITS.maxHeight}. Fix: use fewer rows.`);
  const values = rows.map((row, index) => colorRow(row, rows === colors ? `${where}.colors[${index}]` : `${where}.colors`));
  if (values.some(row => row.length !== values[0].length)) throw new RangeError(`${where}.colors rows must all have the same number of colours.`);
  return { width: values[0].length / 4, height: values.length, bytes: Uint8Array.from(values.flat()) };
}

function pixelsFromBytes(entry, where) {
  const { width, height } = entry;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > USER_PASS_LUT_LIMITS.maxWidth || height > USER_PASS_LUT_LIMITS.maxHeight) {
    throw new RangeError(`${where} width and height must be whole numbers up to ${USER_PASS_LUT_LIMITS.maxWidth} by ${USER_PASS_LUT_LIMITS.maxHeight}. Fix: pack a palette into one row, or use "colors".`);
  }
  const bytes = typeof entry.pixels === 'string' ? base64ToBytes(entry.pixels, where)
    : (Array.isArray(entry.pixels) || ArrayBuffer.isView(entry.pixels)) ? Uint8Array.from(entry.pixels) : null;
  if (!bytes) throw new TypeError(`${where}.pixels must be a base64 string, a Uint8Array or an array of bytes. Fix: width x height x 4 RGBA bytes.`);
  if (bytes.length !== width * height * 4) throw new RangeError(`${where}.pixels holds ${bytes.length} bytes; ${width} x ${height} RGBA needs ${width * height * 4}.`);
  if (Array.from(bytes).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new RangeError(`${where}.pixels must be whole numbers from 0 to 255.`);
  return { width, height, bytes };
}

/**
 * Checks a pass's palette textures and returns them as { name: { width, height, pixels } } with `pixels` as base64 RGBA8. Each is
 * `{ colors }` (hex strings, one row or a list of rows) or `{ width, height, pixels }`, at most 256 by 16, and there are at most
 * 4. They are inline data: no URL is read. The pass reads one with `texture(name, uv)` or `texelFetch(name, ivec2(x, y), 0)`.
 */
export function normalizeLuts(luts, { label, reservedNames = [] }) {
  if (!luts || typeof luts !== 'object' || Array.isArray(luts)) throw new TypeError(`${label}.luts must be an object of name: { colors } or { width, height, pixels }.`);
  const names = Object.keys(luts);
  if (names.length > USER_PASS_LUT_LIMITS.maxLuts) throw new RangeError(`${label}.luts has ${names.length} textures; the limit is ${USER_PASS_LUT_LIMITS.maxLuts}. Fix: stack palettes as rows of one texture.`);
  const result = {};
  for (const name of names) {
    const where = `${label}.luts.${name}`;
    if (!UNIFORM_NAME_PATTERN.test(name)) throw new RangeError(`${where}: the name must match ${UNIFORM_NAME_PATTERN}. Fix: start with a lowercase letter, then letters and digits, 32 characters at most.`);
    if (RESERVED_WORDS.has(name) || reservedNames.includes(name)) throw new RangeError(`${where}: the name is a GLSL keyword, an input the engine provides or a uniform of this pass. Fix: pick another name.`);
    const entry = luts[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${where} must be { colors } or { width, height, pixels }.`);
    requireKnownFields(entry, entry.colors === undefined ? ['width', 'height', 'pixels'] : ['colors'], where);
    const { width, height, bytes } = entry.colors === undefined ? pixelsFromBytes(entry, where) : pixelsFromColors(entry.colors, where);
    result[name] = { width, height, pixels: bytesToBase64(bytes) };
  }
  return result;
}

/** The pixels of a normalized palette texture as RGBA bytes. */
export function lutBytes(lut) {
  return base64ToBytes(lut.pixels, 'lut');
}

// One texel by uv, clamped to the texture, so uv 1.0 reads the last texel and nothing wraps.
const TEXEL_HELPER = `ivec2 u67_texelOf(vec2 uv, ivec2 size) { return clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1); }
`;

const NEED_GLSL = Object.freeze({
  // The normal pass stores the world normal as n * 0.5 + 0.5; zero in the sky, where this returns vec3(0).
  normal: `uniform sampler2D sceneNormal;
vec3 normalAt(vec2 uv) {
  vec3 encoded = texelFetch(sceneNormal, u67_texelOf(uv, textureSize(sceneNormal, 0)), 0).rgb;
  return encoded == vec3(0.0) ? vec3(0.0) : normalize(encoded * 2.0 - 1.0);
}
`,
  // The object ID pass packs a 24 bit ID into red, green and blue; 0 is the background. sceneObjectIds is declared with the pass header.
  objectId: `int objectIdAt(vec2 uv) {
  vec3 idBytes = floor(texelFetch(sceneObjectIds, u67_texelOf(uv, textureSize(sceneObjectIds, 0)), 0).rgb * 255.0 + 0.5);
  return int(idBytes.r + idBytes.g * 256.0 + idBytes.b * 65536.0);
}
`,
  albedo: `uniform sampler2D sceneAlbedo;
vec3 albedoAt(vec2 uv) { return texelFetch(sceneAlbedo, u67_texelOf(uv, textureSize(sceneAlbedo, 0)), 0).rgb; }
`,
  emission: `uniform sampler2D sceneEmission;
vec3 emissionAt(vec2 uv) { return texelFetch(sceneEmission, u67_texelOf(uv, textureSize(sceneEmission, 0)), 0).rgb; }
`,
});

/** The GLSL a pass adds to the shared header for its needs and palettes: empty text when it has neither, so such a pass compiles as before. */
export function passInputDeclarations(pass) {
  const needs = pass.needs ?? [];
  const lutNames = Object.keys(pass.luts ?? {}).sort();
  if (needs.length === 0 && lutNames.length === 0) return '';
  const lutLines = lutNames.map(name => `uniform sampler2D ${name};\n`).join('');
  return `${needs.length > 0 ? TEXEL_HELPER : ''}${needs.map(need => NEED_GLSL[need]).join('')}${lutLines}`;
}

/** Which of `needs` a snippet calls without having asked for it, as a message; undefined when all is declared. */
export function missingNeedMessage(snippet, needs = [], label) {
  const called = USER_PASS_NEEDS.filter(need => {
    const helper = NEED_NAMES[need][0];
    const defines = new RegExp(`\\b(?:vec3|int)\\s+${helper}\\s*\\(`).test(snippet);
    return !needs.includes(need) && !defines && new RegExp(`\\b${helper}\\s*\\(`).test(snippet);
  });
  if (called.length === 0) return undefined;
  return `${label} calls ${called.map(need => `${NEED_NAMES[need][0]}()`).join(', ')} without asking for it. Fix: add needs: [${called.map(need => `"${need}"`).join(', ')}] to the pass.`;
}

// Texture units of a pass: 0 colour, 1 depth, 2 object IDs (user-pass.js), then one per captured G-buffer pass and the palettes.
const CAPTURED_UNITS = Object.freeze({ normal: 3, albedo: 4, emission: 5 });
const FIRST_LUT_UNIT = 6;
const CAPTURED_ORDER = Object.freeze(['normal', 'albedo', 'emission']);

// Uploading binds the new texture to the active unit; the binding that was there comes back, so a unit already set up for the draw keeps its texture.
function createInputTexture(backend, width, height, bytes = null) {
  return backend.createDataTexture2D({ width, height, format: 'rgba8', linear: false, clamp: true, data: bytes, restoreBinding: true });
}

/**
 * The runtime of `needs` and `luts` for one renderer. `draw` renders the render passes the passes ask for before the lit frame and
 * keeps a copy of each (the render pass target holds only the last one); a frame whose passes ask for none draws nothing.
 * The object ID pass is drawn last, so it stays in renderer.passSupport.texture where the `objects` mask reads it.
 */
export function createPassInputs(renderer, backend = backendFor(renderer)) {
  const captured = new Map();
  const paletteTextures = new Map();

  function needsOf(passes) {
    return new Set(passes.flatMap(pass => pass.needs ?? []));
  }

  function capture(need, width, height) {
    let copy = captured.get(need);
    if (copy && (copy.width !== width || copy.height !== height)) {
      backend.deleteTexture(copy.texture);
      copy = null;
    }
    copy ??= { texture: createInputTexture(backend, width, height), width, height };
    captured.set(need, copy);
    backend.copyFramebufferToTexture(renderer.passSupport.framebuffer, copy.texture, width, height);
  }

  return {
    /** Draws what the passes need. `renderPass(passFrame)` is the renderer's own render. */
    draw(renderPass, frame, passes, { objectIdDrawn = false } = {}) {
      const needs = needsOf(passes);
      const capturedNeeds = CAPTURED_ORDER.filter(need => needs.has(need));
      const usesObjects = passes.some(pass => pass.objects);
      const wantsObjectIds = needs.has('objectId') || usesObjects;
      const drawsObjectIds = wantsObjectIds && (capturedNeeds.length > 0 || !objectIdDrawn);
      if (capturedNeeds.length === 0 && !drawsObjectIds) return;
      if (!renderer.passSupport) throw new Error('A pass with needs or objects reads the render passes. Fix: call installRenderPasses(renderer) from crucible/addons/render-passes first.');
      const { width, height } = renderer.canvas;
      for (const need of capturedNeeds) {
        renderPass({ ...frame, pass: need, previousCamera: undefined });
        capture(need, width, height);
      }
      if (drawsObjectIds) renderPass({ ...frame, pass: 'objectId', previousCamera: undefined });
    },

    /** Binds the captured passes and palettes of `pass` to their units and points the uniforms at them. */
    bind(pass, locations) {
      for (const need of pass.needs ?? []) {
        if (need === 'objectId') continue;
        backend.bindTextureUnit(CAPTURED_UNITS[need], captured.get(need).texture);
        backend.uniform1i(locations[`scene${need[0].toUpperCase()}${need.slice(1)}`], CAPTURED_UNITS[need]);
      }
      Object.entries(pass.luts ?? {}).sort(([first], [second]) => (first < second ? -1 : 1)).forEach(([name, lut], index) => {
        backend.bindTextureUnit(FIRST_LUT_UNIT + index, this.paletteTexture(pass, name, lut));
        backend.uniform1i(locations[name], FIRST_LUT_UNIT + index);
      });
    },

    /** The texture of one palette, uploaded again only when its pixels changed. */
    paletteTexture(pass, name, lut) {
      const key = `${pass.name}:${name}`;
      const known = paletteTextures.get(key);
      if (known && known.signature === lut.pixels) return known.texture;
      if (known) backend.deleteTexture(known.texture);
      const texture = createInputTexture(backend, lut.width, lut.height, lutBytes(lut));
      paletteTextures.set(key, { signature: lut.pixels, texture });
      return texture;
    },

    /** Drops the palette textures of passes and palettes that are gone. */
    prune(passes) {
      const used = new Set(passes.flatMap(pass => Object.keys(pass.luts ?? {}).map(name => `${pass.name}:${name}`)));
      for (const [key, entry] of paletteTextures) {
        if (used.has(key)) continue;
        backend.deleteTexture(entry.texture);
        paletteTextures.delete(key);
      }
    },

    releaseCaptures() {
      captured.forEach(copy => backend.deleteTexture(copy.texture));
      captured.clear();
    },

    dispose() {
      this.releaseCaptures();
      paletteTextures.forEach(entry => backend.deleteTexture(entry.texture));
      paletteTextures.clear();
    },
  };
}
