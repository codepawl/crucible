// renderer.stats reports the cost of the last render() without wrapping the context by hand (#2995).
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

async function readStats(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createGpuTimer } = await import('/src/adaptive-quality.js');
    const material = { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 };
    const sharedGeometry = box(0, 1);
    const partAt = (x) => ({ name: 'box', geometry: sharedGeometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]), material });
    const frame = { eye: [0, 2, 8], target: [0, 0, 0] };
    const measure = (instanceCount, options = {}) => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      document.body.append(canvas);
      const parts = Array.from({ length: instanceCount }, (unused, index) => partAt(index * 0.01));
      const renderer = new CrucibleRenderer(canvas, parts, { samples: 1, pixelRatio: 1, ...options });
      const before = { ...renderer.stats };
      renderer.render(frame);
      const first = { ...renderer.stats };
      renderer.render(frame);
      const second = { ...renderer.stats };
      const ownDrawLeft = Object.hasOwn(renderer.context, 'drawElements');
      renderer.dispose();
      return { before, first, second, ownDrawLeft, triangles: renderer.triangles };
    };
    return { one: measure(1), many: measure(200), timed: measure(1, { createGpuTimer }) };
  };
  return page.evaluate(task);
}

test('renderer.stats counts draw calls, drawn triangles and planned bytes after each render', async (context) => {
  await withDevServerPage(context, async (page) => {
    const { one, many, timed } = await readStats(page);
    assert.equal(one.before.drawCalls, 0, 'nothing is drawn before the first render');
    assert.ok(one.first.drawCalls >= 2, `the scene draw and the resolve draw, got ${one.first.drawCalls}`);
    assert.ok(one.first.trianglesDrawn >= one.triangles, 'every triangle of the box is drawn at least once');
    assert.equal(one.second.drawCalls, one.first.drawCalls, 'stats restart for each render instead of adding up');
    assert.ok(one.first.geometryBytes > 0 && one.first.textureBytes > 0);
    assert.equal(one.first.gpuTimeMs, null, 'no timer was asked for');
    assert.equal(one.ownDrawLeft, false, 'the counting wrappers leave the context as they found it');
    assert.ok(many.first.trianglesDrawn > one.first.trianglesDrawn * 50, 'instances add drawn triangles');
    assert.ok(many.first.drawCalls <= one.first.drawCalls + 2, `instances share draw calls: ${one.first.drawCalls} for one, ${many.first.drawCalls} for 200`);
    assert.ok(timed.second.gpuTimeMs === null || timed.second.gpuTimeMs >= 0);
  });
});
