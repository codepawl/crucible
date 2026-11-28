// renderer.backend "native" on render jobs: the optional hardware ray query tracer (Cook, @codepawlhq/cook) traces the scene
// the job page exported, then the job runner denoises and writes the PNG. The package and its binary are optional: when they,
// or a Vulkan ray query adapter, are missing, the job runs on the gpu or cpu backend and the report says why.
import { NOTEWORTHY_COMPILE_SECONDS } from './agent-render-estimate.mjs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clampLimitsByEngine, requireRenderEngine } from './render-engine.mjs';
import { estimateRelativeNoise } from '../src/path-tracer-denoise.js';
import { readBlobBytes } from './cdp-blob-read.mjs';
import { applyExportDelta } from './native-export-delta.js';
import { requireExportFitsCapacity } from './native-capacity.mjs';
import { mapLookToCookPost } from './native-post-look.mjs';
import { encodeOpaquePng } from './native-png.mjs';
import { NATIVE_JOB_MAXIMUM_INSTANCES, NATIVE_JOB_MAXIMUM_TRIANGLES, chunkedTriangleBound } from './native-bake-page.js';

// The name sits in a variable so the bundler leaves the import alone; the package resolves from the user's node_modules.
const NATIVE_PACKAGE = '@codepawlhq/cook';
const INSTALL_HINT = 'npm install github:codepawl/cook, then npm run build inside it';
const MODULE_NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
// The Crucible defaults of a job, lowered by the limits the installed engine declares.
const DEFAULT_ENGINE_LIMITS = { triangles: NATIVE_JOB_MAXIMUM_TRIANGLES, instances: NATIVE_JOB_MAXIMUM_INSTANCES };
const TABLE_NAMES = ['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'];
const TABLE_TYPES = { triangles: Float32Array, materials: Float32Array, lights: Float32Array, atlas: Uint32Array,
  environmentColors: Float32Array, environmentTables: Float32Array, parameters: Uint8Array };

const NOT_INSTALLED_REASON = `renderer.backend "native" needs ${NATIVE_PACKAGE} (${INSTALL_HINT}).`;

function isModuleNotFound(error, specifier) {
  return MODULE_NOT_FOUND_CODES.has(error?.code) && String(error.message).includes(specifier);
}

// COOK_PACKAGE_PATH names a local Cook checkout, whose index.mjs is imported by file URL.
function chooseSpecifier() {
  const checkoutPath = process.env.COOK_PACKAGE_PATH;
  if (!checkoutPath) return { specifier: NATIVE_PACKAGE };
  const indexPath = join(resolve(checkoutPath), 'index.mjs');
  if (!existsSync(indexPath)) return { missingReason: `renderer.backend "native" found no index.mjs in COOK_PACKAGE_PATH (${checkoutPath}); point it at a Cook checkout or unset it.` };
  return { specifier: pathToFileURL(indexPath).href };
}

// Resolves with { module }, { missingReason } for an absent package or { reason } for an install that exists but fails to load.
async function importNativePackage(importPackage) {
  const { specifier, missingReason } = chooseSpecifier();
  if (missingReason) return { missingReason };
  try {
    return { module: await importPackage(specifier) };
  } catch (error) {
    if (isModuleNotFound(error, specifier)) return { missingReason: NOT_INSTALLED_REASON };
    return { reason: `renderer.backend "native" found ${NATIVE_PACKAGE} but it failed to load (${error?.message ?? error}); reinstall it (${INSTALL_HINT}).` };
  }
}

function checkNativePackage(imported) {
  if (imported.missingReason) return { reason: imported.missingReason };
  if (imported.reason) return { reason: imported.reason };
  const checked = requireRenderEngine(imported.module);
  if (checked.reason) return { reason: `renderer.backend "native" cannot use ${NATIVE_PACKAGE}: ${checked.reason}` };
  let addonPath;
  try {
    addonPath = checked.engine.findNativeAddon();
  } catch (error) {
    return { reason: `renderer.backend "native" cannot find the binary of ${NATIVE_PACKAGE}: ${error.message}` };
  }
  if (!addonPath) return { reason: `renderer.backend "native" needs the built binary of ${NATIVE_PACKAGE} (npm run build in that package, or COOK_ADDON_PATH for a build elsewhere).` };
  // A package newer than the pinned one checks the addon's build info on load; its message (stale addon, wrong platform) is the reason as written.
  if (typeof imported.module.loadNativeAddon === 'function') {
    try {
      imported.module.loadNativeAddon();
    } catch (error) {
      return { reason: error.message };
    }
  }
  const limits = clampLimitsByEngine(DEFAULT_ENGINE_LIMITS, checked.description.limits);
  return { tracer: checked.engine, description: checked.description, limits };
}

/**
 * A cached look for the native tracer. Looking costs one import and one file check, done once per process. `markUnusable`
 * records a failure from a real trace (usually no ray query adapter), so later jobs skip the attempt and keep the reason.
 * A found tracer comes with the engine `description` and the job `limits` (Crucible defaults lowered by the engine's own).
 */
export function createNativeTracerLocator({ importPackage = specifier => import(specifier) } = {}) {
  let lookup;
  let unusableReason = null;
  return {
    async find() {
      // JS67_NATIVE_TRACER=off keeps a job on the gpu or cpu backend whatever is installed, which is also how the fallback is tested.
      if (process.env.JS67_NATIVE_TRACER === 'off') return { reason: 'renderer.backend "native" is switched off by JS67_NATIVE_TRACER=off.' };
      // COOK_DISABLE=1 behaves like an absent package (the test helper and the build honour it too).
      if (process.env.COOK_DISABLE === '1') return { reason: NOT_INSTALLED_REASON };
      lookup ??= importNativePackage(importPackage).then(checkNativePackage);
      const found = await lookup;
      if (unusableReason) return { reason: unusableReason };
      return found;
    },
    markUnusable(reason) {
      unusableReason = `renderer.backend "native" could not trace (${reason}), which usually means no Vulkan ray query adapter.`;
    },
  };
}

/**
 * Which backend a job's frames run on. "native" falls back to gpu, or to cpu on a runtime without a GPU, and `note` says why.
 * Every other request runs as asked, and the caller still rejects "gpu" on a cpu runtime.
 */
export async function chooseTraceBackend({ requested, runtimeBackend, locator }) {
  if (requested !== 'native') return { backend: requested };
  const found = await locator.find();
  if (found.tracer) return { backend: 'native', tracer: found.tracer };
  const fallback = runtimeBackend === 'cpu' ? 'cpu' : 'gpu';
  return { backend: fallback, reason: found.reason, note: `${found.reason} The ${fallback} backend ran instead.` };
}

const V2_TABLE_TYPES = { Uint8Array, Uint32Array, Int32Array, Float32Array };

// A table as bytes that start their own buffer, so any typed array can view them: base64 from a one-message export is
// decoded into a fresh buffer, and the bytes a chunked export collected are already one.
function tableBytesFrom(table) {
  if (table instanceof Uint8Array && !Buffer.isBuffer(table) && table.byteOffset === 0) return table;
  const bytes = typeof table === 'string' ? Buffer.from(table, 'base64') : table;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

// The manifest of a chunked export, and the capacity use of a scene that fits the adapter. A scene that cannot fit fails here,
// before any table is read from the page.
function readChunkedManifest(manifest, capacity, caller) {
  const { chunks, ...exported } = manifest;
  if (!chunks || !(chunks.chunkBytes > 0)) {
    throw new TypeError(`${caller}: the export carries no \`chunks\` manifest. Export the scene with transport "chunks".`);
  }
  return { chunks, exported, capacityUse: capacity ? requireExportFitsCapacity(manifest, capacity) : undefined };
}

/**
 * Reads every table of a chunked export (the `manifest` of splitExportForChunks) from a page that holds them as one Blob, back to
 * back in manifest order, and returns the export with its `tables` as bytes, which traceFrameNative takes like the base64 of a
 * one-message export. `readBlob(byteLength)` resolves with all of its bytes; each table is copied out into a buffer of its own.
 * No single string holds a table, so the scene is bounded by memory, not by a message. A manifest with `chunks.delta` sends only the
 * ranges that changed since the export `baseline` (`{ id, tables }`) holds; the tables come back patched, byte for byte what a full
 * export gives, and `sentBytes` says how many bytes crossed.
 */
export async function collectExportBlob(manifest, readBlob, { capacity, baseline } = {}) {
  const { chunks, exported, capacityUse } = readChunkedManifest(manifest, capacity, 'collectExportBlob');
  const { delta } = chunks;
  if (delta && baseline?.id !== delta.base) {
    throw new RangeError(`The native scene export is a delta against ${JSON.stringify(delta.base)}, and the baseline held here is ${JSON.stringify(baseline?.id)}. Export the scene again without a baseline.`);
  }
  const totalBytes = delta
    ? Object.values(delta.ranges).reduce((total, list) => total + list.reduce((sum, [, length]) => sum + length, 0), 0)
    : Object.values(chunks.tables).reduce((total, byteLength) => total + byteLength, 0);
  const blob = await readBlob(totalBytes);
  if (blob.length !== totalBytes) {
    throw new RangeError(`The native scene export sent ${blob.length} bytes, expected ${totalBytes}. The page changed the export while it was read.`);
  }
  if (delta) {
    const tables = applyExportDelta({ previous: baseline.tables, lengths: chunks.tables, ranges: delta.ranges, sent: blob });
    return { ...exported, tables, ...(capacityUse ? { capacityUse } : {}), sentBytes: totalBytes };
  }
  const tables = {};
  let offset = 0;
  for (const [name, byteLength] of Object.entries(chunks.tables)) {
    tables[name] = blob.slice(offset, offset + byteLength);
    offset += byteLength;
  }
  return { ...exported, tables, ...(capacityUse ? { capacityUse } : {}) };
}

/**
 * Exports the scene of a render job from its page and returns it with byte tables. `input` is what the page's
 * `exportNativeScene` takes. The page holds the tables as one Blob and the job runner reads it over the DevTools stream of
 * `session` (the CDP session of the page; one is made and detached here when none is passed). The page lets go of its copy
 * when the read ends, whether it succeeded or not. `capacity` (from readNativeCapacity) makes a scene the adapter cannot hold
 * fail before its tables are read. `baseline` is an object the caller keeps for the frames of one job: each frame after the first
 * reads only the table ranges that changed since the one before, unless JS67_NATIVE_EXPORT_DELTA=off. A frame that cannot use it
 * (the page lost its copy) reads every table, and the tables are the same bytes either way.
 */
export async function fetchNativeExport(page, input, { capacity, session, baseline } = {}) {
  const maximumTriangles = chunkedTriangleBound(capacity?.maxUniqueTriangles);
  const keepBaseline = baseline !== undefined && process.env.JS67_NATIVE_EXPORT_DELTA !== 'off';
  const request = { ...input, chunked: true, maximumTriangles, ...(keepBaseline ? { keepBaseline, ...(baseline.id === undefined ? {} : { deltaBase: baseline.id }) } : {}) };
  const manifest = await page.evaluate(exportRequest => window.__agentPreview.exportNativeScene(exportRequest), request);
  const { exportId } = manifest;
  const exported = await readHeldNativeExport(page, manifest, {
    blobExpression: 'window.__agentPreview.nativeExportBlob()',
    release: () => window.__agentPreview.releaseNativeExport(),
    capacity,
    session,
    baseline,
  });
  if (baseline !== undefined) {
    baseline.id = keepBaseline ? exportId : undefined;
    baseline.tables = keepBaseline && exportId !== undefined ? exported.tables : undefined;
  }
  return exported;
}

/**
 * Reads the chunked export a page holds, given the `manifest` it answered with (fetchNativeExport and the render-file CLI both
 * end here). `blobExpression` evaluates to the Blob of the tables in the page and `release` runs there when the read ends,
 * whether it succeeded or not. The Blob comes over the DevTools stream of `session` (made and detached here when none is
 * passed); `capacity` fails a scene the adapter cannot hold before any byte is read.
 */
export async function readHeldNativeExport(page, manifest, { blobExpression, release, capacity, session: givenSession, baseline }) {
  const session = givenSession ?? await page.context().newCDPSession(page);
  try {
    return await collectExportBlob(manifest, byteLength => readBlobBytes(session, blobExpression, byteLength), { capacity, baseline });
  } finally {
    await page.evaluate(release).catch(() => {});
    if (!givenSession) await session.detach().catch(() => {});
  }
}

// The FORMAT-v2 input of an instanced scene: the page names each table's array type and sends the record counts.
function decodeTablesV2(exported) {
  const input = { schemaVersion: exported.schemaVersion, ...exported.counts };
  for (const [name, base64] of Object.entries(exported.tables)) {
    const View = V2_TABLE_TYPES[exported.types?.[name]];
    if (!View) throw new TypeError(`The exported native scene table "${name}" has an unknown array type ${JSON.stringify(exported.types?.[name])}.`);
    const bytes = tableBytesFrom(base64);
    input[name] = new View(bytes.buffer, 0, bytes.length / View.BYTES_PER_ELEMENT);
  }
  return input;
}

// The bytes of every table the tracer is handed, which is what it uploads to the card (before alignment).
function tableBytes(tables) {
  return Object.values(tables).reduce((total, value) => total + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
}

function decodeTables(exported) {
  if (exported.schemaVersion !== undefined) return decodeTablesV2(exported);
  const input = { triangleCount: exported.triangleCount };
  for (const name of TABLE_NAMES) {
    const bytes = tableBytesFrom(exported.tables[name]);
    const View = TABLE_TYPES[name];
    input[name] = new View(bytes.buffer, 0, bytes.length / View.BYTES_PER_ELEMENT);
  }
  return input;
}

function normalizeNormals(normal) {
  for (let offset = 0; offset < normal.length; offset += 3) {
    const length = Math.hypot(normal[offset], normal[offset + 1], normal[offset + 2]);
    if (length > 1e-6) {
      normal[offset] /= length;
      normal[offset + 1] /= length;
      normal[offset + 2] /= length;
    }
  }
}

function withoutAlpha(rgba, pixelCount) {
  const color = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    color.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return color;
}

/**
 * The colour with every negative value raised to zero. Dispersive glass keeps signed spectral weights (as Cycles does), so a
 * trace can hold small negative pixels at the most saturated fringes. The film stays signed; this clamp sits in front of what
 * cannot take them: OIDN, and the display transforms (agx and neutral shift hue and brightness on a negative channel). The
 * wavelet and a-trous filters only average, so they keep the signs. A buffer with no negative value comes back as the same
 * array, so a render without dispersion is untouched.
 */
export function clampNegativeColor(color) {
  let clamped = null;
  for (let index = 0; index < color.length; index++) {
    if (!(color[index] < 0)) continue;
    clamped ??= color.slice();
    clamped[index] = 0;
  }
  return clamped ?? color;
}

/**
 * The native kernel a job traces with: "cycles" (the Cycles-matching kernel) unless JS67_NATIVE_KERNEL=legacy asks for the
 * older one. Any other value is passed on so `traceNative` rejects it with its own message.
 */
export function chooseNativeKernel(environment = process.env) {
  const requested = environment.JS67_NATIVE_KERNEL;
  return requested === undefined || requested === '' ? 'cycles' : requested;
}

export const DEFAULT_NATIVE_DISPATCH_BUDGET_MS = 8;

/**
 * Whether a job keeps repeated geometry as instances: on with the "cycles" kernel, off with the legacy kernel and when
 * JS67_NATIVE_INSTANCING=off asks for flattened triangles (to compare the two, or to rule instancing out of a bug).
 */
export function chooseNativeInstancing(environment = process.env) {
  return chooseNativeKernel(environment) === 'cycles' && environment.JS67_NATIVE_INSTANCING !== 'off';
}

/**
 * The GPU dispatch time budget in milliseconds for interactive cycles renders (#1124), so long frames split into tiles
 * instead of stalling the compositor. Defaults to 8 ms on the cycles kernel; `JS67_NATIVE_DISPATCH_BUDGET_MS=off` disables it.
 */
export function chooseNativeDispatchBudgetMs({ dispatchBudgetMs, environment = process.env, kernel = chooseNativeKernel(environment) } = {}) {
  if (kernel !== 'cycles') return undefined;
  if (dispatchBudgetMs !== undefined) return dispatchBudgetMs === false || dispatchBudgetMs === null ? undefined : dispatchBudgetMs;
  const raw = environment.JS67_NATIVE_DISPATCH_BUDGET_MS;
  if (raw === undefined || raw === '') return DEFAULT_NATIVE_DISPATCH_BUDGET_MS;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === 'off' || trimmed === '0' || trimmed === 'false') return undefined;
  return Number(raw);
}

/**
 * The traced colour after the GPU a-trous filter, three floats per pixel. The cycles kernel already returned it when the
 * trace asked for `denoise: "atrous"`; otherwise (the legacy kernel, or the filter after OIDN failed) the tracer filters
 * the traced image with its guide buffers. Throws when the installed package cannot filter.
 */
function atrousColor({ tracer, traced, width, height }) {
  let filtered = traced.denoisedRgba;
  if (!filtered) {
    if (typeof tracer.denoiseAtrous !== 'function') throw new Error('the installed @codepawlhq/cook package has no a-trous filter');
    const { rgba, albedo, normal, depth, variance } = traced;
    filtered = tracer.denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance }).rgba;
  }
  return withoutAlpha(filtered, width * height);
}

// One in-process OIDN device per loaded denoiser package, kept for the life of the process so the second and later frames
// skip device creation and the filter commit. `instance` is null when the package, the OIDN library or the addon cannot do it.
const persistentOidnByPackage = new WeakMap();

function persistentOidnFor({ tracer, denoiser }) {
  if (typeof denoiser.createOidnDenoiser !== 'function' || typeof tracer.createNativeOidnDenoiser !== 'function') return { instance: null };
  if (!persistentOidnByPackage.has(denoiser)) {
    try {
      persistentOidnByPackage.set(denoiser, { instance: denoiser.createOidnDenoiser({ createNative: tracer.createNativeOidnDenoiser }) });
    } catch (error) {
      persistentOidnByPackage.set(denoiser, { instance: null, note: error.message });
    }
  }
  return persistentOidnByPackage.get(denoiser);
}

/**
 * Runs OIDN on one frame: in the persistent in-process device when it is available, otherwise (or when that call fails)
 * through the `oidnDenoise` tool. Resolves with the filtered colour and `{ mode, note }`; `mode` is "in-process" or "cli".
 */
export async function denoiseFrameWithOidn({ tracer, denoiser, width, height, color, albedo, normal }) {
  const persistent = persistentOidnFor({ tracer, denoiser });
  let note = persistent.note;
  if (persistent.instance) {
    try {
      return { linear: await persistent.instance.denoise({ width, height, color, albedo, normal }), mode: 'in-process' };
    } catch (error) {
      note = error.message;
    }
  }
  const linear = await denoiser.denoiseWithOidn({ width, height, color, albedo, normal });
  return { linear, mode: 'cli', ...(note ? { note: `The in-process OIDN device was not used (${note}): the oidnDenoise tool ran instead.` } : {}) };
}

// Blends the filtered colour into the job's history and returns the colour to show. A frame that did not go through a
// session (a one-shot fallback) has no kernel parameter block to reproject with, so the history starts again after it.
function blendOverTime({ temporal, color, features, kernelParams, route, report }) {
  if (!kernelParams) {
    temporal.restart('the frame before did not render through a session');
    report.temporal = { historyShare: 0, restarted: 'this frame did not render through a session' };
    return color;
  }
  const started = performance.now();
  const blended = temporal.accumulate({ color, depth: features.depth, normal: features.normal, kernelParams,
    sceneChanged: route.path !== 'reused' });
  report.temporal = { historyShare: blended.historyShare, ...(blended.restarted ? { restarted: blended.restarted } : {}),
    seconds: (performance.now() - started) / 1000 };
  return blended.color;
}

/**
 * Yields one macrotask after a native frame so older addons' external-buffer finalizers and queued UI work can run (#1211).
 * Cook >= 0.2.1 with V8-owned TypedArrays (codepawl/cook#34) releases frame planes immediately even without yielding.
 */
export function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}


/**
 * The sentence for a frame that spent seconds compiling its kernel, or undefined when it did not. Cook compiles one kernel per
 * scene variant (a scene with no emitter is a different variant from a lit one), and the first trace of a variant pays for it.
 */
export function describeKernelCompile({ compileSeconds }) {
  if (!(compileSeconds >= NOTEWORTHY_COMPILE_SECONDS)) return undefined;
  return `This frame spent ${compileSeconds.toFixed(1)} s compiling the kernel variant its scene needs, which is not trace time. Later frames of this job reuse it.`;
}

/**
 * Traces one frame the page exported and returns the PNG (base64) with the job report. `denoise` is "none", "wavelet",
 * "atrous" (the tracer's GPU filter, which is also where a missing or failing OIDN lands) or "oidn"; `denoiser` is the
 * loaded OIDN package for "oidn". The result also holds `rawLinear`, the traced colour before any filter (three floats per
 * pixel), which equals `linear` when no filter ran. `sequence` (from createNativeSequence) renders a cycles kernel frame through the job's
 * persistent session and adds `report.nativeSession`, the route the frame took. `temporal` (from createTemporalAccumulator)
 * blends the filtered colour of a session frame into the frames before it and adds `report.temporal`; `linear` is the
 * blended colour and `rawLinear` stays the traced colour of this frame alone. `viewTransform` (aces, agx or neutral), `look` and
 * `exposure` set the display look. A session frame with no JavaScript denoiser or temporal blend gets its 8-bit display bytes from
 * Cook's GPU post stage (`nativePost: false` turns that off); any other frame, or a look Cook's post cannot say, uses the
 * JavaScript helper, and `report.display` names the path and the reason. `report.encodeSeconds` is the display and PNG time. Throws when the tracer cannot run, so the caller can fall back.
 */
export async function traceFrameNative(frameOptions) {
  const traced = await traceOneFrameNative(frameOptions);
  // The frame's planes are unreferenced now, so the yield lets their finalizers run before the next frame is traced.
  await yieldToEventLoop();
  return traced;
}

/**
 * The 8-bit display bytes of a frame. Cook's GPU post stage made them (`traced.display`) when the frame asked for it and the film it
 * resolved is the film shown: no JavaScript denoiser or temporal blend changed `linear` afterwards. Otherwise the JavaScript helper
 * makes them, and `report.display` says which path ran and why.
 */
async function displayBytes({ traced, linear, width, height, nativePost, postTrace, report, look }) {
  const { toneMapToRgba8 } = await import('../src/path-tracer.js');
  if (postTrace.post && traced.display) {
    report.display = { path: 'cook-post', postSeconds: traced.postSeconds };
    return traced.display;
  }
  const reason = nativePost === false ? 'native post was switched off for this frame'
    : postTrace.reason ?? 'this frame did not render through a session';
  report.display = { path: 'javascript', reason };
  const displayed = clampNegativeColor(linear);
  const scaled = look.exposure === 1 ? displayed : displayed.map(value => value * look.exposure);
  return toneMapToRgba8(scaled, width, height, { viewTransform: look.viewTransform, look: look.look, localToneMapping: look.localToneMapping ?? null });
}

async function traceOneFrameNative({ tracer, exported, width, height, samples, bounces, seed, denoise, denoiser, maxSeconds, noiseThreshold = 0, kernel = chooseNativeKernel(), dispatchBudgetMs, sequence, temporal,
  nativePost = true, viewTransform = 'aces', look = null, exposure = 1, localToneMapping = null }) {
  const started = performance.now();
  const filtersInTrace = denoise === 'atrous' && kernel === 'cycles';
  const tables = decodeTables(exported);
  // The GPU post stage reads the film the session resolved, so it fits only when no JavaScript step edits the film afterwards.
  const jsEditsFilm = !(denoise === 'none' || filtersInTrace) || Boolean(temporal);
  const postRequest = nativePost === false ? {} : jsEditsFilm ? { reason: 'a JavaScript denoiser or temporal blend edits the film after the trace' } : mapLookToCookPost({ viewTransform, look, exposure, localToneMapping });
  const chosenDispatchBudgetMs = chooseNativeDispatchBudgetMs({ dispatchBudgetMs, kernel });
  const traceOptions = { width, height, samples, maxSeconds, kernel, noiseThreshold,
    ...(chosenDispatchBudgetMs === undefined ? {} : { dispatchBudgetMs: chosenDispatchBudgetMs }),
    ...(filtersInTrace ? { denoise: 'atrous' } : {}),
    ...(sequence && kernel === 'cycles' && postRequest.post ? { post: postRequest.post } : {}) };
  const { traced, route, kernelParams } = sequence && kernel === 'cycles'
    ? sequence.trace(tables, traceOptions)
    : { traced: tracer.traceNative(tables, traceOptions) };
  const tracedSeconds = (performance.now() - started) / 1000;
  const pixelCount = width * height;
  const features = { color: withoutAlpha(traced.rgba, pixelCount), albedo: traced.albedo, normal: traced.normal,
    depth: traced.depth, variance: traced.variance };
  normalizeNormals(features.normal);
  const averageSamples = traced.averageSamples ?? samples;
  const estimatedNoise = estimateRelativeNoise({ color: features.color, variance: features.variance, averageSamples });
  const kernelCompileNote = describeKernelCompile({ compileSeconds: traced.compileSeconds });
  const report = { width, height, samples, bounces, seed, denoised: false, denoiser: 'none', threads: 1, backend: 'native',
    gpu: traced.adapter, nativeBackend: traced.backend, nativeFeatures: traced.features, setupSeconds: traced.setupSeconds, compileSeconds: traced.compileSeconds,
    uploadSeconds: traced.uploadSeconds, accelerationBuildSeconds: traced.accelerationBuildSeconds,
    ...(traced.tracedSeconds === undefined ? {} : { gpuTraceSeconds: traced.tracedSeconds }),
    ...(kernelCompileNote ? { kernelCompileNote } : {}),
    kernel, averageSamples, noiseThreshold, ...(estimatedNoise === null ? {} : { estimatedNoise }), triangles: exported.triangles, inputBytes: tableBytes(tables), ...(exported.instances === undefined ? {} : { instances: exported.instances }),
    ...(exported.instancing === undefined ? {} : { instancing: exported.instancing, instancingReason: exported.instancingReason }),
    ...(exported.materialsReason === undefined ? {} : { materialsReason: exported.materialsReason }), tracedSeconds, ignored: exported.ignored,
    ...(route ? { nativeSession: route } : {}), ...(exported.capacityUse ? { nativeCapacity: exported.capacityUse } : {}), ...(exported.sentBytes === undefined ? {} : { exportSentBytes: exported.sentBytes }) };
  const rawLinear = features.color;
  let linear = features.color;
  const denoiseStarted = performance.now();
  if (denoise === 'oidn') {
    try {
      const filtered = await denoiseFrameWithOidn({ tracer, denoiser, width, height, color: clampNegativeColor(features.color), albedo: features.albedo, normal: features.normal });
      linear = filtered.linear;
      Object.assign(report, { denoised: true, denoiser: 'oidn', oidnVersion: denoiser.OIDN_VERSION, oidnMode: filtered.mode, ...(filtered.note ? { denoiserNote: filtered.note } : {}) });
    } catch (error) {
      report.denoiserNote = `OIDN failed (${error.message}): the GPU a-trous filter ran instead.`;
      denoise = 'atrous';
    }
  }
  if (denoise === 'atrous') {
    try {
      linear = atrousColor({ tracer, traced, width, height });
      Object.assign(report, { denoised: true, denoiser: 'atrous' });
    } catch (error) {
      const failure = `The GPU a-trous filter failed (${error.message}): the wavelet filter ran instead.`;
      report.denoiserNote = [report.denoiserNote, failure].filter(Boolean).join(' ');
      denoise = 'wavelet';
    }
  }
  if (denoise === 'wavelet') {
    const { denoiseRadiance } = await import('../src/path-tracer-denoise.js');
    linear = denoiseRadiance({ width, height, ...features });
    Object.assign(report, { denoised: true, denoiser: 'wavelet' });
  }
  if (report.denoised) report.denoiseSeconds = (performance.now() - denoiseStarted) / 1000;
  if (temporal) {
    linear = blendOverTime({ temporal, color: linear, features, kernelParams, route, report });
  }
  const encodeStarted = performance.now();
  const rgba8 = await displayBytes({ traced, linear, width, height, nativePost, postTrace: postRequest, report, look: { viewTransform, look, exposure, localToneMapping } });
  const png = encodeOpaquePng(rgba8, width, height);
  report.encodeSeconds = (performance.now() - encodeStarted) / 1000;
  report.seconds = (performance.now() - started) / 1000;
  return { data: Buffer.from(png).toString('base64'), report, linear, rawLinear };
}

function floatsToBase64(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

function floatsFromBase64(data) {
  const bytes = Buffer.from(data, 'base64');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, copy.length / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * Traces the texels of a recipe bake that the page packed, for the page's `__crucibleNativeBake` bridge. `request` holds the
 * scene `tables` and `triangleCount` as `exportNativeScene` makes them, plus `texelCount`, `points`, `normals` (base64
 * floats) and `samples`. Resolves with the base64 `radiance` and `escaped` arrays; throws when the tracer cannot run.
 */
export function traceTexelsNative({ tracer, request, maxSeconds }) {
  const texels = { count: request.texelCount, points: floatsFromBase64(request.points), normals: floatsFromBase64(request.normals) };
  const traced = tracer.traceNativeTexels(decodeTables(request), texels, { samples: request.samples, maxSeconds });
  return { radiance: floatsToBase64(traced.radiance), escaped: floatsToBase64(traced.escaped), adapter: traced.adapter,
    compileSeconds: traced.compileSeconds, tracedSeconds: traced.tracedSeconds };
}

/** True for the error the native tracer raises when a trace passes its `maxSeconds`: a clean failure, not a broken adapter. */
export function isNativeTimeLimitError(error) {
  if (error?.code === 'COOK_TIME_LIMIT') return true;
  return /passed its time limit/.test(error?.message ?? '');
}
