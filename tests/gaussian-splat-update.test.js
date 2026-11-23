import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { attachGaussianSplats, createGaussianSplats } from '../src/gaussian-splats.js';

const ROW_WORDS = 2048 * 4;

// A WebGL2 stand-in that keeps each texture's words (texImage2D and texSubImage2D), counts every object it creates and records
// every instanced draw and texture row upload.
function createRecordingRenderer() {
  const textureWords = new Map();
  const framebufferTextures = new Map();
  const state = { boundTexture: null, readFramebuffer: null, created: { texture: 0, buffer: 0, vertexArray: 0, program: 0 }, draws: [], rowUploads: [], orderUploads: [] };
  let nextObject = 0;
  const handlers = {
    isContextLost: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createTexture: () => { state.created.texture++; return { texture: nextObject++ }; },
    createBuffer: () => { state.created.buffer++; return { buffer: nextObject++ }; },
    createVertexArray: () => { state.created.vertexArray++; return { vertexArray: nextObject++ }; },
    createProgram: () => { state.created.program++; return { program: nextObject++ }; },
    createFramebuffer: () => ({ framebuffer: nextObject++ }),
    bindTexture: (target, texture) => { state.boundTexture = texture; },
    texImage2D: (...parameters) => { textureWords.set(state.boundTexture, Uint32Array.from(parameters[8])); },
    texSubImage2D: (target, level, x, y, width, height, format, type, data) => {
      state.rowUploads.push({ firstRow: y, rows: height });
      textureWords.get(state.boundTexture).set(data, y * ROW_WORDS);
    },
    bindFramebuffer: (target, framebuffer) => { if (target === 'READ_FRAMEBUFFER') state.readFramebuffer = framebuffer; },
    framebufferTexture2D: (target, attachment, textureTarget, texture) => { framebufferTextures.set(state.readFramebuffer, texture); },
    bufferSubData: (target, offset, order, sourceOffset, length) => { state.orderUploads.push(Array.from(order.subarray(0, length))); },
    drawArraysInstanced: (mode, first, vertices, instances) => { state.draws.push(instances); },
    getParameter: () => null,
    readPixels: (x, y, width, height, format, type, target) => { target.set(textureWords.get(framebufferTextures.get(state.readFramebuffer))); },
  };
  const context = new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (handlers[name]) return handlers[name];
      if (/^[A-Z_0-9]+$/.test(name)) return name;
      return () => ({ created: name });
    },
  });
  const renderer = {
    context,
    canvas: { width: 64, height: 64 },
    multisampleFramebuffer: {},
    projection: mat4.perspective(mat4.create(), 1, 1, 0.1, 50),
    view: mat4.create(),
    hdr: false,
    drawBlendBatches() {},
    dispose() {},
  };
  return { renderer, state, textureWords, draw: () => renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 }) };
}

function splatData(count, offsetX = 0, scale = 0.1) {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const scales = new Float32Array(count * 3).fill(scale);
  const rotations = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    positions.set([offsetX + index * 0.01, 0, -3 - index * 0.001], index * 3);
    colors.set([10, 20, 30, 255], index * 4);
    rotations[index * 4] = 1;
  }
  return { count, positions, colors, scales, rotations, bounds: { minimum: [offsetX, 0, -4], maximum: [offsetX + count * 0.01, 0, -3] } };
}

function attachSample(count, capacity) {
  const harness = createRecordingRenderer();
  const splats = createGaussianSplats(splatData(count), { capacity });
  const detach = attachGaussianSplats(harness.renderer, splats);
  harness.draw();
  return { ...harness, splats, detach };
}

const dataTexture = harness => [...harness.textureWords.values()].at(-1);
const floatsOf = words => new Float32Array(words.buffer, words.byteOffset, words.length);

test('update changes the drawn data without creating a set, texture, buffer or program (#2756)', () => {
  const sample = attachSample(100, 100);
  const created = { ...sample.state.created };
  const objectsBefore = sample.splats;
  const texture = dataTexture(sample);
  assert.equal(floatsOf(texture)[0], 0);
  const next = splatData(100, 5);
  next.colors.fill(200);
  sample.detach.update({ positions: next.positions, colors: next.colors, scales: next.scales, rotations: next.rotations });
  sample.draw();
  assert.deepEqual(sample.state.created, created);
  assert.equal(sample.splats, objectsBefore);
  assert.equal(dataTexture(sample), texture, 'the same texture object keeps the words');
  assert.equal(floatsOf(texture)[0], 5);
  assert.equal(texture[3], 0xc8c8c8c8);
  assert.equal(sample.state.orderUploads.length, 2, 'the changed centres are sorted and uploaded again');
});

test('the function attachGaussianSplats returns still detaches (#2756)', () => {
  const sample = attachSample(10, 10);
  assert.equal(typeof sample.detach, 'function');
  assert.equal(typeof sample.detach.update, 'function');
  sample.detach();
  assert.equal(sample.splats.packed.words.length, ROW_WORDS);
  assert.throws(() => sample.detach.update({ count: 5 }), /detached.*Attach them again/);
});

test('a set shrinks and grows within its capacity and draws that many splats (#2756)', () => {
  const sample = attachSample(100, 150);
  assert.equal(sample.state.draws.at(-1), 100);
  sample.detach.update({ count: 40 });
  sample.draw();
  assert.equal(sample.state.draws.at(-1), 40);
  const more = splatData(150, 2);
  sample.detach.update({ count: 150, positions: more.positions, colors: more.colors, scales: more.scales });
  sample.draw();
  assert.equal(sample.state.draws.at(-1), 150);
  assert.equal(sample.splats.statistics.count, 150);
  assert.throws(() => sample.detach.update({ count: 151 }), /count must be a whole number from 1 to 150.*larger capacity/);
});

test('a range update re-uploads only the texture rows it touches (#2756)', () => {
  const sample = attachSample(2000, 2000);
  const burst = splatData(10, 9);
  sample.detach.update({ start: 1000, length: 10, positions: burst.positions, colors: burst.colors });
  assert.deepEqual(sample.state.rowUploads, [{ firstRow: 1000 * 3 / 2048 | 0, rows: 1 }]);
  const words = floatsOf(dataTexture(sample));
  assert.equal(words[1000 * 12], 9);
  assert.equal(words[999 * 12], Math.fround(999 * 0.01), 'the neighbour is untouched');
  assert.ok(sample.splats.bounds.maximum[0] >= 9, 'bounds follow the moved centres');
});

test('scales alone are a shape without rotation and the covariance follows them (#2756)', () => {
  const sample = attachSample(4, 4);
  sample.detach.update({ scales: new Float32Array(12).fill(2) });
  const words = floatsOf(dataTexture(sample));
  assert.equal(words[4], 4);
  assert.equal(words[5], 0);
});

test('a bad update throws an error that says what to pass and changes nothing (#2756)', () => {
  const sample = attachSample(10, 20);
  const before = Uint32Array.from(dataTexture(sample));
  const good = splatData(10);
  assert.throws(() => sample.detach.update(null), /needs an object/);
  assert.throws(() => sample.detach.update({ colour: good.colors }), /does not take colour/);
  assert.throws(() => sample.detach.update({ positions: good.positions.subarray(0, 9) }), /positions to hold 30 values/);
  assert.throws(() => sample.detach.update({ positions: new Float32Array(30).fill(NaN) }), /positions\[0\] is NaN.*finite/);
  assert.throws(() => sample.detach.update({ colors: new Float32Array(40) }), /colors as a Uint8Array/);
  assert.throws(() => sample.detach.update({ rotations: good.rotations }), /scales together with rotations/);
  assert.throws(() => sample.detach.update({ scales: new Float32Array(30).fill(1e20) }), /overflows 32-bit floats/);
  assert.throws(() => sample.detach.update({ start: 11 }), /start must be a whole number from 0 to 10/);
  assert.throws(() => sample.detach.update({ start: 5, length: 6 }), /length must be a whole number from 0 to 5/);
  assert.throws(() => sample.detach.update({ count: 15 }), /needs positions for the new splats|needs colors for the new splats|needs positions, colors and scales|grows/);
  assert.throws(() => sample.detach.update({ bounds: { minimum: [0, 0], maximum: [1, 1, 1] } }), /bounds/);
  assert.deepEqual(dataTexture(sample), before);
  assert.equal(sample.splats.count, 10);
});

test('splats with spherical harmonic bands refuse an update and say why (#2756)', () => {
  const harness = createRecordingRenderer();
  const data = { ...splatData(4), sphericalHarmonics: { degree: 1, coefficients: new Float32Array(4 * 9) } };
  const detach = attachGaussianSplats(harness.renderer, createGaussianSplats(data));
  assert.throws(() => detach.update({ count: 2 }), /spherical harmonic bands/);
});

test('capacity is checked at create time (#2756)', () => {
  assert.throws(() => createGaussianSplats(splatData(10), { capacity: 5 }), /capacity must be a whole number from the splat count \(10\)/);
  assert.throws(() => createGaussianSplats(splatData(10), { capacity: 1.5 }), /capacity must be a whole number/);
  assert.equal(createGaussianSplats(splatData(10)).capacity, 10);
  assert.equal(createGaussianSplats(splatData(10), { capacity: 64 }).capacity, 64);
});

test('updated centres move the sort bounds so splats outside the old box still draw (#2756)', () => {
  const sample = attachSample(50, 50);
  const far = splatData(50, 100);
  sample.detach.update({ positions: far.positions });
  assert.ok(sample.splats.bounds.minimum[0] >= 100);
  sample.draw();
  assert.equal(sample.state.draws.at(-1), 50);
  assert.equal(sample.state.orderUploads.at(-1).length, 50);
});
