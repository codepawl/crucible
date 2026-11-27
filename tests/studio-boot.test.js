import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  creepTargetAfter,
  driftTargetAfter,
  reportStudioLoadingProgress,
  reportStudioModulesLoaded,
  revealStudio,
  showStudioLoadingFailure,
  STUDIO_LOADING_MILESTONES,
  waitForNextPaint,
  waitForStreamLanding,
  windDownStudioLoading,
} from '../src/studio-boot.js';
import { STUDIO_PREFERENCES_KEY } from '../src/studio-preferences.js';

const PAGE_HTML = await readFile(new URL('../bench/studio/index.html', import.meta.url), 'utf8');
const TOKENS_CSS = await readFile(new URL('../src/site-tokens.css', import.meta.url), 'utf8');

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
  assert.match(PAGE_HTML, /[.]progress [{][^}]*background: color-mix[(]in srgb, var[(]--site-text[)] \d+%, transparent[)]/, 'the track is the text token mixed with transparent (its strength is pinned by the contrast test)');
  assert.match(PAGE_HTML, /[.]fill [{][^}]*background: var[(]--site-focus[)]/, 'the fill is the accent token of each theme (it replaced the moving segment of the first loading bar)');
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

// The pour: the pot tips, a curved stream leaves the lip into the bar, sparks hop where it lands and the bar fills. Only transform and opacity animate.
const LOADING_STYLE = PAGE_HTML.slice(PAGE_HTML.indexOf('<style>'), PAGE_HTML.indexOf('</style>'));
const KEYFRAME_BLOCKS = [...LOADING_STYLE.matchAll(/@keyframes (studio-[\w-]+) [{]([^\n]*)/g)];
const COMPOSITOR_PROPERTIES = new Set(['transform', 'opacity', 'animation-timing-function']);

// A loading element with a fill that records the animations started on it. The fill stands where the last one ended.
function createProgressPage() {
  const properties = new Map();
  const state = { fillScale: 0.04, started: [], cancelled: 0 };
  const fillElement = {
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ transform: `matrix(${state.fillScale}, 0, 0, 1, 0, 0)` }) },
    },
    animate(keyframes, options) {
      const scales = keyframes.map(keyframe => Number(/scaleX[(]([\d.]+)/.exec(keyframe.transform)[1]));
      const target = scales[1];
      state.started.push({ from: scales[0], target, driftTarget: scales.at(-1), scales, keyframes, options });
      state.fillScale = target;
      return { cancel: () => (state.cancelled += 1) };
    },
  };
  const loadingElement = {
    dataset: {},
    style: {
      getPropertyValue: name => properties.get(name) ?? '',
      setProperty: (name, value) => properties.set(name, value),
    },
    getAnimations: () => [],
    remove() {},
    querySelector: selector => (selector === '.fill' ? fillElement : null),
  };
  const documentReference = {
    documentElement: { removeAttribute() {} },
    getElementById: id => (id === 'studio-loading' ? loadingElement : null),
  };
  return { loadingElement, documentReference, state, progress: () => Number(properties.get('--progress')) };
}

test('the loading element has a pot, a stream that leaves its lip into the bar, a fill in the bar and four sparks, and no pool', () => {
  assert.match(PAGE_HTML, /<div class="pour">\s*<div class="stream"><div class="flow"><i><\/i><\/div><\/div>\s*<div class="pot">[\s\S]*mark-light[\s\S]*mark-dark[\s\S]*<\/div>\s*<div class="progress"><div class="fill"><\/div><\/div>\s*(?:<i class="spark"><\/i>){4}\s*<\/div>/);
  assert.ok(!/class="(?:pool|ripple|drop)"/.test(PAGE_HTML), 'no pool, ripple or droplets sit under the stream any more');
  assert.ok(!/[.](?:pool|ripple|drop)\b/.test(LOADING_STYLE), 'no style is left for the pool, the ripple or the droplets');
  assert.match(PAGE_HTML, /<img class="mark mark-light" src="\/brand\/crucible-mark[.]svg"/, 'the pot is the brand mark file, not a redrawn copy');
  assert.ok(!PAGE_HTML.includes('class="body"'), 'no copy of the mark artwork sits in the page');
});

test('the stream is one static curved clip, wider at the lip than at the pool, with a flow texture inside it', () => {
  const clip = /[.]flow [{][^}]*clip-path: path[(]"([^"]+)"[)]/.exec(LOADING_STYLE);
  assert.ok(clip, 'the stream shape is a static clip-path');
  const topWidth = /^M(\d+) 0H(\d+)/.exec(clip[1]);
  assert.ok(Number(topWidth[2]) - Number(topWidth[1]) > 4, 'the stream is wide where it leaves the lip');
  assert.match(clip[1], /8 70H4C/, 'it ends square, 4 px wide, with no rounded tip (owner: the round blob looks ugly)');
  assert.ok(!/Q/.test(clip[1]), 'no curve is left at its end');
  assert.match(LOADING_STYLE, /[.]flow i [{][^}]*repeating-linear-gradient[(]transparent 0, color-mix[(]in srgb, var[(]--site-text[)] 24%, transparent[)] 4px, transparent 8px, color-mix[(]in srgb, var[(]--site-bg[)] 30%, transparent[)] 11px, transparent 14px[)],\s*var[(]--site-focus[)]/, 'soft lighter and deeper bands made of tokens over the molten colour');
  assert.match(LOADING_STYLE, /studio-stream-flow 0[.]7s linear infinite/);
  assert.match(LOADING_STYLE, /@keyframes studio-stream-flow [{] to [{] transform: translateY[(]14px[)]; [}] [}]/, 'the flow moves by exactly one band period of 14 px, so the loop is seamless');
  assert.match(LOADING_STYLE, /studio-stream-sway 2[.]2s ease-in-out infinite alternate/);
});

test('the stream ends sunk into the bar, over the start of the fill, with no pool between them', () => {
  const rule = selector => new RegExp(`${selector} [{]([^}]*)[}]`).exec(LOADING_STYLE)[1];
  const lengthOf = (body, property) => Number(new RegExp(`(?:^|\\s)${property}: (-?[\\d.]+)(?:px)?;`).exec(body)[1]);
  const bar = rule('#studio-loading [.]progress');
  const stream = rule('#studio-loading [.]stream');
  assert.match(LOADING_STYLE, /clip-path: path[(]"[^"]*8 70H4C/, 'the clip ends square where the box ends');
  const streamBottom = lengthOf(stream, 'top') + lengthOf(stream, 'height');
  assert.equal(streamBottom, lengthOf(bar, 'top') + 2, 'the stream ends 2 px inside the bar, so there is no gap');
  assert.ok(streamBottom < lengthOf(bar, 'top') + lengthOf(bar, 'height'), 'and it stops inside the bar height');
  const landingX = lengthOf(stream, 'left') + 6;
  assert.ok(landingX >= lengthOf(bar, 'left') && landingX <= lengthOf(bar, 'left') + 4, 'the stream lands at the left end of the bar, where the fill starts');
  assert.equal(lengthOf(bar, 'left') + lengthOf(bar, 'width'), 120, 'the bar still ends at the right edge of the group');
  assert.ok(Number(/z-index: (\d+);/.exec(stream)[1]) < Number(/z-index: (\d+);/.exec(bar)[1]), 'the bar is drawn over the stream, so the square end is hidden inside the fill and no cap shows');
  assert.ok(Number(/z-index: (\d+);/.exec(rule('#studio-loading [.]spark'))[1]) > Number(/z-index: (\d+);/.exec(bar)[1]), 'the sparks are drawn over the bar');
});

test('four sparks are thrown up where the stream lands, short, out of step with each other, and animate only transform and opacity', () => {
  const rule = selector => new RegExp(`${selector} [{]([^}]*)[}]`).exec(LOADING_STYLE)[1];
  const lengthOf = (body, property) => Number(new RegExp(`(?:^|\\s)${property}: (-?[\\d.]+)(?:px)?;`).exec(body)[1]);
  const spark = rule('#studio-loading [.]spark');
  const stream = rule('#studio-loading [.]stream');
  const bar = rule('#studio-loading [.]progress');
  const landingX = lengthOf(stream, 'left') + 6;
  assert.equal(lengthOf(spark, 'left') + lengthOf(spark, 'width') / 2, landingX, 'the sparks start at the stream end');
  assert.ok(Math.abs(lengthOf(spark, 'top') + lengthOf(spark, 'height') - lengthOf(bar, 'top')) <= 1, 'and on the bar surface');
  assert.ok(lengthOf(spark, 'width') <= 3, 'a spark is small');
  assert.match(spark, /opacity: 0;/, 'a spark is hidden until its animation shows it');
  assert.match(spark, /var[(]--site-focus[)]/, 'a spark is the lava token');
  const block = KEYFRAME_BLOCKS.find(([, name]) => name === 'studio-spark')[2];
  const lastVisible = [...block.matchAll(/(\d+)% [{] opacity: 1;/g)].map(match => Number(match[1])).at(-1);
  const gone = Number(/(\d+)% [{] opacity: 0; transform: translate[(]var[(]--dx[)], 2px[)]; [}]/.exec(block)[1]);
  assert.ok(gone > lastVisible, 'it fades out before the loop restarts');
  const motionBlock = LOADING_STYLE.slice(LOADING_STYLE.indexOf('@media (prefers-reduced-motion: no-preference) {'));
  const base = /studio-spark ([\d.]+)s linear infinite/.exec(motionBlock);
  const durations = [];
  const delays = [];
  for (let index = 1; index <= 4; index += 1) {
    const sparkRule = new RegExp(`[.]spark:nth-of-type\\(${index}\\) [{]([^}]*)[}]`).exec(motionBlock)[1];
    durations.push(Number(/animation-duration: ([\d.]+)s/.exec(sparkRule)?.[1] ?? base[1]));
    delays.push(Number(/animation-delay: ([\d.]+)s/.exec(sparkRule)[1]));
    assert.ok(Math.abs(Number(/--dx: (-?\d+)px/.exec(sparkRule)[1])) <= 12 && Number(/--rise: (\d+)px/.exec(sparkRule)[1]) <= 10, 'the arcs are small');
  }
  assert.equal(new Set(durations).size, 4, 'each spark has its own period, so the loop never repeats in step');
  assert.equal(new Set(delays).size, 4);
  assert.ok(Math.min(...delays) >= 0.8, 'no spark starts before the stream has arrived');
  for (const duration of durations) {
    assert.ok((duration * gone) / 100 < 0.5, `a spark is visible for ${(duration * gone) / 100} s, under half a second`);
  }
  assert.match(motionBlock, /data-state="done"\] [.]spark [{] visibility: hidden; [}]/, 'the sparks are hidden once the stream starts to leave the bar');
  const hideDelay = Number(/transition: visibility 0s linear ([\d.]+)s/.exec(spark)[1]);
  const streamLeavesAt = Number(/studio-stream-out [\d.]+s ease-in ([\d.]+)s/.exec(motionBlock)[1]);
  assert.equal(hideDelay, streamLeavesAt, 'the sparks go in the frame the stream starts to shorten, and not before the bar is full');
  assert.match(LOADING_STYLE, /data-state="error"\] :is[(][.]stream, [.]spark, [.]progress[)] [{] display: none; [}]/);
});

test('the whole group is scaled up by one transform and still fits a 360 px window', () => {
  const group = /#studio-loading [.]pour [{][^}]*width: (\d+)px;[^}]*transform: translateX[(](\d+)px[)] scale[(]([\d.]+)[)]/.exec(LOADING_STYLE);
  assert.ok(group, 'one transform on the group sets its size and optical position');
  const [, barWidth, shift, scale] = group.map(Number);
  const potLeft = Number(/[.]pot [{][^}]*left: (-\d+)px/.exec(LOADING_STYLE)[1]);
  const windowWidth = 360;
  const origin = windowWidth / 2 + shift;
  const leftEdge = origin + (potLeft - barWidth / 2) * scale;
  const rightEdge = origin + (barWidth - barWidth / 2) * scale;
  assert.ok(leftEdge >= 0 && rightEdge <= windowWidth, `the group spans ${leftEdge} to ${rightEdge} of ${windowWidth}`);
  assert.equal(scale, 1.1, 'the loader stays small beside the editor it opens');
});

test('what the eye sees of the pour sits in the middle of the window', () => {
  const [, boxWidth, shift, scale] = /#studio-loading [.]pour [{][^}]*width: (\d+)px;[^}]*transform: translateX[(](\d+)px[)] scale[(]([\d.]+)[)]/.exec(LOADING_STYLE).map(Number);
  // Measured from a screenshot: the tipped pot's drawing starts at x = -59 of the group and the bar ends at x = 120.
  const drawnLeft = -59;
  const drawnRight = boxWidth;
  const drawnMiddleOffset = ((drawnLeft + drawnRight) / 2 - boxWidth / 2) * scale + shift;
  assert.ok(Math.abs(drawnMiddleOffset) <= 1, `the drawn group's middle is ${drawnMiddleOffset.toFixed(1)} px from the window middle`);
});

test('the pour animates only transform and opacity, with the fill moved by script and no transition', () => {
  assert.ok(KEYFRAME_BLOCKS.length >= 9, 'tilt, right, stream, sway, flow, spark, fade and fill keyframes exist');
  for (const [, name, body] of KEYFRAME_BLOCKS) {
    const properties = [...body.matchAll(/([\w-]+): [^;]+;/g)].map(match => match[1]);
    assert.ok(properties.length > 0, name);
    for (const property of properties) {
      assert.ok(COMPOSITOR_PROPERTIES.has(property), `${name} animates ${property}`);
    }
  }
  assert.deepEqual(LOADING_STYLE.match(/(?<![-\w])transition: [^;]+;/g), ['transition: visibility 0s linear 0.09s;'], 'the only transition is the spark switch-off, which moves nothing: script and keyframes move everything else');
  assert.match(LOADING_STYLE, /[.]fill [{][^}]*transform: scaleX[(]var[(]--progress/);
  assert.ok(!/will-change|<animate/.test(PAGE_HTML), 'no will-change and no SMIL');
  const clipPaths = LOADING_STYLE.match(/clip-path/g);
  assert.equal(clipPaths.length, 1, 'one static clip, never animated');
});

test('with reduced motion the pot and stream stand still, the fill still moves and the loader still fades', () => {
  const motionStart = LOADING_STYLE.indexOf('@media (prefers-reduced-motion: no-preference) {');
  const motionBlock = LOADING_STYLE.slice(motionStart, LOADING_STYLE.indexOf('@keyframes', motionStart));
  const outsideMotionBlock = LOADING_STYLE.replace(motionBlock, '');
  const animationsOutside = [...outsideMotionBlock.matchAll(/(?<![-\w])animation: ([^;]+);/g)].map(match => match[1].split(' ')[0]);
  assert.deepEqual(animationsOutside, ['studio-fill-creep', 'studio-loader-fade', 'none'], 'only the fill, the closing fade and the error reset run without the no-preference query');
  for (const name of ['pot-tilt', 'stream-in', 'stream-sway', 'stream-flow', 'spark']) {
    assert.ok(motionBlock.includes(`studio-${name}`), `${name} is inside the no-preference query`);
  }
  for (const selector of ['stream', 'spark']) {
    assert.match(LOADING_STYLE, new RegExp(`[.]${selector} [{][^}]*opacity: 0;`), `the ${selector} is hidden until its animation shows it`);
  }
  assert.match(motionBlock, /data-state="done"\] [{] animation-delay: 0[.]27s; animation-duration: 0[.]1s; [}]/);
  assert.match(LOADING_STYLE, /data-state="done"\] [{] animation: studio-loader-fade 0[.]15s ease-out 0[.]15s both; pointer-events: none; [}]/, 'the hold is shorter with reduced motion');
});

test('the pour uses only the brand tokens, with no colour of its own', () => {
  const pourRules = LOADING_STYLE.slice(LOADING_STYLE.indexOf('.stream {'), LOADING_STYLE.indexOf('@keyframes'));
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(pourRules));
  assert.match(pourRules, /var[(]--site-focus[)]/);
});

test('progress moves forward through each milestone and never reaches full before Studio is ready', () => {
  const page = createProgressPage();
  const values = [];
  for (const value of Object.values(STUDIO_LOADING_MILESTONES)) {
    reportStudioLoadingProgress(page.documentReference, value);
    values.push(page.progress());
  }
  assert.deepEqual(values, Object.values(STUDIO_LOADING_MILESTONES));
  assert.deepEqual([...values].sort((first, second) => first - second), values, 'the milestones rise');
  reportStudioLoadingProgress(page.documentReference, 0.2);
  assert.equal(page.progress(), values.at(-1), 'a lower report never moves the fill back');
  reportStudioLoadingProgress(page.documentReference, 1);
  assert.ok(page.progress() < 1, 'the report call cannot fill the bar');
});

test('between milestones the fill keeps creeping toward a point short of the next one', () => {
  const page = createProgressPage();
  const milestones = Object.values(STUDIO_LOADING_MILESTONES);
  milestones.forEach(value => reportStudioLoadingProgress(page.documentReference, value));
  assert.equal(page.state.started.length, milestones.length, 'each milestone starts one creep');
  assert.equal(page.state.cancelled, milestones.length - 1, 'a new creep replaces the one before it');
  page.state.started.forEach((creep, index) => {
    const nextMilestone = milestones[index + 1] ?? 1;
    assert.ok(creep.options.duration >= 30000, 'a long run, so the fill is still moving after ten seconds');
    assert.match(creep.keyframes[0].easing, /^cubic-bezier/);
    assert.ok(creep.target > milestones[index], 'it heads past the milestone just reached');
    assert.ok(creep.target < nextMilestone, 'it never arrives at the next milestone');
    assert.ok(creep.target <= 0.97, 'it never reaches full');
    assert.ok(creep.target >= creep.from, 'it never moves backward');
    assert.equal(creepTargetAfter(milestones[index]), creep.target);
  });
  const targets = page.state.started.map(creep => creep.target);
  assert.deepEqual([...targets].sort((first, second) => first - second), targets, 'the targets rise');
  assert.ok(creepTargetAfter(0.97) <= 0.97 && creepTargetAfter(2) <= 0.97, 'past the last step the cap holds');
});

test('a fill that has already crept past a lower target keeps its place', () => {
  const page = createProgressPage();
  page.state.fillScale = 0.6;
  reportStudioLoadingProgress(page.documentReference, STUDIO_LOADING_MILESTONES.modulesLoaded);
  assert.equal(page.state.started[0].from, 0.6);
  assert.equal(page.state.started[0].target, 0.6, 'the target is never below where the fill stands');
});

test('the bar fills in 200 ms only after Studio is ready, and the pour winds down with it', async () => {
  const page = createProgressPage();
  let finishReady;
  const studio = { ready: new Promise(resolve => (finishReady = resolve)), setupDone: true, openSetup() {} };
  const frames = [];
  const revealed = revealStudio({ studio, setupParameter: null, documentReference: page.documentReference, requestFrame: callback => frames.push(callback) });
  reportStudioLoadingProgress(page.documentReference, STUDIO_LOADING_MILESTONES.studioCreated);
  await settle();
  assert.ok(page.progress() < 1);
  assert.ok(page.state.started.every(run => run.target < 1), 'no run reaches full before ready');
  assert.equal(page.loadingElement.dataset.state, undefined);
  finishReady();
  await settle();
  assert.equal(page.progress(), 1);
  const completion = page.state.started.at(-1);
  assert.equal(completion.target, 1);
  assert.equal(completion.options.duration, 90, 'the bar completes in 90 ms, while the stream still pours');
  assert.equal(page.loadingElement.dataset.state, 'done', 'the stream and pot wind down as the bar fills');
  while (frames.length > 0) {
    frames.splice(0).forEach(callback => callback());
    await settle();
  }
  await revealed;
});

test('the wind-down waits for the animations of the closing sequence and not for the creep or the stream flow', async () => {
  const page = createProgressPage();
  let finished = false;
  const animationEnding = (endTime, finish) => ({ effect: { getComputedTiming: () => ({ endTime }) }, finished: finish });
  const closingFade = animationEnding(780, new Promise(resolve => {
    setTimeout(() => {
      finished = true;
      resolve();
    }, 20);
  }));
  const neverEnding = new Promise(() => {});
  page.loadingElement.getAnimations = () => [closingFade, animationEnding(Infinity, neverEnding), animationEnding(30000, neverEnding)];
  await windDownStudioLoading(page.documentReference);
  assert.equal(finished, true);
});

test('the page script reports every milestone, in rising order, at the step it names', async () => {
  const pageScript = await readFile(new URL('../bench/studio/main.js', import.meta.url), 'utf8');
  const reported = [...pageScript.matchAll(/reportProgress\('(\w+)'\)/g)].map(match => match[1]);
  assert.deepEqual(reported, Object.keys(STUDIO_LOADING_MILESTONES));
  const position = name => pageScript.indexOf(`reportProgress('${name}')`);
  assert.ok(position('modulesLoaded') < pageScript.indexOf('await loadAllAgentSceneModules('));
  assert.ok(position('sceneModulesLoaded') > pageScript.indexOf('await loadAllAgentSceneModules('));
  assert.ok(position('studioCreated') > pageScript.indexOf('createStudio(root'));
  assert.ok(position('sceneFileLoaded') > pageScript.indexOf('await studio.loadExternalTextFile'));
});

test('the closing sequence runs fill, stream, pot, fade in that order, adds at most 0.4 s, and passes input through from the moment of ready', () => {
  const motionBlock = LOADING_STYLE.slice(LOADING_STYLE.indexOf('@media (prefers-reduced-motion: no-preference) {'));
  const timing = pattern => {
    const match = pattern.exec(motionBlock);
    return { duration: Number(match[1]), delay: Number(match[2]) };
  };
  const stream = timing(/studio-stream-out ([\d.]+)s ease-in ([\d.]+)s/);
  const pot = timing(/studio-pot-right ([\d.]+)s var[(]--site-ease-out[)] ([\d.]+)s/);
  const fade = /data-state="done"\] [{] animation-delay: ([\d.]+)s; animation-duration: ([\d.]+)s/.exec(motionBlock);
  const fadeDelay = Number(fade[1]);
  const fadeDuration = Number(fade[2]);
  const fillSeconds = 0.09;
  assert.ok(stream.delay >= fillSeconds, 'the stream keeps pouring until the fill is complete');
  assert.ok(pot.delay >= stream.delay + stream.duration, 'the pot rights itself after the stream is back in the lip');
  assert.ok(fadeDelay >= pot.delay + pot.duration, 'the contents fade after the pot is upright');
  assert.ok(fadeDelay + fadeDuration <= 0.4, 'the added wait with motion is 0.4 s at most');
  const fadeDelayReduced = Number(/studio-loader-fade [\d.]+s ease-out ([\d.]+)s/.exec(LOADING_STYLE)[1]);
  assert.ok(fadeDelayReduced + 0.15 <= 0.3, 'the added wait with reduced motion is 0.3 s at most');
  assert.match(LOADING_STYLE, /data-state="done"\] [{][^}]*pointer-events: none/, 'the app underneath takes input at once');
});

test('the fade never thins the opaque panel: the panel sits under the loading state and goes with it in the same frame', () => {
  const panelRule = /body:has[(]#studio-loading[)]::before [{]([^}]*)[}]/.exec(LOADING_STYLE);
  assert.ok(panelRule, 'the panel is drawn by the page while the loading element exists');
  assert.match(panelRule[1], /position: fixed; ?\s*inset: 0/s, 'it covers the whole window');
  assert.match(panelRule[1], /background: var[(]--site-bg[)]/, 'it is the theme background token');
  const zIndex = index => Number(new RegExp(index + '[^}]*z-index: (\\d+)', 's').exec(LOADING_STYLE)?.[1]);
  assert.ok(zIndex('body:has') < zIndex('#studio-loading [{]'), 'the loading content stays above the panel');
  const loadingRule = /#studio-loading [{]([^}]*)[}]/.exec(LOADING_STYLE)[1];
  assert.doesNotMatch(loadingRule, /background/, 'the faded element has no background of its own, so the fade shows the panel and never the app');
});

test('past the long ease the fill drifts on, slowly and linearly, and stays below the next step', () => {
  const page = createProgressPage();
  const milestones = Object.values(STUDIO_LOADING_MILESTONES);
  milestones.forEach(value => reportStudioLoadingProgress(page.documentReference, value));
  page.state.started.forEach((creep, index) => {
    const nextMilestone = milestones[index + 1] ?? 1;
    assert.equal(creep.options.duration, 150000, 'thirty seconds of ease and two minutes of drift');
    assert.equal(creep.keyframes[1].offset, 0.2, 'the ease takes the first fifth');
    assert.equal(creep.keyframes[1].easing, 'linear', 'the drift after it is linear');
    assert.ok(creep.driftTarget >= creep.target, 'the drift never goes back');
    assert.ok(creep.driftTarget > creep.target || creep.target === 0.97, 'the drift keeps the fill moving after the ease, unless the cap is already reached');
    assert.ok(creep.driftTarget < nextMilestone, 'the drift never arrives at the next step');
    assert.ok(creep.driftTarget <= 0.97, 'the drift never reaches full');
    assert.equal(driftTargetAfter(milestones[index]), creep.driftTarget);
  });
  assert.ok(driftTargetAfter(0.97) <= 0.97 && driftTargetAfter(2) <= 0.97, 'past the last step the cap holds');
  assert.match(LOADING_STYLE, /studio-fill-creep 150s linear both/);
  assert.match(LOADING_STYLE, /20% [{] transform: scaleX\(0[.]3\); [}] 100% [{] transform: scaleX\(0[.]34\); [}]/, 'before the first step the CSS creep also drifts on, below 0.35');
});

function tokenColors(blockStart) {
  const tokensText = TOKENS_CSS.slice(TOKENS_CSS.indexOf(blockStart));
  const read = name => {
    const hex = new RegExp(`--site-${name}: #([0-9a-f]{6})`).exec(tokensText)[1];
    return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  };
  return { page: read('bg'), text: read('text') };
}

function contrastRatio(first, second) {
  const linear = channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = ([red, green, blue]) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('the unfilled track keeps at least 2:1 against the page in both themes, using only the text and page tokens', () => {
  const share = Number(/[.]progress [{][^}]*color-mix[(]in srgb, var[(]--site-text[)] (\d+)%, transparent[)]/.exec(PAGE_HTML)[1]) / 100;
  for (const [theme, blockStart] of [['light', ':root {'], ['dark', '[data-theme="dark"] {']]) {
    const { page, text: textColor } = tokenColors(blockStart);
    const track = textColor.map((channel, index) => channel * share + page[index] * (1 - share));
    assert.ok(contrastRatio(track, page) >= 2, `the ${theme} track reads at ${contrastRatio(track, page).toFixed(2)}:1`);
  }
  assert.ok(!/[.]progress [{][^}]*#[0-9a-f]{3,8}/i.test(PAGE_HTML), 'the track has no colour of its own');
});

function keyframeOffsets(name) {
  const body = KEYFRAME_BLOCKS.find(block => block[1] === `studio-${name}`)[2];
  return [...body.matchAll(/((?:from|to|\d+%)(?:, ?(?:from|to|\d+%))*) [{] ([^}]*) [}]/g)].map(match => ({
    offsets: match[1].split(/, ?/).map(offset => (offset === 'from' ? 0 : offset === 'to' ? 100 : Number(offset.slice(0, -1)))),
    declarations: match[2],
  }));
}

test('the stream shortens into the lip before the pot starts to right itself, so no streak is left behind', () => {
  assert.match(LOADING_STYLE, /#studio-loading [.]stream [{][^}]*transform-origin: 6px 0;/, 'the stream is scaled about the lip, at its top');
  const streamGone = keyframeOffsets('stream-out').find(step => /opacity: 0/.test(step.declarations) && /scaleY[(]0[)]/.test(step.declarations));
  assert.ok(streamGone, 'the stream ends scaled to 0 along its length and transparent');
  assert.ok(!keyframeOffsets('stream-out').some(step => /scaleX/.test(step.declarations)), 'the stream is not thinned sideways, which leaves a streak in the air');
  const potStart = keyframeOffsets('pot-right').find(step => step.offsets.includes(0));
  assert.match(potStart.declarations, /rotate[(]30deg[)]/, 'the pot starts the wind-down still tipped (held through its delay)');
});

test('the stream is fully transparent before its last frame, so no flake of lava is left at the lip once it has retracted', () => {
  const steps = keyframeOffsets('stream-out');
  const hidden = steps.find(step => /opacity: 0/.test(step.declarations) && !step.offsets.includes(100));
  assert.ok(hidden, 'opacity reaches 0 at a step before the end, while the stream still has some length');
  assert.ok(Math.max(...hidden.offsets) <= 85, 'and does so before the last frames of the retraction');
  assert.ok(!steps.some(step => /opacity: 1/.test(step.declarations) && step.offsets.some(offset => offset > 0 && offset < 100)), 'no middle step holds the stream fully opaque up to its last frames');
});

test('the stream leaves from behind the pot, tangent to its rim, with no flat top over the page and no gap', () => {
  const rule = selector => new RegExp(`${selector} [{]([^}]*)[}]`).exec(LOADING_STYLE)[1];
  assert.match(rule('#studio-loading [.]stream'), /z-index: 0;/, 'the stream sits under the pot (it comes first in the markup), so the pot hides its flat top and the stream emerges from the rim');
  assert.doesNotMatch(rule('#studio-loading [.]pot'), /z-index/, 'the pot is not lowered beneath the stream');
  assert.match(rule('#studio-loading [.]pot'), /left: -78px;/, 'the pot sits 2 px right of where it stood, so the stream top is under the rim crest at the 30 degree pour angle, not beside it');
});

test('the stream turns to the plain molten token over its last 14 px, so it meets the fill in the same colour with no band, outline or glow', () => {
  const overlay = /#studio-loading [.]flow::after [{]([^}]*)[}]/.exec(LOADING_STYLE);
  assert.ok(overlay, 'a static overlay sits at the bottom of the stream');
  assert.match(overlay[1], /inset: auto 0 0;/, 'it is pinned to the bottom edge');
  assert.ok(Number(/height: ([0-9]+)px;/.exec(overlay[1])[1]) >= 14, 'it is at least one band period tall, so a dark band never meets the fill');
  assert.match(overlay[1], /background: linear-gradient[(]transparent, var[(]--site-focus[)][)];/, 'it ends in the same token as the fill, fully opaque at the junction');
  assert.ok(!/(?:box-shadow|filter|outline|border):/.test(rule('#studio-loading [.]fill')), 'the fill has no outline, glow or shadow');
  assert.ok(!/(?:box-shadow|filter|outline|border):/.test(rule('#studio-loading [.]stream')), 'nor has the stream');
  function rule(selector) { return new RegExp(`${selector} [{]([^}]*)[}]`).exec(LOADING_STYLE)[1]; }
});

test('the fill stays hidden until the stream has landed, and the wind-down waits for the landing', async () => {
  assert.match(LOADING_STYLE, /studio-fill-land 0[.]08s steps[(]1, end[)] 0[.]72s both/, 'the fill appears as the stream arrives, from a 4 px start under the stream end');
  assert.match(LOADING_STYLE, /@keyframes studio-fill-land [{] from [{] opacity: 0; [}] to [{] opacity: 1; [}] [}]/);
  const motionBlock = LOADING_STYLE.slice(LOADING_STYLE.indexOf('@media (prefers-reduced-motion: no-preference) {'));
  const streamIn = /studio-stream-in ([\d.]+)s var[(]--site-ease-out[)] ([\d.]+)s/.exec(motionBlock);
  assert.ok(0.72 < Number(streamIn[1]) + Number(streamIn[2]), 'the fill appears before the stream has finished growing, and not before it is at the bar');
  assert.ok(0.72 >= Number(streamIn[2]) + 0.2, 'and well after the stream starts to grow');
  const page = createProgressPage();
  let elapsed = 500;
  page.loadingElement.querySelector = selector => (selector === '.stream' ? { getAnimations: () => [{ animationName: 'studio-stream-in', get currentTime() { return elapsed; } }] } : null);
  const before = Date.now();
  await waitForStreamLanding(page.documentReference);
  assert.ok(Date.now() - before >= 250, 'a load that is ready at 0.5 s waits for the remaining 0.3 s of the pour');
  elapsed = 900;
  const waitedAgain = Date.now();
  await waitForStreamLanding(page.documentReference);
  assert.ok(Date.now() - waitedAgain < 100, 'a later ready does not wait');
});

test('the fill appears in one frame at full opacity once the stream has landed, so at the junction it never differs from the stream in opacity', () => {
  const land = /studio-fill-land ([0-9.]+)s (steps[(][^)]*[)]|[^ ]+) ([0-9.]+)s both/.exec(LOADING_STYLE);
  assert.ok(land, 'the fill has one appearance animation');
  assert.match(land[2], /^steps[(]1, ?(?:end|jump-end)[)]$/, 'a single step: opacity is 0 until the end of the animation and 1 from then on, with no fade through half-opacity');
  assert.ok(Number(land[1]) + Number(land[3]) >= 0.8 - 1e-9, 'the step comes when the stream has finished growing (0.8 s), not before');
});

test('with reduced motion the fill completes in 200 ms, and with motion in 90 ms while the stream still pours', () => {
  const page = createProgressPage();
  page.loadingElement.ownerDocument = { defaultView: { matchMedia: () => ({ matches: true }) } };
  windDownStudioLoading(page.documentReference);
  assert.equal(page.state.started.at(-1).options.duration, 200);
});

test('the bar moves in a step for each scene module that arrives, between the script step and the scene modules step, and never back', () => {
  const page = createProgressPage();
  reportStudioLoadingProgress(page.documentReference, STUDIO_LOADING_MILESTONES.modulesLoaded);
  const total = 50;
  const seen = [];
  for (let loaded = 1; loaded <= total; loaded += 1) {
    reportStudioModulesLoaded(page.documentReference, loaded, total);
    seen.push(page.progress());
  }
  assert.equal(new Set(seen).size, total, 'every module moves the bar to a new place');
  assert.deepEqual([...seen].sort((first, second) => first - second), seen, 'the bar only moves forward');
  assert.ok(seen[0] > STUDIO_LOADING_MILESTONES.modulesLoaded && seen[0] < 0.4, 'the first module moves it a little');
  assert.ok(Math.abs(seen.at(-1) - STUDIO_LOADING_MILESTONES.sceneModulesLoaded) < 1e-9, 'the last module lands on the scene modules step');
  reportStudioModulesLoaded(page.documentReference, 1, total);
  assert.equal(page.progress(), seen.at(-1), 'a late report never moves the bar back');
});

test('the page script reports each module as it loads, and loadAllAgentSceneModules calls back once per module with a running count', async () => {
  const pageScript = await readFile(new URL('../bench/studio/main.js', import.meta.url), 'utf8');
  assert.match(pageScript, /loadAllAgentSceneModules[(][{] onModuleLoaded: [(]loaded, total[)] => reportStudioModulesLoaded[(]document, loaded, total[)] [}][)]/);
  const { loadAllAgentSceneModules } = await import('../src/agent-scene-modules.js');
  const counts = [];
  const totals = new Set();
  await loadAllAgentSceneModules({ onModuleLoaded: (loaded, total) => { counts.push(loaded); totals.add(total); } });
  assert.equal(totals.size, 1);
  assert.deepEqual(counts, Array.from({ length: counts.length }, (unused, index) => index + 1), 'the count rises by one each time');
  assert.equal(counts.at(-1), [...totals][0], 'the last call reports every module loaded');
  await loadAllAgentSceneModules();
});
