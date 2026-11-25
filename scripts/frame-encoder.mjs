import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { rawFrameInputArguments } from './gpu-frame-reader.mjs';

/** Drain and finalization wait this long: below-normal priority jobs on a busy machine need more than 5 s. */
export const DEFAULT_ENCODER_TIMEOUT_MS = 30000;

/** AAC adds priming and padding at both ends of a part; PCM does not, so parts meant to be joined use PCM. */
export function audioCodecArguments(audioCodec) {
  if (audioCodec === 'aac') return ['-c:a', 'aac', '-b:a', '192k'];
  if (audioCodec === 'pcm') return ['-c:a', 'pcm_s16le'];
  throw new TypeError('Audio codec must be aac or pcm.');
}

/**
 * Pads the sound with silence and cuts the output at exactly the picture length. `-shortest` cannot do this: it drops every
 * audio packet when the raw H.264 copy has no timestamps, and it ends PCM up to 80 ms before the last frame.
 */
export function audioTrimArguments(audioCodec, pictureSeconds) {
  return ['-af', 'apad', ...audioCodecArguments(audioCodec), '-t', pictureSeconds.toFixed(6)];
}

/**
 * The page encoder's raw H.264 has no timing data, so ffmpeg guesses each frame's time from the stream. For that stream it
 * guesses right for the first 50 frames and then gives every frame a 1 microsecond length (a 4 s clip came out 2.08 s long).
 * The page encodes one frame per tick and no B-frames, so frame N is at N / fps: say so explicitly.
 */
export function pageEncodedTimestampFilter(fps) {
  return `setts=ts=N/${fps}/TB:duration=1/${fps}/TB`;
}

/**
 * The page encoder writes full-range YUV and leaves the range out of the stream, so players assume limited range and stretch
 * the picture's contrast (blacks crushed, whites clipped: 28.8 dB against the lossless frames, 36.8 dB once the range is
 * read as full). Say so in the stream itself, with the BT.709 colour the container is tagged with.
 */
export const PAGE_ENCODED_COLOUR_FILTER = 'h264_metadata=video_full_range_flag=1:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1';

/** The complete ffmpeg argument list for one encoder, kept apart from the spawn so tests can pin it without ffmpeg. */
export function frameEncoderArguments({ output, fps, format, backend, audioArguments, audioCodec, frameCount, width, height }) {
  const raw = format === 'rawvideo' ? rawFrameInputArguments({ width, height, fps }) : undefined;
  const encoded = format === 'h264';
  const codec = encoded
    ? ['-c:v', 'copy', '-bsf:v', `${PAGE_ENCODED_COLOUR_FILTER},${pageEncodedTimestampFilter(fps)}`, '-color_range', 'pc']
    : backend === 'gpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '20']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2'];
  return ['-hide_banner', '-loglevel', 'error', '-y', ...(encoded ? ['-f', 'h264', '-framerate', String(fps)] : raw ? raw.input : ['-f', 'image2pipe', '-framerate', String(fps), '-vcodec', format === 'jpeg' ? 'mjpeg' : 'png']),
    '-i', 'pipe:0', ...audioArguments, ...(raw ? raw.filter : []), ...codec,
    ...(encoded ? [] : ['-pix_fmt', 'yuv420p']), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart', ...(audioArguments.length ? audioTrimArguments(audioCodec, frameCount / fps) : []),
    '-f', 'mp4', output];
}

/** One streamed frame at a time. The caller owns output publication and cleanup. */
export function createFrameEncoder({ executable = 'ffmpeg', output, fps, format = 'jpeg', backend = 'cpu',
  audioArguments = [], audioCodec = 'aac', frameCount, width, height, signal, maximumFrameBytes = 1024 * 1024,
  maximumOutputBytes = 128 * 1024 * 1024, timeoutMs = DEFAULT_ENCODER_TIMEOUT_MS } = {}) {
  if (typeof output !== 'string' || !output || !Number.isFinite(fps) || fps < 1 || fps > 60 ||
      !['jpeg', 'png', 'rawvideo', 'h264'].includes(format) || !['cpu', 'gpu'].includes(backend)) {
    throw new TypeError('Encoder requires an output path, valid fps, format and backend.');
  }
  for (const value of [maximumFrameBytes, maximumOutputBytes, timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Encoder limits must be positive safe integers.');
  }
  if (format === 'rawvideo' && !(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0)) {
    throw new TypeError('Raw video frames need a width and a height.');
  }
  if (audioArguments.length && !(Number.isSafeInteger(frameCount) && frameCount > 0)) {
    throw new TypeError('An encoder with audio needs frameCount, the number of frames it will receive, so the sound ends with the picture.');
  }
  signal?.throwIfAborted();
  const argumentsValue = frameEncoderArguments({ output, fps, format, backend, audioArguments, audioCodec, frameCount, width, height });
  const child = spawn(executable, argumentsValue, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostics = '';
  let processError;
  let busy = false;
  let phase = 'writing';
  let closePromise;
  const metrics = { frames: 0, chunks: 0, maximumPendingFrames: 0, backpressureSeconds: 0, finishSeconds: 0 };
  const retainError = value => { diagnostics = (diagnostics + String(value)).slice(-8192); };
  child.stderr.on('data', retainError);
  child.on('error', error => { processError = error; retainError(error.message); });
  child.stdin.on('error', error => { processError = error; retainError(error.message); });
  let exit;
  const exited = new Promise(resolve => {
    child.once('error', error => { if (!child.pid) { exit = { error }; resolve(exit); } });
    child.once('close', (code, terminationSignal) => { exit = { code, terminationSignal }; resolve(exit); });
  });
  function failure() {
    return new Error(`Video encoder stopped: ${diagnostics || processError?.message || exit?.terminationSignal || exit?.code}`);
  }
  function abort() {
    if (!exit) child.kill();
  }
  signal?.addEventListener('abort', abort, { once: true });
  function check() {
    signal?.throwIfAborted();
    if (processError || exit || child.stdin.destroyed) throw failure();
  }
  async function checkSize() {
    let information;
    try { information = await stat(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (information?.size > maximumOutputBytes) throw new Error('Video output exceeded its byte budget.');
  }
  async function deadline(promise, message, duration = timeoutMs) {
    let timer;
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = () => reject(signal.reason); });
    signal?.addEventListener('abort', rejectAbort, { once: true });
    try {
      signal?.throwIfAborted();
      return await Promise.race([promise, aborted, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), duration);
      })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', rejectAbort);
    }
  }
  return Object.freeze({
    get pid() { return child.pid; },
    get metrics() { return { ...metrics }; },
    async writeFrame(bytes) {
      if (phase !== 'writing' || busy) throw new Error('Encoder accepts one pending frame and no frames after finalization.');
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maximumFrameBytes) {
        throw new RangeError('Captured frame exceeded its byte budget or was empty.');
      }
      check();
      busy = true;
      metrics.maximumPendingFrames = 1;
      try {
        let writable;
        const written = new Promise((resolve, reject) => {
          writable = child.stdin.write(bytes, error => error ? reject(error) : resolve());
        });
        // Observe rejection immediately, including while waiting for drain.
        written.catch(() => {});
        if (!writable) {
          const start = performance.now();
          let cleanup;
          const drained = new Promise((resolve, reject) => {
            const success = () => resolve();
            const failed = error => reject(error);
            const closed = () => reject(failure());
            cleanup = () => {
              child.stdin.off('drain', success);
              child.stdin.off('error', failed);
              child.off('close', closed);
            };
            child.stdin.once('drain', success);
            child.stdin.once('error', failed);
            child.once('close', closed);
          });
          try { await deadline(drained, 'Video encoder drain exceeded its deadline.'); }
          finally { cleanup(); }
          metrics.backpressureSeconds += (performance.now() - start) / 1000;
        }
        await deadline(written, 'Video encoder write exceeded its deadline.');
        check();
        await checkSize();
        metrics.frames++;
      } finally { busy = false; }
    },
    /** Appends an encoded H.264 chunk that the page already produced. Chunks are small, so the pipe buffer absorbs them. */
    writeChunk(bytes) {
      if (format !== 'h264') throw new Error('Chunks are for encoder format h264.');
      if (phase !== 'writing') throw new Error('Encoder accepts no chunks after finalization.');
      check();
      child.stdin.write(bytes);
      metrics.chunks++;
    },
    async finish() {
      if (phase !== 'writing' || busy) throw new Error('Finish requires an idle encoder that has not been finalized.');
      check();
      phase = 'finalizing';
      const start = performance.now();
      child.stdin.end();
      const result = await deadline(exited, 'Video encoder finalization exceeded its deadline.');
      metrics.finishSeconds = (performance.now() - start) / 1000;
      if (result.code !== 0 || processError) throw failure();
      await checkSize();
      phase = 'completed';
      signal?.removeEventListener('abort', abort);
      return { ...metrics };
    },
    close() {
      closePromise ??= (async () => {
        phase = 'closed';
        signal?.removeEventListener('abort', abort);
        child.stdin.destroy();
        if (!exit) child.kill();
        let timer;
        const graceful = await Promise.race([exited.then(() => true), new Promise(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
        clearTimeout(timer);
        if (!graceful) {
          child.kill('SIGKILL');
          const forced = await Promise.race([exited.then(() => true), new Promise(resolve => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          })]);
          clearTimeout(timer);
          if (!forced) throw new Error('Owned video encoder failed to exit after termination.');
        }
      })();
      return closePromise;
    },
  });
}
