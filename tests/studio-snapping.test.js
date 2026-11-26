import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudioController } from '../src/studio.js';
import { normalizeStudioPreferences, STUDIO_PREFERENCE_DEFAULTS } from '../src/studio-preferences.js';
import {
  OWN_VERTEX_LIMIT,
  SNAP_TARGET_IDS,
  VERTEX_SNAP_MAX_RANKED_PARTS,
  VERTEX_SNAP_MAX_VERTICES,
  buildEditSnapSources,
  findVertexUnderPointer,
  moveToLandVertex,
  sampleVertices,
  snapIsActive,
  snapScaleFactor,
  snapToStep,
} from '../src/studio-snapping.js';

function snapRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0 },
      { id: 'sphere', type: 'sphere', segments: 16, rings: 12 },
    ],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'paint', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'sphere', material: 'paint', translation: [-2.2, 0.5, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'block', geometry: 'cube', material: 'paint', translation: [3, 0.5, 0] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function mountController(settings = {}) {
  const controller = createStudioController({ scene: createAgentScene(snapRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.setInteractionSettings(settings);
  controller.selectNode('hero');
  return controller;
}

const nodeOf = (controller, id) => controller.exportRecipe().nodes.find(node => node.id === id);

function alongAxis(controller, axis, distance) {
  const handles = controller.gizmoHandles();
  return controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis[axis][index] * distance));
}

// Drags the hero along X by `travel` metres from its handle tip and returns its final x.
function dragAlongX(controller, travel, options) {
  const handles = controller.gizmoHandles();
  const grab = alongAxis(controller, 'x', handles.handleLength);
  const release = alongAxis(controller, 'x', handles.handleLength + travel);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y, options);
  controller.endGizmoDrag();
  return nodeOf(controller, 'hero').translation[0];
}

test('snapping is on when the toggle is on, flipped while Ctrl is held', () => {
  assert.equal(snapIsActive(false, false), false);
  assert.equal(snapIsActive(true, false), true);
  assert.equal(snapIsActive(false, true), true);
  assert.equal(snapIsActive(true, true), false);
});

test('the step helpers land on multiples of the step and a snapped scale never collapses', () => {
  assert.equal(snapToStep(0.8, 0.25), 0.75);
  assert.equal(snapToStep(-0.4, 0.25), -0.5);
  assert.equal(snapScaleFactor(1.04), 1);
  assert.ok(Math.abs(snapScaleFactor(1.26) - 1.3) < 1e-9);
  assert.ok(Math.abs(snapScaleFactor(0.01) - 0.1) < 1e-9, 'the smallest snapped scale is one step');
});

test('a vertex target is the nearest vertex of the parts within the pixel radius, searched within the caps', () => {
  const corner = (x, y, z) => [x, y, z];
  const part = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], geometry: { positions: Float32Array.from([...corner(0, 0, 0), ...corner(1, 0, 0), ...corner(1, 1, 0)]) } };
  const project = point => ({ x: point[0] * 100, y: point[1] * 100 });
  const found = findVertexUnderPointer({ parts: [part], project, pointer: { x: 103, y: 4 } });
  assert.deepEqual(found.point, [1, 0, 0]);
  assert.equal(findVertexUnderPointer({ parts: [part], project, pointer: { x: 150, y: 50 } }), null, 'nothing within 12 pixels');
  assert.equal(findVertexUnderPointer({ parts: [part], project, pointer: { x: 111, y: 0 } }).point[0], 1, '11 pixels is in reach');
  assert.equal(findVertexUnderPointer({ parts: [part], project, pointer: { x: 113, y: 0 } }), null, '13 pixels is not');

  const heavy = Array.from({ length: 100 }, (_, index) => ({
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index, 0, 0, 1],
    geometry: { positions: new Float32Array(3000) },
  }));
  let projections = 0;
  const counting = point => {
    projections += 1;
    return project(point);
  };
  findVertexUnderPointer({ parts: heavy, project: counting, pointer: { x: 0, y: 0 }, maxParts: 10, maxVertices: 200 });
  assert.ok(projections <= 100 + 10 + 200 + 10, `projected ${projections} points for 100 parts of 1000 vertices`);
  assert.equal(sampleVertices(heavy, 64).length <= 64 + heavy.length, true, 'the moved object contributes a bounded sample');
});

test('the move that lands the nearest own vertex on a target is the whole move from the start', () => {
  const own = [[0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
  assert.deepEqual(moveToLandVertex(own, [1.6, 0, 0], [2, 1, 0.5]), [1.5, 0.5, 0]);
  assert.equal(moveToLandVertex([], [0, 0, 0], [1, 1, 1]), null);
});

test('snapping state is a validated setting of the controller, off and Increment to start', () => {
  const controller = mountController();
  assert.deepEqual([controller.interactionSettings.snapEnabled, controller.interactionSettings.snapTarget], [false, 'increment']);
  controller.setInteractionSettings({ snapEnabled: true, snapTarget: 'face' });
  assert.deepEqual([controller.interactionSettings.snapEnabled, controller.interactionSettings.snapTarget], [true, 'face']);
  assert.throws(() => controller.setInteractionSettings({ snapTarget: 'edge' }), /snapTarget must be one of increment, vertex, face/);
  assert.throws(() => controller.setInteractionSettings({ snapEnabled: 'yes' }), /snapEnabled must be true or false/);
});

test('the snapping state is a stored preference: kept when valid, dropped when not, back to off by Reset', () => {
  assert.deepEqual([STUDIO_PREFERENCE_DEFAULTS.snapEnabled, STUDIO_PREFERENCE_DEFAULTS.snapTarget], [false, 'increment']);
  const kept = normalizeStudioPreferences({ snapEnabled: true, snapTarget: 'vertex' });
  assert.deepEqual([kept.snapEnabled, kept.snapTarget], [true, 'vertex']);
  const damaged = normalizeStudioPreferences({ snapEnabled: 'on', snapTarget: 'edge' });
  assert.deepEqual([damaged.snapEnabled, damaged.snapTarget], [false, 'increment']);
  assert.deepEqual(SNAP_TARGET_IDS, ['increment', 'vertex', 'face']);
});

test('Increment: a move along an axis lands on the step, free when off, flipped by Ctrl in both directions', () => {
  assert.ok(Math.abs(dragAlongX(mountController({ snapEnabled: true }), 0.8) - 0.75) < 1e-6, 'on: 0.8 m becomes 0.75 m');
  const free = dragAlongX(mountController({ snapEnabled: false }), 0.8);
  assert.ok(Math.abs(free - 0.8) < 0.02 && Math.abs(free - 0.75) > 0.01, `off: the move stays free, got ${free}`);
  assert.ok(Math.abs(dragAlongX(mountController({ snapEnabled: false }), 0.8, { ctrlKey: true }) - 0.75) < 1e-6, 'off and Ctrl: snaps');
  const flippedOff = dragAlongX(mountController({ snapEnabled: true }), 0.8, { ctrlKey: true });
  assert.ok(Math.abs(flippedOff - free) < 1e-6 || Math.abs(flippedOff - 0.8) < 0.02, `on and Ctrl: free, got ${flippedOff}`);
  const stepped = dragAlongX(mountController({ snapEnabled: true, moveSnapStep: 0.5 }), 1.2);
  assert.ok(Math.abs(stepped - 1) < 1e-6, 'the step comes from the setting');
});

test('Increment: a free move in a plane puts the position on the grid; Ctrl lets go mid drag', () => {
  const controller = mountController({ snapEnabled: true });
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  const snapped = controller.updateGizmoDrag(origin.x + 83, origin.y - 41);
  for (const component of snapped.translation) {
    assert.ok(Math.abs(component / 0.25 - Math.round(component / 0.25)) < 1e-6, `${component} is on the 0.25 grid`);
  }
  const freed = controller.updateGizmoDrag(origin.x + 83, origin.y - 41, { ctrlKey: true });
  assert.ok(freed.translation.some(component => Math.abs(component / 0.25 - Math.round(component / 0.25)) > 1e-3), 'Ctrl held: the same pointer position is free');
  const snappedAgain = controller.updateGizmoDrag(origin.x + 83, origin.y - 41, { ctrlKey: false });
  assert.deepEqual(snappedAgain.translation, snapped.translation, 'letting Ctrl go snaps again');
  controller.endGizmoDrag();
});

test('Rotate and Scale use their steps whenever snapping is on, whatever the target', () => {
  for (const snapTarget of SNAP_TARGET_IDS) {
    const controller = mountController({ snapEnabled: true, snapTarget });
    controller.setTool('rotate');
    const handles = controller.gizmoHandles();
    const ringPoint = degrees => controller.projectWorldPoint([
      handles.pivot[0] + Math.cos((degrees * Math.PI) / 180),
      handles.pivot[1],
      handles.pivot[2] - Math.sin((degrees * Math.PI) / 180),
    ]);
    controller.beginGizmoDrag('y', ringPoint(0).x, ringPoint(0).y);
    controller.updateGizmoDrag(ringPoint(33).x, ringPoint(33).y);
    controller.endGizmoDrag();
    assert.ok(Math.abs(nodeOf(controller, 'hero').rotation[1] - Math.sin((15 * Math.PI) / 180)) < 1e-3, `${snapTarget}: 33 degrees becomes 30`);

    controller.setTool('scale');
    const scaleHandles = controller.gizmoHandles();
    controller.beginGizmoDrag('uniform', scaleHandles.origin.x, scaleHandles.origin.y);
    controller.updateGizmoDrag(scaleHandles.origin.x + 41, scaleHandles.origin.y);
    controller.endGizmoDrag();
    const scale = nodeOf(controller, 'hero').scale;
    assert.ok(scale.every(component => Math.abs(component * 10 - Math.round(component * 10)) < 1e-6), `${snapTarget}: scale ${scale} is on steps of 0.1`);
    assert.ok(scale[0] > 1.3, 'the drag did scale it');
  }
  const free = mountController({ snapEnabled: false });
  free.setTool('scale');
  const origin = free.gizmoHandles().origin;
  free.beginGizmoDrag('uniform', origin.x, origin.y);
  free.updateGizmoDrag(origin.x + 41, origin.y);
  free.endGizmoDrag();
  assert.ok(Math.abs(nodeOf(free, 'hero').scale[0] * 10 - Math.round(nodeOf(free, 'hero').scale[0] * 10)) > 1e-3, 'off: the scale is not on a step');
});

function cornerOfBlock() {
  return [2.5, 1, 0.5];
}

test('Vertex: a free move lands a vertex of the moved object on the vertex under the pointer, with a marker', () => {
  const controller = mountController({ snapEnabled: true, snapTarget: 'vertex' });
  const origin = controller.gizmoHandles().origin;
  const target = controller.projectWorldPoint(cornerOfBlock());
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  assert.equal(controller.snapMarker(), null, 'no marker before the pointer moves');
  controller.updateGizmoDrag(target.x + 5, target.y - 4);
  const marker = controller.snapMarker();
  assert.ok(Math.hypot(marker.x - target.x, marker.y - target.y) < 0.5, 'the marker sits on the vertex being snapped to');
  const translation = nodeOf(controller, 'hero').translation;
  const lands = [-0.5, 0.5].some(x => [-0.5, 0.5].some(y => [-0.5, 0.5].some(z => (
    Math.hypot(translation[0] + x - 2.5, translation[1] + y - 1, translation[2] + z - 0.5) < 1e-3
  ))));
  assert.ok(lands, `a corner of the moved cube is on the block's corner, centre ${translation}`);
  controller.updateGizmoDrag(target.x + 60, target.y + 60);
  assert.equal(controller.snapMarker(), null, 'out of reach: no marker and a free move');
  controller.updateGizmoDrag(target.x, target.y, { ctrlKey: true });
  assert.equal(controller.snapMarker(), null, 'Ctrl flips snapping off, and the marker goes');
  controller.endGizmoDrag();
  assert.equal(controller.snapMarker(), null, 'no marker once the drag is over');
});

test('Face: a free move drops the object on the surface under the pointer; the surface is never another selected object', () => {
  const controller = mountController({ snapEnabled: true, snapTarget: 'face' });
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  const origin = controller.gizmoHandles().origin;
  const orbBefore = nodeOf(controller, 'orb').translation.slice();
  const heroBefore = nodeOf(controller, 'hero').translation.slice();
  const overOrb = controller.projectWorldPoint(orbBefore);
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(overOrb.x, overOrb.y);
  const hero = nodeOf(controller, 'hero').translation;
  assert.ok(hero[1] > 0.45 && hero[1] < 0.55, `the cube rests on the ground, not on the selected sphere, y = ${hero[1]}`);
  const orb = nodeOf(controller, 'orb').translation;
  [0, 1, 2].forEach(axis => assert.ok(Math.abs((orb[axis] - orbBefore[axis]) - (hero[axis] - heroBefore[axis])) < 1e-6, 'the other object keeps its offset'));
  controller.endGizmoDrag();
});

test('several selected objects move together with their offsets, by axis and by step, and cancel puts all back', () => {
  const controller = mountController({ snapEnabled: true });
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  const heroX = dragAlongX(controller, 0.8);
  assert.ok(Math.abs(heroX - 0.75) < 1e-6);
  assert.ok(Math.abs(nodeOf(controller, 'orb').translation[0] - (-2.2 + 0.75)) < 1e-6, 'the active object snaps and the other keeps its offset');
  assert.equal(nodeOf(controller, 'block').translation[0], 3, 'an unselected object stays');
  controller.undo();
  assert.equal(nodeOf(controller, 'hero').translation[0], 0);
  assert.equal(nodeOf(controller, 'orb').translation[0], -2.2);

  const handles = controller.gizmoHandles();
  const grab = alongAxis(controller, 'x', handles.handleLength);
  const release = alongAxis(controller, 'x', handles.handleLength + 1);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  assert.notEqual(nodeOf(controller, 'orb').translation[0], -2.2);
  controller.cancelGizmoDrag();
  assert.equal(nodeOf(controller, 'hero').translation[0], 0);
  assert.equal(nodeOf(controller, 'orb').translation[0], -2.2, 'cancel puts every selected object back');
});

test('the Snap tool is gone and the old surface axis is refused', () => {
  const controller = mountController();
  assert.throws(() => controller.setTool('snap'), /Unknown Studio tool "snap"/);
  assert.throws(() => controller.beginGizmoDrag('surface', 10, 10), /Unsupported gizmo axis "surface"/);
});

test('Shift+Tab is the snapping key; Tab alone still edits the mesh and leaves it', async () => {
  const { findKeymapAction, resolveKeymapPreset } = await import('../src/studio-keymap.js');
  const keymap = resolveKeymapPreset('crucible');
  const press = (properties, context) => findKeymapAction(keymap, { key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...properties }, context)?.actionId;
  assert.equal(press({ shiftKey: true }, 'normal'), 'snap.toggle');
  assert.equal(press({}, 'normal'), 'mesh.enter');
  assert.equal(press({}, 'mesh'), 'mesh.leave');
  assert.equal(press({ shiftKey: true }, 'mesh'), undefined, 'in edit mode Shift+Tab is not the way out, so it falls through to snapping');
  assert.equal(keymap.actions.some(action => action.id === 'tool.snap'), false, 'the Snap tool has no key left');
});

test('two vertices at the same spot on screen go to the one nearer the camera', () => {
  const part = depth => ({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], geometry: { positions: Float32Array.from([0, 0, depth]) } });
  const project = point => ({ x: 100, y: 100, depth: point[2] });
  const found = findVertexUnderPointer({ parts: [part(5), part(2), part(9)], project, pointer: { x: 101, y: 100 } });
  assert.deepEqual(found.point, [0, 0, 2]);
});

test('Increment in a plane puts the position on the grid along the plane and keeps the height across it', () => {
  const controller = mountController({ snapEnabled: true });
  controller.setCameraViewPreset('isometric');
  const corners = controller.gizmoHandles().planes.xz;
  const centre = { x: corners.reduce((sum, corner) => sum + corner.x, 0) / 4, y: corners.reduce((sum, corner) => sum + corner.y, 0) / 4 };
  controller.beginGizmoDrag('xz', centre.x, centre.y);
  const moved = controller.updateGizmoDrag(centre.x + 57, centre.y + 13).translation;
  assert.equal(moved[1], 0.5, 'the cube stays at its height instead of dropping to the grid');
  assert.ok(Math.abs(moved[0] / 0.25 - Math.round(moved[0] / 0.25)) < 1e-6 && Math.abs(moved[2] / 0.25 - Math.round(moved[2] / 0.25)) < 1e-6, `${moved} is on the grid in X and Z`);
  controller.endGizmoDrag();
});

test('the search is bounded by hard caps however many parts the scene has, and so is the moved object sample', () => {
  const parts = Array.from({ length: 5000 }, (_, index) => ({
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index, 0, 0, 1],
    geometry: { positions: new Float32Array(300) },
  }));
  let projections = 0;
  const counting = point => {
    projections += 1;
    return { x: point[0], y: point[1], depth: point[2] };
  };
  findVertexUnderPointer({ parts, project: counting, pointer: { x: 0, y: 0 } });
  assert.ok(projections <= VERTEX_SNAP_MAX_RANKED_PARTS + VERTEX_SNAP_MAX_VERTICES, `projected ${projections} points for 5000 parts`);
  assert.ok(sampleVertices(parts).length <= OWN_VERTEX_LIMIT, 'the moved object tries at most the cap, over all its parts');
  assert.ok(sampleVertices(parts, 64).length <= 64);
  const fewParts = sampleVertices(parts.slice(0, 3));
  assert.ok(fewParts.length > 3 && fewParts.length <= OWN_VERTEX_LIMIT, 'a few parts share the cap');
});

test('Shift alone no longer steps a move: the key is Ctrl', () => {
  const controller = mountController({ snapEnabled: false });
  const onStep = value => Math.abs(value / 0.25 - Math.round(value / 0.25)) < 1e-6;
  const heroX = dragAlongX(controller, 0.83, { shiftKey: true });
  assert.equal(onStep(heroX), false, `Shift leaves the move free: ${heroX}`);
});

test('preferences stored before the snapping state existed load with snapping off and Increment', () => {
  const loaded = normalizeStudioPreferences({ theme: 'dark', moveSnapStep: 1, setupDone: true });
  assert.equal(loaded.snapEnabled, false);
  assert.equal(loaded.snapTarget, 'increment');
  assert.equal(loaded.moveSnapStep, 1, 'what was stored stays');
});

test('Vertex: several selected objects move together by the same step when the active one lands on a vertex', () => {
  const controller = mountController({ snapEnabled: true, snapTarget: 'vertex' });
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  const heroBefore = nodeOf(controller, 'hero').translation.slice();
  const orbBefore = nodeOf(controller, 'orb').translation.slice();
  const origin = controller.gizmoHandles().origin;
  const target = controller.projectWorldPoint(cornerOfBlock());
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(target.x + 5, target.y - 4);
  assert.ok(controller.snapMarker(), 'a vertex was found');
  controller.endGizmoDrag();
  const heroAfter = nodeOf(controller, 'hero').translation;
  const orbAfter = nodeOf(controller, 'orb').translation;
  assert.ok(Math.hypot(...heroAfter.map((value, axis) => value - heroBefore[axis])) > 1, 'the active object moved');
  [0, 1, 2].forEach(axis => {
    assert.ok(Math.abs((orbAfter[axis] - orbBefore[axis]) - (heroAfter[axis] - heroBefore[axis])) < 1e-6, 'the other object keeps its offset');
  });
});

test('under auto-key the other selected objects move from the pose they show at this time', () => {
  const controller = mountController({});
  controller.setAutoKey(true);
  controller.setMotionTime(0);
  controller.selectNode('orb');
  controller.insertNodeKeyframe('orb');
  controller.setMotionTime(2);
  controller.updateNodeTransform('orb', { translation: [-0.2, 0.5, 0] });
  controller.setMotionTime(1);
  const partX = id => controller.scene.parts.find(part => part.name === id).matrix[12];
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  const heroBefore = partX('hero');
  const orbBefore = partX('orb');
  assert.ok(Math.abs(orbBefore - -1.2) < 1e-6, `orb shows its sampled pose half way: ${orbBefore}`);
  dragAlongX(controller, 0.8);
  const heroShift = partX('hero') - heroBefore;
  assert.ok(Math.abs(heroShift) > 0.5, `the active object moved: ${heroShift}`);
  assert.ok(Math.abs((partX('orb') - orbBefore) - heroShift) < 1e-6, `the other object moved by the same amount from what it shows: ${partX('orb')}`);
});

test('buildEditSnapSources separates moved vertices from unmoved vertices and unmoved faces', () => {
  const mesh = {
    vertexCount: 4,
    faceCount: 2,
    faceOffsets: Int32Array.from([0, 3, 6]),
    cornerVertices: Int32Array.from([0, 1, 2, 1, 2, 3]),
  };
  const positions = Float32Array.from([9, 9, 9, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const basePositions = Float32Array.from([0, 0, 0]);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1];
  const sources = buildEditSnapSources({
    mesh,
    positions,
    basePositions,
    movedVertices: [0],
    seedVertices: [0],
    matrix,
  });
  assert.deepEqual(sources.ownPoints, [[2, 0, 0]], 'moved vertex uses start-of-drag basePositions in world space');
  assert.equal(sources.unmovedVertexPart.geometry.positions.length, 9, 'only the 3 unmoved vertices are targets');
  assert.deepEqual(Array.from(sources.unmovedVertexPart.geometry.positions), [1, 0, 0, 0, 1, 0, 1, 1, 0]);
  assert.equal(sources.unmovedFacePart.geometry.indices.length, 3, 'the face touching vertex 0 is excluded; the other face stays');
  assert.deepEqual(Array.from(sources.unmovedFacePart.geometry.indices), [1, 2, 3]);
});
