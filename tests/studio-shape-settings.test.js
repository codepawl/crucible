import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { meshGeometryOfPrimitive } from '../src/studio-mesh-edit.js';
import { MESH_EDITED_REASON, SHAPE_SETTINGS, changeShapeSetting, checkedShapeValue, shapeSectionOf } from '../src/studio-shape-settings.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function recipeOf(geometries, nodes) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries,
    nodes: nodes ?? [{ id: 'hero', geometry: geometries[0].id, material: 'grey', label: 'Hero' }],
    camera: CAMERA,
  };
}

function cylinderRecipe() {
  return recipeOf([{ id: 'geo-hero', type: 'cylinder', segments: 32, bevel: 0.025 }]);
}

function controllerOf(recipe) {
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  return controller;
}

function geometryOf(controller, id = 'geo-hero') {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === id);
}

function vertexCountOfHero(controller) {
  return controller.scene.parts.find(part => part.name === 'hero').geometry.positions.length / 3;
}

test('a cylinder goes from 32 to 8 sides, and the part is rebuilt with fewer vertices', () => {
  const controller = controllerOf(cylinderRecipe());
  const before = vertexCountOfHero(controller);
  changeShapeSetting(controller, 'hero', 'segments', '8');
  assert.equal(geometryOf(controller).segments, 8);
  assert.equal(geometryOf(controller).bevel, 0.025, 'the other fields stay');
  assert.ok(vertexCountOfHero(controller) < before, 'the rebuilt shape has fewer vertices');
});

test('one change is one undo step', () => {
  const controller = controllerOf(cylinderRecipe());
  changeShapeSetting(controller, 'hero', 'segments', '8');
  assert.equal(controller.undo(), true);
  assert.equal(geometryOf(controller).segments, 32);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').geometry, 'geo-hero');
  assert.equal(controller.redo(), true);
  assert.equal(geometryOf(controller).segments, 8);
});

test('out-of-range and non-number input is refused with a message that names the range, and the recipe stays', () => {
  const controller = controllerOf(cylinderRecipe());
  const before = JSON.stringify(controller.exportRecipe());
  for (const typed of ['2', '2049', '8.5', 'abc', '', '  ', 'NaN', 'Infinity', '1e999']) {
    assert.throws(
      () => changeShapeSetting(controller, 'hero', 'segments', typed),
      error => error instanceof RangeError && error.message === 'Segments must be a whole number from 3 to 2048, such as 3.',
      `input ${JSON.stringify(typed)}`,
    );
  }
  assert.equal(JSON.stringify(controller.exportRecipe()), before);
});

test('a field the shape does not have is refused with the shapes to pick', () => {
  const controller = controllerOf(cylinderRecipe());
  assert.throws(() => changeShapeSetting(controller, 'hero', 'rings', '8'), /no shape setting "rings"/u);
});

test('a geometry other nodes use is copied, so the others keep their shape', () => {
  const recipe = recipeOf([{ id: 'geo-hero', type: 'cylinder', segments: 32 }], [
    { id: 'hero', geometry: 'geo-hero', material: 'grey' },
    { id: 'twin', geometry: 'geo-hero', material: 'grey', translation: [2, 0, 0] },
  ]);
  const controller = controllerOf(recipe);
  changeShapeSetting(controller, 'hero', 'segments', '8');
  const nodes = controller.exportRecipe().nodes;
  assert.equal(nodes.find(node => node.id === 'twin').geometry, 'geo-hero');
  assert.equal(geometryOf(controller, 'geo-hero').segments, 32);
  const heroGeometry = nodes.find(node => node.id === 'hero').geometry;
  assert.notEqual(heroGeometry, 'geo-hero');
  assert.equal(geometryOf(controller, heroGeometry).segments, 8);
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').geometry, 'geo-hero');
});

test('a shape edited as a mesh has no fields, only the reason', () => {
  const recipe = cylinderRecipe();
  const meshOfShape = { id: 'geo-hero', ...meshGeometryOfPrimitive(recipe.geometries[0]) };
  const edited = controllerOf(recipeOf([meshOfShape]));
  const section = shapeSectionOf(edited.exportRecipe(), 'hero');
  assert.equal(section.fields, undefined);
  assert.equal(section.reason, MESH_EDITED_REASON);
  assert.throws(() => changeShapeSetting(edited, 'hero', 'segments', '8'), /no shape setting/u);
  assert.equal(shapeSectionOf(recipe, 'hero').fields.length, SHAPE_SETTINGS.cylinder.length);
  assert.equal(shapeSectionOf(recipeOf([{ id: 'geo-hero', type: 'lathe', profile: [[0.1, 0], [0.5, 1]] }]), 'hero'), null);
});

// The table repeats the ranges of the recipe's validator. Each bound is applied to the real validator, so a range that drifts fails here.
function validatorAccepts(type, fieldId, value, otherFields = {}) {
  try {
    createAgentScene(recipeOf([{ id: 'geo-hero', type, ...otherFields, [fieldId]: value }]));
    return true;
  } catch {
    return false;
  }
}

// Fields a bound needs beside it: a cone needs one radius above zero, and a sharp box is what lets 128 subdivisions fit the vertex budget.
const COMPANION_FIELDS = { 'cone.radiusTop': { radiusBottom: 1 }, 'cone.radiusBottom': { radiusTop: 1 }, 'box.subdivisions': { bevel: 0 } };

for (const [type, fields] of Object.entries(SHAPE_SETTINGS)) {
  for (const field of fields) {
    test(`${type} ${field.id}: the table's bounds match the validator`, () => {
      const also = COMPANION_FIELDS[`${type}.${field.id}`] ?? {};
      const smallestInside = field.lowerBoundExcluded ? field.min + 0.01 : field.min;
      assert.equal(validatorAccepts(type, field.id, smallestInside, also), true, `minimum ${smallestInside}`);
      assert.doesNotThrow(() => checkedShapeValue(field, String(smallestInside)));
      const justBelow = field.whole ? field.min - 1 : field.min - 0.01;
      const belowIsRefusedByValidator = field.lowerBoundExcluded ? true : !validatorAccepts(type, field.id, justBelow, also);
      assert.equal(belowIsRefusedByValidator, true, `validator takes ${justBelow}`);
      assert.throws(() => checkedShapeValue(field, String(field.lowerBoundExcluded ? field.min : justBelow)), RangeError);
      if (Number.isFinite(field.max)) {
        const largestInside = field.upperBoundExcluded ? field.max - 0.01 : field.max;
        // Building a shape at its largest setting takes seconds, so the validator is asked only about the value above it: a table maximum past the real one fails there.
        assert.doesNotThrow(() => checkedShapeValue(field, String(largestInside)));
        const justAbove = field.whole ? field.max + 1 : field.max + 0.01;
        const aboveRefusedByValidator = field.upperBoundExcluded ? !validatorAccepts(type, field.id, field.max, also) : !validatorAccepts(type, field.id, justAbove, also);
        assert.equal(aboveRefusedByValidator, true, `validator takes the value above ${field.max}`);
        assert.throws(() => checkedShapeValue(field, String(field.upperBoundExcluded ? field.max : justAbove)), RangeError);
      }
    });
  }
}

// The same thing through the Studio page: the fields are in the node panel, a typed number rebuilds the shape, a bad one is told.
function mountStudio(testContext, recipe) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const section = root.querySelector('.crucible-studio-shape-settings');
  const inputLabelled = label => section.descendants().find(element => element.getAttribute('aria-label') === label);
  const status = () => root.querySelector('.crucible-studio-status').textContent;
  return { dom, studio, root, section, inputLabelled, status };
}

test('Studio shows the cylinder fields, rebuilds on a typed value and tells a refused one', testContext => {
  const ui = mountStudio(testContext, cylinderRecipe());
  assert.equal(ui.section.hidden, false);
  const segments = ui.inputLabelled('Segments');
  assert.equal(segments.value, '32');
  assert.equal(ui.inputLabelled('Bevel').value, '0.025');
  segments.value = '8';
  dispatch(segments, 'change');
  assert.equal(geometryOf(ui.studio.controller).segments, 8);
  assert.equal(ui.inputLabelled('Segments').value, '8');
  const refused = ui.inputLabelled('Segments');
  refused.value = '9999';
  dispatch(refused, 'change');
  assert.match(ui.status(), /Segments must be a whole number from 3 to 2048/u);
  assert.equal(geometryOf(ui.studio.controller).segments, 8);
  assert.equal(ui.inputLabelled('Segments').value, '8', 'the field goes back to the recipe');
  const words = ui.inputLabelled('Segments');
  words.value = 'many';
  dispatch(words, 'change');
  assert.match(ui.status(), /Segments must be a whole number/u);
  assert.equal(geometryOf(ui.studio.controller).segments, 8);
});

test('Studio hides the fields of a part edited as a mesh and says why', testContext => {
  const recipe = cylinderRecipe();
  const edited = recipeOf([{ id: 'geo-hero', ...meshGeometryOfPrimitive(recipe.geometries[0]) }]);
  const ui = mountStudio(testContext, edited);
  assert.equal(ui.section.hidden, false);
  assert.equal(ui.inputLabelled('Segments'), undefined);
  const reason = ui.section.querySelector('.crucible-studio-shape-reason');
  assert.equal(reason.hidden, false);
  assert.equal(reason.textContent, MESH_EDITED_REASON);
});

test('Studio shows no shape section for a node that is no basic shape', testContext => {
  const ui = mountStudio(testContext, recipeOf([{ id: 'geo-hero', type: 'lathe', profile: [[0.1, 0], [0.5, 1]] }]));
  assert.equal(ui.section.hidden, true);
});
