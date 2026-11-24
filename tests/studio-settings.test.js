import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_PREFERENCE_DEFAULTS, normalizeStudioPreferences } from '../src/studio-preferences.js';
import { STUDIO_SETTING_SECTIONS } from '../src/studio-settings.js';
import { createAccountSection, resolveAccountHost } from '../src/studio-account.js';
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
  const settingsDialog = root.querySelector('.crucible-studio-settings-dialog');
  return {
    dom,
    studio,
    root,
    settingsDialog,
    canvas: viewport.querySelector('canvas'),
    controller: studio.controller,
    control: name => settingsDialog.descendants().find(element => element.dataset?.setting === name),
    sectionButtons: () => settingsDialog.querySelectorAll('.crucible-studio-settings-section'),
    pane: id => settingsDialog.querySelectorAll('.crucible-studio-settings-pane').find(pane => pane.dataset.section === id),
    account: () => settingsDialog.querySelector('.crucible-studio-account'),
    accountButtons: () => (settingsDialog.querySelector('.crucible-studio-account-actions')?.querySelectorAll('button') ?? []).map(button => button.textContent),
    accountButton: label => settingsDialog.querySelectorAll('.crucible-studio-account button').find(button => button.textContent === label),
  };
}

function withShell(testContext, shell) {
  globalThis.crucibleShell = shell;
  testContext.after(() => { delete globalThis.crucibleShell; });
}

const FULL_REPORT = { signedIn: true, name: 'Sample Person', email: 'sample.person@example.com', remainingText: '1,240 credits left', planText: 'Studio plan' };

test('Settings groups its rows into titled sections that each have an icon, and shows one section at a time (#3310)', testContext => {
  const ui = mountStudio(testContext);
  const titles = ui.sectionButtons().map(button => button.querySelector('span').textContent);
  assert.deepEqual(titles, ['Interface', 'Viewport', 'Editing', 'Keys'], 'no Account section without a host');
  for (const button of ui.sectionButtons()) {
    assert.ok(button.querySelector('svg'), `${button.dataset.section} has an icon in the list`);
    assert.ok(ui.pane(button.dataset.section).querySelector('h3 svg'), `${button.dataset.section} has an icon at its title`);
  }
  const rowsOf = id => ui.pane(id).descendants().filter(element => element.dataset?.setting).map(element => element.dataset.setting);
  assert.deepEqual(rowsOf('interface'), ['theme', 'startWorkspace', 'panelsFloating', 'motion']);
  assert.deepEqual(rowsOf('viewport'), ['performance', 'gridVisible', 'readoutVisible', 'viewWidgetVisible', 'agentCursorVisible', 'gizmoSize', 'zoomDirection']);
  assert.deepEqual(rowsOf('editing'), ['moveSnapStep', 'rotateSnapDegrees']);
  assert.deepEqual(rowsOf('keys'), ['keymap']);
  const shownRows = STUDIO_SETTING_SECTIONS.flatMap(section => section.rows.map(row => row[0]));
  assert.equal(new Set(shownRows).size, shownRows.length, 'a preference sits in one section only');
  assert.equal(ui.account(), null);
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-settings-section').some(button => button.dataset.section === 'account'), false);

  assert.equal(ui.pane('interface').dataset.current, 'true');
  assert.equal(ui.pane('viewport').dataset.current, 'false');
  ui.sectionButtons().find(button => button.dataset.section === 'viewport').click();
  assert.equal(ui.pane('interface').dataset.current, 'false');
  assert.equal(ui.pane('viewport').dataset.current, 'true');
  assert.equal(ui.sectionButtons().find(button => button.dataset.section === 'viewport').getAttribute('aria-current'), 'true');
});

test('Run setup again closes Settings and opens the first-run setup, and Keys can open the shortcuts list (#3310)', testContext => {
  const ui = mountStudio(testContext);
  ui.settingsDialog.showModal();
  ui.settingsDialog.querySelectorAll('button').find(button => button.textContent === 'Run setup again').click();
  assert.equal(ui.settingsDialog.open, false);
  assert.equal(ui.root.querySelector('.crucible-studio-setup-dialog').open, true);
  ui.settingsDialog.showModal();
  ui.settingsDialog.querySelectorAll('button').find(button => button.textContent === 'Show').click();
  assert.equal(ui.settingsDialog.open, false);
  assert.equal(ui.root.querySelector('.crucible-studio-shortcuts-dialog').open, true);
});

test('Reset in a sectioned Settings returns every preference, the new ones too, and keeps setupDone (#3310)', testContext => {
  const saved = new Map();
  const ui = mountStudio(testContext, { preferenceStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  ui.control('motion').value = 'reduced';
  dispatch(ui.control('motion'), 'change');
  ui.control('zoomDirection').value = 'inverted';
  dispatch(ui.control('zoomDirection'), 'change');
  assert.equal(JSON.parse(saved.get('crucible-studio-preferences')).motion, 'reduced');
  ui.settingsDialog.querySelectorAll('button').find(button => button.textContent === 'Reset').click();
  const stored = JSON.parse(saved.get('crucible-studio-preferences'));
  assert.equal(stored.motion, 'system');
  assert.equal(stored.zoomDirection, 'normal');
  assert.equal(ui.control('motion').value, 'system');
  assert.equal(ui.root.dataset.motion, 'system');
});

test('the Zoom direction preference inverts the wheel and pinch zoom, is saved and reset (#3310)', testContext => {
  const ui = mountStudio(testContext);
  const distance = () => Math.hypot(...ui.controller.scene.camera.eye.map((value, index) => value - ui.controller.scene.camera.target[index]));
  let before = distance();
  dispatch(ui.canvas, 'wheel', { deltaY: 100 });
  assert.ok(distance() > before, 'normal: scrolling down moves the camera away');
  ui.control('zoomDirection').value = 'inverted';
  dispatch(ui.control('zoomDirection'), 'change');
  before = distance();
  dispatch(ui.canvas, 'wheel', { deltaY: 100 });
  assert.ok(distance() < before, 'inverted: scrolling down brings the camera closer');
  before = distance();
  dispatch(ui.canvas, 'wheel', { deltaY: -100, ctrlKey: true });
  assert.ok(distance() > before, 'a pinch (a wheel with Ctrl) follows the same direction');
  assert.equal(ui.studio.preferences.zoomDirection, 'inverted');
});

test('the Motion preference set to Reduced makes the view jump instead of fly, whatever the system says (#3310)', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.orbitCamera({ zoomScale: 6 });
  const goal = ui.controller.frameSelectionPose();
  const distanceToGoal = () => Math.hypot(...ui.controller.scene.camera.eye.map((value, axis) => value - goal.eye[axis]));
  dispatch(ui.dom.document, 'keydown', { key: 'f' });
  assert.ok(distanceToGoal() > 0.01, 'following the system, with no reduced-motion request, the view flies');
  ui.dom.runAnimationFrames(1000);
  ui.dom.runAnimationFrames(2000);
  ui.controller.orbitCamera({ zoomScale: 6 });
  ui.control('motion').value = 'reduced';
  dispatch(ui.control('motion'), 'change');
  assert.equal(ui.root.dataset.motion, 'reduced');
  dispatch(ui.dom.document, 'keydown', { key: 'f' });
  assert.ok(distanceToGoal() < 1e-6, 'with Reduced the view jumps');
});

test('motion and zoom direction are normalised: an unknown value falls back to the default (#3310)', () => {
  const normalised = normalizeStudioPreferences({ motion: 'full', zoomDirection: 'up', moveSnapStep: 1 });
  assert.equal(normalised.motion, STUDIO_PREFERENCE_DEFAULTS.motion);
  assert.equal(normalised.zoomDirection, STUDIO_PREFERENCE_DEFAULTS.zoomDirection);
  assert.equal(normalised.moveSnapStep, 1);
  assert.equal(normalizeStudioPreferences({ motion: 'reduced', zoomDirection: 'inverted' }).motion, 'reduced');
});

test('without a host account there is no Account section and no function reads one (#3310)', () => {
  assert.equal(resolveAccountHost(undefined), null);
  assert.equal(resolveAccountHost({}), null);
  assert.equal(resolveAccountHost({ account: { signIn() {} } }), null, 'an account without get() is not one');
  assert.equal(createAccountSection({ documentReference: {}, createElement() {}, createIcon() {}, shell: {} }), null);
});

test('Account shows the signed-out state with one Sign in action, a waiting state and the error when it rejects (#3310)', async testContext => {
  let rejectSignIn;
  let finishSignIn;
  let signInCalls = 0;
  withShell(testContext, {
    account: {
      get: async () => ({ signedIn: false }),
      signIn: () => {
        signInCalls += 1;
        return new Promise((resolve, reject) => {
          finishSignIn = resolve;
          rejectSignIn = reject;
        });
      },
    },
  });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  assert.ok(ui.sectionButtons().some(button => button.dataset.section === 'account'));
  assert.equal(ui.account().dataset.phase, 'signed-out');
  assert.match(ui.account().textContent, /Signed out/);
  assert.deepEqual(ui.accountButtons(), ['Sign in']);
  ui.accountButton('Sign in').click();
  assert.equal(signInCalls, 1);
  assert.equal(ui.account().dataset.phase, 'waiting');
  assert.equal(ui.accountButton('Waiting').disabled, true);
  rejectSignIn(new Error('The browser window was closed.'));
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-out');
  assert.match(ui.account().querySelector('.crucible-studio-account-error').textContent, /The browser window was closed\./);
  assert.deepEqual(ui.accountButtons(), ['Sign in'], 'it can be tried again');
  ui.accountButton('Sign in').click();
  finishSignIn();
  await ui.dom.settle();
  assert.equal(ui.account().querySelector('.crucible-studio-account-error'), null, 'a new try clears the old error');
});

test('Account shows a signed-in person with every field, and Sign out, Buy more and Manage billing call the host (#3310)', async testContext => {
  const calls = [];
  let report = { ...FULL_REPORT };
  withShell(testContext, {
    account: {
      get: async () => report,
      signIn: async () => calls.push('signIn'),
      signOut: async () => {
        calls.push('signOut');
        report = { signedIn: false };
      },
      buyCredits: () => calls.push('buyCredits'),
      manageBilling: () => calls.push('manageBilling'),
    },
  });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  const text = ui.account().textContent;
  assert.equal(ui.account().dataset.phase, 'signed-in');
  for (const expected of ['Signed in', 'Sample Person', 'sample.person@example.com', 'Left to use', '1,240 credits left', 'Plan', 'Studio plan']) {
    assert.ok(text.includes(expected), `shows ${expected}`);
  }
  assert.equal(ui.account().querySelector('.crucible-studio-account-avatar').textContent, 'S');
  assert.deepEqual(ui.accountButtons(), ['Sign out', 'Buy more', 'Manage billing']);
  assert.notEqual(ui.account().querySelector('.crucible-studio-account-status svg path').getAttribute('d'), undefined);
  ui.accountButton('Buy more').click();
  ui.accountButton('Manage billing').click();
  ui.accountButton('Sign out').click();
  await ui.dom.settle();
  assert.deepEqual(calls, ['buyCredits', 'manageBilling', 'signOut']);
  assert.equal(ui.account().dataset.phase, 'signed-out', 'the account is read again after signing out');
  assert.deepEqual(ui.accountButtons(), ['Sign in']);
});

test('Account with no optional fields shows only what is known, and offers no Buy more or Manage billing without the functions (#3310)', async testContext => {
  withShell(testContext, { account: { get: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} } });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-in');
  assert.equal(ui.account().querySelector('.crucible-studio-account-who'), null);
  assert.equal(ui.account().querySelector('.crucible-studio-setting'), null, 'no empty value rows');
  assert.deepEqual(ui.accountButtons(), ['Sign out']);
  assert.ok(!ui.account().textContent.includes('undefined'));
});

test('Account takes the initial from the email when there is no name, and shows text only as text (#3310)', async testContext => {
  withShell(testContext, { account: { get: async () => ({ signedIn: true, email: 'ada@example.com', name: 42, remainingText: '<b>5 left</b>' }), signIn: async () => {} } });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  assert.equal(ui.account().querySelector('.crucible-studio-account-avatar').textContent, 'A');
  assert.ok(ui.account().textContent.includes('<b>5 left</b>'), 'markup stays text');
  assert.equal(ui.account().querySelector('b'), null);
});

test('the older built-in agent host gets an Account section with its state and sign in only (#3310)', async testContext => {
  let signedIn = false;
  withShell(testContext, { builtInAgent: { isSignedIn: async () => signedIn, signIn: async () => { signedIn = true; return { signedIn: true }; } } });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-out');
  assert.deepEqual(ui.accountButtons(), ['Sign in']);
  ui.accountButton('Sign in').click();
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-in');
  assert.deepEqual(ui.accountButtons(), [], 'no Sign out, Buy more or Manage billing: the old object has none');
});

test('the host announcing a change makes Account read the account again, and a read that fails shows its message (#3310)', async testContext => {
  let report = { signedIn: false };
  let failing = false;
  withShell(testContext, { account: { get: async () => { if (failing) throw new Error('The host could not answer.'); return report; }, signIn: async () => {} } });
  const ui = mountStudio(testContext);
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-out');
  report = { ...FULL_REPORT };
  ui.dom.document.dispatchEvent(ui.dom.document.createEvent('crucible-shell:account-changed'));
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-in');
  failing = true;
  ui.dom.document.dispatchEvent(ui.dom.document.createEvent('crucible-shell:account-changed'));
  await ui.dom.settle();
  assert.equal(ui.account().dataset.phase, 'signed-out');
  assert.match(ui.account().textContent, /The host could not answer\./);
});

test('disposing Studio removes the account listener from the page (#3310)', async testContext => {
  withShell(testContext, { account: { get: async () => ({ signedIn: false }), signIn: async () => {} } });
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer() });
  testContext.after(() => dom.uninstall());
  assert.equal(dom.document.listeners.filter(entry => entry.type === 'crucible-shell:account-changed').length, 1);
  studio.dispose();
  assert.equal(dom.document.listeners.filter(entry => entry.type === 'crucible-shell:account-changed').length, 0);
});
