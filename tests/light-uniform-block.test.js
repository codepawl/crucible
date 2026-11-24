import test from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_DATA_BLOCK, UniformBlockBuffer, uniformBlockByteSize, uniformBlockDeclaration } from '../src/light-uniform-block.js';

// MAX_UNIFORM_BLOCK_SIZE is at least 16 KiB on every WebGL 2 device.
const GUARANTEED_BLOCK_BYTES = 16384;

function fakeContext() {
  const calls = [];
  const context = {
    UNIFORM_BUFFER: 1, DYNAMIC_DRAW: 2, INVALID_INDEX: 0xffffffff, calls,
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: (target, offset, data) => calls.push(['bufferSubData', Array.from(data)]),
    bindBufferBase: (target, binding) => calls.push(['bindBufferBase', binding]),
    getUniformBlockIndex: (program, name) => (program.blocks.includes(name) ? 3 : 0xffffffff),
    uniformBlockBinding: (program, index, binding) => calls.push(['uniformBlockBinding', index, binding]),
    deleteBuffer: () => calls.push(['deleteBuffer']),
  };
  return context;
}

test('the light data block fits the 16 KiB every WebGL 2 device guarantees', () => {
  assert.ok(uniformBlockByteSize(LIGHT_DATA_BLOCK) <= GUARANTEED_BLOCK_BYTES / 2, `${uniformBlockByteSize(LIGHT_DATA_BLOCK)} bytes`);
});

test('the declaration is a std140 block without an instance name, so shader code keeps the plain array names', () => {
  const declaration = uniformBlockDeclaration(LIGHT_DATA_BLOCK);
  assert.match(declaration, /^layout\(std140\) uniform LightData \{/);
  assert.match(declaration, /vec4 pointLightPositions\[16\];/);
  assert.match(declaration, /mat4 localShadowMatrices\[24\];/);
  assert.match(declaration, /\};$/);
});

test('a float array takes one row per element and a vec4 array packs tightly', () => {
  const context = fakeContext();
  const block = new UniformBlockBuffer(context, LIGHT_DATA_BLOCK);
  block.write('pointLightPositions', new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]));
  block.write('pointLightRadii', new Float32Array([9, 10, 11]));
  const radiiStart = 16 * 4 * 2;
  assert.deepEqual(Array.from(block.data.subarray(0, 8)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([block.data[radiiStart], block.data[radiiStart + 4], block.data[radiiStart + 8]], [9, 10, 11]);
  assert.equal(block.data[radiiStart + 1], 0, 'the rest of a float row stays empty');
  assert.throws(() => block.write('noSuchArray', new Float32Array(1)), /no array named noSuchArray/);
});

test('upload sends the data, binds the buffer and links the block once per program', () => {
  const context = fakeContext();
  const block = new UniformBlockBuffer(context, LIGHT_DATA_BLOCK);
  const program = { blocks: ['LightData'] };
  block.upload(program);
  block.upload(program);
  assert.equal(context.calls.filter(call => call[0] === 'uniformBlockBinding').length, 1);
  assert.deepEqual(context.calls.find(call => call[0] === 'uniformBlockBinding'), ['uniformBlockBinding', 3, LIGHT_DATA_BLOCK.binding]);
  assert.equal(context.calls.filter(call => call[0] === 'bufferSubData').length, 2);
  const otherProgram = { blocks: [] };
  block.upload(otherProgram);
  assert.equal(context.calls.filter(call => call[0] === 'uniformBlockBinding').length, 1, 'a program that does not use the block is not linked');
});
