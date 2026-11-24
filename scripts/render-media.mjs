import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { FILM_DURATION } from '../src/film.js';
import { videoFrameCount } from '../src/film-timeline.js';
import { RENDER_PRESETS } from '../src/budget.js';
import { createFrameEncoder } from './frame-encoder.mjs';
import { measureStreamSeconds, planRenderMediaAudio } from './job-audio.mjs';
import { prepareFileScene, readCameraKeys } from './file-scene.mjs';
import { startAssetServer } from './asset-server.mjs';
import { DEFAULT_PAGE_ENCODER_QUANTIZER, createFrameReceiver, installFrameReaderInPage, startFrameServer, startVideoEncoderInPage } from './gpu-frame-reader.mjs';

function argumentsFrom(values) {
  const result = {};
  const allowed = new Set(['kind', 'backend', 'scene', 'preset', 'width', 'height', 'fps', 'duration', 'time', 'memory', 'assembly', 'output', 'audio', 'encoder', 'start', 'aspect', 'asset', 'config', 'camera', 'root', 'capture', 'jpeg-quality', 'frames']);
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index].startsWith('--') || values[index + 1] === undefined) throw new Error('Every option needs a value.');
    const name = values[index].slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown render option: ${name}`);
    result[name] = values[index + 1];
  }
  return result;
}

/** A dimension the caller did not pass is derived from the other one; video rounds it to even so yuv420p accepts it. */
function roundDerivedDimension(value, kind, passedValue) {
  if (kind === 'video' && passedValue === undefined) return 2 * Math.round(value / 2);
  return Math.round(value);
}

/** Still number `index` is frame-<index>.<ext> in the directory of --output, like the render job; the extension follows the capture format. */
export function stillPath(output, index, captureFormat) {
  const extension = captureFormat === 'jpeg' ? 'jpg' : 'png';
  return resolve(dirname(output), `frame-${index}.${extension}`);
}

/** The paths of `count` stills, one distinct file per still, however short the duration. */
/** The most frames one --frames range may write; a longer film is rendered as several ranges. */
export const MAXIMUM_FRAME_RANGE_COUNT = 3600;

/** Reads "--frames 0-89" (first and last frame, both included) or a single frame number "12". */
export function parseFrameRange(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text));
  if (!match) throw new Error(`--frames must be a first and last frame such as 0-89 (or one frame such as 12), got "${text}".`);
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (last < first) throw new Error(`--frames must end at or after its first frame, got ${first}-${last}. Pass the smaller number first.`);
  const count = last - first + 1;
  if (count > MAXIMUM_FRAME_RANGE_COUNT) throw new Error(`--frames asks for ${count} frames; at most ${MAXIMUM_FRAME_RANGE_COUNT} per run. Render a longer film as several ranges.`);
  return { first, last, count };
}

/** The path of frame `frame` of a range ending at `last`: frame-0000.png, padded to at least 4 digits and to the width of the last frame. */
export function framePath(output, frame, last, captureFormat) {
  const extension = captureFormat === 'jpeg' ? 'jpg' : 'png';
  const digits = Math.max(4, String(last).length);
  return resolve(dirname(output), `frame-${String(frame).padStart(digits, '0')}.${extension}`);
}

export function stillPaths(output, count, captureFormat) {
  return Array.from({ length: count }, (_, index) => stillPath(output, index, captureFormat));
}

/** The encoder options of a video render; `frameCount` is required whenever the video has audio. */
export function renderEncoderOptions({ ffmpeg, output, fps, captureFormat, width, height, encoderBackend, audioArguments, frameCount }) {
  const format = captureFormat === 'raw' ? 'rawvideo' : captureFormat === 'webcodecs' ? 'h264' : captureFormat;
  return { executable: ffmpeg, output, fps, format, width, height, backend: encoderBackend, audioArguments, frameCount,
    maximumFrameBytes: 64 * 1024 * 1024, maximumOutputBytes: Number.MAX_SAFE_INTEGER };
}

const AUDIO_LENGTH_TOLERANCE_SECONDS = 0.05;
// A large file scene such as the Barbershop benchmark takes about a minute to load when other jobs share the machine (#2158).
const SCENE_READY_TIMEOUT_MILLISECONDS = 240000;

/** Decodes the audio stream of a finished file and throws when there is none or, given the picture length, when its length is off. */
export async function assertOutputHasAudio(ffmpeg, output, expectedSeconds) {
  let audioSeconds;
  try {
    audioSeconds = await measureStreamSeconds(ffmpeg, output, 'audio');
  } catch (error) {
    throw new Error(`The rendered video has no audio stream although --audio was given (${error.message}). Check the sound file and the encoder.`);
  }
  if (expectedSeconds !== undefined && Math.abs(audioSeconds - expectedSeconds) > AUDIO_LENGTH_TOLERANCE_SECONDS) {
    throw new Error(`The rendered audio is ${audioSeconds.toFixed(3)} s but the picture is ${expectedSeconds.toFixed(3)} s; they must match within 50 ms.`);
  }
}

export function parseRenderOptions(values) {
  const options = argumentsFrom(values);
  const kind = options.kind ?? 'image';
  const backend = options.backend ?? 'gpu';
  const scene = options.scene ?? 'film';
  const presetName = options.preset ?? (backend === 'cpu' ? 'cpu' : 'balanced');
  const preset = RENDER_PRESETS[presetName];
  const aspect = options.aspect ?? 'landscape';
  if (!preset || !['image', 'video', 'stills'].includes(kind) || !['gpu', 'cpu'].includes(backend) || !['film', 'nature', 'object', 'motion', 'view2d', 'assets', 'modeling', 'file'].includes(scene) || !['landscape', 'portrait', 'square'].includes(aspect)) throw new Error('Unknown render kind, backend, scene, aspect or preset.');
  if (options.asset && scene !== 'assets') throw new Error('The asset file option requires --scene assets.');
  if (scene === 'file' && !options.config) throw new Error('--scene file needs --config <scene.json>.');
  if ((options.config || options.camera || options.root) && scene !== 'file') throw new Error('--config, --camera and --root require --scene file.');
  const cameraKeys = options.camera ? readCameraKeys(options.camera) : null;
  const numberOption = (name, fallback, minimum, maximum) => {
    const value = Number(options[name] ?? fallback);
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
    return value;
  };
  const shorter = Math.min(preset.width, preset.height);
  const longer = Math.max(preset.width, preset.height);
  const ratio = aspect === 'portrait' ? 9 / 16 : aspect === 'square' ? 1 : 16 / 9;
  let defaultWidth = aspect === 'landscape' ? longer : shorter;
  let defaultHeight = aspect === 'portrait' ? longer : shorter;
  if (options.width !== undefined && options.height === undefined) defaultHeight = Number(options.width) / ratio;
  if (options.height !== undefined && options.width === undefined) defaultWidth = Number(options.height) * ratio;
  const width = roundDerivedDimension(numberOption('width', defaultWidth, 64, 4096), kind, options.width);
  const height = roundDerivedDimension(numberOption('height', defaultHeight, 64, 4096), kind, options.height);
  if (kind === 'video' && (width % 2 || height % 2)) throw new Error('Video dimensions must be even for yuv420p output.');
  const fps = numberOption('fps', cameraKeys?.fps ?? preset.fps, 1, 60);
  const duration = numberOption('duration', scene === 'film' ? FILM_DURATION : ['motion', 'modeling'].includes(scene) ? 12 : 32, 0.1, 240);
  const time = numberOption('time', scene === 'assets' ? 0 : 3, 0, 3600);
  const start = numberOption('start', 0, 0, 3600);
  const frameRange = options.frames === undefined ? null : parseFrameRange(options.frames);
  if (frameRange && kind !== 'stills') throw new Error('--frames writes a numbered PNG sequence and needs --kind stills.');
  if (frameRange && (options.start !== undefined || options.time !== undefined || options.duration !== undefined)) throw new Error('--frames sets the times itself (frame / fps); drop --start, --time and --duration.');
  // A scene file carries its own budget (the Bistro needs about 1.4 GiB for textures), so it is the default and the cap is higher.
  const sceneFileBudget = scene === 'file' ? JSON.parse(readFileSync(resolve(options.config), 'utf8')).renderer?.memoryBudgetMiB : undefined;
  const memory = numberOption('memory', sceneFileBudget ?? preset.memoryBudgetMiB, 32, scene === 'file' ? 8192 : 1024);
  const assembly = numberOption('assembly', 0, 0, 1);
  const captureFormat = options.capture ?? (kind === 'video' ? 'auto' : 'png');
  if (!['auto', 'webcodecs', 'raw', 'jpeg', 'png'].includes(captureFormat)) throw new Error('Capture must be auto, webcodecs, raw, jpeg or png.');
  if (['auto', 'webcodecs', 'raw'].includes(captureFormat) && kind !== 'video') throw new Error('Auto, webcodecs and raw capture are for video only. Stills are PNG or JPEG screenshots.');
  const jpegQuality = numberOption('jpeg-quality', 95, 1, 100);
  if (!Number.isInteger(jpegQuality)) throw new Error('JPEG quality must be an integer.');
  const output = resolve(options.output ?? `artifacts/${scene}-${backend}.${kind === 'video' ? 'mp4' : captureFormat === 'jpeg' ? 'jpg' : 'png'}`);
  const encoderBackend = options.encoder ?? (backend === 'cpu' ? 'cpu' : 'auto');
  if (!['auto', 'cpu', 'gpu'].includes(encoderBackend)) throw new Error('Encoder must be auto, cpu or gpu.');
  const audio = options.audio ?? (scene === 'film' ? 'artifacts/critical-score.wav' : null);
  return { cameraKeys, options, kind, backend, scene, presetName, preset, aspect, width, height, fps, duration, time, start, frameRange, memory, assembly, output, encoderBackend, audio, captureFormat, jpegQuality };
}

export async function selectEncoderBackend(requested, probe) {
  if (!['auto', 'cpu', 'gpu'].includes(requested)) throw new Error('Encoder must be auto, cpu or gpu.');
  if (requested === 'cpu') return 'cpu';
  const result = await probe();
  if (result.available) return 'gpu';
  if (requested === 'gpu') throw new Error(`NVENC is unavailable: ${result.reason || 'availability probe failed'}`);
  return 'cpu';
}

function probeNvenc(ffmpeg) {
  return new Promise((resolveProbe) => {
    const probe = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      probe.kill();
    }, 5000);
    probe.stderr.on('data', data => {
      tail = (tail + data.toString()).slice(-8192);
    });
    probe.on('error', error => {
      clearTimeout(timeout);
      resolveProbe({ available: false, reason: error.message });
    });
    probe.on('close', code => {
      clearTimeout(timeout);
      resolveProbe({ available: code === 0 && !timedOut, reason: timedOut ? 'probe timed out after 5 seconds' : tail.trim() || `probe exited ${code}` });
    });
  });
}

/** Another render or dev server on this machine may already hold a fixed port, so ask the system for a free one. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

export async function renderMedia(values = process.argv.slice(2)) {
  const plan = parseRenderOptions(values);
  const { options, kind, backend, scene, presetName, preset, aspect, width, height, fps, time, start, memory, assembly, output, jpegQuality } = plan;
  let captureFormat = plan.captureFormat;
  let duration = plan.duration;
  let frameRangeSeconds = 0;
  if (options.asset) {
    const details = await stat(resolve(options.asset));
    if (!details.isFile() || details.size > 32 * 1024 ** 2) throw new Error('Asset capture requires a GLB file of at most 32 MiB.');
  }
  await mkdir(dirname(output), { recursive: true });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ffmpeg = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffmpeg.exe') : 'ffmpeg';
  const encoderBackend = kind === 'video' ? await selectEncoderBackend(plan.encoderBackend, () => probeNvenc(ffmpeg)) : null;
  const chrome = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const serverPort = await freePort();
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/render-vite.config.mjs', '--host', '127.0.0.1', '--port', String(serverPort), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  let browser;
  let frameReceiver;
  let frameServer;
  let assetServer;
  let encoder;
  let peakNodeBytes = 0;
  let peakBrowserHeap = 0;
  let peakEstimatedRenderBytes = 0;
  let maximumPendingFrames = 0;
  let firstFrameBytes = 0;
  let actualRenderSize;
  let capturedFrames = 0;
  const stageTimings = { renderSeconds: 0, captureSeconds: 0, readPixelsSeconds: 0, encoderBackpressureSeconds: 0, encoderFinishSeconds: 0 };
  const started = performance.now();
  try {
    await new Promise((resolveStarted, reject) => {
      const timeout = setTimeout(() => reject(new Error('Render server did not start.')), 15000);
      server.stdout.on('data', (data) => {
        // Vite bolds the port number when colour is forced, so strip the colour codes before looking for it.
        if (data.toString().replace(/\u001b\[[0-9;]*m/g, '').includes(`127.0.0.1:${serverPort}`)) { clearTimeout(timeout); resolveStarted(); }
      });
      server.on('error', reject);
      server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Render server exited ${code}.`)); });
    });
    const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-audio-output'];
    if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    else if (process.platform === 'darwin') args.push('--use-angle=metal', '--enable-gpu');
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}), args });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const route = scene === 'object' ? 'object.html' : `${scene}.html`;
    const query = new URLSearchParams({ export: '1', width: String(width), height: String(height), aspect, memory: String(memory), samples: String(backend === 'cpu' ? 1 : preset.samples) });
    if (scene === 'file') {
      const assetPaths = [];
      assetServer = await startAssetServer(assetPaths, { pageOrigin: `http://127.0.0.1:${serverPort}` });
      const world = prepareFileScene({ configPath: options.config, root: options.root, largeAssetOrigin: assetServer.origin });
      assetPaths.push(...world.assets);
      await page.route('**/__file/**', async (request) => {
        const { pathname } = new URL(request.request().url());
        if (pathname === '/__file/config.json') await request.fulfill({ json: world.description });
        else if (pathname === '/__file/camera.json' && plan.cameraKeys) await request.fulfill({ json: plan.cameraKeys });
        else if (pathname.startsWith('/__file/asset/')) await request.fulfill({ path: world.assets[Number(pathname.split('/')[3])] });
        else await request.fulfill({ status: 404, body: 'not found' });
      });
    }
    await page.goto(`http://127.0.0.1:${serverPort}/${route}?${query}`);
    await page.waitForFunction((mode) => window.__fileSceneError || window.__scene?.renderer || (mode === 'film' ? window.__filmReady : mode === 'nature' ? window.__nature?.renderer : mode === 'object' ? window.__studio?.renderer : false), scene, { timeout: SCENE_READY_TIMEOUT_MILLISECONDS });
    const fileSceneError = await page.evaluate(() => window.__fileSceneError);
    if (fileSceneError) throw new Error(`Scene file failed to load: ${fileSceneError}`);
    // Output draws only after the levels of detail are in, so the frames never depend on when they were made (#2985).
    await page.evaluate(() => window.__scene?.lodsReady);
    if (options.asset) {
      await page.locator('#file').setInputFiles(resolve(options.asset));
      await page.waitForFunction(() => document.querySelector('#notice').hidden || document.querySelector('#notice').textContent.startsWith('⚠'));
      const failure = await page.locator('#notice').evaluate(element => element.hidden ? null : element.textContent);
      if (failure) throw new Error(`Asset import failed: ${failure}`);
    }
    const sceneDuration = await page.evaluate(() => window.__scene?.duration ?? window.__film?.duration);
    if (Number.isFinite(sceneDuration) && sceneDuration > 0) {
      if (start >= sceneDuration) throw new Error('Start time must precede the end of the scene.');
      if (plan.frameRange && plan.frameRange.last / fps > sceneDuration + 1e-8) throw new Error(`Frame ${plan.frameRange.last} at ${fps} fps is at ${(plan.frameRange.last / fps).toFixed(3)} s, past the scene's ${sceneDuration.toFixed(3)} s. Pass a smaller last frame or a higher --fps.`);
      if (options.duration === undefined) duration = Math.min(240, sceneDuration - start);
      else if (kind === 'video' && start + duration > sceneDuration + 1e-8) throw new Error('The requested video extends beyond the scene duration.');
      if (kind === 'image' && time > sceneDuration) throw new Error('Image time exceeds the scene duration.');
    }
    if (scene !== 'film') await page.evaluate(({ memory, width, height, samples, scene, assembly }) => {
      const canvas = document.querySelector('canvas');
      canvas.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
      document.querySelectorAll('body > *, main > *').forEach((element) => {
        if (element === canvas || element.contains(canvas)) return;
        element.hidden = true;
        element.style.setProperty('display', 'none', 'important');
      });
      window.__scene?.pause?.();
      const renderer = window.__scene?.renderer ?? (scene === 'object' ? window.__studio.renderer : window.__nature.renderer);
      renderer.memoryBudgetMiB = memory;
      renderer.pixelRatio = 1;
      renderer.resize();
      if (window.__scene) return;
      if (scene === 'object') {
        window.__studio.state.exporting = true;
        window.__studio.state.assembly = assembly;
        renderer.projection[8] = 0;
        window.renderAt = () => renderer.render(window.__studio.camera());
      } else window.renderAt = (time) => window.__nature.renderAt(time);
    }, { memory, width, height, samples: backend === 'cpu' ? 1 : preset.samples, scene, assembly });
    const session = await page.context().newCDPSession(page);
    if (['auto', 'webcodecs', 'raw'].includes(captureFormat)) {
      frameReceiver = createFrameReceiver({ maximumBytes: width * height * 4 });
      frameServer = await startFrameServer(frameReceiver);
    }
    if (['auto', 'webcodecs'].includes(captureFormat)) {
      // The page encodes with the browser's hardware H.264 encoder and sends only the small encoded chunks. Software
      // rendering or a CPU encoder request uses screenshots, which feed ffmpeg's libx264, because raw readback is slower.
      const wantsCpu = backend === 'cpu' || options.encoder === 'cpu';
      const started = wantsCpu ? { supported: false, reason: 'A CPU render or encoder was requested.' }
        : await startVideoEncoderInPage(page, frameServer.url, { width, height, fps, quantizer: DEFAULT_PAGE_ENCODER_QUANTIZER });
      if (started.supported) captureFormat = 'webcodecs';
      else if (captureFormat === 'webcodecs') throw new Error(`Capture webcodecs is not available: ${started.reason}`);
      else captureFormat = 'jpeg';
    }
    if (captureFormat === 'raw') await installFrameReaderInPage(page, frameServer.url);
    // A raw frame is read from the drawing buffer in the same task as the draw. The round trip beyond the draw is capture.
    const render = async (seconds, frameIndex) => {
      if (errors.length) throw new Error(`Browser render errors: ${errors.join('; ')}`);
      const renderStarted = performance.now();
      const drawn = await page.evaluate(async ({ value, readFrame, encodeIndex }) => {
        const drawStarted = performance.now();
        if (window.__scene) window.__scene.renderAt(value);
        else if (window.renderAt) window.renderAt(value);
        else window.__nature.renderAt(value);
        const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
        const glError = renderer.context.getError();
        if (glError !== 0) throw new Error(`WebGL render error ${glError}.`);
        if (readFrame || encodeIndex !== null) window.__finishDraw();
        const drawMilliseconds = performance.now() - drawStarted;
        return { rendererPlan: renderer.memoryPlan, drawMilliseconds, frame: readFrame ? await window.__readFrame() : undefined,
          encoded: encodeIndex !== null ? await window.__encodeFrame(encodeIndex) : undefined };
      }, { value: seconds, readFrame: captureFormat === 'raw', encodeIndex: captureFormat === 'webcodecs' ? frameIndex : null });
      const rendererPlan = drawn.rendererPlan;
      const roundTripSeconds = (performance.now() - renderStarted) / 1000;
      const drawSeconds = drawn.frame || drawn.encoded ? drawn.drawMilliseconds / 1000 : roundTripSeconds;
      stageTimings.renderSeconds += drawSeconds;
      stageTimings.captureSeconds += roundTripSeconds - drawSeconds;
      stageTimings.readPixelsSeconds += (drawn.frame?.readMilliseconds ?? 0) / 1000;
      peakEstimatedRenderBytes = Math.max(peakEstimatedRenderBytes, rendererPlan.estimatedBytes);
      actualRenderSize = { width: rendererPlan.width, height: rendererPlan.height, reduced: rendererPlan.reduced };
      if (rendererPlan.estimatedBytes > memory * 1024 ** 2) throw new Error('Render target exceeded the configured memory budget.');
      const nodeBytes = process.memoryUsage().rss;
      peakNodeBytes = Math.max(peakNodeBytes, nodeBytes);
      if (nodeBytes > 512 * 1024 ** 2) throw new Error('Capture process exceeded 512 MiB. Export stopped before buffering more frames.');
      return drawn;
    };
    async function capture(seconds, frameIndex) {
      const { frame: rawFrame, encoded } = await render(seconds, frameIndex);
      if (encoded) {
        capturedFrames++;
        return undefined;
      }
      if (rawFrame) {
        capturedFrames++;
        const bytes = frameReceiver.take({ width, height }, rawFrame);
        if (!firstFrameBytes) firstFrameBytes = bytes.byteLength;
        return bytes;
      }
      const captureStarted = performance.now();
      const screenshot = await session.send('Page.captureScreenshot', {
        format: captureFormat,
        fromSurface: true,
        ...(captureFormat === 'jpeg' ? { quality: jpegQuality } : { optimizeForSpeed: true }),
      });
      const image = Buffer.from(screenshot.data, 'base64');
      stageTimings.captureSeconds += (performance.now() - captureStarted) / 1000;
      capturedFrames++;
      if (!firstFrameBytes) firstFrameBytes = image.byteLength;
      return image;
    }
    if (kind === 'video') {
      const audioPath = plan.audio ? resolve(plan.audio) : null;
      if (options.audio && !existsSync(audioPath)) throw new Error('The selected audio file was not found.');
      let audioArguments = [];
      let frameCount = videoFrameCount(fps, duration);
      if (audioPath && existsSync(audioPath)) {
        // -shortest would cut the picture at the end of a shorter sound, so refuse before rendering anything.
        ({ audioArguments, frameCount } = await planRenderMediaAudio({
          audioPath, startSeconds: start, fps, durationSeconds: duration,
          measureAudioSeconds: path => measureStreamSeconds(ffmpeg, path, 'audio'),
        }));
      }
      encoder = createFrameEncoder(renderEncoderOptions({ ffmpeg, output, fps, captureFormat, width, height, encoderBackend, audioArguments, frameCount }));
      if (captureFormat === 'webcodecs') frameReceiver.onChunk(chunk => encoder.writeChunk(chunk));
      const captureSequenceStarted = performance.now();
      for (let frame = 0; frame < frameCount; frame++) {
        const image = await capture(start + frame / fps, frame);
        maximumPendingFrames = Math.max(maximumPendingFrames, 1);
        if (image) await encoder.writeFrame(image);
        stageTimings.encoderBackpressureSeconds = encoder.metrics.backpressureSeconds;
        if (frame % 48 === 0) {
          const { usedSize } = await session.send('Runtime.getHeapUsage');
          peakBrowserHeap = Math.max(peakBrowserHeap, usedSize);
          if (usedSize > 256 * 1024 ** 2) throw new Error('Browser JavaScript heap exceeded 256 MiB. Export stopped.');
          const elapsed = (performance.now() - captureSequenceStarted) / 1000;
          const effectiveFps = (frame + 1) / elapsed;
          const remainingSeconds = (frameCount - frame - 1) / effectiveFps;
          const message = `Rendered ${frame + 1}/${frameCount} frames | ${effectiveFps.toFixed(1)} fps | ${(effectiveFps / fps).toFixed(2)}x | ETA ${Math.ceil(remainingSeconds)}s | Node ${Math.round(process.memoryUsage().rss / 2 ** 20)} MiB`;
          console.log(message);
        }
      }
      if (captureFormat === 'webcodecs') await page.evaluate(() => window.__finishVideoEncoder());
      const encoding = await encoder.finish();
      stageTimings.encoderFinishSeconds = encoding.finishSeconds;
      // A silent film must not pass for a finished one: the encoder reports success even when the sound was dropped.
      if (audioArguments.length) await assertOutputHasAudio(ffmpeg, output, frameCount / fps);
    } else if (plan.frameRange) {
      // One numbered file per frame, each at exactly frame / fps, so a range split over several runs matches one long run.
      const { first, last } = plan.frameRange;
      const rangeStarted = performance.now();
      for (let frame = first; frame <= last; frame++) {
        await writeFile(framePath(output, frame, last, captureFormat), await capture(frame / fps));
        if ((frame - first) % 30 === 29) console.log(`Rendered ${frame - first + 1}/${plan.frameRange.count} frames`);
      }
      frameRangeSeconds = (performance.now() - rangeStarted) / 1000;
    } else if (kind === 'stills') {
      const stillTimes = scene === 'film' && start === 0 && options.duration === undefined
        ? [23, 49, 59, 101, 114, 149, 158, 182]
        : Array.from({ length: 8 }, (_, index) => start + duration * (index + 0.5) / 8);
      const paths = stillPaths(output, stillTimes.length, captureFormat);
      for (const [stillIndex, seconds] of stillTimes.entries()) {
        await writeFile(paths[stillIndex], await capture(seconds));
      }
    } else {
      await writeFile(output, await capture(time));
    }
    if (errors.length) throw new Error(`Browser render errors: ${errors.join('; ')}`);
    const graphics = await page.evaluate(() => {
      const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
      const context = renderer.context;
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      return { gpu: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable', samples: renderer.capabilities?.samples ?? renderer.samples, capabilities: renderer.capabilities, glError: context.getError() };
    });
    if (graphics.glError !== 0) throw new Error(`WebGL render error ${graphics.glError}.`);
    if (backend === 'cpu' && !graphics.gpu.toLowerCase().includes('swiftshader')) throw new Error('CPU backend did not select SwiftShader.');
    const elapsedSeconds = (performance.now() - started) / 1000;
    const framesReport = plan.frameRange ? { ...plan.frameRange, millisecondsPerFrame: (frameRangeSeconds * 1000) / plan.frameRange.count } : null;
    const report = { scene, kind, backend, preset: presetName, aspect, start, frames: framesReport, encoder: captureFormat === 'webcodecs' ? 'browser-h264' : encoderBackend, requestedEncoder: kind === 'video' ? plan.encoderBackend : null, captureFormat, jpegQuality: captureFormat === 'jpeg' ? jpegQuality : null, capturedFrames, stageTimings, effectiveFPS: capturedFrames / elapsedSeconds, speedRatio: kind === 'video' ? capturedFrames / fps / elapsedSeconds : null, assembly: scene === 'object' ? assembly : null, width, height, actualRenderSize, fps, duration: kind === 'video' ? duration : null, memoryBudgetMiB: memory, peakEstimatedRenderBytes, peakNodeBytes, peakBrowserHeap, maximumPendingFrames, firstFrameBytes, elapsedSeconds, graphics, output: basename(output), errors };
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      await encoder?.close();
    } finally {
      try { await browser?.close(); }
      finally {
        try { await frameServer?.close(); }
        finally {
          try { await assetServer?.close(); }
          finally { server.kill(); }
        }
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderMedia();
