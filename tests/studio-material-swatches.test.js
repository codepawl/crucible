import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { hexToHsv, hsvToHex, normaliseHexColour } from '../src/studio-colour-picker.js';
import { linearRgbToHex } from '../src/studio-controller.js';
import { allByAttribute, byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function makeRecipe({ materials = true } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: materials
      ? [
        { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
        { id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 },
      ]
      : [],
    nodes: materials
      ? [{ id: 'block', geometry: 'cube', material: 'stone' }]
      : [{ id: 'empty-group' }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function mountStudio(testContext, recipeOptions) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(recipeOptions), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  studio.renderNow();
  const root = dom.container.firstElementChild;
  return {
    studio,
    controller: studio.controller,
    root,
    swatches: () => root.querySelectorAll('.crucible-studio-swatch-btn'),
    picker: root.querySelector('.crucible-studio-picker'),
    label: name => byLabel(root, name),
    materialHex: materialId => linearRgbToHex(studio.exportRecipe().materials.find(material => material.id === materialId).color),
  };
}

function typeHex(ui, hex) {
  const input = ui.label('Hex colour');
  input.value = hex;
  dispatch(input, 'input');
}

test('hex text and hue, saturation and value convert both ways', () => {
  assert.equal(normaliseHexColour('#ABC'), '#aabbcc');
  assert.equal(normaliseHexColour('ff8000'), '#ff8000');
  assert.equal(normaliseHexColour('#ff80'), null);
  assert.equal(normaliseHexColour('blue'), null);
  assert.deepEqual(hexToHsv('#ff0000'), { hue: 0, saturation: 1, value: 1 });
  assert.equal(hexToHsv('#00ff00').hue, 120);
  assert.equal(hsvToHex({ hue: 240, saturation: 1, value: 1 }), '#0000ff');
  assert.equal(hsvToHex(hexToHsv('#336699')), '#336699');
  assert.throws(() => hexToHsv('nope'), /#rrggbb/u);
});

test('the swatches sit in the Material panel and show a pencil that the hover styles reveal', testContext => {
  const ui = mountStudio(testContext);
  assert.deepEqual(ui.swatches().map(swatch => swatch.title), ['stone', 'paint']);
  assert.equal(ui.root.querySelector('.crucible-studio-outliner').querySelector('.crucible-studio-swatches'), null);
  assert.equal(ui.swatches()[0].descendants().some(element => element.dataset.icon === 'edit' || element.getAttribute('class') === 'crucible-studio-icon'), true);
});

test('a swatch opens the picker and every change is applied live as one undo step', testContext => {
  const ui = mountStudio(testContext);
  const original = ui.materialHex('paint');
  ui.swatches()[1].click();
  assert.equal(ui.picker.popoverOpen, true);
  assert.equal(ui.label('Hex colour').value, original);
  typeHex(ui, '#102030');
  assert.equal(ui.materialHex('paint'), '#102030');
  typeHex(ui, '#405060');
  assert.equal(ui.materialHex('paint'), '#405060');
  const hue = ui.label('Hue');
  hue.value = '200';
  dispatch(hue, 'input');
  assert.notEqual(ui.materialHex('paint'), '#405060');
  ui.picker.hidePopover();
  assert.notEqual(ui.materialHex('paint'), original);
  assert.equal(ui.controller.undo(), true);
  assert.equal(ui.materialHex('paint'), original, 'one undo takes back the whole edit');
});

test('a quick pick sets the colour of the material being edited', testContext => {
  const ui = mountStudio(testContext);
  ui.swatches()[1].click();
  const stoneHex = ui.materialHex('stone');
  allByAttribute(ui.picker, 'aria-label', `Use ${stoneHex}`)[0].click();
  assert.equal(ui.materialHex('paint'), stoneHex);
  assert.equal(ui.materialHex('stone'), stoneHex);
});

test('Escape closes the picker and puts the colour back without leaving a history step', testContext => {
  const ui = mountStudio(testContext);
  const original = ui.materialHex('paint');
  const stepsBefore = ui.controller.history.position;
  ui.swatches()[1].click();
  typeHex(ui, '#102030');
  assert.equal(ui.materialHex('paint'), '#102030');
  dispatch(ui.picker, 'keydown', { key: 'Escape' });
  assert.equal(ui.picker.popoverOpen, false);
  assert.equal(ui.materialHex('paint'), original);
  assert.equal(ui.controller.history.position, stepsBefore);
});

test('opening the picker and closing it without a change records nothing', testContext => {
  const ui = mountStudio(testContext);
  const undoneBefore = ui.controller.canUndo;
  ui.swatches()[0].click();
  ui.picker.hidePopover();
  assert.equal(ui.controller.canUndo, undoneBefore);
});

test('the plus button adds a material only when the colour is confirmed', testContext => {
  const ui = mountStudio(testContext);
  ui.label('Add a colour').click();
  typeHex(ui, '#22aa44');
  assert.equal(ui.studio.exportRecipe().materials.length, 2, 'nothing is added while the picker is open');
  ui.picker.hidePopover();
  assert.equal(ui.studio.exportRecipe().materials.length, 2, 'clicking away adds nothing');

  ui.label('Add a colour').click();
  typeHex(ui, '#22aa44');
  dispatch(ui.picker, 'keydown', { key: 'Escape' });
  assert.equal(ui.studio.exportRecipe().materials.length, 2, 'Escape adds nothing');

  ui.label('Add a colour').click();
  typeHex(ui, '#22aa44');
  ui.picker.descendants().find(element => element.className === 'crucible-studio-picker-confirm').click();
  const materials = ui.studio.exportRecipe().materials;
  assert.equal(materials.length, 3);
  assert.equal(linearRgbToHex(materials[2].color), '#22aa44');
  assert.equal(ui.swatches().length, 3);
});

test('an invalid hex is ignored and the field shows the colour again', testContext => {
  const ui = mountStudio(testContext);
  ui.swatches()[0].click();
  const before = ui.materialHex('stone');
  typeHex(ui, '#12');
  assert.equal(ui.materialHex('stone'), before);
  dispatch(ui.label('Hex colour'), 'change');
  assert.equal(ui.label('Hex colour').value, before);
  ui.picker.hidePopover();
});

test('a scene without materials says so in the Material tab and offers to create one', testContext => {
  const ui = mountStudio(testContext, { materials: false });
  const slots = ui.root.descendants().filter(element => element.dataset.emptyState === 'true');
  const visible = slots.filter(slot => !slot.hidden);
  assert.equal(visible.length, 1, 'the Material tab shows one empty state');
  assert.equal(visible[0].children[0].textContent, 'No materials yet');
  visible[0].children[1].click();
  assert.equal(ui.studio.exportRecipe().materials.length, 1);
});
