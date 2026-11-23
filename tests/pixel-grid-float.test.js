import test from 'node:test';
import assert from 'node:assert/strict';
import { installPixelGrid, snapFrameToGrid } from '../src/pixel-grid.js';
import { readFrame } from '../src/float-output.js';

const GRID = { width: 256, height: 144, pad: 2 };
const OUTPUT = { width: 1280, height: 720 };

function recordingContext(calls) {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name === 'symbol') return undefined;
      if (name === 'READ_FRAMEBUFFER') return 2;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => 1;
      if (name === 'getContextAttributes') return () => ({ alpha: false });
      return (...args) => {
        calls.push([name, ...args]);
        return { name, serial: calls.length };
      };
    },
  });
}

function recordWithGrid(withGrid) {
  const calls = [];
  const realCanvas = { width: OUTPUT.width, height: OUTPUT.height, clientWidth: OUTPUT.width, clientHeight: OUTPUT.height };
  const passTarget = { texture: { name: 'passTexture' }, framebuffer: { name: 'passFramebuffer' } };
  const renderer = {
    context: recordingContext(calls), canvas: realCanvas, postStages: [], pixelRatio: 1, baseSamples: 4, denseSamples: null,
    multisampleSamples: 4, capabilities: { samples: 4 }, benchmark: false,
    backend: { supportedSampleCount: (format, samples) => samples },
    chooseMultisampleSamples() { return this.baseSamples; },
    resize() {
      this.canvas.width = Math.round(this.canvas.clientWidth * this.pixelRatio);
      this.canvas.height = Math.round(this.canvas.clientHeight * this.pixelRatio);
    },
    allocateFrameTargets() {},
    render(renderedFrame) { this.resolveFrame(renderedFrame); },
    resolveFrame() {},
    passSupport: passTarget,
  };
  installPixelGrid(renderer);
  if (withGrid) renderer.pixelGrid.set(GRID);
  return { record: { renderer }, realCanvas, calls, passTarget, renderer };
}

const frame = { eye: [0.013, 3, 10], target: [0.013, 3, 0], up: [0, 1, 0], projection: 'orthographic', orthographicHeight: 14.4 };

test('a float read on a pixel grid crops, shifts and enlarges the padded grid to the full output', () => {
  for (const source of ['frame', 'pass']) {
    const { record, realCanvas, calls, renderer } = recordWithGrid(true);
    // The grid wrapper records the remainder of each rendered frame; a pass is presented, which stores its own.
    renderer.render(frame);
    renderer.render({ ...frame, pass: 'depth' });
    const callsBefore = calls.length;
    const result = readFrame(record, realCanvas, source);
    const read = calls.slice(callsBefore);
    assert.deepEqual([result.width, result.height], [OUTPUT.width, OUTPUT.height]);
    const drawn = read.findIndex(call => call[0] === 'drawArrays');
    assert.ok(drawn >= 0, `${source}: the padded grid is drawn out to the output size before the read`);
    const viewport = read.find(call => call[0] === 'viewport');
    assert.deepEqual(viewport.slice(1), [0, 0, OUTPUT.width, OUTPUT.height], `${source}: the blit covers the whole output`);
    const gridSize = read.find(call => call[0] === 'uniform2f');
    assert.deepEqual(gridSize.slice(2), [GRID.width, GRID.height], `${source}: only the visible grid is spread over the output`);
    assert.equal(read.find(call => call[0] === 'uniform1f')[2], GRID.pad, `${source}: the pad is cropped away`);
    const remainder = read.findLast(call => call[0] === 'uniform2f');
    assert.deepEqual(remainder.slice(2), snapFrameToGrid(frame, GRID).remainder, `${source}: shifted by the frame remainder`);
    const readIndex = read.findIndex(call => call[0] === 'readPixels');
    assert.ok(readIndex > drawn, `${source}: the pixels are read after the blit`);
    const blitTarget = read.slice(0, drawn).findLast(call => call[0] === 'bindFramebuffer');
    const sourceFramebuffer = source === 'pass' ? record.renderer.passSupport.framebuffer : record.floatOutput.output.framebuffer;
    assert.notEqual(blitTarget[2], sourceFramebuffer, `${source}: the blit lands in its own target, not the corner it reads from`);
    const readBind = read.slice(0, readIndex).findLast(call => call[0] === 'bindFramebuffer' && call[1] === 2);
    assert.equal(readBind[2], blitTarget[2], `${source}: the read comes from the enlarged target`);
  }
});

test('a float read without a pixel grid reads the frame or pass framebuffer directly, as before', () => {
  for (const source of ['frame', 'pass']) {
    for (const installed of [false, true]) {
      const { record, realCanvas, calls } = recordWithGrid(false);
      if (!installed) delete record.renderer.pixelGrid;
      const callsBefore = calls.length;
      readFrame(record, realCanvas, source);
      const read = calls.slice(callsBefore).filter(call => !['createTexture', 'createFramebuffer', 'framebufferTexture2D', 'texImage2D', 'texParameteri', 'bindTexture'].includes(call[0]));
      assert.equal(read.filter(call => call[0] === 'drawArrays').length, 0, `${source}: no blit`);
      assert.equal(read.filter(call => call[0] === 'viewport').length, 0, `${source}: no viewport change`);
      const names = read.map(call => call[0]);
      assert.deepEqual(names.filter(name => name === 'readPixels'), ['readPixels']);
      assert.equal(record.gridFloatOutput, undefined, `${source}: no second target is allocated`);
    }
  }
});
