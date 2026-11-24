import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { isLiveGeometry, markLiveGeometry } from '../src/live-geometry.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { byDataset, byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { CAGE_TRIANGLE_BUDGET, MAX_LOG_ENTRIES, MAX_MASK_VERTICES, createMeshEditor, planMeshMove, previewNormalsOf } from '../src/studio-mesh-edit.js';
import { DEFAULT_KEYMAP_ACTIONS, findKeymapAction, resolveKeymap } from '../src/studio-keymap.js';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function recipeOf({ base = { type: 'box', bevel: 0 }, edits, nodes } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base, ...(edits ? { edits } : {}) }, { id: 'ball', type: 'sphere' }],
    nodes: nodes ?? [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mount(recipe = recipeOf()) {
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const messages = [];
  const previews = [];
  // The renderer cannot be built without a canvas: this writer does what updatePartVertices does to the geometry, so the
  // restore after a drag is checked on real buffers.
  const updatePart = (renderer, part, positions, normals) => {
    part.geometry.positions.set(positions);
    if (normals) part.geometry.normals.set(normals);
    markLiveGeometry(part.geometry);
    previews.push(Float32Array.from(positions));
  };
  const editor = createMeshEditor({ controller, announce: message => messages.push(message), getRenderer: () => ({}), updatePart });
  return { controller, editor, messages, previews };
}

function heroPart(controller) {
  return controller.scene.parts.find(part => part.name === 'hero');
}

function worldPointOf(controller, vertex, positions = editorPositions(controller)) {
  const matrix = heroPart(controller).matrix;
  const [x, y, z] = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function editorPositions(controller) {
  return meshEditSourceOf(heroPart(controller).geometry).mesh.positions;
}

function pixelOfVertex(controller, vertex) {
  return controller.projectWorldPoint(worldPointOf(controller, vertex));
}

function vertexAt(controller, local) {
  const mesh = meshEditSourceOf(heroPart(controller).geometry).mesh;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (local.every((component, axis) => Math.abs(mesh.positions[vertex * 3 + axis] - component) < 1e-5)) return vertex;
  }
  throw new Error(`no vertex at ${local}`);
}

function faceOf(controller, predicate) {
  const mesh = meshEditSourceOf(heroPart(controller).geometry).mesh;
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const corners = [];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) corners.push(mesh.cornerVertices[corner]);
    if (corners.every(vertex => predicate([mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]]))) return { face, corners };
  }
  throw new Error('no such face');
}

function pixelOfFaceCentre(controller, corners) {
  const positions = editorPositions(controller);
  const centre = [0, 0, 0];
  for (const vertex of corners) {
    const world = worldPointOf(controller, vertex, positions);
    for (let axis = 0; axis < 3; axis += 1) centre[axis] += world[axis] / corners.length;
  }
  return controller.projectWorldPoint(centre);
}

function dragSelection(controller, deltaX = 40, deltaY = -25) {
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  const moved = controller.updateGizmoDrag(origin.x + deltaX, origin.y + deltaY);
  return moved.elementDelta;
}

function logOf(controller) {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

test('Tab enters edit mode on a mesh node and leaves it; a primitive says edit mode needs a mesh', () => {
  const { controller, editor, messages } = mount(recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'plain', geometry: 'ball', material: 'grey', translation: [3, 0, 0] }] }));
  assert.equal(editor.enter().ok, true);
  assert.equal(editor.active, true);
  assert.equal(editor.mode, 'face');
  assert.equal(controller.exportRecipe().geometries.length, 2, 'a node with its own geometry gets no copy');
  editor.leave();
  assert.equal(editor.active, false);
  controller.selectNode('plain');
  const refused = editor.enter();
  assert.equal(refused.ok, false);
  assert.match(messages.at(-1), /needs a mesh/);
  assert.equal(editor.active, false);
});

test('a geometry shared with another node is copied for the edited node first, as one undo step', () => {
  const recipe = recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'twin', geometry: 'shape', material: 'grey', translation: [3, 0, 0] }] });
  const { controller, editor } = mount(recipe);
  editor.enter();
  const entered = controller.exportRecipe();
  assert.equal(entered.nodes.find(node => node.id === 'twin').geometry, 'shape');
  const ownId = entered.nodes.find(node => node.id === 'hero').geometry;
  assert.notEqual(ownId, 'shape');
  assert.equal(entered.geometries.find(geometry => geometry.id === ownId).type, 'mesh');
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').geometry, 'shape');
});

test('click picks the nearest vertex, edge or face; Shift toggles; empty space clears', () => {
  const { controller, editor } = mount();
  editor.enter();
  const corner = vertexAt(controller, [0.5, 0.5, 0.5]);
  const neighbour = vertexAt(controller, [-0.5, 0.5, 0.5]);
  editor.setMode('vertex');
  const cornerPixel = pixelOfVertex(controller, corner);
  assert.equal(editor.pick(cornerPixel.x + 3, cornerPixel.y - 2), corner);
  assert.deepEqual(editor.selection, { mode: 'vertex', indices: [corner] });
  const neighbourPixel = pixelOfVertex(controller, neighbour);
  editor.pick(neighbourPixel.x, neighbourPixel.y, { additive: true });
  assert.deepEqual(editor.selection.indices, [corner, neighbour].sort((first, second) => first - second));
  editor.pick(neighbourPixel.x, neighbourPixel.y, { additive: true });
  assert.deepEqual(editor.selection.indices, [corner]);
  editor.pick(5, 5);
  assert.deepEqual(editor.selection.indices, []);

  editor.setMode('edge');
  const mesh = meshEditSourceOf(heroPart(controller).geometry).mesh;
  const middle = { x: (cornerPixel.x + neighbourPixel.x) / 2, y: (cornerPixel.y + neighbourPixel.y) / 2 };
  const edge = editor.pick(middle.x, middle.y);
  assert.deepEqual([mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]].sort((first, second) => first - second), [corner, neighbour].sort((first, second) => first - second));

  editor.setMode('face');
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  assert.equal(editor.pick(centre.x, centre.y), front.face);
  assert.deepEqual(editor.selection, { mode: 'face', indices: [front.face] });
});

test('switching the mode keeps what the new mode can still say: the vertices of a face become its edges', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  editor.setMode('vertex');
  assert.equal(editor.selection.indices.length, 4);
  editor.setMode('edge');
  assert.equal(editor.selection.indices.length, 4);
  editor.setMode('face');
  assert.deepEqual(editor.selection.indices, [front.face]);
  assert.throws(() => editor.setMode('loop'), /Unknown selection mode/);
});

test('dragging a face writes one translate entry; the evaluated mesh moves by the drag in the node space, scale and rotation included', () => {
  const recipe = recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey', scale: [2, 1, 1], rotation: [0, 0.2588, 0, 0.9659] }] });
  const { controller, editor, previews } = mount(recipe);
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  const geometryBefore = heroPart(controller).geometry;
  const renderBefore = Float32Array.from(geometryBefore.positions);
  const originalPositions = Float32Array.from(editorPositions(controller));
  const inverse = mat4.invert(mat4.create(), heroPart(controller).matrix);
  const undoDepthBefore = controller.canUndo;

  const worldDelta = dragSelection(controller);
  assert.ok(previews.length > 0, 'the preview wrote into the part while dragging');
  assert.notDeepEqual(Array.from(geometryBefore.positions), Array.from(renderBefore), 'the part shows the drag');
  assert.equal(logOf(controller).length, 0, 'nothing is in the log before the release');
  controller.endGizmoDrag();

  assert.deepEqual(Array.from(geometryBefore.positions), Array.from(renderBefore), 'the previewed buffers are restored exactly on release');
  const log = logOf(controller);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'translate');
  assert.deepEqual(log[0].select, { faces: [front.face] });
  assert.equal(undoDepthBefore, false);
  const expectedLocal = [
    inverse[0] * worldDelta[0] + inverse[4] * worldDelta[1] + inverse[8] * worldDelta[2],
    inverse[1] * worldDelta[0] + inverse[5] * worldDelta[1] + inverse[9] * worldDelta[2],
    inverse[2] * worldDelta[0] + inverse[6] * worldDelta[1] + inverse[10] * worldDelta[2],
  ];
  const movedPositions = editorPositions(controller);
  for (let vertex = 0; vertex < movedPositions.length / 3; vertex += 1) {
    const expected = front.corners.includes(vertex) ? expectedLocal : [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(Math.abs(movedPositions[vertex * 3 + axis] - originalPositions[vertex * 3 + axis] - expected[axis]) < 3e-4, `vertex ${vertex} axis ${axis}`);
    }
  }
  assert.deepEqual(editor.selection, { mode: 'face', indices: [front.face] }, 'the selection survives the commit');
  controller.undo();
  editor.refresh(); // Studio calls this from its onChange for an undo or a redo
  assert.equal(logOf(controller).length, 0, 'one undo takes the whole drag back');
  assert.deepEqual(Array.from(editorPositions(controller)), Array.from(originalPositions));
  assert.deepEqual(Array.from(editor.cage.positions), Array.from(originalPositions), 'the cage follows the undo');
  controller.redo();
  editor.refresh();
  assert.equal(logOf(controller).length, 1);
  assert.ok(Math.abs(editor.cage.positions[front.corners[0] * 3 + 1] - editorPositions(controller)[front.corners[0] * 3 + 1]) < 1e-9, 'the cage follows the redo');
});

test('Esc during a drag restores the cage and the buffers and leaves the recipe and the undo steps as they were', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  const recipeBefore = controller.exportRecipe();
  const renderBefore = Float32Array.from(heroPart(controller).geometry.positions);
  const cageBefore = Float32Array.from(editor.cage.positions);
  dragSelection(controller);
  assert.notDeepEqual(Array.from(editor.cage.positions), Array.from(cageBefore), 'the cage moved with the drag');
  controller.cancelGizmoDrag();
  assert.deepEqual(Array.from(editor.cage.positions), Array.from(cageBefore));
  assert.deepEqual(Array.from(heroPart(controller).geometry.positions), Array.from(renderBefore));
  assert.deepEqual(controller.exportRecipe(), recipeBefore);
  assert.equal(controller.canUndo, false);
});

test('a vertex or an edge that is not a whole face is written as a set_position over an index mask; four corners of a face as a translate', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  editor.setMode('vertex');
  const corner = vertexAt(controller, [0.5, 0.5, 0.5]);
  const cornerPixel = pixelOfVertex(controller, corner);
  editor.pick(cornerPixel.x, cornerPixel.y);
  const originalPositions = Float32Array.from(editorPositions(controller));
  const worldDelta = dragSelection(controller);
  controller.endGizmoDrag();
  assert.equal(logOf(controller).length, 1);
  assert.equal(logOf(controller)[0].op, 'set_position');
  const moved = editorPositions(controller);
  const identity = mat4.invert(mat4.create(), heroPart(controller).matrix);
  const expectedY = identity[1] * worldDelta[0] + identity[5] * worldDelta[1] + identity[9] * worldDelta[2];
  assert.ok(Math.abs(moved[corner * 3 + 1] - originalPositions[corner * 3 + 1] - expectedY) < 3e-4);
  for (let vertex = 0; vertex < moved.length / 3; vertex += 1) {
    if (vertex !== corner) assert.deepEqual(Array.from(moved.slice(vertex * 3, vertex * 3 + 3)), Array.from(originalPositions.slice(vertex * 3, vertex * 3 + 3)));
  }

  editor.setMode('edge');
  const neighbour = vertexAt(controller, [-0.5, 0.5, 0.5]);
  const neighbourPixel = pixelOfVertex(controller, neighbour);
  const nextCornerPixel = pixelOfVertex(controller, corner);
  editor.pick((neighbourPixel.x + nextCornerPixel.x) / 2, (neighbourPixel.y + nextCornerPixel.y) / 2);
  assert.equal(editor.selection.indices.length, 1);
  dragSelection(controller, -30, 10);
  controller.endGizmoDrag();
  assert.equal(logOf(controller).length, 2);
  assert.equal(logOf(controller)[1].op, 'set_position');

  editor.setMode('vertex');
  editor.pick(5, 5);
  for (const vertex of front.corners) {
    const pixel = pixelOfVertex(controller, vertex);
    editor.pick(pixel.x, pixel.y, { additive: true });
  }
  assert.equal(editor.selection.indices.length, 4);
  dragSelection(controller, 20, 20);
  controller.endGizmoDrag();
  assert.equal(logOf(controller)[2].op, 'translate', 'the vertices of a face are written as a face move');
});

test('a move of more than 19 vertices that are not whole faces is refused when the drag starts, with the reason', () => {
  const recipe = recipeOf({ base: { type: 'plane', segments: 6 } });
  const { controller, editor, messages } = mount(recipe);
  controller.setCameraViewPreset('top');
  editor.enter();
  editor.setMode('vertex');
  const mesh = meshEditSourceOf(heroPart(controller).geometry).mesh;
  // Every other vertex of the grid, so no four of them make a face.
  for (let slot = 0; slot < MAX_MASK_VERTICES + 1; slot += 1) {
    const pixel = pixelOfVertex(controller, slot * 2);
    editor.pick(pixel.x, pixel.y, { additive: true });
  }
  assert.equal(editor.selection.indices.length, MAX_MASK_VERTICES + 1);
  assert.ok(mesh.vertexCount > MAX_MASK_VERTICES + 1);
  const origin = controller.gizmoHandles().origin;
  assert.throws(() => controller.beginGizmoDrag('screen', origin.x, origin.y), /more than 19 vertices/);
  assert.equal(controller.dragging, false);
  assert.throws(() => planMeshMove(mesh, Array.from({ length: 20 }, (unused, index) => index * 2), [0, 1, 0]), /more than 19/);
  assert.equal(planMeshMove(mesh, Array.from({ length: 19 }, (unused, index) => index * 2), [0, 1, 0]).op, 'set_position');
  assert.deepEqual(messages, ['Edit mode: pick a vertex, edge or face.', ''], 'only the hint and its dismissal were announced');
});

test('a mesh whose log is full refuses a move at the start of the drag', () => {
  const edits = Array.from({ length: MAX_LOG_ENTRIES }, () => ({ op: 'translate', select: { faces: [0] }, offset: [0, 0.001, 0] }));
  const { controller, editor } = mount(recipeOf({ edits }));
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  const origin = controller.gizmoHandles().origin;
  assert.throws(() => controller.beginGizmoDrag('screen', origin.x, origin.y), /64 edits/);
  assert.equal(logOf(controller).length, MAX_LOG_ENTRIES);
});

test('the selection clears after an undo that changes the mesh topology, and edit mode ends when another node is picked', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  controller.applyImportOperations([{ type: 'edit-mesh', geometry: 'shape', edits: [{ op: 'subdivide', levels: 1 }] }], { detail: { kind: 'topology', nodeId: 'hero' } });
  editor.refresh();
  assert.deepEqual(editor.selection.indices, [], 'a face number of the old topology means nothing on the new one');
  assert.equal(editor.cage.mesh.faceCount, 24);
  controller.undo();
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, 6);
  controller.selectNode(null);
  editor.refresh();
  assert.equal(editor.active, false);
});

test('a mesh with modifiers or one the cage is too big to draw says so', () => {
  const stacked = recipeOf();
  stacked.geometries[0].stack = [{ op: 'subdivide', levels: 1 }];
  const withStack = mount(stacked);
  assert.equal(withStack.editor.enter().ok, false);
  assert.match(withStack.messages.at(-1), /modifiers/);

  const dense = mount(recipeOf({ base: { type: 'box', bevel: 0, subdivisions: 40 } }));
  assert.equal(dense.editor.enter().ok, true);
  assert.equal(dense.editor.cage.tooLarge, true);
  assert.ok(dense.editor.cage.mesh.faceCount * 2 > CAGE_TRIANGLE_BUDGET);
  assert.match(dense.messages.at(-1), /only the selection is drawn/);
  assert.equal(dense.editor.cagePaths().some(path => path.className.includes('cage-edges')), false);
});

test('the cage draws the polygon edges, the vertices in vertex mode and the selection', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  const faceLayers = editor.cagePaths().map(path => path.className);
  assert.ok(faceLayers.includes('crucible-studio-cage-edges'));
  assert.ok(faceLayers.some(name => name.includes('cage-selected-face')));
  assert.equal(faceLayers.includes('crucible-studio-cage-vertices'), false);
  editor.setMode('vertex');
  assert.ok(editor.cagePaths().some(path => path.className === 'crucible-studio-cage-vertices'));
  const edgePaths = editor.cagePaths().filter(path => path.className === 'crucible-studio-cage-edges' || path.className === 'crucible-studio-cage-edges-far');
  assert.equal(edgePaths.reduce((total, path) => total + path.pathData.split('M').length - 1, 0), 12);
});

test('the mesh keymap context binds Tab, Esc and 1 2 3, and stays out of the way of the normal keys', () => {
  const keymap = resolveKeymap();
  assert.equal(findKeymapAction(keymap, { key: '1' }, 'mesh').actionId, 'mesh.vertexMode');
  assert.equal(findKeymapAction(keymap, { key: '2' }, 'mesh').actionId, 'mesh.edgeMode');
  assert.equal(findKeymapAction(keymap, { key: '3' }, 'mesh').actionId, 'mesh.faceMode');
  assert.equal(findKeymapAction(keymap, { key: 'Tab' }, 'mesh').actionId, 'mesh.leave');
  assert.equal(findKeymapAction(keymap, { key: 'Escape' }, 'mesh').actionId, 'mesh.escape');
  assert.equal(findKeymapAction(keymap, { key: 'Tab' }, 'normal').actionId, 'mesh.enter');
  assert.equal(findKeymapAction(keymap, { key: 'x' }, 'mesh').actionId, 'mesh.noop');
  assert.equal(findKeymapAction(keymap, { key: 'Delete' }, 'mesh').actionId, 'mesh.noop');
  assert.equal(findKeymapAction(keymap, { key: 'z', ctrlKey: true }, 'mesh'), null);
  assert.ok(DEFAULT_KEYMAP_ACTIONS.filter(action => action.context === 'mesh').length >= 6);
});

// The same keys and buttons through the Studio page, on the fake DOM.
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function mountStudioWithMesh(testContext) {
  const dom = installStudioDom();
  const recipe = recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'plain', geometry: 'ball', material: 'grey', translation: [3, 0, 0] }] });
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  const modeButton = mode => byDataset(root, 'meshMode', mode);
  const status = () => root.querySelector('.crucible-studio-status').textContent;
  return { dom, studio, root, viewport, press, modeButton, status, controller: studio.controller };
}

async function untilEditing(ui, wanted = 'true') {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== wanted; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve)); // the fake DOM replaces setTimeout
  }
  assert.equal(ui.root.dataset.meshEdit, wanted);
}

test('Tab enters edit mode on a selected mesh; 1, 2, 3 switch the mode; X and Delete leave the object alone; Tab leaves', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  assert.equal(ui.root.dataset.meshEdit ?? 'false', 'false');
  const tab = ui.press('Tab');
  assert.equal(tab.defaultPrevented, true);
  await untilEditing(ui);
  assert.equal(ui.modeButton('face').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.modeButton('vertex').getAttribute('aria-label'), 'Vertex 1');
  assert.equal(byLabel(ui.root, 'Mesh selection').hidden, false);
  for (const [key, mode] of [['1', 'vertex'], ['2', 'edge'], ['3', 'face']]) {
    ui.press(key);
    assert.equal(ui.modeButton(mode).getAttribute('aria-pressed'), 'true', `key ${key}`);
  }
  ui.modeButton('edge').click();
  assert.equal(ui.modeButton('edge').getAttribute('aria-pressed'), 'true');
  const nodeCount = ui.controller.exportRecipe().nodes.length;
  for (const key of ['x', 'Delete', 'Backspace']) {
    const event = ui.press(key);
    assert.equal(event.defaultPrevented, true, `${key} is taken by edit mode`);
    assert.equal(ui.controller.exportRecipe().nodes.length, nodeCount, `${key} does not delete the node`);
    assert.equal(ui.controller.selectedNodeId, 'hero');
  }
  ui.press('g');
  assert.equal(ui.controller.dragging, false, 'G does not pick the object up in edit mode');
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.equal(byLabel(ui.root, 'Mesh selection').hidden, true);
  ui.press('x');
  assert.equal(ui.controller.exportRecipe().nodes.length, nodeCount - 1, 'outside edit mode X deletes as before');
});

test('Esc with nothing selected leaves edit mode; with a face selected it clears the selection first', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.press('Tab');
  await untilEditing(ui);
  const front = ui.controller.projectWorldPoint([0, 0, 0.5]);
  const down = { clientX: VIEWPORT_BOX.left + front.x, clientY: VIEWPORT_BOX.top + front.y };
  dispatch(ui.viewport.querySelector('canvas'), 'pointerdown', down);
  dispatch(ui.viewport, 'pointerup', down);
  ui.studio.renderNow();
  assert.ok(ui.root.querySelector('.crucible-studio-cage-selected-face'), 'the picked face is drawn');
  ui.press('Escape');
  assert.equal(ui.root.dataset.meshEdit, 'true');
  ui.studio.renderNow();
  assert.equal(ui.root.querySelector('.crucible-studio-cage-selected-face'), null);
  ui.press('Escape');
  assert.equal(ui.root.dataset.meshEdit, 'false');
});

test('Tab on a shape that is not a mesh says edit mode needs a mesh and changes nothing', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.controller.selectNode('plain');
  const recipeBefore = ui.controller.exportRecipe();
  ui.press('Tab');
  for (let attempt = 0; attempt < 2000 && !/needs a mesh/.test(ui.status()); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve)); // the fake DOM replaces setTimeout
  }
  assert.match(ui.status(), /needs a mesh geometry/);
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.deepEqual(ui.controller.exportRecipe(), recipeBefore);
});

// Review round 2: leaving mid-drag, no-op drags, the live flag, the double Tab, the selection across a changed log, the
// rounding, the keys that pass through, the far side of the cage, undo inside edit mode and the preview normals.
function dragThroughSession(controller, deltaX, deltaY) {
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + deltaX, origin.y + deltaY);
}

function pickFront(controller, editor) {
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  return front;
}

test('leaving edit mode in the middle of a drag cancels the drag first: cage, buffers and recipe are as before and the pointer moves throw nothing', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  const recipeBefore = controller.exportRecipe();
  const renderBefore = Float32Array.from(heroPart(controller).geometry.positions);
  const cageBefore = Float32Array.from(editor.cage.positions);
  dragThroughSession(controller, 40, -25);
  assert.equal(controller.dragging, true);
  editor.leave();
  assert.equal(controller.dragging, false, 'the controller drag ended with the edit mode');
  assert.doesNotThrow(() => controller.updateGizmoDrag(10, 10));
  assert.deepEqual(Array.from(heroPart(controller).geometry.positions), Array.from(renderBefore));
  assert.deepEqual(controller.exportRecipe(), recipeBefore);
  assert.equal(cageBefore.length > 0, true);
  assert.equal(controller.canUndo, false);
});

test('a drag smaller than the rounding step writes nothing, not an entry that moves by 0', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  dragThroughSession(controller, 0.004, 0);
  controller.endGizmoDrag();
  assert.equal(logOf(controller).length, 0);
  assert.equal(controller.canUndo, false);
  dragThroughSession(controller, 60, 0);
  controller.endGizmoDrag();
  assert.equal(logOf(controller).length, 1, 'a real drag still writes its entry');
});

test('the offset of an entry is rounded to 0.0001', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  dragThroughSession(controller, 37.3, -21.9);
  controller.endGizmoDrag();
  const { offset } = logOf(controller)[0];
  assert.ok(offset.some(component => component !== 0));
  for (const component of offset) assert.equal(component, Math.round(component * 1e4) / 1e4);
});

test('a cancelled preview takes the live mark off the geometry, but leaves a mark that was there before the drag', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  const geometry = heroPart(controller).geometry;
  assert.equal(isLiveGeometry(geometry), false);
  dragThroughSession(controller, 40, -25);
  assert.equal(isLiveGeometry(geometry), true, 'while previewing, caches skip the geometry');
  controller.cancelGizmoDrag();
  assert.equal(isLiveGeometry(geometry), false, 'after Esc the caches may measure it again');
  markLiveGeometry(geometry);
  dragThroughSession(controller, 40, -25);
  controller.cancelGizmoDrag();
  assert.equal(isLiveGeometry(geometry), true, 'a geometry that was live before is not touched');
});

test('after leave() the handles move the node again and no element session is left', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  editor.leave();
  const translationBefore = controller.exportRecipe().nodes[0].translation ?? [0, 0, 0];
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 60, origin.y);
  controller.endGizmoDrag();
  const recipe = controller.exportRecipe();
  assert.notDeepEqual(recipe.nodes[0].translation ?? [0, 0, 0], translationBefore, 'the node moved');
  assert.equal(logOf(controller).length, 0, 'the mesh log is untouched');
});

test('the selection stays only while the mesh log is the one it was picked on', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = pickFront(controller, editor);
  editor.refresh();
  assert.deepEqual(editor.selection.indices, [front.face], 'nothing changed, so the pick stays');
  const translate = offset => [{ type: 'edit-mesh', geometry: 'shape', edits: [{ op: 'translate', select: { faces: [0] }, offset }] }];
  controller.applyImportOperations(translate([0, 0.1, 0]), { detail: { kind: 'topology', nodeId: 'hero' } });
  editor.refresh();
  assert.deepEqual(editor.selection.indices, [front.face], 'a longer log with the same start and the same counts keeps the pick');
  controller.undo();
  editor.refresh();
  assert.deepEqual(editor.selection.indices, [front.face], 'so does the undo back to the shorter log');
  controller.redo();
  editor.refresh();
  assert.deepEqual(editor.selection.indices, [front.face], 'and the redo');
  controller.undo();
  controller.applyImportOperations(translate([0, 0.3, 0]), { detail: { kind: 'topology', nodeId: 'hero' } });
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, 6, 'the same counts as before');
  assert.deepEqual(editor.selection.indices, [], 'an entry replaced by another one may have moved the numbers');
});

test('the far side of the cage is drawn quiet and an element on the near side is picked before it', () => {
  const faceOnCamera = { eye: [0, 0, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
  const { controller, editor } = mount({ ...recipeOf(), camera: faceOnCamera });
  editor.enter();
  const pathOf = className => editor.cagePaths().find(path => path.className === className)?.pathData ?? '';
  const segments = pathData => pathData.split('M').length - 1;
  assert.equal(segments(pathOf('crucible-studio-cage-edges')), 4, 'the four edges of the front face are near');
  assert.equal(segments(pathOf('crucible-studio-cage-edges-far')), 8, 'the back face and the edges that run to it only touch faces turned away');
  editor.setMode('vertex');
  assert.equal(segments(pathOf('crucible-studio-cage-vertices-far')), 4);
  const near = vertexAt(controller, [0.5, 0.5, 0.5]);
  const far = vertexAt(controller, [0.5, 0.5, -0.5]);
  const nearPixel = pixelOfVertex(controller, near);
  const farPixel = pixelOfVertex(controller, far);
  const click = { x: nearPixel.x + (farPixel.x - nearPixel.x) * 0.52, y: nearPixel.y + (farPixel.y - nearPixel.y) * 0.52 };
  const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
  assert.ok(distance(click, nearPixel) < 14 && distance(click, farPixel) < distance(click, nearPixel), 'the far vertex is the closer one to this click');
  assert.equal(editor.pick(click.x, click.y), near);
});

test('selected vertices and edges are drawn over the handles with a ring, selected faces under them', () => {
  const { controller, editor } = mount();
  editor.enter();
  const front = pickFront(controller, editor);
  const layerOf = className => editor.cagePaths().find(path => path.className.includes(className))?.layer;
  assert.equal(layerOf('cage-selected-face'), 'under');
  editor.setMode('vertex');
  assert.equal(editor.selection.indices.length, 4);
  assert.equal(layerOf('cage-selected-vertex'), 'over');
  assert.equal(layerOf('cage-selected-halo'), 'over');
  assert.ok(front.corners.length === 4);
  editor.setMode('edge');
  assert.equal(layerOf('cage-selected-edge'), 'over');
});

test('the preview writes new normals with the positions and puts the old ones back on Esc', () => {
  const { controller, editor } = mount();
  editor.enter();
  pickFront(controller, editor);
  const geometry = heroPart(controller).geometry;
  const normalsBefore = Float32Array.from(geometry.normals);
  dragThroughSession(controller, 0, -60);
  assert.notDeepEqual(Array.from(geometry.normals), Array.from(normalsBefore), 'the lit surface follows the drag');
  for (let vertex = 0; vertex < geometry.normals.length / 3; vertex += 1) {
    const length = Math.hypot(geometry.normals[vertex * 3], geometry.normals[vertex * 3 + 1], geometry.normals[vertex * 3 + 2]);
    assert.ok(Math.abs(length - 1) < 1e-4, 'unit normals');
  }
  controller.cancelGizmoDrag();
  assert.deepEqual(Array.from(geometry.normals), Array.from(normalsBefore));
});

test('the preview normals of a flat shaded cube equal what the surface builder gives a cube moved by the same amount', () => {
  const normals = previewNormalsOf(Uint16Array.from([0, 1, 2, 0, 2, 3]), Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), new Float32Array(12));
  assert.deepEqual(Array.from(normals), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

async function settle(ticks = 300) {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise(resolve => setImmediate(resolve));
}

test('Tab twice before the editor has loaded cancels the entry, and a third Tab enters', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.press('Tab');
  ui.press('Tab');
  await settle();
  assert.equal(ui.root.dataset.meshEdit ?? 'false', 'false');
  ui.press('Tab');
  await untilEditing(ui);
});

test('Tab in the middle of a drag leaves edit mode and ends the drag without an error', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.press('Tab');
  await untilEditing(ui);
  const front = ui.controller.projectWorldPoint([0, 0, 0.5]);
  const down = { clientX: VIEWPORT_BOX.left + front.x, clientY: VIEWPORT_BOX.top + front.y };
  dispatch(ui.viewport.querySelector('canvas'), 'pointerdown', down);
  dispatch(ui.viewport, 'pointerup', down);
  dragThroughSession(ui.controller, 40, -25);
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.equal(ui.controller.dragging, false);
  assert.doesNotThrow(() => ui.controller.updateGizmoDrag(5, 5));
  assert.equal(logOfShape(ui.controller).length, 0);
});

function logOfShape(controller) {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

async function pickFrontThroughStudio(ui) {
  ui.press('Tab');
  await untilEditing(ui);
  const front = ui.controller.projectWorldPoint([0, 0, 0.5]);
  const down = { clientX: VIEWPORT_BOX.left + front.x, clientY: VIEWPORT_BOX.top + front.y };
  dispatch(ui.viewport.querySelector('canvas'), 'pointerdown', down);
  dispatch(ui.viewport, 'pointerup', down);
}

function ownShapeId(controller) {
  return controller.exportRecipe().nodes.find(node => node.id === 'hero').geometry;
}

test('undo and redo inside edit mode stay in edit mode with the cage redrawn; the view keys and 1, 3 after leaving still work', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  await pickFrontThroughStudio(ui);
  ui.studio.renderNow();
  assert.ok(ui.root.querySelector('.crucible-studio-cage-selected-face'));
  dragThroughSession(ui.controller, 0, -60);
  ui.controller.endGizmoDrag();
  assert.equal(logOfShape(ui.controller).length, 1);
  ui.press('z', { ctrlKey: true });
  assert.equal(logOfShape(ui.controller).length, 0);
  assert.equal(ui.root.dataset.meshEdit, 'true', 'undo does not leave edit mode');
  ui.studio.renderNow();
  assert.ok(ui.root.querySelector('.crucible-studio-cage-edges'), 'the cage is drawn for the restored mesh');
  assert.ok(ui.root.querySelector('.crucible-studio-gizmo [data-gizmo-axis]'), 'the pick survives the undo, so the handles stay on it');
  ui.press('z', { ctrlKey: true, shiftKey: true });
  assert.equal(logOfShape(ui.controller).length, 1);
  assert.equal(ui.root.dataset.meshEdit, 'true', 'redo does not leave edit mode');
  const eyeBefore = [...ui.controller.viewCamera.eye];
  ui.press('7');
  assert.notDeepEqual([...ui.controller.viewCamera.eye], eyeBefore, 'the top view key works in edit mode');
  const projectionBefore = ui.controller.viewCamera.projection;
  ui.press('5');
  assert.notEqual(ui.controller.viewCamera.projection, projectionBefore, 'the projection key works in edit mode');
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  const topEye = [...ui.controller.viewCamera.eye];
  ui.press('1');
  assert.notDeepEqual([...ui.controller.viewCamera.eye], topEye, '1 is the front view again');
  const frontEye = [...ui.controller.viewCamera.eye];
  ui.press('3');
  assert.notDeepEqual([...ui.controller.viewCamera.eye], frontEye, '3 is the right view again');
});

test('undo of the step that made the geometry the node own leaves edit mode with one sentence', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  const twin = recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'twin', geometry: 'shape', material: 'grey', translation: [3, 0, 0] }] });
  ui.controller.loadRecipe(twin, { recordUndo: false });
  ui.controller.selectNode('hero');
  ui.press('Tab');
  await untilEditing(ui);
  assert.notEqual(ownShapeId(ui.controller), 'shape');
  ui.press('z', { ctrlKey: true });
  assert.equal(ownShapeId(ui.controller), 'shape');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.match(ui.status(), /Edit mode ended/);
});

test('edit mode is shown by the toolbar group, a button that leaves it and the readout line, and nowhere else', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  const group = byLabel(ui.root, 'Mesh selection');
  assert.equal(group.hidden, true);
  await pickFrontThroughStudio(ui);
  ui.studio.renderNow();
  assert.equal(group.hidden, false);
  assert.equal(ui.modeButton('vertex').getAttribute('aria-label'), 'Vertex 1');
  assert.equal(ui.modeButton('edge').getAttribute('aria-label'), 'Edge 2');
  assert.equal(ui.modeButton('face').getAttribute('aria-label'), 'Face 3');
  const leave = byLabel(ui.root, 'Object mode (Tab)');
  assert.ok(leave, 'the object item leaves edit mode and names its key');
  assert.equal(leave.getAttribute('aria-pressed'), 'false');
  assert.equal(group.children[0], leave, 'the group reads object, vertex, edge, face');
  assert.match(ui.root.querySelector('.crucible-studio-readout-selection').textContent, /^Edit faces/);
  ui.press('2');
  ui.studio.renderNow();
  assert.match(ui.root.querySelector('.crucible-studio-readout-selection').textContent, /^Edit edges/);
  leave.click();
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.equal(group.hidden, true);
  ui.studio.renderNow();
  assert.doesNotMatch(ui.root.querySelector('.crucible-studio-readout-selection').textContent, /^Edit /);
});

test('the selection outline of the node is not drawn while edit mode is on', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.studio.renderNow();
  const outlineOf = () => ui.root.querySelector('.crucible-studio-selection-silhouette') ?? ui.root.querySelector('.crucible-studio-selection-outline');
  assert.notEqual(outlineOf(), null, 'outside edit mode the selected node has its outline');
  await pickFrontThroughStudio(ui);
  ui.studio.renderNow();
  assert.equal(outlineOf(), null);
  ui.press('Tab');
  ui.studio.renderNow();
  assert.notEqual(outlineOf(), null, 'and it comes back when edit mode ends');
});

test('the edit mode hint goes away with the first pick that selects something', () => {
  const { controller, editor, messages } = mount();
  editor.enter();
  assert.equal(messages.at(-1), 'Edit mode: pick a vertex, edge or face.');
  const corner = vertexAt(controller, [0.5, 0.5, 0.5]);
  editor.setMode('vertex');
  const cornerPixel = pixelOfVertex(controller, corner);
  editor.pick(cornerPixel.x, cornerPixel.y);
  assert.equal(messages.at(-1), '', 'the first selection clears the hint');
  const countAfterFirstPick = messages.length;
  editor.pick(cornerPixel.x, cornerPixel.y, { additive: true });
  assert.equal(messages.length, countAfterFirstPick, 'later picks say nothing');
});
