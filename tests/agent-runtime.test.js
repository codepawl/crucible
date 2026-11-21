import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { isPreviewHost } from '../scripts/preview-host.mjs';
import { addonCapabilities, addonFileFor, addonImportMap } from '../scripts/mcp-addons.mjs';
import { sampleBrowserHeap, exceedsMemoryGuard } from '../scripts/agent-memory-guard.mjs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { writeWebBuild } from '../scripts/web-export.mjs';
import { EXPORT_DIRECTORY_NAME, RENDER_HISTORY_FILE, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';
import { RENDER_ESTIMATE_NOTE, estimateRenderJob, historyWithJob, parseHistory, renderReport, sceneSizeFrom } from '../scripts/agent-render-estimate.mjs';
import { RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget } from '../scripts/agent-render-budget.mjs';
import { RENDER_QUALITY_NOTE, applyQuality, tierReport } from '../scripts/agent-render-quality.mjs';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { estimateFrameBytes } from '../src/budget.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_SEQUENCE_JOB_SIDE, MAXIMUM_SEQUENCE_JOB_PIXELS, MAXIMUM_MEMORY_MIB, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { gameAssetIds } from '../src/game-assets.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from '../src/look-catalog.js';
import { TEXTURE_SEQUENCE_CAPABILITIES } from '../src/texture-sequence-limits.js';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes } from '../src/agent-asset-limits.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { audioInputArguments, createAudioLibrary, measureStreamSeconds } from '../scripts/job-audio.mjs';
import { filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline } from '../src/film-timeline.js';
import { normalizeReview, REVIEW_LIMITS } from '../scripts/agent-review.mjs';
import { BRANCH_LIMITS, validateBranchName } from '../src/agent-branches.js';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { ANNOTATE_LIMITS, describeMarks, validateMarks } from '../src/agent-annotate.js';
import { openReviewPage } from './support/review-page-dom.mjs';
import * as packLimits from '../src/pack-manifest.js';
import { createPackRegistry } from '../scripts/agent-packs.mjs';

const HARNESS_TEST_TIMEOUT_MS = 30000;

function runTest(name, body) {
  return test(name, { timeout: HARNESS_TEST_TIMEOUT_MS }, body);
}

runTest('runtime reports real scene capabilities without launching a browser and closes idempotently', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.phase, 'idle');
  assert.equal(capabilities.scene.schemaVersion, 1);
  assert.equal(capabilities.preview.maximumActiveScenes, 4);
  assert.equal(capabilities.preview.memoryBudgetMiB, 64);
  assert.equal(capabilities.preview.backend, 'cpu');
  assert.equal(capabilities.review.maximumShots, 4);
  assert.deepEqual([capabilities.jobs.maximumWidth, capabilities.jobs.maximumHeight, capabilities.jobs.maximumPixels], [3840, 3840, 3840 * 2160]);
  assert.deepEqual([capabilities.jobs.maximumSequenceWidth, capabilities.jobs.maximumSequenceHeight, capabilities.jobs.maximumSequencePixels], [1920, 1920, 1920 * 1080]);
  assert.equal(capabilities.review.maximumGridHeight, 1008);
  assert.equal(capabilities.review.maximumPendingFrames, 1);
  assert.equal(capabilities.sceneLimits.maxGeometryBytes, 32 * 1024 * 1024);
  await runtime.close();
  await runtime.close();
  assert.equal((await runtime.capabilities()).phase, 'closed');
  await assert.rejects(runtime.create({ recipe: {} }), /closed/);
});

const openHarnesses = [];

// Every test must end in seconds: a runtime that throws inside the sandbox leaves page promises and
// deadline timers pending, which kept the CI shard alive for 15 minutes (#1212).
afterEach(async () => {
  const harnesses = openHarnesses.splice(0);
  for (const { runtime, sandboxTimers, releasePages } of harnesses) {
    releasePages();
    let closeTimer;
    await Promise.race([runtime.close().catch(() => {}),
      new Promise(resolve => { closeTimer = setTimeout(resolve, 2000); })]);
    clearTimeout(closeTimer);
    for (const timer of sandboxTimers) clearTimeout(timer);
  }
});

// Race a "started" signal against the call that should start it, so a throw inside the runtime
// fails the test with that error instead of waiting for a signal that never comes.
function startedOrFailed(started, pending) {
  return Promise.race([started, pending.then(() => undefined)]);
}

// Names the runtime module imports, resolved from the module's own import lines so a new
// constant cannot be missing from the sandbox.
async function importedBindings(source) {
  const bindings = {};
  const importPattern = /^import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+'([^']+)'/gm;
  for (const [, defaultName, namedList, specifier] of source.matchAll(importPattern)) {
    if (specifier.endsWith('.json')) continue;
    const moduleUrl = specifier.startsWith('.') ? new URL(`../scripts/${specifier}`, import.meta.url).href : specifier;
    const namespace = await import(moduleUrl);
    if (defaultName) bindings[defaultName] = namespace.default;
    for (const entry of (namedList ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
      const [exported, local = exported] = entry.split(/\s+as\s+/);
      bindings[local] = namespace[exported];
    }
  }
  return bindings;
}

const ANNOTATE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const ANNOTATE_CAMERA = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 };
function annotateFrameOf({ width, height }, revision, motionTime) {
  return { mimeType: 'image/png', data: ANNOTATE_PNG, metadata: { width, height, revision, motionTime: motionTime ?? null }, width, height, camera: ANNOTATE_CAMERA };
}
// A scene with one lamp on the view axis: a ray that starts left of the axis misses it, the others hit it.
function hitNearestLamp(ray) {
  return ray.direction[0] < -0.2 ? null : { id: 'lamp', point: [0, 1, 0], normal: [0, 1, 0], distance: 10, material: 'brass' };
}

async function reviewRuntimeHarness({ failShot, blockShot = false, oversize = false, deadlineMs,
  failDispose = false, heapSize = 1024, stallPrivatePage = false, blockPrivateCreate = false, resumeDelayMs = 0, suspendDelayMs = 0, failResume = false, hangMethod, failPrivateCreate = false, failPrivateCreateMessage, disposeGate, disposeLostBridge = false, disposeWithoutScene = false, hangBrowserClose = false, closeTimeoutMs, failFirstGoto = false, jobRender, sceneBake, exportedRecipe, runtimeOptions = {}, contextOverrides = {}, lookBytesPerPixel = 0, inspection } = {}) {
  const events = [];
  const sourceCalls = [];
  const sandboxTimers = new Set();
  const viewports = [];
  const deadlines = [];
  let privatePage;
  let sourceRevision = 0;
  let resolveShotStarted;
  const shotStarted = new Promise(resolve => { resolveShotStarted = resolve; });
  let resolveAcquisitionStarted;
  const acquisitionStarted = new Promise(resolve => { resolveAcquisitionStarted = resolve; });
  let resolvePrivatePage;
  const acquiredPage = new Promise(resolve => { resolvePrivatePage = () => resolve(privatePage = new FakePage(true)); });
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], ...(sceneBake ? { bake: sceneBake } : {}) };
  class FakePage {
    constructor(privateTarget) { this.privateTarget = privateTarget; this.closed = false; }
    route() {}
    exposeFunction() {}
    setDefaultTimeout() {}
    setViewportSize(size) { this.viewport = size; viewports.push(size); }
    goto() {
      if (!this.privateTarget && failFirstGoto) {
        failFirstGoto = false;
        throw new Error('page.goto: Timeout 15000ms exceeded.');
      }
    }
    waitForFunction() {}
    isClosed() { return this.closed; }
    context() { return { newCDPSession: async () => ({
      send: async () => ({ usedSize: heapSize }), detach: async () => { events.push('detach'); },
    }) }; }
    async evaluate(callback, argument) {
      // The render job disposes its private session with a bare session id instead of a method call.
      const { method, input } = typeof argument === 'string' ? { method: 'dispose', input: { sessionId: argument } } : argument;
      events.push(`${this.privateTarget ? 'private' : 'source'}:${method}`);
      if (!this.privateTarget) sourceCalls.push({ method, input });
      if (method === hangMethod && !this.privateTarget) return new Promise(() => {});
      if (method === 'create' && this.privateTarget && failPrivateCreate) {
        failPrivateCreate = false;
        throw new Error(typeof failPrivateCreateMessage === 'string' ? failPrivateCreateMessage : 'Injected private create failure');
      }
      if (method === 'dispose' && this.privateTarget && disposeLostBridge) throw new TypeError("page.evaluate: TypeError: Cannot read properties of undefined (reading 'dispose')");
      if (method === 'dispose' && this.privateTarget && disposeWithoutScene) throw new Error('page.evaluate: Error: No scene is active: it was never created, was disposed, or scene_create failed. Call scene_create or scene_create_asset first, then pass the sessionId it returns.');
      if (method === 'dispose' && disposeGate) await disposeGate;
      if (method === 'resume' && failResume) throw new Error('Injected resume failure');
      if (method === 'create' && this.privateTarget && blockPrivateCreate) return new Promise((resolve, reject) => { this.rejectShot = reject; });
      if (method === 'create') return { sessionId: input.sessionId, revision: 0, ...(jobRender && this.privateTarget ? { render: jobRender } : {}) };
      if (method === 'inspect' && inspection) return inspection;
      if (method === 'exportRecipe') return { recipe: exportedRecipe, revision: 1 };
      if (method === 'exportGlb') return { data: Buffer.from('glb bytes').toString('base64') };
      if (method === 'snapshot') {
        if (input.expectedRevision !== sourceRevision) throw new Error('Stale revision for render snapshot.');
        return { sourceRevision, recipe };
      }
      if (method === 'reviewShot') {
        resolveShotStarted();
        if (blockShot) return new Promise((resolve, reject) => { this.rejectShot = reject; });
        if (input.index === failShot) throw new Error('Injected partial shot failure');
        return { label: input.shot.label, motionTime: input.shot.motionTime,
          rendererTime: input.shot.rendererTime, graphics: 'SwiftShader', width: 384, height: 384 };
      }
      if (method === 'look') {
        const { width, height } = this.viewport;
        return { mimeType: 'image/png', data: Buffer.alloc(Math.round(width * height * lookBytesPerPixel)).toString('base64'), metadata: { width, height } };
      }
      if (method === 'annotateFrame') return annotateFrameOf(this.viewport, sourceRevision, input.motionTime);
      if (method === 'pickMarks') return { revision: sourceRevision, marks: describeMarks(validateMarks(input.marks, input), input.camera, { width: input.width, height: input.height, raycast: hitNearestLamp }) };
      if (method === 'reviewResult') return { mimeType: 'image/png',
        data: Buffer.alloc(oversize ? 1024 * 1024 + 1 : 16).toString('base64') };
      if (method === 'dispose' && failDispose) throw new Error('Injected disposal failure');
      if (method === 'resume' && resumeDelayMs) await new Promise(resolve => setTimeout(resolve, resumeDelayMs));
      if (method === 'suspend' && suspendDelayMs) await new Promise(resolve => setTimeout(resolve, suspendDelayMs));
      if (method === 'apply') { sourceRevision++; return { revision: sourceRevision }; }
      return {};
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      events.push(`${this.privateTarget ? 'private' : 'source'}:close`);
      this.rejectShot?.(new Error('Review page closed'));
    }
  }
  const sourcePage = new FakePage(false);
  let pageCount = 0;
  let browserConnected = true;
  const browser = { isConnected: () => browserConnected,
    newPage: async () => {
      if (++pageCount === 1) return sourcePage;
      resolveAcquisitionStarted();
      return stallPrivatePage ? acquiredPage : (privatePage = new FakePage(true));
    },
    close: async () => { if (hangBrowserClose) { hangBrowserClose = false; return new Promise(() => {}); } await privatePage?.close(); await sourcePage.close(); events.push('browser:close'); },
  };
  const originalSource = await readFile(new URL('../scripts/agent-runtime.mjs', import.meta.url), 'utf8');
  let source = originalSource
    .replace(/^import .+;\r?$/gm, '')
    .replace('export function validateLaunchPaths', 'function validateLaunchPaths')
    .replace('export function createAgentRuntime', 'function createAgentRuntime')
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url))
    .replace("import('playwright-core')", 'Promise.resolve({ chromium: globalThis.chromium })');
  if (closeTimeoutMs) source = source.replace('const BROWSER_CLOSE_TIMEOUT_MS = 5000;', `const BROWSER_CLOSE_TIMEOUT_MS = ${closeTimeoutMs};`);
  const deadlineLine = 'const EVALUATION_TIMEOUT_MS = previewDeadlineMilliseconds();';
  if (deadlineMs) {
    assert.ok(source.includes(deadlineLine), `the harness shortens the deadline by rewriting "${deadlineLine}"; update it to match agent-runtime.mjs`);
    source = source.replace(deadlineLine, `const EVALUATION_TIMEOUT_MS = ${deadlineMs};`);
  }
  const context = createContext({ ...(await importedBindings(originalSource)),
    packageMetadata: { version: 'test' }, existsSync: () => true, readFile: async () => '',
    createRequire: () => ({ resolve: () => { throw new Error('no peer in tests'); } }),
    runAnnotateSession: async () => ({ outcome: 'timeout' }), openInDefaultBrowser: async () => {},
    createNativeTracerLocator: () => ({ find: async () => ({ reason: 'no native tracer in tests' }) }),
    createAgentRenderJobs: async () => ({ list: () => [], close: async () => {} }), resolveJobRoot: path => path,
    chromium: { launch: async () => { browserConnected = true; return browser; } },
    launchWithShaderCache: async () => { browserConnected = true; return browser; }, URL, Buffer, AbortController, process, performance, clearTimeout, runtimeOptions, ...contextOverrides,
    setTimeout: (callback, delay) => {
      deadlines.push(delay);
      const timer = setTimeout(callback, delay);
      sandboxTimers.add(timer);
      return timer;
    },
  });
  new Script(`${source}\nglobalThis.runtime = createAgentRuntime({ backend: 'cpu', ...runtimeOptions });`).runInContext(context);
  const runtime = context.runtime;
  openHarnesses.push({ runtime, sandboxTimers, releasePages: () => { resolvePrivatePage(); privatePage?.rejectShot?.(new Error('Harness cleanup')); } });
  const created = await runtime.create({ recipe });
  const disconnectBrowser = () => { browserConnected = false; };
  return { runtime, sessionId: created.sessionId, disconnectBrowser, deadlines, events, sourceCalls, viewports, shotStarted, acquisitionStarted, resolvePrivatePage };
}

function boundedResult(promise) {
  let timer;
  return Promise.race([promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 150); }),
  ]).finally(() => clearTimeout(timer));
}

runTest('scene_look steps a busy PNG down by 0.75 until it fits the 1 MiB budget and says which size came back (#1197)', async () => {
  const busy = await reviewRuntimeHarness({ lookBytesPerPixel: 2 });
  const stepped = await busy.runtime.look({ sessionId: busy.sessionId, width: 1024, height: 640 });
  assert.deepEqual(busy.viewports.slice(-2).map(size => `${size.width}x${size.height}`), ['1024x640', '768x480']);
  assert.equal(stepped.metadata.returnedWidth, 768);
  assert.equal(stepped.metadata.returnedHeight, 480);
  await busy.runtime.close();
  assert.equal(stepped.metadata.requestedWidth, 1024);
  assert.match(stepped.metadata.note, /1024x640.*768x480/);
  const calm = await reviewRuntimeHarness({ lookBytesPerPixel: 0.5 });
  const unchanged = await calm.runtime.look({ sessionId: calm.sessionId, width: 1024, height: 640 });
  assert.equal(calm.viewports.length, 1);
  assert.equal(unchanged.metadata.note, undefined);
  await calm.runtime.close();
});

runTest('scene_look fails only when the fourth step down still does not fit, naming that size (#1197)', async () => {
  const hopeless = await reviewRuntimeHarness({ lookBytesPerPixel: 50 });
  await assert.rejects(hopeless.runtime.look({ sessionId: hopeless.sessionId, width: 1024, height: 640 }), /even at 324x202/);
  assert.equal(hopeless.viewports.length, 5);
  await hopeless.runtime.close();
});

runTest('an edit of a scene with a bake, or one that adds a bake, gets the bake deadline; a plain edit keeps 30 s', async () => {
  const plain = await reviewRuntimeHarness();
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: { preset: 'draft' } }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: null }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  const applyDeadlines = plain.deadlines.slice(-5);
  assert.deepEqual(applyDeadlines, [30000, 120000, 120000, 120000, 30000]);
  await plain.runtime.close();
  const baked = await reviewRuntimeHarness({ sceneBake: { preset: 'draft' } });
  assert.equal(baked.deadlines.at(-1), 120000, 'creating a scene with a bake gets the bake deadline');
  await baked.runtime.apply({ sessionId: baked.sessionId, operations: [{ type: 'set-node', id: 'a' }] });
  assert.equal(baked.deadlines.at(-1), 120000, 'moving a part in a baked scene gets the bake deadline');
  await baked.runtime.close();
});

runTest('review deadline rejects stalled page acquisition and disposes a late page', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({
    stallPrivatePage: true, deadlineMs: 40,
  });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  try {
    await startedOrFailed(acquisitionStarted, pending);
    assert.equal(await boundedResult(pending), 'settled', 'deadline must reject without waiting for newPage');
    await assert.rejects(pending, /deadline/);
    assert.equal((await runtime.capabilities()).phase, 'ready');
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await runtime.close();
  }
});

runTest('close interrupts stalled page acquisition and late resolution cannot resurrect the runtime', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({ stallPrivatePage: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  pending.catch(() => {});
  await startedOrFailed(acquisitionStarted, pending);
  const closing = runtime.close();
  try {
    assert.equal(await boundedResult(closing), 'settled', 'close must not wait for newPage');
    await closing;
    await assert.rejects(pending, /closing|closed/);
    assert.ok(events.includes('browser:close'));
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.ok(!events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'closed');
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await closing;
  }
});

runTest('review queue releases private renderer before source resume, including partial and size failures', async () => {
  for (const options of [{}, { failShot: 1 }, { oversize: true }, { heapSize: 256 * 1024 ** 2 + 1 }]) {
    const { runtime, sessionId, events } = await reviewRuntimeHarness(options);
    try {
      const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }, {}] });
      if (options.failShot !== undefined || options.oversize || options.heapSize) await assert.rejects(pending, /partial shot|1 MiB|heap guard/);
      else {
        const result = await pending;
        assert.equal(result.metadata.sourceRevision, 0);
        assert.equal(result.metadata.shots[1].motionTime, null);
        assert.equal(result.metadata.maximumPendingFrames, 1);
      }
      assert.ok(events.indexOf('private:dispose') < events.indexOf('private:close'));
      assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
      assert.equal(events.filter(event => event === 'source:resume').length, 1);
      assert.equal((await runtime.apply({ sessionId })).revision, 1);
    } finally { await runtime.close(); }
  }
});

runTest('queued review detaches its request before a caller can mutate shot clocks', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness();
  try {
    const input = { sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }] };
    const pending = runtime.review(input);
    input.shots[0].motionTime = 99;
    input.shots.push({ motionTime: 88 });
    const result = await pending;
    assert.equal(result.metadata.shots.length, 1);
    assert.equal(result.metadata.shots[0].motionTime, 1);
  } finally { await runtime.close(); }
});

runTest('successful review elapsed time includes source renderer recovery', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ resumeDelayMs: 30 });
  try {
    const result = await runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
    assert.ok(result.metadata.elapsedSeconds >= 0.02, 'elapsed must include the delayed source resume');
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('total review deadline closes private page and restores the usable source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockShot: true, deadlineMs: 40 });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /total [\d.]+ second deadline after 0 of 1 shots/);
    assert.ok(events.includes('private:close'));
    assert.ok(events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a job cut short by its deadline leaves the runtime usable although the scene page is slow to resume (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockPrivateCreate: true, resumeDelayMs: 100, deadlineMs: 40,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('Render job exceeded its elapsed deadline.')), 20);
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: abortController.signal, progress: async () => {} }), /Review page closed/);
    assert.ok(events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('scene_render_status of a finished job still answers while a newer job holds the renderer', async () => {
  const finishedJobId = randomUUID();
  const runningJobId = randomUUID();
  const records = [{ jobId: finishedJobId, state: 'completed' }, { jobId: runningJobId, state: 'running' }];
  const controller = {
    list: () => records,
    status: jobId => records.find(record => record.jobId === jobId),
    close: async () => {},
    submit: async () => ({ jobId: runningJobId }),
  };
  const { runtime, sessionId } = await reviewRuntimeHarness({
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async () => controller } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    assert.equal((await runtime.jobStatus({ jobId: runningJobId })).state, 'running');
    assert.equal((await runtime.jobStatus({ jobId: finishedJobId })).state, 'completed');
    assert.equal((await runtime.capabilities()).phase, 'rendering', 'the renderer stays leased to the running job');
  } finally { await runtime.close(); }
});

runTest('a tool blocked by a render job names the job, how far it is and the tools to call next (#2050)', async () => {
  const runningJobId = randomUUID();
  const records = [{ jobId: runningJobId, state: 'running', progress: { frames: 3, maximumPendingFrames: 1 }, settings: { frameCount: 24 } }];
  const controller = { list: () => records, status: jobId => records.find(record => record.jobId === jobId), close: async () => {}, submit: async () => ({ jobId: runningJobId }) };
  const { runtime, sessionId } = await reviewRuntimeHarness({
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async () => controller } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    for (const blocked of [() => runtime.look({ sessionId }), () => runtime.dispose({ sessionId }), () => runtime.exportGlb({ sessionId })]) {
      await assert.rejects(blocked(), error => {
        assert.ok(error.message.includes(runningJobId), error.message);
        assert.match(error.message, /running \(frame 3 of 24\)/);
        assert.match(error.message, /scene_render_status.*scene_render_cancel/);
        return true;
      });
    }
  } finally { await runtime.close(); }
});

async function runOversizeJob({ requested, jobRender, memory }) {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, viewports } = await reviewRuntimeHarness({ jobRender,
    runtimeOptions: { memory, jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', ...requested } });
    const outcome = await runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', ...requested }, signal: new AbortController().signal, progress: async () => {} }).then(() => undefined, error => error);
    return { outcome, viewports };
  } finally { await runtime.close(); }
}

runTest('a job frame over 1920x1080 that --memory shrinks is refused with the memory it needs, a 1080p one is only reduced (#1241)', async () => {
  const plan = { width: 1920, height: 1080, samples: 4, hdr: false, bloom: true, depth: false, estimatedBytes: estimateFrameBytes(1920, 1080, 4, 2048, { bloom: true }) };
  const oversize = await runOversizeJob({ requested: { width: 2880, height: 1620 }, jobRender: plan, memory: 192 });
  assert.match(oversize.outcome.message, /2880x1620 was reduced to 1920x1080 by --memory 192.*Fix: start the server with --memory 257 or more/);
  assert.deepEqual(oversize.viewports, [], 'the page is never resized for a refused frame');
  const standard = await runOversizeJob({ requested: { width: 1920, height: 1080 }, jobRender: { ...plan, width: 960, height: 540 }, memory: 192 });
  assert.doesNotMatch(String(standard.outcome?.message), /was reduced to/);
  assert.deepEqual(JSON.parse(JSON.stringify(standard.viewports)), [{ width: 960, height: 540 }]);
});

const NON_INDEXED_INSPECTION = vertices => ({ counts: { parts: 1, vertices, materials: 1 }, nodes: [], look: {} });

async function submitWithInspection(inspection, settings, backend) {
  const submitted = [];
  const controller = { list: () => [], close: async () => {}, submit: async request => { submitted.push(request); return { jobId: 'job' }; } };
  const { runtime, sessionId } = await reviewRuntimeHarness({ inspection,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test'), ...(backend ? { backend } : {}) },
    contextOverrides: { createAgentRenderJobs: async () => controller } });
  try {
    const attempt = await runtime.submitJob({ sessionId, expectedRevision: 0, settings }).then(() => undefined, error => error);
    return { attempt, submitted, phase: (await runtime.capabilities()).phase };
  } finally { await runtime.close(); }
}

runTest('submitJob refuses a path trace over the cpu triangle cap with the count, creates no job and stays ready (#1325)', async () => {
  const rejected = await submitWithInspection(NON_INDEXED_INSPECTION(1700000), { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer' } });
  assert.match(rejected.attempt?.message ?? '', /about 850000 triangles and the cpu path tracer takes at most 400000/);
  assert.match(rejected.attempt.message, /this runtime has no GPU backend/);
  assert.equal(rejected.submitted.length, 0);
  assert.equal(rejected.phase, 'ready');
});

runTest('submitJob accepts the same oversized scene as a raster job, with backend gpu, and a non-indexed scene under the cap (#1325)', async () => {
  const raster = await submitWithInspection(NON_INDEXED_INSPECTION(1700000), { kind: 'image', width: 64, height: 64 });
  assert.equal(raster.attempt, undefined);
  assert.equal(raster.submitted.length, 1);
  const gpu = await submitWithInspection(NON_INDEXED_INSPECTION(1700000), { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', backend: 'gpu' } }, 'gpu');
  assert.equal(gpu.attempt, undefined);
  assert.equal(gpu.submitted.length, 1);
  // 1,150,000 vertices without indices are about 383,000 real triangles; the estimate says 575,000, inside the safety margin.
  const borderline = await submitWithInspection(NON_INDEXED_INSPECTION(1150000), { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer' } });
  assert.equal(borderline.attempt, undefined);
  assert.equal(borderline.submitted.length, 1);
});

runTest('submitJob refuses a scene of plain nodes whose exact count is over the cap even inside the safety margin (#1325)', async () => {
  // 455,168 listed triangles are exact; the vertex-based estimate (3 vertices each, halved) says 682,752, under the 800,000 margin.
  const exactNodes = Array.from({ length: 4 }, (_, index) => ({ id: `node-${index}`, triangles: 113792 }));
  const inspection = { counts: { parts: 4, vertices: 455168 * 3, materials: 1 }, nodes: exactNodes, look: {} };
  const rejected = await submitWithInspection(inspection, { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer' } });
  assert.match(rejected.attempt?.message ?? '', /this scene has 455168 triangles and the cpu path tracer takes at most 400000/);
  assert.equal(rejected.submitted.length, 0);
  assert.equal(rejected.phase, 'ready');
  const underCap = { ...inspection, nodes: exactNodes.map(node => ({ ...node, triangles: 90000 })) };
  const accepted = await submitWithInspection(underCap, { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer' } });
  assert.equal(accepted.attempt, undefined);
});

runTest('submitJob refuses stills estimated over the combined output byte budget before rendering (#2199)', async () => {
  const rejected = await submitWithInspection(NON_INDEXED_INSPECTION(100), {
    kind: 'stills', width: 1280, height: 720, fps: 24, stillCount: 288, quality: 'realtime-high',
  });
  assert.match(rejected.attempt?.message ?? '', /combined output byte budget/);
  assert.match(rejected.attempt?.message ?? '', /224 frames/);
  assert.equal(rejected.submitted.length, 0);
  assert.equal(rejected.phase, 'ready');
});

runTest('a slow suspend at job start does not fail the runtime (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockPrivateCreate: true, suspendDelayMs: 100, deadlineMs: 40,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('Render job exceeded its elapsed deadline.')), 150);
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: abortController.signal, progress: async () => {} }));
    assert.ok(events.includes('source:suspend'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('a failed runtime starts fresh for the next scene, while other calls still say it is failed (#1256)', async () => {
  const { runtime, sessionId, disconnectBrowser } = await reviewRuntimeHarness();
  try {
    disconnectBrowser();
    await assert.rejects(runtime.inspect({ sessionId }), /browser disconnected.*scene_create/s);
    assert.equal((await runtime.capabilities()).phase, 'failed');
    await assert.rejects(runtime.inspect({ sessionId }), /The agent runtime is failed.*scenes.*lost.*scene_create.*scene_create_asset.*no server restart/s);
    const fresh = await runtime.create({ recipe: { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] } });
    assert.notEqual(fresh.sessionId, sessionId);
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
    await assert.rejects(runtime.apply({ sessionId }), /session|scene/i);
  } finally { await runtime.close(); }
});

const FRESH_RECIPE = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] };

runTest('a scene page that times out fails the runtime with the recovery hint, and the next scene starts fresh (#1256)', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ hangMethod: 'inspect', deadlineMs: 40 });
  try {
    await assert.rejects(runtime.inspect({ sessionId }), error => /exceeded.*scene_create.*no server restart/s.test(error.message) && !/must be closed/.test(error.message));
    assert.equal((await runtime.capabilities()).phase, 'failed');
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a timed-out preview call names the operation that ran long (#2200)', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ hangMethod: 'apply', deadlineMs: 40 });
  try {
    await assert.rejects(runtime.apply({ sessionId, operations: [{ type: 'add-material', material: { id: 'stone', pattern: 'stone' } }, { type: 'add-material', material: { id: 'tiles', pattern: 'tiles' } }] }),
      /operation "apply" \(2 operations: add-material\) exceeded 0\.04 seconds/);
  } finally { await runtime.close(); }
});

runTest('the next scene_create after a timeout succeeds first try even when the old browser never finishes closing (#2200)', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ hangMethod: 'inspect', deadlineMs: 40, hangBrowserClose: true, closeTimeoutMs: 30 });
  try {
    await assert.rejects(runtime.inspect({ sessionId }), /operation "inspect" exceeded.*scene_create/s);
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a browser start whose page load times out is retried once on a fresh browser (#2200)', async () => {
  const harness = await reviewRuntimeHarness({ failFirstGoto: true });
  try {
    assert.equal(typeof harness.sessionId, 'string');
  } finally { await harness.runtime.close(); }
});

runTest('a job whose page navigates under it fails with the page loss and the budget, then the next scene works (#2198)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const submitted = { kind: 'video', width: 1280, height: 720, fps: 24, duration: 12 };
  const settings = { ...submitted, frameCount: 288 };
  const { runtime, sessionId } = await reviewRuntimeHarness({ failPrivateCreate: true, disposeLostBridge: true,
    failPrivateCreateMessage: 'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test'), memory: 192 },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: submitted });
    const failure = await runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} }, settings,
      signal: new AbortController().signal, progress: async () => {} }).then(() => assert.fail('the job must fail'), error => error);
    assert.match(failure.message, /preview page navigated or reloaded before the first frame at 1280x720/);
    assert.match(failure.message, /raise --memory \(now 192 MiB\)/);
    assert.doesNotMatch(failure.message, /reading 'dispose'/);
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a job that fails for its own reason is not masked by a lost page bridge on dispose (#2198)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId } = await reviewRuntimeHarness({ failPrivateCreate: true, disposeLostBridge: true, failPrivateCreateMessage: 'Injected scene problem',
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const failure = await runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: new AbortController().signal, progress: async () => {} }).then(() => assert.fail('the job must fail'), error => error);
    assert.match(failure.message, /Injected scene problem/);
  } finally { await runtime.close(); }
});

runTest('a job whose scene was never created reports the create failure, not "No scene is active" from the cleanup (#2198)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const harness = await reviewRuntimeHarness({ failPrivateCreate: true, disposeWithoutScene: true, failPrivateCreateMessage: 'Injected particles problem',
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  const { runtime, sessionId } = harness;
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const failure = await runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: new AbortController().signal, progress: async () => {} }).then(() => assert.fail('the job must fail'), error => error);
    assert.match(failure.message, /Injected particles problem/);
    assert.doesNotMatch(failure.message, /No scene is active/);
  } finally { await runtime.close(); }
});

runTest('a failed resume after a render job fails the runtime, and the next scene starts fresh (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId } = await reviewRuntimeHarness({ failResume: true, failPrivateCreate: true,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: new AbortController().signal, progress: async () => {} }), /Preview recovery failed after render job/);
    assert.equal((await runtime.capabilities()).phase, 'failed');
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a browser lost under a stills job fails the job with its size and limit, and the runtime recovers (#2018)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const submitted = { kind: 'stills', width: 1920, height: 1080, stillCount: 12, fps: 24, passes: ['depth'] };
  const settings = { ...submitted, frameCount: 12 };
  const { runtime, sessionId } = await reviewRuntimeHarness({ failPrivateCreate: true, failPrivateCreateMessage: 'Target page, context or browser has been closed', failResume: true,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test'), memory: 1024 },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: submitted });
    const failure = await runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} }, settings,
      signal: new AbortController().signal, progress: async () => {} }).then(() => assert.fail('the job must fail'), error => error);
    assert.match(failure.message, /preview browser crashed before the first frame at 1920x1080 with depth pass/);
    assert.match(failure.message, /Lower the size or the frame count, or raise --memory \(now \d+ MiB\)/);
    assert.doesNotMatch(failure.message, /Preview recovery failed/);
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a stills job that fails for another reason keeps its own message (#2018)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const submitted = { kind: 'stills', width: 64, height: 64, stillCount: 2, fps: 24 };
  const settings = { ...submitted, frameCount: 2 };
  const { runtime, sessionId } = await reviewRuntimeHarness({ failPrivateCreate: true, failPrivateCreateMessage: 'Injected scene problem',
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: submitted });
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} }, settings,
      signal: new AbortController().signal, progress: async () => {} }), /^Error: Injected scene problem$/);
  } finally { await runtime.close(); }
});

runTest('a job still unwinding when the runtime restarts does not fail the new runtime (#1256)', async () => {
  let runJob;
  let openGate;
  const disposeGate = new Promise(resolve => { openGate = resolve; });
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, disconnectBrowser, events } = await reviewRuntimeHarness({ failPrivateCreate: true, disposeGate,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const settled = runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: new AbortController().signal, progress: async () => {} }).catch(error => error);
    while (!events.includes('private:dispose')) await new Promise(resolve => setImmediate(resolve));
    disconnectBrowser();
    await assert.rejects(runtime.inspect({ sessionId }), /browser disconnected/);
    const fresh = await runtime.create({ recipe: FRESH_RECIPE });
    openGate();
    assert.match((await settled).message, /Injected private create failure/);
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId: fresh.sessionId })).revision, 1);
  } finally { openGate(); await runtime.close(); }
});

runTest('runJob starts the render clock once, after the page handoff has finished (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId } = await reviewRuntimeHarness({ suspendDelayMs: 60, failPrivateCreate: true,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const startedAt = performance.now();
    const clockCalls = [];
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: new AbortController().signal, progress: async () => {},
      startRenderClock: () => clockCalls.push(performance.now() - startedAt) }), /Injected private create failure/);
    assert.equal(clockCalls.length, 1);
    assert.ok(clockCalls[0] >= 55, `the clock started ${clockCalls[0]} ms in, before the 60 ms handoff ended`);
  } finally { await runtime.close(); }
});

runTest('private disposal failure still closes its page before restoring source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ failDispose: true });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /disposal failure/);
    assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('review stale revisions and strict runtime fields reject before leasing source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness();
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 1, shots: [{}] }), /Stale/);
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{ url: 'https://example.com' }] }), /Review shot field not accepted: url/);
    assert.ok(!events.includes('source:suspend'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('runtime close promptly aborts a pending private review and skips source resume', async () => {
  const { runtime, sessionId, events, shotStarted } = await reviewRuntimeHarness({ blockShot: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  const rejected = assert.rejects(pending, /closed/);
  await startedOrFailed(shotStarted, pending);
  assert.equal((await runtime.capabilities()).phase, 'reviewing');
  await runtime.close();
  await rejected;
  assert.ok(events.includes('private:close'));
  assert.ok(events.includes('browser:close'));
  assert.ok(!events.includes('source:resume'));
  assert.equal((await runtime.capabilities()).phase, 'closed');
});

runTest('invalid preview configuration rejects before any browser or renderer allocation', () => {
  assert.throws(() => createAgentRuntime({ backend: 'fake' }), /backend/);
  for (const memory of [0, 31, 385, 1024, 64.5, NaN]) {
    assert.throws(() => createAgentRuntime({ memory, totalMemoryBytes: 512 * 1024 ** 2 }), /memory/);
  }
  assert.throws(() => createAgentRuntime({ memory: 2049, totalMemoryBytes: 4 * 1024 ** 3 }), /from 32 to 2048 MiB on this machine/);
  assert.throws(() => createAgentRuntime({ browser: 'does-not-exist-browser.exe' }), /browser/);
  assert.throws(() => createAgentRuntime({ assets: 'relative-path' }), /absolute/);
});

runTest('requests cannot address an absent session or enter a closing runtime', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(runtime.inspect({ sessionId: 'missing' }), /Unknown|No scene is active/);
  await assert.rejects(runtime.look({ sessionId: 'missing' }), /Unknown|No scene is active/);
  const closing = runtime.close();
  await assert.rejects(runtime.checkpoint({ sessionId: 'missing' }), /closing|closed/);
  await closing;
});

runTest('runtime close settles a pending scene_ask_user at once and stops its page server (#1246)', async () => {
  let sessionSignal;
  const waitForSignal = async ({ signal }) => {
    sessionSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true }));
  };
  const { runtime, sessionId } = await reviewRuntimeHarness({ contextOverrides: { runAnnotateSession: waitForSignal } });
  const asking = runtime.askUser({ sessionId, timeoutSeconds: 600 });
  const askingOutcome = asking.then(() => 'resolved', error => error.message);
  while (!sessionSignal) await new Promise(resolve => setTimeout(resolve, 5));
  const started = performance.now();
  await runtime.close();
  assert.match(await askingOutcome, /closed|closing/);
  assert.ok(sessionSignal.aborted);
  assert.ok(performance.now() - started < 3000);
});

runTest('a scene_ask_user fixture answers without a browser, in the same shape as the browser answer, and unset changes nothing (#1956)', async () => {
  const fixtureMarks = [{ x: 384, y: 256, note: 'make this red' }, { x: 40, y: 60, note: 'and this' }];
  let browserSessions = 0;
  const browserAnswer = async () => {
    browserSessions++;
    return { outcome: 'sent', marks: fixtureMarks, image: ANNOTATE_PNG };
  };
  const browser = await reviewRuntimeHarness({ contextOverrides: { runAnnotateSession: browserAnswer } });
  const fromBrowser = await browser.runtime.askUser({ sessionId: browser.sessionId });
  assert.equal(browserSessions, 1, 'without the fixture the browser flow runs');

  const fixture = await reviewRuntimeHarness({
    runtimeOptions: { askUserFixture: { name: 'pin.json', marks: fixtureMarks } },
    contextOverrides: { runAnnotateSession: browserAnswer } });
  const fromFixture = await fixture.runtime.askUser({ sessionId: fixture.sessionId });
  assert.equal(browserSessions, 1, 'with the fixture no browser session opens');

  assert.equal(fromFixture.content.outcome, 'sent');
  assert.equal(fromFixture.content.marks[0].note, 'make this red');
  assert.equal(fromFixture.content.marks[0].partId, 'lamp');
  assert.equal(fromFixture.content.marks[1].partId, null);
  assert.equal(typeof fromFixture.image, 'string');
  assert.deepEqual(Object.keys(fromFixture), Object.keys(fromBrowser));
  // The runtime runs in a vm, so compare the JSON the tool sends, as the MCP server does.
  const asSent = answer => JSON.parse(JSON.stringify(answer.content));
  assert.deepEqual(asSent(fromFixture), { ...asSent(fromBrowser), sessionId: fixture.sessionId });
  const inline = await fixture.runtime.askUser({ sessionId: fixture.sessionId, inline: true });
  assert.equal(inline.content.outcome, 'sent', 'an inline ask is answered by the fixture too');
  await assert.rejects(fixture.runtime.askUser({ sessionId: fixture.sessionId, maxMarks: 1 }), /at most 1 marks/);
});

runTest('a lasso mark resolves to the parts under its outline, through the same pick as a pin, and a lasso over sky has none (#922)', async () => {
  const wholeView = [[0, 0], [768, 0], [768, 512], [0, 512]];
  const skyCorner = [[10, 10], [60, 10], [60, 100], [10, 100]];
  const fixture = await reviewRuntimeHarness({
    runtimeOptions: { askUserFixture: { name: 'lasso.json', marks: [
      { kind: 'lasso', points: wholeView, note: 'make these blue' }, { kind: 'lasso', points: skyCorner, note: 'nothing here' }, { x: 384, y: 256, note: 'a pin' }] } } });
  const answer = JSON.parse(JSON.stringify((await fixture.runtime.askUser({ sessionId: fixture.sessionId })).content));
  const [whole, corner, pin] = answer.marks;
  assert.equal(whole.kind, 'lasso');
  assert.deepEqual(whole.points, wholeView);
  assert.equal(whole.note, 'make these blue');
  assert.equal(whole.partId, 'lamp');
  assert.deepEqual(whole.parts.map(part => part.partId), ['lamp']);
  assert.ok(whole.parts[0].coverage > 0.5 && whole.parts[0].coverage < 1, 'the left of the view is sky, so the lamp covers only part of the outline');
  assert.equal(whole.parts[0].material, 'brass');
  assert.equal(corner.partId, null);
  assert.deepEqual(corner.parts, []);
  assert.equal('kind' in pin, false, 'a pin keeps its old shape');
  assert.equal(pin.partId, 'lamp');
  const pickCall = fixture.sourceCalls.find(call => call.method === 'pickMarks');
  assert.equal(pickCall.input.marks[0].kind, 'lasso', 'the lasso reaches the page as an outline, not as a pixel');
});

runTest('an inline scene_ask_user hands its nonce to the view only and resolves marks once (#923)', async () => {
  let browserSessions = 0;
  const { runtime, sessionId } = await reviewRuntimeHarness({ contextOverrides: { runAnnotateSession: async () => { browserSessions++; return { outcome: 'timeout' }; } } });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]).toString('base64');
  const pending = await runtime.askUser({ sessionId, inline: true, prompt: 'Pin it' });
  assert.equal(browserSessions, 0, 'an inline ask opens no browser page');
  assert.equal(pending.content.outcome, 'pending');
  assert.equal(pending.content.prompt, 'Pin it');
  const { nonce } = pending.viewMeta;
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(pending.content).includes(nonce), 'the nonce is not in what the model reads');
  assert.deepEqual([pending.content.view.width, pending.content.view.height], [768, 512]);
  assert.ok(pending.image);
  await assert.rejects(runtime.submitAskUser({ nonce: 'f'.repeat(32), marks: [{ x: 5, y: 5 }], image: png }), /only accepts the marks of an open annotate view/);
  await assert.rejects(runtime.submitAskUser({ nonce, marks: [{ x: 5000, y: 5, note: 'outside' }], image: png }), /x must be a pixel from 0 to 768/);
  await assert.rejects(runtime.submitAskUser({ nonce, marks: [], image: png }), /at least one pin/);
  await assert.rejects(runtime.submitAskUser({ nonce, marks: [{ x: 5, y: 5, note: 'dull' }], image: 'not a png' }), /PNG/);
  const sent = await runtime.submitAskUser({ nonce, marks: [{ x: 384, y: 256, note: ' dull ' }], image: png });
  assert.equal(sent.content.outcome, 'sent');
  assert.equal(sent.content.marks[0].partId, 'lamp');
  assert.equal(sent.content.marks[0].note, 'dull');
  assert.equal(sent.image, png);
  assert.deepEqual(Object.keys(sent.content).sort(), ['marks', 'outcome', 'revision', 'sessionId', 'view']);
  await assert.rejects(runtime.submitAskUser({ nonce, marks: [{ x: 5, y: 5 }], image: png }), /only accepts the marks of an open annotate view/);
  await runtime.close();
});

runTest('scene_ask_user draws the view at motionTime, names it in the answer and puts the scene back there to pick the marks (#922)', async () => {
  const { runtime, sessionId, sourceCalls } = await reviewRuntimeHarness({ contextOverrides: { runAnnotateSession: async () => ({ outcome: 'sent', image: ANNOTATE_PNG, marks: [{ x: 384, y: 256, note: 'too bright now' }] }) } });
  const sent = await runtime.askUser({ sessionId, motionTime: 2.5 });
  assert.equal(sourceCalls.find(call => call.method === 'annotateFrame').input.motionTime, 2.5);
  assert.equal(sourceCalls.find(call => call.method === 'pickMarks').input.motionTime, 2.5);
  assert.equal(sent.content.view.motionTime, 2.5);
  assert.equal(sent.content.marks[0].partId, 'lamp');
  const still = await runtime.askUser({ sessionId });
  assert.equal('motionTime' in still.content.view, false, 'a view with no time leaves the field out');
  assert.equal('motionTime' in sourceCalls.filter(call => call.method === 'pickMarks').at(-1).input, false);
  await runtime.close();
});

runTest('an inline ask times out, and dispose and close forget it (#923)', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]).toString('base64');
  const { runtime, sessionId } = await reviewRuntimeHarness();
  const expired = await runtime.askUser({ sessionId, inline: true, timeoutSeconds: 0.05 });
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(runtime.submitAskUser({ nonce: expired.viewMeta.nonce, marks: [{ x: 5, y: 5 }], image: png }), /timed out before the marks were sent/);
  const disposed = await runtime.askUser({ sessionId, inline: true });
  await runtime.dispose({ sessionId });
  await assert.rejects(runtime.submitAskUser({ nonce: disposed.viewMeta.nonce, marks: [{ x: 5, y: 5 }], image: png }), /only accepts the marks of an open annotate view/);
  const { runtime: otherRuntime, sessionId: otherSession } = await reviewRuntimeHarness();
  const open = await otherRuntime.askUser({ sessionId: otherSession, inline: true });
  await otherRuntime.close();
  await assert.rejects(otherRuntime.submitAskUser({ nonce: open.viewMeta.nonce, marks: [{ x: 5, y: 5 }], image: png }), /only accepts the marks of an open annotate view/);
  await runtime.close();
});

runTest('a failed browser launch leaves the runtime idle so the next call retries (#1246)', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64, browser: process.execPath });
  after(() => runtime.close());
  const first = await runtime.create({ recipe: {} }).then(() => undefined, error => error.message);
  assert.ok(first, 'a node executable is not a browser, so the first launch must fail');
  assert.equal((await runtime.capabilities()).phase, 'idle');
  const second = await runtime.create({ recipe: {} }).then(() => undefined, error => error.message);
  assert.ok(second);
  assert.doesNotMatch(second, /The agent runtime is failed/);
});

runTest('a recipe over the combined asset limit is refused from file sizes before any grid file is read (#1246)', async () => {
  const gridDirectory = await mkdtemp(join(tmpdir(), 'crucible-grid-limit-'));
  const previousDirectory = process.env.JS67_GRID_DIRECTORY;
  process.env.JS67_GRID_DIRECTORY = gridDirectory;
  after(async () => {
    if (previousDirectory === undefined) delete process.env.JS67_GRID_DIRECTORY;
    else process.env.JS67_GRID_DIRECTORY = previousDirectory;
    await rm(gridDirectory, { recursive: true, force: true });
  });
  const frameBytes = 40 * 1024 * 1024;
  for (const name of ['first.67vg', 'second.67vg']) {
    await writeFile(join(gridDirectory, name), '');
    await truncate(join(gridDirectory, name), frameBytes);
  }
  let gridReads = 0;
  const countingRead = (...argumentsList) => {
    gridReads++;
    return readVolumeGridFiles(...argumentsList);
  };
  const { runtime } = await reviewRuntimeHarness({ contextOverrides: { readVolumeGridFiles: countingRead } });
  gridReads = 0;
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { localVolumes: [{ shape: 'grid', frames: ['first.67vg', 'second.67vg'] }] } };
  await assert.rejects(runtime.create({ recipe }), error => error instanceof RangeError
    && error.message.includes('maxCombinedBytes') && error.message.includes(String(2 * frameBytes)));
  assert.equal(gridReads, 0);
});

// A catalog that reports sizes and counts how often a file is read, so a test can prove a call was refused before any read.
function countingCatalog(sizeByAssetId) {
  const counts = { sizeCalls: 0, reads: 0 };
  const catalog = {
    counts,
    list: () => ({ assets: [] }),
    size: async assetId => {
      counts.sizeCalls++;
      return sizeByAssetId[assetId];
    },
    describeSize: async assetId => ({ name: `${assetId.slice(0, 4)}.glb`, bytes: await catalog.size(assetId) }),
    read: async () => {
      counts.reads++;
      return Buffer.alloc(0);
    },
  };
  return catalog;
}

const catalogAssetIds = ['a', 'b', 'c'].map(letter => letter.repeat(64));

async function catalogLimitHarness(sizeEach, exportedRecipe) {
  const catalog = countingCatalog(Object.fromEntries(catalogAssetIds.map(assetId => [assetId, sizeEach])));
  const harness = await reviewRuntimeHarness({
    exportedRecipe,
    runtimeOptions: { assets: join(tmpdir(), 'crucible-counting-catalog') },
    contextOverrides: { createAgentAssetCatalog: async () => catalog },
  });
  catalog.counts.sizeCalls = 0;
  return { ...harness, catalog };
}

function refusedAtTotal(total) {
  return error => error instanceof RangeError && error.message.includes('maxCombinedBytes') && error.message.includes(String(total));
}

runTest('placed catalog assets over the combined limit are refused from sizes before any read (#1246)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, catalog } = await catalogLimitHarness(sizeEach);
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [],
    nodes: catalogAssetIds.map((assetId, index) => ({ id: `placed-${index}`, asset: { id: assetId } })) };
  await assert.rejects(runtime.create({ recipe }), error => refusedAtTotal(3 * sizeEach)(error) && /Largest: aaaa.glb 30.0 MiB, bbbb.glb 30.0 MiB, cccc.glb 30.0 MiB./.test(error.message) && error.message.includes("gltf-transform simplify"));
  assert.equal(catalog.counts.sizeCalls, 3);
  assert.equal(catalog.counts.reads, 0);
});

runTest('map sequence frames over the combined limit are refused from sizes before any read (#1246)', async () => {
  const sizeEach = 40 * 1024 * 1024;
  const { runtime, catalog } = await catalogLimitHarness(sizeEach);
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], nodes: [],
    materials: [{ id: 'screen', map: { sequence: { frames: catalogAssetIds.slice(0, 2), fps: 24 } } }] };
  await assert.rejects(runtime.create({ recipe }), refusedAtTotal(2 * sizeEach));
  assert.equal(catalog.counts.reads, 0);
});

runTest('motion source assets count in the sum before a scene_apply reads them (#1246)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, catalog } = await catalogLimitHarness(sizeEach);
  const motion = { layers: catalogAssetIds.map(assetId => ({ from: { asset: assetId } })) };
  await assert.rejects(runtime.apply({ sessionId, operations: [{ type: 'set-motion', motion }] }), refusedAtTotal(3 * sizeEach));
  assert.equal(catalog.counts.reads, 0);
});

// A scene that already holds assets: scene_apply add-node must count them with the new ones, since a render job loads the whole scene at once (#1771).
function sceneHolding(...assetIds) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [],
    nodes: assetIds.map((assetId, index) => ({ id: `held-${index}`, asset: { id: assetId } })) };
}

function addNodes(assetId, count) {
  return Array.from({ length: count }, (_, index) => ({ type: 'add-node', node: { id: `added-${index}`, asset: { id: assetId } } }));
}

runTest('scene_apply refuses an add-node that pushes the scene past the combined limit (#1771)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, catalog, events } = await catalogLimitHarness(sizeEach, sceneHolding(catalogAssetIds[0], catalogAssetIds[1]));
  await assert.rejects(runtime.apply({ sessionId, operations: addNodes(catalogAssetIds[2], 1) }), error => refusedAtTotal(3 * sizeEach)(error)
    && error.message.includes('scene'));
  assert.equal(catalog.counts.reads, 0);
  assert.equal(events.includes('source:apply'), false, 'the preview page never receives the refused edit');
});

runTest('scene_apply accepts an add-node while the scene stays under the combined limit (#1771)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, events } = await catalogLimitHarness(sizeEach, sceneHolding(catalogAssetIds[0]));
  await runtime.apply({ sessionId, operations: addNodes(catalogAssetIds[1], 1) });
  assert.ok(events.includes('source:apply'));
});

runTest('one asset placed many times counts once in the scene total (#1771)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, events } = await catalogLimitHarness(sizeEach, sceneHolding(catalogAssetIds[0], catalogAssetIds[1]));
  await runtime.apply({ sessionId, operations: addNodes(catalogAssetIds[0], 7) });
  assert.ok(events.includes('source:apply'));
});

runTest('grid files the scene already holds count toward the combined limit in scene_apply (#1848)', async () => {
  const gridDirectory = await mkdtemp(join(tmpdir(), 'crucible-scene-grid-'));
  const previousDirectory = process.env.JS67_GRID_DIRECTORY;
  process.env.JS67_GRID_DIRECTORY = gridDirectory;
  after(async () => {
    if (previousDirectory === undefined) delete process.env.JS67_GRID_DIRECTORY;
    else process.env.JS67_GRID_DIRECTORY = previousDirectory;
    await rm(gridDirectory, { recursive: true, force: true });
  });
  const gridBytes = 40 * 1024 * 1024;
  await writeFile(join(gridDirectory, 'held.67vg'), '');
  await truncate(join(gridDirectory, 'held.67vg'), gridBytes);
  const sceneWithGrid = { ...sceneHolding(), environment: { localVolumes: [{ shape: 'grid', grid: 'held.67vg' }] } };
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, events } = await catalogLimitHarness(sizeEach, sceneWithGrid);
  await assert.rejects(runtime.apply({ sessionId, operations: addNodes(catalogAssetIds[0], 1) }), refusedAtTotal(gridBytes + sizeEach));
  assert.equal(events.includes('source:apply'), false);
});

// A scene over the cap reaches a render job through an export or an older edit. The job must refuse it before the scene page is
// suspended, because recovery would reload every asset into the page and crash it (#1848).
async function overCapJobHarness() {
  const sizeEach = 30 * 1024 * 1024;
  const catalog = countingCatalog(Object.fromEntries(catalogAssetIds.map(assetId => [assetId, sizeEach])));
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const harness = await reviewRuntimeHarness({
    runtimeOptions: { assets: join(tmpdir(), 'crucible-counting-catalog'), jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentAssetCatalog: async () => catalog, createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } },
  });
  await harness.runtime.submitJob({ sessionId: harness.sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
  const runOverCapJob = () => runJob({ jobId: randomUUID(), sessionId: harness.sessionId, directory: tmpdir(),
    snapshot: { recipe: sceneHolding(...catalogAssetIds) }, settings: { kind: 'image', width: 64, height: 64 },
    signal: new AbortController().signal, progress: async () => {} });
  return { ...harness, catalog, runOverCapJob, sizeEach };
}

runTest('a render job of a scene over the combined limit fails with the cap message and leaves the scene page alone (#1848)', async () => {
  const { runtime, events, catalog, runOverCapJob, sizeEach } = await overCapJobHarness();
  try {
    await assert.rejects(runOverCapJob(), error => refusedAtTotal(3 * sizeEach)(error) && error.message.includes('scene'));
    assert.equal(events.includes('source:suspend'), false, 'the scene page keeps its renderer');
    assert.equal(events.includes('source:resume'), false, 'no recovery reload of the over-cap scene');
    assert.equal(catalog.counts.reads, 0);
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

// A recipe that names a catalog file instead of its SHA-256 id (#1843): the id changes on every re-export, the name does not.
async function namedAssetHarness(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-named-assets-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('./fixtures/kenney-boat/', import.meta.url), directory, { recursive: true });
  await writeFile(join(directory, 'sheep_body.glb'), withDistinctDocument(await readFile(join(directory, 'boat-fishing-small.glb')), 'sheep'));
  const realCatalog = await createAgentAssetCatalog(directory);
  const sheepId = realCatalog.list().assets.find(asset => asset.name === 'sheep_body.glb').assetId;
  const readIds = [];
  const recordingCatalog = {
    list: () => realCatalog.list(),
    size: assetId => realCatalog.size(assetId),
    describeSize: assetId => realCatalog.describeSize(assetId),
    resolveName: name => realCatalog.resolveName(name),
    read: assetId => {
      readIds.push(assetId);
      return realCatalog.read(assetId);
    },
  };
  const harness = await reviewRuntimeHarness({
    runtimeOptions: { assets: directory },
    contextOverrides: { createAgentAssetCatalog: async () => recordingCatalog },
  });
  return { ...harness, sheepId, readIds };
}

function recipePlacing(placement) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [{ id: 'sheep0-body', asset: placement }] };
}

runTest('scene_create places a catalog GLB by file name and keeps only its hash (#1843)', async context => {
  const { runtime, sourceCalls, sheepId, readIds } = await namedAssetHarness(context);
  await runtime.create({ recipe: recipePlacing({ name: 'sheep_body.glb' }) });
  const createCall = sourceCalls.filter(call => call.method === 'create').at(-1);
  assert.deepEqual(createCall.input.recipe.nodes[0].asset, { id: sheepId });
  assert.deepEqual(readIds, [sheepId]);
});

runTest('scene_apply add-node places a catalog GLB by file name (#1843)', async context => {
  const { runtime, sessionId, sourceCalls, sheepId } = await namedAssetHarness(context);
  await runtime.apply({ sessionId, operations: [{ type: 'add-node', node: { id: 'sheep1-body', asset: { name: 'sheep_body.glb' } } }] });
  const applyCall = sourceCalls.filter(call => call.method === 'apply').at(-1);
  assert.deepEqual(applyCall.input.operations[0].node.asset, { id: sheepId });
});

runTest('scene_apply with a branch sends the bytes of the catalog GLB it places (#2267)', async context => {
  const { runtime, sessionId, sourceCalls, sheepId } = await namedAssetHarness(context);
  await runtime.apply({ sessionId, branch: 'flock', operations: [{ type: 'add-node', node: { id: 'sheep1-body', asset: { name: 'sheep_body.glb' } } }] });
  const branchCall = sourceCalls.filter(call => call.method === 'branchApply').at(-1);
  assert.deepEqual(branchCall.input.operations[0].node.asset, { id: sheepId });
  assert.deepEqual(Object.keys(branchCall.input.assetData), [sheepId]);
});

runTest('an unknown asset name is refused with near names and the catalog tool to run (#1843)', async context => {
  const { runtime } = await namedAssetHarness(context);
  await assert.rejects(runtime.create({ recipe: recipePlacing({ name: 'sheep_body' }) }), /No catalog GLB is named "sheep_body".*"sheep_body\.glb"/);
  await assert.rejects(runtime.create({ recipe: recipePlacing({ name: 'wolf.glb' }) }), /Run scene_asset_catalog/);
});

runTest('an asset placement with both id and name is refused (#1843)', async context => {
  const { runtime, sheepId } = await namedAssetHarness(context);
  await assert.rejects(runtime.create({ recipe: recipePlacing({ id: sheepId, name: 'sheep_body.glb' }) }), /exactly one of id .* or name/);
});

runTest('scene_create_asset opens a catalog GLB by assetName and refuses assetName with assetId (#1843)', async context => {
  const { runtime, sourceCalls, sheepId } = await namedAssetHarness(context);
  const assetRecipe = { format: 'crucible.asset', schemaVersion: 1 };
  await runtime.createAsset({ recipe: { ...assetRecipe, assetName: 'sheep_body.glb' } });
  const createCall = sourceCalls.filter(call => call.method === 'createAsset').at(-1);
  assert.equal(createCall.input.recipe.assetId, sheepId);
  assert.equal(createCall.input.recipe.assetName, undefined);
  await assert.rejects(runtime.createAsset({ recipe: { ...assetRecipe, assetId: sheepId, assetName: 'sheep_body.glb' } }), /exactly one of recipe\.assetId/);
});

// Files that arrive or leave the --assets folder after the server started (#2209).
async function rescanHarness(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-rescan-assets-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('./fixtures/kenney-boat/', import.meta.url), directory, { recursive: true });
  const boatBytes = await readFile(join(directory, 'boat-fishing-small.glb'));
  await rm(join(directory, 'boat-fishing-small.glb'));
  await writeFile(join(directory, 'first.glb'), boatBytes);
  const harness = await reviewRuntimeHarness({ runtimeOptions: { assets: directory } });
  const addGlb = (name, marker) => writeFile(join(directory, name), withDistinctDocument(boatBytes, marker));
  return { ...harness, directory, addGlb };
}

function radianceFile() {
  return Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'), Buffer.alloc(2 * 4 * 4, 128)]);
}

const listedNames = async runtime => (await runtime.assetCatalog()).assets.map(asset => asset.name);

runTest('a GLB and an HDRI copied into --assets after start are listed by the next catalog call and placed by name (#2209)', async context => {
  const { runtime, sessionId, sourceCalls, directory, addGlb } = await rescanHarness(context);
  assert.deepEqual(await listedNames(runtime), ['first.glb']);
  await addGlb('downloaded.glb', 'downloaded');
  await writeFile(join(directory, 'sky.hdr'), radianceFile());
  const listing = await runtime.assetCatalog();
  assert.deepEqual(listing.assets.map(asset => asset.name).sort(), ['downloaded.glb', 'first.glb', 'sky.hdr']);
  const downloadedId = listing.assets.find(asset => asset.name === 'downloaded.glb').assetId;
  await runtime.apply({ sessionId, operations: [{ type: 'add-node', node: { id: 'new-boat', asset: { name: 'downloaded.glb' } } }] });
  assert.deepEqual(sourceCalls.filter(call => call.method === 'apply').at(-1).input.operations[0].node.asset, { id: downloadedId });
});

runTest('an asset name that appeared since the last catalog call is found without listing the catalog first (#2209)', async context => {
  const { runtime, sessionId, sourceCalls, addGlb } = await rescanHarness(context);
  await listedNames(runtime);
  await addGlb('late.glb', 'late');
  await runtime.apply({ sessionId, operations: [{ type: 'add-node', node: { id: 'late-boat', asset: { name: 'late.glb' } } }] });
  assert.equal(sourceCalls.filter(call => call.method === 'apply').at(-1).input.operations[0].node.asset.id.length, 64);
});

runTest('a file removed from --assets leaves the catalog and a rewritten file gets its new id (#2209)', async context => {
  const { runtime, directory, addGlb } = await rescanHarness(context);
  await addGlb('temporary.glb', 'one');
  const before = (await runtime.assetCatalog()).assets.find(asset => asset.name === 'temporary.glb').assetId;
  await addGlb('temporary.glb', 'two');
  const after = (await runtime.assetCatalog()).assets.find(asset => asset.name === 'temporary.glb').assetId;
  assert.notEqual(after, before);
  await rm(join(directory, 'temporary.glb'));
  assert.deepEqual(await listedNames(runtime), ['first.glb']);
});

// The same GLB with one extra field in its JSON chunk, so the catalog gives it another asset id.
function withDistinctDocument(bytes, marker) {
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  document.asset = { ...document.asset, extras: { marker } };
  const json = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const binary = bytes.subarray(20 + jsonLength);
  const result = Buffer.alloc(20 + paddedLength + binary.length, 32);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(paddedLength, 12);
  json.copy(result, 20);
  binary.copy(result, 20 + paddedLength);
  return result;
}

runTest('two textured GLBs whose embedded images pass the combined limit are refused by the real catalog (#1282)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-textured-limit-'));
  try {
    await cp(new URL('./fixtures/kenney-boat/', import.meta.url), directory, { recursive: true });
    const boat = await readFile(join(directory, 'boat-fishing-small.glb'));
    const secondBoat = withDistinctDocument(boat, 'second');
    await writeFile(join(directory, 'boat-second.glb'), secondBoat);
    const sharedImageBytes = Buffer.alloc(34 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(sharedImageBytes);
    await writeFile(join(directory, 'Textures', 'colormap.png'), sharedImageBytes);
    const onDiskTotal = boat.length + secondBoat.length + sharedImageBytes.length;
    assert.ok(onDiskTotal < AGENT_ASSET_LIMITS.maxCombinedBytes, 'on disk the files fit, so only the embedded sizes can trip the limit');
    const realCatalog = await createAgentAssetCatalog(directory);
    let reads = 0;
    const countingRealCatalog = {
      list: () => realCatalog.list(),
      size: assetId => realCatalog.size(assetId),
      describeSize: assetId => realCatalog.describeSize(assetId),
      read: assetId => {
        reads++;
        return realCatalog.read(assetId);
      },
    };
    const { runtime } = await reviewRuntimeHarness({
      runtimeOptions: { assets: directory },
      contextOverrides: { createAgentAssetCatalog: async () => countingRealCatalog },
    });
    const assetIds = realCatalog.list().assets.map(asset => asset.assetId);
    assert.equal(assetIds.length, 2);
    const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [],
      nodes: assetIds.map((assetId, index) => ({ id: `boat-${index}`, asset: { id: assetId } })) };
    await assert.rejects(runtime.create({ recipe }), error => error instanceof RangeError && error.message.includes('maxCombinedBytes'));
    assert.equal(reads, 0, 'the refusal comes from size() before any file is read and base64 encoded');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

runTest('the preview server accepts only its own loopback host', () => {
  assert.equal(isPreviewHost('127.0.0.1:4100', 4100), true);
  assert.equal(isPreviewHost('evil.example:4100', 4100), false);
  assert.equal(isPreviewHost('localhost:4100', 4100), false);
  assert.equal(isPreviewHost('127.0.0.1:4101', 4100), false);
  assert.equal(isPreviewHost(undefined, 4100), false);
});

async function webExportHarness({ exportedRecipe, failCopy = () => false, seedJobsDirectory, extraOverrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crucible-web-runtime-'));
  const buildDirectory = join(root, 'build');
  await mkdir(join(buildDirectory, 'mcp'), { recursive: true });
  await writeFile(join(buildDirectory, 'game.js'), 'export {};');
  const jobsDirectory = join(root, 'jobs');
  await mkdir(jobsDirectory);
  await seedJobsDirectory?.(jobsDirectory);
  const failingWriteWebBuild = async options => {
    if (failCopy()) {
      await mkdir(join(options.outputDirectory, 'engine'), { recursive: true });
      throw new Error('Injected copy failure');
    }
    return writeWebBuild(options);
  };
  const harness = await reviewRuntimeHarness({
    exportedRecipe,
    runtimeOptions: { jobs: jobsDirectory, previewUrl: pathToFileURL(join(buildDirectory, 'mcp', 'preview.js')) },
    contextOverrides: { writeWebBuild: failingWriteWebBuild, ...extraOverrides },
  });
  const keptBuilds = async () => (await readdir(join(jobsDirectory, EXPORT_DIRECTORY_NAME))).filter(name => name.startsWith('web-'));
  after(() => harness.runtime.close());
  return { ...harness, keptBuilds };
}

const PLAYABLE_RECIPE = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], game: { player: { node: 'creature' }, physics: false } };

runTest('exportWeb keeps only the newest four builds and returns a real entry page', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push((await runtime.exportWeb({ sessionId })).entry);
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(entries[0]), { code: 'ENOENT' });
  for (const entry of entries.slice(1)) assert.ok((await stat(entry)).isFile());
});

// Files and folders an earlier server run left in the exports folder, oldest first (modified one minute apart).
async function leaveEarlierExports(jobsDirectory, { glbCount, webBuildCount }) {
  const exportsDirectory = join(jobsDirectory, EXPORT_DIRECTORY_NAME);
  await mkdir(exportsDirectory);
  const names = [
    ...Array.from({ length: glbCount }, () => `${randomUUID()}.glb`),
    ...Array.from({ length: webBuildCount }, () => `web-${randomUUID()}`),
  ];
  const start = Date.now() / 1000 - 3600;
  for (const [index, name] of names.entries()) {
    const path = join(exportsDirectory, name);
    if (name.startsWith('web-')) await mkdir(path);
    else await writeFile(path, 'earlier glb');
    await utimes(path, start + index * 60, start + index * 60);
  }
  return names.map(name => join(exportsDirectory, name));
}

runTest('exports left by an earlier run count toward the newest four web builds and eight GLBs (#1246)', async () => {
  let earlier;
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE,
    seedJobsDirectory: async directory => { earlier = await leaveEarlierExports(directory, { glbCount: 8, webBuildCount: 4 }); } });
  const glbEarlier = earlier.filter(path => path.endsWith('.glb'));
  const webEarlier = earlier.filter(path => !path.endsWith('.glb'));
  await runtime.exportWeb({ sessionId });
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(webEarlier[0]), { code: 'ENOENT' });
  assert.ok((await stat(webEarlier[1])).isDirectory());
  await runtime.exportGlb({ sessionId });
  const keptGlbs = (await readdir(join(dirname(webEarlier[0])))).filter(name => name.endsWith('.glb'));
  assert.equal(keptGlbs.length, 8);
  await assert.rejects(stat(glbEarlier[0]), { code: 'ENOENT' });
  assert.ok((await stat(glbEarlier[1])).isFile());
});

runTest('a half-written web export is removed and never evicts or uses up a kept build', async () => {
  let breakCopy = false;
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE, failCopy: () => breakCopy });
  const goodEntries = [];
  for (let index = 0; index < 4; index++) goodEntries.push((await runtime.exportWeb({ sessionId })).entry);
  breakCopy = true;
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(runtime.exportWeb({ sessionId }), /Injected copy failure/);
  assert.equal((await keptBuilds()).length, 4);
  for (const entry of goodEntries) assert.ok((await stat(entry)).isFile());
});

runTest('exportWeb refuses a scene without a game or with physics, and earlier builds stay', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  await runtime.exportWeb({ sessionId });
  const refused = [
    [{ ...PLAYABLE_RECIPE, game: undefined }, /no game/],
    [{ ...PLAYABLE_RECIPE, game: { ...PLAYABLE_RECIPE.game, physics: true } }, /game\.physics is true/],
  ];
  for (const [recipe, message] of refused) {
    const refusing = await webExportHarness({ exportedRecipe: recipe });
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(refusing.runtime.exportWeb({ sessionId: refusing.sessionId }), message);
    assert.equal((await refusing.keptBuilds().catch(() => [])).length, 0);
  }
  assert.equal((await keptBuilds()).length, 1);
});

runTest('exportWeb needs a jobs folder', async () => {
  const harness = await reviewRuntimeHarness({ exportedRecipe: PLAYABLE_RECIPE });
  after(() => harness.runtime.close());
  await assert.rejects(harness.runtime.exportWeb({ sessionId: harness.sessionId }), /--jobs/);
});

// A queue that grants one unit at a time and records every request, grant and release, like a wrapper that never runs light
// beside heavy. The runtime must work with it without ever queueing against itself.
function recordingSerialQueue() {
  const log = [];
  let tail = Promise.resolve();
  return {
    log,
    run(weight, work, { signal } = {}) {
      log.push(`request:${weight}`);
      const result = tail.then(async () => {
        signal?.throwIfAborted();
        log.push(`grant:${weight}`);
        try { return await work(); } finally { log.push(`release:${weight}`); }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

const settleQueue = () => new Promise(resolve => setTimeout(resolve, 20));

runTest('look and review take the card as light and give it back; calls that draw nothing never ask the queue', async () => {
  const queue = recordingSerialQueue();
  const { runtime, sessionId } = await reviewRuntimeHarness({ runtimeOptions: { gpuQueue: queue } });
  assert.deepEqual(queue.log, []);
  await runtime.look({ sessionId });
  await settleQueue();
  assert.deepEqual(queue.log, ['request:light', 'grant:light', 'release:light']);
  queue.log.length = 0;
  await runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  await settleQueue();
  assert.deepEqual(queue.log, ['request:light', 'grant:light', 'release:light']);
  queue.log.length = 0;
  await runtime.apply({ sessionId });
  await runtime.exportRecipe({ sessionId });
  await settleQueue();
  assert.deepEqual(queue.log, []);
});

runTest('a failed look gives the card back', async () => {
  const queue = recordingSerialQueue();
  const { runtime } = await reviewRuntimeHarness({ runtimeOptions: { gpuQueue: queue } });
  await assert.rejects(runtime.look({ sessionId: randomUUID() }));
  await settleQueue();
  assert.deepEqual(queue.log, ['request:light', 'grant:light', 'release:light']);
});

runTest('creating a baked scene and editing a baked scene take the card as heavy, other edits do not', async () => {
  const queue = recordingSerialQueue();
  const { runtime, sessionId } = await reviewRuntimeHarness({ runtimeOptions: { gpuQueue: queue } });
  const bakedRecipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], bake: { quality: 'draft' } };
  const baked = await runtime.create({ recipe: bakedRecipe });
  await settleQueue();
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy', 'release:heavy']);
  queue.log.length = 0;
  await runtime.apply({ sessionId: baked.sessionId, operations: [] });
  await settleQueue();
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy', 'release:heavy']);
  queue.log.length = 0;
  await runtime.apply({ sessionId, operations: [] });
  await settleQueue();
  assert.deepEqual(queue.log, []);
});

runTest('a look while a render job holds the card joins it: both finish with a strictly serial queue and no wait timeout', async () => {
  const queue = recordingSerialQueue();
  let jobHooks;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockPrivateCreate: true,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test'), gpuQueue: queue },
    contextOverrides: { createAgentRenderJobs: async hooks => { jobHooks = hooks; return controller; } } });
  await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
  assert.equal(typeof jobHooks.acquireGpu, 'function');
  const jobAbort = new AbortController();
  const releaseCard = await jobHooks.acquireGpu(jobAbort.signal);
  const jobRun = jobHooks.run({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
    settings: { kind: 'image', width: 64, height: 64 }, signal: jobAbort.signal, progress: async () => {} });
  jobRun.catch(() => {});
  for (let attempt = 0; attempt < 100 && !events.includes('private:create'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const started = Date.now();
  await runtime.look({ sessionId });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy']);
  jobAbort.abort(new Error('Render job cancelled.'));
  await assert.rejects(jobRun, /Review page closed/);
  releaseCard();
  await settleQueue();
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy', 'release:heavy']);
});

runTest('without --gpu-queue the job store gets no card hook', async () => {
  let jobHooks;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId } = await reviewRuntimeHarness({
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async hooks => { jobHooks = hooks; return controller; } } });
  await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
  assert.equal(jobHooks.acquireGpu, undefined);
});

runTest('a review page export, marks saved in the page and read back equal the local scene_ask_user answer (#924)', async () => {
  const { runtime, sessionId } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const exported = await runtime.exportWeb({ sessionId, title: 'Kitchen', review: true });
  assert.equal(exported.review, true);
  assert.ok((await stat(join(dirname(exported.entry), 'frame.png'))).isFile());
  const page = openReviewPage(await readFile(exported.entry, 'utf8'));
  page.tap(384, 256);
  page.tap(40, 60);
  page.write(1, 'brass looks dull');
  const reviewFile = page.saveFileText();

  const fromReview = await runtime.askUser({ sessionId, reviewFile });

  const savedMarks = JSON.parse(reviewFile).marks;
  const local = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE,
    extraOverrides: { runAnnotateSession: async () => ({ outcome: 'sent', marks: savedMarks, image: ANNOTATE_PNG }) } });
  const fromLocal = await local.runtime.askUser({ sessionId: local.sessionId });

  assert.equal(fromReview.image, undefined);
  assert.equal(fromLocal.content.marks.length, 2);
  assert.equal(fromLocal.content.marks[1].partId, null);
  // The runtime runs in a vm, so compare the JSON the tool sends, as the MCP server does.
  assert.deepEqual(JSON.parse(JSON.stringify(fromReview.content)), JSON.parse(JSON.stringify({ ...fromLocal.content, sessionId })));
});

runTest('a review file is refused when it is forged, for another scene, empty or too long (#924)', async () => {
  const { runtime, sessionId } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const exported = await runtime.exportWeb({ sessionId, review: true });
  const page = openReviewPage(await readFile(exported.entry, 'utf8'));
  page.tap(100, 100);
  const file = JSON.parse(page.saveFileText());
  const forged = JSON.stringify({ ...file, reviewId: 'f'.repeat(32) });
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: forged }), /Export the review page again/);
  await assert.rejects(runtime.askUser({ sessionId: 'other-scene', reviewFile: JSON.stringify(file) }), /Unknown|other-scene|made for scene/);
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: JSON.stringify({ ...file, marks: [] }) }), /no marks/);
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: JSON.stringify({ ...file, marks: [{ x: 9999, y: 1, note: '' }] }) }), /mark 1 x/);
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: 'x'.repeat(20000) }), /over 16384 bytes/);
});

runTest('a review file is read once, is forgotten when its scene is disposed, and keeps the page limit of 16 marks (#924)', async () => {
  const { runtime, sessionId } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const exported = await runtime.exportWeb({ sessionId, review: true });
  const page = openReviewPage(await readFile(exported.entry, 'utf8'));
  page.tap(384, 256);
  const reviewFile = page.saveFileText();
  const file = JSON.parse(reviewFile);
  const seventeenMarks = Array.from({ length: 17 }, (unused, index) => ({ x: 10 + index, y: 10, note: '' }));
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: JSON.stringify({ ...file, marks: seventeenMarks }), maxMarks: 32 }), /at most 16 marks/);
  const first = await runtime.askUser({ sessionId, reviewFile });
  assert.equal(first.content.outcome, 'sent');
  await assert.rejects(runtime.askUser({ sessionId, reviewFile }), /already read by an earlier scene_ask_user call/);

  const second = await runtime.exportWeb({ sessionId, review: true });
  const secondFile = openReviewPage(await readFile(second.entry, 'utf8'));
  secondFile.tap(384, 256);
  const secondText = secondFile.saveFileText();
  await runtime.dispose({ sessionId });
  await assert.rejects(runtime.askUser({ sessionId, reviewFile: secondText }), /does not match a review page exported by this server run/);
});

runTest('a review page needs no game and is kept with the newest four web builds (#924)', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] } });
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push((await runtime.exportWeb({ sessionId, review: true })).entry);
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(entries[0]), { code: 'ENOENT' });
});
