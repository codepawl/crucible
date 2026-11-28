import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_LOOK_PRESETS, activeLookPresetId, environmentUnderLook } from '../src/studio-look-gallery.js';
import { allByAttribute, byDataset, createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
const PRESET_COUNT = STUDIO_LOOK_PRESETS.length;

function sceneRecipe(environment = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3], ...environment },
  };
}

// Mounts Studio with a recording renderer factory: the first renderer it builds is the viewport's, the second the gallery's.
function mountStudio(testContext, environment) {
  const dom = installStudioDom();
  const renderers = [];
  const createRenderer = (canvas, parts, options) => {
    const renderer = createFakeRenderer();
    renderers.push({ renderer, options });
    return renderer;
  };
  const studio = createStudio(dom.container, { recipe: sceneRecipe(environment), createRenderer });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  dom.container.firstElementChild.querySelector('.crucible-studio-viewport').box = VIEWPORT_BOX;
  studio.renderNow();
  return { dom, studio, controller: studio.controller, renderers };
}

// The gallery lets go of its renderer after a round, so a later round may run on a new one.
const galleryFrames = ui => ui.renderers.slice(1).flatMap(entry => entry.renderer.frames);
// The test DOM holds every timer until it is told to run them, so the pictures are made by stepping the timers by hand.
function runTimersUntil(ui, isDone) {
  for (let step = 0; step < 100 && !isDone(); step += 1) {
    if (ui.dom.runTimers() === 0) break;
  }
}

function waitForPictures(ui, count) {
  runTimersUntil(ui, () => galleryFrames(ui).length >= count);
  assert.equal(galleryFrames(ui).length, count);
}

function runAllTimers(ui) {
  runTimersUntil(ui, () => false);
}

const activeLook = ui => allByAttribute(ui.dom.container, 'aria-pressed', 'true').find(element => element.dataset.look)?.dataset.look;

test('the Looks gallery names each look once and marks the one the scene uses', testContext => {
  const ui = mountStudio(testContext, { viewTransform: 'agx' });
  const names = ui.dom.container.descendants().filter(element => element.dataset.look).map(element => element.dataset.look);
  assert.deepEqual(names, STUDIO_LOOK_PRESETS.map(preset => preset.id));
  ui.studio.setWorkspace('look', 'looks');
  assert.equal(activeLook(ui), 'agx');
});

test('a look that mixes a transform with a look the gallery does not list marks nothing', () => {
  assert.equal(activeLookPresetId({ viewTransform: 'agx', look: 'warm' }), null);
  assert.equal(activeLookPresetId({}), 'aces');
  assert.equal(activeLookPresetId({ look: 'cool' }), 'cool');
});

test('a look draws its picture over the scene environment, replacing only the transform and the look', () => {
  const environment = { setup: 'studio', viewTransform: 'agx', look: 'faded', lightDirection: [1, 2, 3] };
  const warm = STUDIO_LOOK_PRESETS.find(preset => preset.id === 'warm');
  const framed = environmentUnderLook(environment, warm);
  assert.equal(framed.viewTransform, 'aces');
  assert.equal(framed.look, 'warm');
  assert.deepEqual(framed.lightDirection, [1, 2, 3]);
  const plain = environmentUnderLook(environment, STUDIO_LOOK_PRESETS.find(preset => preset.id === 'standard'));
  assert.equal(plain.look, undefined);
  assert.equal(environment.look, 'faded');
});

test('nothing is drawn for the gallery while the Look tab is out of view', testContext => {
  const ui = mountStudio(testContext);
  runAllTimers(ui);
  assert.equal(ui.renderers.length, 1);
});

test('the Look tab draws one picture for each look on a small second renderer, one after another', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.setWorkspace('look', 'looks');
  waitForPictures(ui, PRESET_COUNT);
  assert.equal(ui.renderers.length, 2);
  assert.equal(ui.renderers[1].options.pixelRatio, 1);
  assert.deepEqual(galleryFrames(ui).map(frame => [frame.environment.viewTransform, frame.environment.look]), STUDIO_LOOK_PRESETS.map(preset => [preset.viewTransform, preset.look ?? undefined]));
  const shown = allByAttribute(ui.dom.container, 'decoding', 'async').filter(image => image.hidden === false);
  assert.equal(shown.length, PRESET_COUNT);
  assert.equal(ui.controller.scene.environment.look, undefined, 'drawing the pictures leaves the scene as it was');
});

test('picking a look applies it as one undo step and keeps the pictures that are already drawn', async testContext => {
  const ui = mountStudio(testContext);
  ui.studio.setWorkspace('look', 'looks');
  waitForPictures(ui, PRESET_COUNT);
  assert.equal(ui.controller.canUndo, false);
  byDataset(ui.dom.container, 'look', 'warm').dispatchEvent(ui.dom.container.ownerDocument.createEvent('click'));
  await ui.dom.settle();
  assert.equal(ui.controller.scene.environment.look, 'warm');
  assert.equal(ui.controller.scene.environment.viewTransform, 'aces');
  assert.equal(activeLook(ui), 'warm');
  runAllTimers(ui);
  assert.equal(galleryFrames(ui).length, PRESET_COUNT, 'picking a look does not redraw the other pictures');
  ui.controller.undo();
  assert.equal(ui.controller.scene.environment.look, undefined);
  assert.equal(ui.controller.canUndo, false);
});

test('an edit to the scene draws the pictures again', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.setWorkspace('look', 'looks');
  waitForPictures(ui, PRESET_COUNT);
  ui.controller.updateLook({ environment: { lightDirection: [3, 4, 1] } });
  waitForPictures(ui, PRESET_COUNT * 2);
});
