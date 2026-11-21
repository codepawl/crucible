import './site-chrome.js';
import './view2d.css';
import './asset-viewer.css';
import { mat4, vec3 } from 'gl-matrix';
import { CrucibleRenderer, cameraView, fitOrthographicHeight } from './index.js';
import { loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { sceneFileLighting, sunShadowBounds } from './dense-lods.js';
import { readQueryNumber } from './query-number.js';

const canvas = document.querySelector('#viewport');
const parameters = new URLSearchParams(location.search);
if (parameters.get('export') === '1') {
  document.body.classList.add('export-view');
  const width = Number(parameters.get('width'));
  const height = Number(parameters.get('height'));
  if (width > 0 && height > 0) {
    document.querySelector('.workspace').style.width = `${width}px`;
    document.querySelector('.workspace').style.height = `${height}px`;
  }
}
// An asset opened from disk gets this sky, a warm floor and the sky's own sun.
const DEFAULT_SETTING = { skyUrl: new URL('hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr', document.baseURI).href, skyRotation: 1.32, skyIntensity: undefined, environment: {}, exposure: 1, effects: {}, yaw: 0.65, pitch: 0.3, focus: null };
// The demo is a flat lay: a camera on a walnut table in soft overcast window light, seen from high up, with the sun
// shining through a window out of frame. `focus` is the box in metres (x, y up, z) the view fits instead of the whole table.
const DEMO_URL = new URL('desk-flat-lay.glb', document.baseURI).href;
const DEMO_TITLE = 'Camera on a desk';
const DEMO_SETTING = {
  skyUrl: new URL('hdri/kloofendal_28d_misty_puresky_1k.hdr', document.baseURI).href,
  skyRotation: 0,
  skyIntensity: 0.7,
  environment: { lightDirection: [-0.25, 0.7, -0.66], keyColor: [1.3, 1.15, 1], sunAngularRadius: 0.09, pointLights: [{ position: [-0.4, 1.8, 0.7], color: [1, 0.82, 0.62], intensity: 4 }] },
  exposure: 0.8,
  effects: { saturation: 0.85, ambientOcclusion: 0.6 },
  yaw: 0,
  pitch: 1.15,
  focus: { minimum: [-0.34, 1.16, -0.3], maximum: [0.34, 1.3, 0.3] },
  portraitFocus: { minimum: [-0.218, 1.16, -0.29], maximum: [0.372, 1.3, 0.41] },
};
const FLOOR_COLOR = [0.34, 0.22, 0.13];
const FRAME_MARGIN = 1.08;
// Distance, in picture heights, at which the lens shows that height of the table; measured on the desk at pitch 1.15.
const FOCUS_DISTANCE_FACTOR = 0.86;
const state = { view: 'perspective', yaw: DEFAULT_SETTING.yaw, pitch: DEFAULT_SETTING.pitch, zoom: 1, time: 0, clip: 0, playing: false };
let setting = DEFAULT_SETTING;
let asset;
let renderer;
let bounds;
let scheduledFrame = 0;
let lastTime = 0;
let pointer;
let loadingRequest = 0;
const skyRequests = new Map();

// Each sky is fetched once; a page that cannot fetch it still shows the asset, lit by the default sky.
function loadSky({ skyUrl, skyRotation, skyIntensity }) {
  if (!skyRequests.has(skyUrl)) {
    skyRequests.set(skyUrl, loadHdri(skyUrl, { showBackground: true, rotation: skyRotation, intensity: skyIntensity }).catch(error => {
      notice(`Sky unavailable: ${error.message}`, true);
      return null;
    }));
  }
  return skyRequests.get(skyUrl);
}

// A warm floor under the asset, wide enough to reach the horizon, so the asset sits on something that takes its shadow.
function floorUnder(assetBounds, extent) {
  const half = extent * 60;
  const height = assetBounds.minimum[1];
  return {
    name: 'Viewer floor',
    geometry: {
      positions: new Float32Array([-half, height, -half, -half, height, half, half, height, half, half, height, -half]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: mat4.create(),
    material: { color: FLOOR_COLOR, metallic: 0, roughness: 0.9, emission: 0 },
  };
}

function notice(message, failed = false, waiting = false) {
  const element = document.querySelector('#notice');
  element.textContent = `${waiting ? '◷' : failed ? '⚠' : '✓'} ${message}`;
  element.hidden = false;
}

function measureBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const transformed = vec3.create();
  for (const part of parts) {
    for (let index = 0; index < part.geometry.positions.length; index += 3) {
      vec3.transformMat4(transformed, part.geometry.positions.subarray(index, index + 3), part.matrix);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], transformed[axis]);
        maximum[axis] = Math.max(maximum[axis], transformed[axis]);
      }
    }
  }
  return { minimum, maximum };
}

function duration() {
  return asset?.animations[state.clip]?.duration ?? 0;
}

// The height of the picture that holds a focus box seen from above: its depth, or its width divided by the canvas shape.
function focusHeight(box, aspect) {
  const width = box.maximum[0] - box.minimum[0];
  const depth = box.maximum[2] - box.minimum[2];
  return Math.max(depth, width / aspect) * FRAME_MARGIN;
}

function frame() {
  const aspect = canvas.width / canvas.height;
  // A narrow canvas (a phone) fits a tighter box, so the subject keeps most of the width instead of a third.
  const framed = (aspect < 1 && setting.portraitFocus) || setting.focus || bounds;
  const target = framed.minimum.map((value, axis) => (value + framed.maximum[axis]) / 2);
  const extent = Math.max(...bounds.maximum.map((value, axis) => value - bounds.minimum[axis]), 0.01);
  const focusExtent = Math.max(...framed.maximum.map((value, axis) => value - framed.minimum[axis]), 0.01);
  const view = cameraView(state.view, { target, distance: focusExtent * 2.5 });
  const fitted = setting.focus && state.view === 'perspective' ? focusHeight(framed, aspect) : fitOrthographicHeight(framed, view, aspect, FRAME_MARGIN);
  const height = Math.max(focusExtent * 0.01, fitted) * state.zoom;
  view.orthographicHeight = height;
  view.near = Math.max(0.0001, extent / 1000);
  view.far = extent * 100;
  if (state.view === 'perspective') {
    const distance = height * (setting.focus ? FOCUS_DISTANCE_FACTOR : 1.7);
    view.eye = [target[0] + Math.sin(state.yaw) * Math.cos(state.pitch) * distance, target[1] + Math.sin(state.pitch) * distance, target[2] + Math.cos(state.yaw) * Math.cos(state.pitch) * distance];
  }
  return { ...view, time: state.time, exposure: Number(document.querySelector('#exposure').value), effects: { ...setting.effects, bloom: { strength: Number(document.querySelector('#bloom').value), threshold: 0.8 } } };
}

function renderAt(time = state.time) {
  if (!renderer) return;
  state.time = Math.max(0, Math.min(duration(), time));
  if (asset.animations.length) renderer.updateParts(asset.applyAnimation(state.time, state.clip));
  renderer.render(frame());
  document.querySelector('#time').value = String(state.time);
  document.querySelector('#time-value').textContent = `${state.time.toFixed(2)} s`;
}

function tick(timestamp) {
  scheduledFrame = 0;
  if (document.hidden) return;
  if (state.playing && duration()) state.time = (state.time + Math.min((timestamp - lastTime) / 1000, 0.05)) % duration();
  lastTime = timestamp;
  try {
    renderAt();
  } catch (error) {
    pause();
    notice(error.message, true);
  }
  if (state.playing) invalidate();
}

function invalidate() {
  if (!scheduledFrame && renderer && !document.hidden) scheduledFrame = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  document.querySelector('#play').textContent = '▶ Play';
}

function syncAnimation() {
  document.querySelector('#time').max = String(duration() || 1);
  document.querySelector('#time').disabled = !duration();
  document.querySelector('#play').disabled = !duration();
}

async function showAsset(loaded, title, nextSetting = DEFAULT_SETTING) {
  const nextBounds = measureBounds(loaded.parts);
  const center = nextBounds.minimum.map((value, axis) => (value + nextBounds.maximum[axis]) / 2);
  const extent = Math.max(...nextBounds.maximum.map((value, axis) => value - nextBounds.minimum[axis]), 0.01);
  const sky = await loadSky(nextSetting);
  const lighting = sceneFileLighting(sky, loaded.lights, nextSetting.environment);
  const sunShadow = lighting.sunSplit ? sunShadowBounds(loaded.parts, lighting.environment.lightDirection) : null;
  renderer?.dispose();
  renderer = null;
  asset?.dispose();
  asset = null;
  let nextRenderer;
  try {
    nextRenderer = new CrucibleRenderer(canvas, loaded.parts, { ground: floorUnder(nextBounds, extent), hdr: true, environment: { ...lighting.environment, map: lighting.map }, samples: readQueryNumber(parameters, 'samples', 4, { minimum: 1, integer: true }), pixelRatio: parameters.get('export') === '1' ? 1 : Math.min(devicePixelRatio, 2), memoryBudgetMiB: readQueryNumber(parameters, 'memory', 256, { minimum: 1 }), shadowBounds: sunShadow ?? { target: center, eye: [center[0] - extent, center[1] + extent * 2, center[2] + extent], extent: extent * 1.5, near: extent * 0.01, far: extent * 8 } });
  } catch (error) {
    loaded.dispose();
    throw error;
  }
  renderer = nextRenderer;
  asset = loaded;
  bounds = nextBounds;
  setting = nextSetting;
  state.yaw = nextSetting.yaw;
  state.pitch = nextSetting.pitch;
  document.querySelector('#exposure').value = String(nextSetting.exposure);
  state.zoom = 1;
  state.time = 0;
  state.clip = 0;
  pause();
  const clip = document.querySelector('#clip');
  clip.replaceChildren();
  const names = asset.animations.length ? asset.animations.map((animation, index) => animation.name || `Clip ${index + 1}`) : ['No animation'];
  names.forEach((name, index) => clip.add(new Option(name, String(index))));
  clip.disabled = !asset.animations.length;
  syncAnimation();
  document.querySelector('#metrics').textContent = `${asset.parts.length.toLocaleString()} parts · ${renderer.batches.length} draws`;
  document.querySelector('#notice').hidden = true;
  document.title = `${title} · Crucible asset viewer`;
  invalidate();
}

async function openFile(file) {
  if (!file) return;
  const request = ++loadingRequest;
  pause();
  notice('Loading asset…', false, true);
  try {
    const loaded = await loadGltf(file, { maxBytes: 32 * 1024 * 1024, maxTexturePixels: 4 * 1024 * 1024 });
    if (request !== loadingRequest) {
      loaded.dispose();
      return;
    }
    await showAsset(loaded, file.name);
  } catch (error) {
    if (request === loadingRequest) notice(error.message, true);
  }
}

document.querySelector('#open').addEventListener('click', () => document.querySelector('#file').click());
document.querySelector('#file').addEventListener('change', event => openFile(event.target.files[0]));
document.querySelector('#fit').addEventListener('click', () => { state.zoom = 1; invalidate(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  invalidate();
}));
for (const id of ['exposure', 'bloom']) document.querySelector(`#${id}`).addEventListener('input', invalidate);
document.querySelector('#clip').addEventListener('change', event => { state.clip = Number(event.target.value); state.time = 0; syncAnimation(); invalidate(); });
document.querySelector('#time').addEventListener('input', event => { pause(); state.time = Number(event.target.value); invalidate(); });
document.querySelector('#play').addEventListener('click', () => { state.playing = !state.playing; document.querySelector('#play').textContent = state.playing ? 'Ⅱ Pause' : '▶ Play'; lastTime = performance.now(); invalidate(); });
canvas.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', event => {
  if (!pointer || state.view !== 'perspective') return;
  state.yaw -= (event.clientX - pointer.x) * 0.008;
  state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch + (event.clientY - pointer.y) * 0.008));
  pointer = { x: event.clientX, y: event.clientY };
  invalidate();
});
canvas.addEventListener('pointerup', () => { pointer = null; });
canvas.addEventListener('wheel', event => { event.preventDefault(); state.zoom = Math.max(0.1, Math.min(10, state.zoom * Math.exp(event.deltaY * 0.001))); invalidate(); }, { passive: false });
canvas.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') { state.zoom = 1; invalidate(); } });
document.querySelector('.stage').addEventListener('dragover', event => event.preventDefault());
document.querySelector('.stage').addEventListener('drop', event => { event.preventDefault(); openFile(event.dataTransfer.files[0]); });
document.addEventListener('visibilitychange', () => { lastTime = performance.now(); if (!document.hidden) invalidate(); });
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  pause();
  renderer?.dispose();
  renderer = null;
  notice('Graphics context lost. Open the asset again after recovery.', true);
});
window.addEventListener('pagehide', () => {
  loadingRequest++;
  pause();
  if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
  renderer?.dispose();
  renderer = null;
  asset?.dispose();
  asset = null;
});
new ResizeObserver(() => { if (renderer) { renderer.resize(); invalidate(); } }).observe(canvas);
document.querySelector('#save').addEventListener('click', async () => {
  if (!renderer) return notice('Open a valid GLB asset before saving an image', true);
  pause();
  renderAt();
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  if (!blob) return notice('Image capture failed', true);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crucible-asset.png';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice('Image saved');
});

window.__assetViewer = { state, openFile, showAsset, get renderer() { return renderer; }, get asset() { return asset; }, renderAt };
window.__scene = { get renderer() { return renderer; }, get duration() { return duration(); }, pause, renderAt };
try {
  await showAsset(await loadGltf(DEMO_URL, { maxBytes: 8 * 1024 * 1024 }), DEMO_TITLE, DEMO_SETTING);
} catch (error) {
  notice(error.message, true);
}
