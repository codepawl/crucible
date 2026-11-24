import test from 'node:test';
import assert from 'node:assert/strict';
import { createFragmentShader, SHADER_FEATURES } from '../src/shaders.js';
import '../src/light-shapes.js';

// WebGL 2 GPUs report MAX_FRAGMENT_UNIFORM_VECTORS from 256 (Qualcomm Adreno) up to 1,024 and more (Apple, desktop). ANGLE
// refuses to link a program whose default-block uniforms do not pack into that many rows under the GLSL ES 3.00 rules.
const ADRENO_FRAGMENT_UNIFORM_VECTORS = 256;
// Rows kept free for a snippet or feature added later. A shader that lands within this of the limit fails here, not on a phone.
const HEADROOM_ROWS = 16;

const COMPONENTS = { float: 1, int: 1, uint: 1, bool: 1, vec2: 2, ivec2: 2, uvec2: 2, bvec2: 2, vec3: 3, ivec3: 3, uvec3: 3, bvec3: 3, vec4: 4, ivec4: 4, uvec4: 4, bvec4: 4 };

function typeShape(type) {
  const matrix = /^mat([234])(?:x([234]))?$/.exec(type);
  if (matrix) return { rowsPerElement: Number(matrix[1]), packable: false };
  if (!(type in COMPONENTS)) return undefined;
  return { rowsPerElement: 1, components: COMPONENTS[type], packable: true };
}

// A uniform the code never reads is dropped by the compiler and takes no row.
function isStaticallyUsed(source, name) {
  return source.match(new RegExp(`\\b${name}\\b`, 'g')).length > 1;
}

/**
 * Rows the default-block uniforms of a GLSL ES 3.00 shader take under the Appendix A packing: arrays and matrices own whole
 * rows (one row per element, or per matrix column), and the plain vec3, vec2 and scalar uniforms share the rows left over.
 * Samplers and uniform blocks do not count against the limit.
 */
export function countPackedUniformRows(rawSource) {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let wholeRows = 0;
  const loose = [];
  for (const match of source.matchAll(/^uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)(?:\[(\d+)\])?\s*;/gm)) {
    const shape = typeShape(match[1]);
    if (!shape || !isStaticallyUsed(source, match[2])) continue;
    const arrayLength = match[3] === undefined ? undefined : Number(match[3]);
    if (arrayLength !== undefined || !shape.packable || shape.components === 4) wholeRows += shape.rowsPerElement * (arrayLength ?? 1);
    else loose.push(shape.components);
  }
  const free = [];
  for (const components of loose.sort((a, b) => b - a)) {
    const row = free.findIndex(available => available >= components);
    if (row >= 0) free[row] -= components;
    else free.push(4 - components);
  }
  return wholeRows + free.length;
}

const features = [...SHADER_FEATURES, 'areaShadows', 'lightProfiles'];

test('the main fragment shader packs into the 256 uniform vectors of an Adreno GPU with every feature and the light shapes on', () => {
  const rows = countPackedUniformRows(createFragmentShader(features));
  assert.ok(rows <= ADRENO_FRAGMENT_UNIFORM_VECTORS - HEADROOM_ROWS, `${rows} packed uniform rows; Adreno links at most ${ADRENO_FRAGMENT_UNIFORM_VECTORS}. Keep per-light arrays in the LightData uniform block.`);
});

test('the main fragment shader with only the core features packs into 256 vectors too', () => {
  const rows = countPackedUniformRows(createFragmentShader(SHADER_FEATURES));
  assert.ok(rows <= ADRENO_FRAGMENT_UNIFORM_VECTORS - HEADROOM_ROWS, `${rows} packed uniform rows`);
});

test('the row counter follows the packing rules', () => {
  const readEveryUniform = '\nvoid main() { a; b; c; d; s; lights; }';
  assert.equal(countPackedUniformRows('uniform vec4 a[3];\nuniform mat4 b;\nuniform float c[5];' + readEveryUniform), 12);
  assert.equal(countPackedUniformRows('uniform vec3 a;\nuniform float b;\nuniform vec2 c;\nuniform vec2 d;\nuniform sampler2D s;' + readEveryUniform), 2);
  assert.equal(countPackedUniformRows('uniform LightData {\n  vec4 a[100];\n} lights;' + readEveryUniform), 0);
  assert.equal(countPackedUniformRows('uniform vec4 a[3];\nvoid main() {}'), 0, 'a uniform nothing reads takes no row');
});
