import './site-tokens.css';
import './brand-fonts.css';
import './site-chrome.css';
import './landing.css';
import { highlightElement } from './code-highlight.js';
import { beatIndexAt, prefersStillStory } from './landing-story.js';

const PACKAGE_COMMANDS = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };
const BAYER_MATRIX = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// The hero region the scene keeps clear for the words: on a wide screen the right part, on a tall one the top.
const HERO_REGION_WIDE = { centreX: 0.72, centreY: 0.5, widthShare: 0.56, heightShare: 1 };
const HERO_REGION_TALL = { centreX: 0.5, centreY: 0.22, widthShare: 1, heightShare: 0.44 };

const page = document.getElementById('page');
const story = document.getElementById('story');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowScreen = matchMedia('(max-width: 820px)');
const compactScreen = matchMedia('(max-width: 520px)');

// ---- Release: the version, the install command and the commit come from release.json ----

const release = { status: 'loading', data: null, packageManager: 'npm' };

function validateRelease(data) {
  for (const key of ['version', 'installCommand', 'commit']) {
    if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`Missing release field: ${key}`);
  }
  if (!/^[a-f0-9]{7,40}$/i.test(data.commit)) throw new Error('Invalid release commit.');
  return data;
}

function installCommandText() {
  return release.data.installCommand.replace(/^npm install/, PACKAGE_COMMANDS[release.packageManager]);
}

function showRelease() {
  const ready = release.status === 'ready';
  for (const element of document.querySelectorAll('[data-release-version]')) {
    element.textContent = ready ? `v${release.data.version}` : release.status === 'error' ? 'Release unavailable' : 'Loading release';
  }
  const installCommand = document.getElementById('package-command');
  if (ready) {
    installCommand.textContent = installCommandText();
    highlightElement(installCommand, 'shell');
  }
  for (const button of document.querySelectorAll('[data-package-manager]')) {
    button.setAttribute('aria-pressed', String(button.dataset.packageManager === release.packageManager));
  }
  for (const link of document.querySelectorAll('[data-release-commit]')) {
    if (!ready) continue;
    link.href = `https://github.com/codepawl/crucible/commit/${release.data.commit}`;
    link.textContent = `Commit ${release.data.commit.slice(0, 7)}`;
  }
  for (const feedback of document.querySelectorAll('.release-feedback')) feedback.hidden = release.status !== 'error';
  for (const retry of document.querySelectorAll('[data-release-retry]')) retry.hidden = release.status !== 'error';
  for (const message of document.querySelectorAll('[data-release-status]')) {
    message.textContent = release.status === 'error' ? 'Release information could not load. Retry to get the current files.' : '';
  }
}

async function loadRelease() {
  release.status = 'loading';
  showRelease();
  try {
    const response = await fetch('./release.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Release endpoint returned ${response.status}.`);
    release.data = validateRelease(await response.json());
    release.status = 'ready';
  } catch {
    release.status = 'error';
  }
  showRelease();
}

for (const button of document.querySelectorAll('[data-package-manager]')) {
  button.addEventListener('click', () => {
    release.packageManager = button.dataset.packageManager;
    showRelease();
  });
}
for (const retry of document.querySelectorAll('[data-release-retry]')) retry.addEventListener('click', loadRelease);
window.__home = { state: release, loadRelease };
loadRelease();
window.addEventListener('pageshow', (event) => { if (event.persisted) loadRelease(); });

// ---- Copy buttons copy the command or the code block beside them ----

async function copyText(button) {
  const holder = button.closest('.command') ?? button.closest('.code-wrap');
  const source = holder.querySelector('code, pre');
  try {
    await navigator.clipboard.writeText(source.textContent);
  } catch {
    getSelection().selectAllChildren(source);
  }
  button.classList.add('copied');
  setTimeout(() => button.classList.remove('copied'), 1400);
}
for (const button of document.querySelectorAll('.copy')) button.addEventListener('click', () => copyText(button));
document.querySelectorAll('.command code').forEach((element) => highlightElement(element, 'shell'));
document.querySelectorAll('#code .code-block').forEach((element) => highlightElement(element, 'javascript'));

// ---- Photos: each starts as a 1-bit ordered dither of its own pixels and develops into the full render when it scrolls in ----

function readPaletteColour(name) {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const context = probe.getContext('2d', { willReadFrequently: true });
  context.fillStyle = getComputedStyle(page).getPropertyValue(name).trim();
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
}

function ditherPhoto(image) {
  const holder = image.parentElement;
  const width = Math.max(40, Math.round(holder.clientWidth / 3));
  const height = Math.max(24, Math.round(holder.clientHeight / 3));
  const overlay = document.createElement('canvas');
  overlay.width = width;
  overlay.height = height;
  const context = overlay.getContext('2d', { willReadFrequently: true });
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  context.drawImage(image, (width - image.naturalWidth * scale) / 2, (height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
  let source;
  try { source = context.getImageData(0, 0, width, height); } catch { return; }
  const paper = readPaletteColour('--bg');
  const ink = readPaletteColour('--fg');
  const molten = readPaletteColour('--accent');
  const shown = context.createImageData(width, height);
  const paint = (developed) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const threshold = (BAYER_MATRIX[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
        const [red, green, blue] = [source.data[offset], source.data[offset + 1], source.data[offset + 2]];
        const tone = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
        const hot = red > 150 && red - blue > 90 && green > 60 && green < red;
        let colour = Math.min(1, tone * 1.5) > threshold ? paper : ink;
        if (hot && tone > threshold * 0.6) colour = molten;
        if (developed > threshold) colour = [red, green, blue];
        shown.data.set([colour[0], colour[1], colour[2], 255], offset);
      }
    }
    context.putImageData(shown, 0, 0);
  };
  paint(0);
  holder.append(overlay);
  new IntersectionObserver((entries, observer) => {
    if (!entries[0].isIntersecting) return;
    observer.disconnect();
    const started = performance.now();
    const develop = (now) => {
      const amount = Math.min(1, (now - started - 300) / 900);
      paint(Math.max(0, amount));
      if (amount < 1) requestAnimationFrame(develop);
      else overlay.remove();
    };
    requestAnimationFrame(develop);
  }, { threshold: 0.6 }).observe(holder);
}

if (!reducedMotion) {
  for (const image of document.querySelectorAll('img[data-dither]')) {
    if (image.complete && image.naturalWidth) ditherPhoto(image);
    else image.addEventListener('load', () => ditherPhoto(image), { once: true });
  }
}

// ---- The story: beats, scroll progress and the live scene ----

const beats = [...document.querySelectorAll('.beat')];
const heroBeat = beats[0];
const calloutNotes = [...document.querySelectorAll('.callout')];
const leader = document.getElementById('leader');
const ladder = document.getElementById('ladder');
const cue = document.getElementById('cue');
const canvas = document.getElementById('foundry');
const readoutFields = { fill: document.getElementById('hud-fill'), heat: document.getElementById('hud-heat') };

let foundry = null;
let easeUnit = null;
let targetProgress = 0;
let shownProgress = 0;
let storyVisible = true;
let lastTime = performance.now();
let activeBeat = -1;
let plainView = false;

// Scrolls to a point of the story, given as its progress from 0 to 1.
function jumpTo(progress) {
  const travel = story.offsetHeight - window.innerHeight;
  window.scrollTo({ top: window.scrollY + story.getBoundingClientRect().top + travel * progress, behavior: reducedMotion ? 'auto' : 'smooth' });
}
if (ladder) {
  ladder.addEventListener('click', (event) => {
    const step = event.target.closest('button[data-jump]');
    if (step) jumpTo(Number(step.dataset.jump));
  });
}
if (cue) {
  cue.addEventListener('click', (event) => {
    event.preventDefault();
    jumpTo(0.2);
  });
}

function fadeHero(progress) {
  const shown = plainView ? 0 : 1 - easeUnit((progress - 0.008) / 0.027);
  heroBeat.style.opacity = String(shown);
  heroBeat.style.visibility = shown > 0.02 ? 'visible' : 'hidden';
  return plainView ? 0 : 1 - easeUnit((progress - 0.03) / 0.06);
}

// Shows the note of the current beat; a note never sits on the scene, so while any drawn part passes behind it, it steps out.
function pickCallout(progress) {
  let shown = null;
  for (const note of calloutNotes) {
    if (!plainView && progress >= Number(note.dataset.from) && progress <= Number(note.dataset.to)) shown = note;
  }
  for (const note of calloutNotes) note.classList.remove('aside');
  if (!shown) return null;
  if (!isCoveredBySubject(shown)) return shown;
  // On a phone the rising mould reaches the bottom edge before the beat ends: the note moves to the free column beside the stream.
  if (compactScreen.matches && shown.hasAttribute('data-aside')) {
    shown.classList.add('aside');
    if (!isCoveredBySubject(shown)) return shown;
    shown.classList.remove('aside');
  }
  return null;
}

function isCoveredBySubject(note) {
  const noteBox = note.getBoundingClientRect();
  return foundry.subjectBoxes().some((box) => !box.name.startsWith('Spark') && box.left < noteBox.right + 4 && box.right > noteBox.left - 4 && box.top < noteBox.bottom + 4 && box.bottom > noteBox.top - 4);
}

function drawLeader(points, endX, endY) {
  leader.firstElementChild.setAttribute('points', points);
  leader.lastElementChild.setAttribute('x', String(endX - 3));
  leader.lastElementChild.setAttribute('y', String(endY - 3));
  leader.style.visibility = 'visible';
}

// Draws the pointer from the note to the thing it names.
function placeCallout(progress) {
  const shown = pickCallout(progress);
  for (const note of calloutNotes) note.classList.toggle('on', note === shown);
  const fromBelow = compactScreen.matches;
  const anchor = shown ? foundry.anchor(shown.dataset.anchor, fromBelow) : null;
  if (!anchor) {
    leader.style.visibility = 'hidden';
    return;
  }
  const endX = Math.round(anchor[0]);
  if (fromBelow && !shown.classList.contains('aside')) {
    const riseX = Math.round(Math.max(shown.offsetLeft + 10, Math.min(shown.offsetLeft + shown.offsetWidth - 10, anchor[0])));
    const topY = Math.round(Math.min(shown.offsetTop - 16, anchor[1]));
    drawLeader(`${riseX},${shown.offsetTop - 6} ${riseX},${topY} ${endX},${topY}`, endX, topY);
    return;
  }
  const noteBottom = shown.offsetTop + shown.offsetHeight;
  if (shown.classList.contains('aside')) {
    // Beside the stream the pointer ends exactly on the anchor: straight across when it is level with the note, else down or up first.
    const anchorY = Math.round(anchor[1]);
    const noteRight = shown.offsetLeft + shown.offsetWidth;
    const leaveX = Math.round(Math.max(shown.offsetLeft + 10, Math.min(noteRight - 10, endX)));
    if (anchorY >= shown.offsetTop && anchorY <= noteBottom) drawLeader(`${noteRight + 6},${anchorY} ${endX},${anchorY}`, endX, anchorY);
    else if (anchorY > noteBottom) drawLeader(`${leaveX},${noteBottom + 6} ${leaveX},${anchorY} ${endX},${anchorY}`, endX, anchorY);
    else drawLeader(`${leaveX},${shown.offsetTop - 6} ${leaveX},${anchorY} ${endX},${anchorY}`, endX, anchorY);
    return;
  }
  const dropX = Math.round(Math.max(shown.offsetLeft + 10, Math.min(shown.offsetLeft + shown.offsetWidth - 10, anchor[0] + 24)));
  const endY = Math.round(Math.max(noteBottom + 16, anchor[1]));
  drawLeader(`${dropX},${noteBottom + 6} ${dropX},${endY} ${endX},${endY}`, endX, endY);
}

function showBeat(progress) {
  const beatIndex = beatIndexAt(progress);
  if (beatIndex === activeBeat) return;
  activeBeat = beatIndex;
  beats.forEach((beat, index) => beat.classList.toggle('on', index === beatIndex));
  if (ladder) {
    [...ladder.children].forEach((step, index) => {
      step.classList.toggle('on', index === beatIndex);
      step.classList.toggle('done', index < beatIndex);
    });
  }
}

function showReadout() {
  const readout = foundry.readout();
  readoutFields.fill.textContent = `${readout.fillPercent}%`;
  readoutFields.heat.textContent = `${readout.temperature}°C`;
}

function drawAt(progress, seconds) {
  showBeat(progress);
  if (!foundry) return;
  foundry.set({ progress, time: seconds });
  foundry.set({ heroAmount: fadeHero(progress), region: narrowScreen.matches ? HERO_REGION_TALL : HERO_REGION_WIDE });
  foundry.draw();
  placeCallout(progress);
  showReadout();
}

function readScroll() {
  const travel = story.offsetHeight - window.innerHeight;
  targetProgress = Math.max(0, Math.min(1, -story.getBoundingClientRect().top / Math.max(1, travel)));
  if (cue) cue.classList.toggle('gone', targetProgress > 0.015);
}

function loop(now) {
  const elapsed = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  shownProgress += (targetProgress - shownProgress) * (1 - Math.exp(-elapsed * 9));
  if (Math.abs(targetProgress - shownProgress) < 0.0004) shownProgress = targetProgress;
  if (storyVisible) drawAt(shownProgress, now / 1000);
  requestAnimationFrame(loop);
}

// The story as five still stages: for reduced motion, a light connection, and when the engine cannot load.
function showStaticStory() {
  story.classList.add('is-static');
}

async function startScene() {
  if (reducedMotion || prefersStillStory({ connection: navigator.connection, deviceMemory: navigator.deviceMemory, search: location.search })) return null;
  try {
    const sceneModule = await import('./landing-scene.js');
    easeUnit = sceneModule.easeUnit;
    return await sceneModule.createFoundry(canvas);
  } catch (error) {
    console.warn('The pour scene could not load:', error.message);
    return null;
  }
}

window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', () => {
  readScroll();
  if (!foundry) return;
  foundry.resize();
  drawAt(shownProgress, performance.now() / 1000);
});
new IntersectionObserver((entries) => { storyVisible = entries[0].isIntersecting; }).observe(story);

showBeat(0);
foundry = await startScene();
if (foundry) {
  readScroll();
  shownProgress = targetProgress;
  drawAt(shownProgress, performance.now() / 1000);
  story.classList.add('scene-live');
  requestAnimationFrame(loop);
} else {
  showStaticStory();
}
// For the checks (scripts/check-landing.mjs): jump to a progress and draw at once, and read what the scene reports.
window.foundryPage = {
  engine: foundry,
  seek(progress, seconds = 1.3) { targetProgress = progress; shownProgress = progress; drawAt(progress, seconds); },
  settled: () => shownProgress === targetProgress,
  // For the fallback stills: the scene alone, centred, without the hero offset or the notes.
  plain(value) { plainView = value; },
};
window.pageReady = true;
