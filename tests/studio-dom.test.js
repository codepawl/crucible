import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodePack } from '../src/scene-pack-format.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { createStudio, createStudioController, STUDIO_PRIMITIVES, STUDIO_TABS, STUDIO_TEMPLATES, STUDIO_TOOLS } from '../src/studio.js';
import { LIGHTING_SETUP_NAMES } from '../src/agent-scene-capabilities.js';
import { createAgentScene } from '../src/agent-scene.js';
import { directionToSunAngles, hexToLinearRgb } from '../src/studio-controller.js';
import { buildGridParts } from '../src/studio-viewport-aids.js';
import { VIEW_TRANSFORM_NAMES } from '../src/view-transform-names.js';
import { tinyHdrBytes } from './helpers/tiny-hdr.js';
import { createFakeWebgl2 } from './support/fake-webgl2.mjs';
import {
  byDataset,
  byLabel,
  byText,
  createFakeRenderer,
  dispatch,
  installStudioDom,
} from './support/studio-dom.mjs';
import { ProgramNotReady, finishProgram } from '../src/gl-program.js';

function makeRecipe() {
  return {
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
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

/** Mounts Studio on the fake DOM with a fake renderer and returns the handles tests use. */
const GRID_LINE_COUNT = buildGridParts().length;

function mountStudio(testContext, { recipe = makeRecipe(), containerWidth = 0, domOptions, sharedDom = null, ...options } = {}) {
  const dom = sharedDom ?? installStudioDom(domOptions);
  const container = sharedDom ? dom.document.createElement('div') : dom.container;
  if (sharedDom) dom.document.body.append(container);
  container.clientWidth = containerWidth;
  const renderer = createFakeRenderer();
  const studio = createStudio(container, { recipe, renderer, ...options });
  testContext.after(() => {
    studio.dispose();
    if (!sharedDom) dom.uninstall();
  });
  const root = container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  const ui = {
    dom,
    studio,
    renderer,
    root,
    viewport,
    canvas: viewport.querySelector('canvas'),
    gizmo: viewport.querySelector('.crucible-studio-gizmo'),
    controller: studio.controller,
    label: label => byLabel(root, label),
    button: text => root.querySelectorAll('button').find(candidate => candidate.textContent === text || candidate.getAttribute('aria-label') === text),
    tool: tool => byDataset(root, 'tool', tool),
    tab: tab => byDataset(root, 'tab', tab),
    panel: tab => root.querySelector(`#crucible-studio-panel-${tab}`),
    status: () => root.querySelector('.crucible-studio-status').textContent,
    // The camera and light rows sit above the node rows; these two helpers read the node rows only.
    rows: () => root.querySelectorAll('.crucible-studio-tree-row').filter(row => row.dataset.sceneObject === undefined),
    rowLabels: () => ui.rows().map(row => row.querySelector('.crucible-studio-tree-label').textContent),
    objectRows: () => root.querySelectorAll('.crucible-studio-tree-row').filter(row => row.dataset.sceneObject !== undefined),
    objectLabels: () => ui.objectRows().map(row => row.querySelector('.crucible-studio-tree-label').textContent),
    node: nodeId => studio.exportRecipe().nodes.find(node => node.id === nodeId),
    material: materialId => studio.exportRecipe().materials.find(material => material.id === materialId),
    selectRow: nodeId => {
      const row = ui.rows().find(candidate => candidate.querySelector('.crucible-studio-tree-label').textContent === nodeId);
      row.querySelector('.crucible-studio-tree-select').click();
    },
    gizmoPart: axis => ui.gizmo.descendants().find(element => element.getAttribute('data-gizmo-axis') === axis),
    clientPoint: point => ({ clientX: point.x + VIEWPORT_BOX.left, clientY: point.y + VIEWPORT_BOX.top }),
    setSlider: (label, value) => {
      const slider = ui.label(label);
      slider.value = String(value);
      dispatch(slider, 'input');
      dispatch(slider, 'change');
    },
  };
  return ui;
}

test('mounting Studio builds the three zones, the styles and the first frame', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.root.className, 'crucible-studio');
  assert.equal(ui.root.dataset.desktop, 'false');
  assert.equal(ui.root.dataset.outlinerCollapsed, 'false');
  assert.equal(ui.root.dataset.compact, undefined);
  assert.equal(ui.dom.document.head.querySelectorAll('style').length, 1);
  assert.ok(ui.dom.document.getElementById('crucible-studio-styles').textContent.length > 100);
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb']);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'untitled.scene.json');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').dataset.dirty, 'false');
  assert.equal(ui.root.querySelector('.crucible-studio-watch-pill').hidden, true);
  assert.equal(ui.studio.dirty, false);
  assert.equal(ui.studio.renderer, ui.renderer);
  assert.equal(ui.studio.scene, ui.controller.scene);
  assert.ok(ui.renderer.calls.includes('render'));
  assert.equal(ui.renderer.frames.at(-1).exposure, ui.controller.scene.effects.exposure);
  assert.equal(ui.controller.viewportWidth, 800);
  assert.equal(ui.controller.viewportHeight, 600);
  assert.ok(ui.renderer.calls.includes('resize'));
  assert.equal(ui.canvas.getAttribute('aria-label'), '3D viewport. Click to select, drag to orbit, scroll to zoom.');
  assert.ok(ui.canvas.id.startsWith('crucible-studio-canvas-'));
  assert.equal(ui.dom.observers.resize.length, 1);
  assert.equal(ui.dom.observers.resize[0].observed[0], ui.viewport);
  assert.equal(ui.dom.observers.intersection.length, 1);

  assert.throws(() => createStudio(null), /requires a DOM container element/);
  const secondContainer = ui.dom.document.createElement('div');
  ui.dom.document.body.append(secondContainer);
  const secondStudio = createStudio(secondContainer, { renderer: createFakeRenderer(), template: 'showcase' });
  assert.equal(ui.dom.document.head.querySelectorAll('style').length, 1);
  assert.ok(secondStudio.exportRecipe().nodes.length > 0);
  secondStudio.dispose();
});

test('Studio mounts from a ready scene and from the smaller templates without building a renderer', testContext => {
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  for (const templateKey of ['courtyard', 'empty']) {
    const studio = createStudio(dom.container, { template: templateKey, renderer: createFakeRenderer() });
    assert.equal(studio.exportRecipe().format, 'crucible.scene', templateKey);
    studio.dispose();
  }
  const scene = createStudioController({ scene: createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() }).scene }).scene;
  const fromScene = createStudio(dom.container, { scene, renderer: createFakeRenderer() });
  assert.equal(fromScene.scene, scene);
  fromScene.dispose();
});

test('tool buttons, tab buttons and tool keys switch the active tool and inspector tab', testContext => {
  const ui = mountStudio(testContext);
  for (const tool of STUDIO_TOOLS) {
    ui.tool(tool).click();
    assert.equal(ui.controller.tool, tool);
    for (const other of STUDIO_TOOLS) {
      assert.equal(ui.tool(other).getAttribute('aria-pressed'), other === tool ? 'true' : 'false');
    }
  }
  const keyToTool = { q: 'select', g: 'translate', r: 'rotate', s: 'scale', G: 'translate' };
  for (const [key, tool] of Object.entries(keyToTool)) {
    dispatch(ui.dom.document, 'keydown', { key });
    assert.equal(ui.controller.tool, tool, `key ${key}`);
  }
  assert.equal(ui.dom.document.querySelector('[data-tool="snap"]'), null, 'snapping is no longer a tool on the rail');
  dispatch(ui.dom.document, 'keydown', { key: 't' });
  assert.equal(ui.controller.tool, 'translate', 'T, the old Snap key, is free');

  for (const tab of STUDIO_TABS) {
    ui.tab(tab).click();
    assert.equal(ui.controller.activeTab, tab);
    for (const other of STUDIO_TABS) {
      assert.equal(ui.tab(other).getAttribute('aria-selected'), other === tab ? 'true' : 'false');
      assert.equal(ui.tab(other).hasAttribute('focusgroupstart'), other === tab);
      assert.equal(ui.panel(other).hasAttribute('hidden'), other !== tab);
      assert.equal(ui.panel(other).tabIndex === 0, other === tab);
    }
  }
  ui.studio.setActiveTab('node');
  assert.equal(ui.tab('node').getAttribute('aria-selected'), 'true');
  ui.panel('look').dispatchEvent(ui.dom.document.createEvent('beforematch'));
  assert.equal(ui.controller.activeTab, 'look');
  ui.studio.setTool('rotate');
  assert.equal(ui.tool('rotate').getAttribute('aria-pressed'), 'true');
});

test('arrow keys move focus along the toolbar and the tab list when the browser has no focus groups', testContext => {
  const ui = mountStudio(testContext);
  const toolbar = ui.root.querySelector('.crucible-studio-toolbar');
  const tabList = ui.root.querySelector('.crucible-studio-tablist');
  assert.equal(tabList.getAttribute('role'), 'tablist');
  assert.equal(ui.tab('look').getAttribute('role'), 'tab');

  ui.tool('select').focus();
  assert.equal(ui.tool('select').tabIndex, 0);
  assert.equal(ui.tool('translate').tabIndex, -1);
  const down = dispatch(ui.tool('select'), 'keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(ui.dom.document.activeElement, ui.tool('translate'));
  assert.equal(ui.tool('translate').tabIndex, 0);
  dispatch(ui.tool('translate'), 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.dom.document.activeElement, ui.tool('select'));
  dispatch(ui.tool('select'), 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.dom.document.activeElement, byLabel(toolbar, 'Show or hide the panels'));
  dispatch(ui.dom.document.activeElement, 'keydown', { key: 'Home' });
  assert.equal(ui.dom.document.activeElement, ui.tool('select'));
  dispatch(ui.tool('select'), 'keydown', { key: 'End' });
  assert.equal(ui.dom.document.activeElement, byLabel(toolbar, 'Show or hide the panels'));
  const ignored = dispatch(ui.dom.document.activeElement, 'keydown', { key: 'a' });
  assert.equal(ignored.defaultPrevented, false);

  // Arrow keys walk only the tabs of the open workspace: Look holds Material and Look.
  ui.tab('material').click();
  ui.tab('material').focus();
  dispatch(ui.tab('material'), 'keydown', { key: 'ArrowRight' });
  assert.ok(ui.dom.document.activeElement === ui.tab('look'));
  assert.equal(ui.controller.activeTab, 'look');
  dispatch(ui.tab('look'), 'keydown', { key: 'ArrowRight' });
  assert.equal(ui.controller.activeTab, 'material', 'the walk wraps inside the workspace and skips the hidden tabs');
  dispatch(ui.tab('material'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(ui.controller.activeTab, 'look');

  ui.dom.document.activeElement = null;
  const stray = dispatch(tabList, 'keydown', { key: 'ArrowRight' });
  assert.equal(stray.defaultPrevented, false);
  const outsideFocus = ui.dom.document.createEvent('focusin', { target: ui.root });
  tabList.dispatchEvent(outsideFocus);
  assert.equal(ui.tab('look').tabIndex, 0);
});

test('the outliner selects, hides, filters and renames nodes', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.controller.selectedNodeId, 'ground');
  assert.equal(ui.rows()[0].dataset.selected, 'true');
  assert.equal(ui.rows().filter(row => row.dataset.selected === 'true').length, 1);
  ui.selectRow('hero');
  assert.equal(ui.controller.selectedNodeId, 'hero');
  assert.equal(ui.rows()[1].dataset.selected, 'true');
  assert.equal(ui.rows()[1].getAttribute('aria-selected'), 'true');
  assert.equal(ui.label('Node label').value, 'hero');
  assert.equal(ui.label('Node label').disabled, false);
  assert.equal(ui.label('Position Y').value, '0.5');

  const eye = ui.rows()[1].querySelector('.crucible-studio-tree-eye');
  assert.equal(eye.getAttribute('aria-label'), 'Hide hero');
  eye.click();
  assert.equal(ui.node('hero').visible, false);
  const hiddenEye = ui.rows()[1].querySelector('.crucible-studio-tree-eye');
  assert.equal(hiddenEye.getAttribute('aria-label'), 'Show hero');
  assert.equal(hiddenEye.dataset.hidden, 'true');
  assert.equal(ui.rows()[1].querySelector('.crucible-studio-tree-select').dataset.hidden, 'true');
  assert.equal(ui.studio.dirty, true);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').dataset.dirty, 'true');
  hiddenEye.click();
  assert.notEqual(ui.node('hero').visible, false);

  const search = ui.label('Filter the scene list');
  search.value = 'OR';
  dispatch(search, 'input');
  assert.deepEqual(ui.rowLabels(), ['orb']);
  search.value = 'nothing-matches';
  dispatch(search, 'input');
  assert.deepEqual(ui.rowLabels(), []);
  search.value = '';
  dispatch(search, 'input');
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb']);

  ui.rows()[2].querySelector('.crucible-studio-tree-select').dispatchEvent(ui.dom.document.createEvent('dblclick'));
  assert.equal(ui.controller.selectedNodeId, 'orb');
  const rowEditorInput = ui.root.querySelector('.crucible-studio-name-editor input');
  assert.equal(rowEditorInput.value, 'orb', 'a double click edits the name in the row itself (#3344)');
  assert.equal(ui.dom.document.activeElement === rowEditorInput, true);
  assert.equal(rowEditorInput.selected, true);
  dispatch(rowEditorInput, 'keydown', { key: 'Escape' });

  const nameInput = ui.label('Node label');
  nameInput.value = 'Moon';
  dispatch(nameInput, 'change');
  assert.equal(ui.node('orb').label, 'Moon');
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'Moon']);
});

test('the Object tab edits visibility, shadows, parent and the three vector fields', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode(null);
  const nameInput = ui.label('Node label');
  assert.equal(nameInput.disabled, true);
  assert.equal(ui.label('Parent node').disabled, true);
  nameInput.value = 'ignored';
  dispatch(nameInput, 'change');
  dispatch(ui.label('Parent node'), 'change');
  ui.root.querySelectorAll('button').find(button => button.textContent === 'Casts shadow').click();
  assert.equal(ui.controller.selectedNodeId, null);

  ui.selectRow('hero');
  const castShadow = ui.root.querySelectorAll('button').find(button => button.textContent === 'Casts shadow');
  const receiveShadow = ui.root.querySelectorAll('button').find(button => button.textContent === 'Receives shadow');
  castShadow.click();
  assert.equal(ui.node('hero').castShadow, false);
  assert.equal(castShadow.getAttribute('aria-pressed'), 'false');
  castShadow.click();
  assert.notEqual(ui.node('hero').castShadow, false);
  receiveShadow.click();
  assert.equal(ui.node('hero').receiveShadow, false);
  assert.equal(receiveShadow.getAttribute('aria-pressed'), 'false');

  const visibility = ui.label('Hide');
  visibility.click();
  assert.equal(ui.node('hero').visible, false);
  assert.equal(visibility.getAttribute('aria-label'), 'Show');
  assert.equal(visibility.dataset.icon, 'eyeOff');
  ui.label('Show').click();
  assert.notEqual(ui.node('hero').visible, false);

  const parentSelect = ui.label('Parent node');
  assert.deepEqual(parentSelect.children.map(option => option.value), ['', 'ground', 'orb']);
  parentSelect.value = 'ground';
  dispatch(parentSelect, 'change');
  assert.equal(ui.node('hero').parent, 'ground');
  parentSelect.value = '';
  dispatch(parentSelect, 'change');
  assert.equal(ui.node('hero').parent ?? null, null);

  const positionX = ui.label('Position X');
  positionX.value = '1.5';
  dispatch(positionX, 'change');
  assert.deepEqual(ui.node('hero').translation, [1.5, 0.5, 0]);
  positionX.value = 'not a number';
  dispatch(positionX, 'change');
  assert.equal(ui.node('hero').translation[0], 1.5);

  const rotationY = ui.label('Rotation ° Y');
  rotationY.value = '45';
  dispatch(rotationY, 'change');
  const quaternion = ui.node('hero').rotation;
  assert.ok(Math.abs(quaternion[1] - Math.sin(Math.PI / 8)) < 1e-3);
  assert.equal(ui.label('Rotation ° Y').value, '45');

  const scaleZ = ui.label('Scale Z');
  scaleZ.value = '3';
  dispatch(scaleZ, 'change');
  assert.deepEqual(ui.node('hero').scale, [1, 1, 3]);
  scaleZ.value = '0';
  dispatch(scaleZ, 'change');
  assert.deepEqual(ui.node('hero').scale, [1, 1, 0.02]);
});

test('the scale lock keeps the three axes together and axis labels scrub the value', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const lock = ui.label('Keep the three axes together');
  assert.equal(lock.getAttribute('aria-pressed'), 'false');
  lock.click();
  assert.equal(lock.getAttribute('aria-pressed'), 'true');
  const scaleX = ui.label('Scale X');
  scaleX.value = '2';
  dispatch(scaleX, 'change');
  assert.deepEqual(ui.node('hero').scale, [2, 2, 2]);
  lock.click();
  assert.equal(lock.getAttribute('aria-pressed'), 'false');

  const scrubLabel = ui.root.querySelectorAll('.crucible-studio-axis-scrub')[0];
  assert.equal(scrubLabel.textContent, 'X');
  const pointerDown = dispatch(scrubLabel, 'pointerdown', { clientX: 100, pointerId: 7 });
  assert.equal(pointerDown.defaultPrevented, true);
  assert.deepEqual(scrubLabel.capturedPointerIds, [7]);
  dispatch(scrubLabel, 'pointermove', { clientX: 140 });
  assert.equal(ui.node('hero').translation[0], 0.6);
  dispatch(scrubLabel, 'pointermove', { clientX: 140, shiftKey: true });
  assert.equal(ui.node('hero').translation[0], 0.12);
  dispatch(scrubLabel, 'pointerup', {});
  dispatch(scrubLabel, 'pointermove', { clientX: 300 });
  assert.equal(ui.node('hero').translation[0], 0.12);
  dispatch(scrubLabel, 'pointerdown', { clientX: 0 });
  dispatch(scrubLabel, 'pointercancel', {});
  dispatch(scrubLabel, 'pointermove', { clientX: 90 });
  assert.equal(ui.node('hero').translation[0], 0.12);
});

test('toolbar buttons undo, redo, duplicate, delete and frame the selection', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode(null);
  const undoButton = ui.label('Undo (Ctrl+Z)');
  const redoButton = ui.label('Redo (Ctrl+Shift+Z)');
  const duplicateButton = ui.label('Duplicate (Ctrl+D)');
  const deleteButton = ui.label('Delete (Del)');
  const frameButton = ui.label('Frame in view (F)');
  assert.equal(undoButton.getAttribute('aria-disabled'), 'true');
  assert.equal(duplicateButton.getAttribute('aria-disabled'), 'true');
  undoButton.click();
  redoButton.click();
  duplicateButton.click();
  deleteButton.click();
  assert.equal(ui.status(), '');
  assert.equal(ui.studio.exportRecipe().nodes.length, 3);

  ui.selectRow('hero');
  assert.equal(duplicateButton.getAttribute('aria-disabled'), 'false');
  assert.equal(deleteButton.getAttribute('aria-disabled'), 'false');
  const eyeBefore = ui.controller.scene.camera.eye.slice();
  frameButton.click();
  assert.equal(ui.status(), 'Framed selection');
  ui.dom.runAnimationFrames(0);
  ui.dom.runAnimationFrames(500);
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore);

  duplicateButton.click();
  assert.equal(ui.studio.exportRecipe().nodes.length, 4);
  assert.match(ui.status(), /^Duplicated to /);
  assert.equal(undoButton.getAttribute('aria-disabled'), 'false');
  undoButton.click();
  assert.equal(ui.status(), 'Undid edit');
  assert.equal(ui.studio.exportRecipe().nodes.length, 3);
  assert.equal(redoButton.getAttribute('aria-disabled'), 'false');
  redoButton.click();
  assert.equal(ui.status(), 'Redid edit');
  assert.equal(ui.studio.exportRecipe().nodes.length, 4);

  ui.selectRow('hero');
  deleteButton.click();
  assert.equal(ui.status(), 'Deleted node');
  assert.equal(ui.studio.exportRecipe().nodes.some(node => node.id === 'hero'), false);
  assert.equal(ui.controller.selectedNodeId, null, 'a delete leaves nothing selected');
  assert.equal(ui.dom.pendingTimerCount > 0, true);
  ui.dom.runTimers();
  assert.equal(ui.status(), '');
});

test('the add menu opens beside its button and adds every primitive and the three lights', async testContext => {
  const ui = mountStudio(testContext);
  const addButton = ui.label('Add an object or a light');
  addButton.click();
  const addPopover = ui.root.querySelector('#crucible-studio-pop-add');
  assert.equal(addPopover.popoverOpen, true);
  assert.match(addPopover.style.left, /px$/);
  assert.match(addPopover.style.top, /px$/);

  let expectedNodes = 3;
  for (const primitive of STUDIO_PRIMITIVES) {
    const label = { icoSphere: 'Icosphere', disc: 'Circle' }[primitive] ?? primitive[0].toUpperCase() + primitive.slice(1);
    byText(addPopover, label).click();
    await ui.dom.settle();
    expectedNodes += 1;
    assert.equal(addPopover.popoverOpen, false);
    assert.equal(ui.studio.exportRecipe().nodes.length, expectedNodes, label);
    assert.match(ui.status(), /^Added /, label);
    assert.equal(ui.controller.selectedNodeId, ui.studio.exportRecipe().nodes.at(-1).id);
  }

  byText(addPopover, 'Point light').click();
  assert.equal(ui.status(), 'Point lights: 1');
  byText(addPopover, 'Spot light').click();
  assert.equal(ui.status(), 'Spot lights: 1');
  assert.equal(ui.studio.exportRecipe().environment.pointLights.length, 1);
  assert.equal(ui.studio.exportRecipe().environment.spotLights.length, 1);
  byText(addPopover, 'Area light').click();
  assert.equal(ui.status(), 'Area lights: 1');
  assert.equal(ui.studio.exportRecipe().environment.areaLights.length, 1);
  assert.deepEqual(ui.studio.exportRecipe().environment.areaLights[0].direction, [0, -1, 0], 'a new area light shines down');
  for (let added = 1; added < 7; added += 1) {
    byText(addPopover, 'Area light').click();
  }
  assert.equal(ui.status(), 'Area lights: 7');
  byText(addPopover, 'Area light').click();
  assert.match(ui.status(), /limit of 7 area lights/, 'one more than the limit says why it was not added');
  assert.equal(ui.studio.exportRecipe().environment.areaLights.length, 7);
  for (const type of ['circle', 'text']) {
    assert.ok(ui.studio.exportRecipe().geometries.some(geometry => geometry.type === type), type);
  }
});

test('the add menu lists Mesh, Text and Light in that order, with no caption or divider', testContext => {
  const ui = mountStudio(testContext);
  ui.label('Add an object or a light').click();
  const addPopover = ui.root.querySelector('#crucible-studio-pop-add');
  const groups = [...addPopover.querySelectorAll('[role="group"]')];
  assert.deepEqual(groups.map(group => group.getAttribute('aria-label')), ['Mesh', 'Text', 'Light']);
  const buttonLabels = group => [...group.querySelectorAll('button')].map(button => button.textContent);
  assert.deepEqual(buttonLabels(groups[0]), ['Plane', 'Box', 'Circle', 'Sphere', 'Icosphere', 'Cylinder', 'Cone', 'Torus']);
  assert.deepEqual(buttonLabels(groups[1]), ['Text']);
  assert.deepEqual(buttonLabels(groups[2]), ['Point light', 'Spot light', 'Area light']);
  assert.equal(addPopover.children.length, 3, 'only the three groups, no heading or rule between them');
});

test('a scene holding a heart and a vase shows both in the Scene list and selects them', testContext => {
  const recipe = makeRecipe();
  recipe.geometries.push(
    { id: 'heart-shape', type: 'extrude', contour: [[0, 0.5], [0.4, 0.9], [0.5, 0.4], [0, -0.5], [-0.5, 0.4], [-0.4, 0.9]], depth: 0.25 },
    { id: 'vase-shape', type: 'lathe', profile: [[0.3, -0.5], [0.46, -0.2], [0.42, 0.05], [0.24, 0.3], [0.34, 0.5]], segments: 48 },
  );
  recipe.nodes.push(
    { id: 'heart', geometry: 'heart-shape', material: 'paint', translation: [1, 0.5, 0] },
    { id: 'vase', geometry: 'vase-shape', material: 'paint', translation: [-1, 0.5, 0] },
  );
  const ui = mountStudio(testContext, { recipe });
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb', 'heart', 'vase']);
  ui.selectRow('vase');
  assert.equal(ui.controller.selectedNodeId, 'vase');
  assert.equal(ui.label('Position X').value, '-1');
  ui.controller.updateNodeTransform('vase', { translation: [0, 0.5, 2] });
  assert.deepEqual(ui.node('vase').translation, [0, 0.5, 2]);
});

test('popover buttons open each menu, close it again on a click inside and stay inside the window', testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelectorAll('button').find(button => button.getAttribute('popovertarget') === 'crucible-studio-pop-new');
  filePill.box = { left: 20, top: 10, width: 120, height: 24, right: 140, bottom: 34 };
  filePill.click();
  const newPopover = ui.root.querySelector('#crucible-studio-pop-new');
  assert.equal(newPopover.popoverOpen, true);
  assert.equal(newPopover.style.left, '15px');
  assert.equal(newPopover.style.right, 'auto');
  assert.equal(newPopover.style.top, '48px');
  newPopover.querySelector('#crucible-studio-recent-list').dispatchEvent(ui.dom.document.createEvent('click', { bubbles: true }));
  assert.equal(newPopover.popoverOpen, true);

  assert.equal(ui.root.querySelector('#crucible-studio-pop-export'), null, 'Export is a workspace, so the top bar holds no export menu');

  const syncButton = ui.label('Work with an AI agent');
  syncButton.box = { left: 1000, top: 700, width: 30, height: 30, right: 1030, bottom: 730 };
  syncButton.click();
  const syncPopover = ui.root.querySelector('#crucible-studio-pop-sync');
  assert.equal(syncPopover.style.top, '500px');
});

test('a material swatch assigns its material and opens the Material tab', testContext => {
  const ui = mountStudio(testContext);
  const swatches = ui.root.querySelectorAll('.crucible-studio-swatch-btn');
  assert.deepEqual(swatches.map(swatch => swatch.title), ['stone', 'paint']);
  assert.equal(swatches[0].getAttribute('aria-pressed'), 'true');
  assert.equal(swatches[1].getAttribute('aria-pressed'), 'false');
  swatches[1].click();
  assert.equal(ui.controller.activeTab, 'material');
  assert.equal(ui.node('ground').material, 'paint');
  assert.equal(ui.label('Assigned material').value, 'paint');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-swatch-btn')[1].getAttribute('aria-pressed'), 'true');

  ui.controller.selectNode(null);
  ui.root.querySelectorAll('.crucible-studio-swatch-btn')[0].click();
  assert.equal(ui.controller.activeTab, 'material');
  assert.equal(ui.node('ground').material, 'paint');
});

test('Material tab edits colours and sliders as single undo steps', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tab('material').click();
  assert.equal(ui.label('Roughness').value, '0.4');
  assert.equal(ui.label('Roughness').parentNode.querySelector('output').textContent, '0.40');

  const colorInput = ui.label('Base color');
  colorInput.value = '#336699';
  dispatch(colorInput, 'input');
  dispatch(colorInput, 'input');
  dispatch(colorInput, 'change');
  assert.notDeepEqual(ui.material('paint').color, [0.8, 0.25, 0.2]);
  ui.controller.undo();
  assert.deepEqual(ui.material('paint').color, [0.8, 0.25, 0.2]);
  assert.equal(ui.controller.canUndo, false);

  const glowInput = ui.label('Emissive color');
  glowInput.value = '#ff8800';
  dispatch(glowInput, 'input');
  dispatch(glowInput, 'change');
  assert.ok(ui.material('paint').emissiveColor);

  const expectations = [
    ['Roughness', 0.9, 'roughness', 0.9],
    ['Metallic', 0.6, 'metallic', 0.6],
    ['Clearcoat', 0.5, 'clearcoat', 0.5],
    ['Opacity', 0.7, 'opacity', 0.7],
    ['Emission', 3.5, 'emission', 3.5],
  ];
  for (const [label, sliderValue, property, expected] of expectations) {
    ui.setSlider(label, sliderValue);
    assert.equal(ui.material('paint')[property], expected, property);
  }
  assert.equal(ui.material('paint').clearcoatRoughness, 0.08);
  assert.equal(ui.label('Emission').parentNode.querySelector('output').textContent, '3.5');

  ui.controller.undo();
  assert.equal(ui.material('paint').emission ?? 0, 0);
  assert.equal(ui.material('paint').opacity, 0.7);
  ui.controller.undo();
  assert.equal(ui.material('paint').opacity ?? 1, 1);

  assert.equal(ui.label('Roughness').disabled, false);
});

test('Material tab edits clearcoat roughness and double sided, each as one undo step', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tab('material').click();
  assert.equal(ui.label('Clearcoat roughness').value, '0');
  assert.equal(ui.button('Double sided').getAttribute('aria-pressed'), 'false');

  ui.setSlider('Clearcoat', 0.5);
  assert.equal(ui.material('paint').clearcoatRoughness, 0.08);
  ui.setSlider('Clearcoat roughness', 0.4);
  assert.equal(ui.material('paint').clearcoatRoughness, 0.4);
  assert.equal(ui.label('Clearcoat roughness').parentNode.querySelector('output').textContent, '0.40');
  ui.setSlider('Clearcoat', 0.9);
  assert.equal(ui.material('paint').clearcoatRoughness, 0.4, 'moving the coat keeps the chosen roughness');
  ui.controller.undo();
  ui.controller.undo();
  assert.equal(ui.material('paint').clearcoatRoughness, 0.08);

  ui.button('Double sided').click();
  assert.equal(ui.material('paint').doubleSided, true);
  assert.equal(ui.button('Double sided').getAttribute('aria-pressed'), 'true');
  ui.controller.undo();
  assert.equal(ui.material('paint').doubleSided, false);
  assert.equal(ui.button('Double sided').getAttribute('aria-pressed'), 'false');
});

test('material presets, the material list and new materials work from the Material tab', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('orb');
  ui.tab('material').click();
  byDataset(ui.root, 'preset', 'gold').click();
  assert.equal(ui.status(), 'Applied Gold preset');
  assert.equal(ui.material('paint').metallic, 0.96);
  assert.equal(ui.label('Metallic').value, '0.96');

  const materialSelect = ui.label('Assigned material');
  assert.deepEqual(materialSelect.children.map(option => option.value), ['stone', 'paint']);
  materialSelect.value = 'stone';
  dispatch(materialSelect, 'change');
  assert.equal(ui.node('orb').material, 'stone');
  materialSelect.value = '';
  dispatch(materialSelect, 'change');
  assert.equal(ui.node('orb').material, 'stone');

  ui.tab('node').click();
  ui.label('New material').click();
  assert.equal(ui.controller.activeTab, 'material');
  assert.match(ui.status(), /^Created /);
  assert.equal(ui.studio.exportRecipe().materials.length, 3);
  assert.equal(ui.node('orb').material, ui.studio.exportRecipe().materials[2].id);
  assert.equal(ui.root.querySelectorAll('.crucible-studio-swatch-btn').length, 3);
});

test('material controls without a selection act on the first material', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode(null);
  assert.equal(ui.label('Assigned material').value, 'stone');
  ui.setSlider('Metallic', 0.3);
  assert.equal(ui.material('stone').metallic, 0.3);
  byDataset(ui.root, 'preset', 'gold').click();
  assert.equal(ui.material('stone').metallic, 0.96);
});

test('Look tab picks a lighting setup, drags the sun pad as one undo step and moves its sliders', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const setupButtons = LIGHTING_SETUP_NAMES.map(setup => byDataset(ui.root, 'setup', setup));
  const initialSetup = ui.studio.exportRecipe().environment.setup;
  assert.equal(setupButtons.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
  const otherSetup = LIGHTING_SETUP_NAMES.find(setup => setup !== initialSetup);
  byDataset(ui.root, 'setup', otherSetup).click();
  assert.equal(ui.studio.exportRecipe().environment.setup, otherSetup);
  assert.equal(byDataset(ui.root, 'setup', otherSetup).getAttribute('aria-pressed'), 'true');
  assert.equal(byDataset(ui.root, 'setup', initialSetup).getAttribute('aria-pressed'), 'false');

  const sunPad = ui.root.querySelector('.crucible-studio-sunpad');
  sunPad.box = { left: 0, top: 0, width: 120, height: 120, right: 120, bottom: 120 };
  dispatch(sunPad, 'pointermove', { clientX: 60, clientY: 10 });
  dispatch(sunPad, 'pointerdown', { clientX: 60, clientY: 10, pointerId: 3 });
  assert.deepEqual(sunPad.capturedPointerIds, [3]);
  let angles = directionToSunAngles(ui.studio.exportRecipe().environment.lightDirection);
  assert.equal(angles.azimuthDegrees, 0);
  assert.ok(Math.abs(angles.elevationDegrees - 24) <= 1, `elevation ${angles.elevationDegrees}`);
  dispatch(sunPad, 'pointermove', { clientX: 110, clientY: 60 });
  angles = directionToSunAngles(ui.studio.exportRecipe().environment.lightDirection);
  assert.equal(angles.azimuthDegrees, 90);
  dispatch(sunPad, 'pointerup', {});
  dispatch(sunPad, 'pointermove', { clientX: 10, clientY: 60 });
  assert.equal(directionToSunAngles(ui.studio.exportRecipe().environment.lightDirection).azimuthDegrees, 90);
  dispatch(sunPad, 'pointerup', {});
  dispatch(sunPad, 'pointercancel', {});
  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().environment.setup, otherSetup);
  assert.notEqual(directionToSunAngles(ui.studio.exportRecipe().environment.lightDirection).azimuthDegrees, 90);

  ui.setSlider('Sun strength', 4.5);
  assert.equal(ui.studio.exportRecipe().environment.keyIntensity, 4.5);
  ui.setSlider('Exposure', 1.4);
  assert.equal(ui.studio.exportRecipe().effects.exposure, 1.4);
  ui.setSlider('Contrast', 1.2);
  assert.equal(ui.studio.exportRecipe().effects.contrast, 1.2);
  ui.setSlider('Saturation', 0.6);
  assert.equal(ui.studio.exportRecipe().effects.saturation, 0.6);
  ui.setSlider('Bloom', 0.5);
  assert.equal(ui.studio.exportRecipe().effects.bloom.strength, 0.5);
  ui.setSlider('Fog density', 0.02);
  assert.equal(ui.studio.exportRecipe().environment.fogDensity, 0.02);
  assert.equal(ui.label('Fog density').parentNode.querySelector('output').textContent, '0.02', 'trailing zeros are trimmed');
  ui.dom.runAnimationFrames(10);
  assert.equal(ui.renderer.frames.at(-1).exposure, 1.4);
});

test('the colour look select applies a view transform after loading its module', async testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const select = ui.label('View transform');
  assert.deepEqual(select.children.map(option => option.value), [...VIEW_TRANSFORM_NAMES]);
  assert.deepEqual(select.children.map(option => option.textContent), ['ACES', 'AgX', 'Neutral', 'Standard'], 'the options read as names while the recipe keeps its own values');
  const chosen = VIEW_TRANSFORM_NAMES.find(name => name !== select.value);
  select.value = chosen;
  dispatch(select, 'change');
  await ui.dom.settle();
  assert.equal(ui.studio.exportRecipe().environment.viewTransform, chosen);
  assert.equal(select.value, chosen);
});

test('Camera tab sets view presets, projection, lens, field of view and orthographic size', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const eyeBefore = ui.controller.scene.camera.eye.slice();
  for (const [text, announcement] of [['Front', 'Front view'], ['Right', 'Right view'], ['Top', 'Top view'], ['Iso', 'Iso view']]) {
    byText(ui.root, text).click();
    assert.equal(ui.status(), announcement);
    const activeViewChips = ['Front', 'Right', 'Top', 'Iso'].filter(name => byText(ui.root, name).getAttribute('aria-pressed') === 'true');
    assert.deepEqual(activeViewChips, [text], 'the chip of the current view is active and the others are not');
  }
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore);
  ui.controller.orbitCamera({ deltaAzimuth: 0.5, deltaElevation: 0.3 });
  assert.equal(['Front', 'Right', 'Top', 'Iso'].some(name => byText(ui.root, name).getAttribute('aria-pressed') === 'true'), false, 'a free orbit matches no view chip');
  assert.equal(byText(ui.root, 'Perspective').getAttribute('aria-pressed'), 'true', 'the projection chip names the projection in use');

  const projectionPill = byText(ui.root, 'Perspective');
  projectionPill.click();
  assert.equal(ui.status(), 'Orthographic view');
  assert.equal(projectionPill.textContent, 'Orthographic');
  assert.equal(projectionPill.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.controller.scene.camera.projection, 'orthographic');
  ui.setSlider('Orthographic size', 12);
  assert.equal(ui.controller.scene.camera.orthoScale, 12);
  projectionPill.click();
  assert.equal(ui.status(), 'Perspective view');
  assert.equal(ui.controller.scene.camera.projection, 'perspective');

  const lensButton = byDataset(ui.root, 'focal', '85');
  lensButton.click();
  assert.equal(lensButton.getAttribute('aria-pressed'), 'true');
  assert.equal(byDataset(ui.root, 'focal', '35').getAttribute('aria-pressed'), 'false');
  assert.equal(lensButton.textContent, '85 mm', 'a lens chip keeps its unit lower case');
  assert.ok(STUDIO_CSS.includes('.crucible-studio-chips-row button[data-focal] { text-transform: none; }'), 'the stylesheet does not capitalise the unit of a lens chip');
  ui.controller.setCameraLensMillimetres(85.4);
  assert.equal(lensButton.getAttribute('aria-pressed'), 'true', 'within half a millimetre still counts');
  ui.controller.setCameraLensMillimetres(70);
  assert.equal(lensButton.getAttribute('aria-pressed'), 'false');
  ui.setSlider('Field of view', 70);
  assert.equal(ui.controller.scene.camera.fov, 70);
  assert.equal(ui.label('Field of view').parentNode.querySelector('output').textContent, '70');
});

test('camera shots are saved, jumped to and removed from the Camera tab and the shot pills', async testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const nameInput = ui.label('Shot name');
  nameInput.value = ' wide  open ';
  byText(ui.root, 'Save shot').click();
  await ui.dom.settle();
  assert.equal(ui.status(), 'Saved view wide-open');
  assert.equal(nameInput.value, '');
  byText(ui.root, 'Save shot').click();
  await ui.dom.settle();
  assert.equal(ui.status(), 'Saved view shot-2');
  assert.deepEqual(ui.controller.listBookmarks().map(shot => shot.name), ['wide-open', 'shot-2']);
  const pills = ui.root.querySelectorAll('.crucible-studio-shots button');
  assert.deepEqual(pills.map(pill => pill.textContent), ['wide-open', 'shot-2']);

  const eyeAtShot = ui.controller.scene.camera.eye.slice();
  ui.controller.orbitCamera({ deltaAzimuth: 0.5 });
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeAtShot);
  pills[0].click();
  ui.controller.scene.camera.eye.forEach((value, index) => assert.ok(Math.abs(value - eyeAtShot[index]) < 1e-6));

  ui.controller.orbitCamera({ deltaAzimuth: 0.5 });
  const listButton = ui.root.querySelectorAll('.crucible-studio-bookmark-row button').find(button => button.textContent === 'wide-open');
  listButton.click();
  ui.controller.scene.camera.eye.forEach((value, index) => assert.ok(Math.abs(value - eyeAtShot[index]) < 1e-6));
  byLabel(ui.root, 'Remove bookmark wide-open').click();
  assert.deepEqual(ui.controller.listBookmarks().map(shot => shot.name), ['shot-2']);
  assert.equal(ui.root.querySelectorAll('.crucible-studio-shots button').length, 1);
});

test('the timeline needs a keyframe before it plays, then plays, loops, scrubs and pauses', async testContext => {
  const ui = mountStudio(testContext);
  const playButton = ui.label('Play (Space)');
  const scrub = ui.label('Timeline scrub');
  assert.equal(playButton.getAttribute('aria-disabled'), 'true');
  assert.equal(scrub.disabled, true);
  playButton.click();
  assert.equal(ui.status(), 'Add a keyframe first (K)');
  assert.equal(playButton.getAttribute('aria-pressed'), 'false');
  dispatch(scrub, 'input');
  assert.equal(ui.controller.motionTime, 0);

  ui.selectRow('hero');
  ui.label('Add a keyframe here (K)').click();
  await ui.dom.settle();
  assert.match(ui.status(), /^Keyframed at 0\.00 s$/);
  assert.equal(playButton.getAttribute('aria-disabled'), 'false');
  assert.equal(scrub.disabled, false);
  const duration = ui.studio.exportRecipe().motion.duration;
  assert.equal(scrub.max, String(duration));
  assert.equal(byText(ui.root, `0.0 / ${duration.toFixed(1)} s`).tagName, 'OUTPUT');

  ui.dom.runAnimationFrames(10);
  playButton.click();
  assert.equal(playButton.getAttribute('aria-pressed'), 'true');
  assert.equal(playButton.getAttribute('aria-label'), 'Pause (Space)');
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);
  const framesBefore = ui.renderer.frames.length;
  ui.dom.runAnimationFrames(1000);
  assert.equal(ui.controller.motionTime, 0);
  ui.dom.runAnimationFrames(1030);
  assert.ok(Math.abs(ui.controller.motionTime - 0.03) < 1e-6, `time ${ui.controller.motionTime}`);
  ui.dom.runAnimationFrames(1500);
  assert.ok(Math.abs(ui.controller.motionTime - 0.08) < 1e-6, 'a long gap advances at most 0.05 s');
  assert.ok(ui.renderer.frames.length > framesBefore);
  assert.equal(ui.renderer.frames.at(-1).time, ui.controller.motionTime);
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);

  ui.controller.setMotionTime(duration - 0.01);
  ui.dom.runAnimationFrames(1550);
  assert.ok(ui.controller.motionTime < 0.1, 'playback wraps to the start');

  playButton.click();
  assert.equal(playButton.getAttribute('aria-pressed'), 'false');
  assert.equal(playButton.getAttribute('aria-label'), 'Play (Space)');

  scrub.value = '0.5';
  dispatch(scrub, 'input');
  assert.equal(ui.controller.motionTime, 0.5);
  assert.equal(byText(ui.root, `0.5 / ${duration.toFixed(1)} s`).tagName, 'OUTPUT');
});

test('playback stops by itself when the animation is deleted while playing', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.label('Add a keyframe here (K)').click();
  await ui.dom.settle();
  ui.label('Play (Space)').click();
  assert.equal(ui.label('Pause (Space)').getAttribute('aria-pressed'), 'true');
  const withoutMotion = ui.studio.exportRecipe();
  delete withoutMotion.motion;
  ui.controller.loadRecipe(withoutMotion);
  ui.dom.runAnimationFrames(100);
  ui.dom.runAnimationFrames(130);
  assert.equal(ui.label('Play (Space)').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.label('Play (Space)').getAttribute('aria-disabled'), 'true');
});

test('the gizmo draws handles for each tool and clears them when nothing is selected', testContext => {
  const ui = mountStudio(testContext);
  const axesDrawn = () => new Set(ui.gizmo.descendants().map(element => element.getAttribute('data-gizmo-axis')).filter(Boolean));
  ui.controller.selectNode(null);
  ui.studio.renderNow();
  // Nothing selected leaves no handles or outline; only the sun's mark and its ray stay.
  assert.deepEqual(ui.gizmo.children.map(element => element.getAttribute('class')), ['crucible-studio-scene-mark-ray', 'crucible-studio-scene-mark']);
  assert.equal(axesDrawn().size, 0);

  ui.selectRow('hero');
  ui.tool('select').click();
  ui.studio.renderNow();
  assert.equal(ui.gizmo.getAttribute('viewBox'), '0 0 800 600');
  const silhouette = ui.gizmo.querySelector('.crucible-studio-selection-silhouette');
  assert.ok(silhouette.getAttribute('d').startsWith('M') && silhouette.getAttribute('d').includes('L'), 'the selection is drawn from the triangles of the object');
  const filterId = ui.gizmo.querySelector('filter').getAttribute('id');
  assert.ok(filterId.startsWith('crucible-studio-silhouette-'), 'each Studio has its own filter');
  assert.equal(silhouette.getAttribute('filter'), `url(#${filterId})`);
  assert.equal(ui.gizmo.querySelector('.crucible-studio-selection-outline'), null, 'the hull is only the fallback');
  assert.deepEqual([...axesDrawn()], ['screen']);

  ui.tool('translate').click();
  ui.studio.renderNow();
  assert.deepEqual([...axesDrawn()].sort(), ['screen', 'x', 'xy', 'xz', 'y', 'yz', 'z']);
  ui.tool('rotate').click();
  ui.studio.renderNow();
  assert.deepEqual([...axesDrawn()].sort(), ['x', 'y', 'z']);
  assert.equal(ui.gizmo.querySelectorAll('polyline').filter(element => !element.getAttribute('data-gizmo-hit')).length, 3);
  ui.tool('scale').click();
  ui.studio.renderNow();
  assert.deepEqual([...axesDrawn()].sort(), ['uniform', 'x', 'y', 'z']);
  assert.equal(ui.gizmo.querySelectorAll('rect').length, 3);
});

test('dragging a gizmo handle with the pointer moves the node, and undo puts it back', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const along = (axis, distance) => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis[axis][index] * distance));
  const grab = along('x', handles.handleLength);
  const release = along('x', handles.handleLength + 0.8);

  const down = dispatch(ui.gizmoPart('x'), 'pointerdown', { ...ui.clientPoint(grab), pointerId: 5 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.propagationStopped, true);
  assert.deepEqual(ui.viewport.capturedPointerIds, [5]);
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(release));
  assert.ok(Math.abs(ui.node('hero').translation[0] - 0.8) < 0.01, `x ${ui.node('hero').translation[0]}`);
  assert.equal(ui.controller.selectedNodeId, 'hero');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(release));
  assert.equal(ui.studio.dirty, true);

  dispatch(ui.canvas, 'pointermove', ui.clientPoint(grab));
  assert.ok(Math.abs(ui.node('hero').translation[0] - 0.8) < 0.01, 'a finished drag ignores further movement');
  ui.controller.undo();
  assert.deepEqual(ui.node('hero').translation, [0, 0.5, 0]);

  const missed = dispatch(ui.gizmo, 'pointerdown', ui.clientPoint(grab));
  assert.equal(missed.defaultPrevented, false);
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(release));
  assert.deepEqual(ui.node('hero').translation, [0, 0.5, 0]);
});

test('rotate and scale handles turn and stretch the node, and Ctrl snaps the turn', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('rotate').click();
  ui.studio.renderNow();
  let handles = ui.controller.gizmoHandles();
  const ringPoint = degrees => ui.controller.projectWorldPoint([
    handles.pivot[0] + Math.cos((degrees * Math.PI) / 180),
    handles.pivot[1],
    handles.pivot[2] - Math.sin((degrees * Math.PI) / 180),
  ]);
  dispatch(ui.gizmoPart('y'), 'pointerdown', ui.clientPoint(ringPoint(0)));
  dispatch(ui.canvas, 'pointermove', { ...ui.clientPoint(ringPoint(33)), ctrlKey: true });
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(ringPoint(33)));
  assert.ok(Math.abs(ui.node('hero').rotation[1] - Math.sin((15 * Math.PI) / 180)) < 1e-3);
  assert.ok(Math.abs(ui.label('Rotation ° Y').value - 30) < 0.5);

  ui.tool('scale').click();
  ui.studio.renderNow();
  handles = ui.controller.gizmoHandles();
  dispatch(ui.gizmoPart('uniform'), 'pointerdown', ui.clientPoint(handles.origin));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: handles.origin.x + 74, y: handles.origin.y }));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(handles.origin));
  assert.ok(Math.abs(ui.node('hero').scale[0] - 2) < 0.01);
  assert.ok(Math.abs(ui.node('hero').scale[2] - 2) < 0.01);
});

test('clicking the canvas picks an object or clears the selection, and dragging orbits or pans', testContext => {
  const ui = mountStudio(testContext);
  const orbPoint = ui.controller.projectWorldPoint([2.2, 0.5, 0]);
  dispatch(ui.canvas, 'pointerdown', ui.clientPoint(orbPoint));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(orbPoint));
  assert.equal(ui.controller.selectedNodeId, 'orb');
  assert.equal(ui.rows()[2].dataset.selected, 'true');

  dispatch(ui.canvas, 'pointerdown', ui.clientPoint({ x: 12, y: 12 }));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint({ x: 12, y: 12 }));
  assert.equal(ui.controller.selectedNodeId, null);

  dispatch(ui.canvas, 'pointerup', ui.clientPoint(orbPoint));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(orbPoint));
  dispatch(ui.canvas, 'pointerdown', { ...ui.clientPoint(orbPoint), button: 7 });
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(orbPoint));
  assert.equal(ui.controller.selectedNodeId, null);

  const start = { x: 400, y: 300 };
  const eyeBefore = ui.controller.scene.camera.eye.slice();
  dispatch(ui.canvas, 'pointerdown', ui.clientPoint(start));
  assert.equal(ui.canvas.capturedPointerIds.at(-1), 1);
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: 402, y: 301 }));
  assert.deepEqual(ui.controller.scene.camera.eye, eyeBefore);
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: 460, y: 330 }));
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore);
  dispatch(ui.canvas, 'pointerup', ui.clientPoint({ x: 460, y: 330 }));
  assert.equal(ui.controller.selectedNodeId, null, 'a drag is not a click');

  for (const panGesture of [{ shiftKey: true }, { button: 2 }, { button: 1 }]) {
    const targetBefore = ui.controller.scene.camera.target.slice();
    dispatch(ui.canvas, 'pointerdown', { ...ui.clientPoint(start), ...panGesture });
    dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: 480, y: 340 }));
    dispatch(ui.canvas, 'pointercancel', ui.clientPoint({ x: 480, y: 340 }));
    assert.notDeepEqual(ui.controller.scene.camera.target, targetBefore, JSON.stringify(panGesture));
  }
  assert.equal(dispatch(ui.canvas, 'contextmenu').defaultPrevented, true);
});

test('the mouse wheel zooms the camera and the page does not scroll', testContext => {
  const ui = mountStudio(testContext);
  const distance = () => Math.hypot(...ui.controller.scene.camera.eye.map((value, index) => value - ui.controller.scene.camera.target[index]));
  const before = distance();
  const zoomOut = dispatch(ui.canvas, 'wheel', { deltaY: 100 });
  assert.equal(zoomOut.defaultPrevented, true);
  const afterOut = distance();
  assert.ok(afterOut > before);
  dispatch(ui.canvas, 'wheel', { deltaY: -100 });
  assert.ok(distance() < afterOut);
  const beforeHuge = distance();
  dispatch(ui.canvas, 'wheel', { deltaY: 100000 });
  assert.ok(distance() / beforeHuge <= 1.35 + 1e-3, 'one wheel step is limited to 35 percent');

  // Wheel over a gizmo handle or scene mark zooms the camera too; over a scrolling panel it leaves the camera alone (#3464).
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const gizmoHandle = ui.gizmoPart('x');
  const lightMark = ui.gizmo.descendants().find(element => element.getAttribute('data-scene-object') === 'sun');
  assert.ok(gizmoHandle && lightMark, 'gizmo handle and sun mark are mounted over the viewport');
  const beforeGizmoWheel = distance();
  assert.equal(dispatch(gizmoHandle, 'wheel', { deltaY: 100 }).defaultPrevented, true);
  assert.ok(distance() > beforeGizmoWheel, 'wheel over a gizmo handle zooms');
  const beforeMarkWheel = distance();
  assert.equal(dispatch(lightMark, 'wheel', { deltaY: -100 }).defaultPrevented, true);
  assert.ok(distance() < beforeMarkWheel, 'wheel over a light or sun mark zooms');

  const panels = ui.root.querySelector('.crucible-studio-panels');
  const beforePanelWheel = distance();
  const panelWheel = dispatch(panels, 'wheel', { deltaY: 100 });
  assert.equal(panelWheel.defaultPrevented, false);
  assert.equal(distance(), beforePanelWheel, 'wheel over a panel leaves the camera alone');

  // Camera drags starting on a gizmo handle or scene mark with middle, right, Alt, or Shift+left move the camera (#3464).
  const azimuth = () => ui.controller.viewCamera.eye[0];
  const handles = ui.controller.gizmoHandles();
  const start = ui.clientPoint(handles.origin);
  const moved = ui.clientPoint({ x: handles.origin.x + 40, y: handles.origin.y + 15 });
  const beforePan = [...ui.controller.viewCamera.target];
  dispatch(gizmoHandle, 'pointerdown', { ...start, button: 1, pointerId: 21 });
  dispatch(ui.viewport, 'pointermove', { ...moved, pointerId: 21 });
  dispatch(ui.viewport, 'pointerup', { ...moved, button: 1, pointerId: 21 });
  assert.notDeepEqual(ui.controller.viewCamera.target, beforePan, 'middle drag from a gizmo handle pans the camera');

  const viewOffset = () => ui.controller.viewCamera.eye.map((value, index) => Math.round((value - ui.controller.viewCamera.target[index]) * 1e6) / 1e6);
  const beforeShiftOffset = viewOffset();
  const afterPanTarget = [...ui.controller.viewCamera.target];
  dispatch(lightMark, 'pointerdown', { ...start, button: 0, shiftKey: true, pointerId: 22 });
  dispatch(ui.viewport, 'pointermove', { ...moved, pointerId: 22 });
  dispatch(ui.viewport, 'pointerup', { ...moved, button: 0, pointerId: 22 });
  assert.notDeepEqual(ui.controller.viewCamera.target, afterPanTarget, 'Shift + left drag from a mark pans the camera');
  assert.deepEqual(viewOffset(), beforeShiftOffset, 'Shift + left drag pans rather than orbiting');

  const beforeRightPan = [...ui.controller.viewCamera.target];
  dispatch(gizmoHandle, 'pointerdown', { ...start, button: 2, pointerId: 23 });
  dispatch(ui.viewport, 'pointermove', { ...moved, pointerId: 23 });
  dispatch(ui.viewport, 'pointerup', { ...moved, button: 2, pointerId: 23 });
  assert.notDeepEqual(ui.controller.viewCamera.target, beforeRightPan, 'right drag from a gizmo handle pans the camera');
});

test('Move with the Face target drops the selection onto the surface under the pointer', testContext => {
  const ui = mountStudio(testContext, { preferences: { snapEnabled: true, snapTarget: 'face' } });
  ui.selectRow('hero');
  ui.controller.updateNodeTransform('hero', { translation: [0, 5, 0] });
  ui.tool('translate').click();
  ui.studio.renderNow();
  const floorPoint = ui.controller.projectWorldPoint([0, 0, -2]);
  dispatch(ui.gizmoPart('screen'), 'pointerdown', ui.clientPoint(ui.controller.gizmoHandles().origin));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(floorPoint));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(floorPoint));
  assert.ok(ui.node('hero').translation[1] < 1.2, `y ${ui.node('hero').translation[1]}`);
  assert.equal(ui.controller.selectedNodeId, 'hero');

  const heroPoint = ui.controller.projectWorldPoint(ui.node('hero').translation);
  dispatch(ui.canvas, 'pointerdown', ui.clientPoint(heroPoint));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(heroPoint));
  assert.equal(ui.controller.selectedNodeId, 'hero');
});

function findFileInput(ui) {
  return ui.root.descendants().find(element => element.type === 'file');
}

function createDesktop(overrides = {}) {
  const calls = [];
  const record = (name, response) => async argument => {
    calls.push({ name, argument });
    return typeof response === 'function' ? response(argument) : response;
  };
  return {
    calls,
    openFile: record('openFile', { text: JSON.stringify(makeRecipe()), filePath: 'C:/scenes/opened.scene.json', fileName: 'opened.scene.json' }),
    saveFile: record('saveFile', argument => ({ filePath: argument.filePath, fileName: 'again.scene.json' })),
    saveFileAs: record('saveFileAs', { filePath: 'C:/scenes/saved.scene.json', fileName: 'saved.scene.json' }),
    savePng: record('savePng', { fileName: 'shot.png' }),
    saveGlb: record('saveGlb', { fileName: 'model.glb' }),
    packWebBundle: record('packWebBundle', { outDir: 'C:/out/web' }),
    ...overrides,
  };
}

function animatedRecipe() {
  return {
    ...makeRecipe(),
    motion: {
      duration: 1.5,
      loop: true,
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
    },
  };
}

test('keyboard shortcuts edit, undo, redo, duplicate and delete from anywhere in the page', testContext => {
  const ui = mountStudio(testContext);
  const press = (key, properties = {}) => dispatch(ui.canvas, 'keydown', { key, ...properties });
  ui.selectRow('hero');

  ui.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  assert.equal(press('z', { ctrlKey: true }).defaultPrevented, true);
  assert.deepEqual(ui.node('hero').translation, [0, 0.5, 0]);
  press('Z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(ui.node('hero').translation, [3, 0.5, 0]);
  press('z', { metaKey: true });
  assert.deepEqual(ui.node('hero').translation, [0, 0.5, 0]);

  press('d', { ctrlKey: true });
  assert.equal(ui.studio.exportRecipe().nodes.length, 4);
  assert.match(ui.status(), /^Duplicated to /);
  const copyId = ui.controller.selectedNodeId;
  assert.notEqual(copyId, 'hero');
  assert.equal(press('Delete').defaultPrevented, true);
  assert.equal(ui.studio.exportRecipe().nodes.some(node => node.id === copyId), false);
  ui.selectRow('orb');
  press('Backspace');
  assert.equal(ui.studio.exportRecipe().nodes.some(node => node.id === 'orb'), false);
  assert.equal(ui.status(), 'Deleted node');

  ui.controller.selectNode(null);
  const nodeCount = ui.studio.exportRecipe().nodes.length;
  press('d', { ctrlKey: true });
  press('Delete');
  assert.equal(ui.studio.exportRecipe().nodes.length, nodeCount);

  ui.selectRow('hero');
  const eyeBefore = ui.controller.scene.camera.eye.slice();
  press('f');
  ui.dom.runAnimationFrames(0);
  ui.dom.runAnimationFrames(500);
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore);
  press('5');
  assert.equal(ui.controller.scene.camera.projection, 'orthographic');
  press('5');
  assert.equal(ui.controller.scene.camera.projection, 'perspective');
  press('z');
  press('?');
  assert.equal(ui.root.querySelectorAll('dialog')[1].open, true);
  assert.equal(press(' ').defaultPrevented, false, 'keys wait while a dialog is open');
  ui.root.querySelectorAll('dialog')[1].close();
  assert.equal(press(' ').defaultPrevented, true);
  assert.equal(ui.status(), 'Add a keyframe first (K)');
});

test('editing the scene camera marks the file as unsaved, but orbiting does not', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.studio.dirty, false);
  ui.controller.orbitCamera({ deltaAzimuth: 0.4 });
  assert.equal(ui.studio.dirty, false, 'orbiting is navigation, not an edit');

  ui.tab('camera').click();
  byDataset(ui.root, 'focal', '85').click();
  assert.equal(ui.studio.dirty, true, 'a lens chip is an edit');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').dataset.dirty, 'true');
});

test('the Field of view row marks the file as unsaved', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  ui.setSlider('Field of view', 70);
  assert.equal(ui.studio.dirty, true);
});

test('a camera view chip marks the file as unsaved', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  byText(ui.root, 'Top').click();
  assert.equal(ui.studio.dirty, true);
});

test('selecting a mesh row after the Sun row leaves the Look tab for the object', testContext => {
  const ui = mountStudio(testContext);
  ui.objectRows().find(row => row.dataset.sceneObject === 'sun').querySelector('.crucible-studio-tree-select').click();
  assert.equal(ui.controller.activeTab, 'look');
  ui.selectRow('hero');
  assert.notEqual(ui.controller.activeTab, 'look');
  assert.equal(ui.panel(ui.controller.activeTab).hasAttribute('hidden'), false);
  assert.equal(ui.tab(ui.controller.activeTab).getAttribute('aria-selected'), 'true');
  assert.equal(ui.label('Assigned material').value, 'paint', 'the Properties card shows the selected object');

  ui.tab('look').click();
  ui.selectRow('orb');
  assert.equal(ui.controller.activeTab, 'look', 'a Look tab opened by hand stays open when a mesh is picked');
});

test('keyboard shortcuts still work while a slider or a switch holds the focus', testContext => {
  const ui = mountStudio(testContext);
  const scrub = ui.label('Timeline scrub');
  dispatch(scrub, 'keydown', { key: 'r' });
  assert.equal(ui.controller.tool, 'rotate', 'a letter is not typed into a slider, so it reaches the tools');
  dispatch(scrub, 'keydown', { key: 'ArrowRight' });
  dispatch(scrub, 'keydown', { key: 'Home' });
  assert.equal(ui.controller.tool, 'rotate', 'the keys that move a slider stay with it');
  const roughness = ui.label('Roughness');
  dispatch(roughness, 'keydown', { key: 's' });
  assert.equal(ui.controller.tool, 'scale');
});

test('Ctrl+C and Ctrl+V copy and paste the selected object as one undo step, even after it is deleted', testContext => {
  const ui = mountStudio(testContext);
  const press = (key, properties = {}) => dispatch(ui.canvas, 'keydown', { key, ...properties });
  ui.selectRow('hero');
  assert.equal(press('c', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(ui.status(), 'Copied');
  assert.equal(ui.studio.exportRecipe().nodes.length, 3, 'copying changes nothing');
  assert.equal(ui.studio.dirty, false);

  ui.selectRow('orb');
  assert.equal(press('v', { metaKey: true }).defaultPrevented, true);
  assert.match(ui.status(), /^Pasted hero copy/);
  assert.equal(ui.studio.exportRecipe().nodes.length, 4);
  const firstCopy = ui.controller.selectedNodeId;
  assert.equal(ui.node(firstCopy).material, 'paint');
  assert.equal(ui.studio.dirty, true);
  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().nodes.length, 3, 'one undo removes the paste');

  press('v', { ctrlKey: true });
  press('v', { ctrlKey: true });
  const [firstPaste, secondPaste] = ui.studio.exportRecipe().nodes.slice(3);
  assert.notDeepEqual(firstPaste.translation, secondPaste.translation, 'each paste lands beside the last');

  ui.selectRow('hero');
  press('Delete');
  assert.equal(ui.node('hero'), undefined);
  press('v', { ctrlKey: true });
  assert.equal(ui.studio.exportRecipe().nodes.length, 4 + 1, 'a paste still works after the original is deleted');

  const editMenu = ui.root.querySelector('#crucible-studio-pop-edit');
  assert.ok(byText(editMenu, 'Copy'));
  assert.ok(byText(editMenu, 'Paste'));
  const labels = ui.root.querySelector('.crucible-studio-shortcuts-dialog').querySelectorAll('.crucible-studio-shortcut-item').map(item => item.textContent);
  assert.ok(labels.includes('CopyCtrl+C'));
  assert.ok(labels.includes('PasteCtrl+V'));
});

test('Ctrl+C and Ctrl+V are left to the browser while typing or while text is selected', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const nameInput = ui.label('Node label');
  assert.equal(dispatch(nameInput, 'keydown', { key: 'c', ctrlKey: true }).defaultPrevented, false);
  assert.equal(dispatch(nameInput, 'keydown', { key: 'v', ctrlKey: true }).defaultPrevented, false);
  assert.equal(ui.controller.canPaste, false);

  ui.dom.document.defaultView.getSelection = () => ({ isCollapsed: false, toString: () => 'some words' });
  assert.equal(dispatch(ui.canvas, 'keydown', { key: 'c', ctrlKey: true }).defaultPrevented, false);
  assert.equal(ui.controller.canPaste, false);
  ui.dom.document.defaultView.getSelection = () => ({ isCollapsed: true, toString: () => '' });
  assert.equal(dispatch(ui.canvas, 'keydown', { key: 'c', ctrlKey: true }).defaultPrevented, true);
  assert.equal(ui.controller.canPaste, true);
});

test('keyboard shortcuts are ignored while typing and after the Studio left the page', testContext => {
  const ui = mountStudio(testContext);
  const nameInput = ui.label('Node label');
  for (const editable of [nameInput, ui.label('Parent node'), ui.root.querySelector('dialog textarea')]) {
    dispatch(editable, 'keydown', { key: 'r' });
    assert.equal(ui.controller.tool, 'translate', editable.tagName);
  }
  const contentEditable = ui.dom.document.createElement('div');
  contentEditable.isContentEditable = true;
  ui.root.append(contentEditable);
  dispatch(contentEditable, 'keydown', { key: 'r' });
  assert.equal(ui.controller.tool, 'translate');
  dispatch(ui.dom.document, 'keydown', { key: 'r' });
  assert.equal(ui.controller.tool, 'rotate');

  ui.root.remove();
  dispatch(ui.dom.document, 'keydown', { key: 'g' });
  assert.equal(ui.controller.tool, 'rotate');
});

test('the space key and K work the timeline from the keyboard', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  dispatch(ui.canvas, 'keydown', { key: 'k' });
  await ui.dom.settle();
  assert.equal(ui.studio.exportRecipe().motion.tracks.length > 0, true);
  dispatch(ui.canvas, 'keydown', { key: ' ' });
  assert.equal(ui.label('Pause (Space)').getAttribute('aria-pressed'), 'true');
  dispatch(ui.canvas, 'keydown', { key: ' ' });
  assert.equal(ui.label('Play (Space)').getAttribute('aria-pressed'), 'false');
});

test('the Recipe JSON dialog shows the recipe, applies edits and reports bad JSON', async testContext => {
  const ui = mountStudio(testContext);
  const [recipeDialog, shortcutsDialog] = ui.root.querySelectorAll('dialog');
  const textarea = recipeDialog.querySelector('textarea');
  ui.button('Recipe JSON').click();
  assert.equal(recipeDialog.open, true);
  assert.deepEqual(JSON.parse(textarea.value), ui.studio.exportRecipe());

  textarea.value = '{ not json';
  byText(recipeDialog, 'Apply JSON').click();
  await ui.dom.settle();
  assert.match(ui.status(), /JSON/);
  assert.equal(recipeDialog.open, true);

  textarea.value = '{}';
  byText(recipeDialog, 'Apply JSON').click();
  await ui.dom.settle();
  assert.equal(recipeDialog.open, true);
  assert.equal(ui.studio.exportRecipe().nodes.length, 3);

  const edited = ui.studio.exportRecipe();
  edited.nodes = edited.nodes.filter(node => node.id !== 'orb');
  textarea.value = JSON.stringify(edited);
  byText(recipeDialog, 'Apply JSON').click();
  await ui.dom.settle();
  assert.equal(ui.status(), 'Recipe applied');
  assert.equal(recipeDialog.open, false);
  assert.equal(recipeDialog.returnValue, '');
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero']);

  ui.button('Recipe JSON').click();
  const fileInput = findFileInput(ui);
  const clicksBefore = fileInput.clicks;
  byText(recipeDialog, 'Load file\u2026').click();
  assert.equal(recipeDialog.open, false);
  assert.equal(fileInput.clicks, clicksBefore + 1);

  byText(ui.root.querySelector('#crucible-studio-pop-help'), 'Keyboard shortcuts').click();
  assert.equal(shortcutsDialog.open, true);
  assert.ok(shortcutsDialog.querySelectorAll('.crucible-studio-shortcut-item').length >= 8);
  shortcutsDialog.close('close');
  assert.equal(shortcutsDialog.returnValue, '');
});

test('Save downloads the recipe in the browser and clears the unsaved mark', async testContext => {
  const changes = [];
  const ui = mountStudio(testContext, { onDirtyChange: change => changes.push(change) });
  assert.deepEqual(changes.at(-1), { filePath: null, fileName: 'untitled.scene.json', dirty: false });
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  assert.equal(changes.at(-1).dirty, true);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  assert.equal(filePill.dataset.dirty, 'true');

  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(ui.status(), 'Downloaded untitled.scene.json');
  assert.equal(filePill.dataset.dirty, 'false');
  assert.equal(changes.at(-1).dirty, false);
  const [download] = ui.dom.document.downloads;
  assert.equal(download.filename, 'untitled.scene.json');
  assert.equal(download.blob.type, 'application/json');
  const saved = JSON.parse(await download.blob.text());
  assert.deepEqual(saved.nodes.find(node => node.id === 'hero').translation, [1, 0.5, 0]);
  assert.equal(ui.dom.runTimers() > 0, true);

  dispatch(ui.canvas, 'keydown', { key: 's', ctrlKey: true });
  await ui.dom.settle();
  dispatch(ui.canvas, 'keydown', { key: 'S', metaKey: true, shiftKey: true });
  await ui.dom.settle();
  byText(ui.root, 'Save as\u2026').click();
  await ui.dom.settle();
  assert.equal(ui.dom.document.downloads.length, 4);
});

const sceneNameEditor = ui => ui.root.querySelector('.crucible-studio-name-editor');

async function renameSceneTo(ui, typedText, key = 'Enter') {
  ui.root.querySelector('.crucible-studio-filepill').click();
  const input = sceneNameEditor(ui).querySelector('input');
  input.value = typedText;
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key });
  await ui.dom.settle();
}

test('a click on the scene name edits its name part in place and keeps the type fixed (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  assert.equal(filePill.getAttribute('aria-label'), 'Rename scene');
  filePill.click();
  assert.notEqual(ui.root.querySelector('#crucible-studio-pop-new').popoverOpen, true, 'the File menu belongs to the File button');
  const editor = sceneNameEditor(ui);
  assert.equal(filePill.dataset.renaming, 'true');
  const input = editor.querySelector('input');
  assert.equal(input.value, 'untitled');
  assert.equal(input.getAttribute('aria-label'), 'Rename scene');
  assert.equal(editor.querySelector('.crucible-studio-name-suffix').textContent, '.scene.json');
  assert.equal(input.selected, true);

  input.value = 'lounge.glb';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  await ui.dom.settle();
  assert.equal(sceneNameEditor(ui), null);
  assert.equal(filePill.textContent, 'lounge.scene.json', 'the typed type is dropped and the original type stays');
  assert.equal(filePill.dataset.dirty, 'false', 'the name is not part of the recipe, so a rename is not a change of the scene');
  assert.equal(ui.status(), 'Renamed. Saved under this name next time.');
  assert.notEqual(ui.root.querySelector('.crucible-studio-status svg'), null, 'the toast starts with a mark');
  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(ui.dom.document.downloads.at(-1).filename, 'lounge.scene.json');
});

test('the scene name editor refuses bad names in place and Escape restores the old name (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  for (const bad of ['', '   ', 'a|b', 'a.', '...', 'CON', 'x'.repeat(121)]) {
    await renameSceneTo(ui, bad);
    const editor = sceneNameEditor(ui);
    assert.notEqual(editor, null, `${JSON.stringify(bad)} keeps the editor open`);
    assert.equal(editor.querySelector('.crucible-studio-name-error').hidden, false);
    assert.equal(filePill.textContent, 'untitled.scene.json');
    dispatch(editor.querySelector('input'), 'keydown', { key: 'Escape' });
    assert.equal(sceneNameEditor(ui), null);
    assert.equal(filePill.textContent, 'untitled.scene.json');
  }
  await renameSceneTo(ui, 'changed', 'Escape');
  assert.equal(filePill.textContent, 'untitled.scene.json', 'Escape cancels a valid name too');
});

test('a click away keeps a valid scene name and drops an invalid one (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  filePill.click();
  let input = sceneNameEditor(ui).querySelector('input');
  input.value = 'half|typed';
  dispatch(input, 'input');
  dispatch(input, 'blur');
  await ui.dom.settle();
  assert.equal(sceneNameEditor(ui), null);
  assert.equal(filePill.textContent, 'untitled.scene.json');
  filePill.click();
  input = sceneNameEditor(ui).querySelector('input');
  input.value = 'kept';
  dispatch(input, 'input');
  dispatch(input, 'blur');
  await ui.dom.settle();
  assert.equal(filePill.textContent, 'kept.scene.json');
});

test('studio shortcuts do not fire while a name is typed (#3344)', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const toolBefore = ui.controller.tool;
  ui.root.querySelector('.crucible-studio-filepill').click();
  const input = sceneNameEditor(ui).querySelector('input');
  for (const key of ['g', 'r', 's', 'x', 'a', 'Delete', 'Backspace']) dispatch(input, 'keydown', { key });
  dispatch(input, 'keydown', { key: 'a', ctrlKey: true });
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['ground', 'hero', 'orb']);
  assert.equal(ui.controller.selectedNodeId, 'hero');
  assert.equal(ui.controller.tool, toolBefore);
});

test('a second rename does not repeat the browser notice and a new file closes an open editor (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  await renameSceneTo(ui, 'first');
  assert.match(ui.status(), /Saved under this name next time/);
  ui.dom.runTimers();
  await renameSceneTo(ui, 'second');
  assert.doesNotMatch(ui.status(), /Saved under this name/);
  ui.root.querySelector('.crucible-studio-filepill').click();
  assert.notEqual(sceneNameEditor(ui), null);
  ui.studio.setFileContext({ filePath: 'C:/scenes/other.scene.json', fileName: 'other.scene.json' });
  assert.equal(sceneNameEditor(ui), null, 'the name never lands on a different file');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'other.scene.json');
});

test('a host that can rename is asked, never overwrites and reports a taken name in place (#3344)', async testContext => {
  const taken = new Set(['C:/scenes/taken.scene.json']);
  const desktop = createDesktop({
    renameScene: async ({ filePath, fileName }) => {
      const target = `C:/scenes/${fileName}`;
      desktop.calls.push({ name: 'renameScene', argument: { filePath, fileName } });
      return taken.has(target) ? { exists: true } : { filePath: target, fileName };
    },
  });
  const ui = mountStudio(testContext, { desktop });
  ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  await renameSceneTo(ui, 'taken');
  const editor = sceneNameEditor(ui);
  assert.notEqual(editor, null, 'the editor stays open');
  assert.equal(editor.querySelector('.crucible-studio-name-error-text').textContent, 'A file with this name already exists');
  assert.equal(filePill.textContent, 'old.scene.json');
  const input = editor.querySelector('input');
  input.value = 'fresh';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  await ui.dom.settle();
  assert.equal(filePill.textContent, 'fresh.scene.json');
  assert.equal(filePill.title, 'C:/scenes/fresh.scene.json');
  assert.deepEqual(desktop.calls.filter(call => call.name === 'renameScene').map(call => call.argument.fileName), ['taken.scene.json', 'fresh.scene.json']);
  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(desktop.calls.at(-1).name, 'saveFile', 'the file already moved, so Save writes to its new path');
  assert.equal(desktop.calls.at(-1).argument.filePath, 'C:/scenes/fresh.scene.json');
});

test('renaming the scene renames its entry in Open recent, and a scene that was never listed stays out of it (#3344)', async testContext => {
  let entries = [{ id: 'h1', name: 'old.scene.json' }];
  const recentScenes = {
    list: async () => entries.map(entry => ({ ...entry })),
    remember: async ({ name }) => {
      entries = [{ id: `h-${name}`, name }, ...entries.filter(entry => entry.name !== name)];
    },
    remove: async id => {
      entries = entries.filter(entry => entry.id !== id);
    },
  };
  const desktop = createDesktop({
    recentScenes,
    renameScene: async ({ fileName }) => ({ filePath: `C:/scenes/${fileName}`, fileName }),
  });
  const ui = mountStudio(testContext, { desktop });
  ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
  await renameSceneTo(ui, 'fresh');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'fresh.scene.json');
  assert.deepEqual(entries.map(entry => entry.name), ['fresh.scene.json'], 'the list shows the new name and no leftover of the old one');

  entries = [{ id: 'h2', name: 'other.scene.json' }];
  await renameSceneTo(ui, 'again');
  assert.deepEqual(entries.map(entry => entry.name), ['other.scene.json'], 'a scene that was not in the list is not added by a rename');
});

test('a host without a rename method sends the next Save through Save as with the new name (#3344)', async testContext => {
  const desktop = createDesktop();
  const ui = mountStudio(testContext, { desktop });
  ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
  await renameSceneTo(ui, 'newer');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'newer.scene.json');
  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(desktop.calls.at(-1).name, 'saveFileAs');
  assert.equal(desktop.calls.at(-1).argument.suggestedName, 'newer.scene.json');
  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(desktop.calls.at(-1).name, 'saveFile', 'after the file exists under the new name, Save is plain again');
});

async function typeInRowEditor(ui, typedText, key = 'Enter') {
  const input = ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor input');
  input.value = typedText;
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key });
  await ui.dom.settle();
}

test('F2 renames the active object in its Scene row; the id stays, labels may repeat, one undo step (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const dirtyBefore = ui.root.querySelector('.crucible-studio-filepill').dataset.dirty;
  assert.equal(dirtyBefore, 'false');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  const input = ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor input');
  assert.equal(input.value, 'hero');
  assert.equal(input.getAttribute('aria-label'), 'Rename hero');
  await typeInRowEditor(ui, '  Hero cube  ');
  assert.equal(ui.node('hero').label, 'Hero cube');
  assert.equal(ui.node('hero').id, 'hero');
  assert.deepEqual(ui.rowLabels(), ['ground', 'Hero cube', 'orb']);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').dataset.dirty, 'true', 'a label is part of the saved recipe');

  ui.selectRow('orb');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  await typeInRowEditor(ui, 'Hero cube');
  assert.deepEqual(ui.rowLabels(), ['ground', 'Hero cube', 'Hero cube'], 'a second object may carry the same label');
  ui.controller.undo();
  assert.deepEqual(ui.rowLabels(), ['ground', 'Hero cube', 'orb'], 'one undo step takes the rename back');
  ui.controller.undo();
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb']);
});

test('in the Scene list a single click only selects, a double click renames, Escape and a bad name keep the old label (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null, 'a single click does not edit');
  ui.rows()[1].querySelector('.crucible-studio-tree-select').dispatchEvent(ui.dom.document.createEvent('dblclick'));
  assert.notEqual(ui.root.querySelector('.crucible-studio-name-editor'), null);
  await typeInRowEditor(ui, 'gone', 'Escape');
  assert.equal(ui.node('hero').label, undefined, 'Escape restores');
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null);

  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  await typeInRowEditor(ui, '   ');
  const editor = ui.root.querySelector('.crucible-studio-name-editor');
  assert.notEqual(editor, null, 'an empty name keeps the editor open');
  assert.equal(editor.querySelector('.crucible-studio-name-error').hidden, false);
  assert.match(editor.querySelector('.crucible-studio-name-error-text').textContent, /Enter a name/);
  dispatch(editor.querySelector('input'), 'blur');
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null);
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb']);

  const properties = ui.label('Node label');
  properties.value = '  ';
  dispatch(properties, 'change');
  assert.equal(ui.node('hero').label, undefined, 'the Properties field refuses an empty name too');
  assert.equal(properties.value, 'hero');
});

test('with several objects selected F2 renames the active one only (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const orbSelect = ui.rows()[2].querySelector('.crucible-studio-tree-select');
  dispatch(orbSelect, 'click', { shiftKey: true });
  assert.deepEqual([...ui.controller.selectedNodeIds].sort(), ['hero', 'orb']);
  const active = ui.controller.selectedNodeId;
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  await typeInRowEditor(ui, 'Only this');
  const renamed = ['hero', 'orb'].filter(id => ui.node(id).label === 'Only this');
  assert.deepEqual(renamed, [active]);
});

test('F2 opens a collapsed or filtered Scene list, and on the camera it says the name is fixed (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('orb');
  ui.studio.setOutlinerCollapsed(true);
  const search = ui.label('Filter the scene list');
  search.value = 'ground';
  dispatch(search, 'input');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  assert.equal(ui.root.dataset.outlinerCollapsed, 'false');
  assert.equal(search.value, '');
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor input').value, 'orb');
  dispatch(ui.root.querySelector('.crucible-studio-name-editor input'), 'keydown', { key: 'Escape' });

  ui.controller.selectSceneObject('camera');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null);
  assert.match(ui.status(), /keep their names/);
});

test('the Edit menu and the right click menu have a Rename row with F2 beside it (#3344)', testContext => {
  const ui = mountStudio(testContext);
  for (const popoverId of ['crucible-studio-pop-edit', 'crucible-studio-pop-object']) {
    const row = byText(ui.root.querySelector(`#${popoverId}`), 'Rename');
    assert.ok(row, popoverId);
    assert.match(row.dataset.shortcut ?? '', /F2/);
  }
});

test('a shot is renamed in place by a double click; a taken name is refused in the field (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.controller.saveBookmark('wide');
  ui.controller.saveBookmark('tall');
  ui.studio.renderNow();
  const listButton = name => ui.root.querySelector('.crucible-studio-bookmark-list').querySelectorAll('button').find(button => button.textContent === name);
  listButton('wide').dispatchEvent(ui.dom.document.createEvent('dblclick'));
  const input = ui.root.querySelector('.crucible-studio-bookmark-list .crucible-studio-name-editor input');
  assert.equal(input.getAttribute('aria-label'), 'Rename shot wide');
  input.value = 'tall';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  await ui.dom.settle();
  assert.match(ui.root.querySelector('.crucible-studio-name-error-text').textContent, /already exists/);
  assert.deepEqual(ui.controller.listBookmarks().map(shot => shot.name), ['wide', 'tall']);
  input.value = 'close up';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  await ui.dom.settle();
  assert.deepEqual(ui.controller.listBookmarks().map(shot => shot.name), ['close-up', 'tall'], 'the shot keeps its place');
  ui.controller.undo();
  assert.deepEqual(ui.controller.listBookmarks().map(shot => shot.name), ['wide', 'tall'], 'one undo step');
});

test('renameBookmark keeps the camera of the shot and refuses unknown, taken and malformed names (#3344)', testContext => {
  const ui = mountStudio(testContext);
  const shot = ui.controller.saveBookmark('wide');
  ui.controller.saveBookmark('tall');
  ui.controller.renameBookmark('wide', 'wide');
  const renamed = ui.controller.renameBookmark('wide', 'establishing');
  assert.deepEqual(renamed.find(candidate => candidate.name === 'establishing').camera, shot.camera);
  assert.throws(() => ui.controller.renameBookmark('establishing', 'tall'), /already exists/);
  assert.throws(() => ui.controller.renameBookmark('missing', 'x'), /Unknown camera bookmark/);
  assert.throws(() => ui.controller.renameBookmark('tall', 'a b'), /1 to 24 letters/);
  assert.throws(() => ui.controller.renameBookmark('tall', 'x'.repeat(25)), /1 to 24 letters/);
});

test('only a known type or the extension the host gave is the fixed type: "Scene 1.5" keeps its dot (#3344)', async testContext => {
  const named = mountStudio(testContext, { fileName: 'Scene 1.5' });
  named.root.querySelector('.crucible-studio-filepill').click();
  assert.equal(sceneNameEditor(named).querySelector('input').value, 'Scene 1.5', 'no file behind the name: the dot belongs to it');
  assert.equal(sceneNameEditor(named).querySelector('.crucible-studio-name-suffix').textContent, '.scene.json');
  dispatch(sceneNameEditor(named).querySelector('input'), 'keydown', { key: 'Escape' });
  const ui = mountStudio(testContext);
  ui.studio.setFileContext({ fileName: 'notes.txt' });
  ui.root.querySelector('.crucible-studio-filepill').click();
  assert.equal(sceneNameEditor(ui).querySelector('input').value, 'notes');
  assert.equal(sceneNameEditor(ui).querySelector('.crucible-studio-name-suffix').textContent, '.txt');
  dispatch(sceneNameEditor(ui).querySelector('input'), 'keydown', { key: 'Escape' });
  await renameSceneTo(ui, 'my.scene');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'my.scene.txt');
});

test('a pending host rename keeps the field, blocks a second rename and is applied when it settles (#3344)', async testContext => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const desktop = createDesktop({ renameScene: () => pending });
  const ui = mountStudio(testContext, { desktop });
  ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  filePill.click();
  const input = sceneNameEditor(ui).querySelector('input');
  input.value = 'fresh';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  assert.equal(input.readOnly, true);
  assert.equal(sceneNameEditor(ui).dataset.busy, 'true');
  dispatch(input, 'keydown', { key: 'Escape' });
  dispatch(input, 'blur');
  ui.selectRow('hero');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  assert.equal(ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor'), null, 'no second rename while one is pending');
  assert.notEqual(sceneNameEditor(ui), null, 'Escape and a click away did not close it');
  settle({ filePath: 'C:/scenes/fresh.scene.json', fileName: 'fresh.scene.json' });
  await ui.dom.settle();
  assert.equal(sceneNameEditor(ui), null);
  assert.equal(filePill.textContent, 'fresh.scene.json');
  assert.equal(filePill.title, 'C:/scenes/fresh.scene.json');
  assert.equal(ui.status(), 'Renamed', 'a host that renamed the file says only that');
});

test('a host that rejects shows a readable error and leaves the old name (#3344)', async testContext => {
  for (const rejection of [null, 'The folder is read-only', new Error('Access denied')]) {
    const desktop = createDesktop({ renameScene: () => Promise.reject(rejection) });
    const ui = mountStudio(testContext, { desktop });
    ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
    await renameSceneTo(ui, 'fresh');
    const shown = sceneNameEditor(ui).querySelector('.crucible-studio-name-error-text').textContent;
    assert.ok(shown.length > 0 && shown !== 'null');
    assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'old.scene.json');
    assert.equal(sceneNameEditor(ui).dataset.busy, 'false');
  }
});

test('a rename finished after another file was opened does not touch that file (#3344)', async testContext => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const desktop = createDesktop({ renameScene: () => pending });
  const ui = mountStudio(testContext, { desktop });
  ui.studio.setFileContext({ filePath: 'C:/scenes/old.scene.json', fileName: 'old.scene.json', dirty: false });
  ui.root.querySelector('.crucible-studio-filepill').click();
  const input = sceneNameEditor(ui).querySelector('input');
  input.value = 'fresh';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  ui.studio.setFileContext({ filePath: 'C:/scenes/other.scene.json', fileName: 'other.scene.json' });
  settle({ filePath: 'C:/scenes/fresh.scene.json', fileName: 'fresh.scene.json' });
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'other.scene.json');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').title, 'C:/scenes/other.scene.json');
});

test('focus returns to the name only after a rename started from the keyboard (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  await renameSceneTo(ui, 'by-mouse');
  assert.equal(ui.dom.document.activeElement === filePill, false, 'a click start leaves no ring on the name');
  dispatch(filePill, 'click', { detail: 0 });
  const input = sceneNameEditor(ui).querySelector('input');
  input.value = 'by-key';
  dispatch(input, 'input');
  dispatch(input, 'keydown', { key: 'Enter' });
  await ui.dom.settle();
  assert.equal(ui.dom.document.activeElement === filePill, true, 'a keyboard start puts focus back on the name');
});

test('a Rename row of the Edit or the right click menu opens the field once the menu has closed (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  for (const popoverId of ['crucible-studio-pop-edit', 'crucible-studio-pop-object']) {
    ui.selectRow('hero');
    const popover = ui.root.querySelector(`#${popoverId}`);
    byText(popover, 'Rename').dispatchEvent(ui.dom.document.createEvent('click', { bubbles: true }));
    assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null, 'not while the menu is still closing');
    ui.dom.runTimers();
    await ui.dom.settle();
    const input = ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor input');
    assert.notEqual(input, null, popoverId);
    assert.equal(ui.dom.document.activeElement === input, true);
    dispatch(input, 'keydown', { key: 'Escape' });
  }
});

test('a Scene row rebuilt under an open field answers it like a click away (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  let input = ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor input');
  input.value = 'Typed';
  dispatch(input, 'input');
  ui.controller.updateNodeTransform('hero', { visible: false });
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null, 'no orphan field');
  assert.equal(ui.node('hero').label, 'Typed', 'a valid name is kept');

  ui.selectRow('orb');
  dispatch(ui.canvas, 'keydown', { key: 'F2' });
  input = ui.root.querySelector('.crucible-studio-tree .crucible-studio-name-editor input');
  input.value = '   ';
  dispatch(input, 'input');
  ui.controller.updateNodeTransform('orb', { visible: false });
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-name-editor'), null);
  assert.equal(ui.node('orb').label, undefined, 'an invalid name is dropped');
});

test('saving, renaming and removing a shot mark the scene as changed, and a double click applies it once (#3344)', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  assert.equal(filePill.dataset.dirty, 'false');
  ui.controller.saveBookmark('wide');
  assert.equal(filePill.dataset.dirty, 'true', 'a saved shot is part of the recipe');
  ui.studio.setFileContext({ dirty: false });
  ui.controller.renameBookmark('wide', 'tall');
  assert.equal(filePill.dataset.dirty, 'true', 'a renamed shot too');
  ui.studio.setFileContext({ dirty: false });
  ui.controller.removeBookmark('tall');
  assert.equal(filePill.dataset.dirty, 'true', 'and a removed one');

  ui.controller.saveBookmark('wide');
  ui.studio.renderNow();
  const button = ui.root.querySelector('.crucible-studio-bookmark-list').querySelectorAll('button').find(candidate => candidate.textContent === 'wide');
  const shotEye = ui.controller.listBookmarks()[0].camera.eye.slice();
  ui.controller.updateCamera({ eye: [1, 2, 3] });
  dispatch(button, 'click', { detail: 1 });
  assert.deepEqual(ui.controller.scene.camera.eye, shotEye, 'the first click applies the shot');
  ui.controller.updateCamera({ eye: [1, 2, 3] });
  dispatch(button, 'click', { detail: 2 });
  button.dispatchEvent(ui.dom.document.createEvent('dblclick'));
  assert.deepEqual(ui.controller.scene.camera.eye, [1, 2, 3], 'the second click of a double click does not apply it again');
  assert.notEqual(ui.root.querySelector('.crucible-studio-bookmark-list .crucible-studio-name-editor'), null);
});

test('no element reads a data-tight attribute any more (#3344)', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.root.dataset.tight, undefined);
  assert.doesNotMatch(STUDIO_CSS, /data-tight/);
});

test('Save, Save as and Open go through the desktop shell when there is one', async testContext => {
  const desktop = createDesktop();
  const changes = [];
  const ui = mountStudio(testContext, { desktop, onDirtyChange: change => changes.push(change) });
  assert.equal(ui.root.dataset.desktop, 'true');
  const watchPill = ui.root.querySelector('.crucible-studio-watch-pill');
  assert.equal(watchPill.hidden, true);

  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(desktop.calls[0].name, 'saveFileAs');
  assert.equal(desktop.calls[0].argument.suggestedName, 'untitled.scene.json');
  assert.deepEqual(JSON.parse(desktop.calls[0].argument.text), ui.studio.exportRecipe());
  assert.equal(ui.status(), 'Saved saved.scene.json');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'saved.scene.json');
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').title, 'C:/scenes/saved.scene.json');
  assert.equal(watchPill.hidden, false);
  assert.deepEqual(changes.at(-1), { filePath: 'C:/scenes/saved.scene.json', fileName: 'saved.scene.json', dirty: false });
  assert.match(ui.root.querySelector('#crucible-studio-pop-sync .crucible-studio-popover-note').textContent, /Watching C:\/scenes\/saved.scene.json \(auto-reload on\)\./);

  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(desktop.calls[1].name, 'saveFile');
  assert.equal(desktop.calls[1].argument.filePath, 'C:/scenes/saved.scene.json');
  byText(ui.root, 'Save as\u2026').click();
  await ui.dom.settle();
  assert.equal(desktop.calls[2].name, 'saveFileAs');

  desktop.saveFileAs = async () => ({ canceled: true });
  desktop.saveFile = async () => null;
  const nameBeforeCancel = ui.root.querySelector('.crucible-studio-filepill').textContent;
  byText(ui.root, 'Save as\u2026').click();
  await ui.dom.settle();
  byText(ui.root.querySelector('#crucible-studio-pop-new'), 'Save').click();
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, nameBeforeCancel);

  desktop.openFile = async () => ({ canceled: true });
  byText(ui.root, 'Open\u2026').click();
  await ui.dom.settle();
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, nameBeforeCancel);
  desktop.openFile = async () => null;
  byText(ui.root, 'Open\u2026').click();
  await ui.dom.settle();
  desktop.openFile = async () => ({ text: '{ broken', filePath: 'C:/bad.json', fileName: 'bad.json' });
  byText(ui.root, 'Open\u2026').click();
  await ui.dom.settle();
  assert.match(ui.status(), /JSON/);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, nameBeforeCancel);

  const opened = animatedRecipe();
  opened.nodes = opened.nodes.slice(0, 2);
  desktop.openFile = async () => ({ text: JSON.stringify(opened), filePath: 'C:/scenes/opened.scene.json', fileName: 'opened.scene.json' });
  dispatch(ui.canvas, 'keydown', { key: 'o', ctrlKey: true });
  await ui.dom.settle();
  assert.equal(ui.status(), 'Opened opened.scene.json');
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero']);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'opened.scene.json');
});

test('Open without a desktop shell uses the file picker, and a dropped file loads too', async testContext => {
  const ui = mountStudio(testContext);
  const fileInput = findFileInput(ui);
  byText(ui.root, 'Open\u2026').click();
  assert.equal(fileInput.clicks, 1);

  dispatch(fileInput, 'change');
  await ui.dom.settle();
  assert.equal(ui.status(), '');

  const smaller = makeRecipe();
  smaller.nodes = smaller.nodes.slice(0, 1);
  fileInput.files = [{ name: 'small.scene.json', text: async () => JSON.stringify(smaller) }];
  dispatch(fileInput, 'change');
  await ui.dom.settle();
  assert.equal(ui.status(), 'Loaded small.scene.json');
  assert.equal(fileInput.value, '');
  assert.deepEqual(ui.rowLabels(), ['ground']);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'small.scene.json');

  fileInput.files = [{ name: 'broken.json', text: async () => 'nope' }];
  dispatch(fileInput, 'change');
  await ui.dom.settle();
  assert.match(ui.status(), /JSON/);
  assert.deepEqual(ui.rowLabels(), ['ground']);

  const dragOver = dispatch(ui.viewport, 'dragover');
  assert.equal(dragOver.defaultPrevented, true);
  assert.equal(ui.viewport.dataset.dropActive, 'true');
  dispatch(ui.viewport, 'dragleave');
  assert.equal(ui.viewport.dataset.dropActive, undefined);
  dispatch(ui.viewport, 'drop', { dataTransfer: { files: [] } });
  dispatch(ui.viewport, 'drop', {});
  await ui.dom.settle();
  assert.deepEqual(ui.rowLabels(), ['ground']);
  dispatch(ui.viewport, 'drop', { dataTransfer: { files: [{ name: 'dropped.scene.json', path: 'C:/drop/dropped.scene.json', text: async () => JSON.stringify(makeRecipe()) }] } });
  await ui.dom.settle();
  assert.equal(ui.status(), 'Loaded dropped.scene.json');
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero', 'orb']);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').title, 'C:/drop/dropped.scene.json');
  dispatch(ui.viewport, 'dragover');
  dispatch(ui.viewport, 'drop', { dataTransfer: { files: [{ name: 'bad.json', text: async () => '[' }] } });
  await ui.dom.settle();
  assert.match(ui.status(), /JSON|Unexpected/);
  assert.equal(ui.viewport.dataset.dropActive, undefined);
});

test('file context set from outside shows in the file pill and the watch note', testContext => {
  const changes = [];
  const ui = mountStudio(testContext, { watchedPath: 'C:/agent/live.scene.json', fileName: 'live.scene.json', onDirtyChange: change => changes.push(change) });
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  assert.equal(ui.root.querySelector('.crucible-studio-watch-pill').hidden, false);
  assert.equal(filePill.title, 'C:/agent/live.scene.json');
  assert.equal(ui.studio.shouldAutoReloadExternal(), true);

  ui.studio.setFileContext({ fileName: 'renamed.scene.json', dirty: true });
  assert.equal(filePill.textContent, 'renamed.scene.json');
  assert.equal(filePill.dataset.dirty, 'true');
  assert.equal(ui.studio.dirty, true);
  ui.studio.setFileContext({ filePath: null, dirty: false });
  assert.equal(ui.root.querySelector('.crucible-studio-watch-pill').hidden, true);
  assert.equal(changes.at(-1).dirty, false);
  ui.studio.setFileContext({});
  assert.equal(filePill.textContent, 'renamed.scene.json');

  ui.studio.setFileContext({ filePath: 'C:/agent/live.scene.json' });
  const reloadButton = byText(ui.root, 'Reload when the agent edits');
  reloadButton.click();
  assert.equal(ui.studio.shouldAutoReloadExternal(), false);
  assert.equal(reloadButton.getAttribute('aria-pressed'), 'false');
  assert.equal(ui.status(), 'Auto-reload paused');
  assert.match(ui.root.querySelector('#crucible-studio-pop-sync .crucible-studio-popover-note').textContent, /paused/);
  reloadButton.click();
  assert.equal(ui.studio.shouldAutoReloadExternal(), true);
  assert.equal(ui.status(), 'Auto-reload enabled');
});

test('loadExternalTextFile loads a recipe with or without an undo step and rejects bad text', async testContext => {
  const ui = mountStudio(testContext);
  const smaller = makeRecipe();
  smaller.nodes = smaller.nodes.slice(0, 2);
  await ui.studio.loadExternalTextFile(JSON.stringify(smaller), { filePath: 'C:/x.json', fileName: 'x.json', recordUndo: false });
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero']);
  assert.equal(ui.controller.canUndo, false);
  assert.equal(ui.studio.dirty, false);
  await ui.studio.loadExternalTextFile(JSON.stringify(makeRecipe()));
  assert.equal(ui.controller.canUndo, true);
  assert.equal(ui.root.querySelector('.crucible-studio-filepill').textContent, 'scene.json');
  await assert.rejects(() => ui.studio.loadExternalTextFile('{'), SyntaxError);
  ui.studio.loadRecipe(smaller);
  assert.deepEqual(ui.rowLabels(), ['ground', 'hero']);
});

test('the New scene menu replaces the scene with a template and resets the file', async testContext => {
  const ui = mountStudio(testContext);
  const filePill = ui.root.querySelector('.crucible-studio-filepill');
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  assert.equal(ui.studio.dirty, true);
  const templateKey = 'courtyard';
  const spec = STUDIO_TEMPLATES[templateKey];
  filePill.click();
  const newPopover = ui.root.querySelector('#crucible-studio-pop-new');
  byText(newPopover, 'New scene…').click();
  await ui.dom.settle();
  assert.equal(newPopover.popoverOpen, false);
  byText(ui.root, spec.label).parentNode.click();
  await ui.dom.settle();
  byText(ui.root.querySelector('.crucible-studio-confirm-dialog'), 'Discard').click();
  await ui.dom.settle();
  assert.equal(filePill.textContent, `${templateKey}.scene.json`);
  assert.equal(filePill.dataset.dirty, 'false');
  assert.equal(ui.status(), `New ${spec.label}`);
  assert.equal(ui.studio.exportRecipe().nodes.some(node => node.id === 'hero'), false);
});

test('Copy a prompt for the agent uses the clipboard and falls back to the recipe dialog', async testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('orb');
  byText(ui.root, 'Copy a prompt for the agent').click();
  await ui.dom.settle();
  assert.equal(ui.dom.clipboardTexts.length, 1);
  assert.match(ui.dom.clipboardTexts[0], /Edit Crucible scene "untitled.scene.json" \(format crucible.scene v1, currently at revision \d+, selected node: orb\)/);
  assert.equal(ui.status(), 'Copied AI prompt to clipboard');
  assert.equal(ui.root.querySelector('#crucible-studio-pop-sync').popoverOpen, false);

  const blockedUi = mountStudio(testContext, { domOptions: { clipboardFails: true }, watchedPath: 'C:/live.scene.json' });
  byText(blockedUi.root, 'Copy a prompt for the agent').click();
  await blockedUi.dom.settle();
  const dialog = blockedUi.root.querySelector('dialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.querySelector('textarea').value, /Edit Crucible scene "C:\/live.scene.json"/);
});

test('Export saves a PNG still in the browser and through the desktop shell', async testContext => {
  const ui = mountStudio(testContext, { fileName: 'castle.scene.json' });
  const renderCountBefore = ui.renderer.frames.length;
  byText(ui.root, 'Save PNG').click();
  await ui.dom.settle();
  assert.equal(ui.canvas.lastDataUrlType, 'image/png');
  assert.ok(ui.renderer.frames.length > renderCountBefore, 'a still renders a fresh frame first');
  const [download] = ui.dom.document.downloads;
  assert.equal(download.filename, 'castle.png');
  assert.equal(download.blob.type, 'image/png');
  const bytes = new Uint8Array(await download.blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(ui.status(), 'Saved PNG still');

  const desktop = createDesktop();
  const desktopUi = mountStudio(testContext, { sharedDom: ui.dom, desktop, fileName: 'castle.scene.json' });
  byText(desktopUi.root, 'Save PNG').click();
  await desktopUi.dom.settle();
  assert.equal(desktop.calls[0].name, 'savePng');
  assert.equal(desktop.calls[0].argument.suggestedName, 'castle.png');
  assert.match(desktop.calls[0].argument.dataUrl, /^data:image\/png;base64,/);
  assert.equal(desktopUi.status(), 'Saved shot.png');
  desktop.savePng = async () => ({ canceled: true });
  desktopUi.dom.runTimers();
  byText(desktopUi.root, 'Save PNG').click();
  await desktopUi.dom.settle();
  assert.equal(desktopUi.status(), '');
});

test('Export writes a GLB model of the scene and reports a desktop failure', async testContext => {
  const ui = mountStudio(testContext);
  byText(ui.root, 'Save GLB').click();
  await ui.dom.settle();
  const [download] = ui.dom.document.downloads;
  assert.equal(download.filename, 'untitled.glb');
  assert.equal(download.blob.type, 'model/gltf-binary');
  const bytes = new Uint8Array(await download.blob.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'glTF');
  assert.equal(ui.status(), 'Exported GLB mesh');
  assert.equal(ui.studio.exportGlbBytes().byteLength, bytes.byteLength);

  const desktop = createDesktop();
  const desktopUi = mountStudio(testContext, { sharedDom: ui.dom, desktop });
  byText(desktopUi.root, 'Save GLB').click();
  await desktopUi.dom.settle();
  assert.equal(desktop.calls[0].name, 'saveGlb');
  assert.equal(desktop.calls[0].argument.suggestedName, 'untitled.glb');
  assert.equal(String.fromCharCode(...new Uint8Array(desktop.calls[0].argument.bytes).slice(0, 4)), 'glTF');
  assert.equal(desktopUi.status(), 'Exported model.glb');
  desktop.saveGlb = async () => {
    throw new Error('Disk is full.');
  };
  byText(desktopUi.root, 'Save GLB').click();
  await desktopUi.dom.settle();
  assert.equal(desktopUi.status(), 'Disk is full.');
  desktop.saveGlb = async () => ({ canceled: true });
  desktopUi.dom.runTimers();
  byText(desktopUi.root, 'Save GLB').click();
  await desktopUi.dom.settle();
  assert.equal(desktopUi.status(), '');
});

test('Export packs a web bundle, naming what a still pack leaves out', async testContext => {
  const ui = mountStudio(testContext, { recipe: animatedRecipe() });
  byText(ui.root, 'Save pack').click();
  await ui.dom.settle();
  const [download] = ui.dom.document.downloads;
  assert.equal(download.filename, 'untitled.pack');
  assert.equal(download.blob.type, 'application/octet-stream');
  assert.ok(download.blob.size > 100);
  assert.equal(ui.status(), 'Downloaded scene.pack');

  const payload = await ui.studio.buildWebPackPayload();
  assert.equal(payload.title, 'untitled');
  assert.deepEqual(payload.stripped, ['motion']);
  assert.match(payload.posterDataUrl, /^data:image\/png/);
  assert.ok(payload.packBytes.byteLength > 100);

  const desktop = createDesktop();
  const desktopUi = mountStudio(testContext, { sharedDom: ui.dom, desktop, recipe: animatedRecipe(), fileName: 'castle.scene.json' });
  byText(desktopUi.root, 'Save pack').click();
  await desktopUi.dom.settle();
  assert.equal(desktop.calls[0].name, 'packWebBundle');
  assert.equal(desktop.calls[0].argument.title, 'castle');
  assert.equal(desktopUi.status(), 'Packed web bundle to C:/out/web (static snapshot, omitted motion)');
  desktop.packWebBundle = async () => ({ canceled: true });
  desktopUi.dom.runTimers();
  byText(desktopUi.root, 'Save pack').click();
  await desktopUi.dom.settle();
  assert.equal(desktopUi.status(), '');
  desktop.packWebBundle = async () => {
    throw new Error('Out folder is not writable.');
  };
  byText(desktopUi.root, 'Save pack').click();
  await desktopUi.dom.settle();
  assert.equal(desktopUi.status(), 'Out folder is not writable.');

  const plainUi = mountStudio(testContext, { sharedDom: ui.dom });
  const plainPayload = await plainUi.studio.buildWebPackPayload();
  assert.deepEqual(plainPayload.stripped, []);
  const plainDesktop = createDesktop();
  const plainDesktopUi = mountStudio(testContext, { sharedDom: ui.dom, desktop: plainDesktop });
  byText(plainDesktopUi.root, 'Save pack').click();
  await plainDesktopUi.dom.settle();
  assert.equal(plainDesktopUi.status(), 'Packed web bundle to C:/out/web');
});

test('a narrow container starts with the panels closed and opens them when it grows', testContext => {
  const ui = mountStudio(testContext, { containerWidth: 600 });
  const toggleDocks = ui.label('Show or hide the panels');
  assert.equal(ui.root.dataset.compact, 'true');
  assert.equal(ui.root.dataset.outlinerCollapsed, 'true');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true');
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'false');

  toggleDocks.click();
  assert.equal(ui.root.dataset.outlinerCollapsed, 'false');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'false');
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'true');
  toggleDocks.click();
  assert.equal(ui.root.dataset.outlinerCollapsed, 'true');
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'false');

  ui.dom.container.clientWidth = 1200;
  ui.dom.observers.resize[0].callback([]);
  assert.equal(ui.root.dataset.compact, 'false');
  assert.equal(ui.root.dataset.outlinerCollapsed, 'false');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'false');
  ui.dom.observers.resize[0].callback([]);
  assert.equal(ui.root.dataset.compact, 'false');

  ui.studio.setOutlinerCollapsed(true);
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'true');
  ui.studio.setInspectorCollapsed(true);
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'false');
  ui.studio.setOutlinerCollapsed(false);
  assert.equal(toggleDocks.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true');
});

test('drawing pauses while the Studio is off screen or the tab is hidden, and resumes after', testContext => {
  const ui = mountStudio(testContext);
  const observer = ui.dom.observers.intersection[0];
  ui.dom.runAnimationFrames(1);
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);
  ui.selectRow('hero');
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);
  const framesBefore = ui.renderer.frames.length;
  observer.callback([{ isIntersecting: false }]);
  ui.dom.runAnimationFrames(2);
  assert.equal(ui.renderer.frames.length, framesBefore, 'a queued frame is dropped once the view is off screen');
  ui.selectRow('orb');
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);
  observer.callback([{ isIntersecting: true }]);
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);
  ui.dom.runAnimationFrames(3);
  assert.equal(ui.renderer.frames.length, framesBefore + 1);

  ui.dom.document.hidden = true;
  ui.selectRow('hero');
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);
  dispatch(ui.dom.document, 'visibilitychange');
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);
  ui.dom.document.hidden = false;
  dispatch(ui.dom.document, 'visibilitychange');
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);
  ui.dom.document.hidden = true;
  ui.dom.runAnimationFrames(4);
  assert.equal(ui.renderer.frames.length, framesBefore + 1);
});

test('the viewport follows its element size, and the renderer is kept in step with the scene', testContext => {
  const ui = mountStudio(testContext);
  ui.viewport.box = { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 };
  ui.studio.renderNow();
  assert.equal(ui.controller.viewportWidth, 640);
  assert.equal(ui.controller.viewportHeight, 360);
  assert.equal(ui.gizmo.getAttribute('viewBox'), '0 0 640 360');

  const callsBefore = ui.renderer.calls.length;
  ui.controller.addPrimitive('box');
  ui.studio.renderNow();
  assert.ok(ui.renderer.calls.slice(callsBefore).includes('replaceParts'));
  assert.equal(ui.renderer.partCount, ui.controller.scene.parts.length + GRID_LINE_COUNT);
  assert.ok(ui.renderer.shadowBounds);
  assert.equal(ui.renderer.shadowsDirty, true);
  assert.equal(ui.renderer.world, ui.controller.scene.environment.world);
  const frame = ui.renderer.frames.at(-1);
  assert.deepEqual(frame.eye, ui.controller.scene.camera.eye);
  assert.deepEqual(frame.effects, ui.controller.scene.effects);

  ui.renderer.updateFailure = new Error('The GPU was lost.');
  assert.throws(() => ui.studio.renderNow(), /The GPU was lost\./);
  ui.renderer.updateFailure = null;
  ui.studio.renderNow();
  assert.ok(ui.studio.capturePngDataUrl().startsWith('data:image/png'));
});

test('F flies the camera to the selection in under half a second, without an undo step, and a wheel turn stops it', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.controller.orbitCamera({ zoomScale: 6 });
  const start = ui.controller.scene.camera.eye.slice();
  const goal = ui.controller.frameSelectionPose();
  const undoBefore = ui.controller.canUndo;
  const distanceToGoal = () => Math.hypot(...ui.controller.scene.camera.eye.map((value, axis) => value - goal.eye[axis]));
  dispatch(ui.dom.document, 'keydown', { key: 'f' });
  assert.deepEqual(ui.controller.scene.camera.eye, start, 'nothing moves before the first frame');
  ui.dom.runAnimationFrames(1000);
  ui.dom.runAnimationFrames(1100);
  const midway = distanceToGoal();
  assert.ok(midway > 0.01 && midway < Math.hypot(...start.map((value, axis) => value - goal.eye[axis])), 'part of the way there after 100 ms');
  ui.dom.runAnimationFrames(1490);
  assert.ok(distanceToGoal() < 1e-6, 'there before half a second has passed');
  assert.deepEqual(ui.controller.scene.camera.target, goal.target);
  assert.equal(ui.controller.canUndo, undoBefore, 'a flight is a view change, not an edit');

  ui.controller.orbitCamera({ zoomScale: 6 });
  dispatch(ui.dom.document, 'keydown', { key: 'f' });
  ui.dom.runAnimationFrames(2000);
  ui.dom.runAnimationFrames(2100);
  dispatch(ui.canvas, 'wheel', { deltaY: 100 });
  const stopped = ui.controller.scene.camera.eye.slice();
  ui.dom.runAnimationFrames(2400);
  assert.deepEqual(ui.controller.scene.camera.eye, stopped, 'the wheel takes the camera back');

  ui.dom.document.defaultView.matchMedia = () => ({ matches: true });
  dispatch(ui.dom.document, 'keydown', { key: 'f' });
  assert.ok(distanceToGoal() < 1e-6, 'with reduced motion the view jumps');
});

test('the viewport still draws the floor and the scene when the camera is as far out as it goes', testContext => {
  const ui = mountStudio(testContext);
  for (let turn = 0; turn < 12; turn += 1) {
    ui.controller.orbitCamera({ zoomScale: 3 });
  }
  ui.studio.renderNow();
  const camera = ui.controller.scene.camera;
  const distance = Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis]));
  const frame = ui.renderer.frames.at(-1);
  assert.ok(distance > 300, 'the camera is far past the 120 m the scene camera reaches');
  assert.ok(frame.far > distance * 10, 'the frame reaches far behind the scene, so nothing is cut away');
  assert.ok(frame.near < distance / 10);
  ui.selectRow('hero');
  assert.ok(ui.controller.selectionOutline(), 'and the selection can still be outlined from there');
  assert.ok(ui.controller.projectWorldPoint([0, 0.5, 0]).visible);
});

test('the readout names the grid step, which grows as the camera pulls back', testContext => {
  const ui = mountStudio(testContext);
  const readout = ui.dom.document.querySelector('.crucible-studio-readout');
  assert.match(readout.textContent, /Grid 1 m/);
  ui.controller.orbitCamera({ zoomScale: 12 });
  ui.studio.renderNow();
  assert.match(readout.textContent, /Grid 10 m/);
});

test('dispose removes the Studio and every listener it added to the page', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.label('Frame in view (F)').click();
  assert.equal(ui.dom.pendingAnimationFrameCount, 2, 'the next draw and the flight to the framed object');
  assert.equal(ui.dom.pendingTimerCount > 0, true);
  const keydownListeners = ui.dom.document.listeners.filter(entry => entry.type === 'keydown').length;
  assert.equal(keydownListeners, 1);

  ui.studio.dispose();
  assert.equal(ui.dom.container.children.length, 0);
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);
  assert.equal(ui.dom.pendingTimerCount, 0);
  assert.equal(ui.dom.document.listeners.filter(entry => entry.type === 'keydown' || entry.type === 'visibilitychange').length, 0);
  assert.equal(ui.dom.observers.resize[0].disconnected, true);
  assert.equal(ui.dom.observers.intersection[0].disconnected, true);
  assert.equal(ui.renderer.disposed, true);
  dispatch(ui.dom.document, 'keydown', { key: 'r' });
  assert.equal(ui.controller.tool, 'translate');
});

test('a reload of the watched file walks a named agent cursor over the objects it changed', async testContext => {
  const ui = mountStudio(testContext, { watchedPath: 'C:/agent/live.scene.json', agentName: 'Claude' });
  const cursor = ui.viewport.querySelector('.crucible-studio-agent-cursor');
  const outlines = () => ui.gizmo.descendants().filter(element => element.getAttribute('class') === 'crucible-studio-agent-outline');
  assert.equal(cursor.hidden, true);
  const edited = makeRecipe();
  edited.nodes[1].translation = [-1.5, 0.5, 0];
  edited.nodes[2].scale = [0.8, 0.8, 0.8];
  await ui.studio.loadExternalTextFile(JSON.stringify(edited), { filePath: 'C:/agent/live.scene.json', fileName: 'live.scene.json', recordUndo: false });
  assert.equal(cursor.hidden, false);
  assert.equal(cursor.querySelector('.crucible-studio-agent-name').textContent, 'Claude');
  assert.equal(cursor.dataset.nodeId, 'hero');
  assert.equal(ui.status(), 'Claude edited hero, orb');
  ui.studio.renderNow();
  assert.equal(outlines().length, 1);
  const heroLeft = Number.parseFloat(cursor.style.getPropertyValue('--studio-agent-x'));
  const halfWidth = ui.controller.viewportWidth / 2;
  assert.ok(heroLeft > 0 && heroLeft < halfWidth, `the cursor sits on the hero, left of centre: ${heroLeft}px`);
  ui.dom.runTimers();
  assert.equal(cursor.dataset.nodeId, 'orb');
  assert.ok(Number.parseFloat(cursor.style.getPropertyValue('--studio-agent-x')) > halfWidth, 'the cursor moved to the orb');
  ui.dom.runTimers();
  assert.equal(cursor.hidden, true);
  ui.studio.renderNow();
  assert.equal(outlines().length, 0);
});

test('the agent cursor stays away for a file the person opens and takes a name per edit', async testContext => {
  const ui = mountStudio(testContext, { watchedPath: 'C:/agent/live.scene.json' });
  const cursor = ui.viewport.querySelector('.crucible-studio-agent-cursor');
  const edited = makeRecipe();
  edited.nodes[1].translation = [1, 0.5, 0];
  await ui.studio.loadExternalTextFile(JSON.stringify(edited), { filePath: 'C:/other.scene.json', fileName: 'other.scene.json' });
  assert.equal(cursor.hidden, true);
  await ui.studio.loadExternalTextFile(JSON.stringify(makeRecipe()), { filePath: 'C:/other.scene.json', agent: { name: 'Builder' } });
  assert.equal(cursor.hidden, false);
  assert.equal(cursor.querySelector('.crucible-studio-agent-name').textContent, 'Builder');
  const builderColor = cursor.style.color;
  assert.equal(cursor.querySelector('.crucible-studio-agent-name').style.background, builderColor);
  ui.studio.renderNow();
  assert.equal(ui.gizmo.descendants().find(element => element.getAttribute('class') === 'crucible-studio-agent-outline').getAttribute('stroke'), builderColor);
  ui.studio.showAgentEdit({ name: 'Claude', nodeIds: ['orb'] });
  assert.notEqual(cursor.style.color, builderColor, 'another agent gets another colour');
  await ui.studio.loadExternalTextFile(JSON.stringify(edited), { filePath: 'C:/other.scene.json', agent: false });
  assert.equal(cursor.hidden, true);
  const relit = makeRecipe();
  relit.nodes = edited.nodes;
  relit.environment.setup = 'sunset';
  await ui.studio.loadExternalTextFile(JSON.stringify(relit), { agent: true });
  assert.equal(cursor.hidden, true);
  assert.equal(ui.status(), 'Agent changed the scene look');
});

test('showAgentEdit points at named objects, skips unknown ones and rejects bad input', testContext => {
  const ui = mountStudio(testContext);
  const cursor = ui.viewport.querySelector('.crucible-studio-agent-cursor');
  ui.studio.showAgentEdit({ name: 'Claude', nodeIds: ['missing', 'orb'] });
  assert.equal(cursor.dataset.nodeId, 'orb');
  assert.equal(ui.status(), 'Claude edited missing, orb');
  const before = cursor.style.getPropertyValue('--studio-agent-x');
  ui.controller.orbitCamera({ deltaAzimuth: 0.6 });
  ui.studio.renderNow();
  assert.notEqual(cursor.style.getPropertyValue('--studio-agent-x'), before, 'the cursor follows its object when the camera moves');
  ui.studio.showAgentEdit({ nodeIds: [] });
  assert.equal(cursor.hidden, true);
  assert.throws(() => ui.studio.showAgentEdit({ name: '', nodeIds: [] }), /agent name must be a string/);
  assert.throws(() => ui.studio.showAgentEdit({ nodeIds: [7] }), /nodeIds must be an array of node id strings/);
  assert.throws(() => ui.studio.showAgentEdit({ nodeIds: 'orb' }), /nodeIds must be an array of node id strings/);
  assert.throws(() => ui.controller.nodeOutline(''), /nodeOutline requires a node id string/);
  assert.throws(() => mountStudio(testContext, { sharedDom: ui.dom, agentName: '' }), /agent name must be a string/);
});

test('the ground grid is drawn with the scene, leaves with its button and stays out of a captured still', testContext => {
  const ui = mountStudio(testContext);
  const sceneParts = ui.controller.scene.parts.length;
  const gridButton = ui.label('Show or hide the grid');
  const readout = ui.viewport.querySelector('.crucible-studio-readout');
  assert.equal(ui.studio.gridVisible, true);
  assert.equal(gridButton.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT);
  assert.match(readout.textContent, /Grid 1 m/);

  ui.studio.capturePngDataUrl();
  assert.equal(ui.renderer.partCount, sceneParts, 'a still shows the scene alone');
  ui.studio.renderNow();
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT);

  gridButton.click();
  ui.studio.renderNow();
  assert.equal(ui.studio.gridVisible, false);
  assert.equal(gridButton.getAttribute('aria-pressed'), 'false');
  assert.equal(ui.renderer.partCount, sceneParts);
  assert.doesNotMatch(readout.textContent, /Grid/);
  ui.studio.setGridVisible(true);
  ui.studio.renderNow();
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT);
});

test('the view widget follows the camera and its ends snap to the main views', testContext => {
  const ui = mountStudio(testContext);
  const widget = ui.viewport.querySelector('.crucible-studio-view-widget');
  const end = name => widget.descendants().find(element => element.getAttribute('data-axis-end') === name);
  const letters = widget.descendants().filter(element => element.getAttribute('class') === 'crucible-studio-view-letter').map(element => element.textContent);
  assert.deepEqual(letters.sort(), ['X', 'Y', 'Z']);
  assert.equal(end('-y').getAttribute('data-view'), null, 'there is no view from below');
  const xBefore = end('+x').getAttribute('cx');
  ui.controller.orbitCamera({ deltaAzimuth: 0.7 });
  ui.studio.renderNow();
  assert.notEqual(end('+x').getAttribute('cx'), xBefore);

  end('+y').click();
  ui.studio.renderNow();
  const camera = ui.controller.scene.camera;
  assert.ok(camera.eye[1] - camera.target[1] > 1, 'the camera looks down from above');
  assert.ok(Math.abs(camera.eye[0] - camera.target[0]) < 0.1);
  end('+x').click();
  ui.studio.renderNow();
  assert.ok(ui.controller.scene.camera.eye[0] - ui.controller.scene.camera.target[0] > 1, 'the camera looks from the right');
});

test('the readout names the camera and gives the size of the selection in metres', testContext => {
  const ui = mountStudio(testContext);
  const selection = ui.viewport.querySelector('.crucible-studio-readout-selection');
  const readout = ui.viewport.querySelector('.crucible-studio-readout');
  assert.match(readout.textContent, /^Perspective · \d+ ?(mm|°)/u);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  assert.match(selection.textContent, /^hero · \d+\.\d\d × \d+\.\d\d × \d+\.\d\d m$/u);
  const bounds = ui.controller.nodeBounds('hero');
  assert.deepEqual(bounds.size.map(value => Number(value.toFixed(4))), bounds.max.map((value, axis) => Number((value - bounds.min[axis]).toFixed(4))));
  const sizeText = selection.textContent;
  ui.controller.updateNodeTransform('hero', { scale: [2, 2, 2] });
  ui.studio.renderNow();
  assert.ok(ui.controller.nodeBounds('hero').size[0] > bounds.size[0] * 1.9, 'the size follows the scale');
  assert.notEqual(selection.textContent, sizeText);
  ui.controller.selectNode(null);
  ui.studio.renderNow();
  assert.equal(selection.textContent, '');
  assert.equal(ui.controller.nodeBounds('missing'), null);
  assert.throws(() => ui.controller.nodeBounds(''), /nodeBounds requires a node id string/);
  ui.controller.toggleCameraProjection();
  ui.studio.renderNow();
  assert.match(readout.textContent, /^Orthographic/u);
});

test('move handles end in arrows, scale handles in squares and an axis that faces the viewer falls back to a dot', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('hero');
  const shapes = () => ui.gizmo.descendants().filter(element => ['x', 'y', 'z'].includes(element.getAttribute('data-gizmo-axis')) && !element.getAttribute('data-gizmo-hit') && element.tagName.toLowerCase() !== 'line').map(element => element.tagName.toLowerCase());
  ui.tool('translate').click();
  ui.studio.renderNow();
  assert.deepEqual(shapes(), ['polygon', 'polygon', 'polygon']);
  const arrow = ui.gizmoPart('x');
  const handles = ui.controller.gizmoHandles();
  const head = ui.gizmo.descendants().find(element => element.getAttribute('data-gizmo-shape') === 'arrow' && element.getAttribute('data-gizmo-axis') === 'x');
  const [point] = head.getAttribute('points').split(' ').map(pair => pair.split(',').map(Number));
  const tipDistance = Math.hypot(handles.axes.x.x - handles.origin.x, handles.axes.x.y - handles.origin.y);
  assert.ok(Math.hypot(point[0] - handles.origin.x, point[1] - handles.origin.y) > tipDistance, 'the arrow points away from the origin');
  assert.ok(arrow);
  ui.tool('scale').click();
  ui.studio.renderNow();
  assert.deepEqual(shapes(), ['rect', 'rect', 'rect']);
  ui.tool('translate').click();
  ui.controller.setCameraViewPreset('front');
  ui.studio.renderNow();
  assert.deepEqual(shapes().sort(), ['circle', 'polygon', 'polygon'], 'the Z axis points at the viewer');
});

test('the View menu rows that switch something say whether it is on', testContext => {
  const ui = mountStudio(testContext);
  const toggleRow = label => ui.root.descendants().find(element => element.getAttribute('role') === 'menuitemcheckbox' && element.textContent === label);
  const grid = toggleRow('Grid');
  assert.ok(grid);
  assert.equal(grid.getAttribute('aria-checked'), 'true');
  grid.click();
  assert.equal(grid.getAttribute('aria-checked'), 'false');
  assert.equal(ui.studio.preferences.gridVisible, false);
  const properties = toggleRow('Properties');
  assert.equal(properties.getAttribute('aria-checked'), 'true');
  properties.click();
  assert.equal(properties.getAttribute('aria-checked'), 'false');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true');
});

test('the handle under the pointer is marked, stays marked through its drag and clears after', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  assert.equal(ui.gizmo.dataset.hoverAxis, undefined);
  dispatch(ui.gizmoPart('y'), 'pointermove', { bubbles: true });
  assert.equal(ui.gizmo.dataset.hoverAxis, 'y');
  dispatch(ui.gizmoPart('x'), 'pointermove', { bubbles: true });
  assert.equal(ui.gizmo.dataset.hoverAxis, 'x');
  dispatch(ui.gizmo, 'pointerleave');
  assert.equal(ui.gizmo.dataset.hoverAxis, undefined);

  const handles = ui.controller.gizmoHandles();
  const along = distance => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.z[index] * distance));
  dispatch(ui.gizmoPart('z'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  assert.equal(ui.gizmo.dataset.hoverAxis, 'z');
  dispatch(ui.gizmo, 'pointerleave');
  assert.equal(ui.gizmo.dataset.hoverAxis, 'z', 'the handle being dragged stays lit');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength)));
  assert.equal(ui.gizmo.dataset.hoverAxis, undefined);
  for (const axis of ['x', 'xy', 'screen']) {
    assert.ok(STUDIO_CSS.includes(`.crucible-studio-gizmo[data-hover-axis="${axis}"] [data-gizmo-axis="${axis}"]`), `the stylesheet lights ${axis}`);
  }
});

test('Studio opens on the blockout scene when it gets no recipe', testContext => {
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  const studio = createStudio(dom.container, { renderer: createFakeRenderer() });
  testContext.after(() => studio.dispose());
  assert.deepEqual(studio.exportRecipe().nodes.map(node => node.id), ['cube', 'sphere', 'cone']);
  assert.equal(Object.keys(STUDIO_TEMPLATES)[0], 'blockout');
  for (const nodeId of ['cube', 'sphere', 'cone']) {
    const bounds = studio.controller.nodeBounds(nodeId);
    assert.ok(Math.abs(bounds.min[1]) < 1e-3, `${nodeId} rests on the ground`);
    assert.ok(bounds.size.every(length => Math.abs(length - 1) < 1e-3), `${nodeId} is one metre across`);
  }
});

test('turning a ring shows where the turn began, how far it has gone and hides the other rings', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('rotate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const ringPoint = degrees => ui.controller.projectWorldPoint([
    handles.pivot[0] + Math.cos((degrees * Math.PI) / 180),
    handles.pivot[1],
    handles.pivot[2] - Math.sin((degrees * Math.PI) / 180),
  ]);
  const sweepPart = part => ui.gizmo.descendants().find(element => element.getAttribute('data-rotation-sweep') === part);
  const rings = () => ui.gizmo.descendants().filter(element => element.tagName.toLowerCase() === 'polyline' && !element.getAttribute('data-gizmo-hit')).map(element => element.getAttribute('data-gizmo-axis'));
  assert.equal(ui.controller.rotationSweep(), null);
  assert.equal(sweepPart('wedge'), undefined);
  assert.deepEqual(rings(), ['x', 'y', 'z']);

  dispatch(ui.gizmoPart('y'), 'pointerdown', ui.clientPoint(ringPoint(0)));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(ringPoint(40)));
  ui.studio.renderNow();
  let sweep = ui.controller.rotationSweep();
  assert.equal(sweep.axis, 'y');
  assert.ok(Math.abs(sweep.degrees - 40) < 0.5);
  const reach = point => Math.hypot(point.x - sweep.centre.x, point.y - sweep.centre.y);
  assert.ok(sweep.arc.every(point => reach(point) > 10), 'the arc runs along the ring, away from the centre');
  const start = ringPoint(0);
  const now = ringPoint(40);
  const bearing = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
  assert.ok(Math.abs(bearing(sweep.centre, sweep.arc[0]) - bearing(sweep.centre, start)) < 0.02, 'the first spoke points at the grab');
  assert.ok(Math.abs(bearing(sweep.centre, sweep.arc.at(-1)) - bearing(sweep.centre, now)) < 0.02, 'the last spoke follows the pointer');
  assert.deepEqual(rings(), ['y']);
  assert.equal(sweepPart('wedge').getAttribute('pointer-events'), 'none');
  assert.ok(Number(sweepPart('wedge').getAttribute('fill-opacity')) < 0.25, 'the wedge stays faint');
  assert.equal(sweepPart('wedge').getAttribute('points').split(' ').length, sweep.arc.length + 1);
  assert.ok(sweepPart('start').getAttribute('stroke-dasharray'));
  assert.equal(sweepPart('now').getAttribute('stroke-dasharray'), null);

  for (const degrees of [100, 170, 230]) {
    dispatch(ui.canvas, 'pointermove', ui.clientPoint(ringPoint(degrees)));
  }
  sweep = ui.controller.rotationSweep();
  assert.ok(Math.abs(sweep.degrees - 230) < 0.5, 'a turn past half a circle keeps counting');
  dispatch(ui.canvas, 'pointermove', { ...ui.clientPoint(ringPoint(228)), ctrlKey: true });
  assert.equal(ui.controller.rotationSweep().degrees, 225);

  dispatch(ui.canvas, 'pointerup', ui.clientPoint(ringPoint(228)));
  ui.studio.renderNow();
  assert.equal(ui.controller.rotationSweep(), null);
  assert.equal(sweepPart('wedge'), undefined);
  assert.deepEqual(rings(), ['x', 'y', 'z']);
});

test('a drag leaves a ghost where the object was, and a move draws the line it has travelled', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const along = distance => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.x[index] * distance));
  const tracePart = part => ui.gizmo.descendants().find(element => element.getAttribute('data-drag-trace') === part);
  const outlineBefore = ui.controller.selectionOutline();
  assert.equal(ui.controller.dragTrace(), null);

  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  ui.studio.renderNow();
  assert.equal(ui.controller.dragTrace(), null, 'nothing to trace until the object has moved');
  assert.equal(tracePart('ghost'), undefined);

  dispatch(ui.canvas, 'pointermove', ui.clientPoint(along(handles.handleLength + 0.8)));
  ui.studio.renderNow();
  const trace = ui.controller.dragTrace();
  assert.equal(trace.tool, 'translate');
  assert.deepEqual(trace.outline, outlineBefore);
  assert.ok(Math.abs(trace.from.x - handles.origin.x) < 0.01 && Math.abs(trace.from.y - handles.origin.y) < 0.01);
  const pivotNow = ui.controller.gizmoHandles().origin;
  assert.ok(Math.abs(trace.to.x - pivotNow.x) < 0.01 && Math.abs(trace.to.y - pivotNow.y) < 0.01);
  assert.ok(Math.hypot(trace.to.x - trace.from.x, trace.to.y - trace.from.y) > 5);
  assert.equal(tracePart('ghost').getAttribute('points').split(' ').length, outlineBefore.length);
  assert.equal(tracePart('ghost').getAttribute('fill'), 'none');
  for (const part of ['ghost', 'travel', 'start']) {
    assert.equal(tracePart(part).getAttribute('pointer-events'), 'none');
  }
  assert.equal(Number(tracePart('travel').getAttribute('x2')).toFixed(1), trace.to.x.toFixed(1));
  const haloPart = part => ui.gizmo.descendants().find(element => element.getAttribute('data-drag-halo') === part);
  for (const part of ['ghost', 'travel']) {
    assert.equal(haloPart(part).getAttribute('stroke'), 'var(--studio-trace-edge)', 'a dark line lies under the pale dashed one');
    assert.equal(tracePart(part).getAttribute('stroke'), 'var(--studio-trace)');
    assert.ok(Number(haloPart(part).getAttribute('stroke-width')) > Number(tracePart(part).getAttribute('stroke-width')));
    assert.ok(ui.gizmo.descendants().indexOf(haloPart(part)) < ui.gizmo.descendants().indexOf(tracePart(part)), 'the halo is drawn first');
  }
  assert.equal(tracePart('start').getAttribute('stroke'), 'var(--studio-trace-edge)');

  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength + 0.8)));
  ui.studio.renderNow();
  assert.equal(ui.controller.dragTrace(), null);
  assert.equal(tracePart('ghost'), undefined);
  assert.equal(tracePart('travel'), undefined);

  ui.tool('scale').click();
  ui.studio.renderNow();
  const origin = ui.controller.gizmoHandles().origin;
  dispatch(ui.gizmoPart('uniform'), 'pointerdown', ui.clientPoint(origin));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: origin.x + 40, y: origin.y }));
  ui.studio.renderNow();
  assert.ok(tracePart('ghost'), 'a scale drag keeps the old outline');
  assert.equal(tracePart('travel'), undefined, 'only a move has a line of travel');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(origin));
});

test('a new object lands beside the ones already there, and ground pieces stay at the centre', testContext => {
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  const studio = createStudio(dom.container, { renderer: createFakeRenderer() });
  testContext.after(() => studio.dispose());
  const first = studio.controller.addPrimitive('box');
  assert.deepEqual(first.translation, [2.5, 0.5, 0], 'the cube holds the centre and the cone the next spot');
  const second = studio.controller.addPrimitive('sphere');
  assert.deepEqual(second.translation, [3.75, 0.5, 0]);
  assert.ok(Math.abs(studio.controller.nodeBounds(second.id).min[1]) < 1e-3, 'it rests on the ground');
  assert.deepEqual(studio.controller.addPrimitive('plane').translation, [0, 0.02, 0]);
  assert.deepEqual(studio.controller.addPrimitive('box', { translation: [0, 0.5, 0] }).translation, [0, 0.5, 0], 'a given place is kept');
});

test('workspaces run Build, Look, Animate, Export and each shows only the panels its step needs', testContext => {
  const ui = mountStudio(testContext);
  const workspaceTab = id => byDataset(ui.root, 'workspace', id);
  const shownTabs = () => STUDIO_TABS.filter(tab => !ui.tab(tab).hasAttribute('hidden'));
  const tabList = ui.root.querySelector('.crucible-studio-tablist');
  const workspaceList = ui.root.querySelector('.crucible-studio-workspaces');
  assert.deepEqual(workspaceList.querySelectorAll('.crucible-studio-workspace-label').map(label => label.textContent), ['Build', 'Look', 'Animate', 'Export']);
  assert.deepEqual(workspaceList.querySelectorAll('button').map(button => button.querySelector('svg') !== null), [true, true, true, true], 'each workspace tab leads with an icon');
  assert.deepEqual(workspaceList.querySelectorAll('button').map(button => button.getAttribute('aria-label')), ['Build', 'Look', 'Animate', 'Export']);
  assert.equal(workspaceList.getAttribute('role'), 'tablist');
  assert.equal(workspaceList.parentNode.className, 'crucible-studio-menubar', 'the tabs share the menu bar, not a row of their own');

  assert.equal(ui.root.dataset.workspace, 'build');
  assert.equal(workspaceTab('build').getAttribute('aria-selected'), 'true');
  assert.deepEqual(shownTabs(), ['node', 'modifiers']);
  assert.equal(tabList.hasAttribute('hidden'), false, 'Build holds the Object and Modifiers tabs');

  const recipeBefore = JSON.stringify(ui.studio.exportRecipe());
  workspaceTab('look').click();
  assert.equal(ui.root.dataset.workspace, 'look');
  assert.equal(workspaceTab('build').getAttribute('aria-selected'), 'false');
  assert.equal(workspaceTab('build').hasAttribute('aria-pressed'), false);
  assert.deepEqual(shownTabs(), ['material', 'look']);
  assert.equal(tabList.hasAttribute('hidden'), false);
  assert.equal(ui.controller.activeTab, 'material');
  ui.tab('look').click();
  assert.equal(ui.root.dataset.workspace, 'look');
  assert.equal(ui.controller.activeTab, 'look');

  workspaceTab('animate').click();
  assert.deepEqual(shownTabs(), ['node', 'camera'], 'Animate keeps the object panel one tab away, for the object being keyed');
  assert.equal(ui.controller.activeTab, 'camera', 'a workspace opens on its first panel');
  workspaceTab('look').click();
  assert.equal(ui.controller.activeTab, 'material');
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore, 'a workspace is not part of the scene');
  assert.equal(ui.controller.canUndo, false);

  ui.studio.setActiveTab('node');
  assert.equal(ui.root.dataset.workspace, 'build', 'opening a panel brings its workspace forward');
  dispatch(ui.dom.document, 'keydown', { key: 'k' });
  assert.equal(ui.root.dataset.workspace, 'animate', 'a keyframe opens the timeline');

  workspaceTab('export').click();
  assert.equal(ui.root.dataset.workspace, 'export');
  assert.equal(workspaceTab('export').getAttribute('aria-selected'), 'true');
  assert.deepEqual(shownTabs(), ['export'], 'Export shows its own panel alone');
  assert.ok(tabList.hasAttribute('hidden'), 'one panel needs no tab row');
  assert.equal(ui.controller.activeTab, 'export');
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore, 'entering Export keeps the scene');
  assert.equal(ui.controller.canUndo, false);
});

test('the Export workspace holds an image, a model and a web pack, each with its facts, one action and a result line', async testContext => {
  const ui = mountStudio(testContext, { recipe: animatedRecipe(), fileName: 'castle.scene.json' });
  ui.canvas.width = 640;
  ui.canvas.height = 360;
  byDataset(ui.root, 'workspace', 'export').click();
  const groups = ui.root.querySelectorAll('.crucible-studio-export-group');
  assert.deepEqual(groups.map(group => group.dataset.kind), ['image', 'model', 'pack']);
  assert.deepEqual(groups.map(group => group.querySelector('.crucible-studio-export-heading span').textContent), ['Image', 'Model', 'Web pack']);
  for (const group of groups) {
    assert.ok(group.querySelector('.crucible-studio-export-heading svg'), 'each group title has an icon');
    assert.equal(group.querySelectorAll('button').length, 1, 'one action for each export');
    assert.equal(group.querySelector('button svg'), null, 'the group title carries the icon, as the other Studio buttons carry none');
    assert.equal(group.querySelector('.crucible-studio-export-result').hasAttribute('hidden'), true, 'no result before an export');
  }
  const factTexts = kind => groups.find(group => group.dataset.kind === kind).querySelectorAll('.crucible-studio-export-fact').map(fact => fact.textContent);
  assert.ok(factTexts('model').some(text => /parts?$/.test(text)) && factTexts('model').some(text => /triangles$/.test(text)), 'the model names its parts and triangles');
  assert.deepEqual(factTexts('pack'), [factTexts('model')[0], 'motion left out'], 'the pack names its parts and what a static snapshot leaves out');
  assert.deepEqual(factTexts('image'), ['', '640 × 360'], 'the image shows its shape and names its size in pixels');

  byText(ui.root, 'Save PNG').click();
  await ui.dom.settle();
  const imageResult = groups.find(group => group.dataset.kind === 'image').querySelector('.crucible-studio-export-result');
  assert.match(imageResult.textContent, /^castle\.png, 640 × 360, \d+ B$/);
  byText(ui.root, 'Save GLB').click();
  await ui.dom.settle();
  const modelResult = groups.find(group => group.dataset.kind === 'model').querySelector('.crucible-studio-export-result');
  assert.equal(modelResult.dataset.state, 'ok');
  assert.match(modelResult.textContent, /^castle\.glb, \d+(\.\d)? (B|KB|MB)$/);
  assert.ok(modelResult.querySelector('svg'), 'a result leads with a mark');
  const statusRegion = ui.root.querySelector('.crucible-studio-export-status');
  assert.equal(statusRegion.getAttribute('role'), 'status');
  assert.equal(statusRegion.hasAttribute('hidden'), false, 'the status region is never hidden, so a screen reader has it before the first message');
  assert.equal(statusRegion.textContent, modelResult.textContent, 'and it carries the same message');
  assert.equal(modelResult.getAttribute('aria-hidden'), 'true', 'the line seen is not read twice');
  assert.equal(ui.root.querySelector('.crucible-studio-inspector .crucible-studio-dock-title span').textContent, 'Export', 'the card is titled for the workspace');

  const failing = createDesktop();
  failing.saveGlb = async () => {
    throw new Error('Disk is full.');
  };
  const failingUi = mountStudio(testContext, { sharedDom: ui.dom, desktop: failing });
  byText(failingUi.root, 'Save GLB').click();
  await failingUi.dom.settle();
  const failedResult = failingUi.root.querySelectorAll('.crucible-studio-export-group').find(group => group.dataset.kind === 'model').querySelector('.crucible-studio-export-result');
  assert.equal(failedResult.dataset.state, 'failed');
  assert.equal(failedResult.textContent, 'Disk is full.');
  assert.notEqual(failedResult.querySelector('path').getAttribute('d'), modelResult.querySelector('path').getAttribute('d'), 'success and failure differ in shape');

  byDataset(ui.root, 'workspace', 'build').click();
  assert.equal(modelResult.hasAttribute('hidden'), true, 'leaving the workspace clears the results');
  assert.equal(ui.root.querySelector('.crucible-studio-inspector .crucible-studio-dock-title span').textContent, 'Properties');
});

test('Export is a place to look and save: edits, edit mode, picking and the view are locked, and leaving gives them back (#3343)', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const recipeBefore = JSON.stringify(ui.studio.exportRecipe());
  const toolBefore = ui.controller.tool;
  const eyeBefore = [...ui.controller.viewCamera.eye];
  const sceneParts = ui.controller.scene.parts.length;
  ui.studio.renderNow();
  assert.ok(ui.gizmo.children.length > 0, 'Build draws the handles of the selection');

  byDataset(ui.root, 'workspace', 'export').click();
  for (const key of ['Delete', 'x', 'g', 'r', 's', 'Tab', 'k', 'f']) {
    dispatch(ui.dom.document, 'keydown', { key });
  }
  dispatch(ui.dom.document, 'keydown', { key: 'd', shiftKey: true });
  dispatch(ui.dom.document, 'keydown', { key: 'c', ctrlKey: true });
  dispatch(ui.dom.document, 'keydown', { key: 'v', ctrlKey: true });
  assert.equal(ui.root.dataset.workspace, 'export', 'a keyframe key does not carry the person to Animate');
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore, 'no key edits the scene');
  assert.equal(ui.controller.tool, toolBefore);
  assert.equal(ui.controller.selectedNodeId, 'hero');
  assert.equal(ui.root.querySelector('.crucible-studio-hint-chip'), null, 'no move is waiting for the pointer');

  const orbPoint = ui.controller.projectWorldPoint([2.2, 0.5, 0]);
  dispatch(ui.canvas, 'pointerdown', ui.clientPoint(orbPoint));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(orbPoint));
  assert.equal(ui.controller.selectedNodeId, 'hero', 'a click on the viewport picks nothing');
  dispatch(ui.canvas, 'pointerdown', ui.clientPoint({ x: 400, y: 300 }));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: 480, y: 340 }));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint({ x: 480, y: 340 }));
  const zoom = dispatch(ui.canvas, 'wheel', { deltaY: 100 });
  assert.equal(zoom.defaultPrevented, true, 'the page still does not scroll under the wheel');
  assert.deepEqual([...ui.controller.viewCamera.eye], eyeBefore, 'the view is the shot: dragging and the wheel do not move it');

  const popover = id => ui.root.querySelector(`#crucible-studio-pop-${id}`);
  byText(popover('edit'), 'Delete').click();
  byText(popover('edit'), 'Duplicate').click();
  byText(popover('view'), 'Top view').click();
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore, 'the menu rows are locked too');
  assert.deepEqual([...ui.controller.viewCamera.eye], eyeBefore);

  ui.studio.renderNow();
  assert.equal(ui.gizmo.children.length, 0, 'no handle, outline, mark or agent pointer is built');
  assert.equal(ui.root.querySelector('.crucible-studio-outliner').inert, true, 'the Scene card cannot be used');

  ui.controller.updateNodeTransform('hero', { translation: [0, 1.5, 0] });
  byText(popover('edit'), 'Undo').click();
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore, 'undo stays available');

  byDataset(ui.root, 'workspace', 'build').click();
  ui.dom.runAnimationFrames(performance.now());
  assert.ok(ui.gizmo.children.length > 0, 'leaving brings the handles back');
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT, 'and the grid');
  assert.deepEqual([...ui.controller.viewCamera.eye], eyeBefore, 'and the same view');
  assert.equal(ui.controller.tool, toolBefore);
  assert.equal(ui.controller.selectedNodeId, 'hero', 'and the same selection');
  dispatch(ui.dom.document, 'keydown', { key: 'Delete' });
  assert.equal(ui.studio.exportRecipe().nodes.length, JSON.parse(recipeBefore).nodes.length - 1, 'and the keys edit the scene again');
});

test('entering Export asks for a frame, so the viewport shows the shot without the grid every time (#3343)', testContext => {
  const ui = mountStudio(testContext);
  const sceneParts = ui.controller.scene.parts.length;
  ui.dom.runAnimationFrames(performance.now());
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT);
  byDataset(ui.root, 'workspace', 'export').click();
  assert.ok(ui.dom.pendingAnimationFrameCount > 0, 'a change of workspace asks for a frame');
  ui.dom.runAnimationFrames(performance.now());
  assert.equal(ui.renderer.partCount, sceneParts, 'no grid inside the frame');
  assert.equal(ui.root.querySelector('.crucible-studio-export-guide') !== null, true);
  const hiddenInExport = ['.crucible-studio-view-widget', '.crucible-studio-readout', '.crucible-studio-hintbar', '.crucible-studio-outliner', '.crucible-studio-gizmo'];
  for (const selector of hiddenInExport) {
    assert.ok(STUDIO_CSS.includes(`.crucible-studio[data-workspace="export"] ${selector}`), `${selector} is hidden in Export`);
  }
});

test('a result line goes when the scene changes, and when the same action runs again (#3343)', async testContext => {
  const desktop = createDesktop();
  const ui = mountStudio(testContext, { desktop });
  byDataset(ui.root, 'workspace', 'export').click();
  const modelResult = () => ui.root.querySelectorAll('.crucible-studio-export-group').find(group => group.dataset.kind === 'model').querySelector('.crucible-studio-export-result');
  byText(ui.root, 'Save GLB').click();
  await ui.dom.settle();
  assert.equal(modelResult().hasAttribute('hidden'), false);
  ui.controller.updateNodeTransform('hero', { translation: [0, 1.5, 0] });
  assert.equal(modelResult().hasAttribute('hidden'), true, 'an edit of the scene clears the line');

  byText(ui.root, 'Save GLB').click();
  await ui.dom.settle();
  assert.equal(modelResult().hasAttribute('hidden'), false);
  desktop.saveGlb = async () => ({ canceled: true });
  byText(ui.root, 'Save GLB').click();
  await ui.dom.settle();
  assert.equal(modelResult().hasAttribute('hidden'), true, 'a cancelled save leaves no old line');
});

test('the Web pack facts are worked out only while Export is open, and a failure shows as a warning (#3343)', testContext => {
  const ui = mountStudio(testContext);
  const packFacts = () => ui.root.querySelectorAll('.crucible-studio-export-group').find(group => group.dataset.kind === 'pack').querySelectorAll('.crucible-studio-export-fact');
  ui.controller.updateNodeTransform('hero', { translation: [0, 1.5, 0] });
  assert.equal(packFacts().length, 0, 'nothing is worked out in another workspace');

  const realClone = globalThis.structuredClone;
  globalThis.structuredClone = value => {
    // Only the copy the Web pack makes fails; the rest of Studio copies recipes as it always did.
    if (new Error().stack.includes('buildPackReadyRecipe')) throw new Error('The recipe cannot be copied.');
    return realClone(value);
  };
  try {
    byDataset(ui.root, 'workspace', 'export').click();
  } finally {
    globalThis.structuredClone = realClone;
  }
  assert.equal(packFacts().map(fact => fact.textContent).join('|'), 'The recipe cannot be copied.');
  assert.ok(packFacts()[0].querySelector('svg'), 'the failure leads with the warning mark');
  const modelFacts = ui.root.querySelectorAll('.crucible-studio-export-group').find(group => group.dataset.kind === 'model').querySelectorAll('.crucible-studio-export-fact');
  assert.ok(modelFacts.length > 0, 'the other groups are not affected');
});

test('a scene with no parts cannot be saved as a model or a pack, and Studio refuses a scene with no camera (#3343)', async testContext => {
  const empty = makeRecipe();
  empty.nodes = [];
  const ui = mountStudio(testContext, { recipe: empty });
  byDataset(ui.root, 'workspace', 'export').click();
  const group = kind => ui.root.querySelectorAll('.crucible-studio-export-group').find(candidate => candidate.dataset.kind === kind);
  for (const kind of ['model', 'pack']) {
    assert.equal(group(kind).querySelector('button').getAttribute('aria-disabled'), 'true', `${kind} is disabled`);
    assert.equal(group(kind).querySelector('.crucible-studio-export-fact').textContent, 'No parts to save');
    assert.ok(group(kind).querySelector('.crucible-studio-export-fact svg'), 'the reason has a warning mark');
  }
  assert.notEqual(group('image').querySelector('button').getAttribute('aria-disabled'), 'true', 'an empty scene still has a picture');
  byText(ui.root, 'Save GLB').click();
  byText(ui.root, 'Save pack').click();
  await ui.dom.settle();
  assert.equal(ui.dom.document.downloads.length, 0, 'a disabled button writes nothing');
  assert.equal(group('model').querySelector('.crucible-studio-export-result').hasAttribute('hidden'), true);

  const sceneWithoutCamera = { ...createAgentScene(makeRecipe()), camera: undefined };
  assert.throws(() => mountStudio(testContext, { sharedDom: ui.dom, scene: sceneWithoutCamera }), /Studio scene must provide parts and camera/, 'a scene always has a camera, so the image never lacks one');
});

test('the desktop host names the file or folder it wrote, whatever it is called (#3343)', async testContext => {
  const folder = createDesktop({ packWebBundle: async () => ({ outDir: 'C:/out/site' }) });
  const folderUi = mountStudio(testContext, { desktop: folder, fileName: 'castle.scene.json' });
  byText(folderUi.root, 'Save pack').click();
  await folderUi.dom.settle();
  const resultOf = ui => ui.root.querySelectorAll('.crucible-studio-export-group').find(group => group.dataset.kind === 'pack').querySelector('.crucible-studio-export-result').textContent;
  assert.match(resultOf(folderUi), /^site, \d+ (B|KB|MB)$/, 'a bundle folder is shown by its folder name, not as a .pack file');
  const named = createDesktop({ packWebBundle: async () => ({ outDir: 'C:/out', fileName: 'castle.bundle' }) });
  const namedUi = mountStudio(testContext, { sharedDom: folderUi.dom, desktop: named });
  byText(namedUi.root, 'Save pack').click();
  await namedUi.dom.settle();
  assert.match(resultOf(namedUi), /^castle\.bundle, /, 'a name the host returns wins');
});

test('each scene row draws the shape of its object in the colour of its material', testContext => {
  const recipe = makeRecipe();
  recipe.nodes.push({ id: 'set', label: 'Set' });
  const ui = mountStudio(testContext, { recipe });
  const shapes = Object.fromEntries(ui.rows().map(row => [
    row.querySelector('.crucible-studio-tree-label').textContent,
    row.querySelector('.crucible-studio-tree-badge'),
  ]));
  assert.equal(shapes.hero.getAttribute('data-shape'), 'node');
  assert.equal(shapes.orb.getAttribute('data-shape'), 'sphere');
  assert.equal(shapes.Set.getAttribute('data-shape'), 'group');
  assert.match(shapes.hero.style.fill, /^#[0-9a-f]{6}$/);
  assert.equal(shapes.Set.style.fill, undefined, 'a group has no material to show');
  assert.equal(shapes.orb.tagName.toLowerCase(), 'svg');
});

test('Blender keys add, duplicate, delete, deselect, turn the view and fold Properties', testContext => {
  const ui = mountStudio(testContext);
  const press = (key, properties = {}) => dispatch(ui.dom.document, 'keydown', { key, ...properties });
  ui.selectRow('hero');
  const countBefore = ui.studio.exportRecipe().nodes.length;
  press('D', { shiftKey: true });
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore + 1, 'Shift+D duplicates');
  press('x');
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore, 'X deletes the selection');

  ui.selectRow('hero');
  press('Escape');
  assert.equal(ui.controller.selectedNodeId, null, 'Esc deselects');
  press('x');
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore, 'X does nothing with no selection');

  const offset = () => ui.controller.scene.camera.eye.map((value, index) => value - ui.controller.scene.camera.target[index]);
  press('7');
  assert.ok(offset()[1] > Math.abs(offset()[0]) * 20 && offset()[1] > Math.abs(offset()[2]) * 20, 'top view looks straight down');
  assert.equal(ui.status(), 'Top view');
  press('1');
  assert.ok(offset()[2] > 0 && Math.abs(offset()[0]) < 1e-3 && Math.abs(offset()[1]) < 1e-3, 'front view looks along Z');
  press('3');
  assert.ok(offset()[0] > 0 && Math.abs(offset()[2]) < 1e-3, 'right view looks along X');

  press('n');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true');
  press('n');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'false');

  let addClicks = 0;
  ui.label('Add an object or a light').addEventListener('click', () => { addClicks += 1; });
  press('A', { shiftKey: true });
  assert.equal(addClicks, 1, 'Shift+A opens the Add menu');

  const toolBefore = ui.controller.tool;
  press('g', { ctrlKey: true });
  assert.equal(ui.controller.tool, toolBefore, 'a browser shortcut is not taken for a tool key');
  press(',', { ctrlKey: true });
  assert.equal(ui.root.querySelector('.crucible-studio-settings-dialog').open, true, 'Ctrl+, opens Settings');
});

test('Settings change the snap, the handles and what the viewport shows, and are kept for the next visit', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  const control = name => ui.root.querySelector('.crucible-studio-settings-dialog').descendants().find(element => element.dataset?.setting === name);
  const choose = (name, value) => {
    control(name).value = String(value);
    dispatch(control(name), 'change');
  };
  const toggle = (name, checked) => {
    control(name).checked = checked;
    dispatch(control(name), 'change');
  };
  assert.deepEqual(ui.controller.interactionSettings, { moveSnapStep: 0.25, rotateSnapDegrees: 15, gizmoPixels: 74, snapEnabled: false, snapTarget: 'increment', lengthUnit: 'm' });
  assert.equal(control('moveSnapStep').value, '0.25');
  assert.equal(control('gridVisible').checked, true);

  byText(ui.root, 'Settings…').click();
  assert.equal(ui.root.querySelector('.crucible-studio-settings-dialog').open, true);
  choose('moveSnapStep', 1);
  choose('rotateSnapDegrees', 45);
  choose('gizmoSize', 'large');
  assert.deepEqual(ui.controller.interactionSettings, { moveSnapStep: 1, rotateSnapDegrees: 45, gizmoPixels: 92, snapEnabled: false, snapTarget: 'increment', lengthUnit: 'm' });
  toggle('gridVisible', false);
  assert.equal(ui.studio.gridVisible, false);
  assert.equal(ui.label('Show or hide the grid').getAttribute('aria-pressed'), 'false');
  toggle('readoutVisible', false);
  toggle('viewWidgetVisible', false);
  assert.equal(ui.root.dataset.readout, 'off');
  assert.equal(ui.root.dataset.viewWidget, 'off');
  choose('startWorkspace', 'animate');
  assert.equal(ui.root.dataset.workspace, 'build', 'the workspace in use is left alone');
  assert.deepEqual(JSON.parse(saved.get('crucible-studio-preferences')), {
    panelWidth: 284,
    sceneShare: 0,
    sceneWidth: 0,
    propertiesWidth: 0,
    sceneHeight: 0,
    propertiesHeight: 0,
    sceneMinimized: false,
    propertiesMinimized: false,
    historyVisible: false,
    historyMinimized: false,
    propertyGroupsOpen: {},
    panelsFloating: false,
    moveSnapStep: 1,
    rotateSnapDegrees: 45,
    lengthUnit: 'm',
    snapEnabled: false,
    snapTarget: 'increment',
    gizmoSize: 'large',
    startWorkspace: 'animate',
    theme: 'system',
    performance: 'automatic',
    keymap: 'crucible',
    numberPad: false,
    numberPadNoticeShown: false,
    keyOverrides: {},
    motion: 'system',
    zoomDirection: 'normal',
    setupDone: false,
    gridVisible: false,
    readoutVisible: false,
    viewWidgetVisible: false,
    agentCursorVisible: true,
  });

  ui.label('Show or hide the grid').click();
  assert.equal(control('gridVisible').checked, true, 'the grid button and the setting are one switch');

  const next = mountStudio(testContext, { preferenceStorage, sharedDom: ui.dom });
  assert.equal(next.root.dataset.workspace, 'animate', 'the next visit opens in the chosen workspace');
  assert.equal(next.controller.interactionSettings.moveSnapStep, 1);
  assert.equal(next.root.dataset.readout, 'off');

  next.button('Reset settings').click();
  assert.deepEqual(next.controller.interactionSettings, { moveSnapStep: 0.25, rotateSnapDegrees: 15, gizmoPixels: 74, snapEnabled: false, snapTarget: 'increment', lengthUnit: 'm' });
  assert.equal(next.root.dataset.readout, 'on');
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).startWorkspace, 'build');
  assert.throws(() => next.studio.setPreference('colour', 'pink'), /Unknown Studio preference/);
});

test('a Ctrl drag snaps a move to the step chosen in Settings while snapping is off', testContext => {
  const ui = mountStudio(testContext, { preferences: { moveSnapStep: 1 } });
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const along = distance => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.x[index] * distance));
  const startX = ui.node('hero').translation[0];
  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  dispatch(ui.canvas, 'pointermove', { ...ui.clientPoint(along(handles.handleLength + 1.3)), ctrlKey: true });
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength + 1.3)));
  const travelled = ui.node('hero').translation[0] - startX;
  assert.ok(Math.abs(travelled - Math.round(travelled)) < 1e-6 && Math.abs(travelled) >= 1, `moved ${travelled} m in whole metres`);
});

test('Scene and Properties share one column and the Scene head carries its icons', testContext => {
  const ui = mountStudio(testContext);
  const side = ui.root.querySelector('.crucible-studio-side');
  const docks = side.children.map(child => child.getAttribute('aria-label'));
  assert.deepEqual(docks, ['Panel width', 'Scene outliner', 'Scene card height', 'Scene inspector', 'History']);
  const head = side.querySelector('.crucible-studio-dock-head');
  assert.ok(head.querySelector('.crucible-studio-dock-title').querySelector('svg'));
  const sideRule = STUDIO_CSS.slice(STUDIO_CSS.indexOf('.crucible-studio-side {'), STUDIO_CSS.indexOf('.crucible-studio-side > .crucible-studio-dock {'));
  assert.ok(sideRule.includes('inset-inline-end: var(--studio-edge);') && !sideRule.includes('inset-inline-start'), 'the column sits on the right, across from the tool rail');

  const filterRow = side.querySelector('.crucible-studio-filter');
  const search = ui.label('Filter the scene list');
  const findButton = ui.label('Find an object in the scene');
  assert.ok(head.children.includes(findButton) && findButton.querySelector('svg'));
  assert.equal(filterRow.hidden, true, 'the filter box stays away until asked for');
  findButton.click();
  assert.equal(filterRow.hidden, false);
  assert.equal(findButton.getAttribute('aria-pressed'), 'true');
  search.value = 'or';
  dispatch(search, 'input');
  assert.deepEqual(ui.rowLabels(), ['orb']);
  dispatch(search, 'keydown', { key: 'Escape' });
  assert.equal(filterRow.hidden, true);
  assert.equal(search.value, '', 'closing the box clears the filter');
  assert.ok(ui.rowLabels().length > 1);
  assert.equal(findButton.getAttribute('aria-pressed'), 'false');

  const addButton = ui.label('Add to the scene');
  assert.ok(head.children.includes(addButton));
  assert.equal(addButton.getAttribute('popovertarget'), 'crucible-studio-pop-add');
});

test('the top left shows the Crucible mark from the brand kit', testContext => {
  const ui = mountStudio(testContext);
  const mark = ui.root.querySelector('.crucible-studio-brand').querySelector('svg');
  const layers = mark.children.map(path => path.getAttribute('class'));
  assert.deepEqual(layers, ['body', 'shadow', 'molten-deep', 'molten', 'face-shadow', 'face', 'eye'].map(layer => 'crucible-studio-mark-' + layer));
  const kit = readFileSync(new URL('../public/brand/crucible-mark.svg', import.meta.url), 'utf8');
  assert.ok(kit.includes('viewBox="' + mark.getAttribute('viewBox') + '"'));
  for (const path of mark.children) {
    assert.ok(kit.includes(' d="' + path.getAttribute('d') + '"'), 'every path is the kit path, untouched');
  }
});

test('handle heads have no border until the pointer is on them', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const heads = ['x', 'y', 'z'].map(axis => ui.gizmo.descendants().find(element => element.tagName.toLowerCase() === 'polygon' && element.getAttribute('data-gizmo-axis') === axis));
  for (const head of heads) {
    assert.equal(head.getAttribute('stroke'), 'none');
  }
  const hoverRule = STUDIO_CSS.slice(STUDIO_CSS.indexOf('[data-gizmo-axis="surface"]:is(polygon, rect, circle) {'));
  assert.ok(hoverRule.slice(0, 120).includes('stroke: var(--studio-trace);'), 'the border under the pointer is pale');
});

test('the top bar has File, Edit, View, Agent and Help menus that do what their rows say', testContext => {
  const ui = mountStudio(testContext);
  const menus = ui.root.querySelector('.crucible-studio-menus').children.map(button => button.textContent);
  assert.deepEqual(menus, ['File', 'Edit', 'View', 'Agent', 'Help']);
  const menuButton = label => ui.root.querySelector('.crucible-studio-menus').children.find(button => button.textContent === label);
  const popover = id => ui.root.querySelector(`#crucible-studio-pop-${id}`);
  const rows = id => popover(id).querySelectorAll('button').map(button => button.textContent);

  menuButton('File').click();
  assert.equal(popover('new').popoverOpen, true);
  assert.deepEqual(rows('new'), ['New scene…', 'Open…', 'Open recent', 'Save', 'Save as…', 'Export…', 'Recipe JSON']);
  assert.equal(byText(popover('new'), 'Save').dataset.shortcut, 'Ctrl+S');
  byText(popover('new'), 'Export…').click();
  assert.equal(ui.root.dataset.workspace, 'export', 'the one Export row opens the workspace');
  byDataset(ui.root, 'workspace', 'build').click();
  assert.equal(popover('new').popoverOpen, false, 'a row closes its menu');

  menuButton('Edit').click();
  assert.deepEqual(rows('edit'), ['Undo', 'Redo', 'History', 'Copy', 'Paste', 'Duplicate', 'Join', 'Parent', 'Clear parent', 'Delete', 'Rename', 'Deselect', 'Hide', 'Show all', 'Reset position', 'Reset rotation', 'Reset scale', 'Settings…']);
  ui.selectRow('hero');
  const countBefore = ui.studio.exportRecipe().nodes.length;
  byText(popover('edit'), 'Duplicate').click();
  assert.equal(popover('edit').popoverOpen, false, 'a row closes its menu');
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore + 1);
  byText(popover('edit'), 'Undo').click();
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore);
  byText(popover('edit'), 'Redo').click();
  byText(popover('edit'), 'Delete').click();
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore);
  ui.selectRow('hero');
  byText(popover('edit'), 'Deselect').click();
  assert.equal(ui.controller.selectedNodeId, null);

  menuButton('View').click();
  byText(popover('view'), 'Top view').click();
  assert.equal(ui.status(), 'Top view');
  byText(popover('view'), 'Perspective / Orthographic').click();
  assert.equal(ui.controller.scene.camera.projection, 'orthographic');
  byText(popover('view'), 'Grid').click();
  assert.equal(ui.studio.gridVisible, false);
  byText(popover('view'), 'Properties').click();
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true');

  byText(popover('help'), 'Keyboard shortcuts').click();
  assert.equal(ui.root.querySelector('.crucible-studio-shortcuts-dialog').open, true);
  assert.equal(ui.root.querySelectorAll('button').filter(button => ['Settings (Ctrl+,)', 'Keyboard shortcuts (?)'].includes(button.getAttribute('aria-label'))).length, 0);
});

test('the rail keeps scene tools above one line and the show and hide switches below it', testContext => {
  const ui = mountStudio(testContext);
  const toolbar = ui.root.querySelector('.crucible-studio-toolbar');
  const rows = toolbar.children.map(child => child.getAttribute('role') === 'separator' ? 'line' : child.getAttribute('aria-label'));
  // The mesh selection modes are in the rail but hidden until edit mode starts.
  assert.deepEqual(rows, ['Transform tool', 'Snapping', 'Mesh selection', 'Edit the scene', 'line', 'Show or hide']);
  assert.equal(toolbar.children[2].hidden, true);
  const below = toolbar.children.at(-1).children.map(button => button.getAttribute('aria-label'));
  assert.deepEqual(below, ['Show or hide the grid', 'See through the surface (Alt+Z)', 'Show or hide the panels']);
  const above = toolbar.children[3].children.map(button => button.dataset.icon);
  assert.deepEqual(above, ['add', 'undo', 'redo']);
});

test('each card minimizes to its head, apart from the panels switch, and stays that way on the next visit', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  assert.equal(ui.root.dataset.outlinerMinimized, 'false');
  const minimizeScene = ui.label('Minimize Scene');
  assert.equal(minimizeScene.getAttribute('aria-expanded'), 'true');
  minimizeScene.click();
  assert.equal(ui.root.dataset.outlinerMinimized, 'true');
  assert.equal(ui.root.dataset.outlinerCollapsed, 'false', 'a minimized card is still shown');
  assert.equal(minimizeScene.getAttribute('aria-label'), 'Expand Scene');
  assert.equal(minimizeScene.getAttribute('aria-expanded'), 'false');
  assert.equal(minimizeScene.dataset.icon, 'expand');
  ui.label('Minimize Properties').click();
  assert.equal(ui.root.dataset.inspectorMinimized, 'true');

  ui.label('Show or hide the panels').click();
  ui.label('Show or hide the panels').click();
  assert.equal(ui.root.dataset.outlinerMinimized, 'true', 'hiding and showing the panels keeps a card minimized');

  const next = mountStudio(testContext, { preferenceStorage, sharedDom: ui.dom });
  assert.equal(next.root.dataset.outlinerMinimized, 'true');
  assert.equal(next.root.dataset.inspectorMinimized, 'true');
  next.label('Expand Scene').click();
  assert.equal(next.root.dataset.outlinerMinimized, 'false');
  assert.ok(STUDIO_CSS.includes('[data-outliner-minimized="true"] .crucible-studio-outliner > :not(.crucible-studio-dock-head)'));
});

test('the panel column resizes by dragging its grips or with the arrow keys, inside its limits, and keeps the size', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  const widthGrip = ui.label('Panel width');
  const splitGrip = ui.label('Scene card height');
  const savedPreferences = () => JSON.parse(saved.get('crucible-studio-preferences'));
  assert.equal(widthGrip.getAttribute('aria-valuenow'), '284');
  assert.equal(ui.root.dataset.sceneSized, 'false', 'the Scene card sizes itself until someone drags the split');

  dispatch(widthGrip, 'pointerdown', { clientX: 600 });
  dispatch(widthGrip, 'pointermove', { clientX: 540 });
  assert.equal(widthGrip.getAttribute('aria-valuenow'), '344', 'the drag previews the width');
  assert.equal(saved.has('crucible-studio-preferences'), false, 'and saves nothing until the pointer lets go');
  dispatch(widthGrip, 'pointerup', { clientX: 540 });
  assert.equal(ui.studio.preferences.panelWidth, 344);
  assert.equal(savedPreferences().panelWidth, 344);

  dispatch(widthGrip, 'pointerdown', { clientX: 540 });
  dispatch(widthGrip, 'pointermove', { clientX: -900 });
  dispatch(widthGrip, 'pointerup', { clientX: -900 });
  assert.equal(ui.studio.preferences.panelWidth, 520, 'the column stops at its widest');
  dispatch(widthGrip, 'pointerdown', { clientX: 0 });
  dispatch(widthGrip, 'pointermove', { clientX: 900 });
  dispatch(widthGrip, 'pointerup', { clientX: 900 });
  assert.equal(ui.studio.preferences.panelWidth, 240, 'and at its narrowest');

  const widen = dispatch(widthGrip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(widen.defaultPrevented, true);
  assert.equal(ui.studio.preferences.panelWidth, 256);
  dispatch(widthGrip, 'keydown', { key: 'ArrowRight' });
  assert.equal(ui.studio.preferences.panelWidth, 240);
  assert.equal(dispatch(widthGrip, 'keydown', { key: 'a' }).defaultPrevented, false);
  dispatch(widthGrip, 'dblclick');
  assert.equal(ui.studio.preferences.panelWidth, 284, 'a double click goes back to the opening width');

  dispatch(splitGrip, 'keydown', { key: 'ArrowDown' });
  assert.equal(ui.studio.preferences.sceneShare, 47);
  assert.equal(ui.root.dataset.sceneSized, 'true');
  dispatch(splitGrip, 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.studio.preferences.sceneShare, 42);
  dispatch(splitGrip, 'dblclick');
  assert.equal(ui.studio.preferences.sceneShare, 0);
  assert.equal(ui.root.dataset.sceneSized, 'false');

  const next = mountStudio(testContext, { preferenceStorage, sharedDom: ui.dom, preferences: { panelWidth: 9000, sceneShare: 3 } });
  assert.equal(next.studio.preferences.panelWidth, 520, 'a saved width outside the limits is pulled back in');
  assert.equal(next.studio.preferences.sceneShare, 15);
  assert.equal(mountStudio(testContext, { sharedDom: ui.dom, preferences: { panelWidth: Number.NaN } }).studio.preferences.panelWidth, 284);
});
test('panels dock to the window edges by default and float over the scene from Settings', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  assert.equal(ui.root.dataset.floating, 'false', 'a first visit opens docked');
  const viewMenu = ui.root.descendants().find(element => element.id === 'crucible-studio-pop-view');
  assert.equal(viewMenu.descendants().some(element => element.textContent === 'Floating panels'), false, 'the switch lives in Settings only');
  const control = ui.root.querySelector('.crucible-studio-settings-dialog').descendants().find(element => element.dataset?.setting === 'panelsFloating');
  assert.equal(control.checked, false);
  control.checked = true;
  dispatch(control, 'change');
  assert.equal(ui.root.dataset.floating, 'true');
  assert.equal(ui.studio.preferences.panelsFloating, true);
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).panelsFloating, true);

  const next = mountStudio(testContext, { preferenceStorage, sharedDom: ui.dom });
  assert.equal(next.root.dataset.floating, 'true', 'the next visit keeps the floating panels');

  const docked = '.crucible-studio[data-floating="false"]:not([data-compact="true"])';
  const viewportRule = STUDIO_CSS.slice(STUDIO_CSS.indexOf(docked + ' .crucible-studio-viewport {'));
  assert.ok(viewportRule.startsWith(docked), 'the docked viewport has a rule of its own');
  assert.ok(viewportRule.slice(0, viewportRule.indexOf('}')).includes('inset: var(--studio-dock-bar) var(--studio-dock-side) 0 var(--studio-rail)'), 'the viewport is the room the panels leave, so the scene is drawn at that size');
});

function floatingPanelGrips(testContext, extraOptions = {}) {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage, preferences: { panelsFloating: true }, ...extraOptions });
  const grips = {
    sceneWidth: ui.label('Resize Scene width'),
    sceneHeight: ui.label('Resize Scene height'),
    propertiesWidth: ui.label('Resize Properties width'),
    propertiesHeight: ui.label('Resize Properties height'),
  };
  const column = ui.root.querySelector('.crucible-studio-side');
  column.box = { left: 0, top: 68, width: 284, height: 900, right: 284, bottom: 968 };
  const savedPreferences = () => JSON.parse(saved.get('crucible-studio-preferences'));
  const drag = (grip, { fromX = 0, toX = 0, fromY = 0, toY = 0, ctrlKey = false }) => {
    dispatch(grip, 'pointerdown', { clientX: fromX, clientY: fromY });
    dispatch(grip, 'pointermove', { clientX: toX, clientY: toY, ctrlKey });
    dispatch(grip, 'pointerup', { clientX: toX, clientY: toY });
  };
  return { ui, grips, column, saved, savedPreferences, drag };
}

test('floating, each card resizes on its own: a left edge changes one width and a bottom edge one height', testContext => {
  const { ui, grips, drag, savedPreferences } = floatingPanelGrips(testContext);
  assert.equal(ui.root.dataset.floating, 'true');
  const scene = ui.root.querySelector('.crucible-studio-outliner');
  const properties = ui.root.querySelector('.crucible-studio-inspector');
  assert.ok(scene.children.includes(grips.sceneWidth) && scene.children.includes(grips.sceneHeight), 'the Scene card carries its own grips');
  assert.ok(properties.children.includes(grips.propertiesWidth) && properties.children.includes(grips.propertiesHeight), 'and so does the Properties card');
  for (const grip of Object.values(grips)) {
    assert.equal(grip.getAttribute('role'), 'separator');
    assert.ok(Number(grip.getAttribute('aria-valuemin')) < Number(grip.getAttribute('aria-valuemax')));
  }
  assert.equal(grips.sceneWidth.getAttribute('aria-orientation'), 'vertical');
  assert.equal(grips.propertiesHeight.getAttribute('aria-orientation'), 'horizontal');

  // Opens like the docked column: the same width for both cards, the Scene card sized by its share, Properties to the margin.
  assert.equal(ui.root.style['--studio-scene-width'], '284px');
  assert.equal(ui.root.style['--studio-properties-width'], '284px');
  assert.equal(ui.root.dataset.sceneHeightSized, 'false');
  assert.equal(ui.root.dataset.propertiesHeightSized, 'false');

  drag(grips.propertiesWidth, { fromX: 600, toX: 480 });
  assert.equal(ui.studio.preferences.propertiesWidth, 404, 'the Properties card is wider');
  assert.equal(ui.studio.preferences.sceneWidth, 0, 'and the Scene card is untouched');
  assert.equal(ui.studio.preferences.panelWidth, 284, 'so is the docked column width');
  assert.equal(ui.root.style['--studio-scene-width'], '284px');
  assert.equal(ui.root.style['--studio-properties-width'], '404px');
  assert.equal(grips.propertiesWidth.getAttribute('aria-valuenow'), '404');
  assert.equal(savedPreferences().propertiesWidth, 404);

  // Heights: the Properties card shortens and the Scene card keeps the height it came to.
  drag(grips.propertiesHeight, { fromY: 900, toY: 700 });
  assert.equal(ui.studio.preferences.propertiesHeight, 96, 'an unmeasured card starts from 240 and never goes below the least height');
  assert.equal(ui.root.dataset.propertiesHeightSized, 'true');
  assert.equal(ui.studio.preferences.sceneHeight, 0);

  properties.box = { left: 0, top: 394, width: 404, height: 500, right: 404, bottom: 894 };
  scene.box = { left: 0, top: 68, width: 284, height: 320, right: 284, bottom: 388 };
  ui.studio.setPreference('propertiesHeight', 0);
  drag(grips.propertiesHeight, { fromY: 900, toY: 700 });
  assert.equal(ui.studio.preferences.propertiesHeight, 300, 'a laid out card starts from its measured height');
  drag(grips.sceneHeight, { fromY: 388, toY: 548 });
  assert.equal(ui.studio.preferences.sceneHeight, 480, 'the Scene card is taller');
  assert.equal(ui.studio.preferences.propertiesHeight, 300, 'and the Properties card keeps its size');
  assert.equal(ui.root.style['--studio-scene-height'], '480px');
  assert.equal(ui.root.style['--studio-properties-height'], '300px');

  // No room: the dragged card stops where the other card and the gap leave it.
  scene.box = { left: 0, top: 68, width: 284, height: 480, right: 284, bottom: 548 };
  drag(grips.propertiesHeight, { fromY: 800, toY: 5000 });
  assert.equal(ui.studio.preferences.propertiesHeight, 900 - 480 - 6, 'Properties stops growing at the column bottom');
  drag(grips.sceneHeight, { fromY: 548, toY: 348 });
  assert.equal(ui.studio.preferences.sceneHeight, 280);
  scene.box = { left: 0, top: 68, width: 284, height: 280, right: 284, bottom: 348 };
  drag(grips.sceneHeight, { fromY: 348, toY: 5000 });
  assert.equal(ui.studio.preferences.sceneHeight, 900 - 414 - 6, 'the Scene card leaves Properties its height');
  assert.equal(ui.studio.preferences.propertiesHeight, 414, 'whose size did not change');
});

test('Ctrl on a width grip resizes both cards together and Ctrl on the Scene bottom edge is the docked split', testContext => {
  const { ui, grips, drag } = floatingPanelGrips(testContext, { preferences: { panelsFloating: true, propertiesWidth: 380, propertiesHeight: 300 } });
  assert.equal(ui.root.style['--studio-scene-width'], '284px');
  assert.equal(ui.root.style['--studio-properties-width'], '380px');
  drag(grips.sceneWidth, { fromX: 600, toX: 540, ctrlKey: true });
  assert.equal(ui.studio.preferences.sceneWidth, 344, 'both cards grow by the same amount');
  assert.equal(ui.studio.preferences.propertiesWidth, 440, 'and keep the difference between them');
  drag(grips.propertiesWidth, { fromX: 600, toX: 700, ctrlKey: true });
  assert.equal(ui.studio.preferences.sceneWidth, 244, 'either card grip works on both');
  assert.equal(ui.studio.preferences.propertiesWidth, 340);
  drag(grips.propertiesWidth, { fromX: 600, toX: 100, ctrlKey: true });
  assert.deepEqual([ui.studio.preferences.sceneWidth, ui.studio.preferences.propertiesWidth], [520, 520], 'each card stops at the widest');
  drag(grips.sceneWidth, { fromX: 600, toX: 640 });
  assert.equal(ui.studio.preferences.sceneWidth, 480);
  assert.equal(ui.studio.preferences.propertiesWidth, 520, 'without Ctrl the other card does not move');

  // Meta does the same on a Mac.
  dispatch(grips.sceneWidth, 'dblclick');
  dispatch(grips.propertiesWidth, 'dblclick');
  dispatch(grips.sceneWidth, 'pointerdown', { clientX: 600 });
  dispatch(grips.sceneWidth, 'pointermove', { clientX: 580, metaKey: true });
  dispatch(grips.sceneWidth, 'pointerup', { clientX: 580 });
  assert.deepEqual([ui.studio.preferences.sceneWidth, ui.studio.preferences.propertiesWidth], [304, 304]);

  // Ctrl on the bottom edge of the Scene card: it grows, Properties goes back to filling the rest.
  drag(grips.sceneHeight, { fromY: 300, toY: 340, ctrlKey: true });
  assert.equal(ui.studio.preferences.sceneHeight, 280);
  assert.equal(ui.studio.preferences.propertiesHeight, 0, 'the other card takes what the Scene card leaves');
  assert.equal(ui.root.dataset.propertiesHeightSized, 'false');
});

test('the card grips answer the arrow keys, with Ctrl for both cards, and a double click puts a card back to automatic', testContext => {
  const { ui, grips, savedPreferences } = floatingPanelGrips(testContext);
  const widen = dispatch(grips.sceneWidth, 'keydown', { key: 'ArrowLeft' });
  assert.equal(widen.defaultPrevented, true);
  assert.equal(ui.studio.preferences.sceneWidth, 300);
  assert.equal(ui.studio.preferences.propertiesWidth, 0);
  dispatch(grips.propertiesWidth, 'keydown', { key: 'ArrowLeft', ctrlKey: true });
  assert.equal(ui.studio.preferences.sceneWidth, 316);
  assert.equal(ui.studio.preferences.propertiesWidth, 300);
  dispatch(grips.propertiesWidth, 'keydown', { key: 'ArrowRight', metaKey: true });
  assert.deepEqual([ui.studio.preferences.sceneWidth, ui.studio.preferences.propertiesWidth], [300, 284]);
  assert.equal(dispatch(grips.sceneWidth, 'keydown', { key: 'a' }).defaultPrevented, false);
  assert.equal(dispatch(grips.sceneWidth, 'keydown', { key: 'ArrowDown' }).defaultPrevented, false, 'a vertical key does nothing on a width grip');

  dispatch(grips.sceneHeight, 'keydown', { key: 'ArrowDown' });
  assert.equal(ui.studio.preferences.sceneHeight, 264, 'an unmeasured card starts from 240 and a step is 24 pixels');
  dispatch(grips.propertiesHeight, 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.studio.preferences.propertiesHeight, 216);
  assert.equal(ui.studio.preferences.sceneHeight, 264, 'one card at a time');
  dispatch(grips.sceneHeight, 'keydown', { key: 'ArrowDown', ctrlKey: true });
  assert.equal(ui.studio.preferences.sceneHeight, 288);
  assert.equal(ui.studio.preferences.propertiesHeight, 0, 'Ctrl on the Scene card height is the split');

  dispatch(grips.sceneWidth, 'dblclick');
  assert.equal(ui.studio.preferences.sceneWidth, 0);
  assert.equal(ui.studio.preferences.propertiesWidth, 284, 'a double click resets only its own card');
  dispatch(grips.sceneHeight, 'dblclick');
  assert.equal(ui.studio.preferences.sceneHeight, 0);
  assert.equal(ui.root.dataset.sceneHeightSized, 'false');
  assert.equal(savedPreferences().sceneHeight, 0);
});

test('Ctrl or Meta with a double click on a card grip puts both cards back to automatic in that dimension', testContext => {
  const { ui, grips } = floatingPanelGrips(testContext, { preferences: { panelsFloating: true, sceneWidth: 400, propertiesWidth: 360, sceneHeight: 300, propertiesHeight: 280 } });
  dispatch(grips.sceneWidth, 'dblclick', { ctrlKey: true });
  assert.deepEqual([ui.studio.preferences.sceneWidth, ui.studio.preferences.propertiesWidth], [0, 0], 'both widths');
  assert.deepEqual([ui.studio.preferences.sceneHeight, ui.studio.preferences.propertiesHeight], [300, 280], 'the heights stay');
  dispatch(grips.propertiesHeight, 'dblclick', { metaKey: true });
  assert.deepEqual([ui.studio.preferences.sceneHeight, ui.studio.preferences.propertiesHeight], [0, 0], 'both heights');

  dispatch(grips.sceneWidth, 'keydown', { key: 'ArrowLeft' });
  dispatch(grips.propertiesWidth, 'keydown', { key: 'ArrowLeft' });
  dispatch(grips.propertiesWidth, 'dblclick');
  assert.equal(ui.studio.preferences.propertiesWidth, 0);
  assert.equal(ui.studio.preferences.sceneWidth, 300, 'a plain double click still resets one card');
});

test('card sizes are saved, pulled back into their limits on load, and leave the docked column alone', testContext => {
  const { ui, grips, saved, savedPreferences, drag } = floatingPanelGrips(testContext);
  drag(grips.sceneWidth, { fromX: 600, toX: 540 });
  drag(grips.sceneHeight, { fromY: 300, toY: 340 });
  assert.equal(savedPreferences().sceneWidth, 344);
  assert.equal(savedPreferences().sceneHeight, 280);
  assert.equal(savedPreferences().panelWidth, 284, 'the docked width is not written by a floating drag');
  assert.equal(savedPreferences().sceneShare, 0);

  const next = mountStudio(testContext, { preferenceStorage: { getItem: key => saved.get(key) ?? null, setItem: () => {} }, sharedDom: ui.dom });
  assert.equal(next.studio.preferences.sceneWidth, 344, 'the next visit keeps the card sizes');
  assert.equal(next.studio.preferences.sceneHeight, 280);

  const clamped = mountStudio(testContext, { sharedDom: ui.dom, preferences: { sceneWidth: 9000, propertiesWidth: 10, sceneHeight: 99999, propertiesHeight: 5 } });
  assert.equal(clamped.studio.preferences.sceneWidth, 520);
  assert.equal(clamped.studio.preferences.propertiesWidth, 240, 'a saved width below the least is pulled up, not read as automatic');
  assert.equal(clamped.studio.preferences.sceneHeight, 1600);
  assert.equal(clamped.studio.preferences.propertiesHeight, 96);
  const broken = mountStudio(testContext, { sharedDom: ui.dom, preferences: { sceneWidth: Number.NaN, propertiesWidth: '300', sceneHeight: null, propertiesHeight: undefined } });
  assert.deepEqual([broken.studio.preferences.sceneWidth, broken.studio.preferences.propertiesWidth, broken.studio.preferences.sceneHeight, broken.studio.preferences.propertiesHeight], [0, 0, 0, 0], 'bad values fall back to automatic');
});

test('docked keeps one column width and one split, whatever the floating cards were sized to', testContext => {
  const { ui, grips } = floatingPanelGrips(testContext, { preferences: { panelsFloating: true, panelWidth: 300, sceneShare: 40, sceneWidth: 500, propertiesHeight: 300 } });
  ui.studio.setPreference('panelsFloating', false);
  assert.equal(ui.root.dataset.floating, 'false');
  assert.equal(ui.studio.preferences.panelWidth, 300);
  assert.equal(ui.studio.preferences.sceneShare, 40);
  assert.equal(ui.studio.preferences.sceneWidth, 500, 'the floating sizes are kept for the way back');
  assert.equal(ui.root.style['--studio-side-width'], '300px', 'the column is as wide as the docked width says');
  const docked = '.crucible-studio[data-floating="false"]:not([data-compact="true"])';
  assert.ok(STUDIO_CSS.includes(`${docked} .crucible-studio-side > .crucible-studio-dock {
  inline-size: auto;`), 'docked cards fill the column, not their floating width');
  const cardGripRule = STUDIO_CSS.slice(STUDIO_CSS.indexOf('.crucible-studio[data-floating="false"] .crucible-studio-grip-card-width'));
  assert.ok(cardGripRule.slice(0, cardGripRule.indexOf('{')).includes('.crucible-studio[data-floating="true"] .crucible-studio-grip-width'), 'each layout hides the other layout\'s grips');
  assert.ok(STUDIO_CSS.includes('.crucible-studio[data-floating="true"][data-scene-height-sized="true"]'), 'saved card heights apply only floating');

  // Dragging the docked grips still writes the docked values only.
  dispatch(ui.label('Panel width'), 'pointerdown', { clientX: 600 });
  dispatch(ui.label('Panel width'), 'pointermove', { clientX: 580 });
  dispatch(ui.label('Panel width'), 'pointerup', { clientX: 580 });
  assert.equal(ui.studio.preferences.panelWidth, 320);
  assert.equal(ui.studio.preferences.sceneWidth, 500);
  assert.equal(grips.sceneWidth.getAttribute('aria-valuenow'), '500');
});

test('the axis widget stands at the top right of the viewport, beside the panel column, in both layouts', testContext => {
  const rule = selector => {
    const start = STUDIO_CSS.indexOf(`${selector} {`);
    assert.ok(start >= 0, `a rule for ${selector}`);
    return STUDIO_CSS.slice(start, STUDIO_CSS.indexOf('}', start));
  };
  const floating = rule('.crucible-studio-view-widget');
  assert.ok(floating.includes('inset-block-start: var(--studio-top);'), 'level with the top of the Scene card');
  assert.ok(floating.includes('inset-inline-end: calc(var(--studio-edge) + var(--studio-gizmo-clear, 0px));'), 'left of the cards, one edge gap from them');
  assert.ok(!floating.includes('inset-block-end'), 'no longer in the bottom corner');
  assert.ok(STUDIO_CSS.includes('.crucible-studio {\n  --studio-gizmo-clear: calc(var(--studio-scene-width, 284px) + var(--studio-edge));\n}'), 'it follows the Scene card width');
  assert.ok(STUDIO_CSS.includes('[data-outliner-minimized="true"]:not([data-inspector-collapsed="true"]) {\n  --studio-gizmo-clear: calc(max(var(--studio-scene-width, 284px), var(--studio-properties-width, 284px))'), 'a short minimized Scene card leaves a wider Properties card the room under the widget');
  assert.ok(rule('.crucible-studio[data-outliner-collapsed="true"][data-inspector-collapsed="true"][data-history-collapsed="true"]').includes('--studio-gizmo-clear: 0px;'), 'with both cards away it takes the corner');
  const docked = rule('.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-view-widget');
  assert.ok(docked.includes('inset-inline-end: var(--studio-edge);') && docked.includes('inset-block-start: var(--studio-edge);'), 'docked, the viewport already ends at the column, so the widget takes its corner');
  assert.ok(rule('.crucible-studio[data-compact="true"] .crucible-studio-view-widget').includes('inset-inline-end: var(--studio-edge);'), 'a compact window keeps it in the corner under the bar, clear of the cards');

  // The widget no longer needs a gap under the Properties card.
  const column = rule('.crucible-studio-side');
  assert.ok(column.includes('inset-block: var(--studio-top) var(--studio-edge);'), 'Properties runs down to the bottom margin');
  assert.ok(!column.includes('100px'));
  assert.ok(rule('.crucible-studio[data-workspace="animate"] .crucible-studio-readout,\n.crucible-studio[data-workspace="animate"] .crucible-studio-side').includes('inset-block-end: calc(var(--studio-edge) + var(--studio-bar-clear));'), 'the timeline bar still has its room in Animate');

  const ui = mountStudio(testContext, { preferences: { panelsFloating: true } });
  assert.ok(ui.viewport.children.includes(ui.root.querySelector('.crucible-studio-view-widget')), 'the widget lives in the viewport');
  ui.studio.setPreference('viewWidgetVisible', false);
  assert.equal(ui.root.dataset.viewWidget, 'off');
});

test('G picks the selected object up under the pointer; X locks an axis, Esc puts it back and a click places it', testContext => {
  const ui = mountStudio(testContext);
  const hintBar = ui.root.querySelector('.crucible-studio-hintbar');
  const heroNode = () => ui.controller.exportRecipe().nodes.find(node => node.id === ui.controller.selectedNodeId);
  const press = key => dispatch(ui.dom.document, 'keydown', { key });

  // With nothing selected, or the pointer away from the viewport, the key only switches the tool.
  press('g');
  assert.equal(ui.root.dataset.modal, undefined);
  ui.controller.selectNode(ui.controller.exportRecipe().nodes[0].id);
  press('g');
  assert.equal(ui.root.dataset.modal, undefined);

  const before = structuredClone(heroNode().translation);
  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  press('g');
  assert.equal(ui.root.dataset.modal, 'translate');
  assert.equal(ui.controller.dragging, true);
  dispatch(ui.dom.document, 'pointermove', { clientX: 380, clientY: 150 });
  assert.notDeepEqual(heroNode().translation, before);
  assert.equal(hintBar.querySelectorAll('kbd').filter(key => key.getAttribute('aria-pressed') === 'true').length, 0);

  press('x');
  const pressed = hintBar.querySelectorAll('kbd').filter(key => key.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map(key => key.textContent), ['X']);
  assert.equal(heroNode().translation[1], before[1]);
  assert.equal(heroNode().translation[2], before[2]);
  press('x');
  assert.equal(hintBar.querySelectorAll('kbd').filter(key => key.getAttribute('aria-pressed') === 'true').length, 0);

  press('Escape');
  assert.equal(ui.root.dataset.modal, undefined);
  assert.deepEqual(heroNode().translation, before);
  assert.equal(ui.controller.canUndo, false);
  assert.equal(hintBar.textContent, '');

  // Placed with a click: one undo step takes the whole move back, axis changes included.
  press('g');
  dispatch(ui.dom.document, 'pointermove', { clientX: 380, clientY: 150 });
  press('y');
  press('z');
  dispatch(ui.dom.document, 'pointermove', { clientX: 420, clientY: 120 });
  const placing = dispatch(ui.dom.document, 'pointerdown', { button: 0, clientX: 420, clientY: 120 });
  assert.equal(placing.defaultPrevented, true);
  assert.equal(ui.root.dataset.modal, undefined);
  assert.notDeepEqual(heroNode().translation, before);
  ui.controller.undo();
  assert.deepEqual(heroNode().translation, before);
  assert.equal(ui.controller.canUndo, false);

  // R while holding swaps the tool; a right press cancels.
  press('s');
  assert.equal(ui.root.dataset.modal, 'scale');
  press('r');
  assert.equal(ui.root.dataset.modal, 'rotate');
  assert.equal(ui.controller.tool, 'rotate');
  dispatch(ui.dom.document, 'pointerdown', { button: 2, clientX: 420, clientY: 120 });
  assert.equal(ui.root.dataset.modal, undefined);
  assert.equal(ui.controller.canUndo, false);
});

test('typed digits set the amount of a held move, turn or scale, and Shift with an axis keeps the move on a plane', testContext => {
  const ui = mountStudio(testContext);
  const hintBar = ui.root.querySelector('.crucible-studio-hintbar');
  const heroNode = () => ui.controller.exportRecipe().nodes.find(node => node.id === ui.controller.selectedNodeId);
  const press = (key, modifiers = {}) => dispatch(ui.dom.document, 'keydown', { key, ...modifiers });
  const pressAll = keys => keys.forEach(key => press(key));
  ui.controller.selectNode(ui.controller.exportRecipe().nodes[0].id);
  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  const before = structuredClone(heroNode().translation);

  // G X 2 Enter moves 2 m along X in one undo step, whatever the pointer does.
  pressAll(['g', 'x', '2']);
  dispatch(ui.dom.document, 'pointermove', { clientX: 380, clientY: 150 });
  assert.match(hintBar.textContent, /= 2 m/);
  assert.deepEqual(heroNode().translation, [before[0] + 2, before[1], before[2]]);
  press('.');
  press('5');
  assert.equal(heroNode().translation[0], before[0] + 2.5);
  press('Backspace');
  press('Backspace');
  assert.equal(heroNode().translation[0], before[0] + 2);
  press('-');
  assert.equal(heroNode().translation[0], before[0] - 2);
  press('Enter');
  assert.equal(ui.root.dataset.modal, undefined);
  assert.equal(heroNode().translation[0], before[0] - 2);
  ui.controller.undo();
  assert.deepEqual(heroNode().translation, before);
  assert.equal(ui.controller.canUndo, false);

  // An amount typed before the axis survives the lock; Esc puts everything back.
  pressAll(['g', '3', 'x']);
  assert.equal(heroNode().translation[0], before[0] + 3);
  press('Escape');
  assert.deepEqual(heroNode().translation, before);

  // Shift+Y keeps the move on the ground plane: the height does not change, the pointer sets X and Z.
  press('g');
  dispatch(ui.dom.document, 'pointermove', { clientX: 380, clientY: 150 });
  press('Y', { shiftKey: true });
  assert.deepEqual(hintBar.querySelectorAll('kbd').filter(key => key.getAttribute('aria-pressed') === 'true').map(key => key.textContent), ['X', 'Z']);
  dispatch(ui.dom.document, 'pointermove', { clientX: 420, clientY: 120 });
  assert.equal(heroNode().translation[1], before[1]);
  assert.notEqual(heroNode().translation[0], before[0]);
  pressAll(['4']);
  assert.deepEqual(heroNode().translation, [before[0] + 4, before[1], before[2] + 4]);
  press('Escape');

  // Rotate takes degrees and scale takes a factor.
  const beforeScale = structuredClone(heroNode().scale ?? [1, 1, 1]);
  pressAll(['s', '2']);
  assert.deepEqual(heroNode().scale, beforeScale.map(value => value * 2));
  press('Enter');
  ui.controller.undo();
  pressAll(['r', 'y', '9', '0']);
  const [, turned, , turnedW] = heroNode().rotation;
  assert.ok(Math.abs(turned - Math.sin(Math.PI / 4)) < 1e-3 && Math.abs(turnedW - Math.cos(Math.PI / 4)) < 1e-3, 'ninety degrees about Y');
  press('Enter');
  ui.controller.undo();
  assert.equal(ui.controller.canUndo, false);
});

test('a right click on an object opens its menu; H hides, Alt+H shows all and Alt+G, R and S reset the transform', testContext => {
  const ui = mountStudio(testContext);
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  const heroNode = () => ui.controller.exportRecipe().nodes.find(node => node.id === 'hero');
  const press = (key, modifiers = {}) => dispatch(ui.dom.document, 'keydown', { key, ...modifiers });
  assert.deepEqual(menu.querySelectorAll('button').map(button => button.textContent), ['Frame', 'Rename', 'Duplicate', 'Hide', 'Reset position', 'Reset rotation', 'Reset scale', 'Apply…', 'Set origin…', 'Delete']);

  // In the Scene list the row is selected first, then the menu opens on it.
  const heroRow = ui.rows().find(row => row.textContent.includes(heroNode().label ?? 'hero'));
  const opened = dispatch(heroRow.querySelector('.crucible-studio-tree-select'), 'contextmenu', { clientX: 900, clientY: 120 });
  assert.equal(opened.defaultPrevented, true);
  assert.equal(ui.controller.selectedNodeId, 'hero');
  assert.equal(menu.popoverOpen, true);
  assert.equal(menu.style.left, '900px');
  assert.equal(menu.style.top, '120px');

  byText(menu, 'Hide').click();
  assert.equal(menu.popoverOpen, false);
  assert.equal(heroNode().visible, false);
  press('h', { altKey: true });
  assert.notEqual(heroNode().visible, false);
  assert.match(ui.status(), /Showing 1 hidden object/);
  press('h');
  assert.equal(heroNode().visible, false);
  ui.controller.undo();
  assert.notEqual(heroNode().visible, false);
  press('h', { altKey: true });
  assert.equal(ui.status(), 'Nothing is hidden');

  ui.controller.updateNodeTransform('hero', { translation: [2, 3, 4], scale: [2, 2, 2], rotation: [0, 0.7071068, 0, 0.7071068] });
  press('g', { altKey: true });
  assert.deepEqual(heroNode().translation, [0, 0, 0]);
  assert.equal(ui.root.dataset.modal, undefined);
  press('r', { altKey: true });
  assert.deepEqual(heroNode().rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
  byText(menu, 'Reset scale').click();
  assert.deepEqual(heroNode().scale ?? [1, 1, 1], [1, 1, 1]);
  assert.equal(ui.status(), 'Scale reset');
});

test('the press that ends a held move reaches nothing under it, and held or modified keys leave the lock alone', testContext => {
  const ui = mountStudio(testContext);
  const hintBar = ui.root.querySelector('.crucible-studio-hintbar');
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  const press = (key, modifiers = {}) => dispatch(ui.dom.document, 'keydown', { key, ...modifiers });
  const lockedKeys = () => hintBar.querySelectorAll('kbd').filter(key => key.getAttribute('aria-pressed') === 'true').map(key => key.textContent);
  const hold = key => {
    dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
    press(key);
    dispatch(ui.dom.document, 'pointermove', { clientX: 360, clientY: 170 });
  };
  ui.controller.selectNode('hero');
  const nodeCount = ui.controller.exportRecipe().nodes.length;

  hold('g');
  press('x');
  press('x', { repeat: true });
  assert.deepEqual(lockedKeys(), ['X']);
  press('z', { ctrlKey: true });
  press('s', { ctrlKey: true });
  assert.deepEqual(lockedKeys(), ['X']);
  assert.equal(ui.root.dataset.modal, 'translate');

  // Placed over the Delete button: the click that follows the press must not delete the object.
  const deleteButton = ui.label('Delete (Del)');
  dispatch(ui.dom.document, 'pointerdown', { button: 0, clientX: 900, clientY: 300 });
  const strayClick = dispatch(deleteButton, 'click', {});
  assert.equal(strayClick.defaultPrevented, true);
  assert.equal(ui.controller.exportRecipe().nodes.length, nodeCount);
  assert.equal(ui.controller.canUndo, true);

  // Enter places too.
  hold('r');
  press('Enter');
  assert.equal(ui.root.dataset.modal, undefined);

  // A right press on a handle cancels and its context menu does not open the object's menu.
  hold('s');
  dispatch(ui.dom.document, 'pointerdown', { button: 2, clientX: 300, clientY: 200 });
  const swallowed = dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(swallowed.defaultPrevented, true);
  assert.notEqual(menu.popoverOpen, true);
  // The next right click on a handle is a real one.
  dispatch(ui.dom.document, 'pointerdown', { button: 2, clientX: 300, clientY: 200 });
  dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(menu.popoverOpen, true);

  // A middle press cancels and leaves the next right click alone.
  menu.hidePopover();
  hold('g');
  dispatch(ui.dom.document, 'pointerdown', { button: 1, clientX: 300, clientY: 200 });
  assert.equal(ui.root.dataset.modal, undefined);
  dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(menu.popoverOpen, true);

  // The window losing focus lets go.
  const windowListeners = new Map();
  ui.dom.document.defaultView.addEventListener = (type, listener) => windowListeners.set(type, listener);
  ui.dom.document.defaultView.removeEventListener = type => windowListeners.delete(type);
  const beforeBlur = structuredClone(ui.controller.exportRecipe().nodes.find(node => node.id === 'hero').translation);
  hold('g');
  windowListeners.get('blur')();
  assert.equal(ui.root.dataset.modal, undefined);
  assert.equal(windowListeners.has('blur'), false);
  assert.deepEqual(ui.controller.exportRecipe().nodes.find(node => node.id === 'hero').translation, beforeBlur);
});

test('a right click on an object in the viewport selects it and opens its menu; a right drag only pans', testContext => {
  const ui = mountStudio(testContext);
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  ui.controller.selectNode('hero');
  const onHero = ui.clientPoint(ui.controller.projectWorldPoint(ui.controller.gizmoHandles().pivot));
  ui.controller.selectNode(null);

  dispatch(ui.canvas, 'pointerdown', { button: 2, pointerId: 3, ...onHero });
  dispatch(ui.canvas, 'pointermove', { clientX: onHero.clientX + 60, clientY: onHero.clientY + 40 });
  dispatch(ui.canvas, 'pointerup', { button: 2, clientX: onHero.clientX + 60, clientY: onHero.clientY + 40 });
  ui.dom.runTimers();
  assert.notEqual(menu.popoverOpen, true);

  ui.controller.selectNode(null);
  const heroNow = (() => {
    ui.controller.selectNode('hero');
    const point = ui.clientPoint(ui.controller.projectWorldPoint(ui.controller.gizmoHandles().pivot));
    ui.controller.selectNode(null);
    return point;
  })();
  dispatch(ui.canvas, 'pointerdown', { button: 2, pointerId: 4, ...heroNow });
  dispatch(ui.canvas, 'pointerup', { button: 2, ...heroNow });
  assert.equal(ui.controller.selectedNodeId, 'hero');
  ui.dom.runTimers();
  assert.equal(menu.popoverOpen, true);
  assert.equal(menu.style.left, `${Math.round(heroNow.clientX)}px`);
});

test('menu rows start with their icon or an empty square, so the labels line up', testContext => {
  const ui = mountStudio(testContext);
  const menuIds = ['crucible-studio-pop-new', 'crucible-studio-pop-edit', 'crucible-studio-pop-object', 'crucible-studio-pop-view', 'crucible-studio-pop-help'];
  for (const menuId of menuIds) {
    const menu = ui.root.descendants().find(element => element.id === menuId);
    const rows = menu.children.filter(element => element.tagName === 'BUTTON');
    assert.ok(rows.length > 0, menuId);
    for (const row of rows) {
      const lead = row.children[0];
      const leadClass = lead.getAttribute('class') ?? lead.className;
      assert.match(String(leadClass), /crucible-studio-icon|crucible-studio-menu-gap/, `${menuId}: ${row.textContent}`);
    }
  }
});

test('each handle answers a press well outside what is drawn, and a drawn handle still lies on top', testContext => {
  const ui = mountStudio(testContext);
  const hitAreas = () => ui.gizmo.descendants().filter(element => element.getAttribute('data-gizmo-hit'));
  const axesOf = kind => hitAreas().filter(element => element.getAttribute('data-gizmo-hit') === kind).map(element => element.getAttribute('data-gizmo-axis'));
  ui.tool('translate').click();
  ui.studio.renderNow();
  assert.deepEqual(axesOf('line'), ['x', 'y', 'z']);
  assert.deepEqual(axesOf('disc'), ['x', 'y', 'z', 'screen']);
  const parts = ui.gizmo.descendants().filter(element => element.getAttribute('data-gizmo-axis'));
  const lastHit = Math.max(...hitAreas().map(element => parts.indexOf(element)));
  const firstDrawn = parts.findIndex(element => !element.getAttribute('data-gizmo-hit'));
  assert.ok(lastHit < firstDrawn, 'unseen areas come first, so drawn handles win a press');
  assert.ok(Number(hitAreas().find(element => element.getAttribute('data-gizmo-hit') === 'disc').getAttribute('r')) >= 13);
  assert.ok(STUDIO_CSS.includes('[data-gizmo-hit="line"] { stroke-width: 22px !important; }'));
  ui.tool('scale').click();
  ui.studio.renderNow();
  assert.deepEqual(axesOf('disc'), ['x', 'y', 'z', 'uniform']);
  ui.tool('rotate').click();
  ui.studio.renderNow();
  assert.deepEqual(axesOf('line'), ['x', 'y', 'z']);
  assert.deepEqual(axesOf('disc'), []);
});

test('the Animated camera row shows only when a track drives the camera, and switches the free view', testContext => {
  const viewRow = ui => ui.root.descendants().find(element => element.getAttribute('role') === 'menuitemcheckbox' && element.textContent === 'Animated camera');
  const openViewMenu = ui => dispatch(ui.root.descendants().find(element => element.id === 'crucible-studio-pop-view'), 'toggle');
  const plain = mountStudio(testContext);
  openViewMenu(plain);
  assert.equal(viewRow(plain).hidden, true);

  const drivenRecipe = makeRecipe();
  drivenRecipe.motion = {
    duration: 4,
    loop: false,
    tracks: [{ kind: 'camera', property: 'fov', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 40 }, { time: 4, value: 30 }] }],
  };
  const sharedDom = plain.dom;
  const driven = mountStudio(testContext, { recipe: drivenRecipe, sharedDom });
  openViewMenu(driven);
  const row = viewRow(driven);
  assert.equal(row.hidden, false);
  assert.equal(row.getAttribute('aria-checked'), 'true');
  const sceneEye = Array.from(driven.controller.scene.camera.eye);
  row.click();
  assert.equal(driven.controller.freeView, true);
  assert.equal(row.getAttribute('aria-checked'), 'false');
  assert.deepEqual([...driven.controller.viewCamera.eye], sceneEye, 'the free view starts where the animated camera stands');
  driven.controller.orbitCamera({ zoomScale: 0.5 });
  driven.studio.renderNow();
  assert.deepEqual([...driven.renderer.frames.at(-1).eye], [...driven.controller.viewCamera.eye], 'the frame is drawn from the free view');
  assert.deepEqual(Array.from(driven.controller.scene.camera.eye), sceneEye);
  row.click();
  assert.equal(driven.controller.freeView, false);
  assert.equal(row.getAttribute('aria-checked'), 'true');
});

test('the Export workspace draws the viewport as the saved shot: the scene camera, no grid, and the free view comes back after it (#3343)', testContext => {
  const drivenRecipe = makeRecipe();
  drivenRecipe.motion = {
    duration: 4,
    loop: false,
    tracks: [{ kind: 'camera', property: 'fov', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 40 }, { time: 4, value: 30 }] }],
  };
  const ui = mountStudio(testContext, { recipe: drivenRecipe });
  const sceneParts = ui.controller.scene.parts.length;
  const sceneEye = Array.from(ui.controller.scene.camera.eye);
  ui.controller.moveViewportCamera({ eye: [9, 9, 9], target: [0, 0, 0] });
  ui.studio.renderNow();
  assert.deepEqual([...ui.renderer.frames.at(-1).eye], [9, 9, 9], 'Build draws the free view');
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT, 'Build draws the grid');
  assert.ok(ui.renderer.frames.at(-1).near !== undefined, 'Build widens the clip planes');

  byDataset(ui.root, 'workspace', 'export').click();
  ui.studio.renderNow();
  assert.deepEqual([...ui.renderer.frames.at(-1).eye], sceneEye, 'Export draws the scene camera, which is what a PNG uses');
  assert.equal(ui.renderer.partCount, sceneParts, 'Export leaves the grid out, as the saved image does');
  assert.equal(ui.renderer.frames.at(-1).near, ui.controller.scene.camera.near, 'Export keeps the scene camera clip planes');
  assert.equal(ui.controller.freeView, true, 'the free view is kept while Export is open');

  byDataset(ui.root, 'workspace', 'build').click();
  ui.studio.renderNow();
  assert.deepEqual([...ui.renderer.frames.at(-1).eye], [9, 9, 9], 'leaving Export brings the free view back');
  assert.equal(ui.renderer.partCount, sceneParts + GRID_LINE_COUNT, 'and the grid');
});

test('the scene list shows the camera, the sun and each light above the nodes, selects them and honours the filter', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  ui.controller.addSceneLight('spot');
  ui.controller.addSceneLight('area');
  assert.deepEqual(ui.objectLabels(), ['Camera', 'Sun', 'Point light', 'Spot light', 'Area light']);
  const tree = ui.rows()[0].parentNode;
  assert.deepEqual(tree.children.slice(0, 5).map(row => row.dataset.sceneObject), ['camera', 'sun', 'point:0', 'spot:0', 'area:0'], 'the object rows come first');
  assert.equal(tree.children.length, 8);
  assert.ok(ui.objectRows().every(row => row.getAttribute('role') === 'treeitem' && row.querySelector('.crucible-studio-tree-eye') === null));
  assert.deepEqual(ui.objectRows().map(row => row.querySelector('.crucible-studio-tree-badge').getAttribute('data-shape')), ['camera', 'sun', 'pointLight', 'spotLight', 'areaLight']);

  ui.objectRows()[0].querySelector('.crucible-studio-tree-select').click();
  assert.equal(ui.controller.selectedObjectKey, 'camera');
  assert.equal(ui.controller.selectedNodeId, null);
  assert.equal(ui.objectRows()[0].getAttribute('aria-selected'), 'true');
  assert.equal(ui.rows().filter(row => row.dataset.selected === 'true').length, 0, 'no node row stays selected');
  assert.equal(ui.tab('camera').getAttribute('aria-selected'), 'true');

  ui.objectRows()[3].querySelector('.crucible-studio-tree-select').click();
  assert.equal(ui.controller.selectedObjectKey, 'spot:0');
  assert.equal(ui.objectRows()[0].getAttribute('aria-selected'), 'false');
  assert.equal(ui.objectRows()[3].getAttribute('aria-selected'), 'true');
  assert.equal(ui.tab('look').getAttribute('aria-selected'), 'true');

  ui.selectRow('hero');
  assert.equal(ui.controller.selectedObjectKey, null);
  assert.equal(ui.objectRows().filter(row => row.dataset.selected === 'true').length, 0);

  const search = ui.label('Filter the scene list');
  search.value = 'SPOT';
  dispatch(search, 'input');
  assert.deepEqual(ui.objectLabels(), ['Spot light']);
  assert.deepEqual(ui.rowLabels(), []);
  search.value = 'orb';
  dispatch(search, 'input');
  assert.deepEqual(ui.objectLabels(), []);
  assert.deepEqual(ui.rowLabels(), ['orb']);
});

test('a light has a mark in the viewport that selects it and drags it in the plane facing the view', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  ui.controller.moveSceneObject('point:0', [1, 1.5, 1]);
  ui.studio.renderNow();
  const markOf = key => ui.gizmo.descendants().find(element => element.getAttribute('data-scene-object') === key && element.tagName.toLowerCase() === 'circle');
  assert.ok(markOf('sun'), 'the sun has a mark');
  assert.equal(markOf('camera'), undefined, 'the camera you look through is not drawn');
  assert.ok(markOf('point:0'));
  assert.ok(ui.gizmo.querySelector('.crucible-studio-scene-mark-ray'), 'the sun points along its light');

  const lightPosition = ui.controller.listSceneObjects().find(object => object.key === 'point:0').position;
  const grab = ui.controller.projectWorldPoint(lightPosition);
  const down = dispatch(markOf('point:0'), 'pointerdown', { ...ui.clientPoint(grab), pointerId: 6 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.propagationStopped, true);
  assert.equal(ui.controller.selectedObjectKey, 'point:0');
  assert.equal(ui.controller.selectedNodeId, null);
  assert.equal(ui.tab('look').getAttribute('aria-selected'), 'true');
  ui.studio.renderNow();
  assert.equal(ui.gizmo.querySelector('.crucible-studio-scene-mark[data-selected="true"]').children[0].getAttribute('data-scene-object'), 'point:0');

  const release = { x: grab.x + 80, y: grab.y };
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(release));
  const moved = ui.studio.exportRecipe().environment.pointLights[0].position;
  assert.ok(moved[0] > lightPosition[0] || moved[2] !== lightPosition[2], 'the light followed the pointer');
  const projectedAfter = ui.controller.projectWorldPoint(moved);
  assert.ok(Math.abs(projectedAfter.x - release.x) < 1 && Math.abs(projectedAfter.y - release.y) < 1, 'the light sits under the pointer');
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: release.x + 20, y: release.y }));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(release));
  assert.equal(ui.studio.dirty, true);
  ui.controller.undo();
  assert.deepEqual(ui.studio.exportRecipe().environment.pointLights[0].position, lightPosition, 'one undo puts the light back after the whole drag');

  ui.tool('select').click();
  const stillDown = dispatch(markOf('point:0') ?? ui.gizmo.descendants().find(element => element.getAttribute('data-scene-object') === 'point:0'), 'pointerdown', { ...ui.clientPoint(grab), pointerId: 7 });
  assert.equal(stillDown.defaultPrevented, true);
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(release));
  assert.deepEqual(ui.studio.exportRecipe().environment.pointLights[0].position, lightPosition, 'only the move tool drags a light');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(release));
});

test('a light that a track moves refuses the drag and says why', testContext => {
  const recipe = makeRecipe();
  recipe.environment = { setup: 'studio', lightDirection: [-2, 5, 3], pointLights: [{ position: [1, 1.5, 1], color: [1, 1, 1], intensity: 2, radius: 0.1, range: 12, castShadow: false }] };
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [{ kind: 'light', id: 'point:0', property: 'position', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [1, 1.5, 1] }, { time: 2, value: [1, 1.5, 2] }] }],
  };
  const ui = mountStudio(testContext, { recipe });
  const mark = ui.gizmo.descendants().find(element => element.getAttribute('data-scene-object') === 'point:0');
  const grab = ui.controller.projectWorldPoint([1, 1.5, 1]);
  dispatch(mark, 'pointerdown', { ...ui.clientPoint(grab), pointerId: 8 });
  dispatch(ui.canvas, 'pointermove', ui.clientPoint({ x: grab.x + 60, y: grab.y }));
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(grab));
  assert.deepEqual(ui.studio.exportRecipe().environment.pointLights[0].position, [1, 1.5, 1]);
  assert.match(ui.status(), /point:0 light position is animated/);
});

test('the camera is drawn once the view looks away from it', testContext => {
  const recipe = makeRecipe();
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [{ kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 2, 6] }, { time: 2, value: [1, 2, 6] }] }],
  };
  const ui = mountStudio(testContext, { recipe });
  const cameraMark = () => ui.gizmo.descendants().find(element => element.getAttribute('data-scene-object') === 'camera');
  assert.equal(cameraMark(), undefined);
  ui.controller.orbitCamera({ zoomScale: 2 });
  ui.studio.renderNow();
  assert.ok(cameraMark(), 'the scene camera shows once the view is free');
  dispatch(cameraMark(), 'pointerdown', { ...ui.clientPoint(ui.controller.projectWorldPoint([0, 2, 6])), pointerId: 9 });
  assert.equal(ui.controller.selectedObjectKey, 'camera');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint({ x: 0, y: 0 }));
  assert.equal(ui.tab('camera').getAttribute('aria-selected'), 'true');
});

test('Delete removes the selected light, and the camera and sun stay', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  ui.controller.addSceneLight('spot');
  const press = (key, properties = {}) => dispatch(ui.dom.document, 'keydown', { key, ...properties });
  ui.objectRows()[2].querySelector('.crucible-studio-tree-select').click();
  assert.equal(ui.label('Delete (Del)').getAttribute('aria-disabled'), 'false');
  press('Delete');
  assert.deepEqual(ui.objectLabels(), ['Camera', 'Sun', 'Spot light']);
  assert.equal(ui.status(), 'Deleted Point light');
  assert.equal(ui.controller.selectedObjectKey, null);
  assert.equal(ui.studio.exportRecipe().nodes.length, 3, 'no node went with it');

  ui.objectRows()[2].querySelector('.crucible-studio-tree-select').click();
  ui.label('Delete (Del)').click();
  assert.deepEqual(ui.objectLabels(), ['Camera', 'Sun']);

  ui.objectRows()[1].querySelector('.crucible-studio-tree-select').click();
  assert.equal(ui.label('Delete (Del)').getAttribute('aria-disabled'), 'true');
  press('Delete');
  assert.deepEqual(ui.objectLabels(), ['Camera', 'Sun']);
  press('Escape');
  assert.equal(ui.controller.selectedObjectKey, null);
  ui.controller.undo();
  assert.deepEqual(ui.objectLabels(), ['Camera', 'Sun', 'Spot light']);
});

function selectSceneObjectRow(ui, key) {
  const row = ui.objectRows().find(candidate => candidate.dataset.sceneObject === key);
  row.querySelector('.crucible-studio-tree-select').click();
}

function editNumber(ui, label, value) {
  const input = ui.label(label);
  input.value = String(value);
  dispatch(input, 'change');
}

function countUndoSteps(controller) {
  let steps = 0;
  while (controller.undo()) steps += 1;
  while (controller.redo());
  return steps;
}

test('selecting a light opens its properties, and each control writes its field as one undo step', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  ui.controller.addSceneLight('spot');
  ui.controller.addSceneLight('area');
  assert.equal(countUndoSteps(ui.controller), 3);

  selectSceneObjectRow(ui, 'point:0');
  assert.equal(ui.controller.activeTab, 'look');
  const lightOf = key => {
    const [kind, index] = key.split(':');
    return ui.studio.exportRecipe().environment[`${kind}Lights`][Number(index)];
  };
  const expectOneStep = (key, edit, check) => {
    const before = ui.studio.exportRecipe();
    edit();
    check(lightOf(key));
    assert.equal(ui.controller.undo(), true);
    assert.deepEqual(ui.studio.exportRecipe(), before, 'one undo reverts the edit');
    ui.controller.redo();
    check(lightOf(key));
  };

  expectOneStep('point:0', () => editNumber(ui, 'Intensity', 6), light => assert.equal(light.intensity, 6));
  expectOneStep('point:0', () => editNumber(ui, 'Radius', 0.3), light => assert.equal(light.radius, 0.3));
  expectOneStep('point:0', () => editNumber(ui, 'Range', 20), light => assert.equal(light.range, 20));
  expectOneStep('point:0', () => editNumber(ui, 'Light position Y', 4.5), light => assert.equal(light.position[1], 4.5));
  expectOneStep('point:0', () => ui.button('Soft falloff').click(), light => assert.equal(light.softFalloff, true));
  expectOneStep('point:0', () => ui.button('Shadow').click(), light => assert.equal(light.castShadow, undefined));
  const colour = ui.label('Color');
  expectOneStep('point:0', () => {
    colour.value = '#ff0000';
    dispatch(colour, 'input');
    colour.value = '#00ff00';
    dispatch(colour, 'input');
    dispatch(colour, 'change');
  }, light => assert.deepEqual(light.color, [0, 1, 0]));
  assert.equal(ui.label('Color').value, '#00ff00');

  selectSceneObjectRow(ui, 'spot:0');
  expectOneStep('spot:0', () => ui.setSlider('Angle °', 40), light => assert.ok(Math.abs(light.angle - (40 * Math.PI) / 180) < 1e-3));
  expectOneStep('spot:0', () => ui.setSlider('Penumbra', 0.6), light => assert.equal(light.penumbra, 0.6));
  expectOneStep('spot:0', () => editNumber(ui, 'Light direction X', 1), light => assert.equal(light.direction[0], 1));
  assert.equal(ui.button('Portal'), undefined, 'a spot light has no portal');

  selectSceneObjectRow(ui, 'area:0');
  expectOneStep('area:0', () => editNumber(ui, 'Width', 5), light => assert.equal(light.width, 5));
  expectOneStep('area:0', () => editNumber(ui, 'Height', 1.5), light => assert.equal(light.height, 1.5));
  expectOneStep('area:0', () => ui.button('Portal').click(), light => assert.equal(light.portal, true));
  expectOneStep('area:0', () => ui.button('Shadow').click(), light => assert.equal(light.castShadow, true));
  assert.equal(ui.button('Soft falloff'), undefined, 'an area light has no soft falloff');
});

test('the sun properties edit the key light, and the panel shows the sun when no light is selected', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  ui.setSlider('Sun strength', 3.5);
  assert.equal(ui.studio.exportRecipe().environment.keyIntensity, 3.5);
  const colour = ui.label('Sun color');
  colour.value = '#ff8000';
  dispatch(colour, 'input');
  dispatch(colour, 'change');
  assert.deepEqual(ui.studio.exportRecipe().environment.keyColor, hexToLinearRgb('#ff8000'));
  editNumber(ui, 'Sun size', 1.5);
  assert.ok(Math.abs(ui.studio.exportRecipe().environment.sunAngularRadius - (1.5 * Math.PI) / 180) < 1e-9, 'typed degrees are written as radians');
  assert.equal(ui.label('Sun size').value, '1.5');
  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().environment.sunAngularRadius, undefined);
  assert.equal(ui.label('Sun size').value, '0.5', 'undo puts the control back, shown in degrees');
});

test('a scene file an agent rewrote shows its new sun values in the open Look panel', async testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const edited = ui.studio.exportRecipe();
  edited.environment = { ...edited.environment, keyIntensity: 4.25, sunAngularRadius: (2 * Math.PI) / 180 };
  await ui.studio.loadExternalTextFile(JSON.stringify(edited), { filePath: 'C:/agent/live.scene.json', fileName: 'live.scene.json', recordUndo: false });
  assert.equal(Number(ui.label('Sun strength').value), 4.25, 'the slider follows the file the agent wrote');
  assert.equal(ui.label('Sun size').value, '2', 'the size is shown in degrees');
});

test('the Camera tab edits focal length, sensor, clip planes, shift, depth of field and the eye and target', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const cameraOf = () => ui.studio.exportRecipe().camera;
  editNumber(ui, 'Focal length mm', 85);
  assert.equal(cameraOf().focalLength, 85);
  assert.equal(cameraOf().fov, undefined);
  editNumber(ui, 'Sensor width mm', 24);
  assert.equal(cameraOf().sensorWidth, 24);
  editNumber(ui, 'Clip start', 0.25);
  assert.equal(cameraOf().near, 0.25);
  editNumber(ui, 'Clip end', 300);
  assert.equal(cameraOf().far, 300);
  editNumber(ui, 'Shift X', 0.2);
  assert.deepEqual(cameraOf().shift, [0.2, 0]);
  const depthSwitch = ui.label('Depth of field');
  assert.equal(depthSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(ui.label('Focus distance').parentNode.hidden, false, 'the focus distance stays on screen while depth of field is off');
  assert.equal(ui.label('Focus distance').parentNode.dataset.dimmed, 'true');
  assert.equal(ui.label('Focus distance').disabled, true);
  assert.equal(ui.label('F-stop').disabled, true);
  assert.equal(ui.label('F-stop').value, '2.8', 'an off f-stop shows the default number, not the word Off');
  assert.equal(ui.label('F-stop').placeholder, '');
  depthSwitch.click();
  assert.equal(cameraOf().fStop, 2.8, 'the switch writes the f-stop');
  assert.equal(depthSwitch.getAttribute('aria-checked'), 'true');
  assert.equal(ui.label('Focus distance').parentNode.dataset.dimmed, 'false');
  assert.equal(ui.label('F-stop').disabled, false);
  editNumber(ui, 'F-stop', 4);
  assert.equal(cameraOf().fStop, 4);
  editNumber(ui, 'Focus distance', 5);
  assert.equal(cameraOf().focusDistance, 5);
  editNumber(ui, 'Eye X', 3);
  assert.equal(cameraOf().eye[0], 3);
  editNumber(ui, 'Target Y', 1);
  assert.equal(cameraOf().target[1], 1);
  assert.equal(countUndoSteps(ui.controller), 10, 'each edit is one undo step');

  depthSwitch.click();
  assert.equal(cameraOf().fStop, undefined);
  assert.equal(cameraOf().focusDistance, undefined);
  assert.equal(depthSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(ui.label('F-stop').value, '4', 'switched off, the f-stop keeps showing its last number');
  depthSwitch.click();
  assert.equal(cameraOf().fStop, 4, 'switched on again, it writes that last number');
  assert.equal(ui.label('F-stop').value, '4');
  editNumber(ui, 'F-stop', '');
  assert.equal(cameraOf().fStop, undefined, 'an emptied f-stop field still clears the depth of field');
  assert.equal(cameraOf().focusDistance, undefined);
  ui.controller.undo();
  assert.equal(cameraOf().fStop, 4);

  ui.button('Ortho').click();
  assert.equal(cameraOf().projection, 'orthographic');
  assert.equal(ui.label('Focal length mm').parentNode.hidden, true);
  assert.equal(ui.label('Orthographic size').parentNode.hidden, false);
  editNumber(ui, 'Clip end', 0.01);
  assert.match(ui.status(), /near/, 'a far plane in front of the near plane is told to the person');
  assert.equal(cameraOf().far, 300);
  assert.equal(ui.label('Clip end').value, '300', 'the control goes back to the recipe');
});

test('a change an agent makes from outside shows in the light and camera controls', async testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  selectSceneObjectRow(ui, 'point:0');
  assert.equal(ui.label('Intensity').value, '2.5');

  const agentRecipe = ui.studio.exportRecipe();
  agentRecipe.environment.pointLights[0].intensity = 9;
  agentRecipe.environment.keyIntensity = 2.2;
  agentRecipe.camera.focalLength = 50;
  delete agentRecipe.camera.fov;
  await ui.studio.loadExternalTextFile(JSON.stringify(agentRecipe), { filePath: null, agent: true });
  assert.equal(ui.label('Intensity').value, '9');

  ui.controller.selectSceneObject('sun');
  ui.tab('look').click();
  assert.equal(ui.label('Sun strength').value, '2.2');
  ui.tab('camera').click();
  assert.equal(ui.label('Focal length mm').value, '50');

  ui.studio.loadRecipe({ ...agentRecipe, camera: { ...agentRecipe.camera, focalLength: 135 } }, { recordUndo: false });
  assert.equal(ui.label('Focal length mm').value, '135');
});

test('fields a motion track drives are disabled with a mark, in the light and camera panels', testContext => {
  const recipe = makeRecipe();
  recipe.environment.pointLights = [{ position: [1, 3, 1], intensity: 2 }];
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [
      { kind: 'light', id: 'point:0', property: 'intensity', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 1 }, { time: 2, value: 3 }] },
      { kind: 'camera', property: 'fov', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 40 }, { time: 2, value: 60 }] },
    ],
  };
  const ui = mountStudio(testContext, { recipe });
  selectSceneObjectRow(ui, 'point:0');
  const intensity = ui.label('Intensity');
  const row = intensity.parentNode;
  assert.equal(intensity.disabled, true);
  assert.equal(row.dataset.driven, 'true');
  assert.equal(row.querySelector('.crucible-studio-driven-mark').hidden, false);
  assert.equal(ui.label('Radius').disabled, false, 'a field the track leaves alone stays editable');
  assert.equal(ui.label('Radius').parentNode.querySelector('.crucible-studio-driven-mark').hidden, true);

  ui.tab('camera').click();
  assert.equal(ui.label('Field of view').disabled, true);
  assert.equal(ui.label('Eye X').disabled, true, 'a camera track drives the eye whichever field it animates');
  assert.equal(ui.label('Clip end').disabled, false);
});

function editColour(ui, label, hex) {
  const input = ui.label(label);
  input.value = hex;
  dispatch(input, 'input');
  dispatch(input, 'change');
}

function expectOneUndoStep(ui, edit, check) {
  const before = ui.studio.exportRecipe();
  edit();
  check(ui.studio.exportRecipe());
  assert.equal(ui.controller.undo(), true);
  assert.deepEqual(ui.studio.exportRecipe(), before, 'one undo reverts the edit');
  ui.controller.redo();
  check(ui.studio.exportRecipe());
}

test('the Look tab edits the world, fog, film, effects, shadow box and quality fields, each as one undo step', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const environmentOf = recipe => recipe.environment;

  expectOneUndoStep(ui, () => editNumber(ui, 'HDRI strength', 2), recipe => assert.equal(environmentOf(recipe).environmentIntensity, 2));
  expectOneUndoStep(ui, () => editNumber(ui, 'HDRI rotation', 90), recipe => assert.ok(Math.abs(environmentOf(recipe).environmentRotation - Math.PI / 2) < 1e-9, 'typed degrees are written as radians'));
  expectOneUndoStep(ui, () => editColour(ui, 'Sky top', '#ff0000'), recipe => assert.deepEqual(environmentOf(recipe).skyTop, [1, 0, 0]));
  expectOneUndoStep(ui, () => editColour(ui, 'Sky bottom', '#0000ff'), recipe => assert.deepEqual(environmentOf(recipe).skyBottom, [0, 0, 1]));
  expectOneUndoStep(ui, () => editNumber(ui, 'Daylight', 0.4), recipe => assert.equal(environmentOf(recipe).daylight, 0.4));
  expectOneUndoStep(ui, () => editNumber(ui, 'Fill strength', 0.9), recipe => assert.equal(environmentOf(recipe).fillIntensity, 0.9));
  expectOneUndoStep(ui, () => editNumber(ui, 'Ambient strength', 0.2), recipe => assert.equal(environmentOf(recipe).ambientIntensity, 0.2));
  expectOneUndoStep(ui, () => ui.button('Show sky').click(), recipe => assert.equal(environmentOf(recipe).world, true));
  expectOneUndoStep(ui, () => ui.button('Ground').click(), recipe => assert.equal(environmentOf(recipe).ground, false));

  expectOneUndoStep(ui, () => ui.setSlider('Fog density', 0.02), recipe => assert.equal(environmentOf(recipe).fogDensity, 0.02));
  expectOneUndoStep(ui, () => editColour(ui, 'Fog color', '#00ff00'), recipe => assert.deepEqual(environmentOf(recipe).fogColor, [0, 1, 0]));
  expectOneUndoStep(ui, () => editNumber(ui, 'Volume density', 0.3), recipe => assert.equal(environmentOf(recipe).volumeFog.density, 0.3));
  expectOneUndoStep(ui, () => editColour(ui, 'Volume color', '#ffffff'), recipe => assert.deepEqual(environmentOf(recipe).volumeFog.color, [1, 1, 1]));
  expectOneUndoStep(ui, () => ui.setSlider('Anisotropy', 0.5), recipe => assert.equal(environmentOf(recipe).volumeFog.anisotropy, 0.5));
  expectOneUndoStep(ui, () => editNumber(ui, 'Volume steps', 20), recipe => assert.equal(environmentOf(recipe).volumeFog.steps, 20));
  expectOneUndoStep(ui, () => ui.setSlider('Noise amount', 0.8), recipe => assert.equal(environmentOf(recipe).volumeFog.noiseAmount, 0.8));
  expectOneUndoStep(ui, () => editNumber(ui, 'Noise scale', 0.6), recipe => assert.equal(environmentOf(recipe).volumeFog.noiseScale, 0.6));
  expectOneUndoStep(ui, () => editNumber(ui, 'Volume distance', 60), recipe => assert.equal(environmentOf(recipe).volumeFog.maxDistance, 60));

  expectOneUndoStep(ui, () => ui.setSlider('Exposure', 1.3), recipe => assert.equal(recipe.effects.exposure, 1.3));
  expectOneUndoStep(ui, () => ui.setSlider('Temperature', 0.3), recipe => assert.equal(recipe.effects.temperature, 0.3));
  expectOneUndoStep(ui, () => ui.setSlider('Vignette', 0.2), recipe => assert.equal(recipe.effects.vignette, 0.2));
  expectOneUndoStep(ui, () => ui.setSlider('Grain', 0.04), recipe => assert.equal(recipe.effects.grain, 0.04));
  expectOneUndoStep(ui, () => ui.setSlider('Ambient occlusion', 0.6), recipe => assert.equal(recipe.effects.ambientOcclusion, 0.6));
  expectOneUndoStep(ui, () => editNumber(ui, 'AO radius', 1.5), recipe => assert.equal(recipe.effects.ambientOcclusionRadius, 1.5));
  expectOneUndoStep(ui, () => ui.setSlider('Bloom', 0.4), recipe => assert.equal(recipe.effects.bloom.strength, 0.4));
  expectOneUndoStep(ui, () => editNumber(ui, 'Bloom threshold', 2), recipe => assert.equal(recipe.effects.bloom.threshold, 2));
  expectOneUndoStep(ui, () => editNumber(ui, 'Bloom radius', 1.5), recipe => assert.equal(recipe.effects.bloom.radius, 1.5));
  expectOneUndoStep(ui, () => ui.setSlider('DoF blur', 0.4), recipe => assert.equal(recipe.effects.depthOfField.blur, 0.4));
  expectOneUndoStep(ui, () => editNumber(ui, 'DoF focus', 6), recipe => assert.equal(recipe.effects.depthOfField.focusDistance, 6));
  expectOneUndoStep(ui, () => ui.setSlider('Shutter', 0.2), recipe => assert.equal(recipe.effects.motionBlur.shutter, 0.2));
  expectOneUndoStep(ui, () => ui.setSlider('Object blur', 0.5), recipe => assert.equal(recipe.effects.motionBlur.objects, 0.5));

  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow extent', 5), recipe => assert.equal(recipe.shadow.extent, 5));
  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow distance', 12), recipe => assert.equal(recipe.shadow.distance, 12));
  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow clip start', 0.2), recipe => assert.equal(recipe.shadow.near, 0.2));
  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow clip end', 40), recipe => assert.equal(recipe.shadow.far, 40));
  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow target Y', 2), recipe => assert.equal(recipe.shadow.target[1], 2));

  expectOneUndoStep(ui, () => ui.button('Object reflections').click(), recipe => assert.equal(environmentOf(recipe).objectReflections, false));
  expectOneUndoStep(ui, () => ui.button('Floor sky trace').click(), recipe => assert.equal(environmentOf(recipe).floorSkyTrace, false));
  expectOneUndoStep(ui, () => ui.button('Resolve coplanar').click(), recipe => assert.equal(environmentOf(recipe).resolveCoplanar, false));
  expectOneUndoStep(ui, () => editNumber(ui, 'Shadow cascades', 2), recipe => assert.equal(environmentOf(recipe).shadowCascades, 2));
  expectOneUndoStep(ui, () => editNumber(ui, 'Sun bounce', 0.5), recipe => assert.equal(environmentOf(recipe).sunBounce, 0.5));
  expectOneUndoStep(ui, () => editNumber(ui, 'Specular AA', 2), recipe => assert.equal(environmentOf(recipe).specularAntiAliasing, 2));
});

test('the HDRI select loads the file before it writes the choice, and None clears it', async testContext => {
  const requested = [];
  const catalog = { environment: async reference => { requested.push(reference); return tinyHdrBytes(); } };
  const ui = mountStudio(testContext, { catalog });
  ui.tab('look').click();
  const select = ui.label('HDRI');
  assert.deepEqual(select.children.map(option => option.value), ['', 'sky-clouds', 'studio-softbox']);
  select.value = 'sky-clouds';
  dispatch(select, 'change');
  await ui.dom.settle();
  assert.equal(ui.studio.exportRecipe().environment.hdri, 'sky-clouds');
  assert.deepEqual(requested, ['sky-clouds']);
  select.value = '';
  dispatch(select, 'change');
  assert.equal(ui.studio.exportRecipe().environment.hdri, undefined);
  assert.equal(ui.controller.undo(), true);
  assert.equal(ui.label('HDRI').value, 'sky-clouds', 'undo puts the choice back');
});

test('the web pack keeps the HDRI sky as an image, and still names a physical sky it leaves out', async testContext => {
  const ui = mountStudio(testContext, { catalog: { environment: async () => tinyHdrBytes() } });
  ui.tab('look').click();
  const select = ui.label('HDRI');
  select.value = 'sky-clouds';
  dispatch(select, 'change');
  await ui.dom.settle();
  const payload = await ui.studio.buildWebPackPayload();
  assert.deepEqual(payload.stripped, []);
  const packed = decodePack(payload.packBytes);
  assert.equal(packed.environment.hdri, 'sky-clouds');
  assert.ok(packed.environmentMap.data instanceof Float32Array);
  assert.deepEqual([packed.environmentMap.width, packed.environmentMap.height], [4, 2]);

  const withSky = ui.studio.exportRecipe();
  withSky.environment.sky = { type: 'physical', sunElevation: 30 };
  await ui.studio.loadExternalTextFile(JSON.stringify(withSky), { filePath: null, agent: true });
  assert.deepEqual((await ui.studio.buildWebPackPayload()).stripped, ['environment.sky']);
});

test('a catalog HDRI the list lacks shows as the current value', async testContext => {
  const ui = mountStudio(testContext, { catalog: { environment: async () => tinyHdrBytes() } });
  ui.tab('look').click();
  const agentRecipe = ui.studio.exportRecipe();
  agentRecipe.environment.hdri = 'b'.repeat(64);
  await ui.studio.loadExternalTextFile(JSON.stringify(agentRecipe), { filePath: null, agent: true });
  const shown = ui.label('HDRI');
  assert.equal(shown.value, 'b'.repeat(64));
  assert.equal(shown.children.at(-1).disabled, true);
  assert.equal(shown.children.length, 4);
  assert.equal(shown.children.at(-1).textContent, 'Custom bbbbbbbb', 'a raw hash is not shown');
});

test('a change an agent makes from outside shows in the world, effects, shadow and quality controls', async testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const agentRecipe = ui.studio.exportRecipe();
  agentRecipe.environment.fogDensity = 0.05;
  agentRecipe.environment.skyTop = [0, 1, 0];
  agentRecipe.environment.volumeFog = { density: 0.9 };
  agentRecipe.environment.sunBounce = 3;
  agentRecipe.environment.objectReflections = false;
  agentRecipe.effects.vignette = 0.4;
  agentRecipe.effects.bloom = { strength: 0.7, threshold: 3, radius: 2 };
  agentRecipe.shadow.extent = 9;
  await ui.studio.loadExternalTextFile(JSON.stringify(agentRecipe), { filePath: null, agent: true });
  assert.equal(ui.label('Fog density').value, '0.05');
  assert.equal(ui.label('Sky top').value, '#00ff00');
  assert.equal(ui.label('Volume density').value, '0.9');
  assert.equal(ui.label('Sun bounce').value, '3');
  assert.equal(ui.button('Object reflections').getAttribute('aria-checked'), 'false');
  assert.equal(ui.label('Vignette').value, '0.4');
  assert.equal(ui.label('Bloom threshold').value, '3');
  assert.equal(ui.label('Shadow extent').value, '9');

  ui.controller.updateLook({ environment: { fogDensity: 0.01 }, effects: { vignette: 0.1 } });
  assert.equal(ui.label('Fog density').value, '0.01', 'a controller op shows too');
  assert.equal(ui.label('Vignette').value, '0.1');
  ui.controller.updateSceneShadow({ extent: 4 });
  assert.equal(ui.label('Shadow extent').value, '4');
});

test('property groups fold, start with only the first group open, and stay as a person left them', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  ui.tab('look').click();
  const section = (target, id) => byDataset(target.root, 'section', id);
  const rowsOf = (target, id) => section(target, id).querySelector('.crucible-studio-property-rows');
  const titleOf = (target, id) => section(target, id).querySelector('.crucible-studio-property-title');
  assert.equal(rowsOf(ui, 'sun').hidden, false, 'the first group of the tab starts open');
  assert.equal(titleOf(ui, 'sun').getAttribute('aria-expanded'), 'true');
  for (const id of ['world', 'atmosphere', 'film', 'effects', 'quality', 'sceneShadow']) {
    assert.equal(rowsOf(ui, id).hidden, true, `${id} starts closed`);
    assert.equal(titleOf(ui, id).getAttribute('aria-expanded'), 'false');
  }

  titleOf(ui, 'quality').click();
  titleOf(ui, 'sun').click();
  assert.equal(rowsOf(ui, 'quality').hidden, false);
  assert.equal(rowsOf(ui, 'sun').hidden, true);
  assert.deepEqual(JSON.parse(saved.get('crucible-studio-preferences')).propertyGroupsOpen, { quality: true, sun: false });
  assert.deepEqual(ui.studio.preferences.propertyGroupsOpen, { quality: true, sun: false });

  const returning = mountStudio(testContext, { sharedDom: ui.dom, preferenceStorage });
  returning.tab('look').click();
  assert.equal(rowsOf(returning, 'quality').hidden, false, 'the next visit keeps Quality open');
  assert.equal(rowsOf(returning, 'sun').hidden, true, 'and Sun folded');
  assert.equal(rowsOf(returning, 'sceneShadow').hidden, true);
});

test('a selected light takes the Look tab alone, and the scene groups return with the sun selected', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.addSceneLight('point');
  ui.tab('look').click();
  const panels = () => ui.root.querySelectorAll('.crucible-studio-properties').slice(0, 5).map(panel => panel.hidden === true);
  ui.controller.selectSceneObject('sun');
  assert.deepEqual(panels(), [false, false, false, false, false]);
  selectSceneObjectRow(ui, 'point:0');
  assert.deepEqual(panels(), [false, true, false, true, true], 'the world, shadow and quality groups leave; the film and effects stay');
  ui.controller.selectSceneObject('sun');
  assert.deepEqual(panels(), [false, false, false, false, false]);
});

test('fields an environment or effects track drives are disabled with a mark in the Look tab', testContext => {
  const recipe = makeRecipe();
  recipe.effects = { depthOfField: { blur: 0.5, focusDistance: 5 } };
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [
      { kind: 'environment', property: 'fogDensity', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 0.05 }] },
      { kind: 'environment', property: 'skyTop', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0.1, 0.2, 0.3] }, { time: 2, value: [0.3, 0.2, 0.1] }] },
      { kind: 'environment', property: 'volumeFogDensity', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 0.5 }] },
      { kind: 'effects', property: 'exposure', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 1 }, { time: 2, value: 2 }] },
      { kind: 'effects', property: 'focusDistance', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 2 }, { time: 2, value: 8 }] },
    ],
  };
  const ui = mountStudio(testContext, { recipe });
  ui.tab('look').click();
  for (const label of ['Fog density', 'Sky top', 'Volume density', 'Exposure', 'DoF focus']) {
    const control = ui.label(label);
    assert.equal(control.disabled, true, `${label} is disabled`);
    assert.equal(control.parentNode.dataset.driven, 'true');
    assert.equal(control.parentNode.querySelector('.crucible-studio-driven-mark').hidden, false);
  }
  for (const label of ['Fog color', 'Contrast', 'DoF blur', 'Sky bottom']) {
    assert.equal(ui.label(label).disabled, false, `${label} stays editable`);
  }
});

test('the Camera tab opens on the Lens group alone, with the lens presets as its first row', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const sectionOf = id => byDataset(ui.root, 'section', id);
  const rowsOf = id => sectionOf(id).querySelector('.crucible-studio-property-rows');
  assert.equal(rowsOf('lens').hidden, false);
  assert.equal(rowsOf('depthOfField').hidden, true);
  assert.equal(rowsOf('transform').hidden, true);
  assert.equal(rowsOf('lens').children[0].getAttribute('aria-label'), 'Lens presets', 'the presets lead the group');
  assert.deepEqual(rowsOf('lens').children[0].querySelectorAll('button').map(button => button.textContent), ['24 mm', '35 mm', '50 mm', '85 mm']);
  assert.equal(ui.root.querySelectorAll('.crucible-studio-field-head').filter(head => head.textContent === 'Lens').length, 0, 'no second Lens caption');
});

test('each property is one line: a label and its control in one row, and a switch for every toggle', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const rowOf = id => byDataset(ui.root, 'property', id);
  const fogRow = rowOf('fogDensity');
  assert.equal(fogRow.querySelector('.crucible-studio-prop-label').textContent, 'Density');
  assert.equal(fogRow.querySelector('.crucible-studio-prop-label').title, 'Density', 'a label that is cut short still says what it is');
  assert.equal(fogRow.querySelector('input').parentNode, fogRow, 'the control sits in the row beside its label');

  const showSky = ui.button('Show sky');
  assert.equal(showSky.getAttribute('role'), 'switch');
  assert.equal(showSky.getAttribute('aria-checked'), 'false');
  showSky.click();
  assert.equal(ui.studio.exportRecipe().environment.world, true);
  assert.equal(showSky.getAttribute('aria-checked'), 'true');
  showSky.click();
  assert.equal(showSky.getAttribute('aria-checked'), 'false');
  assert.equal(rowOf('world').querySelector('.crucible-studio-prop-label').textContent, 'Show sky');
});

test('lengths, angles and lens values show a quiet unit beside the number and keep the label plain', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const unitOf = id => byDataset(ui.root, 'property', id).querySelector('.crucible-studio-prop-unit')?.textContent;
  assert.equal(unitOf('focalLength'), 'mm');
  assert.equal(unitOf('near'), 'm');
  assert.equal(unitOf('fov'), '°', 'a slider shows its unit in the same slot as a number');
  assert.equal(unitOf('fStop'), '', 'a ratio has no unit but keeps the slot, so its digits end where the others do');
  const numericRows = [...ui.root.querySelectorAll('.crucible-studio-prop')].filter(row => ['number', 'slider'].includes(row.dataset.control));
  assert.ok(numericRows.length > 5);
  assert.ok(numericRows.every(row => row.querySelector('.crucible-studio-prop-unit')), 'every numeric row reserves the unit slot');
  editNumber(ui, 'Clip start', 0.123456);
  assert.equal(ui.label('Clip start').value, '0.123', 'at most three decimals are shown');
  assert.equal(ui.controller.scene.camera.near, 0.123456, 'what is stored is what was typed');
});

test('the group title button keeps its own look over the generic button rule, so it stays opaque and left aligned', () => {
  const rule = STUDIO_CSS.slice(STUDIO_CSS.indexOf('.crucible-studio button.crucible-studio-property-title {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /position: sticky/u);
  assert.match(body, /inset-block-start: 0/u);
  assert.ok(body.includes('background: var(--studio-panel)'));
  assert.match(body, /justify-items: start/u);
});

test('the sun row shows its azimuth and elevation in degrees beside the pad', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const readout = byDataset(ui.root, 'property', 'direction').querySelector('.crucible-studio-sun-readout');
  assert.match(readout.textContent, /Az-?[0-9]+°/u);
  assert.match(readout.textContent, /El[0-9]+°/u);
});

test('the Color look row is the first row of the Film group', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const filmRows = byDataset(ui.root, 'section', 'film').querySelector('.crucible-studio-property-rows');
  assert.equal(filmRows.children[0].querySelector('.crucible-studio-prop-label').textContent, 'Color look');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-prop-label').filter(label => label.textContent === 'Color look').length, 1);
});

test('a lens preset is active when the focal length is within half a millimetre of it, also for a camera set by field of view', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const activeChips = () => ui.label('Lens presets').querySelectorAll('button').filter(chip => chip.getAttribute('aria-pressed') === 'true').map(chip => chip.textContent);
  ui.controller.setCameraLensMillimetres(50);
  assert.deepEqual(activeChips(), ['50 mm']);
  editNumber(ui, 'Focal length mm', 50.4);
  assert.deepEqual(activeChips(), ['50 mm'], 'half a millimetre off still counts');
  editNumber(ui, 'Focal length mm', 52);
  assert.deepEqual(activeChips(), []);
});

test('a driven row names its mark "Animated by a track" right after the label', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('camera').click();
  const marks = ui.root.querySelectorAll('.crucible-studio-driven-mark');
  assert.ok(marks.length > 0);
  for (const driven of marks) {
    assert.equal(driven.getAttribute('aria-label'), 'Animated by a track');
    assert.equal(driven.title, 'Animated by a track');
  }
});

test('the Look tab shows the lighting presets on one row and the sun direction pad beside its label', testContext => {
  const ui = mountStudio(testContext);
  ui.tab('look').click();
  const presets = ui.label('Lighting setup');
  assert.equal(presets.querySelectorAll('button').length, LIGHTING_SETUP_NAMES.length);
  const sunRow = byDataset(ui.root, 'property', 'direction');
  assert.equal(sunRow.querySelector('.crucible-studio-prop-label').textContent, 'Direction');
  assert.ok(sunRow.querySelector('.crucible-studio-sunpad'), 'the pad is in the direction row');
});

test('the stylesheet fades rows under a pinned group title and at the bottom of the panels, and keeps the label column wide enough', () => {
  assert.ok(STUDIO_CSS.includes('container-type: scroll-state;'), 'a group title can tell when it is pinned');
  assert.ok(STUDIO_CSS.includes('@container scroll-state(stuck: top)'), 'the fade under a title shows only while it is pinned');
  assert.ok(STUDIO_CSS.includes('.crucible-studio-scroll[data-fade-bottom="true"]'), 'a scrolling card body fades at the edges that hide content');
  assert.ok(STUDIO_CSS.includes('scrollbar-gutter: stable'), 'the scrollbar gutter stays so content does not shift');
  assert.ok(STUDIO_CSS.includes('grid-template-columns: minmax(min-content, 45%) minmax(0, 1fr);'), 'a label column grows to its label');
  assert.ok(STUDIO_CSS.includes('scroll-snap-type: y mandatory;'), 'the Scene list scrolls a whole row at a time');
});

function pausedNotice(ui) {
  return ui.root.querySelector('.crucible-studio-paused');
}

test('a lost graphics context pauses the picture with a notice, and restoring it draws the same scene again', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.controller.orbitCamera({ zoomScale: 2 });
  const eyeBefore = ui.controller.viewCamera.eye.slice();
  const selectionBefore = ui.controller.selectedNodeId;
  assert.equal(pausedNotice(ui).hidden, true);

  const lostEvent = dispatch(ui.canvas, 'webglcontextlost');
  assert.equal(lostEvent.defaultPrevented, true, 'cancelling the event lets the browser restore the context');
  const notice = pausedNotice(ui);
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.getAttribute('aria-live'), 'polite');
  assert.match(notice.textContent, /graphics context was lost/);
  assert.ok(notice.querySelector('svg'), 'the notice leads with an icon');
  const reloadButton = notice.querySelector('button');
  assert.equal(reloadButton.hidden, true, 'Reload is offered only after a few seconds');
  ui.dom.runTimers();
  assert.equal(reloadButton.hidden, false);

  const renderCallsWhileLost = ui.renderer.calls.length;
  ui.controller.selectNode('orb');
  ui.dom.runAnimationFrames(100);
  ui.studio.renderNow();
  assert.equal(ui.renderer.calls.length, renderCallsWhileLost, 'nothing is drawn while the context is lost');
  assert.equal(ui.dom.pendingAnimationFrameCount, 0, 'the frame loop stays quiet until the context returns');
  assert.throws(() => ui.studio.capturePngDataUrl(), /graphics context was lost/, 'a still is refused instead of returning a blank picture');
  assert.equal(ui.dom.pendingAnimationFrameCount, 0);

  ui.controller.selectNode(selectionBefore);
  const framesBefore = ui.renderer.frames.length;
  dispatch(ui.canvas, 'webglcontextrestored');
  assert.equal(pausedNotice(ui).hidden, true);
  assert.equal(ui.dom.pendingAnimationFrameCount, 1, 'restoring asks for a frame');
  ui.dom.runAnimationFrames(200);
  assert.equal(ui.renderer.frames.length, framesBefore + 1);
  assert.ok(ui.renderer.calls.slice(renderCallsWhileLost).includes('replaceParts'), 'the parts are uploaded again');
  assert.equal(ui.controller.selectedNodeId, selectionBefore);
  assert.deepEqual(ui.controller.viewCamera.eye, eyeBefore);
});

test('a frame that throws once shows the notice, and the next requested frame draws again', testContext => {
  const ui = mountStudio(testContext);
  ui.renderer.updateFailure = new Error('WebGL replacement allocation failed with error 37442');
  ui.selectRow('hero');
  assert.equal(ui.dom.pendingAnimationFrameCount, 1);
  assert.doesNotThrow(() => ui.dom.runAnimationFrames(100));
  const notice = pausedNotice(ui);
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /37442/);
  assert.equal(ui.dom.pendingAnimationFrameCount, 0, 'a failed frame does not retry on its own');

  ui.renderer.updateFailure = null;
  const framesBefore = ui.renderer.frames.length;
  ui.selectRow('orb');
  ui.dom.runAnimationFrames(200);
  assert.equal(ui.renderer.frames.length, framesBefore + 1);
  assert.equal(pausedNotice(ui).hidden, true);
});

test('a scheduled frame whose main program is still linking keeps the picture and draws once the program is ready (#2944)', testContext => {
  const ui = mountStudio(testContext);
  const context = { linked: false, getExtension: () => ({ COMPLETION_STATUS_KHR: 0x91b1 }), getProgramParameter: () => context.linked };
  ui.renderer.context = context;
  ui.renderer.updateFailure = new ProgramNotReady({});
  const framesBefore = ui.renderer.frames.length;
  ui.selectRow('hero');
  assert.doesNotThrow(() => ui.dom.runAnimationFrames(100));
  assert.equal(ui.renderer.frames.length, framesBefore, 'the frame that needs the program is not drawn');
  assert.equal(pausedNotice(ui).hidden, true, 'a program that is still linking is not a failure');
  assert.equal(ui.renderer.calls.includes('dispose'), false, 'the renderer is kept');

  ui.dom.runTimers();
  assert.equal(ui.dom.pendingAnimationFrameCount, 0, 'no frame is drawn while the driver still builds');
  const syncsWhileLinking = ui.renderer.calls.filter(call => call === 'updateParts').length;
  ui.selectRow('orb');
  ui.dom.runAnimationFrames(150);
  assert.equal(ui.renderer.calls.filter(call => call === 'updateParts').length, syncsWhileLinking, 'a frame asked for meanwhile does not upload the parts again');

  ui.renderer.updateFailure = null;
  context.linked = true;
  ui.dom.runTimers();
  assert.equal(ui.dom.pendingAnimationFrameCount, 1, 'the waiting scene asks for its frame without another input');
  ui.dom.runAnimationFrames(200);
  assert.equal(ui.renderer.frames.length, framesBefore + 1);
});

test('only a scheduled frame syncs its parts while the context is preparing', testContext => {
  const ui = mountStudio(testContext);
  ui.renderer.context = { getExtension: () => ({ COMPLETION_STATUS_KHR: 0x91b1 }), getProgramParameter: () => false };
  let preparingDuringSync = null;
  const updateParts = ui.renderer.updateParts;
  ui.renderer.updateParts = parts => {
    try {
      finishProgram(ui.renderer.context, { program: {}, shaders: [] });
      preparingDuringSync = false;
    } catch (error) {
      preparingDuringSync = error instanceof ProgramNotReady;
    }
    updateParts(parts);
  };
  ui.studio.renderNow();
  assert.equal(preparingDuringSync, false, 'renderNow blocks, since its caller reads the canvas');
  ui.selectRow('hero');
  ui.dom.runAnimationFrames(100);
  assert.equal(preparingDuringSync, true);
});

test('disposing Studio removes the context loss listeners from the canvas', testContext => {
  const ui = mountStudio(testContext);
  const listenerTypes = () => ui.canvas.listeners.map(entry => entry.type);
  assert.ok(listenerTypes().includes('webglcontextlost'));
  assert.ok(listenerTypes().includes('webglcontextrestored'));
  ui.studio.dispose();
  assert.ok(!listenerTypes().includes('webglcontextlost'));
  assert.ok(!listenerTypes().includes('webglcontextrestored'));
});

test('in a compact window both cards start right of the tool rail and share the height without overlapping', () => {
  const rule = selector => {
    const start = STUDIO_CSS.indexOf(`${selector} {`);
    assert.ok(start >= 0, `a rule for ${selector}`);
    return STUDIO_CSS.slice(start, STUDIO_CSS.indexOf('}', start));
  };
  const room = 'calc((100% - var(--studio-top) - 72px - 6px) / 2)';
  const inspector = rule('.crucible-studio[data-compact="true"] .crucible-studio-inspector');
  assert.ok(inspector.includes('inset-inline: calc(var(--studio-edge) * 2 + var(--studio-rail)) var(--studio-edge);'), 'Properties starts where the Scene card does, right of the rail');
  assert.ok(!inspector.includes('inset-inline: var(--studio-edge);'), 'not under the rail');
  assert.ok(inspector.includes('inset-block-end: 72px;'));
  assert.ok(inspector.includes(`max-block-size: min(320px, ${room});`), 'at most half of the room between the bar and the bottom bar');
  const outliner = rule('.crucible-studio[data-compact="true"] .crucible-studio-outliner');
  assert.ok(outliner.includes(`max-block-size: min(300px, ${room});`), 'the Scene card takes the other half, less the gap');
});

function draftStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

const DRAFT_KEY = 'crucible.studio.draft';

test('edits are kept as a draft after a pause, and Save clears it', async testContext => {
  const storage = draftStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  assert.equal(storage.entries.has(DRAFT_KEY), false, 'nothing is kept before an edit');
  ui.selectRow('hero');
  ui.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  assert.equal(storage.entries.has(DRAFT_KEY), false, 'the write waits for the edits to pause');
  ui.dom.runTimers();
  const draft = JSON.parse(storage.entries.get(DRAFT_KEY));
  assert.deepEqual(draft.recipe.nodes.find(node => node.id === 'hero').translation, [3, 0.5, 0]);

  ui.controller.updateNodeTransform('hero', { translation: [4, 0.5, 0] });
  ui.button('Save').click();
  await ui.dom.settle();
  ui.dom.runTimers();
  assert.equal(storage.entries.has(DRAFT_KEY), false, 'a saved scene needs no draft, and the pending write is cancelled');
});

test('a draft that differs from the opened scene is offered, and Restore brings it back as one undo step', async testContext => {
  const storage = draftStorage();
  const first = mountStudio(testContext, { preferenceStorage: storage });
  first.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  first.dom.runTimers();
  first.studio.dispose();

  const second = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await second.studio.ready;
  const notice = second.root.querySelector('.crucible-studio-draft');
  assert.equal(notice.hidden, false);
  assert.equal(second.node('hero').translation[0], 0, 'the opened scene is untouched until the person chooses');
  assert.equal(second.studio.dirty, false);

  second.button('Restore').click();
  await second.dom.settle();
  assert.equal(notice.hidden, true);
  assert.deepEqual(second.node('hero').translation, [3, 0.5, 0]);
  assert.equal(second.studio.dirty, true);
  second.controller.undo();
  assert.equal(second.node('hero').translation[0], 0);
  assert.equal(storage.entries.has(DRAFT_KEY), true, 'the restored scene is still unsaved, so its draft stays');
});

test('Discard drops the draft, and a draft equal to the opened scene is not offered', async testContext => {
  const storage = draftStorage();
  const first = mountStudio(testContext, { preferenceStorage: storage });
  const openedRecipe = first.studio.exportRecipe();
  first.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  first.dom.runTimers();
  first.studio.dispose();

  const second = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await second.studio.ready;
  second.button('Discard').click();
  assert.equal(second.root.querySelector('.crucible-studio-draft').hidden, true);
  assert.equal(storage.entries.has(DRAFT_KEY), false);
  second.studio.dispose();

  storage.setItem(DRAFT_KEY, JSON.stringify({ fileName: 'untitled.scene.json', recipe: openedRecipe }));
  const third = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await third.studio.ready;
  assert.equal(third.root.querySelector('.crucible-studio-draft').hidden, true);
});

test('edits made while the restore notice is showing close it and survive a reload (#2838)', async testContext => {
  const storage = draftStorage();
  const first = mountStudio(testContext, { preferenceStorage: storage });
  first.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  first.dom.runTimers();
  first.studio.dispose();

  const second = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await second.studio.ready;
  const notice = second.root.querySelector('.crucible-studio-draft');
  assert.equal(notice.hidden, false);
  second.controller.updateNodeTransform('hero', { translation: [9, 0.5, 0] });
  assert.equal(notice.hidden, true, 'the first edit answers the notice: the person carries on with the current scene');
  second.dom.runTimers();
  const keptTranslation = JSON.parse(storage.entries.get(DRAFT_KEY)).recipe.nodes.find(node => node.id === 'hero').translation;
  assert.deepEqual(keptTranslation, [9, 0.5, 0], 'the draft holds the new edit, not the older draft');
  second.studio.dispose();

  const third = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await third.studio.ready;
  assert.equal(third.root.querySelector('.crucible-studio-draft').hidden, false, 'the reload offers the newest work');
  third.button('Restore').click();
  await third.dom.settle();
  assert.deepEqual(third.node('hero').translation, [9, 0.5, 0]);
});

test('Restore pressed before any edit still replaces the scene as one undo step (#2838)', async testContext => {
  const storage = draftStorage();
  const first = mountStudio(testContext, { preferenceStorage: storage });
  first.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  first.dom.runTimers();
  first.studio.dispose();

  const second = mountStudio(testContext, { preferenceStorage: storage, sharedDom: first.dom });
  await second.studio.ready;
  second.button('Restore').click();
  await second.dom.settle();
  assert.deepEqual(second.node('hero').translation, [3, 0.5, 0]);
  second.controller.undo();
  assert.equal(second.node('hero').translation[0], 0);
});

test('choosing a new scene on purpose clears the draft and its notice', async testContext => {
  const storage = draftStorage();
  storage.setItem(DRAFT_KEY, JSON.stringify({ fileName: 'old.scene.json', recipe: { ...makeRecipe(), nodes: [] } }));
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  await ui.studio.ready;
  assert.equal(ui.root.querySelector('.crucible-studio-draft').hidden, false);
  ui.studio.openNewScene();
  await ui.dom.settle();
  byDataset(ui.root, 'template', 'empty').click();
  await ui.dom.settle();
  assert.equal(storage.entries.has(DRAFT_KEY), false);
  assert.equal(ui.root.querySelector('.crucible-studio-draft').hidden, true);
});

test('New scene works from the Export workspace like Open does: it replaces the scene and Export stays open (#3343)', async testContext => {
  const ui = mountStudio(testContext);
  await ui.studio.ready;
  byDataset(ui.root, 'workspace', 'export').click();
  assert.equal(ui.root.dataset.workspace, 'export');
  assert.ok(ui.node('hero'), 'the scene has its object before');
  const newSceneRow = byText(ui.root.querySelector('#crucible-studio-pop-new'), 'New scene…');
  assert.notEqual(newSceneRow.getAttribute('aria-disabled'), 'true', 'the row is not locked in Export');
  newSceneRow.click();
  await ui.dom.settle();
  byDataset(ui.root, 'template', 'empty').click();
  await ui.dom.settle();
  assert.equal(ui.node('hero'), undefined, 'the scene was replaced');
  assert.equal(ui.root.dataset.workspace, 'export', 'the workspace stays on Export');
  assert.equal(byDataset(ui.root, 'export', 'image').disabled, false, 'the export actions follow the new scene');
});

test('a delete leaves nothing selected, so a second Delete removes nothing, and its undo brings the object back in hand (#2817)', testContext => {
  const ui = mountStudio(testContext);
  const deleteRow = byText(ui.root.querySelector('#crucible-studio-pop-edit'), 'Delete');
  const countBefore = ui.studio.exportRecipe().nodes.length;
  ui.selectRow('hero');
  deleteRow.click();
  assert.equal(ui.controller.selectedNodeId, null);
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore - 1);
  assert.throws(() => ui.controller.deleteSelected(), /Select a node before deleting it/);
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore - 1, 'the second Delete removed no object');

  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().nodes.length, countBefore);
  assert.equal(ui.controller.selectedNodeId, 'hero', 'undo selects the object it brought back');
  ui.controller.redo();
  assert.equal(ui.controller.selectedNodeId, null, 'redo of the delete leaves nothing selected again');
});

test('undo of an added object selects what was selected before it, never another object (#2817)', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode(null);
  const added = ui.controller.addPrimitive('box');
  assert.equal(ui.controller.selectedNodeId, added.id);
  ui.controller.undo();
  assert.equal(ui.controller.selectedNodeId, null, 'nothing was selected before the add');
  ui.controller.redo();
  assert.equal(ui.controller.selectedNodeId, added.id, 'redo selects the object it added again');
});

test('a light added from the menu is selected and its panel opens (#2817)', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  byText(ui.root.querySelector('#crucible-studio-pop-add'), 'Spot light').click();
  assert.equal(ui.controller.selectedObjectKey, 'spot:0');
  assert.equal(ui.controller.selectedNodeId, null);
  assert.equal(ui.controller.activeTab, 'look');
  assert.equal(ui.root.dataset.workspace, 'look');
});

test('picking an object in Animate opens its panel without leaving the workspace (#2817)', testContext => {
  const ui = mountStudio(testContext);
  byDataset(ui.root, 'workspace', 'animate').click();
  assert.equal(ui.controller.activeTab, 'camera');
  ui.selectRow('hero');
  assert.equal(ui.controller.selectedNodeId, 'hero');
  assert.equal(ui.controller.activeTab, 'node', 'the Properties card shows the picked object');
  assert.equal(ui.root.dataset.workspace, 'animate');
  byDataset(ui.root, 'workspace', 'build').click();
  byDataset(ui.root, 'workspace', 'animate').click();
  assert.equal(ui.controller.activeTab, 'camera', 'Animate still opens on the camera');
});

test('an edit still waiting to be kept is written when the window goes to the background or closes', testContext => {
  const storage = draftStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.selectRow('hero');
  ui.controller.updateNodeTransform('hero', { translation: [3, 0.5, 0] });
  assert.equal(storage.entries.has(DRAFT_KEY), false);
  ui.dom.document.hidden = true;
  dispatch(ui.dom.document, 'visibilitychange');
  const draft = JSON.parse(storage.entries.get(DRAFT_KEY));
  assert.deepEqual(draft.recipe.nodes.find(node => node.id === 'hero').translation, [3, 0.5, 0], 'no timer had to run');

  storage.entries.clear();
  ui.dom.document.hidden = false;
  dispatch(ui.dom.document, 'visibilitychange');
  assert.equal(storage.entries.has(DRAFT_KEY), false, 'nothing is written when no edit waits');
});

test('a dense selection is outlined by the mask canvas, with no hull and no frame left running', testContext => {
  const { context, state } = createFakeWebgl2();
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = tagName => {
    const element = createElement(tagName);
    if (tagName === 'canvas') element.getContext = () => context;
    return element;
  };
  const recipe = makeRecipe();
  recipe.geometries.push({ id: 'dense-ball', type: 'sphere', segments: 96, rings: 64 });
  recipe.nodes.push({ id: 'dense', geometry: 'dense-ball', material: 'paint', translation: [0, 1, 0] });
  const ui = mountStudio(testContext, { recipe, sharedDom: dom });
  const maskCanvases = () => ui.viewport.querySelectorAll('.crucible-studio-selection-mask');

  assert.equal(maskCanvases().length, 0, 'no mask exists before a dense selection');
  ui.controller.selectNode('dense');
  ui.studio.renderNow();
  assert.equal(maskCanvases().length, 1);
  assert.equal(maskCanvases()[0].hidden, false);
  assert.ok(state.draws.length >= 1, 'the dense mesh is drawn');
  assert.equal(ui.gizmo.querySelectorAll('.crucible-studio-selection-outline').length, 0, 'no hull polygon');
  assert.equal(ui.gizmo.querySelectorAll('.crucible-studio-selection-silhouette').length, 0, 'no path of a million numbers');
  const viewportChildren = ui.viewport.children;
  assert.ok(viewportChildren.indexOf(maskCanvases()[0]) < viewportChildren.indexOf(ui.gizmo), 'the mask lies under the gizmo handles');

  dom.runAnimationFrames(0);
  dom.runTimers();
  assert.equal(dom.pendingAnimationFrameCount, 0, 'nothing is scheduled while the scene is idle');

  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  assert.equal(maskCanvases()[0].hidden, true, 'a small selection hides the mask');
  assert.equal(state.buffersDeleted, state.buffersCreated, 'and frees its buffers');
  assert.equal(ui.gizmo.querySelectorAll('.crucible-studio-selection-silhouette').length, 1, 'the small mesh keeps the path outline');

  ui.controller.selectNode('dense');
  ui.studio.renderNow();
  ui.studio.dispose();
  assert.equal(state.buffersDeleted, state.buffersCreated, 'dispose frees the buffers');
  assert.equal(state.programsDeleted, 1);
});

function chooseSetting(ui, name, value) {
  const control = ui.root.querySelector('.crucible-studio-settings-dialog').descendants().find(element => element.dataset?.setting === name);
  control.value = String(value);
  dispatch(control, 'change');
}

function setupButton(ui, text) {
  return ui.root.querySelector('.crucible-studio-setup-dialog').descendants().find(element => element.tagName === 'BUTTON' && element.textContent === text);
}

function setupCard(ui, preferenceName, value) {
  const dialog = ui.root.querySelector('.crucible-studio-setup-dialog');
  return dialog.descendants().find(element => element.tagName === 'INPUT' && element.dataset.setup === preferenceName && element.value === String(value));
}

test('Theme forces light or dark on the Studio root, and System leaves the page to decide (#2847)', testContext => {
  const themes = [];
  const ui = mountStudio(testContext, { onThemeChange: theme => themes.push(theme) });
  assert.equal(ui.root.dataset.theme, undefined, 'System sets nothing on the root');
  chooseSetting(ui, 'theme', 'dark');
  assert.equal(ui.root.dataset.theme, 'dark');
  chooseSetting(ui, 'theme', 'light');
  assert.equal(ui.root.dataset.theme, 'light');
  chooseSetting(ui, 'theme', 'system');
  assert.equal(ui.root.dataset.theme, undefined);
  assert.deepEqual(themes, ['light', 'dark', 'light', 'light'], 'the host hears the effective theme at the start and on each change');
  assert.ok(ui.root.querySelector('.crucible-studio-settings-dialog'), 'the dialogs sit inside the root and follow its theme');
});

test('while Theme is System a flip of the operating system scheme reaches the host, and dispose stops listening (#2847)', testContext => {
  const dom = installStudioDom();
  const listeners = new Set();
  let systemIsDark = false;
  dom.document.defaultView.matchMedia = () => ({
    get matches() { return systemIsDark; },
    addEventListener: (type, listener) => { if (type === 'change') listeners.add(listener); },
    removeEventListener: (type, listener) => listeners.delete(listener),
  });
  const themes = [];
  const ui = mountStudio(testContext, { sharedDom: dom, onThemeChange: theme => themes.push(theme) });
  testContext.after(() => dom.uninstall());
  const flip = isDark => {
    systemIsDark = isDark;
    for (const listener of [...listeners]) listener({ matches: isDark });
  };
  assert.deepEqual(themes, ['light']);
  flip(true);
  assert.deepEqual(themes, ['light', 'dark'], 'System follows the flip');
  chooseSetting(ui, 'theme', 'light');
  flip(false);
  flip(true);
  assert.deepEqual(themes, ['light', 'dark', 'light'], 'a forced theme ignores the flip');
  chooseSetting(ui, 'theme', 'system');
  assert.deepEqual(themes.at(-1), 'dark');
  ui.studio.dispose();
  assert.equal(listeners.size, 0, 'dispose removes the listener');
});

test('Performance sets the viewport pixel ratio cap and never touches the recipe (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.dom.document.defaultView.devicePixelRatio = 3;
  ui.renderer.pixelRatio = 3;
  const recipeBefore = JSON.stringify(ui.studio.exportRecipe());
  chooseSetting(ui, 'performance', 'light');
  assert.equal(ui.renderer.pixelRatio, 1);
  chooseSetting(ui, 'performance', 'balanced');
  assert.equal(ui.renderer.pixelRatio, 1.5);
  chooseSetting(ui, 'performance', 'sharp');
  assert.equal(ui.renderer.pixelRatio, 2);
  assert.ok(ui.renderer.calls.includes('resize'), 'the renderer is told to resize at the new ratio');
  assert.equal(JSON.stringify(ui.studio.exportRecipe()), recipeBefore);
  const resizesBefore = ui.renderer.calls.filter(call => call === 'resize').length;
  chooseSetting(ui, 'moveSnapStep', 1);
  assert.equal(ui.renderer.calls.filter(call => call === 'resize').length, resizesBefore, 'a preference that is not a tier leaves the renderer alone');
});

test('Automatic performance takes the detected tier and a screen below the cap keeps its own ratio (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.dom.document.defaultView.devicePixelRatio = 1.25;
  ui.renderer.pixelRatio = 3;
  chooseSetting(ui, 'performance', 'sharp');
  assert.equal(ui.renderer.pixelRatio, 1.25);
  ui.dom.document.defaultView.devicePixelRatio = 2;
  chooseSetting(ui, 'performance', 'automatic');
  assert.equal(ui.renderer.pixelRatio, 1.5, 'hardware the browser does not report is the balanced tier');
});

test('Studio does not open the setup on its own, and Skip and Done both mark it done (#2847)', testContext => {
  const ui = mountStudio(testContext);
  const dialog = ui.root.querySelector('.crucible-studio-setup-dialog');
  assert.notEqual(dialog.open, true, 'no modal until the host asks');
  assert.equal(ui.studio.setupDone, false);

  ui.studio.openSetup();
  assert.equal(dialog.open, true);
  setupButton(ui, 'Skip').click();
  assert.equal(dialog.open, false);
  assert.equal(ui.studio.setupDone, true);

  ui.studio.setPreference('setupDone', false);
  ui.studio.openSetup();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Done').click();
  assert.equal(ui.studio.setupDone, true);

  ui.studio.setPreference('setupDone', false);
  ui.studio.openSetup();
  dialog.close();
  assert.equal(ui.studio.setupDone, true, 'Esc closes the dialog the same way');
});

test('the setup shows one group a page, with Back, Next and Done (#2847)', testContext => {
  const ui = mountStudio(testContext);
  const groups = ui.root.querySelectorAll('.crucible-studio-setup-group');
  const visibleTitles = () => groups.filter(group => !group.inert).map(group => group.children[0].textContent);
  ui.studio.openSetup();
  assert.deepEqual(visibleTitles(), ['Theme']);
  assert.equal(setupButton(ui, 'Back').hidden, true);
  assert.equal(setupButton(ui, 'Done').hidden, true);
  setupButton(ui, 'Next').click();
  assert.deepEqual(visibleTitles(), ['Performance']);
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  setupButton(ui, 'Next').click();
  assert.deepEqual(visibleTitles(), ['Work with an AI agent']);
  assert.equal(setupButton(ui, 'Next').hidden, true);
  assert.equal(setupButton(ui, 'Done').hidden, false);
  setupButton(ui, 'Back').click();
  assert.deepEqual(visibleTitles(), ['Number pad']);
  setupButton(ui, 'Back').click();
  assert.deepEqual(visibleTitles(), ['Keys']);
  setupButton(ui, 'Skip').click();
});

test('openSetup takes no layout: one call shows the steps, whatever it is given (#2847)', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.studio.openSetup.length, 0);
  ui.studio.openSetup({ layout: 'sheet' });
  assert.equal(ui.root.querySelectorAll('.crucible-studio-setup-group').filter(group => !group.inert).length, 1);
  assert.equal(setupButton(ui, 'Next').hidden, false);
  assert.equal(ui.root.querySelector('.crucible-studio-setup-dialog').dataset.layout, undefined);
});

test('choosing a card in the setup applies at once and the cards show the current choice (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  assert.equal(setupCard(ui, 'theme', 'system').checked, true);
  const dark = setupCard(ui, 'theme', 'dark');
  dark.checked = true;
  dispatch(dark, 'change');
  assert.equal(ui.root.dataset.theme, 'dark', 'the live Studio behind the dialog changes');
  assert.equal(setupCard(ui, 'theme', 'dark').parentNode.dataset.selected, 'true');
  assert.equal(setupCard(ui, 'theme', 'system').parentNode.dataset.selected, 'false');

  const snap = setupCard(ui, 'moveSnapStep', 1);
  snap.checked = true;
  dispatch(snap, 'change');
  assert.equal(ui.controller.interactionSettings.moveSnapStep, 1);
  const sharp = setupCard(ui, 'performance', 'sharp');
  sharp.checked = true;
  dispatch(sharp, 'change');
  assert.equal(ui.studio.preferences.performance, 'sharp');
  assert.ok(setupCard(ui, 'performance', 'automatic'), 'Automatic is a card of its own');
});

test('the Help menu reopens the setup and the Agent group copies the same prompt as the Agent menu (#2847)', async testContext => {
  const ui = mountStudio(testContext);
  byText(ui.root.querySelector('#crucible-studio-pop-help'), 'Set up Studio…').click();
  assert.equal(ui.root.querySelector('.crucible-studio-setup-dialog').open, true);
  setupButton(ui, 'Copy prompt').click();
  await ui.dom.settle();
  assert.equal(ui.dom.clipboardTexts.length, 1);
  assert.match(ui.dom.clipboardTexts[0], /Edit Crucible scene/);
});

/** A host page that offers a built-in agent, as the desktop app does through window.crucibleShell. */
function withHostAgent(testContext, { signedIn = false, signInAnswer = { signedIn: true }, account = null } = {}) {
  const calls = [];
  let resolveSignIn;
  globalThis.crucibleShell = {
    builtInAgent: {
      isSignedIn: async () => signedIn,
      signIn: () => {
        calls.push('signIn');
        return new Promise(resolve => { resolveSignIn = () => resolve(signInAnswer); });
      },
    },
    ...(account ? { account: { get: async () => account } } : {}),
  };
  testContext.after(() => { delete globalThis.crucibleShell; });
  return { calls, finishSignIn: () => resolveSignIn() };
}

function agentCards(ui) {
  return ui.root.querySelectorAll('.crucible-studio-setup-agent-card');
}

function agentCardTitles(ui) {
  return agentCards(ui).map(card => card.querySelector('.crucible-studio-setup-agent-title').textContent);
}

function signInControl(ui) {
  return ui.root.querySelector('.crucible-studio-setup-sign-in');
}

function iconPathOf(element) {
  return element.querySelector('.crucible-studio-icon path').getAttribute('d');
}

test("the AI agent step has two titled cards when a host offers a built-in agent, and its sign-in works (#3311)", async testContext => {
  const host = withHostAgent(testContext);
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  assert.deepEqual(agentCardTitles(ui), ['Built-in AI', 'Your own agent']);
  agentCards(ui).forEach(card => {
    assert.equal(card.getAttribute('role'), 'group');
    assert.equal(card.getAttribute('aria-labelledby'), card.querySelector('.crucible-studio-setup-agent-title').id, 'a card is named by its title');
    assert.ok(hasIcon(card.querySelector('.crucible-studio-setup-agent-head')), 'a card title has an icon');
  });
  assert.equal(signInControl(ui).dataset.state, 'signed-out');
  const signIn = setupButton(ui, 'Sign in');
  assert.ok(signIn, 'the built-in card offers the sign-in');
  assert.ok(setupButton(ui, 'Copy prompt'), "the prompt for an agent of one's own stays");
  signIn.click();
  assert.equal(signInControl(ui).dataset.state, 'waiting');
  assert.equal(signIn.disabled, true);
  assert.deepEqual(host.calls, ['signIn']);
  host.finishSignIn();
  await ui.dom.settle();
  const control = signInControl(ui);
  assert.equal(control.dataset.state, 'signed-in');
  assert.equal(control.textContent, 'Signed in');
  assert.equal(setupButton(ui, 'Sign in'), undefined, 'the signed-in state is a status, not a button');
  assert.notEqual(iconPathOf(control), iconPathOf(signIn), 'signed in shows a different mark than signed out');
});

test('a host that is already signed in shows the built-in card as signed in (#3311)', async testContext => {
  withHostAgent(testContext, { signedIn: true });
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  await ui.dom.settle();
  assert.equal(signInControl(ui).dataset.state, 'signed-in');
  assert.equal(signInControl(ui).textContent, 'Signed in');
});

test('the built-in card names who is signed in when the host says so, and the account answer wins (#3311)', async testContext => {
  withHostAgent(testContext, { account: { signedIn: true, name: 'Ada Lovelace', email: 'ada@example.com' } });
  const named = mountStudio(testContext);
  named.studio.openSetup();
  await named.dom.settle();
  assert.equal(signInControl(named).textContent, 'Signed in as Ada Lovelace');

  withHostAgent(testContext, { account: { signedIn: true, email: 'ada@example.com' } });
  const emailOnly = mountStudio(testContext);
  emailOnly.studio.openSetup();
  await emailOnly.dom.settle();
  assert.equal(signInControl(emailOnly).textContent, 'Signed in as ada@example.com');

  withHostAgent(testContext, { account: { signedIn: true } });
  const anonymous = mountStudio(testContext);
  anonymous.studio.openSetup();
  await anonymous.dom.settle();
  assert.equal(signInControl(anonymous).textContent, 'Signed in', 'no name and no email leaves the plain status');

  withHostAgent(testContext, { signedIn: true, account: { signedIn: false } });
  const signedOut = mountStudio(testContext);
  signedOut.studio.openSetup();
  await signedOut.dom.settle();
  assert.equal(signInControl(signedOut).dataset.state, 'signed-out', 'account.get() decides when the host offers it');
});

test('a refused sign-in returns the built-in card to its first state, so it can be tried again (#3311)', async testContext => {
  const host = withHostAgent(testContext, { signInAnswer: { signedIn: false } });
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  setupButton(ui, 'Sign in').click();
  host.finishSignIn();
  await ui.dom.settle();
  assert.equal(signInControl(ui).dataset.state, 'signed-out');
  assert.equal(setupButton(ui, 'Sign in').disabled, false);
});

test("without a host the AI agent step is one finished card for an agent of one's own (#3311)", testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  assert.deepEqual(agentCardTitles(ui), ['Your own agent']);
  assert.equal(signInControl(ui), null);
  assert.equal(setupButton(ui, 'Sign in'), undefined);
  assert.ok(setupButton(ui, 'Copy prompt'));
  assert.ok(hasIcon(agentCards(ui)[0].querySelector('.crucible-studio-setup-agent-head')));
});

test('the AI agent step uses a different icon for each part: tab, both cards, sign in and copy (#3311)', testContext => {
  withHostAgent(testContext);
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  const tabIcon = iconPathOf(ui.root.querySelectorAll('.crucible-studio-setup-step')[5]);
  const cardIcons = agentCards(ui).map(card => iconPathOf(card.querySelector('.crucible-studio-setup-agent-head')));
  const signInIcon = iconPathOf(setupButton(ui, 'Sign in'));
  const copyIcon = iconPathOf(setupButton(ui, 'Copy prompt'));
  assert.equal(new Set([tabIcon, ...cardIcons, signInIcon, copyIcon]).size, 5, 'five places, five icons');
});

test('the prompt and its copy button are one box, and a long prompt stays inside it (#3311)', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  const box = ui.root.querySelector('.crucible-studio-setup-prompt-box');
  assert.ok(box.querySelector('textarea.crucible-studio-setup-prompt'), 'the text is in the box');
  assert.equal(setupButton(ui, 'Copy prompt').parentNode, box, 'the copy control sits on the box itself');
  assert.match(STUDIO_CSS, /textarea\.crucible-studio-setup-prompt \{[^}]*overflow: auto;[^}]*overflow-wrap: anywhere;/, 'long text wraps or scrolls inside the box');
  assert.match(STUDIO_CSS, /textarea\.crucible-studio-setup-prompt \{[^}]*max-block-size: 160px;/);
});

test('Reset in Settings keeps the setup marked done (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.setPreference('setupDone', true);
  ui.studio.setPreference('theme', 'dark');
  ui.button('Reset settings').click();
  assert.equal(ui.studio.preferences.theme, 'system');
  assert.equal(ui.studio.setupDone, true);
});

test('the setup names its steps in a row, jumps between them and rests focus on the primary button (#2847)', testContext => {
  const ui = mountStudio(testContext);
  const stepNames = () => ui.root.querySelectorAll('.crucible-studio-setup-step').map(button => button.textContent);
  ui.studio.openSetup();
  assert.deepEqual(stepNames(), ['Theme', 'Performance', 'Modelling', 'Keys', 'Number pad', 'AI agent']);
  assert.equal(ui.dom.document.activeElement, ui.root.querySelector('.crucible-studio-setup-dialog'), 'the dialog holds the focus, so no control starts with a ring');
  const performanceStep = ui.root.querySelectorAll('.crucible-studio-setup-step')[1];
  performanceStep.click();
  assert.equal(performanceStep.getAttribute('aria-current'), 'step');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-setup-group').filter(group => !group.inert).length, 1);
  ui.root.querySelectorAll('.crucible-studio-setup-step')[5].click();
  assert.equal(setupButton(ui, 'Done').hidden, false);
});

function hasIcon(element) {
  return element.descendants().some(descendant => descendant.tagName === 'svg' || descendant.tagName === 'SVG');
}

test('each theme card holds a miniature of the real Studio chrome: inert, hidden from assistive technology, no text and no ids (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  const previews = ['system', 'light', 'dark'].map(theme => setupCard(ui, 'theme', theme).parentNode.querySelector('.crucible-studio-setup-preview'));
  previews.forEach(preview => {
    assert.ok(preview, 'every theme card has a preview');
    assert.equal(preview.inert, true);
    assert.equal(preview.getAttribute('aria-hidden'), 'true');
    assert.equal(preview.textContent.trim(), '', 'a miniature carries no text');
    assert.ok(preview.descendants().every(element => !element.id), 'a miniature carries no id');
    assert.ok(preview.descendants().every(element => !element.hasAttribute('aria-label') && !element.title), 'and no label that would repeat the real Studio');
  });
  const themesOf = preview => preview.querySelectorAll('.crucible-studio-miniature').map(miniature => miniature.dataset.theme);
  assert.deepEqual(themesOf(previews[0]), ['light', 'dark'], 'System shows both halves');
  assert.deepEqual(themesOf(previews[1]), ['light']);
  assert.deepEqual(themesOf(previews[2]), ['dark']);
  const miniature = previews[1].querySelector('.crucible-studio-miniature');
  for (const className of ['crucible-studio-viewport', 'crucible-studio-menubar', 'crucible-studio-toolbar', 'crucible-studio-side', 'crucible-studio-outliner', 'crucible-studio-inspector']) {
    assert.ok(miniature.querySelector(`.${className}`), `the miniature has the real ${className}`);
  }
  assert.equal(miniature.dataset.floating, 'false', 'the miniature shows the default docked panels');
  assert.ok(hasIcon(miniature.querySelector('.crucible-studio-toolbar')), 'the rail keeps its icons');
  assert.equal(miniature.querySelector('.crucible-studio-viewport').children.length, 0, 'the viewport is a plain block');
  assert.equal(miniature.querySelector('.crucible-studio-outliner').children.length, 0, 'the panel cards are empty surfaces');
  assert.equal(previews[1].querySelectorAll('canvas').length, 0);
});

test('the miniatures are built once, when the setup first opens, and the dialog holds no sketch parts (#2847)', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.root.querySelectorAll('.crucible-studio-miniature').length, 0, 'nothing is built before the dialog opens');
  ui.studio.openSetup();
  assert.equal(ui.root.querySelectorAll('.crucible-studio-miniature').length, 4);
  setupButton(ui, 'Skip').click();
  ui.studio.openSetup();
  assert.equal(ui.root.querySelectorAll('.crucible-studio-miniature').length, 4, 'a second open builds nothing new');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-setup-sketch-part').length, 0);
  assert.ok(STUDIO_CSS.includes('.crucible-studio-miniature[data-half="left"]'));
});

test('every performance tier card and every modelling row carries an icon, and each step names its icon (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  for (const tier of ['automatic', 'light', 'balanced', 'sharp']) {
    assert.ok(hasIcon(setupCard(ui, 'performance', tier).parentNode.querySelector('.crucible-studio-setup-card-name')), `the ${tier} tier has an icon`);
  }
  const tierIcons = ['automatic', 'light', 'balanced', 'sharp'].map(tier => setupCard(ui, 'performance', tier).parentNode.querySelector('.crucible-studio-icon path').getAttribute('d'));
  assert.equal(new Set(tierIcons).size, 4, 'the four tiers have four different icons');
  const rows = ui.root.querySelectorAll('.crucible-studio-setup-row');
  assert.equal(rows.length, 4);
  rows.forEach(row => assert.ok(hasIcon(row.querySelector('.crucible-studio-setup-row-label')), 'a modelling row has an icon on its label'));
  ui.root.querySelectorAll('.crucible-studio-setup-step').forEach(step => assert.ok(hasIcon(step), 'a step has an icon'));
  ['build', 'look', 'animate'].forEach(workspace => assert.ok(hasIcon(setupCard(ui, 'startWorkspace', workspace).parentNode), `the ${workspace} chip has an icon`));
  agentCards(ui).forEach(card => assert.ok(hasIcon(card.querySelector('.crucible-studio-setup-agent-head')), 'each card of the agent step has an icon on its title'));
});

test('each tier card shows its pixel ratio and anti-aliasing on this screen, and Automatic names the tier it took instead of repeating its numbers (#2847)', testContext => {
  const ui = mountStudio(testContext);
  ui.dom.document.defaultView.devicePixelRatio = 1;
  ui.studio.openSetup();
  const facts = card => card.querySelectorAll('.crucible-studio-setup-fact').map(fact => fact.textContent);
  const cardOf = value => setupCard(ui, 'performance', value).parentNode;
  assert.deepEqual(facts(cardOf('light')), ['0.75x', 'AA 2x']);
  assert.deepEqual(facts(cardOf('balanced')), ['1x', 'AA 2x']);
  assert.deepEqual(facts(cardOf('sharp')), ['1x', 'AA 4x']);
  assert.deepEqual(facts(cardOf('automatic')), [], 'Automatic repeats no numbers');
  assert.equal(cardOf('automatic').querySelector('.crucible-studio-setup-facts').textContent, 'Balanced on this machine');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-setup-pick').length, 0, 'no dot marks a tier card');
  assert.equal(cardOf('automatic').querySelector('.crucible-studio-setup-card-detail').textContent, 'Hardware not reported');
  assert.equal(cardOf('automatic').querySelector('.crucible-studio-setup-card-detail').title, 'Hardware not reported');
});

test('the agent step shows the prompt and the copy button says Copied with a check once it is on the clipboard (#2847)', async testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  const prompt = ui.root.querySelector('.crucible-studio-setup-prompt');
  assert.equal(prompt.readOnly, true);
  assert.match(prompt.value, /Edit Crucible scene/);
  const copyButton = setupButton(ui, 'Copy prompt');
  const copyIcon = iconPathOf(copyButton);
  copyButton.click();
  await ui.dom.settle();
  const copied = setupButton(ui, 'Copied');
  assert.ok(copied, 'the button shows Copied');
  assert.notEqual(iconPathOf(copied), copyIcon, 'with a check mark instead of the copy icon');
  assert.equal(ui.dom.clipboardTexts[0], prompt.value);
  assert.equal(ui.status(), '', 'the button says it, so no status toast says it again (#3311)');
});

test('a blocked clipboard leaves the copy button as it was instead of saying Copied (#3311)', async testContext => {
  const ui = mountStudio(testContext, { domOptions: { clipboardFails: true } });
  ui.studio.openSetup();
  setupButton(ui, 'Copy prompt').click();
  await ui.dom.settle();
  assert.equal(setupButton(ui, 'Copied'), undefined);
  assert.ok(setupButton(ui, 'Copy prompt'));
});

// Keymap presets (#2847): the preference swaps the keys live.
function keyboardUi(testContext, keymap) {
  const ui = mountStudio(testContext);
  chooseSetting(ui, 'keymap', keymap);
  ui.selectRow('hero');
  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  const press = (key, properties = {}) => dispatch(ui.dom.document, 'keydown', { key, ...properties });
  return { ui, press };
}

test('the Maya keymap: W, E and R choose the tool without picking the object up, and S keys', async testContext => {
  const { ui, press } = keyboardUi(testContext, 'maya');
  assert.equal(ui.studio.preferences.keymap, 'maya');
  press('w');
  assert.equal(ui.controller.tool, 'translate');
  assert.equal(ui.root.dataset.modal, undefined, 'a Maya tool key does not start a grab');
  assert.equal(ui.controller.dragging, false);
  press('e');
  assert.equal(ui.controller.tool, 'rotate');
  press('r');
  assert.equal(ui.controller.tool, 'scale');
  assert.equal(ui.root.dataset.modal, undefined);
  press('q');
  assert.equal(ui.controller.tool, 'select');
  press('g');
  assert.notEqual(ui.controller.tool, 'translate', 'G is Blender\'s key, not Maya\'s');
  press('s');
  await ui.dom.settle();
  assert.equal(ui.studio.exportRecipe().motion.tracks.length > 0, true, 'S sets a key');
  assert.notEqual(ui.controller.tool, 'scale', 'S no longer scales');
  const nodeCount = ui.studio.exportRecipe().nodes.length;
  press('x');
  assert.equal(ui.studio.exportRecipe().nodes.length, nodeCount, 'X no longer deletes');
  press('Delete');
  assert.equal(ui.studio.exportRecipe().nodes.length, nodeCount - 1);
});

test('the Cinema 4D keymap: E, R and T choose the tool, 9 selects and F9 keys', async testContext => {
  const { ui, press } = keyboardUi(testContext, 'cinema4d');
  press('e');
  assert.equal(ui.controller.tool, 'translate');
  assert.equal(ui.root.dataset.modal, undefined);
  press('r');
  assert.equal(ui.controller.tool, 'rotate');
  press('t');
  assert.equal(ui.controller.tool, 'scale');
  assert.equal(ui.root.dataset.modal, undefined);
  press('9');
  assert.equal(ui.controller.tool, 'select');
  press('S', { shiftKey: true });
  assert.equal(ui.studio.preferences.snapEnabled, true, 'Shift+S, the Cinema 4D snapping key, turns snapping on');
  press('F9');
  await ui.dom.settle();
  assert.equal(ui.studio.exportRecipe().motion.tracks.length > 0, true, 'F9 sets a key');
});

test('the Blender keymap still picks the object up on G, and switching keymaps back restores it', testContext => {
  const { ui, press } = keyboardUi(testContext, 'maya');
  chooseSetting(ui, 'keymap', 'crucible');
  press('g');
  assert.equal(ui.root.dataset.modal, 'translate');
  press('Escape');
  assert.equal(ui.root.dataset.modal, undefined);
});

test('choosing a keymap rewrites the menu keys, the tooltips and the shortcuts dialog at once', testContext => {
  const ui = mountStudio(testContext);
  const editMenu = ui.root.querySelector('#crucible-studio-pop-edit');
  const objectMenu = ui.root.querySelector('#crucible-studio-pop-object');
  const shortcutsText = () => ui.root.querySelector('.crucible-studio-shortcuts').textContent;
  assert.equal(byText(editMenu, 'Hide').dataset.shortcut, 'H');
  assert.equal(byText(editMenu, 'Duplicate').dataset.shortcut, 'Shift+D');
  assert.ok(ui.label('Move (G)'));
  assert.match(shortcutsText(), /Pick up to move/);

  chooseSetting(ui, 'keymap', 'maya');
  assert.equal(byText(editMenu, 'Hide').dataset.shortcut, 'Ctrl+H');
  assert.equal(byText(editMenu, 'Show all').dataset.shortcut, 'Ctrl+Shift+H');
  assert.equal(byText(editMenu, 'Duplicate').dataset.shortcut, 'Ctrl+D');
  assert.equal(byText(objectMenu, 'Frame').dataset.shortcut, 'F');
  assert.equal(byText(ui.root.querySelector('#crucible-studio-pop-view'), 'Properties').dataset.shortcut, 'Ctrl+A');
  assert.ok(ui.label('Move (W)'));
  assert.ok(ui.label('Scale (R)'));
  assert.ok(ui.label('Redo (Ctrl+Y)'));
  assert.ok(ui.label('Play (Alt+V)'));
  assert.ok(ui.label('Add a keyframe here (S)'));
  assert.match(shortcutsText(), /MoveW.*RotateE.*ScaleR/);
  assert.match(shortcutsText(), /Alt \+ left drag/);
  assert.doesNotMatch(shortcutsText(), /While holding/);

  chooseSetting(ui, 'keymap', 'cinema4d');
  assert.equal(byText(editMenu, 'Hide').dataset.shortcut, 'H');
  assert.equal(byText(ui.root.querySelector('#crucible-studio-pop-view'), 'Properties').dataset.shortcut, 'Shift+F5');
  assert.ok(ui.label('Scale (T)'));
  assert.ok(ui.label('Play (F8)'));

  chooseSetting(ui, 'keymap', 'crucible');
  assert.equal(byText(editMenu, 'Hide').dataset.shortcut, 'H');
  assert.ok(ui.label('Move (G)'));
  assert.match(shortcutsText(), /Pick up to move/);
});

test('the keymap starts from the saved preference', testContext => {
  const ui = mountStudio(testContext, { preferences: { keymap: 'cinema4d' } });
  assert.ok(ui.label('Rotate (R)'));
  assert.ok(ui.label('Move (E)'));
  assert.equal(byText(ui.root.querySelector('#crucible-studio-pop-view'), 'Properties').dataset.shortcut, 'Shift+F5');
});

test('Settings has a Keys row with Blender, Maya and Cinema 4D', testContext => {
  const ui = mountStudio(testContext);
  const control = ui.root.querySelector('.crucible-studio-settings-dialog').descendants().find(element => element.dataset?.setting === 'keymap');
  assert.deepEqual(control.querySelectorAll('option').map(option => [option.value, option.textContent]), [['crucible', 'Blender'], ['maya', 'Maya'], ['cinema4d', 'Cinema 4D']]);
  assert.equal(control.value, 'crucible');
});

test('the setup has a Keys step after Modelling with a card per program, each with its logo and its real keys', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.openSetup();
  const names = ui.root.querySelectorAll('.crucible-studio-setup-step').map(button => button.textContent);
  assert.deepEqual(names.slice(2, 6), ['Modelling', 'Keys', 'Number pad', 'AI agent']);
  const expectedKeys = { crucible: ['G', 'R', 'S', 'F'], maya: ['W', 'E', 'R', 'F'], cinema4d: ['E', 'R', 'T', 'O'] };
  const expectedLabels = { crucible: 'Blender', maya: 'Maya', cinema4d: 'Cinema 4D' };
  for (const [preset, keys] of Object.entries(expectedKeys)) {
    const card = setupCard(ui, 'keymap', preset).parentNode;
    assert.equal(card.querySelector('.crucible-studio-setup-card-label').textContent, expectedLabels[preset]);
    const logo = card.querySelector('.crucible-studio-setup-card-name svg');
    assert.equal(logo.dataset.brand, 'true', `${preset} has a brand logo`);
    assert.equal(logo.querySelectorAll('path').length, 1);
    assert.deepEqual(card.querySelectorAll('kbd').map(key => key.textContent), keys);
  }
  assert.equal(setupCard(ui, 'keymap', 'crucible').checked, true);
  const maya = setupCard(ui, 'keymap', 'maya');
  maya.checked = true;
  dispatch(maya, 'change');
  assert.equal(ui.studio.preferences.keymap, 'maya');
  assert.equal(setupCard(ui, 'keymap', 'maya').parentNode.dataset.selected, 'true');
  assert.ok(ui.label('Move (W)'), 'the live Studio behind the dialog follows');
});

test('Maya and Cinema 4D navigate with Alt and a mouse button, and the Blender keymap does not', testContext => {
  const ui = mountStudio(testContext);
  const start = ui.clientPoint({ x: 400, y: 300 });
  const distance = () => Math.hypot(...ui.controller.scene.camera.eye.map((value, index) => value - ui.controller.scene.camera.target[index]));
  const drag = (button, to) => {
    dispatch(ui.canvas, 'pointerdown', { ...start, button, altKey: true });
    dispatch(ui.canvas, 'pointermove', ui.clientPoint(to));
    dispatch(ui.canvas, 'pointerup', ui.clientPoint(to));
  };

  ui.controller.selectNode(null);
  chooseSetting(ui, 'keymap', 'maya');
  let eyeBefore = ui.controller.scene.camera.eye.slice();
  drag(0, { x: 500, y: 320 });
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore, 'Alt and the left button orbit');
  assert.equal(ui.controller.selectedNodeId, null, 'a navigation drag does not select');
  let targetBefore = ui.controller.scene.camera.target.slice();
  drag(1, { x: 480, y: 340 });
  assert.notDeepEqual(ui.controller.scene.camera.target, targetBefore, 'Alt and the middle button pan');
  const distanceBefore = distance();
  drag(2, { x: 460, y: 240 });
  assert.ok(distance() < distanceBefore, 'Alt and the right button zoom in when dragged right and up');
  assert.equal(ui.controller.selectedNodeId, null);
  const orbPoint = ui.clientPoint(ui.controller.projectWorldPoint([2.2, 0.5, 0]));
  dispatch(ui.canvas, 'pointerdown', { ...orbPoint, altKey: true });
  dispatch(ui.canvas, 'pointerup', { ...orbPoint, altKey: true });
  assert.equal(ui.controller.selectedNodeId, null, 'an Alt click over an object does not pick it');
  dispatch(ui.canvas, 'pointerdown', orbPoint);
  dispatch(ui.canvas, 'pointerup', orbPoint);
  assert.equal(ui.controller.selectedNodeId, 'orb', 'a plain click still picks');
  ui.controller.selectNode(null);

  chooseSetting(ui, 'keymap', 'cinema4d');
  eyeBefore = ui.controller.scene.camera.eye.slice();
  drag(0, { x: 560, y: 330 });
  assert.notDeepEqual(ui.controller.scene.camera.eye, eyeBefore);

  chooseSetting(ui, 'keymap', 'crucible');
  targetBefore = ui.controller.scene.camera.target.slice();
  drag(2, { x: 420, y: 300 });
  assert.notDeepEqual(ui.controller.scene.camera.target, targetBefore, 'the default right drag still pans, whatever the keymap');
});

// Snapping is a state on the rail, not a tool (#3342).
function snapParts(ui) {
  return {
    toggle: byDataset(ui.root, 'snapToggle', 'true'),
    targetButton: byDataset(ui.root, 'snapTargetButton', 'true'),
    popover: ui.root.querySelector('#crucible-studio-pop-snap'),
  };
}

test('the magnet toggle and its target menu sit on the rail, lit when on, and are kept for the next visit (#3342)', testContext => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage });
  const { toggle, targetButton, popover } = snapParts(ui);
  assert.equal(toggle.dataset.icon, 'snap');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.match(toggle.getAttribute('aria-label'), /^Snapping off \(Shift\+Tab\)$/);
  assert.equal(targetButton.getAttribute('aria-label'), 'Snap to Increment');
  assert.deepEqual(popover.querySelectorAll('button').map(item => [item.textContent, item.dataset.snapTarget, item.querySelector('svg') !== null]), [
    ['Increment', 'increment', true],
    ['Vertex', 'vertex', true],
    ['Face', 'face', true],
  ]);
  assert.deepEqual(popover.querySelectorAll('button').map(item => item.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.ok(STUDIO_CSS.includes('button[data-snap-toggle][aria-pressed="true"] svg'), 'the lit magnet is filled, not only tinted');

  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.controller.interactionSettings.snapEnabled, true);
  assert.match(toggle.getAttribute('aria-label'), /^Snapping on/);
  assert.equal(ui.status(), 'Snapping on, to Increment');

  byText(popover, 'Vertex').click();
  assert.equal(ui.controller.interactionSettings.snapTarget, 'vertex');
  assert.equal(targetButton.dataset.icon, 'meshVertex');
  assert.equal(targetButton.getAttribute('aria-label'), 'Snap to Vertex');
  assert.deepEqual(popover.querySelectorAll('button').map(item => item.getAttribute('aria-checked')), ['false', 'true', 'false']);

  const next = mountStudio(testContext, { preferenceStorage, sharedDom: ui.dom });
  const nextParts = snapParts(next);
  assert.equal(nextParts.toggle.getAttribute('aria-pressed'), 'true', 'the state comes back');
  assert.equal(nextParts.targetButton.getAttribute('aria-label'), 'Snap to Vertex', 'and so does the target');
  assert.deepEqual([next.controller.interactionSettings.snapEnabled, next.controller.interactionSettings.snapTarget], [true, 'vertex']);

  next.button('Reset settings').click();
  assert.equal(nextParts.toggle.getAttribute('aria-pressed'), 'false', 'Reset turns snapping off');
  assert.equal(nextParts.targetButton.getAttribute('aria-label'), 'Snap to Increment', 'and back to Increment');
});

test('Shift+Tab toggles snapping from the page or the canvas, and leaves Tab to the browser anywhere else (#3342)', testContext => {
  const ui = mountStudio(testContext);
  const { toggle } = snapParts(ui);
  const shiftTab = target => dispatch(target, 'keydown', { key: 'Tab', shiftKey: true });

  assert.equal(shiftTab(ui.dom.document).defaultPrevented, true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  shiftTab(ui.canvas);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'from the canvas too, with the pointer over the viewport');

  const onButton = shiftTab(ui.label('Delete (Del)'));
  assert.equal(onButton.defaultPrevented, false, 'a focused control keeps Shift+Tab as the way back');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  const inField = shiftTab(ui.root.querySelector('input'));
  assert.equal(inField.defaultPrevented, false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  byText(ui.root, 'Settings…').click();
  shiftTab(ui.dom.document);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'nothing happens behind an open dialog');
});

test('Shift+Tab does not enter edit mode (#3342)', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  const meshBefore = ui.root.dataset.meshEdit;
  dispatch(ui.dom.document, 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(ui.root.dataset.meshEdit, meshBefore, 'Shift+Tab only toggled snapping');
  assert.equal(snapParts(ui).toggle.getAttribute('aria-pressed'), 'true');
});

test('holding or letting go of Ctrl flips snapping for a handle drag at once, in both directions (#3342)', testContext => {
  const ui = mountStudio(testContext);
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const along = distance => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.x[index] * distance));
  const heroX = () => ui.node('hero').translation[0];
  const onStep = value => Math.abs(value / 0.25 - Math.round(value / 0.25)) < 1e-6;

  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(along(handles.handleLength + 0.83)));
  const free = heroX();
  assert.equal(onStep(free), false, 'snapping is off: the move is free');
  dispatch(ui.dom.document, 'keydown', { key: 'Control', ctrlKey: true });
  assert.equal(onStep(heroX()), true, 'Ctrl down snaps the move in hand without the pointer moving');
  dispatch(ui.dom.document, 'keyup', { key: 'Control', ctrlKey: false });
  assert.equal(heroX(), free, 'Ctrl up gives the free move back');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength + 0.83)));

  snapParts(ui).toggle.click();
  ui.controller.updateNodeTransform('hero', { translation: [0, 0.5, 0] });
  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(along(handles.handleLength + 0.83)));
  assert.equal(onStep(heroX()), true, 'snapping is on: the move is on the step');
  dispatch(ui.dom.document, 'keydown', { key: 'Control', ctrlKey: true });
  assert.equal(onStep(heroX()), false, 'Ctrl down frees it');
  dispatch(ui.dom.document, 'keyup', { key: 'Control', ctrlKey: false });
  assert.equal(onStep(heroX()), true, 'Ctrl up snaps it again');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength + 0.83)));
});

test('G and R obey the snapping state, and Ctrl flips it while the object is held (#3342)', testContext => {
  const ui = mountStudio(testContext);
  const press = (key, modifiers = {}) => dispatch(ui.dom.document, 'keydown', { key, ...modifiers });
  const heroX = () => ui.node('hero').translation[0];
  const onStep = value => Math.abs(value / 0.25 - Math.round(value / 0.25)) < 1e-6;
  ui.controller.selectNode('hero');
  snapParts(ui).toggle.click();

  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  press('g');
  press('x');
  dispatch(ui.dom.document, 'pointermove', { clientX: 377, clientY: 200 });
  assert.equal(onStep(heroX()) && heroX() !== 0, true, `G with snapping on lands on the step: ${heroX()}`);
  press('Control', { ctrlKey: true });
  assert.equal(onStep(heroX()), false, 'Ctrl while holding frees the move');
  dispatch(ui.dom.document, 'keyup', { key: 'Control', ctrlKey: false });
  assert.equal(onStep(heroX()), true);
  press('Escape');

  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  press('r');
  dispatch(ui.dom.document, 'pointermove', { clientX: 333, clientY: 200 });
  const turned = ui.node('hero').rotation;
  const degrees = (2 * Math.asin(Math.max(Math.abs(turned[0]), Math.abs(turned[1]), Math.abs(turned[2]))) * 180) / Math.PI;
  assert.ok(Math.abs(degrees / 15 - Math.round(degrees / 15)) < 1e-3 && degrees > 1, `R turns in 15 degree steps: ${degrees}`);
  press('Escape');
});

test('select all belongs to Studio only when the event comes from Studio (#3328)', testContext => {
  const ui = mountStudio(testContext);
  const hostText = ui.dom.document.createElement('p');
  ui.dom.document.body.append(hostText);
  const outside = dispatch(hostText, 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(outside.defaultPrevented, false, 'text of the host page outside Studio selects as usual');

  const shadowTextarea = ui.dom.document.createElement('textarea');
  const shadowHost = ui.dom.document.createElement('div');
  ui.dom.document.body.append(shadowHost);
  const retargeted = dispatch(shadowHost, 'keydown', { key: 'a', ctrlKey: true, composedPath: () => [shadowTextarea, {}, shadowHost, ui.dom.document.body, ui.dom.document] });
  assert.equal(retargeted.defaultPrevented, false, 'a field inside a host shadow root selects its own text');

  const insideStudioShadow = dispatch(shadowHost, 'keydown', { key: 'a', ctrlKey: true, composedPath: () => [shadowTextarea, ui.root, ui.dom.document.body] });
  assert.equal(insideStudioShadow.defaultPrevented, false, 'a field anywhere on the path wins over the Studio root');

  const layoutKey = dispatch(ui.tool('select'), 'keydown', { key: 'ф', code: 'KeyA', ctrlKey: true });
  assert.equal(layoutKey.defaultPrevented, true, 'another keyboard layout is matched by its key code');

  dispatch(ui.tool('select'), 'pointerdown');
  const fellToBody = dispatch(ui.dom.document.body, 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(fellToBody.defaultPrevented, true, 'a click on Studio chrome leaves the focus on the body, and select all still goes to Studio');
  dispatch(hostText, 'pointerdown');
  const afterHostClick = dispatch(ui.dom.document.body, 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(afterHostClick.defaultPrevented, false, 'after a click on the host page the host page keeps select all');
});

test('an error message is selectable text in the status toast, an ordinary notice is not (#3328)', async testContext => {
  const ui = mountStudio(testContext);
  const selectableIn = element => element.querySelectorAll('.crucible-studio-selectable').map(part => part.textContent);
  const statusRegion = ui.root.querySelector('.crucible-studio-status');
  const [recipeDialog] = ui.root.querySelectorAll('dialog');
  ui.button('Recipe JSON').click();
  recipeDialog.querySelector('textarea').value = '{ not json';
  byText(recipeDialog, 'Apply JSON').click();
  await ui.dom.settle();
  assert.deepEqual(selectableIn(statusRegion), [ui.status()], 'the whole toast is the error message, so only that text is marked');
  assert.match(ui.status(), /JSON/);
  ui.selectRow('hero');
  ui.root.querySelectorAll('button').find(button => button.getAttribute('aria-label')?.startsWith('Duplicate')).click();
  assert.match(ui.status(), /Duplicated/);
  assert.deepEqual(selectableIn(statusRegion), [], 'an ordinary notice replaces it and is not selectable');

});

test('the driver message in the paused notice is selectable, the sentence around it is not (#3328)', testContext => {
  const ui = mountStudio(testContext);
  const selectableIn = element => element.querySelectorAll('.crucible-studio-selectable').map(part => part.textContent);
  ui.renderer.updateFailure = new Error('WebGL replacement allocation failed with error 37442');
  ui.selectRow('hero');
  ui.dom.runAnimationFrames(100);
  const notice = pausedNotice(ui);
  assert.deepEqual(selectableIn(notice), ['WebGL replacement allocation failed with error 37442'], 'the driver message can be copied, the sentence around it cannot');
  dispatch(ui.canvas, 'webglcontextlost');
  assert.deepEqual(selectableIn(notice), [], 'the fixed lost-context sentence is not selectable');
});

test('select all is kept from the page outside a text field, in any mode, and left to a text field (#3328)', testContext => {
  const ui = mountStudio(testContext);
  const onButton = dispatch(ui.tool('select'), 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(onButton.defaultPrevented, true, 'the browser would highlight the page');
  const withCommand = dispatch(ui.tool('select'), 'keydown', { key: 'A', metaKey: true });
  assert.equal(withCommand.defaultPrevented, true);
  const inField = dispatch(ui.label('Filter the scene list'), 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(inField.defaultPrevented, false, 'a field selects its own text');
  const plain = dispatch(ui.tool('select'), 'keydown', { key: 'a' });
  assert.equal(plain.defaultPrevented, false);
});

test('settleUntil keeps waiting past a few hundred event-loop turns, as a thread-pool hash on a loaded runner needs (#3330)', async testContext => {
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  let turns = 0;
  const countTurns = () => {
    turns += 1;
    if (turns < 1500) setImmediate(countTurns);
  };
  setImmediate(countTurns);
  await dom.settleUntil(() => turns >= 1500);
  assert.equal(turns, 1500, 'the wait lasted until the work was done, not a fixed 400 turns');
});

test('settleUntil gives up at its deadline when the work never finishes', async testContext => {
  const dom = installStudioDom();
  testContext.after(() => dom.uninstall());
  const started = performance.now();
  await dom.settleUntil(() => false, 50);
  const waited = performance.now() - started;
  assert.ok(waited >= 50 && waited < 5000, `waited ${waited} ms for a 50 ms deadline`);
});

test('in Export the controls that do nothing look disabled, a save draws no toast and the picture shape is labelled (#3343)', async testContext => {
  const ui = mountStudio(testContext);
  const gridButton = ui.root.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Show or hide the grid');
  const rowIn = (popoverId, label) => ui.root.querySelectorAll('.crucible-studio-popover').find(popover => popover.id === popoverId).querySelectorAll('button').find(button => button.textContent.startsWith(label));
  const blockedRows = [['edit', 'Duplicate'], ['edit', 'Delete'], ['view', 'Grid'], ['view', 'Frame the selection']].map(([menu, label]) => rowIn(`crucible-studio-pop-${menu}`, label));
  for (const control of [gridButton, ...blockedRows]) assert.notEqual(control.getAttribute('aria-disabled'), 'true', 'live in Build');
  const allowedRows = [rowIn('crucible-studio-pop-new', 'Save'), rowIn('crucible-studio-pop-new', 'Open')];

  byDataset(ui.root, 'workspace', 'export').click();
  for (const control of [gridButton, ...blockedRows]) assert.equal(control.getAttribute('aria-disabled'), 'true', 'dimmed in Export like undo with nothing to undo');
  for (const row of allowedRows) assert.notEqual(row.getAttribute('aria-disabled'), 'true', 'the file rows stay live');
  const gridBefore = ui.controller.scene.revision;
  gridButton.click();
  assert.equal(ui.studio.gridVisible, true, 'the grid toggle does nothing in Export');
  assert.equal(ui.controller.scene.revision, gridBefore);

  const shape = ui.root.querySelectorAll('.crucible-studio-export-frame')[0];
  assert.equal(shape.getAttribute('role'), 'img');
  assert.equal(shape.getAttribute('aria-label'), 'Shape of the picture');

  byText(ui.root, 'Save PNG').click();
  await ui.dom.settle();
  const toast = ui.root.querySelector('.crucible-studio-status');
  assert.equal(ui.status(), 'Saved PNG still', 'a screen reader still hears it');
  assert.equal(toast.getAttribute('data-quiet'), 'true', 'and nothing is drawn');
  assert.ok(ui.root.querySelectorAll('.crucible-studio-export-result').some(result => result.textContent.includes('.png')), 'the result line is the report');

  byDataset(ui.root, 'workspace', 'build').click();
  for (const control of [gridButton, ...blockedRows]) assert.equal(control.getAttribute('aria-disabled'), 'false', 'live again in Build');
});

test('Shift+Tab on the focused canvas is the browser reverse tab while the pointer is off the viewport (#3342)', testContext => {
  const ui = mountStudio(testContext);
  const { toggle } = snapParts(ui);
  const shiftTab = target => dispatch(target, 'keydown', { key: 'Tab', shiftKey: true });

  const withoutPointer = shiftTab(ui.canvas);
  assert.equal(withoutPointer.defaultPrevented, false, 'no pointer over the viewport: the browser takes it');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  assert.equal(shiftTab(ui.canvas).defaultPrevented, true, 'pointer over the viewport: snapping takes it');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  dispatch(ui.viewport, 'pointerleave');
  const afterLeaving = shiftTab(ui.canvas);
  assert.equal(afterLeaving.defaultPrevented, false, 'the pointer left: the browser takes it again');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  assert.equal(shiftTab(ui.dom.document).defaultPrevented, true, 'with nothing focused it still toggles');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

test('no object menu opens over a handle drag or a G, R or S move, and its context menu is still swallowed (#3342)', testContext => {
  const ui = mountStudio(testContext);
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const tip = ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.x[index] * handles.handleLength));

  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(tip));
  assert.equal(ui.controller.dragging, true);
  const duringDrag = dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(duringDrag.defaultPrevented, true);
  assert.notEqual(menu.popoverOpen, true, 'no menu over a handle drag');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(tip));

  dispatch(ui.viewport, 'pointermove', { clientX: 300, clientY: 200 });
  dispatch(ui.dom.document, 'keydown', { key: 'g' });
  assert.equal(ui.root.dataset.modal !== undefined, true);
  const duringMove = dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(duringMove.defaultPrevented, true);
  assert.notEqual(menu.popoverOpen, true, 'no menu over a G move');
  dispatch(ui.dom.document, 'keydown', { key: 'Escape' });

  dispatch(ui.gizmo, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(menu.popoverOpen, true, 'with nothing in hand the menu opens as before');
});

test('the window losing focus during a handle drag lets go of Ctrl, and a cancel with Ctrl held puts the object back (#3342)', testContext => {
  const dom = installStudioDom();
  const windowListeners = new Map();
  dom.document.defaultView.addEventListener = (type, listener) => windowListeners.set(type, listener);
  dom.document.defaultView.removeEventListener = type => windowListeners.delete(type);
  testContext.after(() => dom.uninstall());
  const ui = mountStudio(testContext, { sharedDom: dom });
  ui.selectRow('hero');
  ui.tool('translate').click();
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const along = distance => ui.controller.projectWorldPoint(handles.pivot.map((value, index) => value + handles.basis.x[index] * distance));
  const heroX = () => ui.node('hero').translation[0];
  const onStep = value => Math.abs(value / 0.25 - Math.round(value / 0.25)) < 1e-6;
  const start = heroX();

  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(along(handles.handleLength + 0.83)));
  const free = heroX();
  dispatch(ui.dom.document, 'keydown', { key: 'Control', ctrlKey: true });
  assert.equal(onStep(heroX()), true, 'Ctrl held: on the step');
  windowListeners.get('blur')();
  assert.equal(heroX(), free, 'blur lets go of Ctrl: the free move is back');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength + 0.83)));

  ui.controller.updateNodeTransform('hero', { translation: [start, 0.5, 0] });
  dispatch(ui.gizmoPart('x'), 'pointerdown', ui.clientPoint(along(handles.handleLength)));
  dispatch(ui.canvas, 'pointermove', ui.clientPoint(along(handles.handleLength + 0.83)));
  dispatch(ui.dom.document, 'keydown', { key: 'Control', ctrlKey: true });
  assert.equal(ui.controller.cancelGizmoDrag(), true);
  assert.equal(heroX(), start, 'cancel with Ctrl held puts the object back');
  dispatch(ui.dom.document, 'keyup', { key: 'Control', ctrlKey: false });
  windowListeners.get('blur')();
  assert.equal(heroX(), start, 'a later Ctrl release or blur moves nothing');
  dispatch(ui.canvas, 'pointerup', ui.clientPoint(along(handles.handleLength)));
  assert.equal(heroX(), start);
});

test('the target button always shows the icon of the active target, open or closed (#3342)', testContext => {
  const ui = mountStudio(testContext);
  const { targetButton, popover } = snapParts(ui);
  assert.equal(targetButton.dataset.icon, 'grid');
  popover.showPopover();
  assert.equal(targetButton.dataset.icon, 'grid', 'opening the menu is not a different glyph');
  byDataset(popover, 'snapTarget', 'vertex').click();
  assert.equal(targetButton.dataset.icon, 'meshVertex', 'choosing a target changes it for good');
});

function makeFiveEdits(ui) {
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  ui.controller.updateNodeTransform('hero', { rotationDegrees: [0, 45, 0] });
  ui.controller.updateNodeTransform('orb', { scale: [0.8, 0.8, 0.8] });
  ui.controller.addPrimitive('box');
  ui.controller.updateNodeTransform('hero', { visible: false });
}

const historyPanelOf = ui => ui.root.querySelector('.crucible-studio-history');
const historyRows = ui => historyPanelOf(ui).querySelectorAll('.crucible-studio-history-row');
const historyRow = (ui, name) => historyRows(ui).find(row => row.dataset.label === name);
const historyStates = ui => historyRows(ui).map(row => row.dataset.state);
const editPopoverOf = ui => ui.root.querySelector('#crucible-studio-pop-edit');
const viewPopoverOf = ui => ui.root.querySelector('#crucible-studio-pop-view');
const showHistoryFromViewMenu = ui => byText(viewPopoverOf(ui), 'History').click();
const mountWithStorage = (testContext, options = {}) => {
  const saved = new Map();
  const preferenceStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  return { saved, preferenceStorage, ui: mountStudio(testContext, { preferenceStorage, ...options }) };
};

test('the Edit menu shows Undo, Redo, History and Settings with an icon, and Undo and Redo show their keys', testContext => {
  const ui = mountStudio(testContext);
  const editMenu = editPopoverOf(ui);
  const rowNames = editMenu.querySelectorAll('button').map(row => row.textContent);
  assert.deepEqual(rowNames.slice(0, 3), ['Undo', 'Redo', 'History']);
  assert.ok(rowNames.includes('Settings…'));
  for (const name of ['Undo', 'Redo', 'History', 'Settings…']) {
    assert.match(String(byText(editMenu, name).children[0].getAttribute('class')), /crucible-studio-icon/, name);
  }
  assert.equal(byText(editMenu, 'Undo').dataset.shortcut, 'Ctrl+Z');
  assert.equal(byText(editMenu, 'Redo').dataset.shortcut, 'Ctrl+Shift+Z');
  byText(editMenu, 'Settings…').click();
  assert.ok(ui.root.querySelectorAll('dialog').some(dialog => dialog.open), 'Settings opens');
});

test('Copy, Paste, Duplicate and Deselect each have their own icon', testContext => {
  const ui = mountStudio(testContext);
  const iconPath = name => byText(editPopoverOf(ui), name).children[0].descendants().find(element => element.getAttribute('d'))?.getAttribute('d');
  const paths = ['Copy', 'Paste', 'Duplicate', 'Deselect'].map(iconPath);
  assert.ok(paths.every(Boolean), 'every row draws an icon');
  assert.equal(new Set(paths).size, 4);
});

test('Undo and Redo in the Edit menu are disabled until the stack has something to step to, and History is always there', testContext => {
  const ui = mountStudio(testContext);
  const editMenu = editPopoverOf(ui);
  const disabled = name => byText(editMenu, name).getAttribute('aria-disabled');
  assert.deepEqual(['Undo', 'Redo'].map(disabled), ['true', 'true']);
  assert.notEqual(disabled('History'), 'true');

  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  assert.deepEqual(['Undo', 'Redo'].map(disabled), ['false', 'true']);

  ui.controller.undo();
  assert.deepEqual(['Undo', 'Redo'].map(disabled), ['true', 'false']);
});

test('a dimmed menu row uses the muted token, which is over 3:1 on the menu surface in both themes', () => {
  const rule = STUDIO_CSS.slice(STUDIO_CSS.indexOf('.crucible-studio .crucible-studio-popover button[aria-disabled="true"] {'));
  assert.match(rule.slice(0, 120), /opacity: 1;\s+color: var\(--studio-muted\);/);
});

test('the History panel starts hidden and an empty history shows just Start', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.root.dataset.historyCollapsed, 'true');
  showHistoryFromViewMenu(ui);
  assert.equal(ui.root.dataset.historyCollapsed, 'false');
  assert.deepEqual(historyRows(ui).map(row => row.dataset.label), ['Start']);
  assert.equal(historyRows(ui)[0].getAttribute('aria-current'), 'step');
  assert.equal(historyPanelOf(ui).querySelector('.crucible-studio-dock-head').textContent, 'History');
  assert.equal(historyPanelOf(ui).querySelectorAll('button').some(button => button.getAttribute('aria-label') === 'Close'), false, 'a panel has no close button');
});

test('History rows follow edits live, oldest first, with the kind icon, the name and the target', testContext => {
  const ui = mountStudio(testContext);
  showHistoryFromViewMenu(ui);
  makeFiveEdits(ui);
  assert.deepEqual(historyRows(ui).map(row => row.dataset.label), ['Start', 'Move', 'Rotate', 'Scale', 'Add box', 'Hide']);
  assert.deepEqual(historyRows(ui).map(row => row.querySelector('.crucible-studio-history-detail')?.textContent ?? ''), ['', 'hero', 'hero', 'orb', '', 'hero']);
  assert.deepEqual(historyStates(ui), ['done', 'done', 'done', 'done', 'done', 'current']);
  const iconPaths = historyRows(ui).map(row => row.descendants().find(element => element.getAttribute('d'))?.getAttribute('d'));
  assert.ok(iconPaths.every(Boolean), 'every row draws an icon');
  assert.equal(new Set(iconPaths).size, 6, 'start, move, rotate, scale, add and hide each have their own icon');
  ui.controller.updateNodeTransform('orb', { translation: [3, 0.5, 0] });
  assert.equal(historyRows(ui).length, 7, 'a new edit adds its row at once');
  assert.equal(historyRows(ui)[6].dataset.state, 'current');
  assert.equal(historyRows(ui)[6].tabIndex, 0, 'the current row is the one Tab reaches');
});

test('a long name or target is cut with an ellipsis and its full text is in the title', testContext => {
  const ui = mountStudio(testContext);
  showHistoryFromViewMenu(ui);
  const longLabel = 'A very long object name that cannot fit in the panel';
  ui.controller.updateNodeTransform('hero', { label: longLabel });
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  assert.equal(historyRow(ui, 'Move').title.includes(longLabel), true);
  assert.match(STUDIO_CSS, /\.crucible-studio-history-name,\s*\.crucible-studio-history-detail \{[^}]*text-overflow: ellipsis;/);
});

test('a History row steps the scene to that edit in both directions', testContext => {
  const ui = mountStudio(testContext);
  const original = ui.studio.exportRecipe();
  showHistoryFromViewMenu(ui);
  ui.controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  const afterMove = ui.studio.exportRecipe();
  ui.controller.updateNodeTransform('orb', { scale: [0.8, 0.8, 0.8] });
  ui.controller.addPrimitive('box');
  const afterAdd = ui.studio.exportRecipe();

  historyRow(ui, 'Move').click();
  assert.deepEqual(ui.studio.exportRecipe(), afterMove, 'back to the move');
  assert.deepEqual(historyStates(ui), ['done', 'current', 'undone', 'undone']);
  assert.equal(ui.dom.document.activeElement, historyRow(ui, 'Move'));
  assert.equal(ui.status(), 'Went to Move');

  historyRow(ui, 'Add box').click();
  assert.deepEqual(ui.studio.exportRecipe(), afterAdd, 'forward again to the add');
  assert.deepEqual(historyStates(ui), ['done', 'done', 'done', 'current']);

  historyRow(ui, 'Start').click();
  assert.deepEqual(ui.studio.exportRecipe(), original);
  assert.equal(ui.controller.canUndo, false);
  assert.equal(ui.status(), 'Back to the start');
  assert.deepEqual(historyStates(ui), ['current', 'undone', 'undone', 'undone']);
});

test('undoing marks the rows after the current one as undone and a new edit removes them', testContext => {
  const ui = mountStudio(testContext);
  showHistoryFromViewMenu(ui);
  makeFiveEdits(ui);
  ui.controller.undo();
  ui.controller.undo();
  assert.deepEqual(historyStates(ui), ['done', 'done', 'done', 'current', 'undone', 'undone']);
  assert.equal(historyRows(ui).length, 6, 'the undone rows stay listed');
  ui.controller.updateNodeTransform('orb', { translation: [3, 0.5, 0] });
  assert.deepEqual(historyRows(ui).map(row => row.dataset.label), ['Start', 'Move', 'Rotate', 'Scale', 'Move']);
  assert.deepEqual(historyStates(ui), ['done', 'done', 'done', 'done', 'current']);
});

test('the dimmed History rows use the muted token and the current row the strong text token with a filled mark', () => {
  const ruleOf = selector => STUDIO_CSS.slice(STUDIO_CSS.indexOf(selector), STUDIO_CSS.indexOf('}', STUDIO_CSS.indexOf(selector)));
  assert.match(ruleOf('.crucible-studio .crucible-studio-history-row[data-state="undone"],'), /color: var\(--studio-muted\)/);
  assert.match(ruleOf('.crucible-studio .crucible-studio-history-row {'), /color: var\(--studio-text\)/);
  assert.match(ruleOf('.crucible-studio-history-row[data-state="current"] .crucible-studio-history-mark'), /background: var\(--studio-accent\)/);
  assert.doesNotMatch(ruleOf('.crucible-studio .crucible-studio-history-row[data-state="undone"],'), /opacity/);
});

test('History rows are reached with Tab once, moved with Up and Down, and pressed with Enter or Space', testContext => {
  const ui = mountStudio(testContext);
  showHistoryFromViewMenu(ui);
  makeFiveEdits(ui);
  assert.deepEqual(historyRows(ui).map(row => row.tabIndex), [-1, -1, -1, -1, -1, 0]);
  historyRows(ui)[5].focus();
  assert.equal(dispatch(historyRows(ui)[5], 'keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  assert.equal(ui.dom.document.activeElement, historyRows(ui)[4]);
  dispatch(historyRows(ui)[4], 'keydown', { key: 'ArrowDown' });
  assert.equal(ui.dom.document.activeElement, historyRows(ui)[5]);
  dispatch(historyRows(ui)[5], 'keydown', { key: 'Home' });
  assert.equal(ui.dom.document.activeElement, historyRows(ui)[0]);
  assert.equal(historyRows(ui)[0].tagName, 'BUTTON', 'a button, so Enter and Space press it');
  historyRows(ui)[0].click();
  assert.equal(ui.controller.history.position, 0);
});

test('History keeps no more rows than the undo depth', testContext => {
  const ui = mountStudio(testContext);
  showHistoryFromViewMenu(ui);
  for (let step = 0; step < 40; step += 1) {
    ui.controller.updateNodeTransform('hero', { translation: [step, 0.5, 0] });
  }
  assert.equal(historyRows(ui).length, 32, 'the controller keeps its 32 newest edits');
  assert.equal(historyRows(ui).some(row => row.dataset.label === 'Start'), false, 'the opened scene is no longer reachable');
  assert.equal(historyRows(ui)[31].dataset.state, 'current');
});

test('whether the History panel is shown is remembered with the other view preferences', testContext => {
  const first = mountWithStorage(testContext);
  showHistoryFromViewMenu(first.ui);
  assert.equal(JSON.parse(first.saved.get('crucible-studio-preferences')).historyVisible, true);
  const second = mountStudio(testContext, { preferenceStorage: first.preferenceStorage });
  assert.equal(second.root.dataset.historyCollapsed, 'false', 'a new Studio opens with the panel shown');
  showHistoryFromViewMenu(second);
  assert.equal(second.root.dataset.historyCollapsed, 'true');
  assert.equal(JSON.parse(first.saved.get('crucible-studio-preferences')).historyVisible, false);
});

test('Edit > History shows the panel and puts focus on the current row', testContext => {
  const ui = mountStudio(testContext);
  makeFiveEdits(ui);
  ui.controller.undo();
  assert.equal(ui.root.dataset.historyCollapsed, 'true');
  byText(editPopoverOf(ui), 'History').click();
  assert.equal(ui.root.dataset.historyCollapsed, 'false');
  assert.equal(ui.dom.document.activeElement, historyRows(ui).find(row => row.dataset.state === 'current'));
  assert.equal(historyRows(ui).length, 6);
});

test('a compact window starts with the History panel closed, and History and Properties take turns there', testContext => {
  const ui = mountStudio(testContext, { containerWidth: 600, preferences: { historyVisible: true } });
  assert.equal(ui.root.dataset.compact, 'true');
  assert.equal(ui.root.dataset.historyCollapsed, 'true');
  showHistoryFromViewMenu(ui);
  assert.equal(ui.root.dataset.historyCollapsed, 'false');
  assert.equal(ui.root.dataset.inspectorCollapsed, 'true', 'showing History puts Properties away');
  ui.label('Show or hide the panels').click();
  assert.equal(ui.root.dataset.inspectorCollapsed, 'false', 'the panels button brings Properties back');
  assert.equal(ui.root.dataset.historyCollapsed, 'true', 'and puts History away');
  assert.equal(ui.studio.preferences.historyVisible, true, 'the remembered choice is untouched');
});

test('the History card minimizes to its title row like the Scene and Properties cards and remembers it', testContext => {
  const { saved, preferenceStorage, ui } = mountWithStorage(testContext);
  showHistoryFromViewMenu(ui);
  const minimize = historyPanelOf(ui).querySelector('.crucible-studio-dock-head').querySelectorAll('button')[0];
  assert.equal(minimize.getAttribute('aria-label'), 'Minimize History');
  assert.equal(ui.root.dataset.historyMinimized, 'false');
  minimize.click();
  assert.equal(ui.root.dataset.historyMinimized, 'true');
  assert.equal(minimize.getAttribute('aria-label'), 'Expand History');
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).historyMinimized, true);
  assert.ok(STUDIO_CSS.includes('[data-history-minimized="true"] .crucible-studio-history > :not(.crucible-studio-dock-head) { display: none; }'));
  const second = mountStudio(testContext, { preferenceStorage });
  assert.equal(second.root.dataset.historyMinimized, 'true', 'a new Studio opens with it minimized');
  minimize.click();
  assert.equal(ui.root.dataset.historyMinimized, 'false');
});

test('the column rule keeps Properties at 240 px or more and History to a third of the column', () => {
  const flat = STUDIO_CSS.replace(/\s+/g, ' ');
  assert.ok(flat.includes('.crucible-studio-dock.crucible-studio-history { flex: 0 1 auto; min-block-size: 0; max-block-size: 34%;'));
  assert.ok(flat.includes('.crucible-studio-side > .crucible-studio-inspector { min-block-size: 240px; }'));
});

test('the History position is validated and names every kind of edit', testContext => {
  const ui = mountStudio(testContext);
  assert.throws(() => ui.controller.goToHistoryPosition(1), /from 0 to 0/);
  ui.controller.updateNodeTransform('hero', { label: 'Boss' });
  ui.controller.updateNodeTransform('hero', { translation: [0, 1, 0], scale: [2, 2, 2] });
  ui.controller.updateNodeTransform('hero', { visible: false });
  ui.controller.updateNodeTransform('hero', { visible: true });
  ui.controller.beginUndoGroup();
  ui.controller.updateNodeTransform('orb', { translation: [3, 0.5, 0] });
  ui.controller.updateNodeTransform('orb', { rotationDegrees: [0, 10, 0] });
  ui.controller.endUndoGroup();
  assert.deepEqual(ui.controller.history.labels, ['Rename', 'Transform', 'Hide', 'Show', 'Move']);
  assert.deepEqual(ui.controller.history.details, ['hero', 'Boss', 'Boss', 'Boss', 'orb']);
  assert.throws(() => ui.controller.goToHistoryPosition(1.5), /whole number/);
  assert.equal(ui.controller.goToHistoryPosition(0), 0);
  assert.equal(ui.controller.goToHistoryPosition(3), 3);
  assert.equal(ui.controller.history.position, 3);
});
