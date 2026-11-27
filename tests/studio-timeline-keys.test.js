import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { KEY_NUDGE_STEP, SCRUB_THUMB_WIDTH, keyMarkerOffset, keyTimeFromPointer, snapKeyTime } from '../src/studio-timeline-keys.js';
import { byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'cube', material: 'paint', translation: [2.2, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

const TRACK_LEFT = 100;
const TRACK_WIDTH = 414;

// Mounts Studio on the fake DOM with hero keyed at 0 s and 2 s, the playhead at 0 and the track laid out 414 px wide.
function mountKeyedStudio(testContext) {
  const dom = installStudioDom();
  const container = dom.container;
  container.clientWidth = 0;
  const studio = createStudio(container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  const controller = studio.controller;
  controller.selectNode('hero');
  controller.insertNodeKeyframe('hero');
  controller.setMotionTime(2);
  controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  controller.setMotionTime(0);
  const track = root.querySelector('.crucible-studio-track');
  track.box = { left: TRACK_LEFT, top: 0, width: TRACK_WIDTH, height: 32, right: TRACK_LEFT + TRACK_WIDTH, bottom: 32 };
  const ui = {
    dom,
    studio,
    controller,
    root,
    track,
    scrub: byLabel(root, 'Timeline scrub'),
    autoKeyButton: byLabel(root, 'Auto-key'),
    markers: () => root.querySelectorAll('.crucible-studio-key'),
    marker: time => ui.markers().find(candidate => candidate.getAttribute('aria-label') === `Key at ${time.toFixed(2)} s`),
    labels: () => ui.markers().map(marker => marker.getAttribute('aria-label')),
    duration: () => Number(ui.scrub.max),
    clientXAt: time => TRACK_LEFT + SCRUB_THUMB_WIDTH / 2 + (time / ui.duration()) * (TRACK_WIDTH - SCRUB_THUMB_WIDTH),
    keyTimes: () => controller.nodeKeyframeTimes('hero'),
    positionField: axis => byLabel(root, `Position ${axis}`),
  };
  return ui;
}

function dragMarker(ui, marker, fromTime, toTime) {
  dispatch(marker, 'pointerdown', { clientX: ui.clientXAt(fromTime) });
  dispatch(marker, 'pointermove', { clientX: ui.clientXAt(toTime) });
}

test('the marker position is a pure function that lands under the range thumb at 0, the middle and the end', () => {
  const half = SCRUB_THUMB_WIDTH / 2;
  assert.equal(keyMarkerOffset(0, 4), `calc(${half}px + (100% - ${SCRUB_THUMB_WIDTH}px) * 0)`);
  assert.equal(keyMarkerOffset(2, 4), `calc(${half}px + (100% - ${SCRUB_THUMB_WIDTH}px) * 0.5)`);
  assert.equal(keyMarkerOffset(4, 4), `calc(${half}px + (100% - ${SCRUB_THUMB_WIDTH}px) * 1)`);
  assert.equal(keyMarkerOffset(9, 4), keyMarkerOffset(4, 4), 'a time past the end stays on the track');
  assert.equal(keyMarkerOffset(1, 0), keyMarkerOffset(0, 4), 'an empty duration puts every key at the start');
  const track = { left: 100, width: 414, duration: 4 };
  assert.equal(keyTimeFromPointer({ ...track, clientX: 100 + half }), 0);
  assert.equal(keyTimeFromPointer({ ...track, clientX: 100 + half + (414 - SCRUB_THUMB_WIDTH) / 2 }), 2);
  assert.equal(keyTimeFromPointer({ ...track, clientX: 9999 }), 4);
  assert.equal(keyTimeFromPointer({ ...track, clientX: -50 }), 0);
  assert.equal(snapKeyTime(1.2349, 4), 1.23);
  assert.equal(snapKeyTime(-1, 4), 0);
  assert.equal(snapKeyTime(7, 4), 4);
});

test('the stylesheet draws the thumb at the width the markers assume', () => {
  assert.ok(STUDIO_CSS.includes(`inline-size: ${SCRUB_THUMB_WIDTH}px;`));
});

test('the Auto-key toggle shows its state, sets the controller flag and follows it', testContext => {
  const ui = mountKeyedStudio(testContext);
  assert.equal(ui.autoKeyButton.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.autoKeyButton.getAttribute('aria-label'), 'Auto-key');
  assert.equal(ui.autoKeyButton.dataset.icon, 'autoKey');
  ui.autoKeyButton.click();
  assert.equal(ui.controller.autoKey, false);
  assert.equal(ui.autoKeyButton.getAttribute('aria-pressed'), 'false');
  ui.controller.setAutoKey(true);
  assert.equal(ui.autoKeyButton.getAttribute('aria-pressed'), 'true');
});

test('markers follow the selected node: its key times, after an edit, an undo and a new selection', testContext => {
  const ui = mountKeyedStudio(testContext);
  assert.deepEqual(ui.labels(), ['Key at 0.00 s', 'Key at 2.00 s']);
  ui.markers().forEach(marker => assert.equal(marker.getAttribute('aria-pressed'), 'false'));
  ui.controller.setMotionTime(1);
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  assert.deepEqual(ui.labels(), ['Key at 0.00 s', 'Key at 1.00 s', 'Key at 2.00 s']);
  assert.equal(ui.marker(1).style.insetInlineStart, keyMarkerOffset(1, ui.duration()));
  ui.controller.undo();
  assert.deepEqual(ui.labels(), ['Key at 0.00 s', 'Key at 2.00 s']);
  ui.controller.selectNode('orb');
  assert.deepEqual(ui.labels(), []);
  ui.controller.selectNode('hero');
  assert.deepEqual(ui.labels(), ['Key at 0.00 s', 'Key at 2.00 s']);
});

test('a marker click selects one key and moves the playhead; a new selection clears it', testContext => {
  const ui = mountKeyedStudio(testContext);
  ui.marker(2).click();
  assert.equal(ui.controller.motionTime, 2);
  assert.equal(ui.marker(2).getAttribute('aria-pressed'), 'true');
  assert.equal(ui.marker(0).getAttribute('aria-pressed'), 'false');
  ui.marker(0).click();
  assert.equal(ui.controller.motionTime, 0);
  assert.equal(ui.marker(0).getAttribute('aria-pressed'), 'true');
  assert.equal(ui.marker(2).getAttribute('aria-pressed'), 'false');
  ui.controller.selectNode('orb');
  ui.controller.selectNode('hero');
  ui.markers().forEach(marker => assert.equal(marker.getAttribute('aria-pressed'), 'false'));
});

test('a key that no longer exists is no longer selected', testContext => {
  const ui = mountKeyedStudio(testContext);
  ui.marker(2).click();
  ui.controller.deleteNodeKeyframe('hero', 2);
  ui.markers().forEach(marker => assert.equal(marker.getAttribute('aria-pressed'), 'false'));
  ui.controller.undo();
  ui.markers().forEach(marker => assert.equal(marker.getAttribute('aria-pressed'), 'false'));
});

test('dragging a marker follows the pointer and retimes the key once, on release', testContext => {
  const ui = mountKeyedStudio(testContext);
  const before = ui.controller.exportRecipe();
  const marker = ui.marker(2);
  dragMarker(ui, marker, 2, 1.234);
  dispatch(marker, 'pointermove', { clientX: ui.clientXAt(1.234) });
  assert.equal(marker.style.insetInlineStart, keyMarkerOffset(1.23, ui.duration()), 'the marker follows the pointer, snapped to 0.01 s');
  assert.deepEqual(ui.controller.exportRecipe(), before, 'nothing reaches the controller while the pointer moves');
  dispatch(marker, 'pointerup', { clientX: ui.clientXAt(1.234) });
  assert.deepEqual(ui.keyTimes(), [0, 1.23]);
  assert.equal(ui.marker(1.23).getAttribute('aria-pressed'), 'true');
  ui.controller.undo();
  assert.deepEqual(ui.controller.exportRecipe().motion, before.motion);
  assert.deepEqual(ui.keyTimes(), [0, 2]);
});

test('Escape during a drag cancels it with no change', testContext => {
  const ui = mountKeyedStudio(testContext);
  const before = ui.controller.exportRecipe();
  const marker = ui.marker(2);
  dragMarker(ui, marker, 2, 0.5);
  const escape = dispatch(marker, 'keydown', { key: 'Escape' });
  assert.equal(escape.propagationStopped, true);
  assert.equal(ui.marker(2).style.insetInlineStart, keyMarkerOffset(2, ui.duration()));
  dispatch(marker, 'pointerup', { clientX: ui.clientXAt(0.5) });
  assert.deepEqual(ui.controller.exportRecipe(), before);
  assert.equal(ui.controller.canUndo, true, 'only the set-up edits are on the undo stack');
  ui.controller.undo();
  ui.controller.undo();
  ui.controller.undo();
  assert.equal(ui.controller.exportRecipe().motion ?? null, null);
});

test('a click without movement only selects: the pointer goes down and up and the key stays', testContext => {
  const ui = mountKeyedStudio(testContext);
  const before = ui.controller.exportRecipe();
  const marker = ui.marker(2);
  dispatch(marker, 'pointerdown', { clientX: ui.clientXAt(2) });
  dispatch(marker, 'pointermove', { clientX: ui.clientXAt(2) + 1 });
  dispatch(marker, 'pointerup', { clientX: ui.clientXAt(2) + 1 });
  marker.click();
  assert.deepEqual(ui.controller.exportRecipe(), before);
  assert.equal(ui.marker(2).getAttribute('aria-pressed'), 'true');
});

test('the arrow keys nudge a focused marker by 0.1 s, Shift by 0.01 s, each one undo step', testContext => {
  const ui = mountKeyedStudio(testContext);
  ui.marker(2).focus();
  const right = dispatch(ui.marker(2), 'keydown', { key: 'ArrowRight' });
  assert.equal(right.propagationStopped, true);
  assert.deepEqual(ui.keyTimes(), [0, 2 + KEY_NUDGE_STEP]);
  const focused = ui.dom.document.activeElement;
  assert.equal(focused.getAttribute('aria-label'), 'Key at 2.10 s', 'the focus stays on the key that moved');
  dispatch(focused, 'keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(ui.keyTimes(), [0, 2.09]);
  assert.equal(ui.dom.document.activeElement.getAttribute('aria-label'), 'Key at 2.09 s');
  ui.controller.undo();
  assert.deepEqual(ui.keyTimes(), [0, 2.1]);
  ui.controller.undo();
  assert.deepEqual(ui.keyTimes(), [0, 2]);
  dispatch(ui.marker(0), 'keydown', { key: 'ArrowLeft' });
  assert.deepEqual(ui.keyTimes(), [0, 2], 'a key at the start does not go below zero');
});

test('Delete and Backspace on a marker remove that key only, and the object survives', testContext => {
  const ui = mountKeyedStudio(testContext);
  const event = dispatch(ui.marker(2), 'keydown', { key: 'Delete' });
  assert.equal(event.propagationStopped, true);
  assert.deepEqual(ui.keyTimes(), [0]);
  assert.ok(ui.controller.exportRecipe().nodes.some(node => node.id === 'hero'));
  assert.equal(ui.controller.selectedNodeId, 'hero');
  dispatch(ui.marker(0), 'keydown', { key: 'Backspace' });
  assert.deepEqual(ui.keyTimes(), []);
  assert.ok(ui.controller.exportRecipe().nodes.some(node => node.id === 'hero'));
  ui.controller.undo();
  assert.deepEqual(ui.keyTimes(), [0]);
});

test('the X key on a marker is the delete binding too and still leaves the object alone', testContext => {
  const ui = mountKeyedStudio(testContext);
  dispatch(ui.marker(2), 'keydown', { key: 'x' });
  assert.deepEqual(ui.keyTimes(), [0]);
  assert.ok(ui.controller.exportRecipe().nodes.some(node => node.id === 'hero'));
});

test('Delete away from a marker still deletes the selected object', testContext => {
  const ui = mountKeyedStudio(testContext);
  dispatch(ui.root.querySelector('canvas'), 'keydown', { key: 'Delete' });
  assert.equal(ui.controller.exportRecipe().nodes.some(node => node.id === 'hero'), false);
});

test('a keyed object’s fields are editable with Auto-key on and locked with it off', testContext => {
  const ui = mountKeyedStudio(testContext);
  const positionX = ui.positionField('X');
  assert.equal(positionX.disabled, false);
  ui.controller.setMotionTime(2);
  assert.equal(positionX.value, '3', 'the field shows the pose on screen at the playhead');
  positionX.value = '5';
  dispatch(positionX, 'change');
  assert.equal(ui.controller.nodePose('hero').translation[0], 5);
  assert.deepEqual(ui.keyTimes(), [0, 2]);

  ui.controller.setAutoKey(false);
  assert.equal(ui.positionField('X').disabled, true);
  const lockedRow = ui.positionField('X').parentNode.parentNode.parentNode;
  assert.equal(lockedRow.title, 'Animated by a track. Turn on Auto-key to edit.');
  const lockedMark = lockedRow.querySelector('.crucible-studio-driven-mark');
  assert.equal(lockedMark.hidden, false, 'a locked row carries the keyframe mark');
  assert.equal(lockedMark.getAttribute('aria-label'), 'Animated by a track');
  ui.controller.setAutoKey(true);
  assert.equal(lockedMark.hidden, true, 'the mark leaves when the row unlocks');
  ui.controller.setAutoKey(false);
  ui.controller.selectNode('orb');
  assert.equal(ui.positionField('X').disabled, false, 'an object with no track is never locked');
});

function makeKeyedController() {
  const controller = createStudioController({ scene: createAgentScene(makeRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.insertNodeKeyframe('hero');
  controller.setMotionTime(2);
  return controller;
}

function shownX(controller, nodeId = 'hero') {
  return controller.nodePose(nodeId).translation[0];
}

function beginDragAlongX(controller) {
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const pointAt = distance => controller.projectWorldPoint([handles.pivot[0] + handles.handleLength + distance, handles.pivot[1], handles.pivot[2]]);
  const grab = pointAt(0);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  return pointAt;
}

test('dragging a keyed object shows the pose live, before release', () => {
  const controller = makeKeyedController();
  const pointAt = beginDragAlongX(controller);
  const first = pointAt(1);
  controller.updateGizmoDrag(first.x, first.y);
  assert.ok(Math.abs(shownX(controller) - 1) < 0.02, `shown x ${shownX(controller)}`);
  const second = pointAt(2);
  controller.updateGizmoDrag(second.x, second.y);
  assert.ok(Math.abs(shownX(controller) - 2) < 0.02, `shown x ${shownX(controller)}`);
  assert.deepEqual(controller.nodeKeyframeTimes('hero'), [0, 2], 'one key at the playhead, however many moves');
  controller.endGizmoDrag();
  assert.ok(Math.abs(shownX(controller) - 2) < 0.02);
});

test('cancelling a drag of a keyed object puts the motion and the pose back as they were', () => {
  const controller = makeKeyedController();
  const before = JSON.stringify(controller.exportRecipe());
  const pointAt = beginDragAlongX(controller);
  const moved = pointAt(1);
  controller.updateGizmoDrag(moved.x, moved.y);
  assert.notEqual(JSON.stringify(controller.exportRecipe()), before);
  controller.cancelGizmoDrag();
  assert.equal(JSON.stringify(controller.exportRecipe()), before);
});

test('the whole drag of a keyed object is one undo step', () => {
  const controller = makeKeyedController();
  const before = controller.exportRecipe();
  const pointAt = beginDragAlongX(controller);
  for (const distance of [0.5, 1, 1.5]) {
    const point = pointAt(distance);
    controller.updateGizmoDrag(point.x, point.y);
  }
  controller.endGizmoDrag();
  assert.notDeepEqual(controller.exportRecipe(), before);
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), before);
  controller.redo();
  assert.ok(Math.abs(shownX(controller) - 1.5) < 0.02);
});

test('dragging an object with no track, or with auto-key off, writes no motion while it moves', () => {
  const controller = makeKeyedController();
  controller.selectNode('orb');
  const unkeyedPointAt = beginDragAlongX(controller);
  const unkeyedPoint = unkeyedPointAt(1);
  controller.updateGizmoDrag(unkeyedPoint.x, unkeyedPoint.y);
  assert.deepEqual(controller.nodeKeyframeTimes('orb'), []);
  controller.cancelGizmoDrag();
  controller.selectNode('hero');
  controller.setAutoKey(false);
  const motionBefore = JSON.stringify(controller.exportRecipe().motion);
  const offPointAt = beginDragAlongX(controller);
  const offPoint = offPointAt(1);
  controller.updateGizmoDrag(offPoint.x, offPoint.y);
  assert.equal(JSON.stringify(controller.exportRecipe().motion), motionBefore);
  controller.cancelGizmoDrag();
});

test('one pointer move of a keyed object on a motion of 20 tracks of 20 keys stays quick', () => {
  const recipe = makeRecipe();
  for (let index = 0; index < 19; index += 1) {
    recipe.nodes.push({ id: `extra${index}`, geometry: 'cube', material: 'paint', translation: [index, 0, 0] });
  }
  recipe.motion = {
    duration: 4,
    loop: true,
    tracks: recipe.nodes.slice(0, 20).map(node => ({
      kind: 'node',
      id: node.id,
      property: 'translation',
      keyframes: Array.from({ length: 20 }, (_, index) => ({ time: index * 0.2, value: [index * 0.1, 0.5, 0] })),
    })),
  };
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.setMotionTime(2);
  const pointAt = beginDragAlongX(controller);
  const warmUp = pointAt(0.1);
  controller.updateGizmoDrag(warmUp.x, warmUp.y);
  const moves = 50;
  const started = performance.now();
  for (let move = 0; move < moves; move += 1) {
    const point = pointAt(0.2 + move * 0.01);
    controller.updateGizmoDrag(point.x, point.y);
  }
  const millisecondsPerMove = (performance.now() - started) / moves;
  controller.cancelGizmoDrag();
  console.log(`drag move on 20 tracks x 20 keys: ${millisecondsPerMove.toFixed(2)} ms`);
  assert.ok(millisecondsPerMove < 50, `${millisecondsPerMove} ms per move`);
});
