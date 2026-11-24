import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { isLiveGeometry, markLiveGeometry } from '../src/live-geometry.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { STUDIO_PRIMITIVE_GROUPS, primitiveGeometrySpec } from '../src/studio-templates.js';
import { createMeshEditor, meshGeometryOfPrimitive } from '../src/studio-mesh-edit.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const MESH_SHAPES = STUDIO_PRIMITIVE_GROUPS[0].primitives;
// Faces of each shape as a mesh, measured on the Add menu's own descriptions. The box and the cylinder lose their bevel on the
// way (1,482 and 672 faces with it); the sphere and the torus are the densest, and stay under the cage budget of 8,000 triangles.
const FACES_AFTER_CONVERSION = { plane: 64, box: 6, disc: 37, sphere: 864, icoSphere: 320, cylinder: 96, cone: 72, torus: 1344 };

function nodeOfShape(primitiveType, id = 'hero') {
  const spec = primitiveGeometrySpec(primitiveType);
  return { id, geometry: `geo-${id}`, material: 'grey', label: `Shape ${id}`, translation: spec.translation, rotation: spec.rotation, scale: spec.scale };
}

function recipeOfShape(primitiveType, { extraNodes = [], extraGeometries = [] } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'geo-hero', ...primitiveGeometrySpec(primitiveType).geometry }, ...extraGeometries],
    nodes: [nodeOfShape(primitiveType), ...extraNodes],
    camera: CAMERA,
  };
}

function mount(recipe) {
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const messages = [];
  const updatePart = (renderer, part, positions, normals) => {
    part.geometry.positions.set(positions);
    if (normals) part.geometry.normals.set(normals);
    markLiveGeometry(part.geometry);
  };
  const editor = createMeshEditor({ controller, announce: message => messages.push(message), getRenderer: () => ({}), updatePart });
  return { controller, editor, messages };
}

function heroPart(controller) {
  return controller.scene.parts.find(part => part.name === 'hero');
}

function geometryOf(controller, id) {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === id);
}

function heroNode(controller) {
  return controller.exportRecipe().nodes.find(node => node.id === 'hero');
}

// Picks the first face that a click on its own centre hits, so the same code finds a face of every shape, a torus with its hole included.
function pickAnyFace(controller, editor) {
  editor.setMode('face');
  const mesh = meshEditSourceOf(heroPart(controller).geometry).mesh;
  const matrix = heroPart(controller).matrix;
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const centre = [0, 0, 0];
    const count = mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) {
      const vertex = mesh.cornerVertices[corner];
      const [x, y, z] = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
      centre[0] += (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / count;
      centre[1] += (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / count;
      centre[2] += (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / count;
    }
    const pixel = controller.projectWorldPoint(centre);
    if (editor.pick(pixel.x, pixel.y) !== null) return;
  }
  throw new Error('no face of this shape can be picked');
}

function dragSelection(controller) {
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 40, origin.y - 25);
  controller.endGizmoDrag();
}

for (const primitiveType of MESH_SHAPES) {
  test(`Tab on a ${primitiveType} turns it into a mesh of ${FACES_AFTER_CONVERSION[primitiveType]} faces without moving it; a drag moves a pick and undo gives the shape back`, () => {
    const recipe = recipeOfShape(primitiveType);
    const { controller, editor } = mount(recipe);
    const geometriesBefore = controller.exportRecipe().geometries;
    const matrixBefore = Array.from(heroPart(controller).matrix);
    const nodeBefore = heroNode(controller);
    const entered = editor.enter();
    assert.equal(entered.ok, true, entered.message);
    assert.equal(editor.active, true);

    const { geometry: newGeometryId, ...convertedFields } = heroNode(controller);
    const { geometry: oldGeometryId, ...fieldsBefore } = nodeBefore;
    assert.deepEqual(convertedFields, fieldsBefore, 'name, label, material and transform stay');
    const geometry = geometryOf(controller, newGeometryId);
    assert.equal(geometry.type, 'mesh');
    assert.equal(geometry.base.type, geometriesBefore[0].type);
    assert.equal(geometryOf(controller, oldGeometryId), undefined, 'the shape nothing uses any more is gone');
    assert.equal(editor.cage.mesh.faceCount, FACES_AFTER_CONVERSION[primitiveType]);
    const matrixAfter = heroPart(controller).matrix;
    matrixBefore.forEach((value, index) => assert.ok(Math.abs(value - matrixAfter[index]) < 1e-6, `world matrix entry ${index}`));

    pickAnyFace(controller, editor);
    const positionsBefore = Float32Array.from(editor.cage.mesh.positions);
    dragSelection(controller);
    assert.equal(geometryOf(controller, newGeometryId).edits.length, 1, 'one drag is one entry');
    assert.notDeepEqual(Array.from(editor.cage.mesh.positions), Array.from(positionsBefore), 'the picked face moved');
    controller.undo();
    assert.equal((geometryOf(controller, newGeometryId).edits ?? []).length, 0, 'the first undo takes the drag back');
    assert.equal(editor.active, true);
    controller.undo();
    assert.deepEqual(heroNode(controller), nodeBefore);
    assert.deepEqual(controller.exportRecipe().geometries, geometriesBefore, 'the shape is back as it was, bevel included');
    editor.refresh();
    assert.equal(editor.active, false, 'undo of the conversion leaves edit mode');
  });
}

test('every shape of the Add menu converts and none is missing from the table', () => {
  assert.deepEqual(Object.keys(FACES_AFTER_CONVERSION).sort(), [...MESH_SHAPES].sort());
  for (const primitiveType of MESH_SHAPES) {
    assert.equal(meshGeometryOfPrimitive({ id: 'x', ...primitiveGeometrySpec(primitiveType).geometry }).type, 'mesh');
  }
});

test('a box and a cylinder lose their bevel, other shapes keep all they had, and the shape is not changed in place', () => {
  const box = { id: 'a', type: 'box', bevel: 0.04 };
  assert.deepEqual(meshGeometryOfPrimitive(box), { type: 'mesh', base: { type: 'box', bevel: 0 } });
  assert.equal(box.bevel, 0.04);
  assert.deepEqual(meshGeometryOfPrimitive({ id: 'b', type: 'cylinder', segments: 48, bevel: 0.025 }).base, { type: 'cylinder', segments: 48, bevel: 0 });
  assert.deepEqual(meshGeometryOfPrimitive({ id: 'c', type: 'torus', tubeRadius: 0.24, segments: 56, sides: 24 }).base, { type: 'torus', tubeRadius: 0.24, segments: 56, sides: 24 });
  assert.equal(meshGeometryOfPrimitive({ id: 'd', type: 'text', text: 'Hi' }), null);
});

test('a box whose geometry a twin shares becomes its own mesh and the twin keeps the shape, before and after an edit', () => {
  const twin = { ...nodeOfShape('box', 'twin'), geometry: 'geo-hero', translation: [3, 0.5, 0] };
  const { controller, editor } = mount(recipeOfShape('box', { extraNodes: [twin] }));
  editor.enter();
  const recipe = controller.exportRecipe();
  assert.equal(recipe.nodes.find(node => node.id === 'twin').geometry, 'geo-hero');
  assert.deepEqual(geometryOf(controller, 'geo-hero'), { id: 'geo-hero', type: 'box', bevel: 0.04 });
  assert.equal(geometryOf(controller, heroNode(controller).geometry).type, 'mesh');
  pickAnyFace(controller, editor);
  dragSelection(controller);
  assert.deepEqual(geometryOf(controller, 'geo-hero'), { id: 'geo-hero', type: 'box', bevel: 0.04 }, 'the twin did not move');
  controller.undo();
  controller.undo();
  assert.equal(heroNode(controller).geometry, 'geo-hero');
});

test('a parent, a child and the material stay with the object that turns into a mesh', () => {
  const child = { ...nodeOfShape('sphere', 'child'), geometry: 'geo-hero', parent: 'hero', translation: [0, 1, 0] };
  const { controller, editor } = mount(recipeOfShape('cone', { extraNodes: [child] }));
  const before = controller.exportRecipe();
  editor.enter();
  const after = controller.exportRecipe();
  assert.deepEqual(after.nodes.find(node => node.id === 'child'), before.nodes.find(node => node.id === 'child'));
  assert.deepEqual(after.materials, before.materials);
  assert.equal(after.nodes.length, before.nodes.length);
});

test('what edit mode cannot take says what the thing is and what to do instead, and changes nothing', () => {
  const cases = [
    { name: 'text', geometries: [{ id: 'words', type: 'text', text: 'Hi', size: 0.6, depth: 0.12 }], node: { id: 'other', geometry: 'words', material: 'grey' }, message: /Text cannot be edited.*properties panel/ },
    { name: 'a group', geometries: [], node: { id: 'other' }, children: [{ id: 'part-of-group', geometry: 'geo-hero', material: 'grey', parent: 'other' }], message: /is a group.*no mesh to edit.*Select a shape or a mesh/ },
    { name: 'an empty object', geometries: [], node: { id: 'other' }, message: /is an empty object.*Select a shape or a mesh/ },
    { name: 'a mesh with a modifier', geometries: [{ id: 'stacked', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 1 }] }], node: { id: 'other', geometry: 'stacked', material: 'grey' }, message: /modifiers.*Add a plain shape from the Mesh group.*applied first/ },
  ];
  for (const { name, geometries, node, children = [], message } of cases) {
    const { controller, editor, messages } = mount(recipeOfShape('box', { extraNodes: [node, ...children], extraGeometries: geometries }));
    controller.selectNode('other');
    const before = controller.exportRecipe();
    const result = editor.enter();
    assert.equal(result.ok, false, name);
    assert.match(messages.at(-1), message, name);
    assert.deepEqual(controller.exportRecipe(), before, `${name} is left as it was`);
    assert.equal(editor.active, false);
  }
});

test('leaving in the middle of a drag leaves no live-geometry mark on a converted shape and no edit in the log', () => {
  const { controller, editor } = mount(recipeOfShape('cylinder'));
  editor.enter();
  pickAnyFace(controller, editor);
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 30, origin.y - 20);
  assert.equal(isLiveGeometry(heroPart(controller).geometry), true, 'the preview marks it while dragging');
  editor.leave();
  assert.equal(isLiveGeometry(heroPart(controller).geometry), false);
  assert.equal(geometryOf(controller, heroNode(controller).geometry).edits, undefined);
});

async function settle(ticks = 300) {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise(resolve => setImmediate(resolve));
}

function mountStudioWithBox(testContext, recipe = recipeOfShape('box')) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  studio.controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  return { studio, root, press, controller: studio.controller };
}

async function untilEditing(ui, wanted = 'true') {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== wanted; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, wanted);
}

test('Tab on a box in the Studio page converts it and enters; Tab leaves it a mesh; undo gives the box back', async testContext => {
  const ui = mountStudioWithBox(testContext);
  const boxRecipe = ui.controller.exportRecipe();
  ui.press('Tab');
  await untilEditing(ui);
  assert.equal(geometryOf(ui.controller, heroNode(ui.controller).geometry).type, 'mesh');
  assert.equal(geometryOf(ui.controller, heroNode(ui.controller).geometry).base.bevel, 0);
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.equal(geometryOf(ui.controller, heroNode(ui.controller).geometry).type, 'mesh', 'leaving keeps the mesh');
  ui.press('z', { ctrlKey: true });
  assert.deepEqual(ui.controller.exportRecipe().geometries, boxRecipe.geometries);
});

test('Tab twice on a box before the editor has loaded converts nothing, and a third Tab converts and enters once', async testContext => {
  const ui = mountStudioWithBox(testContext);
  const boxRecipe = ui.controller.exportRecipe();
  ui.press('Tab');
  ui.press('Tab');
  await settle();
  assert.equal(ui.root.dataset.meshEdit ?? 'false', 'false');
  assert.deepEqual(ui.controller.exportRecipe(), boxRecipe);
  ui.press('Tab');
  await untilEditing(ui);
  assert.equal(ui.controller.exportRecipe().geometries.filter(geometry => geometry.type === 'mesh').length, 1);
  ui.press('Escape');
  assert.equal(ui.root.dataset.meshEdit, 'false');
  assert.equal(isLiveGeometry(ui.controller.scene.parts.find(part => part.name === 'hero').geometry), false);
});

test('undo in the middle of a drag cancels the drag and leaves edit mode with no error, no live mark and no stray geometry', () => {
  const { controller, editor } = mount(recipeOfShape('box'));
  const before = controller.exportRecipe();
  editor.enter();
  pickAnyFace(controller, editor);
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 30, origin.y);
  controller.undo();
  editor.refresh();
  assert.equal(editor.active, false, 'the box is back, so edit mode is over');
  assert.doesNotThrow(() => {
    controller.updateGizmoDrag(origin.x + 40, origin.y);
    controller.endGizmoDrag();
    editor.refresh();
  });
  assert.equal(controller.dragging, false);
  assert.equal(isLiveGeometry(heroPart(controller).geometry), false);
  assert.deepEqual(controller.exportRecipe(), before);
});

test('undoing a drag edit while another drag is running re-syncs the cage instead of leaving a stale one', () => {
  const { controller, editor } = mount(recipeOfShape('box'));
  editor.enter();
  pickAnyFace(controller, editor);
  dragSelection(controller);
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 30, origin.y);
  controller.undo();
  editor.refresh();
  assert.equal(controller.dragging, false);
  assert.equal(editor.active, true, 'the mesh still exists');
  assert.equal(editor.cage.mesh.positions.every(Number.isFinite), true);
  assert.equal(isLiveGeometry(heroPart(controller).geometry), false);
  assert.doesNotThrow(() => editor.pick(400, 300));
});

test('a child and keyframes on the transform stay with the object through the conversion and come back with undo', () => {
  const child = { ...nodeOfShape('sphere', 'child'), geometry: 'geo-hero', parent: 'hero', translation: [0, 1, 0] };
  const recipe = recipeOfShape('cylinder', { extraNodes: [child] });
  recipe.motion = { duration: 2, loop: true, tracks: [{ kind: 'node', id: 'hero', property: 'translation', keyframes: [{ time: 0, value: recipe.nodes[0].translation }, { time: 1, value: [1, 1, 1] }] }] };
  const { controller, editor } = mount(recipe);
  const before = controller.exportRecipe();
  editor.enter();
  const converted = controller.exportRecipe();
  assert.deepEqual(converted.motion, before.motion);
  assert.deepEqual(converted.nodes.find(node => node.id === 'child'), before.nodes.find(node => node.id === 'child'));
  controller.undo();
  editor.refresh();
  assert.deepEqual(controller.exportRecipe(), before);
});

test('a selection that changes while the editor loads leaves the object Tab was pressed on alone and enters nothing else', async testContext => {
  const recipe = recipeOfShape('box', { extraNodes: [nodeOfShape('box', 'other')], extraGeometries: [{ id: 'geo-other', type: 'box', bevel: 0.04 }] });
  const ui = mountStudioWithBox(testContext, recipe);
  const before = ui.controller.exportRecipe();
  ui.press('Tab');
  ui.controller.selectNode('other');
  await settle();
  assert.equal(ui.root.dataset.meshEdit ?? 'false', 'false');
  assert.deepEqual(ui.controller.exportRecipe(), before, 'neither box was converted');
  ui.press('Tab');
  await untilEditing(ui);
  assert.equal(ui.controller.exportRecipe().nodes.find(node => node.id === 'other').geometry.endsWith('-mesh'), true, 'a fresh Tab acts on the new selection');
  assert.equal(geometryOf(ui.controller, 'geo-hero').type, 'box');
});
