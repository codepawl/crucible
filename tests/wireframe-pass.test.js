import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { installRenderPasses } from '../src/render-passes.js';
import { ADDON_CATALOG } from '../src/addon-catalog.js';
import { withWireframe, MAXIMUM_WIREFRAME_REPORTED_PARTS, WIREFRAME_COLORS } from '../src/wireframe-pass.js';
import { RENDER_PASS_NAMES } from '../src/agent-scene-capabilities.js';

// A context that records every call; constants read back as their own names and shader and program checks succeed.
function recordingContext(calls) {
  const answers = { getShaderParameter: () => true, getProgramParameter: () => true, checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE', getUniformLocation: (_program, name) => name, getExtension: () => ({}), isContextLost: () => false };
  return new Proxy({}, {
    get(_target, name) {
      if (name in answers) return answers[name];
      if (name === name.toUpperCase()) return name;
      return (...parameters) => {
        calls.push([name, ...parameters]);
        return {};
      };
    },
  });
}

// An open box (five quads as ten triangles) as renderer geometry: four boundary edges, no triangulation diagonals drawn.
function openBoxGeometry() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const quads = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const indices = quads.flatMap(([firstCorner, secondCorner, thirdCorner, fourthCorner]) => [firstCorner, secondCorner, thirdCorner, firstCorner, thirdCorner, fourthCorner]);
  return { positions, normals: new Float32Array(positions.length), indices: new Uint32Array(indices) };
}

function rendererWith(parts, calls, extra = {}) {
  const batch = { parts, layerState: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], textures: [] };
  const renderer = {
    context: recordingContext(calls),
    canvas: { width: 8, height: 8 },
    benchmark: false,
    program: {},
    viewProjection: mat4.create(),
    renderTargets: { record: () => {}, release: () => {} },
    requireFeatureNames: () => {},
    drawsInOpaqueLoop: () => true,
    batches: [batch],
    ...extra,
  };
  installRenderPasses(renderer);
  renderer.passSupport.prepare({ pass: 'wireframe' });
  return renderer;
}

const identity = () => mat4.create();

test('wireframe is a named pass that draws as the diffuse pass on a light background', () => {
  assert.equal(RENDER_PASS_NAMES.at(-1), 'wireframe');
  const renderer = rendererWith([], []);
  assert.equal(renderer.passSupport.prepare({ pass: 'wireframe' }), renderer.passSupport.prepare({ pass: 'diffuse' }));
  assert.deepEqual(renderer.passSupport.background('wireframe'), [0.82, 0.84, 0.86, 1]);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'beauty' }), /Unknown render pass: beauty\. Use .*wireframe/);
});

test('the overlay runs only while a wireframe frame renders and reports edge counts and faulty parts', () => {
  const calls = [];
  const geometry = openBoxGeometry();
  const renderer = rendererWith([{ name: 'open-box', geometry, matrix: identity() }, { name: 'second', geometry, matrix: identity() }], calls);
  renderer.passSupport.copyToCanvas();
  assert.equal(calls.some(call => call[0] === 'drawArraysInstanced'), false, 'A plain pass frame draws no edges.');
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(renderer.passSupport.overlay, null);
  assert.deepEqual(report.edges, { regular: 16, boundary: 8, nonManifold: 0, flipped: 0, degenerate: 0 });
  assert.deepEqual(report.faultyParts.map(part => part.part), ['open-box', 'second']);
  assert.equal(report.partsOmitted, 0);
  const draws = calls.filter(call => call[0] === 'drawArraysInstanced');
  assert.deepEqual(draws.map(call => call.slice(1)), [['TRIANGLES', 0, 6, 12], ['TRIANGLES', 0, 6, 12]]);
});

test('depth state follows the pass: reversed-Z tests GEQUAL with a projection of its own, standard depth tests LEQUAL', () => {
  const part = { name: 'open-box', geometry: openBoxGeometry(), matrix: identity() };
  const standardCalls = [];
  const standard = rendererWith([part], standardCalls);
  withWireframe(standard, () => standard.passSupport.copyToCanvas());
  assert.deepEqual(standardCalls.find(call => call[0] === 'depthFunc').slice(1), ['LEQUAL']);
  const reversedCalls = [];
  const reversed = rendererWith([part], reversedCalls, { reversedDepth: true, rasterViewProjection: mat4.create() });
  withWireframe(reversed, () => reversed.passSupport.copyToCanvas());
  assert.deepEqual(reversedCalls.filter(call => call[0] === 'depthFunc').map(call => call[1]), ['GEQUAL', 'GREATER']);
  assert.deepEqual(standardCalls.filter(call => call[0] === 'depthFunc').map(call => call[1]), ['LEQUAL', 'LESS']);
});

test('a part with no polygon view is skipped and counted instead of failing the frame', () => {
  const collapsed = { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  const renderer = rendererWith([{ name: 'flat', geometry: collapsed, matrix: identity() }], []);
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(report.partsSkipped, 1);
  assert.equal(report.edges.regular, 0);
});

test('the report names at most the worst parts and says how many it left out', () => {
  const parts = Array.from({ length: MAXIMUM_WIREFRAME_REPORTED_PARTS + 3 }, (_unused, index) => ({ name: `part-${index}`, geometry: openBoxGeometry(), matrix: identity() }));
  const renderer = rendererWith(parts, []);
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(report.faultyParts.length, MAXIMUM_WIREFRAME_REPORTED_PARTS);
  assert.equal(report.faultyPartsOmitted, 3);
});

test('the buffers and vertex arrays a frame creates are deleted when the frame is done', () => {
  const calls = [];
  const geometry = openBoxGeometry();
  const parts = [{ name: 'a', geometry, matrix: identity() }, { name: 'b', geometry, matrix: identity() }, { name: 'c', geometry: openBoxGeometry(), matrix: identity() }];
  const renderer = rendererWith(parts, calls);
  withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  const count = name => calls.filter(call => call[0] === name).length;
  assert.equal(count('createBuffer'), 2, 'One buffer per distinct geometry, shared by parts that use it.');
  assert.equal(count('deleteBuffer'), count('createBuffer'));
  assert.equal(count('deleteVertexArray'), count('createVertexArray'));
  assert.ok(count('deleteVertexArray') > 0);
});

test('a frame that never reaches the canvas copy is an error, and the overlay is removed', () => {
  const renderer = rendererWith([], []);
  assert.throws(() => withWireframe(renderer, () => {}), /drew no frame/);
  assert.equal(renderer.passSupport.overlay, null);
  assert.throws(() => withWireframe(renderer, () => { throw new Error('boom'); }), /boom/);
  assert.equal(renderer.passSupport.overlay, null);
});

function styleUniforms(options) {
  const calls = [];
  const renderer = rendererWith([{ name: 'open-box', geometry: openBoxGeometry(), matrix: identity() }], calls);
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas(), options);
  const uniformOf = name => calls.find(call => call[0] === name)[2];
  return { report, colors: Array.from(uniformOf('uniform3fv')), halfWidths: Array.from(uniformOf('uniform1fv')) };
}

test('the default style keeps the repair colours and double-width faults exactly', () => {
  const { colors, halfWidths } = styleUniforms(undefined);
  assert.deepEqual(colors, WIREFRAME_COLORS.flat());
  assert.deepEqual(halfWidths, [0.7, 1.6, 1.6, 1.6, 1.6]);
  assert.deepEqual(styleUniforms({}), styleUniforms({ faults: true }));
});

test('faults: false draws every edge kind in one colour and width and still counts the faults', () => {
  const { report, colors, halfWidths } = styleUniforms({ faults: false });
  const regularColor = WIREFRAME_COLORS[0];
  assert.deepEqual(colors, Array.from({ length: 5 }, () => regularColor).flat());
  assert.deepEqual(halfWidths, [0.7, 0.7, 0.7, 0.7, 0.7]);
  assert.equal(report.edges.boundary, 4);
  const custom = styleUniforms({ faults: false, color: [0.5, 0.25, 1], halfWidth: 2 });
  assert.deepEqual(custom.colors, Array.from({ length: 5 }, () => [0.5, 0.25, 1]).flat());
  assert.deepEqual(custom.halfWidths, [2, 2, 2, 2, 2]);
});

test('color and halfWidth restyle regular edges and leave the faults alone while faults is on', () => {
  const { colors, halfWidths } = styleUniforms({ color: [1, 1, 1], halfWidth: 3 });
  assert.deepEqual(colors, [1, 1, 1, ...WIREFRAME_COLORS.slice(1).flat()]);
  assert.deepEqual(halfWidths, [3, 1.6, 1.6, 1.6, 1.6]);
});

test('bad style options are rejected with what to pass instead', () => {
  const renderer = rendererWith([], []);
  const draw = options => withWireframe(renderer, () => renderer.passSupport.copyToCanvas(), options);
  assert.throws(() => draw(null), /options must be an object/);
  assert.throws(() => draw({ faults: 'no' }), /faults must be true or false.*faults: false/);
  assert.throws(() => draw({ color: [1, 0] }), /color must be three numbers from 0 to 1/);
  assert.throws(() => draw({ color: [2, 0, 0] }), /color must be three numbers/);
  assert.throws(() => draw({ halfWidth: 0 }), /halfWidth must be a number above 0/);
  assert.throws(() => draw({ halfWidth: 1000 }), /halfWidth must be a number above 0 and at most 32/);
});

test('the wireframe addon is a stable package subpath built from its own entry', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.exports['./addons/wireframe-pass'], './build/wireframe-pass.js');
  const viteConfig = readFileSync(new URL('../config/vite.lib.config.js', import.meta.url), 'utf8');
  assert.match(viteConfig, /'wireframe-pass': 'src\/wireframe-pass\.js'/);
  assert.ok(ADDON_CATALOG.some(addon => addon.name === 'wireframe-pass'));
});
