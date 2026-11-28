import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';

function createResizingRenderer({ clientWidth, clientHeight, backingWidth = 0, backingHeight = 0 }) {
  const context = {
    MAX_RENDERBUFFER_SIZE: 7,
    MAX_TEXTURE_SIZE: 8,
    isContextLost: () => false,
    getParameter: () => 8192,
  };
  const canvas = { clientWidth, clientHeight, width: backingWidth, height: backingHeight };
  const renderer = Object.create(CrucibleRenderer.prototype);
  const allocations = [];
  Object.assign(renderer, {
    context,
    backend: new WebGL2GlazeBackend(context),
    canvas,
    pixelRatio: 1,
    baseSamples: 4,
    multisampleSamples: 4,
    hdr: false,
    benchmark: false,
    world: false,
    projection: new Float32Array(16),
    capabilities: { samples: 4 },
    geometryBytes: 0,
    textureBytes: 0,
    depth: true,
    memoryBudgetMiB: 4096,
    maximumMemoryBudgetMiB: 4096,
    allocateFrameTargets(width, height) {
      allocations.push([width, height]);
    },
  });
  return { renderer, canvas, allocations };
}

test('resize() reallocates frame targets when canvas.width and height already match the new size (#3636)', () => {
  const { renderer, canvas, allocations } = createResizingRenderer({ clientWidth: 320, clientHeight: 200 });
  renderer.resize();
  assert.deepEqual(allocations, [[320, 200]]);
  assert.equal(renderer.allocatedTargetWidth, 320);
  assert.equal(renderer.allocatedTargetHeight, 200);

  canvas.clientWidth = 320;
  canvas.clientHeight = 180;
  canvas.width = 320;
  canvas.height = 180;
  renderer.resize();
  assert.deepEqual(allocations, [[320, 200], [320, 180]]);
  assert.equal(renderer.allocatedTargetWidth, 320);
  assert.equal(renderer.allocatedTargetHeight, 180);
});

test('resize() skips allocation when target dimensions and sample count are unchanged (#3636)', () => {
  const { renderer, allocations } = createResizingRenderer({ clientWidth: 320, clientHeight: 200 });
  renderer.resize();
  renderer.resize();
  assert.deepEqual(allocations, [[320, 200]]);
});

test('releaseFrameTargets() clears allocatedTargetWidth and Height so resize() reallocates cleanly (#3636)', () => {
  const deleted = [];
  const { renderer, allocations } = createResizingRenderer({ clientWidth: 320, clientHeight: 200, backingWidth: 320, backingHeight: 200 });
  Object.assign(renderer, {
    renderTargets: { release() {} },
    multisampleFramebuffer: 'fb',
    allocatedTargetWidth: 320,
    allocatedTargetHeight: 200,
  });
  renderer.context.deleteFramebuffer = resource => deleted.push(resource);
  renderer.context.deleteRenderbuffer = resource => deleted.push(resource);
  renderer.context.deleteTexture = resource => deleted.push(resource);
  renderer.releaseFrameTargets();
  assert.deepEqual(deleted, ['fb']);
  assert.equal(renderer.allocatedTargetWidth, 0);
  assert.equal(renderer.allocatedTargetHeight, 0);
  renderer.resize();
  assert.deepEqual(allocations, [[320, 200]]);
});

test('GPU Chrome resize() updates frameColor, sceneDepth, and multisampleColor when canvas backing matches early (#3636)', { skip: process.env.RENDER_TESTS !== '1' }, async () => {
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output', '--enable-webgl'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.route('**/resize-targets-page.html', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"></body>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/resize-targets-page.html`);
    const result = await page.evaluate(async () => {
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const { box } = await import('/src/geometry.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:200px;display:block';
      document.body.append(canvas);
      const parts = [{ name: 'box', geometry: box(0, 1), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag: 'surface', color: [0.5, 0.5, 0.5], roughness: 0.5, metallic: 0, emission: 0 } }];
      const renderer = new CrucibleRenderer(canvas, parts, { ground: false, hdr: false, depth: true, world: false, pixelRatio: 1, samples: 4 });
      const initialReport = renderer.memoryReport();
      canvas.style.width = '320px';
      canvas.style.height = '180px';
      canvas.width = 320;
      canvas.height = 180;
      renderer.resize();
      renderer.render({ eye: [2, 2, 3], target: [0, 0, 0], fov: 40, time: 0 });
      const resizedReport = renderer.memoryReport();
      const glError = renderer.context.getError();
      const allocated = { width: renderer.allocatedTargetWidth, height: renderer.allocatedTargetHeight };
      renderer.dispose?.();
      return { initialTargets: initialReport.targets, resizedTargets: resizedReport.targets, glError, allocated };
    });
    assert.equal(result.glError, 0);
    assert.deepEqual(result.allocated, { width: 320, height: 180 });
    for (const targetName of ['frameColor', 'sceneDepth', 'multisampleColor']) {
      const initialTarget = result.initialTargets.find(target => target.name === targetName);
      const resizedTarget = result.resizedTargets.find(target => target.name === targetName);
      assert.equal(initialTarget.width, 320);
      assert.equal(initialTarget.height, 200);
      assert.equal(resizedTarget.width, 320);
      assert.equal(resizedTarget.height, 180);
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
