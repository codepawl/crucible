import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { box } from '../src/geometry.js';
import { markLiveGeometry } from '../src/live-geometry.js';
import { portalPdf, samplePortalDirection } from '../src/path-tracer-portal.js';
import { cacheCellSizes, resolveRealtimeOptions } from '../src/path-tracer-realtime-options.js';

function createFakeElement() {
  const classes = new Set();
  const childrenBySelector = new Map();
  const element = {
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    title: '',
    srcdoc: '',
    children: [],
    childElementCount: 0,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    addEventListener() {},
    append(...nodes) {
      element.children.push(...nodes);
      element.childElementCount = element.children.length;
    },
    replaceChildren(...nodes) {
      element.children = [...nodes];
      element.childElementCount = element.children.length;
    },
    insertAdjacentHTML() {},
    remove() {},
    querySelector(selector) {
      if (!childrenBySelector.has(selector)) childrenBySelector.set(selector, createFakeElement());
      return childrenBySelector.get(selector);
    },
  };
  return element;
}

async function loadDocsLiveHarness(context) {
  const sourcePath = new URL('../src/docs-live.js', import.meta.url);
  const sourceDir = new URL('../src/', import.meta.url);
  let source = readFileSync(sourcePath, 'utf8');
  source = source.replace("import { highlightCode } from './code-highlight.js';", `import { highlightCode } from '${new URL('code-highlight.js', sourceDir).href}';`);
  source = source.replace("import { escapeHtml, frameControlScript, frameControlStyle, revokeImportUrls } from './docs-live-controls.js';", `import { escapeHtml, frameControlScript, frameControlStyle, revokeImportUrls } from '${new URL('docs-live-controls.js', sourceDir).href}';`);
  source = source.replace(
    /const addonLoaders = import\.meta\.glob\(\[[\s\S]*?\]\);/,
    'const addonLoaders = { "./model.js": () => Promise.resolve({ box: () => ({}) }) };',
  );
  const folder = mkdtempSync(join(tmpdir(), 'crucible-docs-live-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  const modulePath = join(folder, 'docs-live-test.mjs');
  writeFileSync(modulePath, source, 'utf8');

  const created = [];
  const revoked = [];
  const saved = {
    window: globalThis.window,
    location: globalThis.location,
    addEventListener: globalThis.addEventListener,
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
    Blob: globalThis.Blob,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  context.after(() => {
    globalThis.window = saved.window;
    globalThis.location = saved.location;
    globalThis.addEventListener = saved.addEventListener;
    globalThis.document = saved.document;
    globalThis.IntersectionObserver = saved.IntersectionObserver;
    globalThis.Blob = saved.Blob;
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  });

  globalThis.window = {};
  globalThis.location = { origin: 'https://crucible.test', search: '' };
  globalThis.addEventListener = () => {};
  globalThis.document = { createElement: () => createFakeElement() };
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.Blob = class {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  };
  URL.createObjectURL = () => {
    const address = `blob:https://crucible.test/${created.length + 1}`;
    created.push(address);
    return address;
  };
  URL.revokeObjectURL = address => {
    revoked.push(address);
  };

  const module = await import(`${pathToFileURL(modulePath).href}?case=${Date.now()}`);
  return { createLiveExample: module.createLiveExample, created, revoked };
}

test('docs-live revokes blob URLs when stop() is called and when importMapFor fails midway', async (context) => {
  const { createLiveExample, created, revoked } = await loadDocsLiveHarness(context);

  const valid = createLiveExample({
    source: "import { box } from 'crucible/addons/model';\nbox();",
    title: 'Valid example',
  });
  await valid.liveExample.run();
  assert.equal(created.length, 1);
  assert.equal(revoked.length, 0);
  valid.liveExample.stop();
  assert.deepEqual(revoked, [created[0]]);
  assert.equal(valid.dataset.imports, undefined);
  valid.liveExample.dispose();

  const partialFailure = createLiveExample({
    source: "import { box } from 'crucible/addons/model';\nimport { missing } from 'crucible/addons/does-not-exist';",
    title: 'Partial failure',
  });
  await partialFailure.liveExample.run();
  assert.equal(created.length, 2);
  assert.deepEqual(revoked, created);
  assert.equal(partialFailure.querySelector('.live-status').dataset.kind, 'error');
  partialFailure.liveExample.dispose();
});

test('path-tracer-realtime-options rejects sub-micron cacheCellSize and clamps tiny derived cells', () => {
  assert.throws(
    () => resolveRealtimeOptions({ cacheCellSize: 1e-300 }),
    error => error instanceof RangeError && /cacheCellSize/.test(error.message),
  );
  const clamped = cacheCellSizes({ farDistance: 1e-300 });
  assert.ok(clamped.cellSize >= 1e-6);
  assert.equal(clamped.levelDistance, clamped.cellSize * 64);
});

test('path-tracer-portal returns 0 and leaves out untouched for an empty portal list', () => {
  assert.equal(portalPdf([], 0, 0, 0, 0, 0, -1), 0);
  const out = [3, 4, 5];
  assert.equal(samplePortalDirection([], 0, 0, 0, 0.5, 0.5, 0.5, out), 0);
  assert.deepEqual(out, [3, 4, 5]);
});

function createProgressiveFakeContext() {
  class FakeFramebuffer {}
  const savedFramebuffer = globalThis.WebGLFramebuffer;
  const savedOffscreen = globalThis.OffscreenCanvas;
  const constants = new Map();
  const readPixelsCalls = [];
  const handlers = {
    createTexture: () => ({}),
    createFramebuffer: () => new FakeFramebuffer(),
    createProgram: () => ({}),
    deleteTexture() {},
    deleteFramebuffer() {},
    deleteProgram() {},
    getParameter: () => 16384,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getExtension: () => ({}),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    checkFramebufferStatus: () => webglContext.FRAMEBUFFER_COMPLETE,
    readPixels: (...args) => { readPixelsCalls.push(args); },
  };
  const webglContext = new Proxy({ canvas: {} }, {
    get(target, name) {
      if (name in target) return target[name];
      if (name in handlers) return handlers[name];
      if (/^[A-Z0-9_]+$/.test(name)) {
        if (!constants.has(name)) constants.set(name, constants.size + 1);
        return constants.get(name);
      }
      return () => ({});
    },
  });
  globalThis.WebGLFramebuffer = FakeFramebuffer;
  globalThis.OffscreenCanvas = class {
    getContext() {
      return webglContext;
    }
  };
  return {
    webglContext,
    readPixelsCalls,
    restore() {
      globalThis.WebGLFramebuffer = savedFramebuffer;
      globalThis.OffscreenCanvas = savedOffscreen;
    },
  };
}

test('progressive tracer snapshot() before step() and averageBuffers(0) return finite zeroed data without NaN', async () => {
  const fake = createProgressiveFakeContext();
  try {
    const { averageBuffers } = await import('../src/path-tracer-gpu.js');
    const emptyBuffers = averageBuffers(fake.webglContext, 2, 2, 0);
    assert.equal(fake.readPixelsCalls.length, 0);
    assert.ok(emptyBuffers.color.every(value => value === 0));
    assert.ok(emptyBuffers.depth.every(value => value === 0));

    const { createProgressiveTracer } = await import('../src/path-tracer-progressive.js');
    const wall = { name: 'wall', geometry: box(), material: { color: [1, 1, 1], roughness: 1, metallic: 0 } };
    const camera = { eye: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };
    const progressive = await createProgressiveTracer({ parts: [wall], camera }, { width: 16, height: 16, maxSeconds: 60 });
    const frame = progressive.snapshot();
    assert.equal(frame.samples, 0);
    assert.ok(frame.linear.every(Number.isFinite));
    assert.ok(frame.features.color.every(Number.isFinite));
    assert.ok(frame.features.albedo.every(Number.isFinite));
    assert.ok(frame.features.normal.every(Number.isFinite));
    assert.ok(frame.features.depth.every(Number.isFinite));
    assert.ok(frame.features.variance.every(Number.isFinite));
    assert.equal(frame.rgba[0], 0);
    assert.equal(frame.rgba[3], 255);
    progressive.dispose();
    assert.throws(() => progressive.snapshot(), /disposed/i);
  } finally {
    fake.restore();
  }
});

test('path-tracer-worker rejects band and invalid messages before a scene is loaded with a clear error', async () => {
  const savedSelf = globalThis.self;
  const posted = [];
  const fakeSelf = {
    postMessage: message => posted.push(message),
    onmessage: null,
  };
  globalThis.self = fakeSelf;
  try {
    await import(`../src/path-tracer-worker.js?case=${Date.now()}`);
    assert.throws(
      () => fakeSelf.onmessage({ data: { type: 'band', rowStart: 0, rowEnd: 1 } }),
      /received a band before its scene/,
    );
    assert.throws(
      () => fakeSelf.onmessage({ data: null }),
      /expected a message object/,
    );
    assert.throws(
      () => fakeSelf.onmessage({ data: { type: 'other' } }),
      /unknown message type/,
    );
    assert.deepEqual(posted, []);
  } finally {
    globalThis.self = savedSelf;
  }
});

test('markLiveGeometry throws a clear TypeError for null and non-object inputs', () => {
  assert.throws(() => markLiveGeometry(null), error => error instanceof TypeError && /geometry/i.test(error.message));
  assert.throws(() => markLiveGeometry('box'), error => error instanceof TypeError && /geometry/i.test(error.message));
});
