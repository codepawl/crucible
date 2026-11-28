// Shared WebGPU adapter and device lifecycle (#901): one GPUDevice shared between Cook's WebGPU path tracer and
// Glaze's WebGPU backend so compute and rendering share GPU buffers without copies.

export const WEBGPU_MIN_STORAGE_BUFFERS = 10;
export const WEBGPU_MAX_BUFFER_BYTES = 1 << 30;

let cachedNavigatorGpu = null;
let pendingSession = null;
let resolvedSession = null;

/** True when this page exposes navigator.gpu. Adapter availability stays async via acquireWebGpuDevice(). */
export function isWebGpuAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

/** Returns the active `{ adapter, device, gpu }` when already acquired on the current navigator.gpu, else null. */
export function sharedWebGpuDevice() {
  if (!resolvedSession || typeof navigator === 'undefined' || cachedNavigatorGpu !== navigator.gpu) {
    return null;
  }
  return resolvedSession;
}

/** Clears the cached WebGPU device so the next caller acquires a fresh adapter and device. */
export function resetSharedWebGpuDevice() {
  cachedNavigatorGpu = null;
  pendingSession = null;
  resolvedSession = null;
}

function formatAdapterName(adapter) {
  const info = adapter.info ?? {};
  const label = `${info.vendor ?? 'webgpu'} ${info.architecture ?? ''}`.trim();
  return label || 'webgpu';
}

function limitsFit(device, minStorageBuffers, maxBufferBytes) {
  const limits = device?.limits;
  if (!limits) {
    return true;
  }
  const requiredStorage = Math.min(limits.maxStorageBuffersPerShaderStage ?? minStorageBuffers, minStorageBuffers);
  const requiredBinding = Math.min(limits.maxStorageBufferBindingSize ?? maxBufferBytes, maxBufferBytes);
  const requiredBuffer = Math.min(limits.maxBufferSize ?? maxBufferBytes, maxBufferBytes);
  return (limits.maxStorageBuffersPerShaderStage ?? requiredStorage) >= minStorageBuffers
    && (limits.maxStorageBufferBindingSize ?? requiredBinding) >= requiredBinding
    && (limits.maxBufferSize ?? requiredBuffer) >= requiredBuffer;
}

async function openSharedDevice({ purpose, fallbackHint, minStorageBuffers, maxBufferBytes, powerPreference, navigatorGpu }) {
  const adapter = await navigatorGpu.requestAdapter({ powerPreference });
  if (!adapter) {
    throw new Error(`${purpose} found no WebGPU adapter. ${fallbackHint}`);
  }
  const availableStorageBuffers = adapter.limits.maxStorageBuffersPerShaderStage;
  if (availableStorageBuffers < minStorageBuffers) {
    throw new Error(
      `${purpose} needs ${minStorageBuffers} storage buffers per shader stage and this adapter allows ${availableStorageBuffers}. ${fallbackHint}`,
    );
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: minStorageBuffers,
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, maxBufferBytes),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, maxBufferBytes),
    },
  });
  const session = { adapter, device, gpu: formatAdapterName(adapter) };
  resolvedSession = session;
  device.lost?.then?.(() => {
    if (resolvedSession === session) {
      resetSharedWebGpuDevice();
    }
  });
  return session;
}

/**
 * Returns the shared WebGPU `{ adapter, device, gpu }`, opening it once on the first call and coalescing concurrent
 * callers. Invalidates itself automatically when `device.lost` resolves or when `navigator.gpu` changes.
 */
export async function acquireWebGpuDevice({
  purpose = 'WebGPU',
  fallbackHint = 'Use WebGL2 instead.',
  minStorageBuffers = WEBGPU_MIN_STORAGE_BUFFERS,
  maxBufferBytes = WEBGPU_MAX_BUFFER_BYTES,
  powerPreference = 'high-performance',
} = {}) {
  if (!isWebGpuAvailable()) {
    throw new Error(`${purpose} needs navigator.gpu, which this page does not have. ${fallbackHint}`);
  }
  const currentNavigatorGpu = navigator.gpu;
  if (cachedNavigatorGpu !== currentNavigatorGpu) {
    resetSharedWebGpuDevice();
  }
  if (resolvedSession && !limitsFit(resolvedSession.device, minStorageBuffers, maxBufferBytes)) {
    resetSharedWebGpuDevice();
  }
  if (!pendingSession) {
    cachedNavigatorGpu = currentNavigatorGpu;
    pendingSession = openSharedDevice({
      purpose,
      fallbackHint,
      minStorageBuffers,
      maxBufferBytes,
      powerPreference,
      navigatorGpu: currentNavigatorGpu,
    }).catch((error) => {
      if (cachedNavigatorGpu === currentNavigatorGpu) {
        resetSharedWebGpuDevice();
      }
      throw error;
    });
  }
  return pendingSession;
}
