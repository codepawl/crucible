import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { MAX_POINT_LIGHTS } from '../src/light-limits.js';
import { hexToLinearRgb } from '../src/studio-controller.js';
import {
  STUDIO_PRIMITIVE_GROUPS,
  STUDIO_PRIMITIVES,
  STUDIO_TABS,
  STUDIO_TEMPLATES,
  STUDIO_TOOLS,
  buildTemplateRecipe,
  createStudioController,
} from '../src/studio.js';
import { STUDIO_ICON_NAMES, STUDIO_ICON_PATHS, studioIconPath } from '../src/studio-icons.js';
import { primitiveGeometrySpec } from '../src/studio-templates.js';

function makeStudioRecipe({ animated = false, loop = true } = {}) {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0.04 },
      { id: 'sphere', type: 'sphere', segments: 16, rings: 12 },
    ],
    materials: [
      { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
      { id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 },
    ],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'sphere', material: 'paint', translation: [2.2, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
    camera: {
      eye: [0, 2, 6],
      target: [0, 0.5, 0],
      up: [0, 1, 0],
      fov: 45,
      near: 0.1,
      far: 100,
    },
    environment: {
      setup: 'studio',
      lightDirection: [-2, 5, 3],
    },
  };
  if (animated) {
    recipe.motion = {
      duration: 1.5,
      loop,
      tracks: [
        {
          kind: 'node',
          id: 'hero',
          property: 'translation',
          keyframes: [
            { time: 0, value: [0, 0.5, 0] },
            { time: 1.5, value: [0, 1.5, 0] },
          ],
        },
      ],
    };
  }
  return recipe;
}

test('createStudioController validates inputs and enforces tool, tab and node bounds', () => {
  assert.throws(() => createStudioController({}), /requires a scene/);
  const scene = createAgentScene(makeStudioRecipe());
  assert.throws(() => createStudioController({ scene, viewportWidth: 0 }), /viewportWidth/);
  assert.throws(() => createStudioController({ scene, maxHistory: 0 }), /maxHistory/);

  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  assert.deepEqual(STUDIO_TOOLS, ['select', 'translate', 'rotate', 'scale', 'snap']);
  assert.deepEqual(STUDIO_TABS, ['node', 'modifiers', 'material', 'look', 'camera']);
  assert.throws(() => controller.selectNode('missing-node'), /Unknown node/);
  assert.throws(() => controller.setTool('sculpt'), /Unknown Studio tool/);
  assert.throws(() => controller.setActiveTab('physics'), /Unknown Studio tab/);
  assert.throws(() => controller.saveBookmark('bad name!'), /Bookmark name/);
  assert.throws(() => controller.applyBookmark('missing'), /Unknown camera bookmark/);
  assert.throws(() => controller.removeBookmark('missing'), /Unknown camera bookmark/);
  assert.throws(() => controller.setMotionTime(9999), /Motion time/);
  controller.selectNode(null);
  assert.throws(() => controller.beginGizmoDrag('x', 100, 100), /Select a node/);
  controller.dispose();
});

test('viewport projection, unprojection and click picking select the frontmost node or clear on sky', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });

  const heroScreen = controller.projectWorldPoint([0, 0.5, 0]);
  assert.equal(heroScreen.visible, true);
  assert.ok(Math.abs(heroScreen.x - 400) < 2);
  assert.ok(Math.abs(heroScreen.y - 300) < 2);

  const hitHero = controller.pickAt(heroScreen.x, heroScreen.y);
  assert.equal(hitHero?.id, 'hero');
  assert.equal(controller.selectedNodeId, 'hero');

  const orbScreen = controller.projectWorldPoint([2.2, 0.5, 0]);
  const hitOrb = controller.pickAt(orbScreen.x, orbScreen.y);
  assert.equal(hitOrb?.id, 'orb');
  assert.equal(controller.selectedNodeId, 'orb');

  const skyHit = controller.pickAt(15, 15);
  assert.equal(skyHit, null);
  assert.equal(controller.selectedNodeId, null);

  // Trigger a topology change via add-node and ensure pick still indexes the new geometry cleanly.
  scene.apply([
    { type: 'add-node', node: { id: 'extra', geometry: 'cube', material: 'paint', translation: [-2.2, 0.5, 0] } },
  ], { expectedRevision: scene.revision });
  const extraScreen = controller.projectWorldPoint([-2.2, 0.5, 0]);
  const hitExtra = controller.pickAt(extraScreen.x, extraScreen.y);
  assert.equal(hitExtra?.id, 'extra');
  controller.dispose();
});

test('gizmo handles and drags update translate, rotate with snap, scale and surface snap in the recipe', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');

  const heroNode = () => controller.exportRecipe().nodes.find(node => node.id === 'hero');
  const pointAlong = (handles, axis, distance) => controller.projectWorldPoint([
    handles.pivot[0] + handles.basis[axis][0] * distance,
    handles.pivot[1] + handles.basis[axis][1] * distance,
    handles.pivot[2] + handles.basis[axis][2] * distance,
  ]);

  let handles = controller.gizmoHandles();
  assert.ok(handles);
  assert.equal(handles.origin.visible, true);
  assert.deepEqual(handles.basis, { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });

  // Translate along X: the object ends exactly where the pointer went along the axis.
  controller.setTool('translate');
  let grab = pointAlong(handles, 'x', handles.handleLength);
  let release = pointAlong(handles, 'x', handles.handleLength + 0.8);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  assert.equal(controller.endGizmoDrag(), true);
  assert.ok(Math.abs(heroNode().translation[0] - 0.8) < 0.01, `expected x near 0.8, got ${heroNode().translation[0]}`);
  assert.ok(Math.abs(heroNode().translation[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(heroNode().translation[2]) < 1e-6);

  // Rotate around Y: the turn equals the angle the pointer swept on the ring, snapped to 15 degrees.
  controller.setTool('rotate');
  handles = controller.gizmoHandles();
  const ringPoint = degrees => controller.projectWorldPoint([
    handles.pivot[0] + Math.cos((degrees * Math.PI) / 180),
    handles.pivot[1],
    handles.pivot[2] - Math.sin((degrees * Math.PI) / 180),
  ]);
  grab = ringPoint(0);
  release = ringPoint(33);
  controller.beginGizmoDrag('y', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y, { shiftKey: true });
  controller.endGizmoDrag();
  const rotated = heroNode();
  assert.ok(Math.abs(Math.hypot(...rotated.rotation) - 1) < 1e-3);
  assert.ok(Math.abs(rotated.rotation[1] - Math.sin((15 * Math.PI) / 180)) < 1e-3, `expected a 30 degree turn, got ${rotated.rotation}`);

  // The handles now follow the turned object, and a drag along its X moves it along that turned axis.
  controller.setTool('translate');
  handles = controller.gizmoHandles();
  const turnedX = [Math.cos(Math.PI / 6), 0, -Math.sin(Math.PI / 6)];
  handles.basis.x.forEach((value, index) => assert.ok(Math.abs(value - turnedX[index]) < 1e-3));
  const beforeLocalMove = heroNode().translation;
  grab = pointAlong(handles, 'x', handles.handleLength);
  release = pointAlong(handles, 'x', handles.handleLength + 0.5);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  controller.endGizmoDrag();
  const afterLocalMove = heroNode().translation;
  turnedX.forEach((value, index) => {
    assert.ok(Math.abs(afterLocalMove[index] - beforeLocalMove[index] - value * 0.5) < 0.01);
  });

  // Axis scale: pulling the handle to twice its distance doubles that axis only.
  controller.setTool('scale');
  handles = controller.gizmoHandles();
  grab = pointAlong(handles, 'y', handles.handleLength);
  release = pointAlong(handles, 'y', handles.handleLength * 2);
  controller.beginGizmoDrag('y', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  controller.endGizmoDrag();
  assert.ok(Math.abs(heroNode().scale[1] - 2) < 0.01, `expected y scale near 2, got ${heroNode().scale}`);
  assert.ok(Math.abs(heroNode().scale[0] - 1) < 1e-6);

  // Shift snaps the travel to quarter-metre steps along the object's own axis.
  controller.setTool('translate');
  handles = controller.gizmoHandles();
  const beforeSnapMove = heroNode().translation;
  grab = pointAlong(handles, 'x', handles.handleLength);
  release = pointAlong(handles, 'x', handles.handleLength + 0.6);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y, { shiftKey: true });
  controller.endGizmoDrag();
  turnedX.forEach((value, index) => {
    assert.ok(Math.abs(heroNode().translation[index] - beforeSnapMove[index] - value * 0.5) < 1e-3);
  });

  // Uniform scale from the centre handle: one handle length of drag doubles the size.
  controller.setTool('scale');
  handles = controller.gizmoHandles();
  controller.beginGizmoDrag('uniform', handles.origin.x, handles.origin.y);
  controller.updateGizmoDrag(handles.origin.x + 74, handles.origin.y);
  controller.endGizmoDrag();
  const scaled = heroNode();
  assert.ok(Math.abs(scaled.scale[0] - 2) < 0.01 && Math.abs(scaled.scale[1] - 4) < 0.02 && Math.abs(scaled.scale[2] - 2) < 0.01);

  // Move hero high up then surface-snap onto the floor top (y = 0 + half-height of scaled box)
  controller.updateNodeTransform('hero', { translation: [0, 5, 0], rotationDegrees: [0, 0, 0], scale: [1, 2, 1] });
  const floorScreen = controller.projectWorldPoint([0, 0, -2]);
  const snapped = controller.snapSelectedToAt(floorScreen.x, floorScreen.y);
  assert.ok(snapped);
  assert.ok(Math.abs(snapped[1] - 1.0) < 0.05, `expected snapped box center near y=1.0, got ${snapped[1]}`);
  controller.dispose();
});

test('material, sun, look, camera bookmarks and motion scrubbing persist cleanly in exported recipes', () => {
  const animatedRecipe = makeStudioRecipe({ animated: true, loop: false });
  const scene = createAgentScene(animatedRecipe);
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });

  controller.updateMaterial('paint', { hexColor: '#3399ff', roughness: 0.18, metallic: 0.85, emission: 1.5 });
  controller.setSunAngles({ azimuthDegrees: 45, elevationDegrees: 30, keyIntensity: 3.1 });
  controller.updateLook({ environment: { viewTransform: 'agx' }, effects: { exposure: 1.25 } });

  controller.orbitCamera({ deltaAzimuth: 0.4, deltaElevation: 0.1, zoomScale: 0.8 });
  const savedShot = controller.saveBookmark('AngleA');
  assert.equal(savedShot.name, 'AngleA');
  assert.equal(controller.listBookmarks().length, 1);

  controller.frameSelection();
  const framedEye = controller.scene.camera.eye;
  assert.notDeepEqual(framedEye, savedShot.camera.eye);

  controller.applyBookmark('AngleA');
  assert.deepEqual(controller.scene.camera.eye.map(value => Math.round(value * 100) / 100), savedShot.camera.eye.map(value => Math.round(value * 100) / 100));

  controller.setMotionTime(0.75);
  assert.equal(controller.motionTime, 0.75);

  const exported = controller.exportRecipe();
  const reloaded = createAgentScene(exported);
  assert.equal(reloaded.exportRecipe().timeline.shots[0].name, 'AngleA');
  assert.equal(reloaded.exportRecipe().environment.viewTransform, 'agx');
  assert.equal(reloaded.exportRecipe().effects.exposure, 1.25);

  controller.removeBookmark('AngleA');
  assert.equal(controller.exportRecipe().timeline, undefined);
  controller.dispose();
});

test('undo, redo and external loadRecipe handle more edits than agent REVISION_HISTORY_LIMIT', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600, maxHistory: 16 });
  assert.equal(controller.canUndo, false);

  for (let step = 1; step <= 7; step += 1) {
    controller.updateNodeTransform('hero', { translation: [step, 0.5, 0] });
  }
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], 7);
  assert.equal(controller.canUndo, true);

  for (let step = 7; step >= 1; step -= 1) {
    assert.equal(controller.undo(), true);
  }
  assert.equal(controller.canUndo, false);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], 0);
  assert.equal(controller.canRedo, true);

  assert.equal(controller.redo(), true);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], 1);

  const incoming = makeStudioRecipe();
  incoming.nodes[1].translation = [-3, 0.5, 1];
  controller.loadRecipe(incoming);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], -3);
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], 1);
  controller.dispose();
});

test('pro studio operations add objects, drag planar gizmos, edit materials, lenses and keyframes', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 960, viewportHeight: 600 });
  controller.selectNode('hero');

  // Planar gizmo drag (XZ) and rotation rings check
  const handles = controller.gizmoHandles();
  assert.ok(handles.planes.xy.length === 4);
  assert.ok(handles.rings.x.length > 8);
  controller.setTool('translate');
  controller.beginGizmoDrag('xz', 480, 300);
  controller.updateGizmoDrag(540, 318);
  assert.equal(controller.endGizmoDrag(), true);
  const moved = controller.exportRecipe().nodes.find(node => node.id === 'hero');
  assert.ok(Math.abs(moved.translation[0]) > 0.05);

  // Add primitive + duplicate + reparent + metadata + delete
  const addedTorus = controller.addPrimitive('torus');
  assert.equal(controller.selectedNodeId, addedTorus.id);
  const pointCount = controller.addSceneLight('point');
  assert.equal(pointCount, 1);
  assert.equal(controller.selectedObjectKey, 'point:0', 'a new light is selected');
  assert.equal(controller.selectedNodeId, null);
  controller.selectNode(addedTorus.id);

  const duplicate = controller.duplicateSelected();
  assert.equal(controller.selectedNodeId, duplicate.id);
  controller.updateNodeTransform(duplicate.id, {
    label: 'Trim Ring',
    parent: addedTorus.id,
    castShadow: false,
    receiveShadow: true,
  });
  const duplicateAfter = controller.exportRecipe().nodes.find(node => node.id === duplicate.id);
  assert.equal(duplicateAfter.label, 'Trim Ring');
  assert.equal(duplicateAfter.parent, addedTorus.id);
  assert.equal(duplicateAfter.castShadow, false);
  assert.equal(duplicateAfter.receiveShadow, true);

  controller.selectNode(addedTorus.id);
  controller.deleteSelected();
  const afterDelete = controller.exportRecipe().nodes;
  assert.equal(afterDelete.some(node => node.id === addedTorus.id), false);
  assert.equal(afterDelete.some(node => node.id === duplicate.id), false);

  // Materials: create, assign, apply preset
  controller.selectNode('hero');
  const goldMaterial = controller.createMaterial({ roughness: 0.25, metallic: 0.9, assignToNodeId: 'hero' });
  controller.applyMaterialPreset(goldMaterial.id, 'gold');
  const assignedNode = controller.exportRecipe().nodes.find(node => node.id === 'hero');
  assert.equal(assignedNode.material, goldMaterial.id);
  const updatedMaterial = controller.exportRecipe().materials.find(item => item.id === goldMaterial.id);
  assert.ok(updatedMaterial.metallic >= 0.95);
  controller.assignNodeMaterial('orb', goldMaterial.id);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'orb').material, goldMaterial.id);

  // Camera view presets, ortho toggle, lens focal length & keyframe insertion
  controller.setCameraViewPreset('front');
  assert.ok(controller.scene.camera.eye[2] > controller.scene.camera.target[2]);
  controller.toggleCameraProjection();
  assert.equal(controller.scene.camera.projection, 'orthographic');
  controller.setCameraLensMillimetres(85);
  assert.equal(controller.scene.camera.projection, 'perspective');
  assert.equal(controller.scene.camera.focalLength, 85);

  const nextMotion = controller.insertNodeKeyframe('hero');
  assert.ok(nextMotion.tracks.length >= 3);
  controller.setMotionTime(1.5);
  controller.updateNodeTransform('hero', { translation: [1.5, 1.2, 0] });
  controller.insertNodeKeyframe('hero');
  controller.setMotionTime(0.75);
  assert.equal(controller.motionTime, 0.75);

  controller.dispose();
});

test('Studio undo groups one slider drag into one step and keeps the camera where it was left', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()) });
  const materialId = controller.exportRecipe().materials[0].id;
  const roughnessBefore = controller.exportRecipe().materials[0].roughness;

  controller.beginUndoGroup();
  for (let step = 1; step <= 40; step += 1) {
    controller.updateMaterial(materialId, { roughness: 0.1 + step * 0.01 });
  }
  controller.endUndoGroup();
  controller.updateMaterial(materialId, { roughness: 0.9 });

  controller.orbitCamera({ deltaAzimuth: 0.6 });
  const orbitedEye = [...controller.scene.camera.eye];
  assert.equal(controller.undo(), true);
  assert.ok(Math.abs(controller.exportRecipe().materials[0].roughness - 0.5) < 1e-6);
  assert.deepEqual([...controller.scene.camera.eye], orbitedEye);
  assert.equal(controller.undo(), true);
  assert.equal(controller.exportRecipe().materials[0].roughness, roughnessBefore);
  assert.equal(controller.canUndo, false);
  assert.deepEqual([...controller.scene.camera.eye], orbitedEye);

  assert.equal(controller.redo(), true);
  assert.ok(Math.abs(controller.exportRecipe().materials[0].roughness - 0.5) < 1e-6);
  assert.deepEqual([...controller.scene.camera.eye], orbitedEye);
  controller.dispose();
});

test('Studio undo restores the camera when the undone step was a camera edit', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()) });
  const eyeBefore = [...controller.scene.camera.eye];
  controller.setCameraViewPreset('top');
  assert.notDeepEqual([...controller.scene.camera.eye], eyeBefore);
  assert.equal(controller.undo(), true);
  assert.deepEqual([...controller.scene.camera.eye], eyeBefore);
  controller.dispose();
});

test('selectionOutline wraps the selected object on screen and follows it', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode(null);
  assert.equal(controller.selectionOutline(), null);

  controller.selectNode('hero');
  const outline = controller.selectionOutline();
  assert.ok(outline.length >= 4);
  const centre = controller.projectWorldPoint([0, 0.5, 0]);
  const bounds = points => ({
    left: Math.min(...points.map(point => point[0])),
    right: Math.max(...points.map(point => point[0])),
    top: Math.min(...points.map(point => point[1])),
    bottom: Math.max(...points.map(point => point[1])),
  });
  const heroBounds = bounds(outline);
  assert.ok(heroBounds.left < centre.x && centre.x < heroBounds.right);
  assert.ok(heroBounds.top < centre.y && centre.y < heroBounds.bottom);
  const corner = controller.projectWorldPoint([0.5, 1, 0.5]);
  assert.ok(outline.some(point => Math.hypot(point[0] - corner.x, point[1] - corner.y) < 8), 'the outline passes by the near top corner of the bevelled box');

  controller.updateNodeTransform('hero', { translation: [1.5, 0.5, 0] });
  assert.ok(bounds(controller.selectionOutline()).left > heroBounds.left + 40);

  controller.selectNode('orb');
  const orbCentre = controller.projectWorldPoint([2.2, 0.5, 0]);
  const orbRadii = controller.selectionOutline().map(point => Math.hypot(point[0] - orbCentre.x, point[1] - orbCentre.y));
  assert.ok(Math.max(...orbRadii) - Math.min(...orbRadii) < 6, 'a sphere outline is round');
  controller.dispose();
});

test('every Studio template builds a scene the agent recipe accepts, and unknown names say what to pass', () => {
  for (const templateName of Object.keys(STUDIO_TEMPLATES)) {
    const recipe = buildTemplateRecipe(templateName);
    assert.equal(recipe.format, 'crucible.scene');
    const scene = createAgentScene(recipe);
    assert.ok(scene.parts.length >= 1, `${templateName} has no parts`);
    const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
    assert.deepEqual(controller.exportRecipe().nodes.map(node => node.id), recipe.nodes.map(node => node.id));
  }
  assert.deepEqual(buildTemplateRecipe(), buildTemplateRecipe('blockout'));
  assert.throws(() => buildTemplateRecipe('castle'), /Unknown Studio template "castle"\. Use one of blockout, showcase, pedestal, courtyard, empty\./);
});

test('every Studio primitive has a starting shape that sits on the ground and builds', () => {
  for (const primitiveType of STUDIO_PRIMITIVES) {
    const spec = primitiveGeometrySpec(primitiveType);
    assert.ok(spec.labelPrefix.length > 0);
    assert.equal(spec.translation.length, 3);
    assert.equal(spec.rotation.length, 4);
    assert.equal(spec.scale.length, 3);
    const scene = createAgentScene({
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [{ id: 'shape', ...spec.geometry }],
      materials: [{ id: 'paint', tag: 'surface', color: [0.5, 0.5, 0.5], roughness: 0.5, metallic: 0 }],
      nodes: [{ id: 'node', geometry: 'shape', material: 'paint', translation: spec.translation, rotation: spec.rotation, scale: spec.scale }],
    });
    assert.equal(scene.parts.length, 1, `${primitiveType} did not build one part`);
  }
});

test('the add menu offers the basic shapes in the order of Blender, and the shapes it dropped are refused', () => {
  assert.deepEqual(
    STUDIO_PRIMITIVE_GROUPS.map(group => [group.label, [...group.primitives]]),
    [['Mesh', ['plane', 'box', 'disc', 'sphere', 'icoSphere', 'cylinder', 'cone', 'torus']], ['Text', ['text']]],
  );
  assert.deepEqual(STUDIO_PRIMITIVE_GROUPS.flatMap(group => group.primitives), [...STUDIO_PRIMITIVES]);
  assert.ok(STUDIO_PRIMITIVES.every(primitiveType => /^[a-z][a-zA-Z]*$/.test(primitiveType)), 'ids are one word, because node ids and labels are made from them');
  assert.equal(primitiveGeometrySpec('disc').labelPrefix, 'Circle');
  for (const dropped of ['heart', 'vase', 'star', 'terrain', 'gem']) {
    assert.throws(() => primitiveGeometrySpec(dropped), new RegExp(`Unknown primitive "${dropped}"`));
  }
});

test('a recipe holding shapes the add menu no longer offers still loads, lists, selects and moves', () => {
  const recipe = makeStudioRecipe();
  recipe.geometries.push(
    { id: 'heart-shape', type: 'extrude', contour: [[0, 0.5], [0.4, 0.9], [0.5, 0.4], [0, -0.5], [-0.5, 0.4], [-0.4, 0.9]], depth: 0.25, bevel: 0.03 },
    { id: 'vase-shape', type: 'lathe', profile: [[0.3, -0.5], [0.46, -0.2], [0.42, 0.05], [0.24, 0.3], [0.34, 0.5]], segments: 48 },
  );
  recipe.nodes.push(
    { id: 'heart', geometry: 'heart-shape', material: 'paint', translation: [1, 0.5, 0] },
    { id: 'vase', geometry: 'vase-shape', material: 'paint', translation: [-1, 0.5, 0] },
  );
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  const nodeIds = controller.exportRecipe().nodes.map(node => node.id);
  assert.ok(nodeIds.includes('heart') && nodeIds.includes('vase'));
  for (const nodeId of ['heart', 'vase']) {
    controller.selectNode(nodeId);
    assert.equal(controller.selectedNodeId, nodeId);
    controller.updateNodeTransform(nodeId, { translation: [2, 0.5, 3] });
    assert.deepEqual(controller.exportRecipe().nodes.find(node => node.id === nodeId).translation, [2, 0.5, 3]);
    assert.ok(controller.scene.parts.some(part => part.name === nodeId), `${nodeId} still builds a part`);
  }
});

test('every Studio tool and tab has an icon, and an unknown icon name lists the valid ones', () => {
  for (const name of [...STUDIO_TOOLS, ...STUDIO_TABS]) {
    assert.match(studioIconPath(name), /^M[\d.]/, `${name} has no path`);
  }
  for (const name of ['camera', 'sun', 'pointLight', 'spotLight', 'areaLight']) {
    assert.match(studioIconPath(name), /^M[\d.]/, `${name} has no path`);
  }
  assert.equal(new Set(Object.values(STUDIO_ICON_PATHS)).size, STUDIO_ICON_NAMES.length, 'two icons share one drawing');
  assert.throws(() => studioIconPath('rocket'), /Unknown Studio icon "rocket"\. Use one of: select, translate/);
});

test('the Studio controller says what to pass when a scene, a callback or a point is wrong', () => {
  assert.throws(() => createStudioController({ scene: {} }), /Studio scene must provide apply\(\)/);
  const incomplete = { apply() {}, exportRecipe() {}, inspect() {} };
  assert.throws(() => createStudioController({ scene: incomplete }), /must provide parts and camera/);
  const scene = createAgentScene(makeStudioRecipe());
  assert.throws(() => createStudioController({ scene, onChange: 'nope' }), /onChange must be a function/);

  const controller = createStudioController({ scene });
  assert.throws(() => controller.selectNode(7), /expects a node ID string or null/);
  assert.throws(() => controller.screenRay(Number.NaN, 4), /finite pixelX and pixelY/);
  assert.throws(() => controller.projectWorldPoint([1, 2]), /worldPoint must be an array of 3 finite numbers/);
  assert.throws(() => hexToLinearRgb('red'), /Color must be a #rrggbb hex string, got "red"/);
  assert.throws(() => controller.updateMaterial('paint', null), /expects a patch object/);
  assert.throws(() => controller.updateMaterial('paint', { roughness: 'rough' }), /Material roughness must be a finite number/);
  assert.throws(() => controller.updateNodeTransform('hero', null), /expects a patch object/);
  assert.throws(() => controller.updateNodeTransform('hero', { label: 4 }), /Node label must be a string/);
  assert.throws(() => controller.updateNodeTransform('hero', { parent: 'ghost' }), /Unknown parent node "ghost"/);
  assert.throws(() => controller.updateNodeTransform('hero', { parent: 'hero' }), /Cannot parent a node under itself/);
  assert.throws(() => controller.updateNodeTransform('hero', { scale: [1, 0, 1] }), /scale components must stay positive/);
  assert.throws(() => controller.updateNodeTransform('hero', { translation: [1, 2] }), /translation must be an array of 3/);
  assert.throws(() => controller.updateNodeTransform('hero', { visible: 'yes' }), /visible must be true or false/);
  assert.throws(() => controller.assignNodeMaterial('ghost', 'paint'), /has no geometry to paint/);
  assert.throws(() => controller.assignNodeMaterial('hero', 'ghost'), /Unknown material "ghost"/);
  assert.throws(() => controller.applyMaterialPreset('paint', 'lava'), /Unknown material preset "lava"/);
  assert.throws(() => controller.setSunAngles({ keyIntensity: -1 }), /keyIntensity must be a non-negative/);
  assert.throws(() => controller.updateCamera(null), /expects a camera patch object/);
  assert.throws(() => controller.setCameraViewPreset('under'), /Unknown camera view "under"/);
  assert.throws(() => controller.addSceneLight('laser'), /Unsupported light type "laser"\. Use point, spot or area/);
  assert.throws(() => controller.addPrimitive('torus-knot'), /torus-knot/);
  assert.throws(() => controller.insertNodeKeyframe('ghost'), /Unknown node "ghost"/);
  assert.throws(() => controller.setMotionTime(2), /Add a keyframe or motion track/);
  assert.equal(controller.setMotionTime(0), 0);
  controller.selectNode(null);
  assert.throws(() => controller.insertNodeKeyframe(), /Select a node before inserting a keyframe/);
  assert.throws(() => controller.duplicateSelected(), /Select a node before duplicating it/);
  assert.throws(() => controller.copySelected(), /Select a node before copying it/);
  assert.throws(() => controller.pasteCopy(), /Copy a node before pasting/);
  assert.throws(() => controller.deleteSelected(), /Select a node before deleting it/);
  assert.throws(() => controller.snapSelectedToAt(10, 10), /Select a node before snapping it to a surface/);
  assert.equal(controller.undo(), false);
  assert.equal(controller.redo(), false);
  assert.equal(controller.endGizmoDrag(), false);
  assert.equal(controller.updateGizmoDrag(10, 10), null);
  const revisionBefore = controller.scene.revision;
  controller.updateLook({});
  assert.equal(controller.scene.revision, revisionBefore);
  controller.dispose();
});

test('the Studio controller stops lights when the shadow atlas is full and refuses a bad gizmo drag', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600 });
  let pointLights = 0;
  assert.throws(() => {
    for (let count = 1; count <= MAX_POINT_LIGHTS; count += 1) {
      pointLights = controller.addSceneLight('point');
    }
  }, /Shadow casting lights need [0-9]+ atlas tiles/);
  assert.equal(pointLights, 4, 'the shadow atlas holds four point lights');
  assert.equal(controller.exportRecipe().environment.pointLights.length, 4);
  assert.throws(() => controller.addSceneLight('spot'), /atlas tiles/);

  controller.selectNode('hero');
  assert.throws(() => controller.beginGizmoDrag('w', 10, 10), /Unsupported gizmo axis "w"/);
  assert.throws(() => controller.beginGizmoDrag('x', Number.NaN, 10), /finite pixel coordinates/);
  controller.setTool('select');
  controller.beginGizmoDrag('screen', 400, 300);
  assert.throws(() => controller.updateGizmoDrag(Number.NaN, 4), /finite pixel coordinates/);
  assert.ok(controller.updateGizmoDrag(420, 300).translation, 'a screen drag moves the node in the view plane');
  assert.equal(controller.endGizmoDrag(), true);
  controller.dispose();
});

test('an axis that points almost at the camera is drawn long enough to grab', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.setTool('translate');
  const screenLength = axis => {
    const handles = controller.gizmoHandles();
    return Math.hypot(handles.axes[axis].x - handles.origin.x, handles.axes[axis].y - handles.origin.y);
  };
  const longest = () => Math.max(screenLength('x'), screenLength('y'));

  controller.setCameraViewPreset('front');
  assert.ok(screenLength('z') < 1, 'an axis straight at the camera has no length to stretch');
  controller.orbitCamera({ deltaAzimuth: 0.3 });
  const plain = controller.projectWorldPoint(controller.gizmoHandles().pivot.map((value, index) => value + controller.gizmoHandles().basis.z[index] * controller.gizmoHandles().handleLength));
  const origin = controller.gizmoHandles().origin;
  const unstretched = Math.hypot(plain.x - origin.x, plain.y - origin.y);
  assert.ok(unstretched < longest() * 0.4, 'without help the axis would be a stub');
  assert.ok(screenLength('z') > unstretched * 1.5, 'the axis is stretched');
  assert.ok(screenLength('z') >= longest() * 0.55 && screenLength('z') <= longest() * 1.05, 'and ends near the length of the others');

  controller.orbitCamera({ deltaAzimuth: 0.6 });
  const settled = controller.gizmoHandles();
  const settledTip = controller.projectWorldPoint(settled.pivot.map((value, index) => value + settled.basis.z[index] * settled.handleLength));
  assert.ok(Math.abs(settledTip.x - settled.axes.z.x) < 0.01 && Math.abs(settledTip.y - settled.axes.z.y) < 0.01, 'an axis seen from the side keeps its true length');
  controller.dispose();
});

test('the Studio controller reports unchanged drags as cancelled and keeps single-step history', () => {
  const kinds = [];
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600, onChange: detail => kinds.push(detail.kind) });
  controller.selectNode('hero');
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const tip = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength, handles.pivot[1], handles.pivot[2]]);
  controller.beginGizmoDrag('x', tip.x, tip.y);
  assert.equal(controller.endGizmoDrag(), false);
  assert.ok(kinds.includes('transformCancel'));
  assert.equal(controller.canUndo, false);
  controller.dispose();
});

test('rotate rings, move planes and surface snapping drag through every axis', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const heroNode = () => controller.exportRecipe().nodes.find(node => node.id === 'hero');

  controller.setTool('rotate');
  for (const axis of ['x', 'z']) {
    const handles = controller.gizmoHandles();
    assert.equal(handles.rings[axis].length > 8, true);
    const visibleRing = handles.rings[axis].filter(point => point.visible);
    const grab = visibleRing[0];
    const release = visibleRing[Math.floor(visibleRing.length / 4)];
    controller.beginGizmoDrag(axis, grab.x, grab.y);
    const result = controller.updateGizmoDrag(release.x, release.y);
    assert.ok(result, `${axis} ring drag returns the new rotation`);
    assert.equal(controller.endGizmoDrag(), true);
  }
  assert.notDeepEqual(heroNode().rotation, [0, 0, 0, 1]);

  controller.setTool('translate');
  controller.updateNodeTransform('hero', { translation: [0, 0.5, 0], rotationDegrees: [0, 0, 0] });
  controller.setCameraViewPreset('isometric');
  const handles = controller.gizmoHandles();
  for (const planeAxis of ['xy', 'xz', 'yz']) {
    const corners = handles.planes[planeAxis];
    assert.equal(corners.length, 4);
    assert.ok(corners.every(corner => corner.visible), planeAxis);
    const center = { x: corners.reduce((sum, corner) => sum + corner.x, 0) / 4, y: corners.reduce((sum, corner) => sum + corner.y, 0) / 4 };
    const before = heroNode().translation.slice();
    controller.beginGizmoDrag(planeAxis, center.x, center.y);
    controller.updateGizmoDrag(center.x + 25, center.y - 18);
    assert.equal(controller.endGizmoDrag(), true);
    assert.notDeepEqual(heroNode().translation, before, planeAxis);
    controller.updateNodeTransform('hero', { translation: [0, 0.5, 0] });
  }

  controller.setTool('snap');
  controller.updateNodeTransform('hero', { translation: [0, 4, 0] });
  const floorPoint = controller.projectWorldPoint([0, 0, -2]);
  controller.beginGizmoDrag('surface', floorPoint.x, floorPoint.y);
  const snapped = controller.updateGizmoDrag(floorPoint.x, floorPoint.y);
  assert.ok(snapped.translation[1] < 1.2);
  assert.equal(controller.updateGizmoDrag(5, 5), null, 'a pointer over the sky leaves the object where it is');
  assert.equal(controller.endGizmoDrag(), true);
  controller.undo();
  assert.deepEqual(heroNode().translation, [0, 4, 0]);

  assert.equal(controller.snapSelectedToAt(5, 5), null, 'nothing to land on under the sky');
  controller.dispose();
});

test('a child node moves along its own parent axes and snaps in its parent space', () => {
  const recipe = makeStudioRecipe();
  recipe.nodes.push({ id: 'rig', translation: [1, 0, 0], rotation: [0, 0.70710678, 0, 0.70710678], scale: [2, 2, 2] });
  recipe.nodes.find(node => node.id === 'hero').parent = 'rig';
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const along = (axis, distance) => controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis[axis][index] * distance));
  const grab = along('x', handles.handleLength);
  const release = along('x', handles.handleLength + 0.5);
  const before = controller.exportRecipe().nodes.find(node => node.id === 'hero').translation.slice();
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  controller.endGizmoDrag();
  const after = controller.exportRecipe().nodes.find(node => node.id === 'hero').translation;
  assert.notDeepEqual(after, before);
  assert.ok(Math.abs(Math.hypot(...after.map((value, index) => value - before[index])) - 0.25) < 0.02, 'half a world metre is a quarter metre inside a parent scaled by two');

  controller.setTool('snap');
  const floorPoint = controller.projectWorldPoint([3, 0, 0]);
  const snapped = controller.snapSelectedToAt(floorPoint.x, floorPoint.y);
  assert.ok(snapped);

  controller.selectNode('rig');
  assert.equal(controller.selectionOutline().length > 2, true, 'a group outlines its children');
  controller.dispose();
});

test('frameSelectionPose stands back far enough for the object to fit and changes nothing', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const eyeBefore = [...controller.scene.camera.eye];
  const pose = controller.frameSelectionPose();
  assert.deepEqual(controller.scene.camera.eye, eyeBefore);
  const bounds = controller.nodeBounds('hero');
  const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
  assert.ok(pose.target.every((value, axis) => Math.abs(value - center[axis]) < 1e-3), 'it looks at the middle of the object');
  controller.moveViewportCamera(pose);
  const outline = controller.selectionOutline();
  assert.ok(outline.every(point => point[0] > 0 && point[0] < 800 && point[1] > 0 && point[1] < 600), 'the whole object is inside the view');
  const outlineHeight = Math.max(...outline.map(point => point[1])) - Math.min(...outline.map(point => point[1]));
  assert.ok(outlineHeight > 150, 'and it fills a good part of it');
  assert.equal(controller.canUndo, false, 'moving the viewport camera is not an edit');
  controller.selectNode(null);
  const wholeScene = controller.frameSelectionPose();
  assert.ok(wholeScene.eye.every(Number.isFinite), 'with nothing selected it frames every object');
  controller.dispose();
});

test('selectionSilhouette gives the triangles of the selection on screen, all wound one way', () => {
  const scene = createAgentScene(makeStudioRecipe());
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode(null);
  assert.equal(controller.selectionSilhouette(), null);
  controller.selectNode('hero');
  const triangles = controller.selectionSilhouette();
  assert.ok(triangles.length >= 6 && triangles.length % 6 === 0);
  const hull = controller.selectionOutline();
  const hullLeft = Math.min(...hull.map(point => point[0]));
  const hullRight = Math.max(...hull.map(point => point[0]));
  for (let offset = 0; offset < triangles.length; offset += 6) {
    const [ax, ay, bx, by, cx, cy] = triangles.slice(offset, offset + 6);
    assert.ok((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) > 0, 'every triangle turns the same way');
    assert.ok(ax >= hullLeft - 0.5 && ax <= hullRight + 0.5, 'and lies inside the hull');
  }
  controller.dispose();
});

test('selectionOutline is null without a selection, for a group without parts and when everything is off screen', () => {
  const recipe = makeStudioRecipe();
  recipe.nodes.push({ id: 'empty-group', translation: [0, 0, 0] });
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode(null);
  assert.equal(controller.selectionOutline(), null);
  assert.equal(controller.gizmoHandles(), null);
  controller.selectNode('empty-group');
  assert.equal(controller.selectionOutline(), null);
  assert.ok(controller.gizmoHandles());

  controller.selectNode('hero');
  controller.updateCamera({ eye: [0, 0.5, 20], target: [0, 0.5, 30] });
  assert.equal(controller.selectionOutline(), null, 'an object behind the camera has no outline');
  assert.equal(controller.gizmoHandles().origin.visible, false);
  controller.dispose();
});

test('the Studio controller loads a recipe under a playing time and clamps it to the new length', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe({ animated: true })), viewportWidth: 800, viewportHeight: 600 });
  controller.setMotionTime(1.2);
  const shorter = controller.exportRecipe();
  shorter.motion.duration = 0.6;
  shorter.motion.tracks[0].keyframes[1].time = 0.6;
  controller.loadRecipe(shorter);
  assert.equal(controller.motionTime, 0.6);
  controller.insertNodeKeyframe('hero');
  assert.equal(controller.exportRecipe().motion.tracks.find(track => track.property === 'translation').keyframes.length >= 2, true);
  controller.setMotionTime(0.3);
  controller.insertNodeKeyframe('orb');
  controller.insertNodeKeyframe('orb');
  const orbTrack = controller.exportRecipe().motion.tracks.find(track => track.id === 'orb' && track.property === 'translation');
  assert.equal(orbTrack.keyframes.length, 1, 'a second keyframe at the same time replaces the first');
  controller.dispose();
});

test('deleting a node removes its animation and keeps tracks that belong to other nodes', () => {
  const recipe = makeStudioRecipe({ animated: true });
  recipe.motion.tracks.push({
    kind: 'node',
    id: 'orb',
    property: 'translation',
    keyframes: [
      { time: 0, value: [2.2, 0.5, 0] },
      { time: 1.5, value: [2.2, 1.5, 0] },
    ],
  });
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  controller.deleteSelected();
  assert.deepEqual(controller.exportRecipe().motion.tracks.map(track => track.id), ['orb']);
  controller.selectNode('orb');
  controller.deleteSelected();
  assert.equal(controller.exportRecipe().motion ?? null, null);
  controller.dispose();
});

test('orthographic zoom scales the view size and Studio history keeps only the newest edits', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600, maxHistory: 3 });
  controller.updateCamera({ projection: 'orthographic', orthoScale: 4 });
  controller.orbitCamera({ zoomScale: 2 });
  assert.equal(controller.scene.camera.orthoScale, 8);
  controller.selectNode('hero');
  for (let step = 1; step <= 6; step += 1) {
    controller.updateNodeTransform('hero', { translation: [step, 0.5, 0] });
  }
  let undone = 0;
  while (controller.undo()) undone += 1;
  assert.equal(undone, 3);
  controller.dispose();
});

test('cancelling a drag puts the object back and leaves undo and redo as they were', () => {
  const kinds = [];
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 800, viewportHeight: 600, onChange: detail => kinds.push(detail.kind) });
  const heroNode = () => controller.exportRecipe().nodes.find(node => node.id === 'hero');
  assert.equal(controller.cancelGizmoDrag(), false);
  assert.equal(controller.axisFacingView(), 'z');

  controller.selectNode('hero');
  controller.setTool('translate');
  const before = structuredClone(heroNode());
  const pivot = controller.projectWorldPoint(controller.gizmoHandles().pivot);
  assert.equal(controller.dragging, false);
  controller.beginGizmoDrag('screen', pivot.x, pivot.y);
  assert.equal(controller.dragging, true);
  controller.updateGizmoDrag(pivot.x + 90, pivot.y - 40);
  assert.notDeepEqual(heroNode().translation, before.translation);
  assert.equal(controller.cancelGizmoDrag(), true);
  assert.equal(controller.dragging, false);
  assert.deepEqual(heroNode().translation, before.translation);
  assert.deepEqual(heroNode().rotation, before.rotation);
  assert.deepEqual(heroNode().scale, before.scale);
  assert.equal(controller.canUndo, false);
  assert.equal(controller.canRedo, false);
  assert.equal(kinds.at(-1), 'transformCancel');

  // A free turn uses the axis of the object that points most nearly at the camera.
  controller.orbitCamera({ deltaElevation: 2 });
  assert.equal(controller.axisFacingView(), 'y');
  controller.dispose();
});

test('on a scene whose camera a motion track drives, the viewport looks around on its own and leaves the recipe alone', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'g_box', type: 'box' }],
    materials: [{ id: 'm_box', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'box', geometry: 'g_box', material: 'm_box' }],
    camera: { eye: [0, 2, 10], target: [0, 0, 0] },
    motion: {
      duration: 4,
      loop: false,
      tracks: [{ kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 2, 10] }, { time: 4, value: [5, 2, 10] }] }],
    },
  };
  const controller = createStudioController({ scene: createAgentScene(recipe) });
  assert.equal(controller.cameraDriven, true);
  assert.equal(controller.freeView, false);
  const revisionBefore = controller.scene.revision;
  const pointBefore = controller.projectWorldPoint([1, 0, 0]);

  controller.orbitCamera({ deltaAzimuth: 0.5, zoomScale: 0.5 });
  assert.equal(controller.freeView, true);
  assert.ok(Math.abs(Math.hypot(...controller.viewCamera.eye) - Math.hypot(0, 2, 10) / 2) < 1e-3, 'the zoom halves the distance');
  assert.deepEqual(Array.from(controller.scene.camera.eye), [0, 2, 10], 'the animated camera is untouched');
  assert.deepEqual(controller.exportRecipe().camera.eye, [0, 2, 10], 'the recipe is untouched');
  assert.equal(controller.scene.revision, revisionBefore);
  assert.notDeepEqual(controller.projectWorldPoint([1, 0, 0]), pointBefore, 'picking and handles follow the free view');

  const freeEye = [...controller.viewCamera.eye];
  controller.setMotionTime(2);
  assert.deepEqual([...controller.viewCamera.eye], freeEye, 'a scrub does not pull the view back');
  controller.updateNodeTransform('box', { translation: [1, 0, 0] });
  controller.undo();
  assert.deepEqual([...controller.viewCamera.eye], freeEye, 'undo keeps the view');

  controller.lookThroughSceneCamera();
  assert.equal(controller.freeView, false);
  assert.deepEqual(Array.from(controller.viewCamera.eye), [2.5, 2, 10]);

  const { motion: droppedMotion, ...stillRecipe } = recipe;
  assert.ok(droppedMotion);
  const plain = createStudioController({ scene: createAgentScene(stillRecipe) });
  plain.orbitCamera({ zoomScale: 0.5 });
  assert.equal(plain.cameraDriven, false);
  assert.equal(plain.freeView, false);
  assert.deepEqual(plain.exportRecipe().camera.eye, [0, 1, 5], 'without a camera track an orbit still writes the recipe');
});

function makeLitRecipe({ withLightMotion = false } = {}) {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'g_box', type: 'box' }],
    materials: [{ id: 'm_box', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'box', geometry: 'g_box', material: 'm_box' }],
    camera: { eye: [0, 2, 10], target: [0, 0, 0] },
    environment: { setup: 'studio', lightDirection: [0, 2, 0] },
  };
  if (withLightMotion) {
    recipe.motion = {
      duration: 2,
      loop: false,
      tracks: [
        { kind: 'light', id: 'point:0', property: 'position', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 3, 0] }, { time: 2, value: [4, 3, 0] }] },
        { kind: 'light', id: 'point:1', property: 'intensity', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 1 }, { time: 2, value: 3 }] },
      ],
    };
  }
  return recipe;
}

function makeLitController(options) {
  const controller = createStudioController({ scene: createAgentScene(makeLitRecipe()) });
  controller.addSceneLight('point');
  controller.addSceneLight('point');
  controller.addSceneLight('spot');
  controller.addSceneLight('area');
  if (options?.withLightMotion) {
    const recipe = controller.exportRecipe();
    recipe.motion = makeLitRecipe(options).motion;
    controller.loadRecipe(recipe, { recordUndo: false });
  }
  return controller;
}

test('scene objects list the camera, the sun and every light, and selecting one clears the node selection', () => {
  const controller = makeLitController();
  const objects = controller.listSceneObjects();
  assert.deepEqual(objects.map(object => object.key), ['camera', 'sun', 'point:0', 'point:1', 'spot:0', 'area:0']);
  assert.deepEqual(objects.map(object => object.label), ['Camera', 'Sun', 'Point light', 'Point light 2', 'Spot light', 'Area light']);
  assert.deepEqual(objects[0].position, [0, 2, 10]);
  assert.equal(objects[1].position, null);
  assert.ok(Math.abs(Math.hypot(...objects[1].direction) - 1) < 1e-9, 'the sun direction is a unit vector');
  assert.deepEqual(objects[2].position, [2.2, 3, 2.2]);
  assert.ok(objects.every(object => object.driven === false));

  const notifications = [];
  const watched = createStudioController({ scene: createAgentScene(makeLitRecipe()), onChange: detail => notifications.push(detail) });
  assert.equal(watched.selectedNodeId, 'box');
  watched.selectSceneObject('sun');
  assert.equal(watched.selectedObjectKey, 'sun');
  assert.equal(watched.selectedNodeId, null);
  assert.equal(notifications.at(-1).kind, 'selection');
  watched.selectNode('box');
  assert.equal(watched.selectedObjectKey, null);
  assert.equal(watched.selectedNodeId, 'box');

  controller.selectSceneObject('spot:0');
  assert.equal(controller.selectedObjectKey, 'spot:0');
  controller.pickAt(1, 1);
  assert.equal(controller.selectedObjectKey, null, 'a click on empty sky clears the object');
  assert.throws(() => controller.selectSceneObject('spot:5'), /Unknown scene object "spot:5"\. Pass one of: camera, sun, point:0/);
  assert.throws(() => controller.selectSceneObject(null), RangeError);
});

test('a light moves in one undo step, and the camera, the sun and driven lights refuse to move', () => {
  const controller = makeLitController({ withLightMotion: true });
  const objects = controller.listSceneObjects();
  assert.equal(objects.find(object => object.key === 'point:0').driven, true);
  assert.equal(objects.find(object => object.key === 'point:1').driven, true);
  assert.equal(objects.find(object => object.key === 'spot:0').driven, false);
  assert.throws(() => controller.moveSceneObject('point:0', [1, 1, 1]), /point:0 light position is animated/);

  controller.moveSceneObject('point:1', [1, 2, 3]);
  assert.deepEqual(controller.exportRecipe().environment.pointLights[1].position, [1, 2, 3], 'an intensity track does not stop a move');

  const positionBefore = controller.exportRecipe().environment.spotLights[0].position;
  controller.beginUndoGroup();
  controller.moveSceneObject('spot:0', [1, 1, 1]);
  controller.moveSceneObject('spot:0', [2, 2, 2]);
  controller.moveSceneObject('spot:0', [3, 3, 3]);
  controller.endUndoGroup();
  assert.deepEqual(controller.exportRecipe().environment.spotLights[0].position, [3, 3, 3]);
  controller.undo();
  assert.deepEqual(controller.exportRecipe().environment.spotLights[0].position, positionBefore, 'one undo reverts the whole drag');
  controller.redo();
  assert.deepEqual(controller.exportRecipe().environment.spotLights[0].position, [3, 3, 3]);

  assert.throws(() => controller.moveSceneObject('camera', [0, 0, 0]), /"camera" cannot be moved/);
  assert.throws(() => controller.moveSceneObject('sun', [0, 0, 0]), /"sun" cannot be moved/);
  assert.throws(() => controller.moveSceneObject('area:3', [0, 0, 0]), /Unknown scene object/);
  assert.throws(() => controller.moveSceneObject('area:0', [0, 0]), /position must be an array of 3 finite numbers/);
});

test('the listed position follows the sampled time of a moving light', () => {
  const controller = makeLitController({ withLightMotion: true });
  controller.setMotionTime(2);
  assert.deepEqual(controller.listSceneObjects().find(object => object.key === 'point:0').position, [4, 3, 0]);
});

test('deleting a light drops its motion, renumbers the later lights and undo brings it back', () => {
  const controller = makeLitController({ withLightMotion: true });
  controller.selectSceneObject('point:1');
  controller.deleteSceneObject('point:0');
  assert.equal(controller.exportRecipe().environment.pointLights.length, 1);
  assert.equal(controller.selectedObjectKey, 'point:0', 'the selection follows its light to the new index');
  const tracks = controller.exportRecipe().motion.tracks;
  assert.deepEqual(tracks.map(track => `${track.id}.${track.property}`), ['point:0.intensity']);

  controller.undo();
  assert.equal(controller.exportRecipe().environment.pointLights.length, 2);
  assert.equal(controller.exportRecipe().motion.tracks.length, 2);

  controller.selectSceneObject('area:0');
  controller.deleteSceneObject('area:0');
  assert.equal(controller.selectedObjectKey, null);
  assert.deepEqual(controller.listSceneObjects().map(object => object.key), ['camera', 'sun', 'point:0', 'point:1', 'spot:0']);
  controller.undo();
  controller.selectSceneObject('area:0');
  controller.redo();
  assert.equal(controller.selectedObjectKey, null, 'redo removes the light the selection named');

  assert.throws(() => controller.deleteSceneObject('camera'), /"camera" cannot be deleted/);
  assert.throws(() => controller.deleteSceneObject('sun'), /"sun" cannot be deleted/);
  assert.throws(() => controller.deleteSceneObject('point:9'), /Unknown scene object/);
});

test('the sun and the camera report a track that drives them', () => {
  const recipe = makeLitRecipe();
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [
      { kind: 'sun', property: 'direction', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 2, value: [1, 1, 0] }] },
      { kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 2, 10] }, { time: 2, value: [1, 2, 10] }] },
    ],
  };
  const objects = createStudioController({ scene: createAgentScene(recipe) }).listSceneObjects();
  assert.deepEqual(objects.slice(0, 2).map(object => object.driven), [true, true]);
});

test('pasteCopy adds the copied node as one undo step and drops a parent that is gone', () => {
  const controller = createStudioController({ scene: createAgentScene(makeStudioRecipe()), viewportWidth: 960, viewportHeight: 600 });
  controller.selectNode('orb');
  controller.updateNodeTransform('orb', { parent: 'hero' });
  controller.copySelected();
  assert.equal(controller.canPaste, true);
  controller.selectNode('hero');
  controller.deleteSelected();

  const undoDepthBefore = controller.exportRecipe().nodes.length;
  const pasted = controller.pasteCopy();
  assert.equal(pasted.parent, undefined, 'the deleted parent is not kept');
  assert.equal(controller.selectedNodeId, pasted.id);
  assert.equal(controller.exportRecipe().nodes.length, undoDepthBefore + 1);
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.length, undoDepthBefore);
  assert.equal(controller.canPaste, true, 'undo does not empty the clipboard');
  controller.dispose();
});
