import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TILE_PIXELS, MAX_TILE_WIDTH, createBandState, drawOneSample, isSoftwareRenderer, waitForDraw } from '../src/path-tracer-gpu.js';

function createMockGl() {
  const tiles = [];
  let currentScissor = null;
  let scissorEnabled = false;
  let drawCount = 0;
  return {
    BLEND: 1,
    ONE: 2,
    SCISSOR_TEST: 3,
    TRIANGLES: 4,
    viewport() {},
    enable(flag) {
      if (flag === 3) scissorEnabled = true;
    },
    disable(flag) {
      if (flag === 3) scissorEnabled = false;
    },
    blendFunc() {},
    getUniformLocation() {
      return 0;
    },
    uniform1i() {},
    scissor(x, y, w, h) {
      currentScissor = { x, y, w, h };
    },
    drawArrays() {
      drawCount++;
      assert.equal(scissorEnabled, true, 'SCISSOR_TEST must be enabled during draw');
      tiles.push({ ...currentScissor });
    },
    finish() {},
    SYNC_GPU_COMMANDS_COMPLETE: 5,
    TIMEOUT_EXPIRED: 6,
    ALREADY_SIGNALED: 7,
    fenceSync() {
      return {};
    },
    flush() {},
    clientWaitSync() {
      return 7;
    },
    deleteSync() {},
    get tiles() {
      return tiles;
    },
    get drawCount() {
      return drawCount;
    },
    get scissorEnabled() {
      return scissorEnabled;
    },
  };
}

function assertExactPixelCoverage(tiles, width, height) {
  const counts = new Uint8Array(width * height);
  for (const { x, y, w, h } of tiles) {
    assert.ok(w >= 1 && w <= MAX_TILE_WIDTH, `tile width ${w} must stay within 1..${MAX_TILE_WIDTH}`);
    assert.ok(w * h <= MAX_TILE_PIXELS, `tile pixel area ${w}x${h}=${w * h} exceeds ${MAX_TILE_PIXELS}`);
    assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, `tile ${x},${y} ${w}x${h} out of ${width}x${height} bounds`);
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        counts[row * width + col]++;
      }
    }
  }
  for (let pixel = 0; pixel < counts.length; pixel++) {
    assert.equal(counts[pixel], 1, `pixel ${pixel} covered ${counts[pixel]} times`);
  }
}

for (const [width, height] of [[1080, 1920], [720, 1280], [100, 50]]) {
  test(`drawOneSample tiles ${width}x${height} with disjoint coverage and bounded pixel area`, async () => {
    const gl = createMockGl();
    const band = createBandState(height);
    for (let sample = 0; sample < 3; sample++) {
      const startTile = gl.tiles.length;
      await drawOneSample(gl, {}, width, height, sample, band, () => {});
      assertExactPixelCoverage(gl.tiles.slice(startTile), width, height);
    }
    assert.equal(gl.scissorEnabled, false);
  });
}

test('drawOneSample checks shouldStop between tiles inside a band', async () => {
  const gl = createMockGl();
  const band = createBandState(64);
  let checks = 0;
  await assert.rejects(
    drawOneSample(gl, {}, 1080, 64, 0, band, () => {
      checks++;
      if (checks === 2) throw new Error('cancelled mid-band');
    }),
    /cancelled mid-band/,
  );
  assert.equal(gl.drawCount, 2);
  assert.equal(gl.scissorEnabled, false);
});

// A driver whose gl.finish() returns at once (ANGLE on Vulkan in a sandbox, #2833) but whose fence reports the real draw time.
test('tile pacing follows the fence, not gl.finish, so the tile size does not climb to the cap', async () => {
  const secondsPerPixel = 4e-6;
  let clock = 0;
  let gpuDoneAt = 0;
  const tileAreas = [];
  const gl = createMockGl();
  gl.drawArrays = () => {
    const { w, h } = gl.lastScissor;
    tileAreas.push(w * h);
    gpuDoneAt = Math.max(gpuDoneAt, clock) + w * h * secondsPerPixel;
  };
  gl.scissor = (x, y, w, h) => {
    gl.lastScissor = { x, y, w, h };
  };
  gl.clientWaitSync = () => {
    clock += 0.01;
    return clock >= gpuDoneAt ? 7 : 6;
  };
  const band = createBandState(480, MAX_TILE_WIDTH, () => clock * 1000);
  for (let sample = 0; sample < 1; sample++) await drawOneSample(gl, {}, 1080, 480, sample, band, () => {});
  const largest = Math.max(...tileAreas);
  assert.ok(largest <= 2 * 0.08 / secondsPerPixel, `largest tile ${largest} pixels takes over twice the 0.08 s target`);
  assert.ok(largest < MAX_TILE_PIXELS, 'the tile size must not reach the cap when the GPU is slow');
});

test('waitForDraw reads one value back when the context has no fences', async () => {
  let reads = 0;
  await waitForDraw({ RGBA: 1, FLOAT: 2, readPixels() { reads++; } });
  assert.equal(reads, 1);
});

test('waitForDraw gives up after its bound instead of hanging on a fence that never signals', async () => {
  let clock = 0;
  let deleted = false;
  await waitForDraw({ TIMEOUT_EXPIRED: 6, fenceSync: () => ({}), flush() {}, clientWaitSync: () => 6, deleteSync() { deleted = true; } }, () => (clock += 500));
  assert.equal(deleted, true);
});

// Waiting on a fence after every tile left a software GL queue idle and made a lightmap bake 40 percent slower than gl.finish() (#2833).
test('cheap tiles queue up and share one fence wait instead of one wait per tile', async () => {
  const secondsPerPixel = 1e-6;
  let clock = 0;
  let gpuDoneAt = 0;
  let fences = 0;
  const gl = createMockGl();
  gl.scissor = (x, y, w, h) => {
    gl.lastScissor = { x, y, w, h };
  };
  gl.drawArrays = () => {
    const { w, h } = gl.lastScissor;
    gl.tiles.push({ ...gl.lastScissor });
    gpuDoneAt = Math.max(gpuDoneAt, clock) + w * h * secondsPerPixel;
  };
  gl.fenceSync = () => {
    fences++;
    return {};
  };
  gl.clientWaitSync = () => {
    clock += 0.001;
    return clock >= gpuDoneAt ? 7 : 6;
  };
  const band = createBandState(256, 64, () => clock * 1000);
  await drawOneSample(gl, {}, 256, 256, 0, band, () => {});
  assert.ok(gl.tiles.length >= 16, `only ${gl.tiles.length} tiles were drawn`);
  assert.ok(fences * 3 <= gl.tiles.length, `${fences} fence waits for ${gl.tiles.length} tiles`);
});

test('software renderer names are told apart from hardware ones', () => {
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'), false);
  assert.equal(isSoftwareRenderer(undefined), false);
});

function createGlWithRenderer(rendererName) {
  const gl = createMockGl();
  const calls = { finish: 0, fenceSync: 0 };
  gl.finish = () => {
    calls.finish++;
  };
  gl.fenceSync = () => {
    calls.fenceSync++;
    return {};
  };
  gl.getExtension = () => ({ UNMASKED_RENDERER_WEBGL: 9 });
  gl.getParameter = () => rendererName;
  return { gl, calls };
}

test('a software renderer waits with gl.finish() and no fence', async () => {
  const { gl, calls } = createGlWithRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)');
  await waitForDraw(gl);
  assert.deepEqual(calls, { finish: 1, fenceSync: 0 });
});

test('a hardware renderer waits on a fence, not gl.finish()', async () => {
  const { gl, calls } = createGlWithRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)');
  await waitForDraw(gl);
  assert.deepEqual(calls, { finish: 0, fenceSync: 1 });
});
