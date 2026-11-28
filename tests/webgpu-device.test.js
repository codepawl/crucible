import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBGPU_MAX_BUFFER_BYTES,
  WEBGPU_MIN_STORAGE_BUFFERS,
  acquireWebGpuDevice,
  isWebGpuAvailable,
  resetSharedWebGpuDevice,
  sharedWebGpuDevice,
} from '../src/webgpu-device.js';

function restoreNavigator(descriptor) {
  resetSharedWebGpuDevice();
  if (descriptor) {
    Object.defineProperty(globalThis, 'navigator', descriptor);
  } else {
    delete globalThis.navigator;
  }
}

function makeFakeDevice({ maxStorageBuffersPerShaderStage = WEBGPU_MIN_STORAGE_BUFFERS } = {}) {
  let resolveLost;
  const lostPromise = new Promise((resolve) => {
    resolveLost = resolve;
  });
  return {
    device: {
      limits: {
        maxStorageBuffersPerShaderStage,
        maxStorageBufferBindingSize: WEBGPU_MAX_BUFFER_BYTES,
        maxBufferSize: WEBGPU_MAX_BUFFER_BYTES,
      },
      lost: lostPromise,
    },
    lose(reason = 'destroyed') {
      resolveLost({ reason });
      return lostPromise;
    },
  };
}

function makeFakeGpu({
  info = { vendor: 'test-vendor', architecture: 'test-arch' },
  maxStorageBuffersPerShaderStage = WEBGPU_MIN_STORAGE_BUFFERS,
  failAdapter = false,
  failDevice = false,
} = {}) {
  const counts = { adapterCalls: 0, deviceCalls: 0 };
  const devices = [];
  const gpu = {
    async requestAdapter() {
      counts.adapterCalls += 1;
      if (failAdapter) {
        throw new Error('adapter failure');
      }
      if (maxStorageBuffersPerShaderStage === null) {
        return null;
      }
      return {
        info,
        limits: {
          maxStorageBuffersPerShaderStage,
          maxStorageBufferBindingSize: WEBGPU_MAX_BUFFER_BYTES,
          maxBufferSize: WEBGPU_MAX_BUFFER_BYTES,
        },
        async requestDevice() {
          counts.deviceCalls += 1;
          if (failDevice) {
            throw new Error('device failure');
          }
          const created = makeFakeDevice({ maxStorageBuffersPerShaderStage });
          devices.push(created);
          return created.device;
        },
      };
    },
  };
  return { gpu, counts, devices };
}

test('isWebGpuAvailable and missing navigator.gpu error follow environment availability', async (testContext) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  testContext.after(() => restoreNavigator(previousDescriptor));

  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  assert.equal(isWebGpuAvailable(), false);
  assert.equal(sharedWebGpuDevice(), null);
  await assert.rejects(
    acquireWebGpuDevice({ purpose: 'The WebGPU path tracer', fallbackHint: 'Use backend "gpu" (WebGL2) or "cpu".' }),
    /The WebGPU path tracer needs navigator\.gpu.*Use backend "gpu"/,
  );
});

test('missing adapter and insufficient storage buffers throw actionable fallback errors', async (testContext) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  testContext.after(() => restoreNavigator(previousDescriptor));

  const nullAdapter = makeFakeGpu({ maxStorageBuffersPerShaderStage: null });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: nullAdapter.gpu } });
  await assert.rejects(
    acquireWebGpuDevice({ purpose: 'The WebGPU renderer', fallbackHint: 'Use WebGL2.' }),
    /The WebGPU renderer found no WebGPU adapter\. Use WebGL2\./,
  );

  const limitedAdapter = makeFakeGpu({ maxStorageBuffersPerShaderStage: 4 });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: limitedAdapter.gpu } });
  await assert.rejects(
    acquireWebGpuDevice({ purpose: 'The WebGPU renderer', fallbackHint: 'Use WebGL2.', minStorageBuffers: 10 }),
    /needs 10 storage buffers per shader stage and this adapter allows 4\. Use WebGL2\./,
  );
});

test('concurrent callers share one adapter and device acquisition and expose sharedWebGpuDevice', async (testContext) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  testContext.after(() => restoreNavigator(previousDescriptor));

  const fake = makeFakeGpu();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: fake.gpu } });
  assert.equal(isWebGpuAvailable(), true);

  const [first, second] = await Promise.all([
    acquireWebGpuDevice({ purpose: 'Cook WebGPU' }),
    acquireWebGpuDevice({ purpose: 'Glaze WebGPU' }),
  ]);
  assert.equal(first, second);
  assert.equal(fake.counts.adapterCalls, 1);
  assert.equal(fake.counts.deviceCalls, 1);
  assert.equal(first.gpu, 'test-vendor test-arch');
  assert.equal(sharedWebGpuDevice(), first);
});

test('rejected acquisition clears cached promise and retries cleanly', async (testContext) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  testContext.after(() => restoreNavigator(previousDescriptor));

  let failFirst = true;
  let calls = 0;
  const fakeDevice = makeFakeDevice();
  const gpu = {
    async requestAdapter() {
      calls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('transient adapter error');
      }
      return {
        info: { vendor: 'ok' },
        limits: {
          maxStorageBuffersPerShaderStage: WEBGPU_MIN_STORAGE_BUFFERS,
          maxStorageBufferBindingSize: WEBGPU_MAX_BUFFER_BYTES,
          maxBufferSize: WEBGPU_MAX_BUFFER_BYTES,
        },
        async requestDevice() {
          return fakeDevice.device;
        },
      };
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });

  await assert.rejects(acquireWebGpuDevice(), /transient adapter error/);
  assert.equal(sharedWebGpuDevice(), null);
  const recovered = await acquireWebGpuDevice();
  assert.equal(recovered.device, fakeDevice.device);
  assert.equal(calls, 2);
});

test('device loss and navigator.gpu replacement invalidate the cached shared device', async (testContext) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  testContext.after(() => restoreNavigator(previousDescriptor));

  const firstFake = makeFakeGpu({ info: { vendor: 'first' } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: firstFake.gpu } });
  const firstSession = await acquireWebGpuDevice();
  assert.equal(firstSession.gpu, 'first');

  await firstFake.devices[0].lose('destroyed');
  assert.equal(sharedWebGpuDevice(), null);

  const reacquired = await acquireWebGpuDevice();
  assert.notEqual(reacquired.device, firstSession.device);
  assert.equal(firstFake.counts.adapterCalls, 2);

  const secondFake = makeFakeGpu({ info: { vendor: 'second' } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: secondFake.gpu } });
  assert.equal(sharedWebGpuDevice(), null);
  const switched = await acquireWebGpuDevice();
  assert.equal(switched.gpu, 'second');
});
