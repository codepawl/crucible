import test from 'node:test';
import assert from 'node:assert/strict';
import { LINE_ART_DEFAULTS, LINE_ART_LIMITS, POLYLINE_STYLES, polylineSegmentOffsets, resolveLineArt, installLineArt } from '../src/line-art.js';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createFragmentShader } from '../src/shaders.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { materialLayerState, MATERIAL_LAYER_STATE_LENGTH } from '../src/material-layers.js';

const BASE_RECIPE = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }],
  materials: [{ id: 'gray', color: [0.5, 0.5, 0.5] }],
  nodes: [{ id: 'block', geometry: 'box', material: 'gray' }],
};

test('an empty lines object resolves to the documented defaults', () => {
  const lines = resolveLineArt({});
  assert.deepEqual(lines, { ...LINE_ART_DEFAULTS, color: [...LINE_ART_DEFAULTS.color] });
  assert.equal(lines.polylines, undefined);
});

test('lines fields are checked with messages that name the field', () => {
  assert.throws(() => resolveLineArt({ width: 0 }), /lines\.width must be a number between 0\.25 and 16/);
  assert.throws(() => resolveLineArt({ color: [1, 1] }), /lines\.color must be three/);
  assert.throws(() => resolveLineArt({ creaseAngle: 200 }), /lines\.creaseAngle/);
  assert.throws(() => resolveLineArt({ boundaries: 'yes' }), /lines\.boundaries must be true or false/);
  assert.throws(() => resolveLineArt({ colour: [0, 0, 0] }), /unknown field: colour/);
  assert.throws(() => resolveLineArt([]), /lines must be a JSON object/);
});

test('polylines take defaults from the outline settings and are bounded', () => {
  const lines = resolveLineArt({ width: 3, color: [1, 0, 0], polylines: [{ points: [[0, 0, 0], [1, 1, 1]] }, { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true, depthTest: false, width: 6 }] });
  assert.deepEqual(lines.polylines[0], { points: [[0, 0, 0], [1, 1, 1]], color: [1, 0, 0], width: 3, depthTest: true, closed: false });
  assert.equal(lines.polylines[1].width, 6);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0]] }] }), /needs 2 to 256 points/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], dashed: true }] }), /unknown field: dashed/);
  const tooMany = Array.from({ length: LINE_ART_LIMITS.maxPolylines + 1 }, () => ({ points: [[0, 0, 0], [1, 0, 0]] }));
  assert.throws(() => resolveLineArt({ polylines: tooMany }), /at most 64 polylines/);
  const longLine = { points: Array.from({ length: 256 }, (_, index) => [index, 0, 0]) };
  assert.throws(() => resolveLineArt({ polylines: Array.from({ length: 17 }, () => longLine) }), /limit is 4096/);
});

test('the recipe markers load the line art module, and the recipe keeps the resolved lines', async () => {
  const recipe = { ...BASE_RECIPE, environment: { lines: { width: 2 } } };
  assert.ok(agentSceneModulesNeeded(recipe).includes('lineArt'));
  assert.ok(agentSceneModulesNeeded({ ...BASE_RECIPE, materials: [{ id: 'gray', toon: 3 }] }).includes('lineArt'));
  assert.ok(!agentSceneModulesNeeded(BASE_RECIPE).includes('lineArt'));
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  assert.equal(scene.environment.lines.width, 2);
  assert.deepEqual(scene.environment.lines.color, [...LINE_ART_DEFAULTS.color]);
  assert.equal(createAgentScene(BASE_RECIPE).environment.lines, undefined);
});

test('a recipe edit with lines null removes the outlines', async () => {
  const recipe = { ...BASE_RECIPE, environment: { lines: {} } };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  scene.apply([{ type: 'set-environment', environment: { lines: { width: 4 } } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.lines.width, 4);
  scene.apply([{ type: 'set-environment', environment: { lines: null } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.lines, undefined);
});

test('a material toon value is a layer field with its own range and shows in the batching state', async () => {
  const recipe = { ...BASE_RECIPE, materials: [{ id: 'gray', color: [0.5, 0.5, 0.5], toon: 3 }] };
  await loadAgentSceneModules(recipe);
  assert.equal(createAgentScene(recipe).parts[0].material.toon, 3);
  assert.throws(() => createAgentScene({ ...recipe, materials: [{ id: 'gray', toon: 9 }] }), /toon must be between 0 and 8/);
  const state = materialLayerState({ tag: 'surface', toon: 4 });
  assert.equal(state.length, MATERIAL_LAYER_STATE_LENGTH);
  assert.equal(state[22], 4);
  assert.equal(materialLayerState({ tag: 'surface' })[22], 0);
});

test('the toon feature splices its light steps into illuminate, and no other shader mentions it', () => {
  const toonShader = createFragmentShader(['toon']);
  assert.match(toonShader, /float toonLight\(float light\)/);
  assert.match(toonShader, /normalLight = toonLight\(normalLight\);/);
  assert.doesNotMatch(createFragmentShader([]), /toonLight/);
});

test('scene_capabilities names the field and the guide', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.lineArt.field, 'environment.lines');
  assert.equal(AGENT_SCENE_CAPABILITIES.lineArt.note, 'docs/line-art.md');
  for (const field of [...Object.keys(LINE_ART_DEFAULTS), 'polylines']) assert.ok(AGENT_SCENE_CAPABILITIES.lineArt.fields.includes(field), `${field} missing`);
  assert.ok(AGENT_SCENE_CAPABILITIES.materialLayers.toon.note);
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.materialLayers.toon.range, [0, 8]);
});

test('installLineArt needs render passes first and leaves a frame without lines untouched', () => {
  assert.throws(() => installLineArt({ postStages: [], render() {} }), /installRenderPasses/);
  const drawn = [];
  const renderer = { postStages: [], passSupport: {}, render: frame => drawn.push(frame), rebuildMainProgram() {} };
  installLineArt(renderer);
  const frame = { eye: [0, 0, 5] };
  renderer.render(frame);
  assert.deepEqual(drawn, [frame]);
  assert.equal(renderer.postStages.length, 1);
  assert.equal(installLineArt(renderer), renderer);
});

test('the MCP scene_create schema accepts lines (or null) and a material toon', async () => {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; } });
  const client = new Client({ name: 'crucible-line-art-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const outline = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'environment' } })).structuredContent.fields;
  assert.match(JSON.stringify(outline['lines?']), /null/);
  const material = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields' } })).structuredContent.fields;
  assert.ok(material['toon?']);
  await client.close();
  await server.close();
});

test('the addon finds the toon uniforms after the main program is rebuilt', () => {
  const located = [];
  const context = {
    getUniformLocation: (program, name) => {
      located.push(`${program}:${name}`);
      return name;
    },
    useProgram() {},
    uniform1f() {},
  };
  const renderer = {
    postStages: [], passSupport: {}, render() {}, program: 'first', uniforms: {}, context,
    rebuildMainProgram() { this.program = 'rebuilt'; },
  };
  installLineArt(renderer);
  assert.deepEqual(located, ['first:materialToon', 'first:toonDefault']);
  renderer.rebuildMainProgram();
  assert.equal(renderer.uniforms.materialToon, 'materialToon');
  assert.ok(located.includes('rebuilt:toonDefault'));
});

const THREE_STEP_COLORS = [[0.2, 0.5, 0.55], [0.6, 0.8, 0.75], [1, 0.92, 0.95]];

test('toonColors needs one colour per toon step, and says what to pass', () => {
  const recipe = { ...BASE_RECIPE, materials: [{ id: 'gray', toon: 3, toonColors: THREE_STEP_COLORS }] };
  assert.deepEqual(createAgentScene(recipe).parts[0].material.toonColors, THREE_STEP_COLORS);
  const withColors = overrides => ({ ...BASE_RECIPE, materials: [{ id: 'gray', ...overrides }] });
  assert.throws(() => createAgentScene(withColors({ toon: 2, toonColors: THREE_STEP_COLORS })), /toonColors must be an array of 2 colours.*change toon to 3/);
  assert.throws(() => createAgentScene(withColors({ toonColors: THREE_STEP_COLORS })), /toonColors needs toon above 0.*Set toon to 3/);
  assert.throws(() => createAgentScene(withColors({ toon: 1, toonColors: [[0, 0, 9]] })), /toonColors\[0\] must be three linear RGB numbers between 0 and 4/);
  assert.throws(() => createAgentScene(withColors({ toon: 1, toonColors: [[0, 0]] })), /toonColors\[0\].*expected an array of 3 numbers/);
});

test('toon step colours show in the batching state and only when set', () => {
  const plain = materialLayerState({ tag: 'surface', toon: 3 });
  const coloured = materialLayerState({ tag: 'surface', toon: 3, toonColors: THREE_STEP_COLORS });
  assert.equal(plain[MATERIAL_LAYER_STATE_LENGTH - 2], '');
  assert.deepEqual(JSON.parse(coloured[MATERIAL_LAYER_STATE_LENGTH - 2]), THREE_STEP_COLORS);
  assert.deepEqual(plain.slice(0, -2), coloured.slice(0, -2));
});

test('the toon shader tints by step only behind the colour uniform, and keeps the grey path', () => {
  const toonShader = createFragmentShader(['toon']);
  assert.match(toonShader, /uniform vec3 materialToonColors\[8\];/);
  assert.match(toonShader, /radiance \*= toonStepColor\(normalLight\);/);
  assert.match(toonShader, /normalLight = toonLight\(normalLight\);/);
  assert.doesNotMatch(createFragmentShader([]), /toonStepColor/);
});

test('the batch bind uploads the step colours padded to eight, and switches them off when absent', async () => {
  const { layerTextureSupport } = await import('../src/shader-registry.js');
  const calls = [];
  const renderer = {
    program: 'main', uniforms: {}, shaderFeatures: new Set(['toon']),
    context: {
      getUniformLocation: (program, name) => name,
      uniform1f: (name, value) => calls.push([name, value]),
      uniform3fv: (name, values) => calls.push([name, Array.from(values)]),
    },
  };
  const coloured = materialLayerState({ tag: 'surface', toon: 3, toonColors: THREE_STEP_COLORS });
  layerTextureSupport.bind(renderer, [], coloured, {});
  assert.deepEqual(calls[0], ['materialToonColored', 1]);
  assert.equal(calls[1][1].length, 24);
  assert.deepEqual(calls[1][1].slice(0, 3).map(value => Math.fround(value)), THREE_STEP_COLORS[0].map(value => Math.fround(value)));
  calls.length = 0;
  layerTextureSupport.bind(renderer, [], materialLayerState({ tag: 'surface', toon: 3 }), {});
  assert.deepEqual(calls, [['materialToonColored', 0], ['materialToonEdge', 0]]);
});

test('the line modes resolve with their defaults and say what to pass when wrong', () => {
  const resolved = resolveLineArt({ colorMode: 'darken', silhouetteSide: 'front', convexHighlight: 0.5 });
  assert.equal(resolved.colorMode, 'darken');
  assert.equal(resolved.darkenFactor, LINE_ART_DEFAULTS.darkenFactor);
  assert.equal(resolved.silhouetteSide, 'front');
  assert.equal(resolved.convexHighlight, 0.5);
  assert.deepEqual([LINE_ART_DEFAULTS.colorMode, LINE_ART_DEFAULTS.silhouetteSide, LINE_ART_DEFAULTS.convexHighlight], ['solid', 'both', 0]);
  assert.throws(() => resolveLineArt({ colorMode: 'multiply' }), /lines\.colorMode must be "solid" or "darken"/);
  assert.throws(() => resolveLineArt({ silhouetteSide: 'back' }), /lines\.silhouetteSide must be "both" or "front"/);
  assert.throws(() => resolveLineArt({ darkenFactor: 1.5 }), /lines\.darkenFactor must be a number between 0 and 1/);
  assert.throws(() => resolveLineArt({ convexHighlight: -1 }), /lines\.convexHighlight must be a number between 0 and 4/);
  assert.deepEqual(resolveLineArt(resolved), resolved, 'a resolved lines object resolves to itself');
});

test('a recipe keeps the line modes and rejects a wrong one with the field name', async () => {
  const recipe = { ...BASE_RECIPE, environment: { lines: { colorMode: 'darken', darkenFactor: 0.54, silhouetteSide: 'front', convexHighlight: 1 } } };
  await loadAgentSceneModules(recipe);
  const lines = createAgentScene(recipe).environment.lines;
  assert.deepEqual([lines.colorMode, lines.darkenFactor, lines.silhouetteSide, lines.convexHighlight], ['darken', 0.54, 'front', 1]);
  assert.throws(() => createAgentScene({ ...BASE_RECIPE, environment: { lines: { silhouetteSide: 'near' } } }), /lines\.silhouetteSide/);
});

test('polyline styles resolve defaults, clamp narrow lines and reject incompatible fields', () => {
  assert.deepEqual(POLYLINE_STYLES, ['solid', 'dashed', 'dotted', 'double']);
  const lines = resolveLineArt({
    width: 2,
    polylines: [
      { points: [[0, 0, 0], [1, 0, 0]], style: 'dashed' },
      { points: [[0, 0, 0], [1, 0, 0]], style: 'dotted', width: 0.25 },
      { points: [[0, 0, 0], [1, 0, 0]], style: 'double', width: 3 },
      { points: [[0, 0, 0], [1, 0, 0]], style: 'dashed', dashLength: 14, gapLength: 5, dashOffset: -12 },
    ],
  });
  assert.deepEqual(lines.polylines[0], {
    points: [[0, 0, 0], [1, 0, 0]],
    color: [...LINE_ART_DEFAULTS.color],
    width: 2,
    depthTest: true,
    closed: false,
    style: 'dashed',
    dashLength: 8,
    gapLength: 4,
    dashOffset: 0,
  });
  assert.equal(lines.polylines[1].style, 'dotted');
  assert.equal(lines.polylines[1].gapLength, 0.5);
  assert.equal(lines.polylines[1].dashOffset, 0);
  assert.equal(lines.polylines[2].style, 'double');
  assert.equal(lines.polylines[2].gapLength, 4.5);
  assert.equal(lines.polylines[3].dashLength, 14);
  assert.equal(lines.polylines[3].gapLength, 5);
  assert.equal(lines.polylines[3].dashOffset, -12);
  assert.deepEqual(resolveLineArt(lines), lines, 'resolved styled polylines stay idempotent');
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'zigzag' }] }), /lines\.polylines\[0\]\.style/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], dashLength: 4 }] }), /sets dashLength on a solid polyline/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'solid', gapLength: 4 }] }), /sets gapLength on a solid polyline/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'dotted', dashLength: 4 }] }), /sets dashLength with style "dotted"/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'double', dashOffset: 4 }] }), /sets dashOffset with style "double"/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'dashed', dashLength: 0.1 }] }), /lines\.polylines\[0\]\.dashLength must be a number between 0\.5 and 256/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'double', gapLength: 300 }] }), /lines\.polylines\[0\]\.gapLength must be a number between 0\.5 and 256/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], style: 'dotted', dashOffset: 2e5 }] }), /lines\.polylines\[0\]\.dashOffset must be a number between -100000 and 100000/);
});

test('polylineSegmentOffsets accumulates screen pixels around corners and clips near the camera plane', () => {
  const identityProjection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const lShape = [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 0.5, 0]];
  assert.deepEqual(Array.from(polylineSegmentOffsets({ points: lShape, closed: false, style: 'solid' }, identityProjection, 200, 100)), [0, 0]);
  assert.deepEqual(Array.from(polylineSegmentOffsets({ points: lShape, closed: false, style: 'double' }, identityProjection, 200, 100)), [0, 0]);
  const offsets = Array.from(polylineSegmentOffsets({ points: lShape, closed: true, style: 'dashed' }, identityProjection, 200, 100));
  assert.deepEqual(offsets, [0, 100, 125]);
  // Column-major matrix where clip.w = point.z, exercising behind-camera and near-plane clipping paths.
  const wFromZ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  const clipped = Array.from(polylineSegmentOffsets({
    points: [[0, 0, -1], [0, 0, -2], [0, 0, 1], [1, 0, 1]],
    closed: false,
    style: 'dotted',
  }, wFromZ, 200, 200));
  assert.deepEqual(clipped, [0, 0, 0]);
});

test('drawPolylines binds style uniforms, per-segment offsets for dashed/dotted, and deletes buffers on dispose', () => {
  const shaderSources = [];
  const uniform1fCalls = [];
  const uniform3fCalls = [];
  const bufferUploads = [];
  const disabledAttribs = [];
  const attrib1fCalls = [];
  const deletedBuffers = [];
  let nextId = 1;
  const context = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    TEXTURE_2D: 5,
    NEAREST: 6,
    LINEAR: 7,
    TEXTURE_MIN_FILTER: 8,
    TEXTURE_MAG_FILTER: 9,
    TEXTURE_WRAP_S: 10,
    TEXTURE_WRAP_T: 11,
    CLAMP_TO_EDGE: 12,
    FRAMEBUFFER: 13,
    COLOR_ATTACHMENT0: 14,
    FRAMEBUFFER_COMPLETE: 15,
    RGBA16F: 16,
    RGBA8: 17,
    RGBA: 18,
    HALF_FLOAT: 19,
    UNSIGNED_BYTE: 20,
    TEXTURE0: 100,
    BLEND: 21,
    ONE: 22,
    ONE_MINUS_SRC_ALPHA: 23,
    DEPTH_TEST: 24,
    CULL_FACE: 25,
    ARRAY_BUFFER: 26,
    STATIC_DRAW: 27,
    DYNAMIC_DRAW: 28,
    FLOAT: 29,
    TRIANGLES: 30,
    createShader: kind => ({ kind }),
    shaderSource: (shader, source) => {
      shader.source = source;
      shaderSources.push(source);
    },
    compileShader() {},
    getShaderParameter: () => true,
    createProgram: () => ({ id: nextId++ }),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getUniformLocation: (program, name) => name,
    getAttribLocation: (program, name) => ({ startPoint: 0, endPoint: 1, startOffset: 2 }[name] ?? -1),
    createTexture: () => ({ id: nextId++ }),
    bindTexture() {},
    texImage2D() {},
    texParameteri() {},
    createFramebuffer: () => ({ id: nextId++ }),
    bindFramebuffer() {},
    framebufferTexture2D() {},
    checkFramebufferStatus: () => 15,
    createVertexArray: () => ({ id: nextId++ }),
    bindVertexArray() {},
    createBuffer: () => ({ id: nextId++ }),
    bindBuffer() {},
    bufferData: (target, data, usage) => bufferUploads.push({ data: Array.from(data), usage }),
    deleteBuffer: buffer => deletedBuffers.push(buffer),
    deleteTexture() {},
    deleteFramebuffer() {},
    deleteProgram() {},
    deleteVertexArray() {},
    useProgram() {},
    activeTexture() {},
    uniform1i() {},
    uniform1f: (location, value) => uniform1fCalls.push([location, value]),
    uniform2f() {},
    uniform3f: (location, x, y, z) => uniform3fCalls.push([location, x, y, z]),
    uniform3fv() {},
    uniformMatrix4fv() {},
    viewport() {},
    disable() {},
    enable() {},
    blendFuncSeparate() {},
    enableVertexAttribArray() {},
    disableVertexAttribArray: location => disabledAttribs.push(location),
    vertexAttribPointer() {},
    vertexAttribDivisor() {},
    vertexAttrib1f: (location, value) => attrib1fCalls.push([location, value]),
    drawArrays() {},
    drawArraysInstanced() {},
  };
  const identityProjection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let resultTexture = null;
  const renderer = {
    context,
    canvas: { width: 200, height: 100 },
    depthTexture: { id: 99 },
    hdr: false,
    projection: identityProjection,
    viewProjection: identityProjection,
    view: identityProjection,
    postStages: [],
    passSupport: {},
    render(frame) {
      resultTexture = this.postStages[0].apply(this, frame, {}, { id: 88 });
    },
    rebuildMainProgram() {},
    requireFeatureNames() {},
  };
  installLineArt(renderer);
  const resolved = resolveLineArt({
    boundaries: false,
    creaseAngle: 0,
    depthJump: 0,
    polylines: [
      { points: [[0, 0, 0], [1, 0, 0]], width: 2 },
      { points: [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 0.5, 0]], style: 'dashed', dashLength: 12, gapLength: 6, dashOffset: 3, width: 2 },
      { points: [[0, 0, 0], [0.5, 0, 0]], style: 'dotted', gapLength: 5, dashOffset: -2, width: 3 },
      { points: [[0, 0.2, 0], [1, 0.2, 0]], style: 'double', gapLength: 4, width: 2 },
    ],
  });
  renderer.render({ eye: [0, 0, 5], lines: resolved });
  assert.ok(resultTexture);
  assert.ok(shaderSources.some(source => source.includes('railOffset') && source.includes('fromDashCenter') && source.includes('fromDotCenter')));
  assert.deepEqual(
    uniform1fCalls.filter(([location]) => location === 'lineStyle').map(([, value]) => value),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    uniform3fCalls.filter(([location]) => location === 'dashPattern').map(([, x, y, z]) => [x, y, z]),
    [[0, 0, 0], [12, 6, 3], [0, 5, -2], [0, 4, 0]],
  );
  assert.deepEqual(disabledAttribs, [2, 2]);
  assert.deepEqual(attrib1fCalls, [[2, 0], [2, 0]]);
  const dynamicUploads = bufferUploads.filter(upload => upload.usage === context.DYNAMIC_DRAW).map(upload => upload.data);
  assert.deepEqual(dynamicUploads, [[0, 100], [0]]);
  renderer.postStages[0].dispose(context);
  assert.equal(deletedBuffers.length, 5);
});

function createOutlineStageMock() {
  const passes = [];
  const texImageUploads = [];
  let objectNodesCalls = 0;
  const groups = { wall: [1], hero: [2] };
  const passTextures = { objectId: 'id-tex', normal: 'normal-tex' };
  let activePassTexture = null;
  let nextTextureId = 1;
  const context = {
    RGBA16F: 1, RGBA8: 2, RGBA32F: 3, RGBA: 4, HALF_FLOAT: 5, UNSIGNED_BYTE: 6, FLOAT: 7,
    TEXTURE_2D: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10, TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12,
    NEAREST: 13, LINEAR: 14, CLAMP_TO_EDGE: 15, FRAMEBUFFER: 16, COLOR_ATTACHMENT0: 17,
    FRAMEBUFFER_COMPLETE: 18, READ_FRAMEBUFFER: 19, DRAW_FRAMEBUFFER: 20, COLOR_BUFFER_BIT: 21,
    TRIANGLES: 22, DEPTH_TEST: 23, CULL_FACE: 24, TEXTURE0: 100,
    VERTEX_SHADER: 25, FRAGMENT_SHADER: 26, COMPILE_STATUS: 27, LINK_STATUS: 28,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getUniformLocation: (program, name) => name,
    createTexture: () => ({ id: nextTextureId++ }),
    deleteTexture() {},
    createFramebuffer: () => ({}),
    deleteFramebuffer() {},
    bindTexture() {},
    bindFramebuffer() {},
    framebufferTexture2D() {},
    blitFramebuffer() {},
    checkFramebufferStatus: () => 18,
    texParameteri() {},
    texImage2D: (...args) => texImageUploads.push({ internalFormat: args[2], width: args[3], height: args[4] }),
    activeTexture() {},
    useProgram() {},
    uniform1i() {},
    uniform1f() {},
    uniform3f() {},
    uniform3fv() {},
    viewport() {},
    disable() {},
    bindVertexArray() {},
    drawArrays() {},
  };
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const projection = new Float32Array(16);
  projection[10] = -1;
  projection[14] = -0.2;
  const renderer = {
    canvas: { width: 64, height: 64 },
    context,
    hdr: false,
    depthTexture: 'depth-tex',
    view,
    projection,
    batches: [{ parts: [] }],
    postStages: [],
    passSupport: {
      framebuffer: 'pass-fbo',
      get texture() { return activePassTexture; },
      objectNodes() {
        objectNodesCalls += 1;
        return groups;
      },
    },
    render(frame) {
      passes.push(frame.pass ?? 'main');
      if (frame.pass) {
        activePassTexture = passTextures[frame.pass];
        return;
      }
      renderer.postStages[0].apply(renderer, frame, {}, 'scene-tex');
    },
    rebuildMainProgram() {},
  };
  installLineArt(renderer);
  return {
    renderer,
    passes,
    texImageUploads,
    getActivePassTexture: () => activePassTexture,
    getObjectNodesCalls: () => objectNodesCalls,
  };
}

test('drawGuides renders normal before objectId so passSupport.texture holds objectId (#3496)', () => {
  const { renderer, passes, getActivePassTexture } = createOutlineStageMock();
  renderer.render({ lines: resolveLineArt({ creaseAngle: 35, boundaries: true }) });
  assert.deepEqual(passes, ['normal', 'objectId', 'main']);
  assert.equal(getActivePassTexture(), 'id-tex');
});

test('creaseAngle 0 with silhouetteSide both skips the normal pass and its target, while front keeps it (#3491)', () => {
  const { renderer, passes, texImageUploads } = createOutlineStageMock();
  renderer.render({ lines: resolveLineArt({ creaseAngle: 0, boundaries: true, depthJump: 0 }) });
  assert.deepEqual(passes, ['objectId', 'main']);
  const rgba8Targets = texImageUploads.filter(upload => upload.internalFormat === 2);
  // Output color target + one 'part' guide target (no 'normal' guide target allocated).
  assert.equal(rgba8Targets.length, 2);

  passes.length = 0;
  renderer.render({ lines: resolveLineArt({ creaseAngle: 0, boundaries: true, silhouetteSide: 'front' }) });
  assert.deepEqual(passes, ['normal', 'objectId', 'main']);
});

test('nodeTexture upload and objectNodes lookup are cached across unchanged frames (#3491)', () => {
  const { renderer, texImageUploads, getObjectNodesCalls } = createOutlineStageMock();
  const countNodeUploads = () => texImageUploads.filter(upload => upload.internalFormat === 3).length;
  const lines = resolveLineArt({ creaseAngle: 0, nodes: { hero: { silhouetteOnly: true } } });

  renderer.render({ lines });
  assert.equal(countNodeUploads(), 1);
  assert.equal(getObjectNodesCalls(), 1);

  renderer.render({ lines });
  renderer.render({ lines });
  assert.equal(countNodeUploads(), 1, 'identical lines and batches reuse cached nodeTexture');
  assert.equal(getObjectNodesCalls(), 1, 'identical lines and batches skip objectNodes scan');

  const changedNodes = resolveLineArt({ creaseAngle: 0, nodes: { hero: { lines: false } } });
  renderer.render({ lines: changedNodes });
  assert.equal(countNodeUploads(), 2, 'changing lines.nodes invalidates the cache');

  renderer.batches = [{ parts: [] }, { parts: [] }];
  renderer.render({ lines: changedNodes });
  assert.equal(countNodeUploads(), 3, 'replacing renderer.batches invalidates the cache');

  renderer.render({ lines: resolveLineArt({ creaseAngle: 0 }) });
  assert.equal(countNodeUploads(), 4, 'toggling nodes off uploads empty 1x1 table');
  renderer.render({ lines: changedNodes });
  assert.equal(countNodeUploads(), 5, 're-enabling nodes after empty frame re-uploads');

  renderer.postStages[0].releaseTargets(renderer.context);
  renderer.render({ lines: changedNodes });
  assert.equal(countNodeUploads(), 6, 'releaseTargets clears the cached nodeTexture');
});
