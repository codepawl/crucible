// Isolated Dedicated Worker served at /vendor/ktx2-worker.js (#2982).
// Runs three.js Emscripten basis_transcoder.js inside its own HTTP CSP so embind stays off the preview page.

export const KTX2_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'";

export const KTX2_WORKER_SOURCE = `'use strict';
const TRANSCODE_ETC1 = 0;
const TRANSCODE_ETC2_RGBA = 1;
const TRANSCODE_BC1 = 2;
const TRANSCODE_BC3 = 3;
const TRANSCODE_BC7_M5 = 7;
const TRANSCODE_ASTC_4X4 = 10;
const TRANSCODE_RGBA32 = 13;

const GL_ETC2_RGB = 0x9274;
const GL_ETC2_RGBA = 0x9278;
const GL_BC1_RGB = 0x83f0;
const GL_BC3_RGBA = 0x83f3;
const GL_BC7_RGBA = 0x8e8c;
const GL_ASTC_4X4 = 0x93b0;

const KTX2_TRANSCODER_MISSING = 'This GLB uses KHR_texture_basisu and the Basis transcoder is not installed where the MCP server runs (npm install three).';
let transcoderPromise = null;

function chooseTarget(isUastc, width, height, hasAlpha, workerConfig) {
  const support = workerConfig || {};
  const multipleOfFour = width % 4 === 0 && height % 4 === 0;
  if (isUastc) {
    if (support.astcSupported) return { transcoderFormat: TRANSCODE_ASTC_4X4, glFormat: GL_ASTC_4X4 };
    if (support.bptcSupported) return { transcoderFormat: TRANSCODE_BC7_M5, glFormat: GL_BC7_RGBA };
    if (support.etc2Supported) return { transcoderFormat: hasAlpha ? TRANSCODE_ETC2_RGBA : TRANSCODE_ETC1, glFormat: hasAlpha ? GL_ETC2_RGBA : GL_ETC2_RGB };
    if (support.dxtSupported && multipleOfFour) return { transcoderFormat: hasAlpha ? TRANSCODE_BC3 : TRANSCODE_BC1, glFormat: hasAlpha ? GL_BC3_RGBA : GL_BC1_RGB };
    return { transcoderFormat: TRANSCODE_RGBA32, glFormat: null };
  }
  if (support.etc2Supported) return { transcoderFormat: hasAlpha ? TRANSCODE_ETC2_RGBA : TRANSCODE_ETC1, glFormat: hasAlpha ? GL_ETC2_RGBA : GL_ETC2_RGB };
  if (support.bptcSupported) return { transcoderFormat: TRANSCODE_BC7_M5, glFormat: GL_BC7_RGBA };
  if (support.dxtSupported && multipleOfFour) return { transcoderFormat: hasAlpha ? TRANSCODE_BC3 : TRANSCODE_BC1, glFormat: hasAlpha ? GL_BC3_RGBA : GL_BC1_RGB };
  return { transcoderFormat: TRANSCODE_RGBA32, glFormat: null };
}

function loadTranscoder() {
  if (!transcoderPromise) {
    transcoderPromise = (async () => {
      try {
        importScripts('/vendor/basis_transcoder.js');
      } catch {
        throw new Error(KTX2_TRANSCODER_MISSING);
      }
      if (typeof globalThis.BASIS !== 'function') throw new Error(KTX2_TRANSCODER_MISSING);
      const response = await fetch('/vendor/basis_transcoder.wasm');
      if (!response.ok) throw new Error(KTX2_TRANSCODER_MISSING);
      const wasmBinary = await response.arrayBuffer();
      const transcoder = await globalThis.BASIS({ wasmBinary });
      transcoder.initializeBasis();
      return transcoder;
    })().catch(error => {
      transcoderPromise = null;
      throw error;
    });
  }
  return transcoderPromise;
}

self.onmessage = async ({ data: { id, buffer, workerConfig } }) => {
  try {
    const transcoder = await loadTranscoder();
    const file = new transcoder.KTX2File(new Uint8Array(buffer));
    try {
      if (!file.isValid()) throw new Error('Invalid KTX2 texture.');
      if (file.isHDR && file.isHDR()) throw new Error('HDR KTX2 textures are not supported.');
      const width = file.getWidth();
      const height = file.getHeight();
      const levelCount = file.getLevels();
      if (width < 1 || height < 1 || levelCount < 1) throw new Error('Invalid KTX2 texture dimensions.');
      const isUastc = Boolean(file.isUASTC && file.isUASTC());
      const isEtc1s = Boolean(file.isETC1S && file.isETC1S());
      if (!isUastc && !isEtc1s) throw new Error('Unsupported Basis KTX2 encoding.');
      if (!file.startTranscoding()) throw new Error('KTX2 transcoder could not start.');
      const hasAlpha = Boolean(file.getHasAlpha && file.getHasAlpha());
      const { transcoderFormat, glFormat } = chooseTarget(isUastc, width, height, hasAlpha, workerConfig);
      if (glFormat === null) {
        const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, TRANSCODE_RGBA32));
        if (!file.transcodeImage(pixels, 0, 0, 0, TRANSCODE_RGBA32, 0, -1, -1)) {
          throw new Error('KTX2 transcode to RGBA8 failed.');
        }
        self.postMessage({ id, result: { isCompressedTexture: false, image: { width, height, data: pixels } } }, [pixels.buffer]);
        return;
      }
      const mipmaps = [];
      const transfers = [];
      for (let mip = 0; mip < levelCount; mip++) {
        const levelInfo = file.getImageLevelInfo(mip, 0, 0);
        const data = new Uint8Array(file.getImageTranscodedSizeInBytes(mip, 0, 0, transcoderFormat));
        if (!file.transcodeImage(data, mip, 0, 0, transcoderFormat, 0, -1, -1)) {
          throw new Error('KTX2 transcode failed at mip level ' + mip + '.');
        }
        mipmaps.push({ width: levelInfo.origWidth, height: levelInfo.origHeight, data });
        transfers.push(data.buffer);
      }
      self.postMessage({ id, result: { isCompressedTexture: true, format: glFormat, mipmaps } }, transfers);
    } finally {
      file.close();
      file.delete();
    }
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
`;
