import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_PREFERENCE_DEFAULTS, normalizeStudioPreferences } from '../src/studio-preferences.js';
import {
  STUDIO_LENGTH_UNITS,
  formatLength,
  formatLengthInputValue,
  formatLengthTuple,
  lengthFromUnit,
  lengthToUnit,
  parseLengthInput,
} from '../src/studio-units.js';
import { describeBounds } from '../src/studio-viewport-aids.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function mountStudio(testContext, { sharedDom = null, ...options } = {}) {
  const dom = sharedDom ?? installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer(), ...options });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    studio.dispose();
  };
  testContext.after(() => {
    dispose();
    if (!sharedDom) dom.uninstall();
  });
  const root = dom.container.lastElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  const settingsDialog = root.querySelector('.crucible-studio-settings-dialog');
  return {
    dom,
    studio,
    dispose,
    root,
    settingsDialog,
    controller: studio.controller,
    control: name => settingsDialog.descendants().find(element => element.dataset?.setting === name),
    label: text => root.descendants().find(element => element.getAttribute?.('aria-label') === text),
    tab: name => root.querySelector(`#crucible-studio-tab-${name}`),
    property: id => root.descendants().find(element => element.dataset?.property === id),
    node: id => studio.exportRecipe().nodes.find(candidate => candidate.id === id),
  };
}

function chooseLengthUnit(ui, unit) {
  const select = ui.control('lengthUnit');
  select.value = unit;
  dispatch(select, 'change');
}

function closeDelta(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${actual} to be near ${expected}`);
}

test('shared length formatter and parser support m, cm, mm, ft and in (#3319)', () => {
  assert.deepEqual(STUDIO_LENGTH_UNITS, ['m', 'cm', 'mm', 'ft', 'in']);
  assert.equal(formatLength(1.25, 'm', { signed: true, fixedDecimals: 2 }), '+1.25 m');
  assert.equal(formatLength(1.25, 'cm', { signed: true, fixedDecimals: 2 }), '+125.00 cm');
  assert.equal(formatLength(-0.05, 'mm', { signed: true, fixedDecimals: 2 }), '-50.00 mm');
  assert.equal(formatLength(0.3048, 'ft', { signed: true, fixedDecimals: 2 }), '+1.00 ft');
  assert.equal(formatLength(0.0254, 'in', { signed: true, fixedDecimals: 2 }), '+1.00 in');
  assert.equal(formatLengthTuple([0.42, 0.9, 0.42], 'cm'), '42.00 × 90.00 × 42.00 cm');
  assert.equal(describeBounds({ size: [0.3048, 0.6096, 0.9144] }, 'ft'), '1.00 × 2.00 × 3.00 ft');
  assert.equal(formatLengthInputValue(1.5, 'cm'), '150');
  assert.equal(formatLengthInputValue(0.025, 'mm'), '25');
  closeDelta(lengthFromUnit(2, 'ft'), 0.6096);
  closeDelta(lengthToUnit(0.0508, 'in'), 2);

  closeDelta(parseLengthInput('1.5', 'm'), 1.5);
  closeDelta(parseLengthInput('150 cm', 'm'), 1.5);
  closeDelta(parseLengthInput('50 mm', 'ft'), 0.05);
  closeDelta(parseLengthInput('2 ft', 'm'), 0.6096);
  closeDelta(parseLengthInput("3'", 'm'), 0.9144);
  closeDelta(parseLengthInput('12 in', 'cm'), 0.3048);
  closeDelta(parseLengthInput('6"', 'm'), 0.1524);
  closeDelta(parseLengthInput('25.4 millimeters', 'm'), 0.0254);
  assert.equal(parseLengthInput('', 'm'), null);
  assert.equal(parseLengthInput('not a unit', 'm'), null);
  assert.equal(parseLengthInput('5 bananas', 'm'), null);
});

test('Settings Units changes readout, drag labels and length number fields, and converts each unit into metres (#3319)', testContext => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = mountStudio(testContext, { preferenceStorage: storage });

  ui.tab('camera').click();
  const unitOf = id => ui.property(id).querySelector('.crucible-studio-prop-unit').textContent;
  const nearInput = ui.label('Clip start');
  nearInput.value = '0.25';
  dispatch(nearInput, 'change');
  assert.equal(ui.controller.scene.camera.near, 0.25);

  const expectations = [
    { unit: 'm', typed: '2', expectedMetres: 2, shownNear: '0.25', expectedReadoutSuffix: ' m', expectedDelta: 'X +0.50 m' },
    { unit: 'cm', typed: '150', expectedMetres: 1.5, shownNear: '25', expectedReadoutSuffix: ' cm', expectedDelta: 'X +50.00 cm' },
    { unit: 'mm', typed: '400', expectedMetres: 0.4, shownNear: '250', expectedReadoutSuffix: ' mm', expectedDelta: 'X +500.00 mm' },
    { unit: 'ft', typed: '2', expectedMetres: 0.6096, shownNear: '0.82', expectedReadoutSuffix: ' ft', expectedDelta: 'X +1.64 ft' },
    { unit: 'in', typed: '12', expectedMetres: 0.3048, shownNear: '9.843', expectedReadoutSuffix: ' in', expectedDelta: 'X +19.69 in' },
  ];

  const nodeId = ui.studio.exportRecipe().nodes[0].id;
  const nodeRow = ui.root.querySelectorAll('.crucible-studio-tree-row').find(row => row.dataset.sceneObject === undefined);
  nodeRow.querySelector('.crucible-studio-tree-select').click();

  for (const entry of expectations) {
    chooseLengthUnit(ui, entry.unit);
    ui.studio.renderNow();
    assert.equal(unitOf('near'), entry.unit);
    assert.equal(unitOf('focalLength'), 'mm', 'lens focal length stays in millimetres');
    assert.equal(unitOf('fov'), '°', 'field of view stays in degrees');
    assert.equal(nearInput.value, entry.shownNear);
    const readoutText = ui.root.querySelector('.crucible-studio-readout-selection').textContent;
    assert.ok(readoutText.endsWith(entry.expectedReadoutSuffix), `readout "${readoutText}" ends with ${entry.expectedReadoutSuffix}`);

    // Drag label uses the active unit.
    ui.controller.beginGizmoDrag('x', 100, 100, { toolOverride: 'translate' });
    ui.controller.setGizmoTypedAmount(0.5);
    const deltaLabel = ui.root.querySelector('.crucible-studio-hintbar').textContent;
    ui.controller.cancelGizmoDrag();
    assert.equal(deltaLabel, entry.expectedDelta);

    // Plain number typed in Position X is interpreted in the active display unit and saved in metres.
    const positionX = ui.label('Position X');
    positionX.value = entry.typed;
    dispatch(positionX, 'change');
    closeDelta(ui.node(nodeId).translation[0], entry.expectedMetres);
  }

  // Typed unit suffixes override the active display unit on both Position X and Clip start.
  const positionX = ui.label('Position X');
  positionX.value = '250 cm';
  dispatch(positionX, 'change');
  closeDelta(ui.node(nodeId).translation[0], 2.5);

  nearInput.value = '50 mm';
  dispatch(nearInput, 'change');
  closeDelta(ui.controller.scene.camera.near, 0.05);

  // Preference persists across reload; Reset returns it to metres.
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).lengthUnit, 'in');
  ui.dispose();
  const reloaded = mountStudio(testContext, { preferenceStorage: storage, sharedDom: ui.dom });
  assert.equal(reloaded.studio.preferences.lengthUnit, 'in');
  assert.equal(reloaded.control('lengthUnit').value, 'in');
  assert.equal(normalizeStudioPreferences({ lengthUnit: 'yards' }).lengthUnit, STUDIO_PREFERENCE_DEFAULTS.lengthUnit);

  reloaded.settingsDialog.querySelectorAll('button').find(button => button.textContent === 'Reset settings').click();
  assert.equal(reloaded.studio.preferences.lengthUnit, 'm');
  assert.equal(reloaded.control('lengthUnit').value, 'm');
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).lengthUnit, 'm');
  reloaded.dispose();
});
