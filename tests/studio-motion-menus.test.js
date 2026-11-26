import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { longestTransitionMilliseconds, popoverOpeningStyle } from '../src/studio-popover-motion.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
};

function mountStudio(testContext) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  return { dom, studio, root };
}

/** Makes the fake window answer getComputedStyle with the durations the real stylesheet would give. */
function answerTransitionDuration(dom, durations) {
  dom.document.defaultView.getComputedStyle = element => ({ transitionDuration: durations[element.dataset.state] ?? '0s' });
}

/** The notice's own timers: its hide delay of 3400 ms and its exit fallback of 150 ms. Other timers, such as the draft save, are not its. */
function noticeTimerCount(dom) {
  return dom.pendingTimerDelays.filter(delay => delay === 3400 || delay === 150).length;
}

function clickAddMenuItem(root, label) {
  byText(root.querySelector('#crucible-studio-pop-add'), label).click();
}

test('a menu scales from the corner nearest its trigger and starts 4px toward it (#3223)', () => {
  assert.deepEqual(popoverOpeningStyle({ beside: false, opensLeftward: false, opensUpward: false }), { origin: '0 0', shift: '0 -4px' });
  assert.deepEqual(popoverOpeningStyle({ beside: false, opensLeftward: true, opensUpward: false }), { origin: '100% 0', shift: '0 -4px' });
  assert.deepEqual(popoverOpeningStyle({ beside: false, opensLeftward: false, opensUpward: true }), { origin: '0 100%', shift: '0 4px' });
  assert.deepEqual(popoverOpeningStyle({ beside: true, opensLeftward: false, opensUpward: false }), { origin: '0 0', shift: '-4px 0' });
  assert.deepEqual(popoverOpeningStyle({ beside: true, opensLeftward: false, opensUpward: true }), { origin: '0 100%', shift: '-4px 0' });
});

test('the longest transition duration reads seconds, milliseconds and lists, and nothing as zero (#3223)', () => {
  assert.equal(longestTransitionMilliseconds('0.11s, 0.17s'), 170);
  assert.equal(longestTransitionMilliseconds('80ms'), 80);
  assert.equal(longestTransitionMilliseconds('0s'), 0);
  assert.equal(longestTransitionMilliseconds(undefined), 0);
});

test('a menu opening downward, leftward and upward writes its origin and shift when it opens (#3223)', testContext => {
  const { root } = mountStudio(testContext);
  const viewPopover = root.querySelector('#crucible-studio-pop-view');
  const viewButton = byText(root.querySelector('.crucible-studio-menus'), 'View');
  viewButton.box = { left: 100, top: 10, width: 60, height: 30, right: 160, bottom: 40 };
  viewPopover.showPopover();
  assert.equal(viewPopover.style.getPropertyValue('--studio-popover-origin'), '0 0', 'a trigger in the left half opens downward and rightward');
  assert.equal(viewPopover.style.getPropertyValue('--studio-popover-shift'), '0 -4px');
  viewButton.box = { left: 900, top: 10, width: 60, height: 30, right: 960, bottom: 40 };
  viewPopover.showPopover();
  assert.equal(viewPopover.style.getPropertyValue('--studio-popover-origin'), '100% 0', 'a trigger in the right half opens leftward');
  const addPopover = root.querySelector('#crucible-studio-pop-add');
  const addButton = root.descendants().find(element => element.getAttribute('aria-label') === 'Add an object or a light');
  addButton.box = { left: 20, top: 700, width: 30, height: 30, right: 50, bottom: 730 };
  addPopover.showPopover();
  assert.equal(addPopover.style.getPropertyValue('--studio-popover-origin'), '0 100%', 'a menu hanging from its foot grows upward');
  assert.equal(addPopover.style.getPropertyValue('--studio-popover-shift'), '-4px 0', 'and starts beside its trigger');
});

test('the first message shows at once in the live region, and the box leaves with its text after the exit (#3223)', testContext => {
  const { dom, root } = mountStudio(testContext);
  answerTransitionDuration(dom, { out: '0.11s, 0.11s' });
  const notice = root.querySelector('.crucible-studio-status');
  assert.equal(notice.getAttribute('role'), 'status');
  clickAddMenuItem(root, 'Spot light');
  assert.equal(notice.dataset.state, 'in');
  assert.ok(notice.textContent.length > 0, 'the text is there before any timer runs');
  assert.deepEqual(dom.pendingTimerDelays.slice(-1), [3400]);
  dom.runTimers();
  assert.equal(notice.dataset.state, 'out');
  assert.ok(notice.textContent.length > 0, 'the text stays while the box fades');
  assert.deepEqual(dom.pendingTimerDelays.filter(delay => delay === 150), [150], 'the fallback follows the 110 ms exit plus its slack');
  dom.runTimers();
  assert.equal(notice.textContent, '');
  assert.equal(notice.dataset.state, undefined);
});

test('a second message swaps the text, keeps the state and restarts only the hide timer (#3223)', testContext => {
  const { dom, root } = mountStudio(testContext);
  answerTransitionDuration(dom, { out: '0.11s' });
  const notice = root.querySelector('.crucible-studio-status');
  clickAddMenuItem(root, 'Spot light');
  const firstText = notice.textContent;
  const stateWrites = [];
  notice.dataset = new Proxy(notice.dataset, {
    set: (target, key, value) => {
      stateWrites.push([key, value]);
      target[key] = value;
      return true;
    },
  });
  clickAddMenuItem(root, 'Point light');
  assert.notEqual(notice.textContent, firstText);
  assert.equal(notice.dataset.state, 'in');
  assert.deepEqual(stateWrites, [['state', 'in']], 'the state is set to what it already is, so nothing replays');
  assert.equal(noticeTimerCount(dom), 1, 'one hide timer, the first one cleared');
});

test('a message during the exit flips back to in, and the exit timer is gone (#3223)', testContext => {
  const { dom, root } = mountStudio(testContext);
  answerTransitionDuration(dom, { out: '0.11s' });
  const notice = root.querySelector('.crucible-studio-status');
  clickAddMenuItem(root, 'Spot light');
  dom.runTimers();
  assert.equal(notice.dataset.state, 'out');
  clickAddMenuItem(root, 'Point light');
  assert.equal(notice.dataset.state, 'in');
  assert.equal(noticeTimerCount(dom), 1, 'only the new hide timer is left, so the old exit cannot clear the new text');
  dom.runTimers();
  assert.equal(notice.dataset.state, 'out');
});

test('transitionend ends the exit, a transition of another property does not, and a browser without transitions clears at once (#3223)', testContext => {
  const { dom, root } = mountStudio(testContext);
  const notice = root.querySelector('.crucible-studio-status');
  answerTransitionDuration(dom, { out: '0.11s' });
  clickAddMenuItem(root, 'Spot light');
  dom.runTimers();
  dispatch(notice, 'transitionend', { propertyName: 'translate' });
  assert.equal(notice.dataset.state, 'out', 'the translate finishing does not end it');
  dispatch(notice, 'transitionend', { propertyName: 'opacity' });
  assert.equal(notice.textContent, '');
  assert.equal(noticeTimerCount(dom), 0);
  answerTransitionDuration(dom, {});
  clickAddMenuItem(root, 'Spot light');
  dom.runTimers();
  assert.equal(notice.textContent, '', 'no exit duration means no wait');
});

test('dispose clears the hide timer and the exit timer (#3223)', testContext => {
  const first = mountStudio(testContext);
  answerTransitionDuration(first.dom, { out: '0.11s' });
  clickAddMenuItem(first.root, 'Spot light');
  assert.equal(noticeTimerCount(first.dom), 1);
  first.studio.dispose();
  assert.equal(noticeTimerCount(first.dom), 0);
});

test('disposing during an exit clears the exit timer too (#3223)', testContext => {
  const { dom, studio, root } = mountStudio(testContext);
  answerTransitionDuration(dom, { out: '0.11s' });
  clickAddMenuItem(root, 'Spot light');
  dom.runTimers();
  assert.equal(noticeTimerCount(dom), 1, 'the exit timer is pending');
  studio.dispose();
  assert.equal(noticeTimerCount(dom), 0);
});

test('a hover switch between menubar menus is marked only while it flushes style, and needs no frame (#3223)', testContext => {
  const { dom, root } = mountStudio(testContext);
  const menubar = root.querySelector('.crucible-studio-menubar');
  const viewPopover = root.querySelector('#crucible-studio-pop-view');
  const editPopover = root.querySelector('#crucible-studio-pop-edit');
  for (const popover of [viewPopover, editPopover]) {
    popover.matches = selector => selector === ':popover-open' && popover.popoverOpen;
  }
  const markedWhenFlushed = [];
  dom.document.defaultView.getComputedStyle = element => {
    markedWhenFlushed.push([element.id, menubar.dataset.switching]);
    return { opacity: '1' };
  };
  dispatch(byText(root.querySelector('.crucible-studio-menus'), 'Edit'), 'pointerenter');
  assert.deepEqual(markedWhenFlushed, [], 'with no menu open nothing switches');
  viewPopover.showPopover();
  dispatch(byText(root.querySelector('.crucible-studio-menus'), 'Edit'), 'pointerenter');
  assert.equal(viewPopover.popoverOpen, false);
  assert.equal(editPopover.popoverOpen, true);
  assert.deepEqual(markedWhenFlushed, [['crucible-studio-pop-edit', 'true']], 'the incoming menu is read while the bar is marked');
  assert.equal(menubar.dataset.switching, undefined, 'the mark is gone in the same task');
  assert.equal(dom.pendingAnimationFrameCount, 0, 'no frame is waiting to clear it');
});

test('the last input kind sits on the root: a key sets keyboard, a press sets pointer, a modifier changes nothing, dispose lets go (#3223)', testContext => {
  const { dom, studio, root } = mountStudio(testContext);
  assert.equal(root.dataset.input, undefined);
  dispatch(dom.document, 'keydown', { key: 'a' });
  assert.equal(root.dataset.input, 'keyboard');
  dispatch(dom.document, 'pointerdown');
  assert.equal(root.dataset.input, 'pointer');
  for (const modifier of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
    dispatch(dom.document, 'keydown', { key: modifier });
    assert.equal(root.dataset.input, 'pointer', `${modifier} alone does not turn a click into a keyboard action`);
  }
  dispatch(dom.document, 'keydown', { key: 'ArrowRight' });
  assert.equal(root.dataset.input, 'keyboard');
  studio.dispose();
  dispatch(dom.document, 'pointerdown');
  assert.equal(root.dataset.input, 'keyboard', 'after dispose the listeners are gone');
});

test('announce with an empty message clears the box at once and leaves no timer (#3223)', async testContext => {
  const { dom, root } = mountStudio(testContext);
  answerTransitionDuration(dom, { out: '0.11s' });
  const notice = root.querySelector('.crucible-studio-status');
  clickAddMenuItem(root, 'Spot light');
  assert.equal(notice.dataset.state, 'in');
  const realParse = JSON.parse;
  JSON.parse = () => {
    throw new Error('');
  };
  try {
    byText(root, 'Apply JSON').click();
    await dom.settle();
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(notice.textContent, '');
  assert.equal(notice.dataset.state, undefined);
  assert.equal(noticeTimerCount(dom), 0);
});

test('a popover with no opening style of its own gets the default: from the top left corner, 4px up (#3223)', () => {
  assert.deepEqual(popoverOpeningStyle(), { origin: '0 0', shift: '0 -4px' });
  assert.deepEqual(popoverOpeningStyle({}), popoverOpeningStyle({ beside: false, opensLeftward: false, opensUpward: false }));
});

test('the object menu writes its own opening style, down or up, (#3223)', testContext => {
  const { root } = mountStudio(testContext);
  const objectPopover = root.querySelector('#crucible-studio-pop-object');
  const heroRow = root.querySelectorAll('.crucible-studio-tree-row').find(row => row.textContent.includes('hero'));
  const viewport = heroRow.querySelector('.crucible-studio-tree-select');
  dispatch(viewport, 'contextmenu', { clientX: 300, clientY: 200 });
  assert.equal(objectPopover.popoverOpen, true, 'the context menu opened the object menu');
  assert.equal(objectPopover.style.getPropertyValue('--studio-popover-origin'), '0 0');
  assert.equal(objectPopover.style.getPropertyValue('--studio-popover-shift'), '0 -4px');
  dispatch(viewport, 'contextmenu', { clientX: 300, clientY: 700 });
  assert.equal(objectPopover.style.getPropertyValue('--studio-popover-origin'), '0 100%', 'in the lower half it hangs from the pointer and grows upward');
  assert.equal(objectPopover.style.getPropertyValue('--studio-popover-shift'), '0 4px');
});

test('every popover is a descendant of the Studio root, and the menubar menus of the menubar, where the CSS selectors look (#3223)', testContext => {
  const { root } = mountStudio(testContext);
  const popovers = root.descendants().filter(element => element.getAttribute('popover') !== null);
  assert.ok(popovers.length >= 7, `found ${popovers.length} popovers`);
  const menubar = root.querySelector('.crucible-studio-menubar');
  for (const popover of popovers) {
    assert.ok(String(popover.className).split(/\s+/).includes('crucible-studio-popover'), `${popover.id || popover.className} carries the popover class`);
    let ancestor = popover.parentNode;
    let insideRoot = false;
    while (ancestor) {
      insideRoot ||= ancestor === root;
      ancestor = ancestor.parentNode;
    }
    assert.ok(insideRoot, `${popover.id || popover.className} sits under the root`);
  }
  for (const id of ['new', 'edit', 'view', 'sync', 'help']) {
    assert.equal(root.querySelector(`#crucible-studio-pop-${id}`).parentNode, menubar, `${id} is a child of the menubar`);
  }
});
