import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { KEYMAP_PRESET_IDS, keyLabel, resolveKeymapPreset } from '../src/studio-keymap.js';
import { splitKeyCaps, TOOLTIP_DELAY_MILLISECONDS } from '../src/studio-tooltip.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function mountStudio(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const toolbar = root.querySelector('.crucible-studio-toolbar');
  const buttons = toolbar.querySelectorAll('button');
  buttons.forEach((button, index) => {
    button.box = { left: 12, top: 100 + index * 36, width: 32, height: 32, right: 44, bottom: 132 + index * 36 };
  });
  toolbar.box = { left: 8, top: 90, width: 40, height: 600, right: 48, bottom: 690 };
  return { dom, root, toolbar, studio, tooltip: () => root.querySelector('.crucible-studio-tooltip') };
}

const toolButton = (ui, tool) => ui.toolbar.querySelectorAll('button').find(button => button.dataset.tool === tool);

test('key labels split into caps, keeping a plus key whole', () => {
  assert.deepEqual(splitKeyCaps('Ctrl+Shift+Z'), ['Ctrl', 'Shift', 'Z']);
  assert.deepEqual(splitKeyCaps('Ctrl++'), ['Ctrl', '+']);
  assert.deepEqual(splitKeyCaps(''), []);
});

test('toolbar buttons drop the native title but keep an accessible name (#3597)', testContext => {
  const ui = mountStudio(testContext);
  const buttons = ui.toolbar.querySelectorAll('button');
  assert.ok(buttons.length >= 8);
  for (const button of buttons) {
    assert.equal(button.title, '', `${button.getAttribute('aria-label')} has no native tooltip`);
    assert.ok(button.getAttribute('aria-label'), 'and still has a name');
  }
});

test('hovering a toolbar button shows its name, key caps and what it does beside it after a short delay (#3597)', testContext => {
  const ui = mountStudio(testContext);
  const move = toolButton(ui, 'translate');
  dispatch(move, 'pointerover', { pointerType: 'mouse' });
  assert.equal(ui.tooltip(), null, 'nothing shows before the delay');
  assert.deepEqual(ui.dom.pendingTimerDelays.filter(delay => delay === TOOLTIP_DELAY_MILLISECONDS), [TOOLTIP_DELAY_MILLISECONDS]);
  ui.dom.runTimers();
  const tooltip = ui.tooltip();
  assert.equal(tooltip.getAttribute('role'), 'tooltip');
  assert.equal(tooltip.popoverOpen, true);
  assert.equal(tooltip.querySelector('.crucible-studio-tooltip-name').textContent, 'Move');
  const keymap = resolveKeymapPreset('crucible', {}, { numberPad: false });
  assert.deepEqual(tooltip.querySelectorAll('kbd').map(cap => cap.textContent), [keyLabel(keymap, 'tool.translate')]);
  assert.match(tooltip.querySelector('.crucible-studio-tooltip-hint').textContent, /slide the selection/);
  assert.equal(tooltip.dataset.side, 'right');
  assert.equal(tooltip.style.left, `${ui.toolbar.box.right + 8}px`, 'to the right of the rail');
  assert.equal(move.getAttribute('aria-describedby'), tooltip.id);
});

const rotateLabelOf = presetId => keyLabel(resolveKeymapPreset(presetId, {}, { numberPad: false }), 'tool.rotate');

test('the presets name different keys for Rotate, so the next test can see the keymap in force (#3597)', () => {
  assert.ok(new Set(KEYMAP_PRESET_IDS.map(rotateLabelOf)).size > 1);
});

for (const presetId of KEYMAP_PRESET_IDS) {
  test(`the tooltip names the key of the ${presetId} keymap (#3597)`, testContext => {
    const saved = new Map([['crucible-studio-preferences', JSON.stringify({ keymap: presetId })]]);
    const ui = mountStudio(testContext, { preferenceStorage: { getItem: key => saved.get(key) ?? null, setItem: () => {} } });
    dispatch(toolButton(ui, 'rotate'), 'pointerover', { pointerType: 'mouse' });
    ui.dom.runTimers();
    assert.equal(ui.tooltip().querySelectorAll('kbd').map(cap => cap.textContent).join('+'), rotateLabelOf(presetId));
  });
}

test('moving between buttons is instant, keyboard focus has no delay (#3597)', testContext => {
  const ui = mountStudio(testContext);
  const move = toolButton(ui, 'translate');
  const rotate = toolButton(ui, 'rotate');
  dispatch(move, 'pointerover', { pointerType: 'mouse' });
  ui.dom.runTimers();
  dispatch(move, 'pointerout', { relatedTarget: rotate });
  dispatch(rotate, 'pointerover', { pointerType: 'mouse' });
  assert.equal(ui.tooltip().querySelector('.crucible-studio-tooltip-name').textContent, 'Rotate', 'no wait for the second button');
  assert.equal(ui.tooltip().dataset.instant, 'true');

  const scale = toolButton(ui, 'scale');
  dispatch(rotate, 'pointerout', { relatedTarget: ui.root });
  ui.dom.runTimers();
  dispatch(scale, 'focusin');
  assert.equal(ui.tooltip().querySelector('.crucible-studio-tooltip-name').textContent, 'Scale');
});

test('pressing, Escape, scrolling and leaving hide the tooltip; a press does not bring it back (#3597)', testContext => {
  const ui = mountStudio(testContext);
  const move = toolButton(ui, 'translate');
  const showTooltip = () => {
    dispatch(move, 'pointerover', { pointerType: 'mouse' });
    ui.dom.runTimers();
    assert.equal(ui.tooltip().dataset.state, 'in');
  };
  const isHidden = () => ui.tooltip().dataset.state === 'out';

  showTooltip();
  dispatch(move, 'pointerdown');
  assert.equal(isHidden(), true, 'press');
  dispatch(move, 'pointerover', { pointerType: 'mouse' });
  assert.equal(ui.dom.pendingTimerDelays.includes(TOOLTIP_DELAY_MILLISECONDS), false, 'the pressed button stays quiet');
  dispatch(move, 'pointerout', { relatedTarget: ui.root });
  ui.dom.runTimers();

  showTooltip();
  dispatch(move, 'keydown', { key: 'Escape' });
  assert.equal(isHidden(), true, 'Escape');
  ui.dom.runTimers();

  showTooltip();
  dispatch(ui.toolbar, 'scroll');
  assert.equal(isHidden(), true, 'scroll');
  ui.dom.runTimers();

  showTooltip();
  dispatch(move, 'pointerout', { relatedTarget: ui.root });
  assert.equal(isHidden(), true, 'pointer leave');
  assert.equal(move.getAttribute('aria-describedby'), null);
});

test('other icon buttons use the same tooltip with their accessible name, placed below (#3597)', testContext => {
  const ui = mountStudio(testContext);
  const button = ui.root.querySelector('.crucible-studio-scrub').querySelectorAll('button').find(item => item.dataset.icon === 'play' || item.dataset.icon === 'pause');
  assert.ok(button, 'the timeline has a play button');
  assert.equal(button.title, '');
  button.box = { left: 400, top: 10, width: 32, height: 32, right: 432, bottom: 42 };
  dispatch(button, 'pointerover', { pointerType: 'mouse' });
  ui.dom.runTimers();
  assert.equal(ui.tooltip().querySelector('.crucible-studio-tooltip-name').textContent, button.getAttribute('aria-label'));
  assert.equal(ui.tooltip().dataset.side, 'bottom');
});
