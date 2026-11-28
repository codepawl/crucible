import './site-chrome.js';
import './nature-style.css';
import { vec4 } from 'gl-matrix';
import { CrucibleRenderer } from './renderer.js';
import { createNatureWorld } from './nature.js';
import { installMeshBlend } from './mesh-blend.js';
import { attachOrbitControls, createOrbitController } from './site-controls.js';
import { createFlagAnimation } from './nature-flag.js';
import { readQueryNumber } from './query-number.js';

const renderParameters = new URLSearchParams(location.search);
const canvas = document.querySelector('#viewport');
const motionButton = document.querySelector('#motion');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const orbitController = createOrbitController({
  minPitch: 0.03,
  maxPitch: 1.25,
  minDistance: 6,
  maxDistance: 110,
  orbitSpeed: 0.005,
  panSpeed: 0.0016,
  zoomSpeed: 0.001,
  moveSpeed: 0.6,
});
const state = {
  detail: 'balanced', daylight: 1, wind: 0.35, paused: reducedMotion.matches,
  time: 0, azimuth: 0, elevation: 0, distance: 1, target: [0, 0, 0],
  waterRipple: [10000, 0, 10000], rippleTime: -1000,
};
let world = createNatureWorld();
let renderer;
let flagAnimation = null;
let scheduledFrame = 0;
let lastFrameTime = 0;
let noticeTimer;

function syncNatureOrbit() {
  const current = orbitController.state();
  state.azimuth = current.yaw;
  state.elevation = current.pitch;
  state.distance = current.distance;
  state.target = current.target;
}

function notify(message, failure = false) {
  const notice = document.querySelector('#notice');
  notice.textContent = `${failure ? '⚠' : '✓'} ${message}`;
  notice.dataset.failure = String(failure);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  if (!failure) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
}

function setViewpoint(index) {
  const viewpoint = world.points[index];
  const offset = viewpoint.eye.map((value, axis) => value - viewpoint.target[axis]);
  const distance = Math.hypot(...offset);
  const azimuth = Math.atan2(offset[0], offset[2]);
  const elevation = Math.asin(offset[1] / distance);
  orbitController.setHome({
    yaw: azimuth,
    pitch: elevation,
    distance,
    target: [...viewpoint.target],
  }, { apply: true, immediate: true });
  syncNatureOrbit();
  document.querySelector('#viewpoint').value = String(index);
}

function camera() {
  return {
    target: state.target,
    eye: [
      state.target[0] + Math.sin(state.azimuth) * Math.cos(state.elevation) * state.distance,
      state.target[1] + Math.sin(state.elevation) * state.distance,
      state.target[2] + Math.cos(state.azimuth) * Math.cos(state.elevation) * state.distance,
    ],
  };
}

function environment() {
  const daylight = state.daylight;
  const blend = (dusk, day) => day.map((value, axis) => dusk[axis] + (value - dusk[axis]) * daylight);
  return {
    daylight: 0.25 + daylight * 0.75,
    fogColor: blend([0.23, 0.17, 0.25], world.environment.fogColor),
    skyTop: blend([0.16, 0.13, 0.3], world.environment.skyTop),
    skyBottom: blend([0.84, 0.48, 0.36], world.environment.skyBottom),
    lightDirection: blend([-0.8, 0.13, 0.5], world.environment.lightDirection),
    fogDensity: world.environment.fogDensity * (1.25 - daylight * 0.25),
  };
}

function renderFrame() {
  flagAnimation?.update(state.time, state.wind);
  renderer?.render({ ...camera(), time: state.time, wind: state.wind, waterRipple: state.waterRipple, rippleTime: state.rippleTime, environment: environment(), effects: { saturation: 1.06, contrast: 1.03, temperature: (1 - state.daylight) * 0.1, vignette: 0.07, bloom: { strength: 0.1, threshold: 1.2, radius: 1.3 } } });
}

function stopAnimation() {
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  lastFrameTime = 0;
}

function draw(timestamp) {
  scheduledFrame = 0;
  if (!renderer || document.hidden) return;
  const deltaSeconds = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.1) : 0.016;
  if (!state.paused && lastFrameTime) state.time += deltaSeconds;
  lastFrameTime = timestamp;
  const pose = orbitController.step(deltaSeconds);
  if (pose.active) syncNatureOrbit();
  renderFrame();
  if (!state.paused || pose.active) invalidate();
}

function invalidate() {
  if (!scheduledFrame && renderer && !document.hidden) scheduledFrame = requestAnimationFrame(draw);
}

function updateMotionButton() {
  motionButton.textContent = state.paused ? 'Resume motion' : 'Pause motion';
  motionButton.setAttribute('aria-pressed', String(state.paused));
}

function updateStatistics() {
  document.querySelector('#geometry-stat').textContent = `${Math.round(renderer.triangles / 1000)}k triangles, ${renderer.batches.length} draws`;
  document.querySelector('#memory-stat').textContent = `${Math.round(renderer.memoryPlan.estimatedBytes / 1048576)} MB estimated`;
}

function initializeRenderer() {
  // ?softening=0 draws the valley without the seam blend, the flagpole and the flag, to compare frames and frame time.
  const softening = renderParameters.get('softening') !== '0';
  const parts = softening ? world.parts : world.parts.filter(part => part !== world.flag && part.name !== 'Flagpole').map(({ blend, ...part }) => part);
  renderer = new CrucibleRenderer(canvas, parts, {
    world: true, ground: false, hdr: true, depth: softening, environment: world.environment,
    pixelRatio: renderParameters.get('export') === '1' ? 1 : 1.25, memoryBudgetMiB: readQueryNumber(renderParameters, 'memory', 256, { minimum: 1 }),
    samples: readQueryNumber(renderParameters, 'samples', 4, { minimum: 1, integer: true }),
  });
  if (softening) installMeshBlend(renderer);
  flagAnimation = softening ? createFlagAnimation(renderer, world.flag) : null;
  updateStatistics();
  renderFrame();
  invalidate();
}

function renderAt(time) {
  if (!Number.isFinite(time)) throw new TypeError('Render time must be finite.');
  stopAnimation();
  state.paused = true;
  state.time = time;
  updateMotionButton();
  renderFrame();
}

function waterHit(clientX, clientY) {
  if (!renderer) return null;
  const rectangle = canvas.getBoundingClientRect();
  const horizontal = (clientX - rectangle.left) / rectangle.width * 2 - 1;
  const vertical = 1 - (clientY - rectangle.top) / rectangle.height * 2;
  const near = vec4.transformMat4(vec4.create(), [horizontal, vertical, -1, 1], renderer.inverseViewProjection);
  const far = vec4.transformMat4(vec4.create(), [horizontal, vertical, 1, 1], renderer.inverseViewProjection);
  const origin = Array.from(near.subarray(0, 3)).map(value => value / near[3]);
  const end = Array.from(far.subarray(0, 3)).map(value => value / far[3]);
  const direction = end.map((value, axis) => value - origin[axis]);
  if (Math.abs(direction[1]) < 1e-6) return null;
  const distance = (0.22 - origin[1]) / direction[1];
  if (distance < 0 || distance > 1) return null;
  const position = origin.map((value, axis) => value + direction[axis] * distance);
  const water = world.parts.find(part => part.material.tag === 'water').geometry.positions;
  const firstDepth = water[2];
  const lastDepth = water[water.length - 1];
  if (position[2] < firstDepth || position[2] >= lastDepth) return null;
  const along = (position[2] - firstDepth) / (lastDepth - firstDepth) * (water.length / 6 - 1);
  const row = Math.floor(along);
  const fraction = along - row;
  const left = water[row * 6] + (water[(row + 1) * 6] - water[row * 6]) * fraction;
  const right = water[row * 6 + 3] + (water[(row + 1) * 6 + 3] - water[row * 6 + 3]) * fraction;
  return position[0] >= left && position[0] <= right ? position : null;
}

world.points.forEach((viewpoint, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = viewpoint.name;
  document.querySelector('#viewpoint').append(option);
});
setViewpoint(0);
updateMotionButton();
try { initializeRenderer(); } catch (error) { notify(error.message, true); }

window.__nature = { get world() { return world; }, get renderer() { return renderer; }, state, camera, environment, renderAt, waterHit };

document.querySelector('#viewpoint').addEventListener('change', event => {
  setViewpoint(Number(event.target.value));
  invalidate();
});
document.querySelector('#daylight').addEventListener('input', event => {
  state.daylight = Number(event.target.value);
  document.querySelector('#daylight-value').textContent = state.daylight > 0.7 ? 'Day' : state.daylight > 0.3 ? 'Golden' : 'Dusk';
  invalidate();
});
document.querySelector('#wind').addEventListener('input', event => {
  state.wind = Number(event.target.value);
  document.querySelector('#wind-value').textContent = state.wind < 0.1 ? 'Still' : state.wind < 0.55 ? 'Gentle' : 'Breezy';
  invalidate();
});
document.querySelectorAll('[data-daylight]').forEach(button => button.addEventListener('click', () => {
  const slider = document.querySelector('#daylight');
  slider.value = button.dataset.daylight;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}));
motionButton.addEventListener('click', () => {
  state.paused = !state.paused;
  lastFrameTime = 0;
  updateMotionButton();
  invalidate();
});
document.querySelector('#detail').addEventListener('change', event => {
  stopAnimation();
  const previousDetail = state.detail;
  const previousWorld = world;
  try {
    const nextWorld = createNatureWorld({ detail: event.target.value });
    renderer?.dispose();
    renderer = null;
    world = nextWorld;
    state.detail = event.target.value;
    initializeRenderer();
  } catch (error) {
    world = previousWorld;
    state.detail = previousDetail;
    event.target.value = previousDetail;
    if (!renderer) {
      try { initializeRenderer(); } catch { renderer = null; }
    }
    notify(`Scene could not load: ${error.message}`, true);
  }
});

attachOrbitControls(canvas, orbitController, {
  keyTarget: canvas,
  onTap: event => {
    const position = waterHit(event.clientX, event.clientY);
    if (position) {
      state.waterRipple = position;
      state.rippleTime = state.time;
      invalidate();
    }
  },
  onChange: () => {
    syncNatureOrbit();
    invalidate();
  },
});
canvas.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const actions = {
    '+': () => orbitController.zoomBy(-105),
    '=': () => orbitController.zoomBy(-105),
    '-': () => orbitController.zoomBy(95),
    ' ': () => { motionButton.click(); },
  };
  const action = actions[event.key];
  if (action) {
    event.preventDefault();
    action();
    syncNatureOrbit();
    invalidate();
  }
});

document.querySelector('#save-image').addEventListener('click', event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    renderFrame();
    canvas.toBlob(blob => {
      button.disabled = false;
      if (!blob) return notify('Image capture failed.', true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'crucible-silverwater-valley.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Landscape saved.');
    }, 'image/png');
  } catch (error) {
    button.disabled = false;
    notify(`Image capture failed: ${error.message}`, true);
  }
});

const resizeObserver = new ResizeObserver(() => {
  if (!renderer) return;
  renderer.resize();
  updateStatistics();
  invalidate();
});
resizeObserver.observe(canvas);
document.addEventListener('visibilitychange', () => {
  stopAnimation();
  if (!document.hidden) invalidate();
});
reducedMotion.addEventListener('change', event => {
  if (event.matches) {
    state.paused = true;
    updateMotionButton();
    invalidate();
  }
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  stopAnimation();
  // Release while the context is lost; restored contexts reject stale GPU handles.
  renderer?.dispose();
  renderer = null;
  notify('Graphics paused. Waiting for the browser to restore them.', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  try {
    initializeRenderer();
    notify('Graphics restored.');
  } catch (error) { notify(error.message, true); }
});
window.addEventListener('pagehide', () => {
  stopAnimation();
  resizeObserver.disconnect();
  renderer?.dispose();
  renderer = null;
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  try {
    initializeRenderer();
    resizeObserver.observe(canvas);
  } catch (error) { notify(error.message, true); }
});
