import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_ACTION_ICONS, STUDIO_ICON_PATHS } from '../src/studio-icons.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

function mountStudio(testContext) {
  globalThis.crucibleShell = { builtInAgent: { isSignedIn: async () => false, signIn: async () => ({ signedIn: true }) } };
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
    delete globalThis.crucibleShell;
  });
  return dom.container.firstElementChild;
}

function buttonsOf(surface) {
  return surface.descendants().filter(element => element.tagName === 'BUTTON');
}

function leadingGlyph(button) {
  const icon = button.querySelector('svg');
  if (!icon) return null;
  assert.equal(button.children[0], icon, `${button.textContent}: the icon comes before the label`);
  assert.equal(icon.getAttribute('aria-hidden'), 'true', `${button.textContent}: the icon is hidden from assistive technology`);
  return icon.querySelector('path').getAttribute('d');
}

function surfaceOf(root, kind) {
  const dialogWith = text => root.querySelectorAll('dialog').find(dialog => buttonsOf(dialog).some(button => button.textContent === text));
  return {
    paused: () => root.querySelector('.crucible-studio-paused'),
    draft: () => root.querySelector('.crucible-studio-draft'),
    recipe: () => dialogWith('Apply JSON'),
    settings: () => root.querySelector('.crucible-studio-settings-dialog'),
    shortcuts: () => root.querySelectorAll('dialog').find(dialog => dialog.className === 'crucible-studio-shortcuts-dialog'),
    setup: () => root.querySelector('.crucible-studio-setup-dialog'),
  }[kind]();
}

// Each surface lists its buttons by label: the icon it leads with, or null for a dismissal or a step through the setup.
const EXPECTED = {
  paused: { Reload: 'reload' },
  draft: { Restore: 'restoreDraft', Discard: 'discardDraft' },
  recipe: { 'Load file…': 'loadFile', Close: null, 'Apply JSON': 'applyJson' },
  settings: { Reset: 'resetSettings', Done: null },
  shortcuts: { Done: null },
  setup: { Skip: null, Back: null, Next: null, Done: null, 'Sign in for the built-in AI': 'signIn', 'Copy an agent prompt': 'copyPrompt' },
};

test('every main action of a notice or dialog leads with its own icon and a dismissal has none', testContext => {
  const root = mountStudio(testContext);
  for (const [kind, buttons] of Object.entries(EXPECTED)) {
    const surface = surfaceOf(root, kind);
    assert.ok(surface, `${kind} is on the page`);
    for (const [label, actionName] of Object.entries(buttons)) {
      const button = buttonsOf(surface).find(candidate => candidate.textContent === label);
      assert.ok(button, `${kind}: ${label} is there, and its text is its accessible name`);
      const glyph = leadingGlyph(button);
      if (actionName === null) {
        assert.equal(glyph, null, `${kind}: ${label} stays text only`);
      } else {
        assert.equal(glyph, STUDIO_ICON_PATHS[STUDIO_ACTION_ICONS[actionName]], `${kind}: ${label} leads with ${STUDIO_ACTION_ICONS[actionName]}`);
      }
    }
  }
});

test('buttons side by side never share an icon, and none repeats the icon of its title', testContext => {
  const root = mountStudio(testContext);
  for (const kind of Object.keys(EXPECTED)) {
    const surface = surfaceOf(root, kind);
    const byParent = new Map();
    for (const button of buttonsOf(surface).filter(candidate => EXPECTED[kind][candidate.textContent])) {
      const glyph = leadingGlyph(button);
      const siblings = byParent.get(button.parentNode) ?? [];
      assert.ok(!siblings.includes(glyph), `${kind}: ${button.textContent} repeats the icon of a button beside it`);
      siblings.push(glyph);
      byParent.set(button.parentNode, siblings);
    }
    const heading = surface.querySelector('h2 svg');
    if (!heading) continue;
    const headingGlyph = heading.querySelector('path').getAttribute('d');
    for (const siblings of byParent.values()) {
      assert.ok(!siblings.includes(headingGlyph), `${kind}: a button repeats the icon of the title`);
    }
  }
});

test('the notice and dialog actions use the 8 pixel gap of the other icon buttons', () => {
  assert.match(STUDIO_CSS, /\.crucible-studio button\[data-action-icon\] \{ gap: 8px; \}/);
});
