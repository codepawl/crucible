import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { revealStudio, showStudioLoadingFailure, waitForNextPaint } from '../src/studio-boot.js';
import { STUDIO_PREFERENCES_KEY } from '../src/studio-preferences.js';

const PAGE_HTML = await readFile(new URL('../bench/studio/index.html', import.meta.url), 'utf8');

// A page with a loading element, and a frame clock the test advances by hand.
function createFakePage() {
  const events = [];
  const pendingFrames = [];
  const messageElement = { textContent: '' };
  const loadingElement = {
    dataset: {},
    remove() {
      events.push('loading removed');
    },
    querySelector: selector => (selector === '[data-loading-message]' ? messageElement : null),
  };
  const documentReference = {
    documentElement: {
      removeAttribute(name) {
        events.push(`root ${name} removed`);
      },
    },
    getElementById: id => (id === 'studio-loading' ? loadingElement : null),
  };
  const studio = {
    ready: Promise.resolve(),
    setupDone: false,
    openSetup() {
      events.push('setup opened');
    },
  };
  function requestFrame(callback) {
    pendingFrames.push(callback);
  }
  function paintOneFrame() {
    events.push('frame painted');
    pendingFrames.splice(0).forEach(callback => callback());
  }
  return { events, studio, documentReference, loadingElement, messageElement, requestFrame, paintOneFrame };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('waitForNextPaint resolves only after the browser has painted a frame', async () => {
  const page = createFakePage();
  let resolved = false;
  waitForNextPaint(page.requestFrame).then(() => {
    resolved = true;
  });
  await settle();
  assert.equal(resolved, false);
  page.paintOneFrame();
  await settle();
  assert.equal(resolved, false, 'the callback of the first frame runs before that frame is on screen');
  page.paintOneFrame();
  await settle();
  assert.equal(resolved, true);
});

test('the setup opens only after a frame of the app has painted and the loading state is gone', async () => {
  const page = createFakePage();
  const revealed = revealStudio({ studio: page.studio, setupParameter: null, documentReference: page.documentReference, requestFrame: page.requestFrame });
  await settle();
  assert.deepEqual(page.events, [], 'nothing is removed or opened before the app has drawn');
  page.paintOneFrame();
  await settle();
  page.paintOneFrame();
  await revealed;
  assert.deepEqual(page.events, ['frame painted', 'frame painted', 'loading removed', 'root data-theme removed', 'setup opened']);
});

test('the loading state stays while Studio is not ready', async () => {
  const page = createFakePage();
  let finishReady;
  page.studio.ready = new Promise(resolve => {
    finishReady = resolve;
  });
  revealStudio({ studio: page.studio, setupParameter: null, documentReference: page.documentReference, requestFrame: page.requestFrame });
  page.paintOneFrame();
  page.paintOneFrame();
  await settle();
  assert.deepEqual(page.events, ['frame painted', 'frame painted']);
  finishReady();
  await settle();
  page.paintOneFrame();
  page.paintOneFrame();
  await settle();
  assert.ok(page.events.includes('loading removed'));
});

test('setup=off and a finished setup never open the dialog, and the loading state still goes', async () => {
  for (const variant of [{ setupParameter: 'off', setupDone: false }, { setupParameter: null, setupDone: true }]) {
    const page = createFakePage();
    page.studio.setupDone = variant.setupDone;
    const revealed = revealStudio({ studio: page.studio, setupParameter: variant.setupParameter, documentReference: page.documentReference, requestFrame: page.requestFrame });
    await settle();
    page.paintOneFrame();
    await settle();
    page.paintOneFrame();
    await revealed;
    assert.ok(page.events.includes('loading removed'));
    assert.ok(!page.events.includes('setup opened'));
  }
});

test('a failed boot turns the loading element into an error that shows the message as text', () => {
  const page = createFakePage();
  showStudioLoadingFailure(page.documentReference, new Error('scene.json did not load (HTTP 404).'));
  assert.equal(page.loadingElement.dataset.state, 'error');
  assert.equal(page.messageElement.textContent, 'scene.json did not load (HTTP 404).');
});

test('the page HTML paints the theme and the loading state before any module script runs', () => {
  const moduleScript = PAGE_HTML.indexOf('<script type="module"');
  const tokens = PAGE_HTML.indexOf('href="../../src/site-tokens.css"');
  const themeScript = PAGE_HTML.indexOf('document.documentElement.dataset.theme');
  const loading = PAGE_HTML.indexOf('id="studio-loading"');
  assert.ok(tokens > -1 && tokens < moduleScript, 'the token stylesheet is a link in the HTML, not an import of the module');
  assert.ok(themeScript > tokens && themeScript < moduleScript, 'the saved theme is applied by an inline script');
  assert.ok(loading > -1 && loading < moduleScript, 'the loading element is in the HTML');
  assert.ok(PAGE_HTML.includes(`localStorage.getItem('${STUDIO_PREFERENCES_KEY}')`), 'the inline script reads the key Studio saves its theme under');
  assert.match(PAGE_HTML, /background: var\(--site-bg\)/);
  assert.match(PAGE_HTML, /role="status"/);
  assert.match(PAGE_HTML, /[.]progress [{][^}]*background: color-mix[(]in srgb, var[(]--site-text[)] 22%, transparent[)]/, 'the track is the text token at 22 percent, which stays visible on the paper and on the dark background');
  assert.match(PAGE_HTML, /[.]progress::after [{][^}]*background: var[(]--site-focus[)]/, 'the moving segment is the accent token of each theme');
  assert.match(PAGE_HTML, /prefers-reduced-motion: no-preference/);
  assert.match(PAGE_HTML, /data-loading-message/);
  assert.match(PAGE_HTML, /<svg viewBox="0 0 24 24"[^>]*>[\s\S]*<\/svg>\s*<span data-loading-message>/, 'the failure leads with an icon');
});

test('the page script no longer imports the token stylesheet or opens the setup by itself', async () => {
  const pageScript = await readFile(new URL('../bench/studio/main.js', import.meta.url), 'utf8');
  assert.ok(!pageScript.includes("site-tokens.css'"));
  assert.ok(!pageScript.includes('studio.openSetup()'));
  assert.ok(pageScript.includes('revealStudio'));
});
