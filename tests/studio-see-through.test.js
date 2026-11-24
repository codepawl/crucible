import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { createMeshEditor, SEE_THROUGH_SURFACE_OPACITY } from '../src/studio-mesh-edit.js';
import { DEFAULT_KEYMAP_ACTIONS } from '../src/studio-keymap.js';

// The see-through view of edit mode (#3297): from the front a cube hides four vertices behind the other four, and a box
// select over its square reaches them only while the view is on.
const FRONT_CAMERA = { eye: [0, 0, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function frontCubeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: FRONT_CAMERA,
  };
}

function mount() {
  const recipe = frontCubeRecipe();
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const editor = createMeshEditor({ controller, getRenderer: () => ({}), updatePart: () => {} });
  editor.enter();
  editor.setMode('vertex');
  return { controller, editor };
}

// A rectangle a little larger than the front square of the cube on screen.
function rectangleAroundCube(controller) {
  const corner = controller.projectWorldPoint([0.5, 0.5, 0.5]);
  const opposite = controller.projectWorldPoint([-0.5, -0.5, 0.5]);
  const margin = 12;
  return [Math.min(corner.x, opposite.x) - margin, Math.min(corner.y, opposite.y) - margin, Math.max(corner.x, opposite.x) + margin, Math.max(corner.y, opposite.y) + margin];
}

test('a box select across a cube takes four vertices with see-through off and all eight with it on', () => {
  const { controller, editor } = mount();
  const rectangle = rectangleAroundCube(controller);
  assert.equal(editor.seeThrough, false);
  assert.equal(editor.selectInRectangle(...rectangle), 4);
  assert.equal(editor.setSeeThrough(true), true);
  assert.equal(editor.selectInRectangle(...rectangle), 8);
  editor.setSeeThrough(false);
  assert.equal(editor.selectInRectangle(...rectangle), 4);
});

test('see-through in edge and face mode reaches the far edges and faces too', () => {
  const { controller, editor } = mount();
  const rectangle = rectangleAroundCube(controller);
  editor.setMode('edge');
  assert.equal(editor.selectInRectangle(...rectangle), 4);
  editor.setMode('face');
  assert.equal(editor.selectInRectangle(...rectangle), 1);
  editor.setSeeThrough(true);
  editor.setMode('edge');
  assert.equal(editor.selectInRectangle(...rectangle), 12);
  editor.setMode('face');
  assert.equal(editor.selectInRectangle(...rectangle), 6);
});

test('a click picks the far vertex under the pointer only with see-through on, and the box can add to a selection', () => {
  const { controller, editor } = mount();
  const rectangle = rectangleAroundCube(controller);
  const behind = controller.projectWorldPoint([0.5, 0.5, -0.5]);
  const front = controller.projectWorldPoint([0.5, 0.5, 0.5]);
  editor.setSeeThrough(true);
  editor.pick(behind.x, behind.y);
  assert.equal(editor.selection.indices.length, 1);
  const farVertex = editor.selection.indices[0];
  editor.pick(front.x, front.y);
  assert.notEqual(editor.selection.indices[0], farVertex);
  editor.selectInRectangle(...rectangle, { additive: true });
  assert.equal(editor.selection.indices.length, 8);
});

test('see-through draws the surface faint and puts it back on leaving, without touching the recipe or the undo history', () => {
  const { controller, editor } = mount();
  const part = controller.scene.parts.find(candidate => candidate.name === 'hero');
  const recipeBefore = JSON.stringify(controller.exportRecipe());
  const canUndoBefore = controller.canUndo;
  assert.deepEqual(editor.partsToDraw(controller.scene.parts), controller.scene.parts, 'solid while see-through is off');
  editor.setSeeThrough(true);
  const drawn = editor.partsToDraw(controller.scene.parts).find(candidate => candidate.name === 'hero');
  assert.notEqual(drawn, part);
  assert.equal(drawn.material.alphaMode, 'blend');
  assert.ok(drawn.material.opacity <= SEE_THROUGH_SURFACE_OPACITY);
  assert.equal(drawn.geometry, part.geometry, 'the same geometry, so a drag preview still reaches it');
  assert.equal(part.material.alphaMode === 'blend', false, 'the scene part itself is untouched');
  assert.equal(JSON.stringify(controller.exportRecipe()), recipeBefore);
  assert.equal(controller.canUndo, canUndoBefore);
  editor.setSeeThrough(false);
  assert.deepEqual(editor.partsToDraw(controller.scene.parts), controller.scene.parts);
  editor.setSeeThrough(true);
  editor.leave();
  assert.equal(editor.seeThrough, true, 'the view stays on for the next edit session');
});

test('box select needs a rectangle of finite pixels and the toggle needs a boolean', () => {
  const { editor } = mount();
  assert.throws(() => editor.selectInRectangle(0, 0, Number.NaN, 5), /four finite pixel values/);
  assert.throws(() => editor.setSeeThrough('yes'), /true or false/);
});

test('Alt+Z and B are free in every keymap and bound to the see-through and box select actions', () => {
  const byId = new Map(DEFAULT_KEYMAP_ACTIONS.map(item => [item.id, item]));
  assert.deepEqual(byId.get('view.seeThrough').bindings.map(item => ({ ...item })), [{ code: 'KeyZ', alt: true }]);
  assert.equal(byId.get('mesh.boxSelect').bindings[0].key, 'b');
  for (const item of DEFAULT_KEYMAP_ACTIONS) {
    if (item.id === 'view.seeThrough') continue;
    for (const binding of item.bindings) {
      assert.equal(binding.code === 'KeyZ' && binding.alt === true, false, `${item.id} also uses Alt+Z`);
    }
  }
});

test('Alt+Z through the page is view state: the bar button follows it, undo is untouched, and B then a drag selects 4 then 8 vertices', async testContext => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: frontCubeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  const box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  viewport.box = box;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  press('Tab');
  for (let attempt = 0; attempt < 2000 && root.dataset.meshEdit !== 'true'; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(root.dataset.meshEdit, 'true');
  press('1');
  const button = root.querySelectorAll('button').find(candidate => candidate.getAttribute('aria-label')?.startsWith('See through'));
  assert.ok(button, 'the viewport bar has the see-through button');
  const canvas = viewport.querySelector('canvas');
  const toScreen = point => {
    const pixel = studio.controller.projectWorldPoint(point);
    return { clientX: box.left + pixel.x, clientY: box.top + pixel.y };
  };
  const boxSelectAcrossCube = () => {
    press('b');
    const from = toScreen([-0.5, 0.5, 0.5]);
    const to = toScreen([0.5, -0.5, 0.5]);
    dispatch(canvas, 'pointerdown', { clientX: from.clientX - 12, clientY: from.clientY - 12, button: 0 });
    dispatch(viewport, 'pointermove', { clientX: to.clientX + 12, clientY: to.clientY + 12 });
    dispatch(viewport, 'pointerup', { clientX: to.clientX + 12, clientY: to.clientY + 12 });
    studio.renderNow();
  };
  const undoBefore = studio.controller.canUndo;
  boxSelectAcrossCube();
  const picked = () => {
    const path = [...root.querySelectorAll('.crucible-studio-cage-selected-vertex')].map(node => node.getAttribute('d')).join('');
    return (path.match(/h0/g) ?? []).length;
  };
  assert.equal(picked(), 4, 'see-through off: the four near vertices');
  const prevented = press('z', { code: 'KeyZ', altKey: true });
  assert.equal(prevented.defaultPrevented, true);
  assert.equal(studio.seeThrough, true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  boxSelectAcrossCube();
  assert.equal(picked(), 8, 'see-through on: all eight');
  assert.equal(studio.controller.canUndo, undoBefore, 'toggling and selecting add no undo step');
  press('z', { code: 'KeyZ', altKey: true });
  assert.equal(studio.seeThrough, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});
