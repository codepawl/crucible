// #3392: a scene that wrote no shadow bounds and is bigger than the default 7 m studio view gets a sun view fitted to it.
// Without that, a receiver past the default view reads as lit and a caster past it casts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { boxInsideClipVolume, fitStudioShadowView } from '../src/studio-shadow-fit.js';
import { resolveShadowLight, writeShadowLightMatrix } from '../src/shadow-light.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

// The sun of the window-lit classroom: it comes from +x, low, and grazes the back wall at about 5 degrees.
const CLASSROOM_SUN = [0.874, 0.479, 0.082];

function placedBox(minimum, maximum, extra = {}) {
  const size = maximum.map((value, axis) => value - minimum[axis]);
  const centre = maximum.map((value, axis) => (value + minimum[axis]) / 2);
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, centre[0], centre[1], centre[2], 1]);
  return { name: 'part', geometry: box(0, 1), matrix, material: { tag: 'surface' }, ...extra };
}

// A room 11 m wide and 9 m deep: a window wall on the right, the back wall, and a desk in the middle.
function classroomParts() {
  const windowWall = placedBox([3.2, 0, -3.9], [4.2, 3.3, 5]);
  const backWall = placedBox([-6, 0, -4], [4.2, 3.3, -3.9]);
  const desk = placedBox([0, 0, 0], [1, 0.8, 1]);
  return { windowWall, backWall, desk, all: [windowWall, backWall, desk] };
}

function defaultLightMatrix() {
  return writeShadowLightMatrix(mat4.create(), resolveShadowLight(false, CLASSROOM_SUN));
}

test('the default studio view leaves the back-right corner of a 11 m room outside, which is why its receivers read as lit', () => {
  const matrix = defaultLightMatrix();
  const cornerOfRoom = { minimum: [3.2, 0, -3.95], maximum: [3.4, 3.3, -3.85] };
  assert.equal(boxInsideClipVolume(cornerOfRoom, matrix), false);
  assert.equal(boxInsideClipVolume({ minimum: [0, 0, 0], maximum: [1, 1, 1] }, matrix), true);
});

test('a room bigger than the default view gets a view that holds every wall', () => {
  const { all } = classroomParts();
  const view = fitStudioShadowView(all, all, CLASSROOM_SUN);
  assert.ok(view, 'a fitted view');
  assert.ok(view.extent > 3.5, `extent ${view.extent} must grow past the default 3.5`);
  const fittedMatrix = writeShadowLightMatrix(mat4.create(), resolveShadowLight(false, CLASSROOM_SUN, {}, view));
  for (const part of all) {
    const half = [0.5, 0.5, 0.5];
    const corners = [-1, 1].map(sign => [0, 1, 2].map(axis => part.matrix[12 + axis] + sign * half[axis] * part.matrix[axis * 5]));
    assert.ok(boxInsideClipVolume({ minimum: corners[0], maximum: corners[1] }, fittedMatrix), 'part inside the fitted view');
  }
});

test('receivers that cast nothing still widen the view', () => {
  const { desk, backWall } = classroomParts();
  const view = fitStudioShadowView([desk], [desk, backWall], CLASSROOM_SUN);
  assert.ok(view, 'the back wall is a receiver, so the view reaches it');
  assert.ok(view.extent > 3.5);
});

test('a scene inside the default view keeps it, so small scenes do not change', () => {
  const small = [placedBox([-1, 0, -1], [1, 1, 1]), placedBox([0, 1, 0], [0.5, 1.5, 0.5])];
  assert.equal(fitStudioShadowView(small, small, CLASSROOM_SUN), null);
});

test('when every caster lies outside the default view the warning stays and no view is fitted', () => {
  const far = [placedBox([40, 0, 0], [41, 1, 1])];
  assert.equal(fitStudioShadowView(far, far, CLASSROOM_SUN), null);
});

test('a skinned part is boxed where it rests instead of giving the fit up', () => {
  const { all } = classroomParts();
  const person = placedBox([-1, 0, -1], [0, 1.8, 0], { skin: { joints: [] } });
  const view = fitStudioShadowView([...all, person], [...all, person], CLASSROOM_SUN);
  assert.ok(view);
  assert.ok(view.extent > 3.5);
});

test('a scene with no casters keeps the default view', () => {
  assert.equal(fitStudioShadowView([], classroomParts().all, CLASSROOM_SUN), null);
});

test('the renderer shadows a room with a fitted view and keeps the default when bounds are written', async context => {
  await withDevServerPage(context, async page => {
    const result = await page.evaluate(async () => {
      const { box: unitBox } = await import('/src/geometry.js');
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const canvas = document.createElement('canvas');
      canvas.style.width = '64px';
      canvas.style.height = '64px';
      document.body.append(canvas);
      const placed = (scale, position) => new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, position[0], position[1], position[2], 1]);
      const matte = { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.9, emission: 0 };
      const parts = [
        { name: 'backWall', geometry: unitBox(0, 1), matrix: placed([10, 3, 0.2], [0, 1.5, -4]), material: matte },
        { name: 'desk', geometry: unitBox(0, 1), matrix: placed([1, 0.8, 1], [0, 0.4, 0]), material: matte },
      ];
      const lightDirection = [0.874, 0.479, 0.082];
      const outcome = {};
      const open = new CrucibleRenderer(canvas, parts, { samples: 1, pixelRatio: 1, ground: false });
      open.render({ eye: [0, 2, 6], target: [0, 1, 0], fov: 40, environment: { lightDirection } });
      outcome.fittedExtent = open.fittedShadowView()?.extent ?? null;
      const written = new CrucibleRenderer(canvas, parts, { samples: 1, pixelRatio: 1, ground: false, shadowBounds: { target: [0, 1, 0], extent: 3.5 } });
      written.render({ eye: [0, 2, 6], target: [0, 1, 0], fov: 40, environment: { lightDirection } });
      outcome.writtenView = written.fittedShadowView();
      return outcome;
    });
    assert.ok(result.fittedExtent > 3.5, `fitted extent ${result.fittedExtent}`);
    assert.equal(result.writtenView, null);
  });
});
