import { createServer } from 'node:http';
import { loadPreviewPage } from './agent-page-load.mjs';
import { withSnapshotSkyColors } from './snapshot-sky-colors.mjs';
import { previewCallTimeoutMs, recipeHasGridVolume, operationsAddGridVolume, assetDataBytes, slowAssetsNote } from './agent-evaluation-timeout.mjs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { sampleBrowserHeap, memoryGuardLimits, exceedsMemoryGuard, memoryGuardMessage, createNativeMemoryAllowance } from './agent-memory-guard.mjs';
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { resolveLookView } from '../src/look-views.js';
import { runFitLook } from './agent-fit-look.mjs';
import { FIT_LOOK_CAPABILITY_NOTE } from '../src/look-fit-notes.js';
import { TREE_GROWTH_CAPABILITIES, VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CLUTTER_CAPABILITY_NOTE } from '../src/agent-clutter-notes.js';
import { GRASS_CAPABILITY_NOTE } from '../src/agent-grass-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';
import { FOLDED_APPLY_OPERATION_NOTES } from '../src/apply-operation-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_SEQUENCE_JOB_SIDE, MAXIMUM_SEQUENCE_JOB_PIXELS, maximumMemoryMiB, memoryRangeError, BAKE_WORKER_MAXIMUM_SECONDS, MAXIMUM_SQUARE_JOB_SIDE, MAXIMUM_SQUARE_SEQUENCE_JOB_SIDE, MAXIMUM_STILLS_FRAMES } from '../src/agent-scene-capabilities.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { chooseDenoiser, finishWithOidn } from './agent-path-trace-denoise.mjs';
import { createNativeSequence } from './agent-native-sequence.mjs';
import { chooseNativeTemporal, createTemporalAccumulator, temporalFrameSeed } from './agent-native-temporal.mjs';
import { readNativeCapacity } from './native-capacity.mjs';
import { backendFallbackForFrame, explainFailureAfterFallback } from '../src/agent-backend-fallback.js';
import { chooseNativeInstancing, chooseNativeKernel, chooseTraceBackend, createNativeTracerLocator, fetchNativeExport, isNativeTimeLimitError, traceFrameNative, traceTexelsNative } from './agent-native-trace.mjs';
import { addonCapabilities, addonFileFor, addonImportMap } from './mcp-addons.mjs';
import { createAgentAssetCatalog, fingerprintAssetDirectory } from './agent-asset-catalog.mjs';
import { launchWithShaderCache, shaderCacheDirectory } from './agent-shader-cache.mjs';
import { createPackRegistry } from './agent-packs.mjs';
import { VEGETATION_SCANS_PACK, fillVegetationScans, needsVegetationScans, vegetationScansFromPack } from '../src/agent-vegetation-scans.js';
import { MAXIMUM_INSTALLED_PACKS, MAXIMUM_PACK_BYTES, MAXIMUM_PACK_FILES, MAXIMUM_PACK_FILE_BYTES, MAXIMUM_PACK_JSON_BYTES, MAXIMUM_PACK_ITEMS_PER_KIND, PACK_CONTENT_KINDS } from '../src/pack-manifest.js';
import { geometryOnlyGlb } from './agent-query-asset.mjs';
import { AGENT_ASSET_LIMITS, MAX_CHECKED_TRIANGLES, configureAssetByteLimit, assertCombinedAssetBytes, assertCombinedByteTotal, sceneAssetBytesLimitMessage } from '../src/agent-asset-limits.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { namesCatalogFiles, resolveAssetPlacementNames, namesCatalogSequences, resolveCatalogSequenceNames, namesCatalogTextureMaps, resolveTextureSetNames } from '../src/agent-asset-names.js';
import { sequenceFrameIds, hasStreamedSequence } from '../src/agent-texture-sequence.js';
import { readVolumeGridFiles, volumeGridFileBytes } from '../src/mcp-volume-grids.js';
import { catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from '../src/look-catalog.js';
import { TEXTURE_SEQUENCE_CAPABILITIES, TEXTURE_SEQUENCE_LIMITS } from '../src/texture-sequence-limits.js';
import { TEXTURE_SET_CAPABILITIES } from '../src/texture-set-names.js';
import { writeWebBuild } from './web-export.mjs';
import { KTX2_WORKER_CSP, KTX2_WORKER_SOURCE } from './agent-preview-ktx2-worker.mjs';
import { gameAssetIds, gameImageIds } from '../src/game-assets.js';
import { resolveJobRoot } from './agent-job-root.mjs';
import { createAgentRenderJobs, EXPORT_DIRECTORY_NAME, HIGH_PRECISION_FRAME_FACTOR, MAXIMUM_JOB_FRAME_BYTES, MAXIMUM_JOB_OUTPUT_BYTES, RENDER_HISTORY_FILE, normalizeJobSettings, frameByteLimitFor, oversizeFrameBudgetError, requireTracerBackendAvailable } from './agent-render-jobs.mjs';
import { RENDER_QUALITY_NOTE, applyQuality, tierReport } from './agent-render-quality.mjs';
import { RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget } from './agent-render-budget.mjs';
import { RENDER_ESTIMATE_NOTE, addKernelCompile, estimateRenderJob, historyWithJob, outputByteBudgetProblem, parseHistory, pathTraceTriangleProblem, renderReport, sceneSizeFrom } from './agent-render-estimate.mjs';
import { objectIdMetrics } from './agent-object-id-metrics.mjs';
import { renderIconsInPage } from './agent-icon-page.mjs';
import { ICON_CAPABILITIES } from '../src/icon-sheet.js';
import { renderJobMattes, requireMatteTargets } from './job-mattes.mjs';
import { encodeRenderOutput, encodeMultilayerExr } from './render-output-encoders.mjs';
import { createFrameEncoder } from './frame-encoder.mjs';
import { DEFAULT_PAGE_ENCODER_QUANTIZER, createFrameReceiver, startVideoEncoderInPage } from './gpu-frame-reader.mjs';
import { SYNC_TOLERANCE_SECONDS, assertAudioCoversVideo, audioInputArguments, createAudioLibrary, measureStreamSeconds } from './job-audio.mjs';
import { filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline } from '../src/film-timeline.js';
import { isPreviewHost } from './preview-host.mjs';
import { runAnnotateSession } from './annotate-session.mjs';
import { openInDefaultBrowser } from './annotate-open.mjs';
import { ANNOTATE_LIMITS, validateMarks, isBoundedPng } from '../src/agent-annotate.js';
import { REVIEW_LINK_LIMITS, newReviewId, parseReviewFile, validateReviewMarks } from '../src/review-link.js';
import { writeReviewBuild } from './review-page.mjs';
import { normalizeReview, reviewDeadlineMessage, REVIEW_LIMITS } from './agent-review.mjs';
import { normalizeWedge } from './agent-wedge.mjs';
import { WEDGE_LIMITS } from '../src/agent-wedge.js';
import { mergeFrameDiagnostics, pathTracerFindingsLimit, pathTracerSkippedPassesWarning } from '../src/frame-checks.js';
import { BRANCH_LIMITS, validateBranchName } from '../src/agent-branches.js';
import { createSharedGpuCard } from './agent-gpu-queue.mjs';
import { isBrowserLoss, describeBrowserLoss } from './agent-browser-loss.mjs';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { GLB_EXPORT_NOTES } from '../src/glb-export-omissions.js';
import { MOTION_NOT_SET_HINT, recipeMoves } from '../src/motion-hint.js';
import { previewDeadlineMilliseconds } from './preview-deadline.mjs';
import { assertCapturedPngSize, captureClip } from './render-capture-size.mjs';
import { realismReport, reviewTilingFindings } from './review-realism.mjs';

const SCENE_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAXIMUM_IMAGE_BYTES = 1024 * 1024;
// A PNG grows about with its pixel count, so the retry aims at the budget (with 10 percent to spare) instead of stepping a fixed 0.75: a 1024x640 look that is 1.3 MiB comes back at about 870 wide, not 768 (#3056).
const LOOK_BUDGET_SPARE = 0.9;
const LOOK_LARGEST_STEP_SCALE = 0.9;
const LOOK_SMALLEST_STEP_SCALE = 0.5;
const LOOK_MAXIMUM_STEP_DOWNS = 4;
const LOOK_MINIMUM_SIDE = 64;
function lookStepScale(encodedBytes) {
  const aimed = Math.sqrt((MAXIMUM_IMAGE_BYTES * LOOK_BUDGET_SPARE) / encodedBytes);
  return Math.min(LOOK_LARGEST_STEP_SCALE, Math.max(LOOK_SMALLEST_STEP_SCALE, aimed));
}
const MAXIMUM_MOTION_SOURCES = 4;
// A path trace shares the machine with the person using it, so it takes half of the eight-thread ceiling.
const PATH_TRACER_THREADS = 8;
const MAXIMUM_QUEUED_CALLS = 16;
const MAXIMUM_REMEMBERED_EVICTIONS = 32;
const MAXIMUM_GLB_BYTES = 32 * 1024 * 1024;
const MAXIMUM_KEPT_GLBS = 8;
const MAXIMUM_KEPT_WEB_BUILDS = 4;
const EXPORTED_GLB_NAME = /^[0-9a-f-]{36}\.glb$/;
const EXPORTED_WEB_BUILD_NAME = /^web-[0-9a-f-]{36}$/;
// 30 seconds unless a test harness that starts the server asks for longer (#2741).
const EVALUATION_TIMEOUT_MS = previewDeadlineMilliseconds();
// A browser stuck in a long shader compile may never answer the close request; teardown waits this long, then goes on (#2200).
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const RECOVERY_HINT = 'The scenes in this runtime are lost. Call scene_create (or scene_create_asset) to start a fresh runtime; no server restart is needed.';
const FAILED_RUNTIME_MESSAGE = `The agent runtime is failed. ${RECOVERY_HINT}`;
// Handing the scene page to a render job or review and bringing it back gets longer than an ordinary call. A job cut short by its deadline usually ran
// while another process held the GPU, and the page can need that long to draw again once the card is free (#1256).
const PAGE_HANDOFF_TIMEOUT_MS = 4 * EVALUATION_TIMEOUT_MS;
const QUERY_ONLY_TIMEOUT_MS = 120000;
/** A bake runs on a worker for up to its own limit, so a call that bakes gets that much more than a plain call. */
const BAKE_EVALUATION_TIMEOUT_MS = EVALUATION_TIMEOUT_MS + BAKE_WORKER_MAXIMUM_SECONDS * 1000;

/** The last set-bake among the operations decides: a bake object adds one, null clears it. Undefined when there is none. */
function bakeAfterOperations(operations) {
  const setBakes = Array.isArray(operations) ? operations.filter(operation => operation?.type === 'set-bake') : [];
  if (setBakes.length === 0) {
    return undefined;
  }
  const lastBake = setBakes[setBakes.length - 1].bake;
  return lastBake !== null && lastBake !== undefined;
}
// The preview page imports engine chunks that sit beside the package entries, one folder above preview.js.
const ENGINE_CHUNK_URL = /^\/[\w.-]+\.js$/;
const pageHtml = importMapScript => '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#182126}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas>' + importMapScript + '<script type="module" src="/preview.js"></script></body></html>';

/** Local, serialized browser preview. No browser is launched until scene creation. */
// Optional peer dependencies the page loads from the host's node_modules. Rapier ships its WASM inside rapier.mjs.
const VENDOR_FILES = Object.freeze({
  '/vendor/manifold.js': { resolve: require => require.resolve('manifold-3d/manifold.js'), type: 'application/javascript; charset=utf-8' },
  '/vendor/manifold.wasm': { resolve: require => require.resolve('manifold-3d/manifold.wasm'), type: 'application/wasm' },
  '/vendor/rapier.js': { resolve: require => join(dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs'), type: 'application/javascript; charset=utf-8' },
  '/vendor/basis_transcoder.js': { resolve: require => require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'), type: 'application/javascript; charset=utf-8' },
  '/vendor/basis_transcoder.wasm': { resolve: require => require.resolve('three/examples/jsm/libs/basis/basis_transcoder.wasm'), type: 'application/wasm' },
});

/** Checks the launch paths that need no job folder; the CLI runs it before serving so a bad value exits with its message. */
// What a tool that needs the preview renderer says while a render job holds it: which job, how far it is, and the next call.
function leaseHeldMessage(record) {
  const progress = record.state === 'running' ? ` (frame ${record.progress.frames} of ${record.settings.frameCount})` : '';
  return `The renderer is leased to render job ${record.jobId}, which is ${record.state}${progress}. Poll scene_render_status with {"jobId":"${record.jobId}"} until it is completed, or stop it with scene_render_cancel, then call this tool again.`;
}

export function validateLaunchPaths({ browser, assets, packs, ffmpeg = 'ffmpeg', audio }) {
  if (browser !== undefined && (typeof browser !== 'string' || !existsSync(browser))) {
    throw new Error('The configured browser executable does not exist.');
  }
  if (assets !== undefined && (typeof assets !== 'string' || !isAbsolute(assets))) {
    throw new TypeError('Asset root must be an explicit absolute directory path.');
  }
  if (packs !== undefined && (typeof packs !== 'string' || !isAbsolute(packs))) {
    throw new TypeError('Packs root must be an explicit absolute directory path.');
  }
  if (typeof ffmpeg !== 'string' || !ffmpeg || (ffmpeg !== 'ffmpeg' && (!isAbsolute(ffmpeg) || !existsSync(ffmpeg)))) {
    throw new TypeError('FFmpeg must be on PATH or configured with an existing absolute executable path.');
  }
  if (audio !== undefined) {
    createAudioLibrary(audio);
  }
}

export function createAgentRuntime({ kernelWorkers = true, backend = 'gpu', browser: browserPath, memory = 192, assets: assetRoot, packs: packsRoot,
  jobs: jobRoot, ffmpeg = 'ffmpeg', audio: audioRoot, gpuQueue, openPage = openInDefaultBrowser, addons: addonSet = { addons: [], skipped: [] },
  previewUrl = new URL(/* @vite-ignore */ '../build/mcp/preview.js', import.meta.url), totalMemoryBytes = totalmem(), askUserFixture, maxAssetBytes } = {}) {
  if (maxAssetBytes !== undefined) configureAssetByteLimit(maxAssetBytes);
  if (!['gpu', 'cpu'].includes(backend)) {
    throw new RangeError('backend must be gpu or cpu.');
  }
  let nativeTracerLocator;
  // Raised by the first native frame and kept for the life of the process: the in-process OIDN device stays loaded.
  const nativeMemoryAllowance = createNativeMemoryAllowance();
  const maximumMemory = maximumMemoryMiB(totalMemoryBytes);
  if (!Number.isInteger(memory) || memory < 32 || memory > maximumMemory) {
    throw memoryRangeError(memory, maximumMemory);
  }
  validateLaunchPaths({ browser: browserPath, assets: assetRoot, packs: packsRoot, ffmpeg });
  jobRoot = resolveJobRoot(jobRoot);
  const importMapScript = addonSet.addons.length === 0 ? '' : `<script type="importmap">${JSON.stringify(addonImportMap(packageMetadata.exports))}</script>`;
  // The one inline script is the import map; its hash is allowed so script-src stays 'self'. No addons, no hash.
  const importMapHash = addonSet.addons.length === 0 ? '' : ` 'sha256-${createHash('sha256').update(importMapScript.slice(importMapScript.indexOf('>') + 1, -'</script>'.length)).digest('base64')}'`;
  const registeredByAddon = {};
  const refusedAddons = [];
  const audioLibrary = audioRoot === undefined ? undefined : createAudioLibrary(audioRoot);
  // One unit of GPU work (a look, a review, a bake, a render job) waits for the person's own GPU queue when --gpu-queue is set.
  // The server takes the card before it enters its own call queue, so a long wait never blocks other calls, and a unit that
  // runs while the server already holds the card (a look during a render job) joins that hold instead of queueing against itself.
  const gpuCard = gpuQueue ? createSharedGpuCard(gpuQueue) : undefined;
  function gpuUnit(weight, work, options) {
    return gpuCard ? gpuCard.run(weight, work, options) : work();
  }
  let phase = 'idle';
  // A restart replaces the browser and every scene; a job that began before it must not touch the new runtime when it unwinds.
  let runtimeGeneration = 0;
  let browserInstance;
  let httpServer;
  // The job that is capturing video frames, if any. Its socket path is secret and lives only as long as the job.
  let activeFrameReceiver;
  let page;
  let reviewPage;
  let cancelReview;
  // One per scene_ask_user call that is waiting for the person; close() aborts them so the page server and its timer end at once.
  const pendingAskControllers = new Set();
  // The view each exported review page shows (reviewId to sessionId, revision and camera), so a saved review file carries only marks and
  // cannot choose the camera its rays are cast from. The reviewId sits in the exported page, so a file proves nothing about who wrote it.
  // Each entry is read once; oldest first, bounded.
  const rememberedReviews = new Map();
  // Views shown inline by an MCP Apps host (#923): the person's marks come back in a later call, so the frame they marked is kept here.
  const inlineAsks = new Map();
  const MAXIMUM_INLINE_ASKS = 8;
  // Open scenes, least recently used first; the last one is what a call without a sessionId means.
  const openSessionIds = new Set();
  // Set once a recipe with a streamed texture sequence is read; from then on a call with a motion time supplies its frames first.
  let streamedSequencesUsed = false;
  // Scenes the page closed to stay under the scene cap, so a later call with one of them gets a clear error.
  const evictedSessionIds = [];
  const evictionReasons = {};
  // Scenes that have a bake, so an edit that rebakes gets the longer deadline.
  const bakedSessionIds = new Set();
  let queuedCalls = 0;
  let queue = Promise.resolve();
  let closing;
  let catalogPromise;
  let catalogFingerprint;
  let packsPromise;
  let jobsPromise;
  // Set by submitJob for the one job that may run; runJob takes it. Kept in the job folder, the history never leaves the machine.
  let estimateForNextJob;
  let gpuTracerWarm = false;
  async function readRenderHistory() {
    try {
      return parseHistory(await readFile(join(jobRoot, RENDER_HISTORY_FILE), 'utf8'));
    } catch {
      return [];
    }
  }
  // The history only sharpens later estimates, so a failed write never fails the job that finished.
  async function rememberRenderJob({ settings, estimate, report, ranSize }) {
    try {
      const history = historyWithJob(await readRenderHistory(), { settings, backend, estimate, report, ranSize });
      await writeFile(join(jobRoot, RENDER_HISTORY_FILE), JSON.stringify(history), { mode: 0o600 });
    } catch (error) {
      console.error(`Crucible could not save the render history: ${error.message}`);
    }
  }
  const savedGlbPaths = [];
  const savedWebBuildPaths = [];
  // One frame for marking, with the camera it was drawn with. Shared by the local annotate page and the exported review page.
  async function captureAnnotateFrame(sessionId, width, height, motionTime) {
    if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
      throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
    }
    return enqueue(async () => {
      await requirePreviewRenderer();
      requireSession(sessionId);
      await page.setViewportSize({ width, height });
      return invoke('annotateFrame', { sessionId, ...(motionTime === undefined ? {} : { motionTime }) });
    });
  }
  // The view the marks were made on. A film scene also names the time it was drawn at (`motionTime`), so a note like "too bright
  // here" says at which moment; a scene without motion leaves the field out.
  function annotateViewOf(frame) {
    const motionTime = frame.metadata.motionTime;
    return { width: frame.width, height: frame.height, camera: frame.camera, ...(typeof motionTime === 'number' ? { motionTime } : {}) };
  }
  // Resolves pixel marks to parts, points and normals against the camera of the picture they were made on. The answer is the same
  // shape whether the marks came from the local page or from a saved review file.
  async function sentMarksContent(base, camera, marks, duringText) {
    const { sessionId, view } = base;
    const picked = await enqueue(() => invoke('pickMarks', { sessionId, camera, marks, width: view.width, height: view.height, ...(view.motionTime === undefined ? {} : { motionTime: view.motionTime }) }));
    const sceneChanged = picked.revision !== base.revision;
    return { ...base, outcome: 'sent', marks: picked.marks,
      ...(sceneChanged ? { warning: `The scene changed from revision ${base.revision} to ${picked.revision} ${duringText}; part IDs and points describe revision ${picked.revision}, the picture shows ${base.revision}.` } : {}) };
  }
  // scene_export_web with review: a static page of the current view that a person pins on any device and saves as a file. It shares the
  // export folder, naming and retention of the game builds, and needs no game.
  async function exportReviewPage({ sessionId, title }) {
    await jobs();
    const frame = await captureAnnotateFrame(sessionId, 768, 512);
    const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await seedKeptExports(directory);
    const outputDirectory = join(directory, `web-${randomUUID()}`);
    const reviewId = newReviewId();
    let summary;
    try {
      summary = await writeReviewBuild({ frame, outputDirectory, title, reviewId });
    } catch (error) {
      await rm(outputDirectory, { recursive: true, force: true });
      throw error;
    }
    savedWebBuildPaths.push(outputDirectory);
    while (savedWebBuildPaths.length > MAXIMUM_KEPT_WEB_BUILDS) await rm(savedWebBuildPaths.shift(), { recursive: true, force: true });
    const view = annotateViewOf(frame);
    rememberReview(reviewId, { sessionId, revision: frame.metadata.revision, view });
    return { sessionId, revision: frame.metadata.revision, review: true, ...summary, entry: join(outputDirectory, 'index.html'),
      host: 'Serve the folder with any static file server, or send it as is. The reviewer saves a file; pass its text to scene_ask_user as reviewFile.' };
  }
  function rememberReview(reviewId, entry) {
    rememberedReviews.set(reviewId, entry);
    while (rememberedReviews.size > REVIEW_LINK_LIMITS.maxRememberedReviews) rememberedReviews.delete(rememberedReviews.keys().next().value);
  }
  // scene_ask_user with reviewFile: the saved marks of an exported review page, read as if the person had pressed Send here.
  async function readReviewFile(input) {
    const { reviewId, marks: rawMarks } = parseReviewFile(input.reviewFile);
    const review = rememberedReviews.get(reviewId);
    if (!review) {
      throw new Error('This review file does not match a review page exported by this server run (or its export was dropped after eight newer ones). Export the review page again with scene_export_web review: true and ask for a new file.');
    }
    if (review.consumed) {
      throw new Error('This review file was already read by an earlier scene_ask_user call. Each export is read once: export the review page again with scene_export_web review: true and ask for a new file.');
    }
    if (review.sessionId !== input.sessionId) {
      throw new Error(`This review file was made for scene ${review.sessionId}, not ${input.sessionId}. Pass that sessionId.`);
    }
    const maxMarks = Math.min(input.maxMarks ?? ANNOTATE_LIMITS.maxMarks, ANNOTATE_LIMITS.maxMarks);
    const marks = validateReviewMarks(rawMarks, { width: review.view.width, height: review.view.height, maxMarks });
    const base = { sessionId: review.sessionId, revision: review.revision, view: review.view };
    const content = await sentMarksContent(base, review.view.camera, marks, 'after the review page was exported');
    review.consumed = true;
    return { content };
  }
  // Capabilities must work without the job store: a store that cannot open is reported here, not thrown.
  async function jobRecords() {
    if (!jobRoot) return { records: [] };
    try {
      const records = (await jobs()).list().map(record => ({ jobId: record.jobId, state: record.state,
        sourceRevision: record.sourceRevision, progress: record.progress }));
      return { records };
    } catch (error) {
      return { records: [], unavailable: error.message };
    }
  }
  function jobs() {
    if (!jobRoot) throw new Error('Configure --jobs with an absolute output directory before submitting render jobs.');
    if (!jobsPromise && closing) throw new Error('The agent runtime is closing or closed.');
    // A failed creation is not kept: the next call tries again instead of repeating the first error until restart.
    jobsPromise ??= createAgentRenderJobs({ root: jobRoot, run: runJob, acquireGpu: gpuCard ? signal => gpuCard.take('heavy', signal) : undefined }).catch(error => {
      jobsPromise = undefined;
      throw error;
    });
    return jobsPromise;
  }
  // Exports an earlier server run left in the folder count toward the retention limits, oldest first, so a run never adds to them.
  let keptExportsSeeded = false;
  async function seedKeptExports(directory) {
    if (keptExportsSeeded) return;
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const isGlb = entry.isFile() && EXPORTED_GLB_NAME.test(entry.name);
      const isWebBuild = entry.isDirectory() && EXPORTED_WEB_BUILD_NAME.test(entry.name);
      if (!isGlb && !isWebBuild) continue;
      const path = join(directory, entry.name);
      found.push({ path, isGlb, modified: (await lstat(path)).mtimeMs });
    }
    found.sort((left, right) => left.modified - right.modified);
    savedGlbPaths.unshift(...found.filter(item => item.isGlb).map(item => item.path));
    savedWebBuildPaths.unshift(...found.filter(item => !item.isGlb).map(item => item.path));
    keptExportsSeeded = true;
  }
  // The caller never names a path: files get a server-chosen name in the jobs folder, and only the newest few are kept.
  async function saveGlbExport(bytes) {
    const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The export folder must be a real directory without links.');
    await seedKeptExports(directory);
    while (savedGlbPaths.length >= MAXIMUM_KEPT_GLBS) await unlink(savedGlbPaths.shift());
    const filename = `${randomUUID()}.glb`;
    const path = join(directory, filename);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    savedGlbPaths.push(path);
    return { path, filename, mimeType: 'model/gltf-binary', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), keptExports: savedGlbPaths.length };
  }
  /** The render job that still holds the renderer: one that has not reached a terminal state. Undefined when the renderer is free. */
  async function leasingJob() {
    if (phase !== 'rendering') return undefined;
    const terminal = ['completed', 'cancelled', 'failed', 'interrupted'];
    const running = (await jobs()).list().find(record => !terminal.includes(record.state));
    if (running) return running;
    // A queued job can be cancelled before its runner acquires the renderer.
    phase = 'ready';
    return undefined;
  }
  async function rendererStillLeased() {
    return (await leasingJob()) !== undefined;
  }
  async function requirePreviewRenderer() {
    const holder = await leasingJob();
    if (holder) throw new Error(leaseHeldMessage(holder));
  }
  function catalog() {
    if (!assetRoot && !packsRoot) throw new Error('Configure --assets or --packs with an absolute directory before importing GLB assets.');
    catalogPromise ??= packs().then(registry => createAgentAssetCatalog(assetRoot ?? null, registry?.files));
    return catalogPromise;
  }
  /**
   * The catalog after a stat-only look at the --assets folder: a file that appeared, vanished or was rewritten since the last build
   * makes a new catalog (#2209), so a download made mid-session is listed and placeable by name. Used where an agent asks for the
   * list or names a file; reads by asset ID keep the catalog they were pinned against.
   */
  async function rescannedCatalog() {
    if (assetRoot) {
      const fingerprint = await fingerprintAssetDirectory(assetRoot);
      if (fingerprint !== catalogFingerprint) {
        catalogFingerprint = fingerprint;
        catalogPromise = undefined;
      }
    }
    const ready = catalog();
    ready.catch(() => {
      if (catalogPromise === ready) catalogPromise = undefined;
    });
    return ready;
  }
  // Installed data-only packs (docs/packs.md): checked once per runtime; their GLB, image, look and HDRI files join the catalog.
  function packs() {
    if (!packsRoot) return Promise.resolve(null);
    packsPromise ??= createPackRegistry(packsRoot, { packageVersion: packageMetadata.version });
    return packsPromise;
  }

  // The bark and leaf scans per species of the installed vegetation-scans pack, or null without it.
  async function vegetationScans() {
    const registry = await packs();
    const pack = registry?.list().packs.find(candidate => candidate.name === VEGETATION_SCANS_PACK);
    return pack ? vegetationScansFromPack(pack.items.images) : null;
  }

  /** Replaces each `asset: { name }` placement of a recipe or edit list with its catalog id, so everything after this holds the pinned hash. */
  async function pinNamedAssets(value) {
    // Trees without scans draw the vegetation-scans pack when it is installed (`scans: {}` keeps them procedural).
    if (needsVegetationScans(value)) {
      const scans = await vegetationScans();
      if (scans) fillVegetationScans(value, scans);
    }
    if (namesCatalogFiles(value)) resolveAssetPlacementNames(value, (await rescannedCatalog()).resolveName);
    if (namesCatalogSequences(value)) await resolveCatalogSequenceNames(value, pattern => rescannedCatalog().then(assets => assets.resolveSequence(pattern)));
    if (namesCatalogTextureMaps(value)) {
      const assets = await rescannedCatalog();
      await resolveTextureSetNames(value, { resolveSet: assets.resolveTextureSet, checkMap: assets.checkTextureMap });
    }
  }

  /** The same for the asset recipe of scene_create_asset: `assetName` (a catalog file name) becomes `assetId`. */
  async function pinNamedAssetRecipe(recipe) {
    if (recipe?.assetName === undefined) return;
    if (recipe.assetId !== undefined) throw new TypeError('Pass exactly one of recipe.assetId (the pinned SHA-256) or recipe.assetName (the catalog file name), not both.');
    recipe.assetId = (await rescannedCatalog()).resolveName(recipe.assetName);
    delete recipe.assetName;
  }

  /** The catalog IDs a recipe or edit list loads: placed assets, map sequence frames and the HDRI and .cube files that are not shipped. */
  function catalogIdsOf(value) {
    const catalogIds = new Set([...recipeAssetNeeds(value).map(need => need.id), ...sequenceFrameIds(value)]);
    const { environments, looks } = catalogLookReferences(value);
    for (const reference of [...environments, ...looks]) {
      if (!BUNDLED_ENVIRONMENT_NAMES.includes(reference) && !BUNDLED_CUBE_LOOK_NAMES.includes(reference)) catalogIds.add(reference);
    }
    return catalogIds;
  }

  /**
   * Adds up the sizes of the files one call would send, from the catalog record (the embedded length), and refuses the call over the combined limit
   * before any file is read or base64 encoded. Reading first peaked at about 2.2 times the total before the check ran. Motion source
   * assets travel in their own field next to the placed ones, so each counts again even when a recipe also places it.
   * With sceneValue, the assets the scene already holds count too, once per unique ID, because a render job loads the whole scene at once (#1771).
   */
  async function assertPlacedAssetsFitBeforeReading(value, motionSourceIds = [], sceneValue = undefined) {
    const catalogIds = catalogIdsOf(value);
    if (sceneValue) for (const id of catalogIdsOf(sceneValue)) catalogIds.add(id);
    // With a scene, its grid files count too, once per name even when the edit names the same file.
    let total = volumeGridFileBytes(sceneValue ? [value, sceneValue] : value);
    const namedAssets = [];
    if (catalogIds.size || motionSourceIds.length) {
      const readyCatalog = await catalog();
      for (const id of [...catalogIds, ...motionSourceIds]) {
        const described = await readyCatalog.describeSize(id);
        namedAssets.push(described);
        total += described.bytes;
      }
    }
    assertCombinedByteTotal(total, sceneValue ? sceneAssetBytesLimitMessage : undefined, namedAssets);
  }

  /** Refuses an edit that adds catalog assets to a scene whose unique assets would then pass the combined limit, before the preview page loads them. */
  async function assertSceneAssetsFitAfterEdit(sessionId, editedValue) {
    if (!catalogIdsOf(editedValue).size) return;
    const { recipe } = await invoke('exportRecipe', { sessionId });
    await assertPlacedAssetsFitBeforeReading(editedValue, [], recipe);
  }

  /**
   * Refuses a render job or review of a scene whose unique assets pass the combined limit, before the scene page is suspended. The job would fail
   * while loading them, and the recovery that reloads the scene would then crash the page (#1848). An asset snapshot is one catalog file, already capped per file.
   */
  async function assertSceneFitsBeforeJob(recipe) {
    if (recipe?.format === 'crucible.asset') return;
    await assertPlacedAssetsFitBeforeReading({}, [], recipe);
  }

  /**
   * Pins each item of an icons job to its catalog asset id, so the job holds the content hash and a re-exported file cannot change
   * a render in flight. An item is a catalog GLB name or an asset id; the original text stays as `source` for icons.json.
   */
  async function pinIconItems(settings) {
    if (!Array.isArray(settings.items)) return settings;
    const readyCatalog = await rescannedCatalog();
    const items = await Promise.all(settings.items.map(async item => {
      if (typeof item !== 'string') return item;
      if (/^[0-9a-f]{64}$/.test(item)) {
        await readyCatalog.size(item);
        return { source: item, asset: item };
      }
      return { source: item, asset: readyCatalog.resolveName(item) };
    }));
    return { ...settings, items };
  }

  /** Bytes of the catalog files a recipe places, each file once however many copies the scene holds, for the render time estimate. */
  async function placedAssetFileBytes(recipe) {
    const needs = recipeAssetNeeds(recipe);
    if (!needs.length) return 0;
    const readyCatalog = await catalog();
    let totalBytes = 0;
    for (const { id } of needs) totalBytes += (await readyCatalog.describeSize(id)).bytes;
    return totalBytes;
  }

  /** The file name and byte length of each catalog asset a recipe or edit list places, for the error of a call that ran long. */
  async function placedAssetSizes(value) {
    const readyCatalog = await catalog();
    return Promise.all(recipeAssetNeeds(value).map(({ id }) => readyCatalog.describeSize(id)));
  }

  /** Bytes of the catalog assets a recipe or edit list places, base64 by asset id, for the page that decodes them. */
  async function placedAssetData(value, { transcodeKtx2 = false } = {}) {
    await assertPlacedAssetsFitBeforeReading(value);
    const needs = recipeAssetNeeds(value);
    const entries = await Promise.all(needs.map(async ({ id }) => [id, (await (await catalog()).read(id, { transcodeKtx2 })).toString('base64')]));
    return { ...(needs.length ? { assetData: Object.fromEntries(entries) } : {}), ...(await sequenceFrameData(value)), ...(await lookFileData(value)), ...volumeGridData(value) };
  }

  /**
   * A set-game that animates a node the scene already places needs one more decoded copy of that asset, which the operations alone do not
   * name. Returns the scene's nodes with the new game, which the page and the byte loader read the asset needs from, or undefined.
   */
  async function gameAssetNeeds({ sessionId, operations }) {
    const setGame = (operations ?? []).findLast(operation => operation.type === 'set-game');
    if (!setGame?.game) return undefined;
    const { recipe } = await invoke('exportRecipe', { sessionId });
    const candidate = { nodes: recipe.nodes, game: setGame.game };
    return recipeAssetNeeds(candidate).some(need => need.copies > 1) ? { recipe: candidate } : undefined;
  }

  /** The HDRI and .cube files a recipe names: shipped ones by name from assets/looks, the others by catalog ID. The page decodes them. */
  async function lookFileData(value) {
    const { environments, looks } = catalogLookReferences(value);
    // Derived from previewUrl (build/mcp/preview.js in the repo and the package), not from import.meta.url: the bundler
    // inlines a literal `new URL(..., import.meta.url)` as a data URL, and the bundled server sits two folders below the package root.
    const shippedLooksUrl = new URL('../../assets/looks/', previewUrl);
    const lookData = {};
    for (const [kind, references] of [['environment', environments], ['look', looks]]) {
      for (const reference of references) {
        const shipped = BUNDLED_ENVIRONMENT_NAMES.includes(reference) || BUNDLED_CUBE_LOOK_NAMES.includes(reference);
        const bytes = shipped
          ? await readFile(new URL(`${reference}.${kind === 'environment' ? 'hdr' : 'cube'}`, shippedLooksUrl))
          : await (await catalog()).read(reference);
        lookData[reference] = kind === 'environment' ? { kind, base64: bytes.toString('base64') } : { kind, text: bytes.toString('utf8') };
      }
    }
    return Object.keys(lookData).length ? { lookData } : {};
  }

  /** Bytes of the catalog images a recipe or edit list uses as map sequence frames, base64 by asset id. The page decodes them. */
  async function sequenceFrameData(value) {
    if (hasStreamedSequence(value)) streamedSequencesUsed = true;
    const ids = sequenceFrameIds(value);
    if (!ids.length) return {};
    const entries = await Promise.all(ids.map(async id => [id, (await (await catalog()).read(id)).toString('base64')]));
    return { sequenceData: Object.fromEntries(entries) };
  }

  /** Bytes of the grid files (.67vg) the grid volumes of a recipe or edit list name, base64 by file name, never a path. The page registers them. */
  function volumeGridData(value) {
    const files = readVolumeGridFiles(value);
    if (!files.size) return {};
    return { gridData: Object.fromEntries([...files].map(([name, bytes]) => [name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')])) };
  }

  // Motion layers can play a clip of another catalog asset (`from.asset`). The page gets those assets' bytes by catalog ID,
  // never a path, and keeps only their clips and nodes.
  async function motionSources(motions, placedValue = {}) {
    const ids = new Set();
    for (const motion of motions) {
      for (const layer of Array.isArray(motion?.layers) ? motion.layers : []) {
        const id = layer?.from?.asset;
        if (typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id)) ids.add(id.toLowerCase());
      }
    }
    if (ids.size > MAXIMUM_MOTION_SOURCES) throw new RangeError(`Motion layers can retarget clips of at most ${MAXIMUM_MOTION_SOURCES} other assets at once.`);
    if (!ids.size) return {};
    await assertPlacedAssetsFitBeforeReading(placedValue, [...ids]);
    const sources = {};
    for (const id of ids) sources[id] = (await (await catalog()).read(id)).toString('base64');
    return { sources };
  }

  // A failed runtime has lost its scene page and every scene in it. A call that starts a new scene may bring up a fresh runtime
  // instead of repeating the failure until the server restarts (#1256); every other call still says the runtime is failed.
  async function restartFailedRuntime() {
    runtimeGeneration++;
    forgetAllSessions();
    await shutdownResources().catch(() => {});
    phase = 'idle';
  }

  function unavailableMessage(state) {
    return state === 'failed' ? FAILED_RUNTIME_MESSAGE : `The agent runtime is ${state}.`;
  }

  function enqueue(task, { recoversFailedRuntime = false } = {}) {
    if (closing || phase === 'closing' || phase === 'closed' || (phase === 'failed' && !recoversFailedRuntime)) {
      return Promise.reject(new Error(unavailableMessage(phase)));
    }
    if (queuedCalls >= MAXIMUM_QUEUED_CALLS) {
      return Promise.reject(new Error('The preview call queue is full. Retry after pending calls finish.'));
    }
    queuedCalls++;
    const result = queue.then(async () => {
      if (phase === 'failed' && recoversFailedRuntime && !closing) await restartFailedRuntime();
      if (closing || phase === 'closed' || phase === 'failed') {
        throw new Error(unavailableMessage(closing ? 'closing' : phase));
      }
      return task();
    });
    queue = result.catch(() => {}).finally(() => {
      queuedCalls--;
    });
    return result;
  }

  // Closing the browser that just timed out can hang as long as its stuck operation does. The scenes are already forgotten, so the
  // teardown does not wait for a browser that will not answer, and the next call launches a fresh one instead of queueing behind it (#2200).
  async function closeBrowserWithinLimit(browser) {
    if (!browser) return;
    let timer;
    const closed = browser.close().catch(() => {});
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS); })]);
    clearTimeout(timer);
  }

  async function shutdownResources() {
    try {
      await closeBrowserWithinLimit(browserInstance);
    } finally {
      browserInstance = undefined;
      page = undefined;
      if (httpServer?.listening) {
        httpServer.closeAllConnections();
        await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      }
      httpServer = undefined;
    }
  }

  // The page shares engine chunks with the package entries, so it asks for them by name next to preview.js.
  function serveEngineChunk(url, response) {
    const chunkDirectory = fileURLToPath(new URL('../', previewUrl));
    readFile(join(chunkDirectory, url.slice(1))).then(bytes => {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  // Only files inside an allowlisted addon's own package folder, found by the index it was given at startup.
  function serveAddonFile(url, response) {
    const path = addonFileFor(addonSet.addons, url.split('?')[0]);
    if (path === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(path).then(bytes => {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  // Loads each allowlisted addon in the page. One that fails is skipped with its reason; the others stay.
  async function loadAddons() {
    for (const [index, addon] of addonSet.addons.entries()) {
      try {
        const added = await page.evaluate(input => window.__agentPreview.loadAddon(input), { url: `/addons/${index}/${addon.entry}`, name: addon.name, extensionPoints: addon.extensionPoints });
        registeredByAddon[addon.name] = added;
      } catch (error) {
        const reason = String(error.message).replace(/^page\.evaluate: /, '').split('\n')[0];
        refusedAddons.push({ name: addon.name, reason });
        console.error(`Crucible addon ${addon.name} skipped: ${reason}`);
      }
    }
  }

  // Mesh booleans load Manifold and recipe physics loads Rapier, both optional peer dependencies, from the host's
  // node_modules. Without one the page gets a 404 and the edit reports the install command.
  function serveVendorFile({ resolve, type }, response) {
    let path;
    try {
      path = resolve(createRequire(import.meta.url));
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(path).then(bytes => {
      response.setHeader('Content-Type', type);
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  // A start that fails on its page load is tried once more on a fresh browser: right after a timeout the old browser may still be
  // dying and hold the card, and the caller would otherwise need several retries before the runtime came back (#2200).
  async function boot() {
    if (page) {
      return;
    }
    try {
      await bootOnce();
    } catch (error) {
      if (closing || !(error?.pageLoadTimeout || /page.goto|Timeout d+ms exceeded/i.test(String(error?.message)))) throw error;
      await bootOnce();
    }
  }

  async function bootOnce() {
    phase = 'starting';
    try {
      const [{ chromium }, code] = await Promise.all([
        import('playwright-core'),
        readFile(previewUrl, 'utf8'),
      ]);
      httpServer = createServer((request, response) => {
        if (!isPreviewHost(request.headers.host, httpServer.address().port)) {
          response.writeHead(403);
          response.end();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET' && request.url === '/vendor/ktx2-worker.js') {
          response.setHeader('Content-Security-Policy', KTX2_WORKER_CSP);
          response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          response.end(KTX2_WORKER_SOURCE);
          return;
        }
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${importMapHash}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self' blob:`);
        if (request.method === 'GET' && request.url.startsWith('/addons/')) {
          serveAddonFile(request.url, response);
          return;
        }
        const vendor = request.method === 'GET' ? VENDOR_FILES[request.url] : undefined;
        if (vendor) {
          serveVendorFile(vendor, response);
          return;
        }
        if (request.method === 'GET' && request.url !== '/preview.js' && ENGINE_CHUNK_URL.test(request.url)) {
          serveEngineChunk(request.url, response);
          return;
        }
        if (request.method !== 'GET' || !['/', '/preview.js'].includes(request.url)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        response.end(request.url === '/' ? pageHtml(importMapScript) : code);
      });
      httpServer.on('upgrade', (request, socket, head) => {
        const accepted = isPreviewHost(request.headers.host, httpServer.address().port)
          && activeFrameReceiver?.handleUpgrade(request, socket, head);
        if (!accepted) socket.destroy();
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
      if (backend === 'cpu') {
        args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
      }
      const launchOptions = { headless: true, args, ...(browserPath ? { executablePath: browserPath } : { channel: 'chrome' }) };
      // The shader cache only helps the GPU backend: the CPU backend compiles in SwiftShader, which has no driver compile to skip.
      const shaderCacheFolder = backend === 'gpu' ? shaderCacheDirectory() : null;
      browserInstance = shaderCacheFolder
        ? await launchWithShaderCache(chromium, launchOptions, shaderCacheFolder, { viewport: { width: 768, height: 512 }, deviceScaleFactor: 1 })
        : await chromium.launch(launchOptions);
      page = await browserInstance.newPage({ viewport: { width: 768, height: 512 }, deviceScaleFactor: 1 });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort();
      });
      page.setDefaultTimeout(15000);
      if (backend === 'gpu') await page.exposeFunction('__crucibleNativeBake', answerNativeBake);
      if (!kernelWorkers) {
        await page.addInitScript(() => { globalThis.__crucibleKernelWorkers = 'off'; });
      }
      // A kernel that fell back to the main thread says so on the page console; keep that note in the server's stderr.
      page.on?.('console', message => {
        if (message.text().startsWith('Crucible kernel fallback')) console.error(message.text());
      });
      await loadPreviewPage(page, origin);
      await loadAddons();
      phase = 'ready';
    } catch (error) {
      // A failed start is not final: the next call boots again, as the job store does after a failed start.
      phase = closing ? 'closing' : 'idle';
      await shutdownResources();
      throw error;
    }
  }

  // The page's bridge to the native tracer for recipe bakes: `probe` says whether it can run, `trace` bakes the texels the page
  // packed. A failure comes back as `{ error }` so the page falls back to its own GPU kernel, and the cause is remembered, so
  // later bakes and render jobs skip the attempt.
  async function answerNativeBake(request) {
    nativeTracerLocator ??= createNativeTracerLocator();
    const found = await nativeTracerLocator.find();
    if (request.action === 'probe') return { available: Boolean(found.tracer) };
    if (!found.tracer) return { error: found.reason };
    try {
      return traceTexelsNative({ tracer: found.tracer, request, maxSeconds: BAKE_WORKER_MAXIMUM_SECONDS });
    } catch (error) {
      if (!isNativeTimeLimitError(error)) nativeTracerLocator.markUnusable(error.message);
      return { error: error.message };
    }
  }

  function lastUsedSessionId() {
    let lastUsed = null;
    for (const sessionId of openSessionIds) lastUsed = sessionId;
    return lastUsed;
  }

  function forgetSession(sessionId) {
    openSessionIds.delete(sessionId);
    bakedSessionIds.delete(sessionId);
  }

  function forgetAllSessions() {
    openSessionIds.clear();
    bakedSessionIds.clear();
  }

  async function resolveSentMarks({ sessionId, frame, marks, image }) {
    const base = { sessionId, revision: frame.metadata.revision, view: annotateViewOf(frame) };
    return { image, content: await sentMarksContent(base, frame.camera, marks, 'while the person marked') };
  }

  function requireSession(sessionId) {
    if (!openSessionIds.has(sessionId)) {
      throw new Error(sessionProblem(sessionId, lastUsedSessionId(), { openSessionIds: [...openSessionIds], evictedSessionIds, evictionReasons }));
    }
    // Re-insert so the Set order stays least to most recently used.
    openSessionIds.delete(sessionId);
    openSessionIds.add(sessionId);
  }

  // The page returns the scenes it closed to make room; the runtime forgets them and remembers why they are gone.
  function registerCreatedScene(sessionId, result, hasBake) {
    for (const evictedSessionId of result.evictedSessions ?? []) {
      forgetSession(evictedSessionId);
      evictedSessionIds.push(evictedSessionId);
      if (result.evictionReason) evictionReasons[evictedSessionId] = result.evictionReason;
    }
    for (const forgottenId of evictedSessionIds.splice(0, Math.max(0, evictedSessionIds.length - MAXIMUM_REMEMBERED_EVICTIONS))) {
      delete evictionReasons[forgottenId];
    }
    openSessionIds.add(sessionId);
    if (hasBake) bakedSessionIds.add(sessionId);
  }

  // Streamed texture sequences: reads the frames a motion time needs from the catalog and sends them to the page, which decodes
  // them and keeps only that time and the one before. A scene without streamed sequences needs none.
  async function supplyStreamedFrames(target, sessionId, motionTime) {
    const missingIds = await target.evaluate(request => window.__agentPreview.sequenceFramesNeeded(request), { sessionId, motionTime });
    if (!missingIds.length) return;
    const entries = await Promise.all(missingIds.map(async id => [id, (await (await catalog()).read(id)).toString('base64')]));
    await target.evaluate(request => window.__agentPreview.loadSequenceFrames(request), { sessionId, motionTime, sequenceData: Object.fromEntries(entries) });
  }

  async function invoke(method, input, timeoutMs = EVALUATION_TIMEOUT_MS) {
    requireSession(input.sessionId);
    if (streamedSequencesUsed && typeof input.motionTime === 'number') await supplyStreamedFrames(page, input.sessionId, input.motionTime);
    if (!browserInstance?.isConnected() || page.isClosed()) {
      phase = 'failed';
      throw new Error(`The preview browser disconnected. ${RECOVERY_HINT}`);
    }
    return evaluate(method, input, page, timeoutMs);
  }

  // Names the call that ran long: its method, and for an edit list the kinds of operation it carried, so the caller knows what to split (#2200).
  function describeOperation(method, input) {
    const kinds = Array.isArray(input?.operations) ? [...new Set(input.operations.map(operation => operation?.type).filter(Boolean))] : [];
    return kinds.length ? `"${method}" (${input.operations.length} operations: ${kinds.join(', ')})` : `"${method}"`;
  }

  async function evaluate(method, input, target = page, timeoutMs = EVALUATION_TIMEOUT_MS) {
    assertCombinedAssetBytes(input);
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([
        target.evaluate(({ method, input }) => window.__agentPreview[method](input), { method, input }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            if (target === page) phase = 'failed';
            reject(new Error(target === page
              ? `The preview operation ${describeOperation(method, input)} exceeded ${timeoutMs / 1000} seconds. ${RECOVERY_HINT}`
              : `The private render operation ${describeOperation(method, input)} exceeded ${timeoutMs / 1000} seconds.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        if (target === page) {
          forgetAllSessions();
          await shutdownResources();
        } else {
          await target.close();
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runJob({ jobId, sessionId, directory, snapshot, settings, signal, progress, startRenderClock = () => {} }) {
    let jobPage;
    let jobFailed = false;
    let session;
    let encoder;
    let frameReceiver;
    // A stills or video job of native frames renders them all through one session; it is closed when the job ends.
    let nativeSequence;
    // The tables of the last native export of this job, so a frame reads only the byte ranges that changed since (#1861).
    const nativeExportBaseline = {};
    // A native video job blends each frame into the ones before it, so the noise the denoiser leaves does not shimmer.
    let nativeTemporal;
    let nativeTemporalShotIndex;
    let pageEncodes = false;
    let suspended = false;
    // The frame being rendered, so a browser that dies mid-job is reported with where it died (#2018).
    let frameIndex = -1;
    let browserLossFailure;
    const generationAtStart = runtimeGeneration;
    const started = performance.now();
    // One job runs at a time, so the estimate made at submission belongs to the job that starts next.
    const estimate = estimateForNextJob;
    estimateForNextJob = undefined;
    const metrics = { backend, memoryBudgetMiB: memory, maximumMemoryMiB: maximumMemory, requestedWidth: settings.width, requestedHeight: settings.height,
      renderSeconds: 0, captureSeconds: 0, peakNodeBytes: 0, peakBrowserHeap: 0, maximumPendingFrames: 1 };
    async function recordPeakMemory() {
      metrics.peakNodeBytes = Math.max(metrics.peakNodeBytes, process.memoryUsage().rss);
      metrics.peakBrowserHeap = Math.max(metrics.peakBrowserHeap, await sampleBrowserHeap(session, memoryGuardLimits(memory).browserHeapBytes));
      const sample = { nodeBytes: metrics.peakNodeBytes, browserHeapBytes: metrics.peakBrowserHeap, nativeAllowanceBytes: nativeMemoryAllowance.bytes, memoryMiB: memory };
      if (exceedsMemoryGuard(sample)) {
        throw new Error(memoryGuardMessage({ subject: 'Render job', ...sample, maximumMemoryMiB: maximumMemory }));
      }
    }
    const abort = () => { jobPage?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await assertSceneFitsBeforeJob(snapshot.recipe);
      await enqueue(async () => {
        await invoke('suspend', { sessionId }, PAGE_HANDOFF_TIMEOUT_MS);
        suspended = true;
      });
      // The wait behind other calls and the handoff of the scene page are over: from here the deadline counts render time only (#1256).
      startRenderClock();
      signal.throwIfAborted();
      jobPage = await browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 });
      signal.throwIfAborted();
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      await jobPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      jobPage.setDefaultTimeout(15000);
      await loadPreviewPage(jobPage, origin);
      if (settings.kind === 'icons') {
        // Each icon is its own scene, created and disposed inside the job, so the shared dispose below has nothing left to release.
        const icons = await renderIconsInPage({ jobPage, jobId, settings, directory, signal, progress, assetData: placedAssetData, memoryBudgetMiB: memory, backend, tier: settings.quality });
        metrics.renderSeconds = (performance.now() - started) / 1000;
        metrics.elapsedSeconds = metrics.renderSeconds;
        return { artifacts: icons.artifacts, metrics: { ...metrics, ...icons.metrics } };
      }
      const needsRgba = Boolean(settings.renderer || snapshot.recipe?.bake);
      const input = { sessionId: jobId, recipe: snapshot.recipe, memoryBudgetMiB: memory, backend, ...(settings.transparent ? { transparent: true } : {}), ...(settings.quality ? { tier: settings.quality } : {}),
        ...(snapshot.assetBytes ? { data: snapshot.assetBytes.toString('base64'), ...(await motionSources([snapshot.recipe.motion])) } : await placedAssetData(snapshot.recipe, { transcodeKtx2: needsRgba })) };
      const created = await jobPage.evaluate(({ method, input }) => window.__agentPreview[method](input),
        { method: snapshot.assetBytes ? 'createAsset' : 'create', input });
      // The plan made at creation sees the requested size; later plans see the viewport already cut to the budget.
      metrics.requiredMemoryMiB = created.render.requiredMemoryMiB;
      const width = settings.kind === 'video' ? Math.floor(created.render.width / 2) * 2 : created.render.width;
      const height = settings.kind === 'video' ? Math.floor(created.render.height / 2) * 2 : created.render.height;
      if (width < 64 || height < 64) throw new Error('Render budget reduced the job below its minimum output size.');
      const oversizeError = oversizeFrameBudgetError({ requested: { width: settings.width, height: settings.height }, rendered: { width, height },
        plan: created.render, memoryMiB: memory, maximumMemoryMiB: maximumMemory });
      if (oversizeError) throw oversizeError;
      await jobPage.setViewportSize({ width, height });
      session = await jobPage.context().newCDPSession(jobPage);
      const region = settings.region;
      if ((settings.format && settings.format !== 'png') || settings.mattes) await jobPage.evaluate(prepareInput => window.__agentPreview.prepareFloatOutput(prepareInput), { sessionId: jobId });
      if (settings.passes?.includes('wireframe')) await jobPage.evaluate(prepareInput => window.__agentPreview.prepareWireframe(prepareInput), { sessionId: jobId });
      // A memory budget can shrink the frame below the size the region was chosen for.
      if (region && (region.x + region.width > width || region.y + region.height > height)) {
        throw new Error(`The region lies outside the rendered frame, which the memory budget reduced to ${width}x${height}.`);
      }
      const frameByteLimit = frameByteLimitFor(settings.width, settings.height, MAXIMUM_JOB_FRAME_BYTES);
      const outputWidth = region?.width ?? width;
      const outputHeight = region?.height ?? height;
      const format = settings.format ?? 'png';
      const highPrecision = format !== 'png';
      const artifactExtension = format === 'exr' ? 'exr' : 'png';
      const artifactMimeType = format === 'exr' ? 'image/x-exr' : 'image/png';
      // A transparent canvas shows the page behind it in a screenshot, so the page and the browser's default are made clear.
      if (settings.transparent) {
        await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        await jobPage.evaluate(() => {
          document.documentElement.style.background = 'transparent';
          document.body.style.background = 'transparent';
        });
      }
      const artifacts = [];
      const timeline = settings.timeline ? snapshot.recipe.timeline : undefined;
      const audio = settings.audio ? await prepareAudio(settings) : undefined;
      if (settings.kind === 'video') {
        // With NVENC the page encodes each frame in the browser and sends only the H.264 chunks over a socket on the
        // preview's own port (issue #301). Otherwise, or when the browser cannot encode this size, frames are screenshots.
        frameReceiver = createFrameReceiver({ maximumBytes: width * height * 4 });
        activeFrameReceiver = frameReceiver;
        const frameSocketUrl = `ws://127.0.0.1:${httpServer.address().port}${frameReceiver.path}`;
        // A path traced frame is a PNG made outside the page's drawing buffer, so the browser encoder has nothing to encode.
        if (settings.encoder === 'nvenc' && !settings.renderer && !region) {
          const pageEncoder = await startVideoEncoderInPage(jobPage, frameSocketUrl,
            { width, height, fps: settings.fps, quantizer: DEFAULT_PAGE_ENCODER_QUANTIZER });
          pageEncodes = pageEncoder.supported;
        }
        encoder = createFrameEncoder({ executable: ffmpeg, output: join(directory, 'render.mp4.partial'),
          fps: settings.fps, format: pageEncodes ? 'h264' : settings.renderer ? 'png' : 'jpeg', width: outputWidth, height: outputHeight, signal, maximumFrameBytes: MAXIMUM_JOB_FRAME_BYTES, backend: settings.encoder === 'nvenc' ? 'gpu' : 'cpu',
          audioArguments: settings.audio ? audioInputArguments(audio.path, settings.audio.offset) : [],
          audioCodec: settings.audio?.track === 'pcm' ? 'pcm' : 'aac', frameCount: settings.frameCount });
        if (pageEncodes) frameReceiver.onChunk(chunk => encoder.writeChunk(chunk));
        metrics.videoEncoder = pageEncodes ? 'browser-h264' : settings.encoder === 'nvenc' ? 'h264_nvenc' : 'libx264';
      }
      if (timeline) metrics.shots = filmTimelineShotStarts(timeline);
      const streamedJob = hasStreamedSequence(snapshot.recipe);
      if (streamedJob && settings.renderer) {
        throw new Error(`A material map.sequence of more than ${TEXTURE_SEQUENCE_LIMITS.wholeSequenceFrames} frames streams its frames and is drawn by the raster renderer only. Remove settings.renderer, or pass a sequence of at most ${TEXTURE_SEQUENCE_LIMITS.wholeSequenceFrames} frames for a path traced job.`);
      }
      for (let frame = 0; frame < settings.frameCount; frame++) {
        signal.throwIfAborted();
        frameIndex = frame;
        const elapsed = settings.kind === 'video' ? frame / settings.fps
          : settings.kind === 'stills' ? (settings.stillCount ? frame / settings.fps : settings.duration * frame / (settings.frameCount - 1)) : 0;
        // A timeline job reads one clock for the shot, the motion and the renderer, so a seek matches the frame in a video.
        const timelineTime = timeline ? Math.min(filmTimelineDuration(timeline), settings.timeline.start + elapsed) : undefined;
        const shotSample = timeline ? sampleFilmTimeline(timeline, snapshot.recipe, timelineTime) : undefined;
        const frameInput = { sessionId: jobId, ...(highPrecision ? { floatOutput: true } : {}),
          rendererTime: (settings.rendererTime?.start ?? 0) + (timelineTime ?? elapsed) * (settings.rendererTime?.rate ?? 1),
          ...(settings.motion ? { motionTime: settings.motion.start + elapsed } : {}),
          ...(shotSample?.motionTime == null ? {} : { motionTime: shotSample.motionTime }),
          ...(shotSample?.camera ? { camera: shotSample.camera } : {}),
          ...(shotSample?.depthOfField ? { depthOfField: shotSample.depthOfField } : {}),
          ...(shotSample && shotSample.brightness < 1 ? { brightness: shotSample.brightness } : {}),
          ...(settings.animation ? { animation: { clip: settings.animation.clip, time: settings.animation.start + elapsed } } : {}) };
        const renderStarted = performance.now();
        if (streamedJob && frameInput.motionTime !== undefined) await supplyStreamedFrames(jobPage, jobId, frameInput.motionTime);
        if (settings.renderer) {
          const { type, ...tracerOptions } = settings.renderer;
          requireTracerBackendAvailable(settings.renderer, backend);
          nativeTracerLocator ??= createNativeTracerLocator();
          const trace = await chooseTraceBackend({ requested: settings.renderer.backend, runtimeBackend: backend, locator: nativeTracerLocator });
          // denoise true means OIDN on every backend when its package is installed; native differs only in its fallback filter.
          const keepWavelet = settings.quality === 'final';
          let choice = await chooseDenoiser(settings.renderer.denoise, { native: trace.backend === 'native', keepWavelet });
          const traceOptions = { width, height, ...tracerOptions, backend: trace.backend === 'native' ? 'gpu' : trace.backend, denoise: choice.denoise, threads: PATH_TRACER_THREADS };
          let traced;
          let backendNote = trace.note;
          let fallbackReason = trace.reason;
          if (trace.backend === 'native') {
            let exportedScene = false;
            nativeMemoryAllowance.grantForFrame({ width, height, memoryMiB: memory });
            const usesSession = settings.frameCount > 1 && process.env.JS67_NATIVE_SESSIONS !== 'off';
            // Only a video blends over time: the stills of one job are separate pictures, and each must stand alone.
            const blendsOverTime = usesSession && settings.kind === 'video' && chooseNativeKernel() === 'cycles' && chooseNativeTemporal();
            const frameSeed = blendsOverTime ? temporalFrameSeed(tracerOptions.seed, frame) : tracerOptions.seed;
            try {
              const exported = await fetchNativeExport(jobPage, { ...frameInput, options: { width, height, bounces: tracerOptions.bounces, seed: frameSeed, fireflyClamp: 20, noiseThreshold: tracerOptions.noiseThreshold, samples: tracerOptions.samples, instancing: chooseNativeInstancing(), kernel: chooseNativeKernel() } }, { capacity: readNativeCapacity(trace.tracer).capacity, session, baseline: usesSession ? nativeExportBaseline : undefined });
              exportedScene = true;
              if (usesSession) nativeSequence ??= createNativeSequence({ tracer: trace.tracer });
              if (blendsOverTime) {
                nativeTemporal ??= createTemporalAccumulator({ width, height });
                if (shotSample && shotSample.shotIndex !== nativeTemporalShotIndex) nativeTemporal.restart('a new shot began');
                nativeTemporalShotIndex = shotSample?.shotIndex;
              }
              traced = await traceFrameNative({ tracer: trace.tracer, sequence: nativeSequence, temporal: nativeTemporal, exported, width, height, samples: tracerOptions.samples, bounces: tracerOptions.bounces,
                seed: frameSeed, denoise: choice.denoise === false ? 'none' : choice.denoise, denoiser: choice.denoiser,
                maxSeconds: tracerOptions.maxSeconds, noiseThreshold: tracerOptions.noiseThreshold, exposure: snapshot.recipe.effects?.exposure ?? 1 });
              nativeMemoryAllowance.grantForAdapter(traced.report.gpu);
            } catch (error) {
              // Past maxSeconds the job fails as it does on every backend; falling back would only run it twice as long.
              if (isNativeTimeLimitError(error)) throw error;
              // A scene over the adapter capacity fails the job with its own message; the gpu backend is not tried instead.
              if (error.nativeCapacity) throw error;
              nativeSequence?.close();
              nativeSequence = undefined;
              nativeTemporal?.restart('a frame rendered on another backend');
              // Only a tracer or adapter failure makes the tracer unusable; a scene that failed to export says so for this job alone.
              if (exportedScene) nativeTracerLocator.markUnusable(error.message);
              fallbackReason = exportedScene ? (await nativeTracerLocator.find()).reason : `renderer.backend "native" could not export the scene (${error.message}).`;
              backendNote = fallbackReason;
              traceOptions.backend = backend === 'cpu' ? 'cpu' : 'gpu';
              choice = await chooseDenoiser(settings.renderer.denoise, { keepWavelet });
              traceOptions.denoise = choice.denoise;
              backendNote += ' The ' + traceOptions.backend + ' backend ran instead.';
            }
          }
          const fallback = backendFallbackForFrame({ requestedBackend: settings.renderer.backend, tracedNatively: Boolean(traced), usedBackend: traceOptions.backend, fallbackReason });
          if (!traced) {
            try {
              traced = await jobPage.evaluate(input => window.__agentPreview.pathTrace(input), { ...frameInput, options: traceOptions });
            } catch (error) {
              throw explainFailureAfterFallback(error, fallback);
            }
            if (traced.features) {
              traced = await finishWithOidn({ traced, denoiser: choice.denoiser, drawLinear: input => jobPage.evaluate(drawInput => window.__agentPreview.finishPathTrace(drawInput), input) });
            }
          }
          if (backendNote) traced.report.backendNote = backendNote;
          if (fallback) traced.report.backendFallback = fallback;
          const denoiserNote = [choice.note, traced.report.denoiserNote].filter(Boolean).join(' ');
          if (denoiserNote) traced.report.denoiserNote = denoiserNote;
          metrics.renderSeconds += (performance.now() - renderStarted) / 1000;
          metrics.width = width;
          metrics.height = height;
          metrics.pathTracer = traced.report;
          const kernelCompile = addKernelCompile(metrics.kernelCompile, traced.report);
          if (kernelCompile) metrics.kernelCompile = kernelCompile;
          if (frame === 0) {
            const looked = await jobPage.evaluate(input => window.__agentPreview.findings(input), frameInput);
            mergeFrameDiagnostics(metrics, [pathTracerFindingsLimit(), pathTracerSkippedPassesWarning(snapshot.recipe.postPasses), ...looked.diagnostics].filter(Boolean));
          }
          if (traced.report.nativeSession) (metrics.nativeSessionRoutes ??= []).push(traced.report.nativeSession.path);
          const tracedBytes = Buffer.from(traced.data, 'base64');
          if (tracedBytes.length > frameByteLimit) throw new Error(`Path traced frame exceeded ${frameByteLimit / 1024 ** 2} MiB.`);
          if (encoder) {
            await encoder.writeFrame(tracedBytes);
          } else {
            const filename = settings.kind === 'image' ? 'render.png' : `frame-${frame}.png`;
            await writeFile(join(directory, `${filename}.partial`), tracedBytes, { flag: 'wx' });
            artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
          }
          await recordPeakMemory();
          await progress({ frames: frame + 1, maximumPendingFrames: 1 });
          continue;
        }
        // A video frame is read in the same task as its draw, because the browser clears the drawing buffer after presenting.
        const rendered = await jobPage.evaluate(async ({ input, encodeIndex }) => {
          const drawStarted = performance.now();
          const result = await window.__agentPreview.frame(input);
          if (encodeIndex === null) return result;
          window.__finishDraw();
          const drawMilliseconds = performance.now() - drawStarted;
          return { ...result, drawMilliseconds, pageEncoded: await window.__encodeFrame(encodeIndex) };
        }, { input: { ...frameInput, diagnose: frame === 0 }, encodeIndex: pageEncodes ? frame : null });
        const roundTripSeconds = (performance.now() - renderStarted) / 1000;
        const drawSeconds = rendered.pageEncoded ? rendered.drawMilliseconds / 1000 : roundTripSeconds;
        metrics.renderSeconds += drawSeconds;
        metrics.captureSeconds += roundTripSeconds - drawSeconds;
        if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU job did not select SwiftShader.');
        metrics.graphics = rendered.graphics;
        metrics.width = width;
        metrics.height = height;
        metrics.estimatedBytes = rendered.estimatedBytes;
        mergeFrameDiagnostics(metrics, rendered.diagnostics);
        async function captureFrameBytes() {
          if (rendered.pageEncoded) {
            signal.throwIfAborted();
            return undefined;
          }
          const captureStarted = performance.now();
          const captured = await session.send('Page.captureScreenshot', { fromSurface: true,
            format: settings.kind === 'video' ? 'jpeg' : 'png',
            clip: captureClip({ region, width, height }), captureBeyondViewport: true,
            ...(settings.kind === 'video' ? { quality: 95 } : { optimizeForSpeed: true }) });
          const captureBytes = Buffer.from(captured.data, 'base64');
          if (settings.kind !== 'video') assertCapturedPngSize({ bytes: captureBytes, width: outputWidth, height: outputHeight });
          metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
          if (captureBytes.length > frameByteLimit) throw new Error(`Captured job frame exceeded ${frameByteLimit / 1024 ** 2} MiB.`);
          signal.throwIfAborted();
          return captureBytes;
        }
        // 16-bit PNG and EXR come from a float readback of the same frame (or of its pass), encoded here.
        async function readFloatPass(pass) {
          const read = await jobPage.evaluate(readInput => window.__agentPreview.readFloat(readInput),
            { sessionId: jobId, source: pass ? 'pass' : 'frame', ...(region ? { region } : {}) });
          const readBytes = Buffer.from(read.data, 'base64');
          const pixels = new Float32Array(readBytes.buffer.slice(readBytes.byteOffset, readBytes.byteOffset + readBytes.length));
          return { pixels, width: read.width, height: read.height };
        }
        async function captureHighPrecisionBytes(pass) {
          const captureStarted = performance.now();
          const read = await jobPage.evaluate(readInput => window.__agentPreview.readFloat(readInput),
            { sessionId: jobId, source: pass ? 'pass' : 'frame', ...(region ? { region } : {}) });
          const readBytes = Buffer.from(read.data, 'base64');
          const pixels = new Float32Array(readBytes.buffer.slice(readBytes.byteOffset, readBytes.byteOffset + readBytes.length));
          const encodedBytes = encodeRenderOutput({ format, pixels, width: read.width, height: read.height, pass,
            hasAlpha: settings.transparent === true, depthRange: RENDER_PASS_DEPTH_RANGE });
          metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
          if (encodedBytes.length > frameByteLimit * HIGH_PRECISION_FRAME_FACTOR) throw new Error('Rendered frame exceeded the high-precision size limit.');
          signal.throwIfAborted();
          return encodedBytes;
        }
        async function writeArtifact(filename, artifactBytes) {
          await writeFile(join(directory, `${filename}.partial`), artifactBytes, { flag: 'wx' });
          artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: artifactMimeType });
        }
        const bytes = settings.multilayer ? undefined : (highPrecision ? await captureHighPrecisionBytes(undefined) : await captureFrameBytes());
        if (encoder) {
          if (bytes) await encoder.writeFrame(bytes);
        }
        else {
          const stem = settings.kind === 'image' ? 'render' : `frame-${frame}`;
          if (settings.multilayer) {
            const captureStarted = performance.now();
            const beautyRead = await readFloatPass(undefined);
            const passPixels = {};
            for (const pass of settings.passes ?? []) {
              const passInfo = await jobPage.evaluate(input => window.__agentPreview.frame(input),
                { ...frameInput, floatOutput: false, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE, passFloat: true });
              passPixels[pass] = (await readFloatPass(pass)).pixels;
              if (pass === 'depth') metrics.depthRangeMetres = RENDER_PASS_DEPTH_RANGE;
              if (pass === 'objectId') {
                Object.assign(metrics, objectIdMetrics(passInfo));
              }
              if (pass === 'cryptomatte') metrics.cryptomatte = passInfo.cryptomatte;
              if (pass === 'wireframe') metrics.wireframe = passInfo.wireframe;
            }
            const encodedBytes = encodeMultilayerExr({ width: beautyRead.width, height: beautyRead.height, beauty: beautyRead.pixels, passes: passPixels, hasAlpha: settings.transparent === true, depthRange: RENDER_PASS_DEPTH_RANGE });
            metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
            if (encodedBytes.length > frameByteLimit * HIGH_PRECISION_FRAME_FACTOR) throw new Error('Rendered frame exceeded the high-precision size limit.');
            await writeArtifact(`${stem}.exr`, encodedBytes);
          } else {
          await writeArtifact(`${stem}.${artifactExtension}`, bytes);
          // Passes follow the lit image of the same instant, so each seek yields every file for that frame.
          for (const pass of settings.passes ?? []) {
            const passInfo = await jobPage.evaluate(input => window.__agentPreview.frame(input),
              { ...frameInput, floatOutput: false, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE, ...(highPrecision ? { passFloat: true } : {}) });
            await writeArtifact(`${stem}-${pass}.${artifactExtension}`, highPrecision ? await captureHighPrecisionBytes(pass) : await captureFrameBytes());
            if (pass === 'cryptomatte') metrics.cryptomatte = passInfo.cryptomatte;
            if (pass === 'wireframe') metrics.wireframe = passInfo.wireframe;
            if (pass === 'depth') metrics.depthRangeMetres = RENDER_PASS_DEPTH_RANGE;
            if (pass === 'objectId') {
              Object.assign(metrics, objectIdMetrics(passInfo));
            }
          }
          if (settings.mattes) {
            const mattes = await renderJobMattes({ mattes: settings.mattes, renderPass: async pass => {
              const info = await jobPage.evaluate(input => window.__agentPreview.frame(input),
                { ...frameInput, floatOutput: false, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE, passFloat: true });
              return { info, ...(await readFloatPass(pass)) };
            } });
            for (const [index, matte] of mattes.entries()) await writeArtifact(`${stem}-matte-${index}.png`, matte.bytes);
            metrics.mattes = mattes.map(matte => matte.metric);
          }
        }
          }
        await recordPeakMemory();
        await progress({ frames: frame + 1, maximumPendingFrames: 1 });
      }
      if (encoder) {
        if (pageEncodes) await jobPage.evaluate(() => window.__finishVideoEncoder());
        metrics.encoder = await encoder.finish();
        if (audio) metrics.sync = await measureSync(join(directory, 'render.mp4.partial'));
        artifacts.push({ temporary: 'render.mp4.partial', filename: 'render.mp4', mimeType: 'video/mp4' });
      }
      metrics.elapsedSeconds = (performance.now() - started) / 1000;
      metrics.report = renderReport({ estimate, settings, metrics });
      if (settings.renderer?.backend === 'gpu') gpuTracerWarm = true;
      await rememberRenderJob({ settings, estimate, report: metrics.report, ranSize: { width, height } });
      return { artifacts, metrics };
    } catch (error) {
      jobFailed = true;
      if (signal.aborted || !isBrowserLoss(error)) throw error;
      browserLossFailure = describeBrowserLoss({ error, frameIndex, frameCount: settings.frameCount, width: settings.width, height: settings.height, passes: settings.passes, memoryMiB: memory, estimatedPeakMemoryMiB: estimate?.peakMemoryMiB });
      throw browserLossFailure;
    } finally {
      signal.removeEventListener('abort', abort);
      nativeSequence?.close();
      activeFrameReceiver = undefined;
      frameReceiver?.close();
      try { await encoder?.close(); }
      finally {
        try {
          if (jobPage && !jobPage.isClosed()) {
            // After a failed job the dispose may fail too: a page whose create failed answers "No scene is active", a crashed or navigated page has no bridge ("reading 'dispose'").
            // The close below frees the page, and the failure that matters is the job's own, never this cleanup's (#2198).
            try { if (settings.kind !== 'icons') await jobPage.evaluate(sessionId => window.__agentPreview.dispose({ sessionId }), jobId).catch(error => { if (!jobFailed && !browserLossFailure && !isBrowserLoss(error)) throw error; }); }
            finally { await jobPage.close().catch(error => { if (!browserLossFailure && !isBrowserLoss(error)) throw error; }); }
          }
        }
        finally {
          if (generationAtStart !== runtimeGeneration) {
            // The runtime restarted while this job unwound: its scene is gone and the new runtime owns the phase.
          } else if (suspended && !closing) {
            try {
              await enqueue(() => invoke('resume', { sessionId }, PAGE_HANDOFF_TIMEOUT_MS));
              phase = 'ready';
            } catch (error) {
              phase = 'failed';
              throw browserLossFailure ?? new Error(`Preview recovery failed after render job: ${error.message}`);
            }
          } else if (!closing && phase !== 'failed') phase = 'ready';
        }
      }
    }
  }

  // The audio must cover the video from its offset, or ffmpeg would cut the picture short at the end of the sound.
  async function prepareAudio(settings) {
    if (!audioLibrary) throw new Error('Configure --audio with an absolute folder before rendering audio.');
    const path = await audioLibrary.resolve(settings.audio.file);
    const fileSeconds = await measureStreamSeconds(ffmpeg, path, 'audio');
    const videoSeconds = settings.frameCount / settings.fps;
    const availableSeconds = assertAudioCoversVideo(fileSeconds, settings.audio.offset, videoSeconds);
    return { path, availableSeconds };
  }

  // Decodes both streams of the finished file; a gap beyond the encoder delay means picture and sound drifted apart.
  async function measureSync(path) {
    const videoSeconds = await measureStreamSeconds(ffmpeg, path, 'video', { format: 'mp4' });
    const audioSeconds = await measureStreamSeconds(ffmpeg, path, 'audio', { format: 'mp4' });
    const differenceSeconds = audioSeconds - videoSeconds;
    if (Math.abs(differenceSeconds) > SYNC_TOLERANCE_SECONDS) {
      throw new Error(`Audio and video lengths differ by ${(differenceSeconds * 1000).toFixed(0)} ms.`);
    }
    return { videoSeconds, audioSeconds, differenceSeconds, toleranceSeconds: SYNC_TOLERANCE_SECONDS };
  }

  return Object.freeze({
    async capabilities() {
      const deviceTiers = async () => {
        nativeTracerLocator ??= createNativeTracerLocator();
        return tierReport({ backend, nativeTracer: Boolean((await nativeTracerLocator.find()).tracer) });
      };
      return {
        scene: { ...AGENT_SCENE_CAPABILITIES, game: GAME_CAPABILITIES, postPasses: USER_PASS_CAPABILITIES, meshBlend: MESH_BLEND_CAPABILITIES, materialSnippet: MATERIAL_SNIPPET_CAPABILITIES, vegetation: VEGETATION_CAPABILITY_NOTE, treeGrowth: TREE_GROWTH_CAPABILITIES, clutter: CLUTTER_CAPABILITY_NOTE, grass: GRASS_CAPABILITY_NOTE, fitLook: FIT_LOOK_CAPABILITY_NOTE, crowd: CROWD_CAPABILITY_NOTE, settle: SETTLE_CAPABILITY_NOTE, applyOperations: FOLDED_APPLY_OPERATION_NOTES, textureSequence: TEXTURE_SEQUENCE_CAPABILITIES, textureSet: TEXTURE_SET_CAPABILITIES },
        sceneLimits: SCENE_LIMITS,
        preview: { backend, memoryBudgetMiB: memory, maximumWidth: 1024, maximumHeight: 1024, maximumImageBytes: MAXIMUM_IMAGE_BYTES, maximumActiveScenes: SCENE_STORE_LIMITS.maxOpenScenes, maximumOpenSceneBytes: SCENE_STORE_LIMITS.maxOpenSceneBytes, maximumQueuedCalls: MAXIMUM_QUEUED_CALLS, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS },
        review: { ...REVIEW_LIMITS, backend, memoryBudgetMiB: memory, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
          totalTimeoutMs: EVALUATION_TIMEOUT_MS,
          sourcePreserved: true, defaultMotionTime: null, defaultRendererTime: 0, branches: BRANCH_LIMITS },
        wedge: { ...WEDGE_LIMITS, usage: 'scene_review with wedge {target, parameter, values} instead of shots. target: environment, effects, shadow or a material ID. parameter: a field name or path such as roughness, lightDirection, keyIntensity, fogDensity or pointLights.0.intensity. values: 2 to 8 JSON values as scene_apply takes them. shots may hold one shot for the shared camera and motionTime.', backend, memoryBudgetMiB: memory },
        phase: closing && phase !== 'closed' ? 'closing' : phase,
        availableIn: packageMetadata.version,
        assets: {
          configured: Boolean(assetRoot), formats: ['self-contained GLB', 'PNG, JPEG or WebP image (map sequence frame)'],
          maximumBytes: AGENT_ASSET_LIMITS.maxBytes, maximumAssets: AGENT_ASSET_LIMITS.maxAssets, maximumCombinedBytes: AGENT_ASSET_LIMITS.maxCombinedBytes,
          maximumVertices: AGENT_ASSET_LIMITS.maxVertices, maximumParts: AGENT_ASSET_LIMITS.maxParts, maximumTexturePixels: AGENT_ASSET_LIMITS.maxTexturePixels,
          maximumJoints: AGENT_ASSET_LIMITS.maxJoints, maximumClips: AGENT_ASSET_LIMITS.maxClips,
          meshChecks: `scene_create_asset checkMesh: true adds assetWarnings to the result: per mesh, the triangles that repeat an earlier one and the edges more than two triangles share, judged by position. A mesh over ${MAX_CHECKED_TRIANGLES} triangles skips the counts and says so. Nothing is merged or rewritten. A full glTF-Validator run needs a validator, which is code, so it is not offered here.`,
          commands: ['set-root', 'set-asset-node', 'set-motion', 'set-animation', 'set-material', 'set-camera', 'set-environment', 'set-effects', 'set-shadow'],
        },
        packs: {
          configured: Boolean(packsRoot), format: 'crucible.pack', manifest: 'crucible-pack.json', contentKinds: Object.keys(PACK_CONTENT_KINDS),
          extensions: PACK_CONTENT_KINDS, maximumPacks: MAXIMUM_INSTALLED_PACKS, maximumFiles: MAXIMUM_PACK_FILES, maximumBytes: MAXIMUM_PACK_BYTES,
          maximumFileBytes: MAXIMUM_PACK_FILE_BYTES, maximumJsonBytes: MAXIMUM_PACK_JSON_BYTES, maximumItemsPerKind: MAXIMUM_PACK_ITEMS_PER_KIND,
          vegetationScans: (await vegetationScans()) ? 'on: trees draw scanned bark and leaves' : 'off: trees draw procedural bark and leaves; install the vegetation-scans pack for scans',
          use: 'scene_asset_catalog lists packs: name, version, license, author, description and item ids. GLBs, images, looks and environments carry assetId values that work in scene_create_asset, look, hdri and texture fields. Materials and recipes are read with scene_asset_catalog { pack, material } or { pack, recipe }: pass a recipe to scene_create, and a material as a materials entry or a scene_apply set-material. Packs are installed by the user (crucible packs add <name>, or unzip into the packs folder); crucible-mcp reads ~/.crucible/packs unless --packs names another folder, and a tool call never downloads one. Invalid packs are skipped and listed under packs.rejected with the reason.',
        },
        jobs: { configured: Boolean(jobRoot), kinds: ['image', 'stills', 'video', 'icons'], icons: ICON_CAPABILITIES, passes: RENDER_PASS_NAMES, pathTracer: PATH_TRACER_CAPABILITIES, maximumActiveJobs: 1, estimate: RENDER_ESTIMATE_NOTE, budget: RENDER_BUDGET_NOTE, quality: RENDER_QUALITY_NOTE, tiers: await deviceTiers(),
          maximumWidth: MAXIMUM_JOB_SIDE, maximumHeight: MAXIMUM_JOB_SIDE, maximumPixels: MAXIMUM_JOB_PIXELS, maximumSequenceWidth: MAXIMUM_SEQUENCE_JOB_SIDE, maximumSequenceHeight: MAXIMUM_SEQUENCE_JOB_SIDE, maximumSequencePixels: MAXIMUM_SEQUENCE_JOB_PIXELS, maximumSquareSide: MAXIMUM_SQUARE_JOB_SIDE, maximumSquareSequenceSide: MAXIMUM_SQUARE_SEQUENCE_JOB_SIDE,
          maximumDuration: MAXIMUM_VIDEO_SECONDS, maximumFps: MAXIMUM_JOB_FPS, maximumFrames: MAXIMUM_JOB_FRAMES, maximumStills: 8, maximumStillCount: MAXIMUM_STILLS_FRAMES, maximumOutputBytes: MAXIMUM_JOB_OUTPUT_BYTES, maximumFrameBytes: MAXIMUM_JOB_FRAME_BYTES, stillCountNote: 'a stills job with stillCount (2 to maximumStillCount) and fps writes frame-0.png and on, one per 1 / fps s of the motion clock from motion.start; with transparent each is RGBA. Without stillCount it is 8 spread over duration.',
          encoder: 'H.264', encoders: VIDEO_ENCODERS, audio: Boolean(audioRoot), timeline: true, previewSuspendedDuringJob: true,
          glbExport: { maximumBytes: MAXIMUM_GLB_BYTES, maximumKept: MAXIMUM_KEPT_GLBS, maximumTextureSize: 4096 },
          ...(await jobRecords()) },
        export: GLB_EXPORT_NOTES,
        addons: addonCapabilities({ addons: addonSet.addons.filter(addon => !refusedAddons.some(refused => refused.name === addon.name)), skipped: addonSet.skipped, registered: registeredByAddon, refused: refusedAddons }),
        unsupported: ['remote asset providers', 'arbitrary code execution', 'imported morph track authoring'],
      };
    },
    create({ recipe }) {
      const createScene = () => enqueue(async () => {
        await requirePreviewRenderer();
        await pinNamedAssets(recipe);
        await boot();
        const sessionId = randomUUID();
        const createInput ={ recipe, sessionId, memoryBudgetMiB: memory, backend, ...(await placedAssetData(recipe, { transcodeKtx2: Boolean(recipe?.bake) })) };
        const createTimeoutMs = previewCallTimeoutMs({ bakes: Boolean(recipe?.bake), addsGridVolume: recipeHasGridVolume(recipe), plainTimeoutMs: EVALUATION_TIMEOUT_MS, bakeTimeoutMs: BAKE_EVALUATION_TIMEOUT_MS, assetBytes: assetDataBytes(createInput.assetData) });
        const result = await evaluate('create', createInput, page, createTimeoutMs).catch(async error => {
          if (error?.message?.startsWith('The preview operation')) error.message += slowAssetsNote(await placedAssetSizes(recipe));
          throw error;
        });
        registerCreatedScene(sessionId, result, Boolean(recipe?.bake));
        return result;
      }, { recoversFailedRuntime: true });
      return recipe?.bake ? gpuUnit('heavy', createScene) : createScene();
    },
    /** The catalog with the installed packs; `{ pack, recipe }` or `{ pack, material }` reads one pack item's JSON instead. */
    assetCatalog({ pack, recipe, material } = {}) {
      return enqueue(async () => {
        if (pack !== undefined || recipe !== undefined || material !== undefined) {
          if (!packsRoot) throw new Error('Configure --packs with an absolute directory to read pack items.');
          if (pack === undefined || (recipe === undefined) === (material === undefined)) {
            throw new RangeError('Pass pack with exactly one of recipe or material, such as { "pack": "example-starter", "recipe": "workshop" }; scene_asset_catalog without arguments lists them.');
          }
          const kind = recipe === undefined ? 'materials' : 'recipes';
          return { pack, [kind === 'recipes' ? 'recipe' : 'material']: recipe ?? material, json: (await packs()).read(kind, pack, recipe ?? material) };
        }
        if (!assetRoot && !packsRoot) return { configured: false, assets: [] };
        return { configured: true, ...(await rescannedCatalog()).list(), ...(packsRoot && { packs: (await packs()).list() }) };
      });
    },
    createAsset({ recipe, checkMesh = false }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await pinNamedAssetRecipe(recipe);
        const bytes = await (await catalog()).read(recipe.assetId);
        await boot();
        const sessionId = randomUUID();
        const result = await evaluate('createAsset', { recipe, checkMesh, data: bytes.toString('base64'), sessionId, memoryBudgetMiB: memory, backend, ...(await motionSources([recipe.motion])) });
        registerCreatedScene(sessionId, result, false);
        return result;
      }, { recoversFailedRuntime: true });
    },
    inspect(input) {
      if (!input.profile) return enqueue(() => invoke('inspect', input));
      // A cost profile draws real frames, so it takes a GPU slot like a look does.
      return gpuUnit('light', () => enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('inspect', input);
      }));
    },
    inspectMeshes(input) {
      return enqueue(() => invoke('inspectMeshes', input));
    },
    walkMap({ assetId, ...input }) {
      if (assetId === undefined) return enqueue(() => invoke('walkMap', input));
      if (input.sessionId !== undefined) return Promise.reject(new TypeError('scene_walkmap takes a sessionId or an assetId, not both.'));
      // Query-only: the preview page parses the textureless geometry and queries it, with no scene and no render, so it may
      // pass the render vertex cap. The page keeps one scene and asks for the file only when it does not hold it.
      return enqueue(async () => {
        await boot();
        const request = { ...input, assetId };
        const cached = await evaluate('queryOnlyWalkMap', request, page, QUERY_ONLY_TIMEOUT_MS);
        if (!cached.needsData) return cached;
        const stripped = geometryOnlyGlb(await (await catalog()).read(assetId));
        return evaluate('queryOnlyWalkMap', { ...request, data: stripped.toString('base64') }, page, QUERY_ONLY_TIMEOUT_MS);
      });
    },
    setMeshStack(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('setMeshStack', input);
      });
    },
    editMesh(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('editMesh', input);
      });
    },
    apply(input) {
      const applyOperations = () => enqueue(async () => {
        await requirePreviewRenderer();
        await pinNamedAssets(input.operations);
        if (input.branch !== undefined) {
          const { branch, ...rest } = input;
          await assertSceneAssetsFitAfterEdit(input.sessionId, input.operations);
          const branchRebakes = bakedSessionIds.has(input.sessionId) || bakeAfterOperations(input.operations) === true;
          return invoke('branchApply', { ...rest, name: validateBranchName(branch), ...(await placedAssetData(input.operations, { transcodeKtx2: branchRebakes })) });
        }
        const bakeAfter = bakeAfterOperations(input.operations);
        const hadBake = bakedSessionIds.has(input.sessionId);
        const rebakes = hadBake || bakeAfter === true;
        const motions = (input.operations ?? []).filter(operation => operation.type === 'set-motion').map(operation => operation.motion);
        const gameAssets = await gameAssetNeeds(input);
        const placedValue = gameAssets?.recipe ?? input.operations;
        await assertSceneAssetsFitAfterEdit(input.sessionId, placedValue);
        const applyInput = { ...input, ...(await motionSources(motions, placedValue)), ...(await placedAssetData(placedValue, { transcodeKtx2: rebakes })), ...(gameAssets ? { assetNeeds: gameAssets.recipe } : {}) };
        const applyTimeout = previewCallTimeoutMs({ bakes: rebakes, addsGridVolume: operationsAddGridVolume(input.operations), plainTimeoutMs: EVALUATION_TIMEOUT_MS, bakeTimeoutMs: BAKE_EVALUATION_TIMEOUT_MS });
        const applied = await invoke('apply', applyInput, applyTimeout);
        if (bakeAfter ?? hadBake) bakedSessionIds.add(input.sessionId);
        else bakedSessionIds.delete(input.sessionId);
        return applied;
      });
      // Whether the edit rebakes light is read when the call arrives, so the card is taken before the call queue is entered.
      const rebakesLight = input.branch === undefined && (bakedSessionIds.has(input.sessionId) || bakeAfterOperations(input.operations) === true);
      return rebakesLight ? gpuUnit('heavy', applyOperations) : applyOperations();
    },
    look(input) {
      return gpuUnit('light', () => enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(input.sessionId);
        const width = input.width ?? 768;
        const height = input.height ?? 512;
        if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
          throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
        }
        const lookRequest = { sessionId: input.sessionId,
          ...(input.motionTime !== undefined ? { motionTime: input.motionTime } : {}),
          ...(input.labels ? { labels: true } : {}),
          ...(input.view !== undefined ? { view: resolveLookView(input.view) } : {}) };
        // A busy picture can encode past the response budget. Render again a step smaller (same aspect, PNG kept) until it fits.
        let result;
        let stepWidth = width;
        let stepHeight = height;
        for (let step = 0; ; step++) {
          await page.setViewportSize({ width: stepWidth, height: stepHeight });
          result = await invoke('look', lookRequest);
          if (Buffer.byteLength(result.data, 'base64') <= MAXIMUM_IMAGE_BYTES) break;
          if (step === LOOK_MAXIMUM_STEP_DOWNS) {
            throw new Error(`The PNG exceeds the 1 MiB image response budget even at ${stepWidth}x${stepHeight}. Simplify the scene's high-frequency textures or request a smaller preview.`);
          }
          const stepScale = lookStepScale(Buffer.byteLength(result.data, 'base64'));
          stepWidth = Math.max(LOOK_MINIMUM_SIDE, Math.floor(stepWidth * stepScale));
          stepHeight = Math.max(LOOK_MINIMUM_SIDE, Math.floor(stepHeight * stepScale));
        }
        result.metadata.requestedWidth = width;
        result.metadata.requestedHeight = height;
        result.metadata.backend = backend;
        const capped = stepWidth !== width || stepHeight !== height;
        result.metadata.size = { requested: { width, height }, returned: { width: stepWidth, height: stepHeight }, capped, maximumBytes: MAXIMUM_IMAGE_BYTES };
        if (capped) {
          result.metadata.returnedWidth = stepWidth;
          result.metadata.returnedHeight = stepHeight;
          result.metadata.note = `The ${width}x${height} PNG was over the 1 MiB image response budget, so this is the ${stepWidth}x${stepHeight} render. Request that size or smaller to skip the retry; the PNG limit is bytes, so a calmer scene keeps more pixels.`;
        }
        return result;
      }));
    },
    // Fits look parameters to reference region colours (#2801). It holds the preview like a look, on the light GPU slot, and the
    // fit stops at its evaluation and time limits with the best look it found; the scene's recipe is put back at the end.
    fitLook(input) {
      return gpuUnit('light', () => enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(input.sessionId);
        const result = await runFitLook({ input, invoke: (method, value) => invoke(method, value), setViewport: (width, height) => page.setViewportSize({ width, height }) });
        const restored = await invoke('exportRecipe', { sessionId: input.sessionId });
        return { ...result, revision: restored.revision, backend };
      }));
    },
    // Shows the current view in the person's own browser, waits for their pins and notes, and resolves each pin to a part and a
    // world point. The wait holds no preview queue slot, so other tools keep working while the person marks.
    async askUser(input) {
      if (input.reviewFile !== undefined) return readReviewFile(input);
      const width = input.width ?? 768;
      const height = input.height ?? 512;
      const maxMarks = input.maxMarks ?? ANNOTATE_LIMITS.maxMarks;
      const timeoutSeconds = input.timeoutSeconds ?? ANNOTATE_LIMITS.defaultTimeoutSeconds;
      const frame = await captureAnnotateFrame(input.sessionId, width, height, input.motionTime);
      if (closing) throw new Error('The agent runtime is closing.');
      if (askUserFixture) {
        // Test-only (#1956): the fixture stands in for the person, and its marks go through the same pick as a browser answer.
        const marks = validateMarks(askUserFixture.marks, { width: frame.width, height: frame.height, maxMarks });
        return resolveSentMarks({ sessionId: input.sessionId, frame, marks, image: frame.data });
      }
      if (input.inline) {
        // The nonce goes to the view in the result's _meta only, never in the content the model reads: the model cannot call the
        // app-only submit tool with a person's marks because it never sees the nonce.
        const nonce = randomBytes(16).toString('hex');
        inlineAsks.set(nonce, { sessionId: input.sessionId, frame, maxMarks, expiresAt: Date.now() + timeoutSeconds * 1000 });
        while (inlineAsks.size > MAXIMUM_INLINE_ASKS) inlineAsks.delete(inlineAsks.keys().next().value);
        return { image: frame.data, viewMeta: { nonce }, content: { sessionId: input.sessionId, outcome: 'pending', revision: frame.metadata.revision,
          view: annotateViewOf(frame), maxMarks, maxNoteLength: ANNOTATE_LIMITS.maxNoteLength, prompt: input.prompt ?? '',
          message: 'The view is open in the chat for the person. Their marks arrive as a message from them: stop here and do not call scene_ask_user again.' } };
      }
      const askController = new AbortController();
      pendingAskControllers.add(askController);
      let session;
      try {
        session = await runAnnotateSession({ png: frame.data, width: frame.width, height: frame.height, prompt: input.prompt ?? '',
          maxMarks, waitMs: timeoutSeconds * 1000, signal: askController.signal, open: async url => {
            console.error(`Crucible annotate page: ${url}`);
            await openPage(url);
          } });
      } finally {
        pendingAskControllers.delete(askController);
      }
      if (session.outcome === 'aborted') throw new Error('The agent runtime closed while the person was marking the scene.');
      const base = { sessionId: input.sessionId, revision: frame.metadata.revision, view: annotateViewOf(frame) };
      if (session.outcome !== 'sent') {
        return { content: { ...base, outcome: session.outcome, marks: [], message: session.outcome === 'timeout'
          ? `The person did not press Send within ${timeoutSeconds} seconds. Ask in text, or call scene_ask_user again with a longer timeoutSeconds.`
          : 'The person cancelled without sending marks. Ask what they meant in text.' } };
      }
      return resolveSentMarks({ sessionId: input.sessionId, frame, marks: session.marks, image: session.image });
    },
    // The second half of an inline scene_ask_user: the MCP Apps view sends the marks it collected, the answer has the same shape as a
    // browser answer. Only the nonce the view received can submit, so the model cannot forge an answer; an unknown, used or
    // expired nonce fails. The ask stays open until the marks resolve, so a failed pick can be retried.
    async submitAskUser({ nonce, marks, image }) {
      const pending = inlineAsks.get(nonce);
      if (!pending) throw new Error('scene_ask_user_submit only accepts the marks of an open annotate view, using the nonce that view received. Call scene_ask_user again to get a fresh view.');
      if (Date.now() > pending.expiresAt) {
        inlineAsks.delete(nonce);
        throw new Error('The annotate view timed out before the marks were sent. Ask in text, or call scene_ask_user again with a longer timeoutSeconds.');
      }
      const clean = validateMarks(marks, { width: pending.frame.width, height: pending.frame.height, maxMarks: pending.maxMarks });
      if (!clean.length) throw new TypeError('Add at least one pin before sending.');
      if (!isBoundedPng(image)) throw new TypeError('The marked picture is not a PNG within 1 MiB.');
      const answer = await resolveSentMarks({ sessionId: pending.sessionId, frame: pending.frame, marks: clean, image });
      inlineAsks.delete(nonce);
      return answer;
    },
    checkpoint(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('checkpoint', { ...input, checkpointId: randomUUID() });
      });
    },
    // scene_review with wedge: one parameter at several values; each value is a scratch copy of the scene drawn through the same review path.
    async wedge(input) {
      const settings = normalizeWedge(input);
      const loadRecipes = async () => {
        const { recipes } = await invoke('wedgeRecipes', { sessionId: settings.sessionId, expectedRevision: settings.expectedRevision,
          target: settings.wedge.target, field: settings.wedge.parameter, values: settings.wedge.values });
        return new Map(recipes.map((recipe, index) => [settings.wedge.variantNames[index], { recipe: withSnapshotSkyColors({ recipe }).recipe, stale: false }]));
      };
      const output = await this.review(input, { settings, loadRecipes });
      const { shots, ...rest } = output.metadata;
      const wedgeShots = shots.map(({ branch: _branch, branchStale: _stale, ...shot }, index) => ({ ...shot, value: settings.wedge.values[index] }));
      return { ...output, metadata: { ...rest, wedge: { target: settings.wedge.target, parameter: settings.wedge.parameter }, shots: wedgeShots } };
    },
    review(input, wedgeRun) {
      if (input?.wedge !== undefined && !wedgeRun) return this.wedge(input);
      let settings;
      try { settings = wedgeRun ? wedgeRun.settings : normalizeReview(input); }
      catch (error) { return Promise.reject(error); }
      return gpuUnit('light', () => enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(settings.sessionId);
        const snapshot = withSnapshotSkyColors(await invoke('snapshot', settings));
        await assertSceneFitsBeforeJob(snapshot.recipe);
        const branchRecipes = new Map();
        for (const name of settings.branchNames) {
          branchRecipes.set(name, withSnapshotSkyColors(await invoke('branchRecipe', { sessionId: settings.sessionId, name })));
        }
        if (wedgeRun) for (const [name, variant] of await wedgeRun.loadRecipes()) branchRecipes.set(name, variant);
        const assetBytes = snapshot.recipe.format === 'crucible.asset' ? await (await catalog()).read(snapshot.recipe.assetId) : undefined;
        let privateSessionId;
        const started = performance.now();
        let suspended = false;
        let privateCreated = false;
        let session;
        let output;
        let deadlineExpired = false;
        let completedShots = 0;
        const reviewDeadlineText = () => reviewDeadlineMessage({ completedShots, requestedShots: settings.shots.length, deadlineSeconds: EVALUATION_TIMEOUT_MS / 1000 });
        let cancellationReason;
        const cancellation = new Promise((resolve, reject) => {
          cancelReview = error => {
            cancellationReason ??= error;
            reject(cancellationReason);
            reviewPage?.close().catch(() => {});
          };
        });
        // Cancellation can arrive during source suspension, before acquisition attaches its race.
        cancellation.catch(() => {});
        const deadline = setTimeout(() => {
          deadlineExpired = true;
          cancelReview(new Error(reviewDeadlineText()));
        }, EVALUATION_TIMEOUT_MS);
        function requireReviewOpen() {
          if (deadlineExpired) throw new Error(reviewDeadlineText());
          if (closing) throw new Error('The agent runtime is closing.');
        }
        async function reviewEvaluate(method, value) {
          requireReviewOpen();
          const result = await evaluate(method, value, reviewPage);
          requireReviewOpen();
          return result;
        }
        try {
          await invoke('suspend', { sessionId: settings.sessionId }, PAGE_HANDOFF_TIMEOUT_MS);
          suspended = true;
          phase = 'reviewing';
          requireReviewOpen();
          const acquisition = browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 })
            .then(async acquired => {
              if (cancellationReason) {
                await acquired.close();
                throw cancellationReason;
              }
              return acquired;
            });
          reviewPage = await Promise.race([acquisition, cancellation]);
          requireReviewOpen();
          const origin = `http://127.0.0.1:${httpServer.address().port}`;
          await reviewPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          reviewPage.setDefaultTimeout(15000);
          await loadPreviewPage(reviewPage, origin);
          await reviewEvaluate('reviewBegin', { width: settings.gridWidth, height: settings.gridHeight });
          session = await reviewPage.context().newCDPSession(reviewPage);
          const shots = [];
          let peakBrowserHeap = 0;
          let peakNodeBytes = 0;
          for (const group of settings.groups) {
            const branchRecipe = group.branch === undefined ? undefined : branchRecipes.get(group.branch);
            const targetRecipe = branchRecipe ? branchRecipe.recipe : snapshot.recipe;
            privateSessionId = randomUUID();
            await reviewEvaluate(branchRecipe || !assetBytes ? 'create' : 'createAsset', { sessionId: privateSessionId,
              recipe: targetRecipe, memoryBudgetMiB: memory, backend,
              ...(!branchRecipe && assetBytes ? { data: assetBytes.toString('base64'), ...(await motionSources([snapshot.recipe.motion])) } : {}),
              ...(!assetBytes ? await placedAssetData(targetRecipe, { transcodeKtx2: Boolean(targetRecipe?.bake) }) : {}) });
            privateCreated = true;
            for (const index of group.shotIndexes) {
              const rendered = await reviewEvaluate('reviewShot', { sessionId: privateSessionId, shot: settings.shots[index], index,
                width: settings.width, height: settings.height, columns: settings.columns, labels: settings.labels });
              if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU review did not select SwiftShader.');
              peakNodeBytes = Math.max(peakNodeBytes, process.memoryUsage().rss);
              peakBrowserHeap = Math.max(peakBrowserHeap, await sampleBrowserHeap(session, memoryGuardLimits(memory).browserHeapBytes));
              const sample = { nodeBytes: peakNodeBytes, browserHeapBytes: peakBrowserHeap, nativeAllowanceBytes: nativeMemoryAllowance.bytes, memoryMiB: memory };
              if (exceedsMemoryGuard(sample)) {
                throw new Error(memoryGuardMessage({ subject: 'Review', ...sample, maximumMemoryMiB: maximumMemory }));
              }
              shots[index] = { ...rendered, ...(group.branch === undefined ? {} : { branch: group.branch, branchStale: branchRecipe.stale }) };
              completedShots += 1;
            }
            await reviewEvaluate('dispose', { sessionId: privateSessionId });
            privateCreated = false;
          }
          const result = await reviewEvaluate('reviewResult', { sessionId: privateSessionId });
          if (Buffer.byteLength(result.data, 'base64') > MAXIMUM_IMAGE_BYTES) throw new Error('The review PNG exceeds the 1 MiB image response budget. Request smaller shots.');
          output = { ...result, metadata: { sessionId: settings.sessionId, sourceRevision: snapshot.sourceRevision,
            backend, width: settings.gridWidth, height: settings.gridHeight, shots,
            peakNodeBytes, peakBrowserHeap, maximumPendingFrames: 1,
              ...(recipeMoves(snapshot.recipe) && settings.shots.some(shot => shot.motionTime === null) ? { hints: [MOTION_NOT_SET_HINT] } : {}) } };
          if (settings.checks === 'realism') output.metadata.realism = realismReport(snapshot.recipe, reviewTilingFindings(result.data, settings));
        } catch (error) {
          if (deadlineExpired) throw new Error(reviewDeadlineText());
          throw error;
        } finally {
          clearTimeout(deadline);
          cancelReview = undefined;
          try {
            if (reviewPage && !reviewPage.isClosed()) {
              try {
                if (privateCreated && !closing) await evaluate('dispose', { sessionId: privateSessionId }, reviewPage);
              } finally {
                try { await reviewPage.close(); }
                catch (error) {
                  phase = 'failed';
                  await shutdownResources();
                  throw error;
                }
              }
            }
          } finally {
            reviewPage = undefined;
            await session?.detach().catch(() => {});
            if (suspended && !closing && phase !== 'failed') {
              try { await invoke('resume', { sessionId: settings.sessionId }, PAGE_HANDOFF_TIMEOUT_MS); }
              catch (error) {
                phase = 'failed';
                throw new Error(`Preview recovery failed after review: ${error.message}`);
              }
              phase = 'ready';
            }
          }
        }
        output.metadata.elapsedSeconds = (performance.now() - started) / 1000;
        return output;
      }));
    },
    restore(input) {
      const targets = ['checkpointId', 'revision', 'branch'].filter(field => input[field] !== undefined);
      if (targets.length > 1) {
        return Promise.reject(new TypeError(`scene_restore: pass exactly one of checkpointId, revision or branch; got ${targets.join(' and ')}.`));
      }
      return enqueue(async () => {
        await requirePreviewRenderer();
        if (input.branch !== undefined) {
          return invoke('keepBranch', { sessionId: input.sessionId, name: validateBranchName(input.branch), expectedRevision: input.expectedRevision });
        }
        if (input.revision === undefined && input.checkpointId === undefined) throw new TypeError('Restore needs a checkpointId, a revision or a branch.');
        return invoke('restore', input);
      });
    },
    releaseCheckpoint(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('releaseCheckpoint', input);
      });
    },
    exportRecipe(input) {
      return enqueue(() => invoke('exportRecipe', input));
    },
    dispose(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const result = await invoke('dispose', input);
        forgetSession(input.sessionId);
        for (const [nonce, pending] of inlineAsks) if (pending.sessionId === input.sessionId) inlineAsks.delete(nonce);
        for (const [reviewId, review] of rememberedReviews) if (review.sessionId === input.sessionId) rememberedReviews.delete(reviewId);
        return result;
      });
    },
    exportGlb({ sessionId, clip, motionTime, maxTextureSize }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await jobs();
        const exported = await invoke('exportGlb', { sessionId, clip, motionTime, maxTextureSize, maximumBytes: MAXIMUM_GLB_BYTES });
        const { data, ...summary } = exported;
        const file = await saveGlbExport(Buffer.from(data, 'base64'));
        return { ...summary, ...file };
      });
    },
    exportWeb({ sessionId, title, review = false }) {
      if (review) return exportReviewPage({ sessionId, title });
      return enqueue(async () => {
        await requirePreviewRenderer();
        await jobs();
        const { recipe, revision } = await invoke('exportRecipe', { sessionId });
        // Same name rule as GLB exports: the server picks the folder, and only the newest few are kept.
        const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await seedKeptExports(directory);
        const outputDirectory = join(directory, `web-${randomUUID()}`);
        let summary;
        try {
          const assets = new Map();
          for (const id of gameAssetIds(recipe)) assets.set(id, await (await catalog()).read(id, { transcodeKtx2: true }));
          // The catalog images the materials read (graph image nodes, map sequences) travel with the page, which decodes them before the scene is created.
          const images = new Map();
          for (const id of gameImageIds(recipe)) images.set(id, await (await catalog()).read(id));
          summary = await writeWebBuild({ recipe, buildDirectory: fileURLToPath(new URL('../', previewUrl)), outputDirectory, title, assets, images });
        } catch (error) {
          // A refused or half-written build never uses up a retention slot or evicts a good one.
          await rm(outputDirectory, { recursive: true, force: true });
          throw error;
        }
        savedWebBuildPaths.push(outputDirectory);
        while (savedWebBuildPaths.length > MAXIMUM_KEPT_WEB_BUILDS) await rm(savedWebBuildPaths.shift(), { recursive: true, force: true });
        return { sessionId, revision, ...summary, entry: join(outputDirectory, 'index.html'), host: 'Serve the folder with any static file server; no server code runs.' };
      });
    },
    submitJob({ sessionId, expectedRevision, settings }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const controller = await jobs();
        if (settings?.kind === 'icons') settings = await pinIconItems(settings);
        if (settings?.audio) {
          if (!audioLibrary) throw new Error('Configure --audio with an absolute folder before submitting a job with audio.');
          await audioLibrary.resolve(settings.audio.file);
        }
        const snapshot = withSnapshotSkyColors(await invoke('snapshot', { sessionId, expectedRevision }));
        phase = 'rendering';
        try {
          // The estimate is made before the job exists, because the job suspends the scene and starts at once.
          const size = sceneSizeFrom(await invoke('inspect', { sessionId, limit: Math.max(1, snapshot.recipe.nodes?.length ?? 1) }), snapshot.recipe,
            { assetFileBytes: await placedAssetFileBytes(snapshot.recipe) });
          const history = await readRenderHistory();
          const estimateOf = rawSettings => estimateRenderJob({ size, settings: normalizeJobSettings(rawSettings, snapshot.clips, snapshot.recipe), backend, memoryBudgetMiB: memory, history, gpuTracerWarm });
          if (settings?.quality !== undefined && settings.budget !== undefined) throw new TypeError('budget picks the tier: leave settings.quality out, or leave settings.budget out.');
          let jobSettings = settings;
          let budgetReport;
          let qualityReport;
          if (settings?.budget !== undefined) {
            const { budget: budgetInput, ...base } = settings;
            if (base.renderer !== undefined) throw new TypeError('budget picks the renderer: leave settings.renderer out, or leave settings.budget out to choose it yourself.');
            const budget = parseBudget(budgetInput);
            const frameCount = normalizeJobSettings(base, snapshot.clips, snapshot.recipe).frameCount;
            ({ settings: jobSettings, report: budgetReport } = chooseBudgetSettings({ base, budget, tracerBackend: backend === 'cpu' ? 'cpu' : 'gpu', frameCount, estimateOf, serverMemoryMiB: memory }));
          }
          if (settings?.quality !== undefined) {
            nativeTracerLocator ??= createNativeTracerLocator();
            const { quality, ...base } = settings;
            ({ settings: jobSettings, report: qualityReport } = applyQuality({ quality, base, backend, nativeTracer: Boolean((await nativeTracerLocator.find()).tracer), estimateOf }));
          }
          const triangleProblem = pathTraceTriangleProblem(size, jobSettings?.renderer, { canChooseBackend: backend !== 'cpu', picksRenderer: settings?.budget !== undefined || settings?.quality !== undefined });
          if (triangleProblem) throw new RangeError(triangleProblem);
          const normalizedSettings = normalizeJobSettings(jobSettings, snapshot.clips, snapshot.recipe);
          const outputProblem = outputByteBudgetProblem(normalizedSettings, controller.limits?.maxOutputBytes ?? MAXIMUM_JOB_OUTPUT_BYTES);
          if (outputProblem) throw new RangeError(outputProblem);
          requireTracerBackendAvailable(jobSettings?.renderer, backend);
          if (jobSettings?.mattes) requireMatteTargets({ mattes: jobSettings.mattes, ...(await invoke('matteTargets', { sessionId })) });
          const estimate = estimateOf(jobSettings);
          estimateForNextJob = estimate;
          const assetBytes = snapshot.recipe.format === 'crucible.asset' ? await (await catalog()).read(snapshot.recipe.assetId, { transcodeKtx2: Boolean(jobSettings?.renderer || snapshot.recipe?.bake) }) : undefined;
          try {
            const submitted = await controller.submit({ sessionId, sourceRevision: snapshot.sourceRevision,
              snapshot: { recipe: snapshot.recipe, clips: snapshot.clips, ...(assetBytes ? { assetBytes } : {}) }, settings: jobSettings });
            return { ...submitted, estimate, ...(budgetReport ? { budget: budgetReport } : {}), ...(qualityReport ? { quality: qualityReport } : {}) };
          } catch (error) {
            if (estimateForNextJob === estimate) estimateForNextJob = undefined;
            throw error;
          }
        } catch (error) {
          phase = 'ready';
          throw error;
        }
      });
    },
    async jobStatus({ jobId }) {
      const record = (await jobs()).status(jobId);
      // Reading a job never fails because a newer job holds the renderer; it only hands the renderer back once none does.
      if (['completed', 'cancelled', 'failed', 'interrupted'].includes(record.state)) await rendererStillLeased();
      return record;
    },
    async cancelJob({ jobId }) {
      return (await jobs()).cancel(jobId);
    },
    async jobResult({ jobId }) {
      const result = (await jobs()).result(jobId);
      return { ...result, artifacts: result.artifacts.map(artifact => ({
        ...artifact, path: join(jobRoot, result.jobId, artifact.filename),
      })) };
    },
    async releaseJob({ jobId }) {
      return (await jobs()).release(jobId);
    },
    /** The ID of the last used scene, or null. Tools that take a sessionId default to it. */
    activeSessionId() {
      return lastUsedSessionId();
    },
    close() {
      if (!closing) {
        phase = 'closing';
        cancelReview?.(new Error('The agent runtime is closing.'));
        for (const askController of pendingAskControllers) askController.abort();
        inlineAsks.clear();
        closing = (async () => {
          try {
            // The job store goes first: a client that closes the connection waits only a couple of seconds before it kills this
            // process, and the lock must be given back before the slower browser shutdown.
            if (jobsPromise) await (await jobsPromise).close();
            await reviewPage?.close().catch(() => {});
          } finally {
            await queue;
            await shutdownResources();
          }
        })().finally(() => {
          forgetAllSessions();
          phase = 'closed';
        });
      }
      return closing;
    },
  });
}
