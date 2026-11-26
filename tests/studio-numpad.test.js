import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import {
  findKeymapAction,
  findKeymapConflicts,
  formatBinding,
  KEYMAP_PRESET_IDS,
  keyLabel,
  resolveKeymapPreset,
} from '../src/studio-keymap.js';
import { bindingFromKeyEvent } from '../src/studio-key-overrides.js';
import { normalizeStudioPreferences, STUDIO_PREFERENCE_DEFAULTS } from '../src/studio-preferences.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function mountStudio(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  return { dom, studio, root, controller: studio.controller };
}

function memoryStorage() {
  const saved = new Map();
  return { saved, getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
}

function keyEvent(key, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra };
}

test('both number pad choices resolve without clashes in every keymap preset (#3391)', () => {
  for (const numberPad of [false, true]) {
    for (const presetId of KEYMAP_PRESET_IDS) {
      const keymap = resolveKeymapPreset(presetId, {}, { numberPad });
      assert.deepEqual(findKeymapConflicts(keymap.actions), [], `${presetId} numberPad=${numberPad}`);
      if (numberPad) {
        assert.equal(keyLabel(keymap, 'view.front'), 'Numpad 1');
        assert.equal(keyLabel(keymap, 'view.right'), 'Numpad 3');
        assert.equal(keyLabel(keymap, 'view.top'), 'Numpad 7');
        assert.equal(keyLabel(keymap, 'view.projection'), 'Numpad 5');
        assert.equal(findKeymapAction(keymap, keyEvent('1', { code: 'Numpad1' }), 'normal')?.actionId, 'view.front');
        assert.equal(findKeymapAction(keymap, keyEvent('1', { code: 'Digit1' }), 'normal'), null);
      } else {
        assert.equal(keyLabel(keymap, 'view.front'), '1');
        assert.equal(keyLabel(keymap, 'view.right'), '3');
        assert.equal(keyLabel(keymap, 'view.top'), '7');
        assert.equal(keyLabel(keymap, 'view.projection'), '5');
      }
    }
  }
  const crucibleWithPad = resolveKeymapPreset('crucible', {}, { numberPad: true });
  assert.equal(keyLabel(crucibleWithPad, 'view.frame', 0), 'F');
  assert.equal(keyLabel(crucibleWithPad, 'view.frame', 1), 'Numpad .');
  assert.equal(findKeymapAction(crucibleWithPad, keyEvent('.', { code: 'NumpadDecimal' }), 'normal')?.actionId, 'view.frame');
});

test('numpad key recording and formatting preserve physical Numpad codes (#3391)', () => {
  assert.deepEqual(bindingFromKeyEvent(keyEvent('1', { code: 'Numpad1' })), { code: 'Numpad1', shift: false });
  assert.deepEqual(bindingFromKeyEvent(keyEvent('.', { code: 'NumpadDecimal' })), { code: 'NumpadDecimal', shift: false });
  assert.equal(formatBinding({ code: 'Numpad7' }), 'Numpad 7');
  assert.equal(formatBinding({ code: 'NumpadDecimal' }), 'Numpad .');
  assert.equal(formatBinding({ code: 'NumpadAdd', ctrl: true }), 'Ctrl+Numpad +');
});

test('first-run setup includes a Number pad step with keyboard drawings and saves the choice (#3391)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.studio.openSetup();
  const stepNames = ui.root.querySelectorAll('.crucible-studio-setup-step').map(button => button.textContent);
  assert.ok(stepNames.includes('Number pad'));

  const radioFor = value => ui.root.querySelector('.crucible-studio-setup-dialog')
    .descendants()
    .find(element => element.tagName === 'INPUT' && element.dataset.setup === 'numberPad' && element.value === String(value));

  assert.equal(radioFor(false).checked, true);
  assert.equal(radioFor(true).checked, false);

  for (const choice of [true, false]) {
    const card = radioFor(choice).parentNode;
    const svg = card.querySelector('.crucible-studio-keyboard-svg');
    assert.ok(svg, `drawing exists for numberPad=${choice}`);
    assert.equal(svg.querySelectorAll('.crucible-studio-kb-active').length, choice ? 5 : 4, 'highlights view keys');
    const serialized = svg.outerHTML ?? '';
    assert.doesNotMatch(serialized, /#[0-9a-f]{3}|rgb\(/i, 'uses CSS tokens rather than literal colours');
  }

  radioFor(true).checked = true;
  dispatch(radioFor(true), 'change');
  assert.equal(ui.studio.preferences.numberPad, true);
  assert.equal(JSON.parse(storage.saved.get('crucible-studio-preferences')).numberPad, true);
});

test('first number pad press shows a one-time notice that switches view keys when accepted (#3391)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  const notice = () => ui.root.querySelector('.crucible-studio-numpad-notice');
  assert.equal(notice().hidden, true);

  dispatch(ui.dom.document, 'keydown', { key: '1', code: 'Numpad1' });
  assert.equal(notice().hidden, false);
  assert.equal(ui.studio.preferences.numberPadNoticeShown, true);
  assert.equal(ui.studio.preferences.numberPad, false);

  notice().querySelectorAll('button').find(button => button.textContent === 'Use number pad').click();
  assert.equal(notice().hidden, true);
  assert.equal(ui.studio.preferences.numberPad, true);

  const viewMenu = ui.root.querySelector('#crucible-studio-pop-view');
  const frontItem = viewMenu.querySelectorAll('button').find(button => button.textContent === 'Front view');
  assert.equal(frontItem.dataset.shortcut, 'Numpad 1');

  const sheetItems = ui.root.querySelector('.crucible-studio-shortcuts').querySelectorAll('.crucible-studio-shortcut-item');
  const frontSheetRow = sheetItems.find(item => item.querySelector('span').textContent === 'Front view');
  assert.equal(frontSheetRow.querySelector('.crucible-studio-shortcut-keys').textContent, 'Numpad 1');
  const projSheetRow = sheetItems.find(item => item.querySelector('span').textContent === 'Perspective or orthographic');
  assert.equal(projSheetRow.querySelector('.crucible-studio-shortcut-keys').textContent, 'Numpad 5');

  const viewCube = ui.root.querySelector('.crucible-studio-viewcube');
  const frontChip = viewCube.querySelectorAll('button').find(button => button.dataset.view === 'front');
  assert.equal(frontChip.title, 'Front view (Numpad 1)');

  const projectionChip = viewCube.querySelectorAll('button').find(button => button.textContent === 'Perspective' || button.textContent === 'Orthographic');
  assert.equal(projectionChip.title, 'Perspective / Orthographic (Numpad 5)');

  dispatch(ui.dom.document, 'keydown', { key: '1', code: 'Numpad1' });
  const frontEye = ui.controller.scene.camera.eye;
  assert.ok(frontEye[2] > 1 && Math.abs(frontEye[0]) < 0.05, `Numpad 1 sets Front view, got eye=${frontEye}`);
});

test('dismissing the number pad notice once keeps the number row and never prompts again (#3391)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  const notice = ui.root.querySelector('.crucible-studio-numpad-notice');

  dispatch(ui.dom.document, 'keydown', { key: '7', code: 'Numpad7' });
  assert.equal(notice.hidden, false);
  notice.querySelectorAll('button').find(button => button.textContent === 'Keep number row').click();
  assert.equal(notice.hidden, true);
  assert.equal(ui.studio.preferences.numberPad, false);
  assert.equal(ui.studio.preferences.numberPadNoticeShown, true);

  dispatch(ui.dom.document, 'keydown', { key: '3', code: 'Numpad3' });
  assert.equal(notice.hidden, true);
});

async function untilEditing(ui, wanted = 'true') {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== wanted; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, wanted);
}

test('toggling Number pad in Settings updates menus, tooltips, Help sheet and edit-mode view routing (#3391)', async testContext => {
  const ui = mountStudio(testContext);
  const numberPadToggle = ui.root.querySelector('.crucible-studio-settings-dialog')
    .descendants()
    .find(element => element.dataset?.setting === 'numberPad');
  assert.equal(numberPadToggle.type, 'checkbox');
  assert.equal(numberPadToggle.checked, false);

  numberPadToggle.checked = true;
  dispatch(numberPadToggle, 'change');
  assert.equal(ui.studio.preferences.numberPad, true);

  const viewMenu = ui.root.querySelector('#crucible-studio-pop-view');
  assert.equal(viewMenu.querySelectorAll('button').find(button => button.textContent === 'Top view').dataset.shortcut, 'Numpad 7');
  assert.equal(ui.root.querySelector('.crucible-studio-viewcube').querySelectorAll('button').find(button => button.dataset.view === 'right').title, 'Right view (Numpad 3)');

  const firstNodeId = ui.controller.exportRecipe().nodes[0].id;
  ui.studio.selectNode(firstNodeId);
  dispatch(ui.dom.document, 'keydown', { key: 'Tab' });
  await untilEditing(ui, 'true');
  dispatch(ui.dom.document, 'keydown', { key: '3', code: 'Numpad3' });
  const rightEye = ui.controller.scene.camera.eye;
  assert.ok(rightEye[0] > 1 && Math.abs(rightEye[2]) < 0.05, `Numpad 3 triggers Right view in edit mode, got eye=${rightEye}`);
});

test('numberPad preference defaults to false and resets cleanly (#3391)', () => {
  assert.equal(STUDIO_PREFERENCE_DEFAULTS.numberPad, false);
  assert.equal(STUDIO_PREFERENCE_DEFAULTS.numberPadNoticeShown, false);
  const normalized = normalizeStudioPreferences({ numberPad: true, numberPadNoticeShown: true });
  assert.equal(normalized.numberPad, true);
  assert.equal(normalized.numberPadNoticeShown, true);
});
