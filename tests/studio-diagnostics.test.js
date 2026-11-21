import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStudioDiagnostics,
  DIAGNOSTIC_MESSAGE_LIMIT,
  DIAGNOSTIC_STACK_LIMIT,
  STUDIO_DIAGNOSTIC_KINDS,
  watchStudioDiagnostics,
} from '../src/studio-diagnostics.js';
import { VERSION } from '../src/version.js';
import { createStudio } from '../src/studio.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const DISTINCT_NODE_ID = 'private-node-quartz-7731';
const DISTINCT_MATERIAL_ID = 'private-material-cobalt-9902';

function makeSecretRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: DISTINCT_MATERIAL_ID, tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 }],
    nodes: [{ id: DISTINCT_NODE_ID, geometry: 'block', material: DISTINCT_MATERIAL_ID, translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

/** A window that counts its listeners, and a clock that moves a fixed step each time it is read. */
function createListenerWindow() {
  const target = new EventTarget();
  const listeners = new Map();
  return {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    navigator: { userAgent: 'Test Browser/1.0' },
    addEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? 0) + 1);
      target.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? 0) - 1);
      target.removeEventListener(type, listener);
    },
    dispatchEvent: event => target.dispatchEvent(event),
    listenerCount: type => listeners.get(type) ?? 0,
  };
}

function createSteppingClock(step) {
  let time = 0;
  return () => {
    time += step;
    return time;
  };
}

function mountWithWindow(testContext, options = {}) {
  const dom = installStudioDom();
  const windowReference = Object.assign(dom.document.defaultView, createListenerWindow());
  const studio = createStudio(dom.container, { recipe: makeSecretRecipe(), renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const canvas = dom.container.querySelector('canvas');
  return { dom, studio, windowReference, canvas };
}

test('createStudioDiagnostics rejects options with an error that says what to pass', () => {
  assert.throws(() => createStudioDiagnostics({ limit: 0 }), /limit must be an integer from 1 to 5000/);
  assert.throws(() => createStudioDiagnostics({ limit: 1.5 }), /limit must be an integer/);
  assert.throws(() => createStudioDiagnostics({ slowOperationMilliseconds: 0 }), /slowOperationMilliseconds must be a number above 0/);
  assert.throws(() => createStudioDiagnostics({ now: 5 }), /now must be a function/);
  assert.throws(() => createStudioDiagnostics({ onEntry: 'log' }), /onEntry must be a function/);
  assert.throws(() => createStudioDiagnostics().record('crash'), /Unknown diagnostic kind "crash"/);
});

test('the ring keeps the newest entries and counts every kind', () => {
  const diagnostics = createStudioDiagnostics({ limit: 3 });
  for (let index = 0; index < 5; index += 1) {
    diagnostics.record('error', { name: 'Error', message: `failure ${index}` });
  }
  diagnostics.record('contextLost');
  const report = diagnostics.report();
  assert.equal(report.entries.length, 3);
  assert.deepEqual(report.entries.map(entry => entry.message), ['failure 3', 'failure 4', undefined]);
  assert.equal(report.counts.error, 5);
  assert.equal(report.counts.contextLost, 1);
  assert.deepEqual(Object.keys(report.counts), STUDIO_DIAGNOSTIC_KINDS);
});

test('a slow operation records its name, duration and scene size, and a fast one records nothing', () => {
  const diagnostics = createStudioDiagnostics({
    now: createSteppingClock(40),
    slowOperationMilliseconds: 100,
    describeScene: () => ({ nodes: 3, triangles: 72 }),
  });
  assert.equal(diagnostics.measure('quick', () => 'done'), 'done');
  assert.equal(diagnostics.entries().length, 0);

  const slowClock = createSteppingClock(250);
  const slowDiagnostics = createStudioDiagnostics({ now: slowClock, describeScene: () => ({ nodes: 3, triangles: 72 }) });
  assert.equal(slowDiagnostics.measure('add', () => 7), 7);
  const [entry] = slowDiagnostics.entries();
  assert.equal(entry.kind, 'slowOperation');
  assert.equal(entry.name, 'add');
  assert.equal(entry.durationMilliseconds, 250);
  assert.deepEqual(entry.scene, { nodes: 3, triangles: 72 });
});

test('measure times a promise until it settles and still times an operation that throws', async () => {
  const diagnostics = createStudioDiagnostics({ now: createSteppingClock(500) });
  await assert.rejects(diagnostics.measure('load', () => Promise.reject(new Error('nope'))), /nope/);
  assert.throws(() => diagnostics.measure('edit', () => { throw new RangeError('bad'); }), /bad/);
  assert.deepEqual(diagnostics.entries().map(entry => entry.name), ['load', 'edit']);
});

test('messages and stacks are capped and keep no folder or address', () => {
  const diagnostics = createStudioDiagnostics();
  const error = new Error('x'.repeat(5000));
  error.stack = `Error: boom\n    at open (D:\\work\\private\\app.js:10:4)\n    at run (https://example.test/secret/path/bundle.js:1:1)\n${'    at filler (bundle.js:1:1)\n'.repeat(400)}`;
  diagnostics.recordFailure('error', error);
  const [entry] = diagnostics.entries();
  assert.ok(entry.message.length <= DIAGNOSTIC_MESSAGE_LIMIT);
  assert.ok(entry.stack.length <= DIAGNOSTIC_STACK_LIMIT);
  assert.match(entry.stack, /app\.js:10:4/);
  assert.doesNotMatch(entry.stack, /work|private|secret|example\.test/);
});

test('a throwing hook is ignored and never becomes an entry of its own', () => {
  const seen = [];
  const diagnostics = createStudioDiagnostics({
    onEntry: entry => {
      seen.push(entry.kind);
      diagnostics.record('contextRestored');
      throw new Error('hook failed');
    },
  });
  assert.doesNotThrow(() => diagnostics.record('error', { message: 'first' }));
  assert.deepEqual(seen, ['error']);
  assert.deepEqual(diagnostics.entries().map(entry => entry.kind), ['error', 'contextRestored']);
});

test('the hook gets a copy, so it cannot change what the report holds', () => {
  const diagnostics = createStudioDiagnostics({ onEntry: entry => { entry.message = 'changed'; } });
  diagnostics.record('error', { message: 'original' });
  assert.equal(diagnostics.entries()[0].message, 'original');
});

test('watching records errors, rejections, context loss and long tasks, and stops on request', () => {
  const diagnostics = createStudioDiagnostics();
  const windowReference = createListenerWindow();
  const canvas = new EventTarget();
  let observerCallback = null;
  let observerDisconnected = false;
  class FakePerformanceObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe(options) {
      assert.deepEqual(options, { entryTypes: ['longtask'] });
    }

    disconnect() {
      observerDisconnected = true;
    }
  }
  const stop = watchStudioDiagnostics(diagnostics, { windowReference, canvas, PerformanceObserverClass: FakePerformanceObserver });

  windowReference.dispatchEvent(Object.assign(new Event('error'), { error: new TypeError('broken handler'), message: 'ignored' }));
  windowReference.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('rejected') }));
  windowReference.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { secret: 'object' } }));
  canvas.dispatchEvent(new Event('webglcontextlost'));
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  observerCallback({ getEntries: () => [{ duration: 83.46 }] });

  const entries = diagnostics.entries();
  assert.deepEqual(entries.map(entry => entry.kind), ['error', 'rejection', 'rejection', 'contextLost', 'contextRestored', 'longTask']);
  assert.equal(entries[0].name, 'TypeError');
  assert.equal(entries[0].message, 'broken handler');
  assert.match(entries[0].stack, /broken handler/);
  assert.doesNotMatch(JSON.stringify(entries[2]), /secret|object/);
  assert.equal(entries[5].durationMilliseconds, 83.5);

  stop();
  assert.equal(observerDisconnected, true);
  assert.equal(windowReference.listenerCount('error'), 0);
  assert.equal(windowReference.listenerCount('unhandledrejection'), 0);
  windowReference.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after') }));
  canvas.dispatchEvent(new Event('webglcontextlost'));
  assert.equal(diagnostics.entries().length, 6);
});

test('a browser without long task support is fine', () => {
  const diagnostics = createStudioDiagnostics();
  class RefusingObserver {
    observe() {
      throw new TypeError('unsupported entry type');
    }
  }
  const stop = watchStudioDiagnostics(diagnostics, { windowReference: createListenerWindow(), canvas: new EventTarget(), PerformanceObserverClass: RefusingObserver });
  assert.doesNotThrow(stop);
});

test('the diagnostics module schedules no timer, frame or interval', () => {
  const scheduled = [];
  const originals = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.setTimeout = (...args) => { scheduled.push('setTimeout'); return originals.setTimeout(...args); };
  globalThis.setInterval = (...args) => { scheduled.push('setInterval'); return originals.setInterval(...args); };
  globalThis.requestAnimationFrame = (...args) => { scheduled.push('requestAnimationFrame'); return originals.requestAnimationFrame?.(...args); };
  try {
    const diagnostics = createStudioDiagnostics({ now: createSteppingClock(300) });
    const stop = watchStudioDiagnostics(diagnostics, { windowReference: createListenerWindow(), canvas: new EventTarget() });
    diagnostics.measure('edit', () => 1);
    diagnostics.report();
    stop();
  } finally {
    Object.assign(globalThis, originals);
    if (originals.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  }
  assert.deepEqual(scheduled, []);
});

test('Studio reports an error, a rejection and a context loss', testContext => {
  const { studio, windowReference, canvas } = mountWithWindow(testContext);
  windowReference.dispatchEvent(Object.assign(new Event('error'), { error: new Error('handler threw') }));
  windowReference.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('lost promise') }));
  dispatch(canvas, 'webglcontextlost');
  dispatch(canvas, 'webglcontextrestored');
  const report = studio.diagnostics.report();
  assert.equal(report.format, 'crucible.studio.diagnostics');
  assert.equal(report.crucibleVersion, VERSION);
  assert.equal(report.userAgent, 'Test Browser/1.0');
  assert.deepEqual(report.viewport.pixelRatio, 2);
  assert.equal(report.counts.error, 1);
  assert.equal(report.counts.rejection, 1);
  assert.equal(report.counts.contextLost, 1);
  assert.equal(report.counts.contextRestored, 1);
  assert.deepEqual(report.scene.nodes, 1);
  assert.ok(report.scene.triangles > 0);
});

test('Studio records a slow edit with its name, duration and triangle count', testContext => {
  const { studio } = mountWithWindow(testContext, { diagnostics: { now: createSteppingClock(250) } });
  studio.controller.addPrimitive('box');
  const slowAdd = studio.diagnostics.entries().find(entry => entry.kind === 'slowOperation' && entry.name === 'add');
  assert.ok(slowAdd.durationMilliseconds >= 250);
  assert.equal(slowAdd.scene.nodes, 2);
  assert.ok(slowAdd.scene.triangles > 0);
  assert.ok(studio.diagnostics.entries().some(entry => entry.name === 'handleChange'));
});

test('Studio times undo, redo, duplicate, delete and load', testContext => {
  const { studio } = mountWithWindow(testContext, { diagnostics: { now: createSteppingClock(250) } });
  studio.controller.selectNode(DISTINCT_NODE_ID);
  studio.controller.duplicateSelected();
  studio.controller.deleteSelected();
  studio.controller.undo();
  studio.controller.redo();
  studio.loadRecipe(makeSecretRecipe());
  const names = new Set(studio.diagnostics.entries().map(entry => entry.name));
  for (const name of ['duplicate', 'delete', 'undo', 'redo', 'load']) {
    assert.ok(names.has(name), name);
  }
});

test('the report holds no recipe contents', testContext => {
  const { studio, windowReference } = mountWithWindow(testContext, { diagnostics: { now: createSteppingClock(250) } });
  studio.controller.selectNode(DISTINCT_NODE_ID);
  studio.controller.duplicateSelected();
  windowReference.dispatchEvent(Object.assign(new Event('error'), { error: new Error('plain failure') }));
  const reportText = JSON.stringify(studio.diagnostics.report());
  assert.ok(reportText.includes('slowOperation'));
  assert.doesNotMatch(reportText, /private-node|private-material|quartz|cobalt|block/);
  assert.doesNotMatch(reportText, /"nodes":\[|"materials"|"geometries"/);
});

test('onDiagnostic sees each entry and a throwing hook does not break an edit', testContext => {
  const seen = [];
  const { studio } = mountWithWindow(testContext, {
    diagnostics: { now: createSteppingClock(250) },
    onDiagnostic: entry => {
      seen.push(entry.kind);
      throw new Error('the host hook failed');
    },
  });
  assert.doesNotThrow(() => studio.controller.addPrimitive('box'));
  assert.equal(studio.exportRecipe().nodes.length, 2);
  assert.ok(seen.includes('slowOperation'));
});

test('an idle Studio schedules nothing for diagnostics', testContext => {
  const { dom, studio } = mountWithWindow(testContext);
  const timersBefore = dom.pendingTimerCount;
  const framesBefore = dom.pendingAnimationFrameCount;
  studio.diagnostics.report();
  studio.diagnostics.entries();
  assert.equal(dom.pendingTimerCount, timersBefore);
  assert.equal(dom.pendingAnimationFrameCount, framesBefore);
});

test('dispose removes the listeners and stops recording', testContext => {
  const { studio, windowReference, canvas } = mountWithWindow(testContext);
  assert.equal(windowReference.listenerCount('error'), 1);
  assert.equal(windowReference.listenerCount('unhandledrejection'), 1);
  studio.dispose();
  assert.equal(windowReference.listenerCount('error'), 0);
  assert.equal(windowReference.listenerCount('unhandledrejection'), 0);
  windowReference.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after dispose') }));
  dispatch(canvas, 'webglcontextlost');
  assert.equal(studio.diagnostics.entries().length, 0);
});

test('the Help menu saves the report as a file', async testContext => {
  const { dom, studio } = mountWithWindow(testContext);
  const root = dom.container.firstElementChild;
  byText(root, 'Save diagnostics report').click();
  await dom.settle();
  const [download] = dom.document.downloads;
  assert.equal(download.filename, 'crucible-studio-diagnostics.json');
  assert.equal(download.blob.type, 'application/json');
  const saved = JSON.parse(await download.blob.text());
  assert.equal(saved.format, 'crucible.studio.diagnostics');
  assert.deepEqual(saved.counts, studio.diagnostics.report().counts);
});
