import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { editPropertyKey, propertyKeysOf, removePropertyKey } from '../src/studio-property-keys.js';
import { keyValueForEditor, keyValueFromEditor } from '../src/studio-timeline-rows.js';
import { byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

// Hero keyed on all three properties at 0 s, then its position keyed alone at 2 s (the button, so Auto-key is not involved).
function makeKeyedController() {
  const controller = createStudioController({ scene: createAgentScene(makeRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.insertNodeKeyframe('hero');
  controller.setMotionTime(2);
  controller.togglePropertyKeyframe('hero', 'translation');
  return controller;
}

const positionTrack = controller => controller.exportRecipe().motion.tracks.find(track => track.property === 'translation');

test('propertyKeysOf lists one entry per animated property in panel order, each with its keys by time', () => {
  const controller = makeKeyedController();
  const entries = controller.nodePropertyKeys('hero');
  assert.deepEqual(entries.map(entry => entry.property), ['translation', 'rotation', 'scale']);
  assert.deepEqual(entries[0].keys.map(key => key.time), [0, 2]);
  assert.deepEqual(entries[1].keys.map(key => key.time), [0]);
  assert.deepEqual(propertyKeysOf([], 'hero'), []);
});

test('the key button toggles one property only, and undo takes the key back', () => {
  const controller = makeKeyedController();
  controller.setMotionTime(1);
  assert.equal(controller.togglePropertyKeyframe('hero', 'scale'), true);
  const entries = controller.nodePropertyKeys('hero');
  assert.deepEqual(entries.find(entry => entry.property === 'scale').keys.map(key => key.time), [0, 1]);
  assert.deepEqual(entries.find(entry => entry.property === 'translation').keys.map(key => key.time), [0, 2]);
  assert.equal(controller.togglePropertyKeyframe('hero', 'scale'), false);
  assert.equal(controller.nodePropertyKeys('hero').find(entry => entry.property === 'scale').keys.length, 1);
  controller.undo();
  assert.equal(controller.nodePropertyKeys('hero').find(entry => entry.property === 'scale').keys.length, 2);
});

test('a key can be retimed, given a value and an easing, each as one undo step that lands in the recipe', () => {
  const controller = makeKeyedController();
  controller.updatePropertyKeyframe('hero', 'translation', 2, { time: 1.5 });
  assert.deepEqual(positionTrack(controller).keyframes.map(key => key.time), [0, 1.5]);
  controller.updatePropertyKeyframe('hero', 'translation', 1.5, { value: [5, 0.5, 0], easing: 'easeOutBack' });
  assert.deepEqual(positionTrack(controller).keyframes[1], { time: 1.5, value: [5, 0.5, 0], easing: 'easeOutBack' });
  controller.updatePropertyKeyframe('hero', 'translation', 1.5, { easing: null });
  assert.equal(positionTrack(controller).keyframes[1].easing, undefined);
  controller.undo();
  assert.equal(positionTrack(controller).keyframes[1].easing, 'easeOutBack');
  controller.undo();
  controller.undo();
  assert.deepEqual(positionTrack(controller).keyframes.map(key => key.time), [0, 2]);
});

test('deleting a property key keeps the other properties and drops a track left empty', () => {
  const controller = makeKeyedController();
  controller.deletePropertyKeyframe('hero', 'rotation', 0);
  assert.deepEqual(controller.nodePropertyKeys('hero').map(entry => entry.property), ['translation', 'scale']);
  assert.equal(controller.nodeKeyframeTimes('hero').length, 2);
});

test('a bad key edit throws an error that says what to pass', () => {
  const controller = makeKeyedController();
  assert.throws(() => controller.updatePropertyKeyframe('hero', 'translation', 1, { time: 3 }), /no translation key at 1 s/);
  assert.throws(() => controller.updatePropertyKeyframe('hero', 'translation', 2, { easing: 'wobble' }), /not one Crucible knows/);
  assert.throws(() => controller.updatePropertyKeyframe('hero', 'translation', 2, { value: [1, 2] }), /3 finite numbers/);
  assert.throws(() => controller.togglePropertyKeyframe('hero', 'color'), /one of translation, rotation, scale/);
});

test('editPropertyKey and removePropertyKey leave the tracks they were given untouched', () => {
  const tracks = [{ kind: 'node', id: 'hero', property: 'scale', keyframes: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: [2, 2, 2] }] }];
  const edited = editPropertyKey(tracks, 'hero', 'scale', 1, { time: 0 });
  assert.deepEqual(edited[0].keyframes, [{ time: 0, value: [2, 2, 2] }], 'a key moved onto another replaces it');
  assert.equal(removePropertyKey(tracks, 'hero', 'scale', 0)[0].keyframes.length, 1);
  assert.equal(tracks[0].keyframes.length, 2);
});

test('the editor shows a rotation key as degrees and stores it back as the same quaternion', () => {
  const quaternion = keyValueFromEditor('rotation', [10, 20, 30]);
  assert.equal(quaternion.length, 4);
  keyValueForEditor('rotation', quaternion).forEach((degrees, index) => assert.ok(Math.abs(degrees - [10, 20, 30][index]) < 0.05));
  assert.deepEqual(keyValueFromEditor('scale', [1, 2, 3]), [1, 2, 3]);
});

function mountStudio(testContext) {
  const dom = installStudioDom();
  dom.container.clientWidth = 0;
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.controller.selectNode('hero');
  return { studio, root, controller: studio.controller };
}

test('the Object panel key button fills when a key sits on the frame and keys that property alone', testContext => {
  const { root, controller } = mountStudio(testContext);
  const button = byLabel(root, 'Key position');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(controller.nodePropertyKeys('hero').map(entry => entry.property), ['translation']);
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(controller.nodePropertyKeys('hero'), []);
});

test('the timeline shows a row per animated property, selects a key, and the editor retimes and deletes it', testContext => {
  const { root, controller } = mountStudio(testContext);
  controller.insertNodeKeyframe('hero');
  controller.setMotionTime(2);
  controller.togglePropertyKeyframe('hero', 'translation');
  const rows = () => root.querySelectorAll('.crucible-studio-keyrow');
  assert.deepEqual(rows().map(row => row.dataset.property), ['translation', 'rotation', 'scale']);
  const positionKeys = () => rows()[0].querySelectorAll('.crucible-studio-lane-key');
  assert.equal(positionKeys().length, 2);
  const editor = root.querySelector('.crucible-studio-keyeditor');
  assert.equal(editor.hidden, true);
  positionKeys()[1].click();
  assert.equal(editor.hidden, false);
  assert.equal(byLabel(root, 'Key time in seconds').value, '2');
  const timeField = byLabel(root, 'Key time in seconds');
  timeField.value = '1.25';
  dispatch(timeField, 'change');
  assert.deepEqual(controller.nodePropertyKeys('hero')[0].keys.map(key => key.time), [0, 1.25]);
  assert.equal(rows()[0].querySelectorAll('.crucible-studio-lane-key')[1].getAttribute('aria-pressed'), 'true');
  const easingField = byLabel(root, 'Key easing');
  easingField.value = 'easeInOutCubic';
  dispatch(easingField, 'change');
  assert.equal(controller.nodePropertyKeys('hero')[0].keys[1].easing, 'easeInOutCubic');
  byLabel(root, 'Delete key').click();
  assert.deepEqual(controller.nodePropertyKeys('hero')[0].keys.map(key => key.time), [0]);
  assert.equal(editor.hidden, true);
  controller.undo();
  assert.equal(controller.nodePropertyKeys('hero')[0].keys.length, 2);
});
