// #3284: the shadow-miss warning follows a caster that updateParts moves in and out of the studio shadow view. The browser test draws
// in headless Chrome on the dev server; it skips where Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

async function warningsWhileMoving(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '64px';
    canvas.style.height = '64px';
    document.body.append(canvas);
    const placed = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    const matte = color => ({ tag: 'surface', color, metallic: 0, roughness: 0.9, emission: 0 });
    const floor = { name: 'floor', geometry: box(0, 1), matrix: new Float32Array([12, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 12, 0, 0, -0.1, 0, 1]), material: matte([0.8, 0.8, 0.8]), castShadow: false };
    const cube = { name: 'cube', geometry: box(0, 1), matrix: placed(40, 1, 0), material: matte([0.2, 0.2, 0.9]) };
    const renderer = new CrucibleRenderer(canvas, [floor, cube], { samples: 1, pixelRatio: 1, ground: false });
    const frame = { eye: [0, 7, 7], target: [0, 0, 0], fov: 40, environment: { lightDirection: [-1, 1, 0.1] } };
    const kinds = () => renderer.diagnostics.filter(problem => problem.kind === 'shadow-view-misses-casters').length;
    const result = {};
    renderer.render(frame);
    result.outside = kinds();
    cube.matrix = placed(0, 1, 0);
    renderer.updateParts([cube]);
    renderer.render(frame);
    result.movedInside = kinds();
    cube.matrix = placed(40, 1, 0);
    renderer.updateParts([cube]);
    renderer.render(frame);
    result.movedOutAgain = kinds();
    return result;
  };
  return page.evaluate(task);
}

test('a caster moved by updateParts into the studio shadow view clears the warning and moving out raises it again', async context => {
  await withDevServerPage(context, async page => {
    const result = await warningsWhileMoving(page);
    assert.deepEqual(result, { outside: 1, movedInside: 0, movedOutAgain: 1 });
  });
});
