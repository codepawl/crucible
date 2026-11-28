import './site-chrome.js';
import './site.css';
import './showcase.css';
import './pointer-light.js';
import { CrucibleRenderer } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { loadViewTransformForRendererOptions } from './view-transform-loading.js';
import { resolveSceneFileCascades } from './cascaded-shadows.js';
import { mergePartLights, showcaseEnvironment, withSceneFileLights } from './dense-lods.js';
import { applyWaterReflection, attachWaterReflection } from './water-reflection.js';

// The mirror redraws every second lit frame while the camera moves: about 1.3 ms off the orbiting port frame
// (issue #504), and An saw no stutter in a side-by-side. A still camera keeps its picture either way.
const WATER_REFLECTION_OPTIONS = { updateEvery: 2 };
import { renderCommunity } from './community-showcase.js';
import { attachOrbitControls, createOrbitController, orbitFromCamera } from './site-controls.js';
import { resolveRequestedScene } from './showcase-scene-request.js';
import { createDownloadMeter, downloadBlob, inWholeWorldOrder, readByteLength, readPartRanks } from './showcase-download.js';

// Each scene lives in public/showcase/<id>/scene.json: its GLB, sky, camera, renderer and frame options, and credits.
// Optional fields: "bounds" ({ min, max } the camera target stays inside), "minDistance" and "maxDistance".
// A world can load in stages (scripts/split-showcase-glb.mjs): "glb" is then the first part, the ground and the hero the opening
// camera frames, "glbRest" lists the other parts and "hdriPreview" is a small sky for the first frame. The page draws the first
// frame from those two, then streams the rest in and swaps in the full sky.
const SCENE_LABELS = {
  airport: 'Airport ramp',
  datacenter: 'AI data center',
  port: 'Container port',
};
const SCENE_GLOWS = {
  airport: '#ff6a2b',
  datacenter: '#3b82f6',
  port: '#f59e0b',
};
const SCENE_IDS = Object.keys(SCENE_LABELS);
const MIN_PITCH = 0.05;
const MAX_PITCH = 1.45;
const DEFAULT_MAX_DISTANCE_FACTOR = 3;
const DEFAULT_MIN_DISTANCE_FACTOR = 0.05;
const BOUNDS_MARGIN = 0.25;
const MAX_SAMPLED_VERTICES_PER_PART = 4000;
const KEY_MOVE_PER_SECOND = 0.6;

const SPINNER_ICON = '<svg class="status-icon spinner" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const WARNING_ICON = '<svg class="status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 7.8v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ERROR_ICON = '<svg class="status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const canvas = document.querySelector('#showcase-viewport');
const frame = document.querySelector('.showcase-frame');
const status = document.querySelector('#showcase-status');
const notice = document.querySelector('#showcase-notice');
const tabs = document.querySelector('#showcase-tabs');
const resetButton = document.querySelector('#showcase-reset');
const title = document.querySelector('#showcase-title');
const blurb = document.querySelector('#showcase-blurb');
const creditList = document.querySelector('#showcase-credits');
const orbitController = createOrbitController({
  minPitch: MIN_PITCH,
  maxPitch: MAX_PITCH,
  orbitSpeed: 0.005,
  panSpeed: 0.0016,
  zoomSpeed: 0.001,
  moveSpeed: KEY_MOVE_PER_SECOND,
});
const orbit = { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
const limits = { minDistance: 0.1, maxDistance: 10, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] };
const homeView = { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
let renderer = null;
let scene = null;
let currentId = null;
let loadingId = null;
let loadingRequest = 0;
let loadingAbort = null;
let scheduledFrame = 0;
let lastFrameTimestamp = 0;

function syncOrbit() {
  const current = orbitController.state();
  orbit.yaw = current.yaw;
  orbit.pitch = current.pitch;
  orbit.distance = current.distance;
  orbit.target = current.target;
}

function setLoadingState(id) {
  loadingId = id;
  frame.dataset.loading = id ? 'true' : 'false';
  for (const button of tabs.querySelectorAll('button')) {
    button.disabled = Boolean(id) && (button.dataset.scene === id || button.dataset.scene === currentId);
  }
}

function showStatus(kind, message) {
  status.hidden = false;
  status.dataset.kind = kind;
  status.innerHTML = kind === 'error' ? ERROR_ICON : SPINNER_ICON;
  const text = document.createElement('span');
  text.className = 'status-text';
  text.textContent = message;
  status.append(text);
}

// A notice stays up after the scene loads, unlike the loading chip, so a wrong link is still explained.
function showNotice(message) {
  notice.hidden = false;
  notice.innerHTML = WARNING_ICON;
  const text = document.createElement('span');
  text.textContent = message;
  notice.append(text);
}

// Real bytes fetched so far; the total appears once every file's size is known, so the figure never shrinks.
function showProgress(label, meter) {
  const { received, total } = meter.summary();
  const megabytes = bytes => (bytes / 1e6).toFixed(1);
  showStatus('loading', `${label}…  ${total ? `${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`}`);
}

// The part bounds, sampled so a scene with millions of vertices still opens quickly, plus a margin.
function boundsOfParts(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const positions = part.geometry?.positions;
    const matrix = part.matrix;
    if (!positions || !matrix) continue;
    const vertexCount = positions.length / 3;
    const stride = Math.max(1, Math.floor(vertexCount / MAX_SAMPLED_VERTICES_PER_PART));
    for (let vertex = 0; vertex < vertexCount; vertex += stride) {
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      const z = positions[vertex * 3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return minimum.every(Number.isFinite) ? { min: minimum, max: maximum } : null;
}

// The limits follow the opening view, so working them out again once every part has loaded gives the same result as a one-piece load.
function applyLimits(description, parts, view = orbit) {
  const bounds = description.bounds ?? boundsOfParts(parts) ?? {
    min: view.target.map(value => value - view.distance),
    max: view.target.map(value => value + view.distance),
  };
  const margin = bounds.max.map((value, axis) => (value - bounds.min[axis]) * BOUNDS_MARGIN);
  limits.boundsMin = bounds.min.map((value, axis) => Math.min(value - margin[axis], view.target[axis]));
  limits.boundsMax = bounds.max.map((value, axis) => Math.max(value + margin[axis], view.target[axis]));
  limits.minDistance = description.minDistance ?? view.distance * DEFAULT_MIN_DISTANCE_FACTOR;
  limits.maxDistance = description.maxDistance ?? view.distance * DEFAULT_MAX_DISTANCE_FACTOR;
  orbitController.setLimits(limits);
  syncOrbit();
}

function draw(timestamp = performance.now()) {
  scheduledFrame = 0;
  if (!renderer || !scene) return;
  const deltaSeconds = lastFrameTimestamp ? Math.min(0.1, Math.max(0.001, (timestamp - lastFrameTimestamp) / 1000)) : 0.016;
  lastFrameTimestamp = timestamp;
  const pose = orbitController.step(deltaSeconds);
  syncOrbit();
  renderer.render({ ...scene.frame, eye: pose.eye, target: pose.target });
  if (pose.active) requestDraw();
}

function requestDraw() {
  if (!scheduledFrame) scheduledFrame = requestAnimationFrame(draw);
}

function renderTabs() {
  for (const id of SCENE_IDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = id;
    button.textContent = SCENE_LABELS[id];
    button.addEventListener('click', () => selectScene(id));
    tabs.append(button);
  }
}

async function readDescription(id) {
  const response = await fetch(`/showcase/${id}/scene.json`);
  if (!response.ok) throw new Error(`scene ${id} is not available (${response.status})`);
  return response.json();
}

function showCredits(credits = []) {
  creditList.replaceChildren(...credits.map(credit => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = credit.source;
    link.textContent = credit.model;
    item.append(link, ` by ${credit.author}, ${credit.licence}`);
    return item;
  }));
}

function markPressedTab(id) {
  for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.scene === id));
}

// Adds the other parts of a staged world once they have downloaded, then swaps the first frame's small sky for the full one.
async function finishWorld(world) {
  const { request, description, asset, sharedTextures, detachReflection, remainingDownloads, abort } = world;
  const isCurrent = () => request === loadingRequest;
  try {
    const [remainingModels, fullMap] = await remainingDownloads;
    if (!isCurrent()) return;
    const files = [{ parts: asset.parts, ranks: world.ranks }];
    const lightsPerPart = [asset.lights ?? {}];
    for (const [index, model] of remainingModels.entries()) {
      const baseUrl = new URL('.', new URL(description.glbRest[index], location.href)).href;
      const remaining = await loadGltf(model, { baseUrl, sharedTextures, ...(description.gltfOptions ?? {}) });
      files.push({ parts: remaining.parts, ranks: await readPartRanks(model) });
      lightsPerPart.push(remaining.lights ?? {});
    }
    if (!isCurrent()) return;
    // The renderer adds textured parts through this opt-in addon, which stays out of the core bundle.
    await import('./replace-textured-parts.js');
    if (!isCurrent()) return;
    const allParts = inWholeWorldOrder(files);
    // The reflecting surface is found over the whole world, as in a one-piece load, so a part that arrives late can take the mirror.
    const reflection = description.waterReflection ? applyWaterReflection(allParts) : { parts: allParts, surface: null };
    renderer.replaceParts(reflection.parts);
    detachReflection();
    attachWaterReflection(renderer, reflection.surface, WATER_REFLECTION_OPTIONS);
    applyLimits(description, allParts, homeView);
    // The renderer was built with the first part's lights; the lights of every part replace them here, under the scene file's own.
    const environment = withSceneFileLights(mergePartLights(lightsPerPart), description.renderer?.environment);
    if (fullMap) environment.map = fullMap;
    scene.frame = { ...scene.frame, environment };
    window.__showcase.complete = true;
    status.hidden = true;
    requestDraw();
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    showStatus('error', `Could not finish loading ${SCENE_LABELS[world.id]}: ${error.message}`);
  }
}

// The old scene stays on screen and interactive until the new one is ready.
async function selectScene(id) {
  const request = ++loadingRequest;
  loadingAbort?.abort();
  const abort = new AbortController();
  loadingAbort = abort;
  document.documentElement.style.setProperty('--glow', SCENE_GLOWS[id]);
  setLoadingState(id);
  markPressedTab(id);
  let progressLabel = `Loading ${SCENE_LABELS[id]}`;
  const meter = createDownloadMeter(() => { if (request === loadingRequest) showProgress(progressLabel, meter); });
  showProgress(progressLabel, meter);
  try {
    const description = await readDescription(id);
    const glbUrl = new URL(description.glb, location.href);
    const skyUrl = new URL(description.hdri, location.href).href;
    const previewUrl = description.hdriPreview ? new URL(description.hdriPreview, location.href).href : null;
    const remainingUrls = (description.glbRest ?? []).map(path => new URL(path, location.href).href);
    const download = (url, type) => downloadBlob(url, { meter, name: url, type, signal: abort.signal });
    const loadSky = async url => {
      const blob = await download(url, 'image/vnd.radiance');
      return loadHdri(url, { ...(description.hdriOptions ?? {}), fetchImplementation: async () => new Response(blob) });
    };
    meter.register(glbUrl.href);
    meter.register(previewUrl ?? skyUrl);
    // Files that load after the first frame register now with their sizes from a header request, so the total is known early.
    const laterUrls = [...remainingUrls, ...(previewUrl ? [skyUrl] : [])];
    for (const url of laterUrls) {
      meter.register(url);
      readByteLength(url, abort.signal).then(total => meter.setTotal(url, total), () => {});
    }
    const [model, map] = await Promise.all([
      download(glbUrl.href, 'model/gltf-binary'),
      loadSky(previewUrl ?? skyUrl),
    ]);
    // The rest starts the moment the first part is in, so the link stays busy while the page decodes and draws it.
    const remainingDownloads = Promise.all([
      Promise.all(remainingUrls.map(url => download(url, 'model/gltf-binary'))),
      previewUrl ? loadSky(skyUrl) : null,
    ]);
    remainingDownloads.catch(() => {});
    const sharedTextures = createSharedTextures();
    const asset = await loadGltf(model, { baseUrl: new URL('.', glbUrl).href, sharedTextures, ...(description.gltfOptions ?? {}) });
    if (request !== loadingRequest) return;
    renderer?.dispose();
    const rendererOptions = description.renderer ?? {};
    await loadViewTransformForRendererOptions(rendererOptions);
    if (request !== loadingRequest) return;
    // scene.json stores cascades as plain options; the renderer takes the cascade object built from them.
    const environment = showcaseEnvironment(asset.lights, rendererOptions.environment, map);
    const shadowCascades = resolveSceneFileCascades(rendererOptions, environment, rendererOptions.shadowBounds);
    // A scene that sets waterReflection mirrors itself in its largest flat, smooth surface (water or a polished floor).
    if (description.environment?.groundCover !== undefined) console.warn('environment.groundCover is drawn only by render-media.mjs --scene file; this page ignores it.');
    if (description.reflectionHdri !== undefined) console.warn('reflectionHdri is drawn only by render-media.mjs --scene file; this page reflects the lighting HDRI.');
    const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
    const hasBlendedWater = reflection.parts.some(part => part.material.tag === 'water' && part.material.alphaMode === 'blend');
    renderer = new CrucibleRenderer(canvas, reflection.parts, {
      ground: false, hdr: true, compactColor: !hasBlendedWater, samples: 4, memoryBudgetMiB: 384,
      ...rendererOptions,
      shadowCascades,
      environment,
    });
    const detachReflection = attachWaterReflection(renderer, reflection.surface, WATER_REFLECTION_OPTIONS);
    scene = { frame: { exposure: description.exposure ?? 1, ...(description.frame ?? {}) } };
    const initialPose = orbitFromCamera(description.eye, description.target);
    orbitController.setLimits({ minDistance: 0.0001, maxDistance: 1e6, boundsMin: null, boundsMax: null });
    orbitController.setHome(initialPose, { apply: true, immediate: true });
    syncOrbit();
    applyLimits(description, asset.parts, initialPose);
    Object.assign(homeView, orbitController.home());
    currentId = id;
    history.replaceState(null, '', `?scene=${id}${location.hash}`);
    title.textContent = description.title;
    blurb.textContent = description.blurb;
    showCredits(description.credits);
    const staged = remainingUrls.length > 0 || previewUrl !== null;
    window.__showcase = { renderer, scene, orbit, draw, limits, complete: !staged };
    setLoadingState(null);
    requestDraw();
    if (!staged) {
      status.hidden = true;
      return;
    }
    progressLabel = `Loading the rest of ${SCENE_LABELS[id]}`;
    showProgress(progressLabel, meter);
    finishWorld({ id, request, description, asset, sharedTextures, ranks: await readPartRanks(model), detachReflection, remainingDownloads, abort });
  } catch (error) {
    if (request !== loadingRequest) return;
    markPressedTab(currentId);
    setLoadingState(null);
    showStatus('error', `Could not open ${SCENE_LABELS[id]}: ${error.message}`);
  }
}

attachOrbitControls(canvas, orbitController, {
  keyTarget: canvas,
  onChange: () => {
    syncOrbit();
    requestDraw();
  },
});

resetButton.addEventListener('click', () => {
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  orbitController.reset({ immediate: reducedMotion });
  syncOrbit();
  requestDraw();
});
window.addEventListener('resize', () => {
  renderer?.resize();
  requestDraw();
});

renderTabs();
const requestedScene = resolveRequestedScene(new URLSearchParams(location.search).get('scene'), SCENE_IDS);
if (requestedScene.notice) showNotice(requestedScene.notice);
selectScene(requestedScene.id);

renderCommunity({ grid: document.querySelector('#community-grid'), emailLink: document.querySelector('#community-email'), emptyState: document.querySelector('#community-empty') });
