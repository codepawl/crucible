import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { isLiveGeometry, markLiveGeometry } from '../src/live-geometry.js';
import { clearedArrow, clearedPlaneCorners, clearedRingRadius, createStudio, planeSquareIsTooThin, createStudioController } from '../src/studio.js';
import { byDataset, byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { CAGE_TRIANGLE_BUDGET, MAX_LOG_ENTRIES, MAX_MASK_VERTICES, createMeshEditor, planMeshMove, previewNormalsOf } from '../src/studio-mesh-edit.js';
import { DEFAULT_KEYMAP_ACTIONS, findKeymapAction, resolveKeymap } from '../src/studio-keymap.js';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function recipeOf({ base = { type: 'box', bevel: 0 }, edits, nodes } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base, ...(edits ? { edits } : {}) }, { id: 'words', type: 'text', text: 'Hi', size: 0.6, depth: 0.12 }],
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

test('Tab enters edit mode on a mesh node and leaves it; text says what to do instead', () => {
  const { controller, editor, messages } = mount(recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'plain', geometry: 'words', material: 'grey', translation: [3, 0, 0] }] }));
  assert.equal(editor.enter().ok, true);
  assert.equal(editor.active, true);
  assert.equal(editor.mode, 'face');
  assert.equal(controller.exportRecipe().geometries.length, 2, 'a node with its own geometry gets no copy');
  editor.leave();
  assert.equal(editor.active, false);
  controller.selectNode('plain');
  const refused = editor.enter();
  assert.equal(refused.ok, false);
  assert.match(messages.at(-1), /Text cannot be edited/);
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

test('a typed amount moves the selected face by exactly that far along the locked axis, in one log entry', () => {
  const { controller, editor } = mount(recipeOf());
  editor.enter();
  const front = faceOf(controller, point => point[2] > 0.49);
  const centre = pixelOfFaceCentre(controller, front.corners);
  editor.pick(centre.x, centre.y);
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('x', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 30, origin.y);
  assert.equal(controller.setGizmoTypedAmount(0.25), true);
  controller.updateGizmoDrag(origin.x + 90, origin.y + 10);
  controller.endGizmoDrag();
  const log = logOf(controller);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].offset.map(value => Number(value.toFixed(4))), [0.25, 0, 0]);
  assert.throws(() => controller.setGizmoTypedAmount(Number.NaN), /finite number/);
  assert.equal(controller.setGizmoTypedAmount(1), false, 'nothing is held after the release');

  // A typed move stops at the coordinate limit instead of following twelve typed digits to 1e11 metres.
  controller.beginGizmoDrag('x', origin.x, origin.y);
  controller.setGizmoTypedAmount(99999999999);
  const [limitedOffset] = controller.endGizmoDrag() ? logOf(controller).at(-1).offset : [null];
  assert.equal(limitedOffset, 1e6);
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
  const recipe = recipeOf({ nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }, { id: 'plain', geometry: 'words', material: 'grey', translation: [3, 0, 0] }] });
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

test('Tab on text says it cannot be edited and changes nothing', async testContext => {
  const ui = mountStudioWithMesh(testContext);
  ui.controller.selectNode('plain');
  const recipeBefore = ui.controller.exportRecipe();
  ui.press('Tab');
  for (let attempt = 0; attempt < 2000 && !/Text cannot be edited/.test(ui.status()); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve)); // the fake DOM replaces setTimeout
  }
  assert.match(ui.status(), /Text cannot be edited/);
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

// The move handles leave the middle of a small pick clear, so a person can see what is picked.
function mountStudioOnShape(testContext, base) {
  const dom = installStudioDom();
  const recipe = recipeOf({ base });
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
  return { dom, studio, root, viewport, controller: studio.controller, press: (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties }) };
}

function drawnHandles(root) {
  const svg = root.querySelector('.crucible-studio-gizmo');
  const nodes = svg.querySelectorAll('[data-gizmo-axis]').filter(node => node.getAttribute('stroke') !== 'transparent' && node.getAttribute('data-gizmo-hit') === null);
  return {
    planes: nodes.filter(node => ['xy', 'xz', 'yz'].includes(node.getAttribute('data-gizmo-axis'))),
    centreDots: nodes.filter(node => node.tagName === 'CIRCLE' && node.getAttribute('r') === '6.5'),
    shafts: nodes.filter(node => node.tagName === 'LINE'),
  };
}

function distanceFromPointToSegment(point, shaft) {
  const [startX, startY, endX, endY] = ['x1', 'y1', 'x2', 'y2'].map(name => Number(shaft.getAttribute(name)));
  const lengthSquared = (endX - startX) ** 2 + (endY - startY) ** 2;
  const along = Math.max(0, Math.min(1, ((point.x - startX) * (endX - startX) + (point.y - startY) * (endY - startY)) / lengthSquared));
  return Math.hypot(point.x - (startX + along * (endX - startX)), point.y - (startY + along * (endY - startY)));
}

async function pickFaceThrough(ui, predicate) {
  ui.press('Tab');
  await untilEditing(ui);
  const face = faceOf(ui.controller, predicate);
  const centre = pixelOfFaceCentre(ui.controller, face.corners);
  const down = { clientX: VIEWPORT_BOX.left + centre.x, clientY: VIEWPORT_BOX.top + centre.y };
  dispatch(ui.viewport.querySelector('canvas'), 'pointerdown', down);
  dispatch(ui.viewport, 'pointerup', down);
  ui.studio.renderNow();
  const positions = editorPositions(ui.controller);
  const reach = Math.max(...face.corners.map(vertex => {
    const corner = ui.controller.projectWorldPoint(worldPointOf(ui.controller, vertex, positions));
    return Math.hypot(corner.x - centre.x, corner.y - centre.y);
  }));
  return { centre, reach };
}

test('a small pick keeps the middle clear: no centre dot, the plane squares and shafts all start outside the picked face', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  const { centre, reach } = await pickFaceThrough(ui, point => point[2] > 0.49 && point[0] > -1e-6 && point[0] < 0.126 && point[1] > -1e-6 && point[1] < 0.126);
  assert.ok(reach < 30, `the face is small on screen (${reach.toFixed(1)} px from its middle to a corner)`);
  const handles = drawnHandles(ui.root);
  assert.equal(handles.planes.length, 3, 'the three plane squares stay');
  assert.equal(handles.centreDots.length, 0, 'the centre dot would sit on the face');
  assert.ok(handles.shafts.length >= 2, 'the arrows stay');
  for (const square of handles.planes) {
    for (const corner of cornersOf(square)) {
      assert.ok(Math.hypot(corner.x - centre.x, corner.y - centre.y) >= reach, `a corner of the ${square.getAttribute('data-gizmo-axis')} square lies outside the face`);
    }
  }
  for (const shaft of handles.shafts) {
    assert.ok(distanceFromPointToSegment(centre, shaft) >= reach, `the ${shaft.getAttribute('data-gizmo-axis')} shaft starts outside the face`);
  }
  const grabbed = ui.root.querySelectorAll('[data-gizmo-hit]');
  assert.ok(grabbed.length > 0, 'the hit areas of the handles are still there, so the arrows stay as easy to take');
});

test('a large pick also keeps the middle clear, with the arrows cut short of the element at most 60 percent', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0 });
  const { reach } = await pickFaceThrough(ui, point => point[2] > 0.49);
  assert.ok(reach > 60, `the face is large on screen (${reach.toFixed(1)} px)`);
  const handles = drawnHandles(ui.root);
  assert.equal(handles.planes.length, 3);
  assert.equal(handles.centreDots.length, 0);
  assert.ok(handles.shafts.length >= 2);
  const origin = ui.controller.gizmoHandles().origin;
  for (const shaft of handles.shafts) {
    assert.ok(distanceFromPointToSegment(origin, shaft) > 0, 'a shaft starts away from the middle');
  }
});

function cornersOf(polygon) {
  return polygon.getAttribute('points').split(' ').map(pair => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
  });
}

test('a drag on a plane square in edit mode moves the pick in that plane only', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  await pickFaceThrough(ui, point => point[2] > 0.49 && point[0] > -1e-6 && point[0] < 0.126 && point[1] > -1e-6 && point[1] < 0.126);
  const square = drawnHandles(ui.root).planes.find(candidate => candidate.getAttribute('data-gizmo-axis') === 'xy');
  assert.ok(square, 'the xy square is drawn');
  const corners = cornersOf(square);
  const middle = { x: corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length, y: corners.reduce((sum, corner) => sum + corner.y, 0) / corners.length };
  ui.controller.beginGizmoDrag('xy', middle.x, middle.y);
  const moved = ui.controller.updateGizmoDrag(middle.x + 30, middle.y - 20).elementDelta;
  ui.controller.endGizmoDrag();
  assert.ok(Math.hypot(moved[0], moved[1]) > 1e-3, 'the pick moved');
  assert.ok(Math.abs(moved[2]) < 1e-9, `it stayed in the xy plane (z moved ${moved[2]})`);
});

test('clearedPlaneCorners slides a square outward by what each of its two arrows skips, and leaves it alone in object mode', () => {
  const origin = { x: 100, y: 100 };
  const corners = [origin, { x: 110, y: 100 }, { x: 110, y: 90 }, { x: 100, y: 90 }];
  const tips = [{ x: 180, y: 100 }, { x: 100, y: 20 }];
  assert.deepEqual(clearedPlaneCorners(corners, origin, tips, null), corners);
  const moved = clearedPlaneCorners(corners, origin, tips, 12);
  assert.deepEqual(moved[0], { x: 124, y: 76 }, 'the corner on the pick moved 24 along x and 24 along y');
  assert.deepEqual(moved[2], { x: 134, y: 66 });
  const slanted = clearedPlaneCorners(corners, origin, [{ x: 100, y: 20 }, { x: 60, y: 160 }], 12);
  const nearest = Math.min(...slanted.map(corner => Math.hypot(corner.x - origin.x, corner.y - origin.y)));
  assert.ok(nearest >= 24, `axes that point nearly opposite still leave the square as far out as the arrows start (${nearest.toFixed(1)} px)`);
});

test('clearedArrow moves a whole arrow outward by the picked reach plus a gap up to a cap, keeps its length, and leaves object mode alone', () => {
  const origin = { x: 100, y: 100 };
  const tip = { x: 100, y: 20 };
  assert.deepEqual(clearedArrow(origin, tip, null), { start: origin, end: tip });
  assert.deepEqual(clearedArrow(origin, tip, 0), { start: { x: 100, y: 88 }, end: { x: 100, y: 8 } }, 'one vertex still gets the gap, and the tip moves with the start');
  assert.deepEqual(clearedArrow(origin, tip, 30), { start: { x: 100, y: 58 }, end: { x: 100, y: -22 } });
  assert.deepEqual(clearedArrow(origin, tip, 500), { start: { x: 100, y: 0 }, end: { x: 100, y: -80 } }, 'the move stops at 100 px, however big the pick');
  assert.equal(clearedRingRadius(0), 20, 'a vertex: the ring is 20 px out');
  assert.equal(clearedRingRadius(500), 100);
});

test('Tab on a part that comes from an imported file says so and starts no edit', () => {
  // An asset node needs a decoder to expand, which a unit test cannot hold without a file; the refusal reads only the recipe
  // and the selected id, so a controller with exactly those, and the node a placed file leaves in a recipe, pins the message.
  const recipe = { format: 'crucible.scene', schemaVersion: 1, materials: [], geometries: [], nodes: [{ id: 'rock', asset: { id: 'scan' } }] };
  const messages = [];
  const controller = { selectedNodeId: 'rock', exportRecipe: () => recipe };
  const editor = createMeshEditor({ controller, announce: message => messages.push(message) });
  const result = editor.enter();
  assert.equal(result.ok, false);
  assert.equal(result.message, 'This object is an imported file, which has no mesh to edit. Select a shape or a mesh.');
  assert.deepEqual(messages, [result.message]);
  assert.equal(editor.active, false);
});

// What a pointer finds on the drawn handles, from the same stacking order the browser uses: the later element in the tree is on top.
function pointInPolygon(point, corners) {
  let inside = false;
  for (let index = 0, previous = corners.length - 1; index < corners.length; previous = index, index += 1) {
    const first = corners[index];
    const second = corners[previous];
    if ((first.y > point.y) !== (second.y > point.y) && point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x) inside = !inside;
  }
  return inside;
}

// A line with flat ends and this half width, as the browser hit-tests a stroke with a butt cap.
function withinFlatEndedLine(point, line, halfWidth) {
  const [startX, startY, endX, endY] = ['x1', 'y1', 'x2', 'y2'].map(name => Number(line.getAttribute(name)));
  const length = Math.hypot(endX - startX, endY - startY);
  const along = ((point.x - startX) * (endX - startX) + (point.y - startY) * (endY - startY)) / length;
  const across = Math.abs((point.x - startX) * (endY - startY) - (point.y - startY) * (endX - startX)) / length;
  return along >= 0 && along <= length && across <= halfWidth;
}

function topHandleAt(root, point) {
  let found = null;
  for (const node of root.querySelector('.crucible-studio-gizmo').querySelectorAll('[data-gizmo-axis]')) {
    if (node.getAttribute('data-gizmo-ring') !== null) continue;
    const kind = node.getAttribute('data-gizmo-hit');
    let hit = false;
    if (node.tagName === 'CIRCLE' && kind === 'ring') {
      const distance = Math.hypot(point.x - Number(node.getAttribute('cx')), point.y - Number(node.getAttribute('cy')));
      hit = Math.abs(distance - Number(node.getAttribute('r'))) <= Number(node.getAttribute('stroke-width')) / 2;
    } else if (node.tagName === 'CIRCLE') {
      hit = node.getAttribute('fill') !== 'none' && Math.hypot(point.x - Number(node.getAttribute('cx')), point.y - Number(node.getAttribute('cy'))) <= Number(node.getAttribute('r'));
    } else if (node.tagName === 'LINE') {
      hit = kind === 'line' ? withinFlatEndedLine(point, node, 11) : distanceFromPointToSegment(point, node) <= 1.5;
    } else if (node.tagName === 'POLYGON') {
      hit = pointInPolygon(point, cornersOf(node));
    }
    if (hit) found = node.getAttribute('data-gizmo-axis');
  }
  return found;
}

const SMALL_FACE = point => point[2] > 0.49 && point[0] > -1e-6 && point[0] < 0.126 && point[1] > -1e-6 && point[1] < 0.126;

test('in edit mode the answering line of an axis starts and ends where the drawn arrow does, so a click in the gap starts nothing', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  await pickFaceThrough(ui, SMALL_FACE);
  const origin = ui.controller.gizmoHandles().origin;
  const answering = ui.root.querySelectorAll('[data-gizmo-hit="line"]');
  const shafts = drawnHandles(ui.root).shafts;
  assert.ok(shafts.length >= 2);
  for (const shaft of shafts) {
    const axis = shaft.getAttribute('data-gizmo-axis');
    const line = answering.find(candidate => candidate.getAttribute('data-gizmo-axis') === axis);
    for (const name of ['x1', 'y1', 'x2', 'y2']) assert.equal(line.getAttribute(name), shaft.getAttribute(name), `the ${axis} answering line shares ${name} with the drawn shaft`);
    assert.equal(line.getAttribute('stroke-linecap'), 'butt', 'a flat end, so the answering area does not reach back into the gap');
    const start = { x: Number(shaft.getAttribute('x1')), y: Number(shaft.getAttribute('y1')) };
    const halfway = { x: (origin.x + start.x) / 2, y: (origin.y + start.y) / 2 };
    assert.notEqual(topHandleAt(ui.root, halfway), axis, 'the gap between the pick and the arrow is not the arrow');
  }
});

test('the middle of a large face is free: no disc over it, only a thin ring around the pick that moves it in the screen plane', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0 });
  await pickFaceThrough(ui, point => point[2] > 0.49);
  const origin = ui.controller.gizmoHandles().origin;
  const svg = ui.root.querySelector('.crucible-studio-gizmo');
  assert.equal(svg.querySelectorAll('[data-gizmo-hit="disc"]').filter(disc => disc.getAttribute('r') === '13').length, 0, 'the 13 px centre disc is gone');
  const answering = svg.querySelectorAll('[data-gizmo-hit="ring"]');
  assert.equal(answering.length, 1);
  assert.equal(answering[0].getAttribute('data-gizmo-axis'), 'screen');
  assert.equal(Number(answering[0].getAttribute('r')), clearedRingRadius(1e9), 'a big pick puts the ring at the cap');
  assert.ok(Number(answering[0].getAttribute('stroke-width')) <= 22);
  const drawn = svg.querySelectorAll('[data-gizmo-ring="drawn"]');
  assert.equal(drawn.length, 2, 'a pale line under a thin line in the text colour');
  for (const circle of drawn) assert.match(circle.getAttribute('stroke'), /^var\(--studio-(bg|text)\)$/);
  assert.equal(topHandleAt(ui.root, origin), null, 'a click at the middle of the face reaches the mesh and picks');
  assert.equal(topHandleAt(ui.root, { x: origin.x + 40, y: origin.y + 30 }), null, 'so does one inside the ring');
  const ringRadius = clearedRingRadius(1e9);
  assert.equal(topHandleAt(ui.root, { x: origin.x - ringRadius, y: origin.y }), 'screen', 'the ring itself takes the press');
  ui.controller.beginGizmoDrag('screen', origin.x - ringRadius, origin.y);
  const moved = ui.controller.updateGizmoDrag(origin.x - ringRadius + 30, origin.y - 20).elementDelta;
  ui.controller.endGizmoDrag();
  assert.ok(Math.hypot(...moved) > 1e-3, 'dragging the ring moved the pick');
});

test('a vertex keeps the 10 px around it clear of the ring and of every handle (the arrows start 12 px out)', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0 });
  ui.press('Tab');
  await untilEditing(ui);
  ui.press('1');
  const pixel = pixelOfVertex(ui.controller, vertexAt(ui.controller, [0.5, 0.5, 0.5]));
  const down = { clientX: VIEWPORT_BOX.left + pixel.x, clientY: VIEWPORT_BOX.top + pixel.y };
  dispatch(ui.viewport.querySelector('canvas'), 'pointerdown', down);
  dispatch(ui.viewport, 'pointerup', down);
  ui.studio.renderNow();
  const origin = ui.controller.gizmoHandles().origin;
  for (let angle = 0; angle < 360; angle += 15) {
    for (const distance of [0, 5, 10]) {
      const point = { x: origin.x + Math.cos(angle * Math.PI / 180) * distance, y: origin.y + Math.sin(angle * Math.PI / 180) * distance };
      assert.equal(topHandleAt(ui.root, point), null, `${distance} px from the vertex at ${angle} degrees picks the vertex`);
    }
  }
});

test('the tip of an arrow wins over a plane square that lies over it, in the views that foreshorten an axis', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  await pickFaceThrough(ui, SMALL_FACE);
  let lost = 0;
  let sampled = 0;
  for (const preset of ['top', 'front', 'right']) {
    ui.controller.setCameraViewPreset(preset);
    ui.studio.renderNow();
    for (const disc of ui.root.querySelectorAll('[data-gizmo-hit="disc"]')) {
      const [centreX, centreY, radius] = ['cx', 'cy', 'r'].map(name => Number(disc.getAttribute(name)));
      for (let offsetX = -radius; offsetX <= radius; offsetX += 2) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 2) {
          if (Math.hypot(offsetX, offsetY) > radius) continue;
          sampled += 1;
          if (['xy', 'xz', 'yz'].includes(topHandleAt(ui.root, { x: centreX + offsetX, y: centreY + offsetY }))) lost += 1;
        }
      }
    }
  }
  assert.ok(sampled > 300, 'tips were sampled');
  assert.equal(lost, 0, 'no sample point of a tip disc goes to a plane square');
});

test('a plane square whose two axes lie almost along one line on screen is hidden in edit mode, and still drawn in object mode', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  ui.controller.setCameraViewPreset('front');
  ui.controller.orbitCamera({ deltaAzimuth: Math.PI / 4 });
  ui.studio.renderNow();
  const handles = ui.controller.gizmoHandles();
  const thin = Object.entries(handles.planes).filter(([, corners]) => corners && corners.every(point => point.visible) && planeSquareIsTooThin(corners)).map(([name]) => name);
  assert.ok(thin.length > 0, 'this view has a square seen edge on');
  const objectModeSquares = drawnHandles(ui.root).planes.map(square => square.getAttribute('data-gizmo-axis'));
  for (const name of thin) assert.ok(objectModeSquares.includes(name), 'object mode keeps drawing it');
  await pickFaceThrough(ui, point => point[2] > 0.49);
  const editSquares = drawnHandles(ui.root).planes;
  for (const name of thin) assert.equal(editSquares.some(square => square.getAttribute('data-gizmo-axis') === name), false, `the ${name} square is hidden`);
  assert.ok(editSquares.length > 0, 'the squares that can be aimed at stay');
  assert.equal(planeSquareIsTooThin([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 3 }, { x: 0, y: 3 }]), true);
  assert.equal(planeSquareIsTooThin([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 5 }, { x: 0, y: 5 }]), false);
});

test('the arrows keep their drawn length in edit mode while the clearance is under the cap', async testContext => {
  const ui = mountStudioOnShape(testContext, { type: 'box', bevel: 0, subdivisions: 8 });
  await pickFaceThrough(ui, SMALL_FACE);
  const handles = ui.controller.gizmoHandles();
  for (const shaft of drawnHandles(ui.root).shafts) {
    const axis = shaft.getAttribute('data-gizmo-axis');
    const [startX, startY, endX, endY] = ['x1', 'y1', 'x2', 'y2'].map(name => Number(shaft.getAttribute(name)));
    const normalLength = Math.hypot(handles.axes[axis].x - handles.origin.x, handles.axes[axis].y - handles.origin.y);
    assert.ok(Math.abs(Math.hypot(endX - startX, endY - startY) - normalLength) < 0.2, `the ${axis} arrow is as long as in object mode`);
  }
});
