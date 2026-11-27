// The local page behind scene_ask_user (issue #922): it shows one rendered view, lets the person place pin, lasso, colour
// and saved view marks with a short note each, and returns the marks when they press Send. It listens on loopback only, under a
// random path, with no remote assets.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isPreviewHost } from './preview-host.mjs';
import { ANNOTATE_LIMITS, validateMarks, validateViewCamera, isBoundedPng } from '../src/agent-annotate.js';

const MAXIMUM_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_CAMERA = Object.freeze({ eye: [0, 2, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45 });

// Shared with the inline MCP Apps view (scripts/annotate-app-view.mjs) so both look the same.
export function annotateStyle(width) {
  return `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#182126;color:#e8eef0;font:15px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:16px;padding:20px;user-select:none}
h1{margin:0;font-size:18px;font-weight:600}
main{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.stage{position:relative;line-height:0;flex:0 1 ${width}px;max-width:100%;cursor:crosshair;user-select:none}
.stage img{width:100%;height:auto;border-radius:8px;display:block}
.stage.lasso{cursor:cell;touch-action:none}
.stage.view{cursor:grab;touch-action:none}
.stage.view:active{cursor:grabbing}
.outline{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.outline polygon,.outline polyline{fill:rgba(255,90,79,.22);stroke:#ff5a4f;stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.outline polyline{fill:none;stroke:#fff}
.tools{display:flex;gap:4px;flex-wrap:nowrap}
.tool{padding:0 8px;gap:5px;background:#202c33;color:#d6e0e4;font-size:13px;white-space:nowrap}
.tool svg{width:16px;height:16px}
.tool-options{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#202c33;padding:8px 10px;border-radius:8px}
.tool-options[hidden]{display:none}
.tool-options label{font-size:13px;color:#9db0b8}
.tf-grid{display:grid;grid-template-columns:46px repeat(3,minmax(0,1fr));gap:6px;align-items:center;width:100%}
.tf-label{font-size:13px;color:#9db0b8}
.tf-field{display:flex;align-items:center;gap:4px;background:#26343b;border-radius:6px;padding:0 6px;height:32px;min-width:0}
.tf-field span{font-size:12px;color:#9db0b8;flex:none}
.tf-field input[type=number]{width:100%;height:30px;padding:0;background:transparent;min-width:0;font-size:13px}
.tf-field input[type=number]:focus{outline:none}
.tf-field:focus-within{outline:2px solid #6fb7ff}
.tf-reset{height:32px;padding:0 10px;font-size:13px;background:#26343b;justify-content:center}
input[type=color]{flex:none;width:40px;height:36px;padding:2px;border-radius:6px;background:#26343b;cursor:pointer}
input[type=number]{flex:none;width:72px;height:36px}
input[type=range]{flex:1;min-width:90px;height:24px;padding:0;background:transparent;accent-color:#2f7dd1;cursor:pointer}
input[type=number].time-num{width:68px;height:32px;font-size:13px}
.color-hex,.view-summary{font-family:ui-monospace,monospace;font-size:12px;color:#9db0b8}
.pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none}
.pin.transform,.badge.transform{background:#0f766e;color:#fff}
aside{flex:1 1 340px;max-width:440px;display:flex;flex-direction:column;gap:12px;user-select:none}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{flex:none;width:26px;height:26px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center}
.badge.view{background:#2f7dd1;color:#fff}
.row-swatch{flex:none;width:30px;height:36px;padding:2px;border-radius:6px;background:#26343b;cursor:pointer}
.row-meta{flex:none;font-size:12px;color:#9db0b8;background:#202c33;padding:4px 7px;border-radius:6px}
input{flex:1 1 150px;min-width:0;height:36px;border:0;border-radius:6px;background:#26343b;color:inherit;padding:0 10px;font:inherit;user-select:text}
input:focus{outline:2px solid #6fb7ff}
button{height:36px;border:0;border-radius:6px;padding:0 14px;font:inherit;color:inherit;background:transparent;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
button:hover{background:#26343b}
button[aria-pressed=true],button[aria-pressed=true]:hover{background:#2f7dd1;color:#fff}
button[aria-pressed=true] svg .icon-fill{fill:currentColor}
button.primary{background:#2f7dd1;color:#fff}
button.primary:hover{background:#3a8ae0}
button.icon{width:36px;padding:0;justify-content:center;flex:none}
button:disabled{opacity:.5;cursor:default}
svg{width:18px;height:18px;flex:none}
.actions{display:flex;gap:8px;margin-top:4px}
.hint,.count{color:#9db0b8}
.done{display:flex;gap:10px;align-items:center;font-size:17px}
.done svg{width:26px;height:26px}
.ok{color:#58d68d}.stop{color:#f0b429}
`;
}

export function annotateToolbarMarkup() {
  return `<div class="tools" role="group" aria-label="Mark type">
<button class="tool" id="tool-pin" aria-pressed="true" aria-label="Pin" title="Pin: click a spot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-fill" fill-rule="evenodd" d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zm0-13a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg><span>Pin</span></button>
<button class="tool" id="tool-lasso" aria-pressed="false" aria-label="Lasso" title="Lasso: draw around a region"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-fill" d="M12 4C7 4 3 6.5 3 10s4 6 9 6 9-2.5 9-6-4-6-9-6z"/><path d="M9 16c-1 2-1 3.5 1 4"/></svg><span>Lasso</span></button>
<button class="tool" id="tool-color" aria-pressed="false" aria-label="Color" title="Color: click a part and pick its colour"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-fill" d="M12 3l5.5 6.5a6.5 6.5 0 1 1-11 0L12 3z"/></svg><span>Color</span></button>
<button class="tool" id="tool-view" aria-pressed="false" aria-label="Save view" title="View: frame the camera and save a view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-fill" fill-rule="evenodd" d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg><span>Save view</span></button>
<button class="tool" id="tool-transform" aria-pressed="false" aria-label="Transform" title="Transform: click a part with move, rotate or scale deltas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-fill" d="M12 2l3 3h-2v6h6V9l3 3-3 3v-2h-6v6h2l-3 3-3-3h2v-6H5v2l-3-3 3-3v2h6V5H9l3-3z"/></svg><span>Transform</span></button>
</div>
<div class="tool-options" id="color-options" hidden>
<label for="color-picker">Target colour</label>
<input type="color" id="color-picker" value="#ff5a4f" aria-label="Target colour">
<span class="color-hex" id="color-hex">#ff5a4f</span>
</div>
<div class="tool-options" id="view-options" hidden>
<label for="view-fov">FOV</label>
<input type="number" id="view-fov" min="5" max="120" step="1" aria-label="Field of view">
<button type="button" class="primary" id="capture-view">Save view</button>
<button type="button" id="reset-view">Reset</button>
<span class="view-summary" id="view-summary"></span>
</div>
<div class="tool-options" id="transform-options" hidden>
<div class="tf-grid">
<span class="tf-label">Move</span>
<label class="tf-field"><span>dX</span><input type="number" id="tf-dx" value="0" step="0.1" min="-1000" max="1000" aria-label="Move dX"></label>
<label class="tf-field"><span>dY</span><input type="number" id="tf-dy" value="0" step="0.1" min="-1000" max="1000" aria-label="Move dY"></label>
<label class="tf-field"><span>dZ</span><input type="number" id="tf-dz" value="0" step="0.1" min="-1000" max="1000" aria-label="Move dZ"></label>
<span class="tf-label">Rotate</span>
<label class="tf-field"><span>rX</span><input type="number" id="tf-rx" value="0" step="5" min="-360" max="360" aria-label="Rotate rX"></label>
<label class="tf-field"><span>rY</span><input type="number" id="tf-ry" value="0" step="5" min="-360" max="360" aria-label="Rotate rY"></label>
<label class="tf-field"><span>rZ</span><input type="number" id="tf-rz" value="0" step="5" min="-360" max="360" aria-label="Rotate rZ"></label>
<span class="tf-label">Scale</span>
<label class="tf-field"><span>s</span><input type="number" id="tf-s" value="1" step="0.1" min="0.01" max="100" aria-label="Scale s"></label>
<button type="button" class="tf-reset" id="reset-transform">Reset</button>
</div>
</div>
<div class="tool-options" id="motion-options" hidden>
<label for="motion-time">Time</label>
<input type="range" id="motion-scrub" min="0" max="10" step="0.01" value="0" aria-label="Motion time scrubber">
<input type="number" class="time-num" id="motion-time" min="0" max="3600" step="0.01" value="0" aria-label="Motion time seconds">
<span class="view-summary" id="motion-duration"></span>
</div>`;
}

function pageHtml({ prompt, width, height, maxMarks, maxNoteLength, camera, motion, canRender }) {
  const escaped = prompt.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  const limits = {
    width,
    height,
    maxMarks,
    maxNoteLength,
    minLassoPoints: ANNOTATE_LIMITS.minLassoPoints,
    maxLassoPoints: ANNOTATE_LIMITS.maxLassoPoints,
    minViewFov: ANNOTATE_LIMITS.minViewFov,
    maxViewFov: ANNOTATE_LIMITS.maxViewFov,
    camera,
    ...(motion ? { motion } : {}),
    canRender,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Mark the scene</title><style>${annotateStyle(width)}</style></head><body>
<h1>${escaped || 'Click the scene to mark what you mean'}</h1>
<main>
<div class="stage" id="stage"><img id="frame" src="frame.png" width="${width}" height="${height}" alt="Rendered scene"></div>
<aside id="side">
${annotateToolbarMarkup()}
<div class="hint" id="hint">Click the picture to drop a pin, draw with lasso, pick a colour, save a view, or set a transform.</div>
<div id="rows" style="display:flex;flex-direction:column;gap:8px"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="send">Send</button><button id="cancel">Cancel</button></div>
</aside>
</main>
<script type="application/json" id="limits">${JSON.stringify(limits)}</script>
<script src="app.js"></script>
</body></html>`;
}

// Served as its own file because the page's content security policy allows scripts from this origin only.
const PAGE_SCRIPT = `(() => {
const limits = JSON.parse(document.getElementById('limits').textContent);
const marks = [];
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const rows = document.getElementById('rows');
const count = document.getElementById('count');
const hint = document.getElementById('hint');
const sendButton = document.getElementById('send');
const colorOptions = document.getElementById('color-options');
const colorPicker = document.getElementById('color-picker');
const colorHex = document.getElementById('color-hex');
const viewOptions = document.getElementById('view-options');
const viewFovInput = document.getElementById('view-fov');
const viewSummary = document.getElementById('view-summary');
const captureViewButton = document.getElementById('capture-view');
const resetViewButton = document.getElementById('reset-view');
const transformOptions = document.getElementById('transform-options');
const tfDx = document.getElementById('tf-dx');
const tfDy = document.getElementById('tf-dy');
const tfDz = document.getElementById('tf-dz');
const tfRx = document.getElementById('tf-rx');
const tfRy = document.getElementById('tf-ry');
const tfRz = document.getElementById('tf-rz');
const tfS = document.getElementById('tf-s');
const resetTransformButton = document.getElementById('reset-transform');
const motionOptions = document.getElementById('motion-options');
const motionScrub = document.getElementById('motion-scrub');
const motionTimeInput = document.getElementById('motion-time');
const motionDuration = document.getElementById('motion-duration');
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
const svgNamespace = 'http://www.w3.org/2000/svg';
const outline = document.createElementNS(svgNamespace, 'svg');
outline.setAttribute('class', 'outline');
outline.setAttribute('viewBox', '0 0 ' + limits.width + ' ' + limits.height);
outline.setAttribute('preserveAspectRatio', 'none');
stage.appendChild(outline);
const initialFrameSource = frame.getAttribute('src');
function cloneCamera(source) {
  return { eye: source.eye.slice(0, 3), target: source.target.slice(0, 3), up: (source.up || [0, 1, 0]).slice(0, 3), fov: source.fov };
}
function roundVector(vector) {
  return vector.map(component => Math.round(component * 1000) / 1000);
}
function roundTime(value) {
  return Math.round(Math.max(0, Math.min(3600, value)) * 1000) / 1000;
}
function camerasMatch(first, second) {
  const sameVector = (left, right) => left.every((component, index) => Math.abs(component - right[index]) < 1e-4);
  return sameVector(first.eye, second.eye) && sameVector(first.target, second.target) && Math.abs(first.fov - second.fov) < 1e-3;
}
const initialCamera = cloneCamera(limits.camera);
let markingCamera = cloneCamera(initialCamera);
let markingFrameSource = initialFrameSource;
let viewCamera = cloneCamera(initialCamera);
const hasMotion = Boolean(limits.motion);
let activeTime = hasMotion ? roundTime(Number(limits.motion.time) || 0) : 0;
let previewBlobUrl = null;
let renderTimer = null;
let tool = 'pin';
let drawing = null;
let orbiting = null;
const toolButtons = {
  pin: document.getElementById('tool-pin'),
  lasso: document.getElementById('tool-lasso'),
  color: document.getElementById('tool-color'),
  view: document.getElementById('tool-view'),
  transform: document.getElementById('tool-transform'),
};
function hasPixelMarks() {
  return marks.some(mark => mark.kind !== 'view');
}
function syncMotionControls() {
  if (!hasMotion) {
    motionOptions.hidden = true;
    return;
  }
  motionOptions.hidden = false;
  const duration = Number(limits.motion.duration) || 0;
  motionScrub.max = String(Math.max(0.01, Math.min(3600, duration)));
  motionScrub.value = String(Math.min(Number(motionScrub.max), activeTime));
  motionTimeInput.value = String(activeTime);
  motionDuration.textContent = '/ ' + roundTime(duration) + 's';
}
function updateViewReadout() {
  viewFovInput.value = String(Math.round(viewCamera.fov));
  const eye = roundVector(viewCamera.eye);
  const target = roundVector(viewCamera.target);
  viewSummary.textContent = 'eye [' + eye.join(', ') + '] target [' + target.join(', ') + ']';
}
async function renderCameraPreview(camera, motionTime) {
  if (!limits.canRender) return;
  try {
    const body = hasMotion ? { camera, motionTime } : { camera };
    const response = await fetch('render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) return;
    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);
    frame.src = nextUrl;
    if (camerasMatch(camera, markingCamera)) markingFrameSource = nextUrl;
    if (previewBlobUrl && previewBlobUrl !== markingFrameSource) URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = nextUrl;
  } catch (error) {
    hint.textContent = error.message;
  }
}
function scheduleCameraRender() {
  if (!limits.canRender) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderCameraPreview(viewCamera, hasMotion ? activeTime : undefined), 60);
}
function chooseTool(name) {
  const previousTool = tool;
  tool = name;
  stage.classList.toggle('lasso', name === 'lasso');
  stage.classList.toggle('view', name === 'view');
  colorOptions.hidden = name !== 'color';
  viewOptions.hidden = name !== 'view';
  transformOptions.hidden = name !== 'transform';
  Object.entries(toolButtons).forEach(([key, button]) => button.setAttribute('aria-pressed', String(key === name)));
  if (previousTool === 'view' && name !== 'view') {
    if (!hasPixelMarks()) {
      markingCamera = cloneCamera(viewCamera);
      markingFrameSource = frame.src;
    } else if (!camerasMatch(viewCamera, markingCamera)) {
      viewCamera = cloneCamera(markingCamera);
      frame.src = markingFrameSource;
    }
  }
  updateViewReadout();
  render();
}
toolButtons.pin.addEventListener('click', () => chooseTool('pin'));
toolButtons.lasso.addEventListener('click', () => chooseTool('lasso'));
toolButtons.color.addEventListener('click', () => chooseTool('color'));
toolButtons.view.addEventListener('click', () => chooseTool('view'));
toolButtons.transform.addEventListener('click', () => chooseTool('transform'));
colorPicker.addEventListener('input', () => { colorHex.textContent = colorPicker.value.toLowerCase(); });
resetTransformButton.addEventListener('click', () => {
  tfDx.value = '0'; tfDy.value = '0'; tfDz.value = '0';
  tfRx.value = '0'; tfRy.value = '0'; tfRz.value = '0';
  tfS.value = '1';
});
motionScrub.addEventListener('input', () => {
  const parsed = Number(motionScrub.value);
  if (!Number.isFinite(parsed)) return;
  activeTime = roundTime(parsed);
  motionTimeInput.value = String(activeTime);
  scheduleCameraRender();
});
motionTimeInput.addEventListener('change', () => {
  const parsed = Number(motionTimeInput.value);
  if (Number.isFinite(parsed)) activeTime = roundTime(parsed);
  syncMotionControls();
  scheduleCameraRender();
});
function contrastTextColor(hex) {
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.55 ? '#11181c' : '#fff';
}
function pointsText(points) {
  return points.map(point => point[0].toFixed(1) + ',' + point[1].toFixed(1)).join(' ');
}
function markCentre(mark) {
  if (mark.points === undefined) return [mark.x, mark.y];
  const total = mark.points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  return [total[0] / mark.points.length, total[1] / mark.points.length];
}
// A pen stroke has hundreds of points; the answer allows maxLassoPoints, so keep evenly spaced ones.
function thinned(points) {
  if (points.length <= limits.maxLassoPoints) return points;
  return Array.from({ length: limits.maxLassoPoints }, (unused, index) => points[Math.floor(index * points.length / limits.maxLassoPoints)]);
}
function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function crossVectors(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}
function orbitCameraBy(deltaX, deltaY) {
  const offset = [0, 1, 2].map(axis => viewCamera.eye[axis] - viewCamera.target[axis]);
  const radius = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const azimuth = Math.atan2(offset[0], offset[2]) - deltaX * 0.008;
  const elevation = Math.max(-1.48, Math.min(1.48, Math.asin(Math.max(-1, Math.min(1, offset[1] / radius))) + deltaY * 0.008));
  const horizontal = radius * Math.cos(elevation);
  viewCamera.eye = [
    viewCamera.target[0] + horizontal * Math.sin(azimuth),
    viewCamera.target[1] + radius * Math.sin(elevation),
    viewCamera.target[2] + horizontal * Math.cos(azimuth),
  ];
}
function panCameraBy(deltaX, deltaY) {
  const offset = [0, 1, 2].map(axis => viewCamera.target[axis] - viewCamera.eye[axis]);
  const distance = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const forward = normalizeVector(offset);
  const right = normalizeVector(crossVectors(forward, viewCamera.up));
  const cameraUp = normalizeVector(crossVectors(right, forward));
  const step = distance * 0.002;
  for (let axis = 0; axis < 3; axis++) {
    const shift = (-deltaX * right[axis] + deltaY * cameraUp[axis]) * step;
    viewCamera.eye[axis] += shift;
    viewCamera.target[axis] += shift;
  }
}
function zoomCameraBy(deltaY) {
  const offset = [0, 1, 2].map(axis => viewCamera.eye[axis] - viewCamera.target[axis]);
  const distance = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const nextDistance = Math.max(0.2, Math.min(500, distance * Math.exp(deltaY * 0.0012)));
  const scale = nextDistance / distance;
  viewCamera.eye = [0, 1, 2].map(axis => viewCamera.target[axis] + offset[axis] * scale);
}
function transformSummary(mark) {
  const parts = [];
  if (mark.deltaPosition) parts.push('d(' + mark.deltaPosition.join(',') + ')');
  if (mark.deltaRotation) parts.push('r(' + mark.deltaRotation.join(',') + ')');
  if (mark.scaleFactor !== undefined) parts.push('s' + (Array.isArray(mark.scaleFactor) ? mark.scaleFactor.join(',') : mark.scaleFactor));
  return parts.join(' ');
}
function readTransformInputs() {
  const pos = [Number(tfDx.value), Number(tfDy.value), Number(tfDz.value)];
  const rot = [Number(tfRx.value), Number(tfRy.value), Number(tfRz.value)];
  const scale = Number(tfS.value);
  if (!pos.every(value => Number.isFinite(value) && value >= -1000 && value <= 1000)) {
    hint.textContent = 'Move dX, dY, dZ must be numbers from -1000 to 1000.';
    return null;
  }
  if (!rot.every(value => Number.isFinite(value) && value >= -360 && value <= 360)) {
    hint.textContent = 'Rotate rX, rY, rZ must be degrees from -360 to 360.';
    return null;
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) {
    hint.textContent = 'Scale must be greater than 0 and at most 100.';
    return null;
  }
  const cleanPos = roundVector(pos);
  const cleanRot = roundVector(rot);
  const cleanScale = Math.round(scale * 1000) / 1000 || scale;
  const hasMove = cleanPos.some(value => value !== 0);
  const hasRotate = cleanRot.some(value => value !== 0);
  const hasScale = cleanScale !== 1;
  if (!hasMove && !hasRotate && !hasScale) {
    hint.textContent = 'Set at least one Move, Rotate or Scale value before clicking a part.';
    tfDx.focus();
    return null;
  }
  return {
    ...(hasMove ? { deltaPosition: cleanPos } : {}),
    ...(hasRotate ? { deltaRotation: cleanRot } : {}),
    ...(hasScale ? { scaleFactor: cleanScale } : {}),
  };
}
function render() {
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  outline.textContent = '';
  rows.textContent = '';
  const hideSpatialOverlay = tool === 'view' && !camerasMatch(viewCamera, markingCamera);
  marks.forEach((mark, index) => {
    if (mark.kind !== 'view' && !hideSpatialOverlay) {
      const centre = markCentre(mark);
      if (mark.points !== undefined) {
        const shape = document.createElementNS(svgNamespace, 'polygon');
        shape.setAttribute('points', pointsText(mark.points));
        outline.appendChild(shape);
      }
      const pin = document.createElement('div');
      pin.className = mark.kind === 'transform' ? 'pin transform' : 'pin';
      pin.textContent = index + 1;
      pin.style.left = (centre[0] / limits.width * 100) + '%';
      pin.style.top = (centre[1] / limits.height * 100) + '%';
      if (mark.kind === 'color') {
        pin.style.background = mark.hex;
        pin.style.color = contrastTextColor(mark.hex);
      } else if (mark.kind === 'transform') {
        pin.title = transformSummary(mark);
      }
      stage.appendChild(pin);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = mark.kind === 'view' ? 'badge view' : (mark.kind === 'transform' ? 'badge transform' : 'badge');
    badge.textContent = index + 1;
    if (mark.kind === 'color') {
      badge.style.background = mark.hex;
      badge.style.color = contrastTextColor(mark.hex);
    }
    row.appendChild(badge);
    if (mark.kind === 'color') {
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'row-swatch';
      swatch.value = mark.hex;
      swatch.setAttribute('aria-label', 'Mark ' + (index + 1) + ' colour');
      swatch.addEventListener('input', () => {
        mark.hex = swatch.value.toLowerCase();
        render();
      });
      row.appendChild(swatch);
    } else if (mark.kind === 'view') {
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      meta.textContent = 'FOV ' + Math.round(mark.camera.fov);
      meta.title = 'eye [' + mark.camera.eye.join(', ') + '] target [' + mark.camera.target.join(', ') + ']';
      row.appendChild(meta);
    } else if (mark.kind === 'transform') {
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      meta.textContent = transformSummary(mark);
      row.appendChild(meta);
    }
    if (mark.time !== undefined) {
      const timeTag = document.createElement('span');
      timeTag.className = 'row-meta';
      timeTag.textContent = mark.time + 's';
      row.appendChild(timeTag);
    }
    const input = document.createElement('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = mark.kind === 'view' ? 'Why this view?' : (mark.kind === 'color' ? 'Colour note' : (mark.kind === 'transform' ? 'Transform note' : 'What should change here?'));
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove mark';
    remove.setAttribute('aria-label', 'Remove mark ' + (index + 1));
    remove.innerHTML = trash;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); });
    row.append(input, remove);
    rows.appendChild(row);
    mark.input = input;
  });
  count.textContent = marks.length + ' of ' + limits.maxMarks + ' marks';
  sendButton.disabled = marks.length === 0;
  captureViewButton.disabled = marks.length >= limits.maxMarks;
}
function pixelOf(event) {
  const box = frame.getBoundingClientRect();
  const x = Math.min(limits.width, Math.max(0, (event.clientX - box.left) / box.width * limits.width));
  const y = Math.min(limits.height, Math.max(0, (event.clientY - box.top) / box.height * limits.height));
  return [x, y];
}
function polygonArea(points) {
  let twice = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    twice += point[0] * next[1] - next[0] * point[1];
  });
  return Math.abs(twice) / 2;
}
stage.addEventListener('click', event => {
  if ((tool !== 'pin' && tool !== 'color' && tool !== 'transform') || marks.length >= limits.maxMarks) return;
  const [x, y] = pixelOf(event);
  const timeField = hasMotion ? { time: activeTime } : {};
  if (tool === 'color') {
    marks.push({ kind: 'color', x, y, hex: colorPicker.value.toLowerCase(), note: '', ...timeField });
  } else if (tool === 'transform') {
    const delta = readTransformInputs();
    if (!delta) return;
    marks.push({ kind: 'transform', x, y, ...delta, note: '', ...timeField });
  } else {
    marks.push({ x, y, note: '', ...timeField });
  }
  render();
  marks[marks.length - 1].input.focus();
});
stage.addEventListener('contextmenu', event => { if (tool === 'view') event.preventDefault(); });
stage.addEventListener('pointerdown', event => {
  if (tool === 'view' && (event.button === 0 || event.button === 2)) {
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    orbiting = { lastX: event.clientX, lastY: event.clientY, pan: event.shiftKey || event.button === 2 };
    return;
  }
  if (tool !== 'lasso' || marks.length >= limits.maxMarks || event.button !== 0) return;
  event.preventDefault();
  stage.setPointerCapture(event.pointerId);
  const trail = document.createElementNS(svgNamespace, 'polyline');
  outline.appendChild(trail);
  drawing = { points: [pixelOf(event)], trail };
});
stage.addEventListener('pointermove', event => {
  if (orbiting) {
    const deltaX = event.clientX - orbiting.lastX;
    const deltaY = event.clientY - orbiting.lastY;
    orbiting.lastX = event.clientX;
    orbiting.lastY = event.clientY;
    if (orbiting.pan || event.shiftKey) panCameraBy(deltaX, deltaY);
    else orbitCameraBy(deltaX, deltaY);
    updateViewReadout();
    render();
    scheduleCameraRender();
    return;
  }
  if (!drawing) return;
  const point = pixelOf(event);
  const last = drawing.points[drawing.points.length - 1];
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 3) return;
  drawing.points.push(point);
  drawing.trail.setAttribute('points', pointsText(drawing.points));
});
function endPointer(event) {
  if (orbiting) {
    orbiting = null;
    scheduleCameraRender();
    return;
  }
  if (!drawing) return;
  const points = thinned(drawing.points);
  drawing = null;
  if (points.length >= limits.minLassoPoints && polygonArea(points) >= 1) {
    marks.push({ kind: 'lasso', points, note: '', ...(hasMotion ? { time: activeTime } : {}) });
  }
  render();
  if (marks.length && marks[marks.length - 1].points === points) marks[marks.length - 1].input.focus();
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', event => {
  if (tool !== 'view') return;
  event.preventDefault();
  zoomCameraBy(event.deltaY);
  updateViewReadout();
  render();
  scheduleCameraRender();
}, { passive: false });
viewFovInput.addEventListener('change', () => {
  const parsed = Number(viewFovInput.value);
  const clamped = Number.isFinite(parsed) ? Math.max(limits.minViewFov, Math.min(limits.maxViewFov, parsed)) : viewCamera.fov;
  viewCamera.fov = clamped;
  updateViewReadout();
  scheduleCameraRender();
});
captureViewButton.addEventListener('click', () => {
  if (marks.length >= limits.maxMarks) return;
  marks.push({
    kind: 'view',
    camera: { eye: roundVector(viewCamera.eye), target: roundVector(viewCamera.target), fov: Math.round(viewCamera.fov * 100) / 100 },
    note: '',
    ...(hasMotion ? { time: activeTime } : {}),
  });
  render();
  marks[marks.length - 1].input.focus();
});
resetViewButton.addEventListener('click', () => {
  viewCamera = cloneCamera(initialCamera);
  updateViewReadout();
  render();
  if (limits.canRender) {
    if (hasMotion) {
      renderCameraPreview(viewCamera, activeTime);
    } else {
      frame.src = initialFrameSource;
      if (!hasPixelMarks()) {
        markingCamera = cloneCamera(initialCamera);
        markingFrameSource = initialFrameSource;
      }
    }
  }
});
function serializeMark(mark) {
  const timeField = mark.time !== undefined ? { time: mark.time } : {};
  if (mark.kind === 'lasso') return { kind: 'lasso', points: mark.points, note: mark.note, ...timeField };
  if (mark.kind === 'color') return { kind: 'color', x: mark.x, y: mark.y, hex: mark.hex, note: mark.note, ...timeField };
  if (mark.kind === 'view') return { kind: 'view', camera: mark.camera, note: mark.note, ...timeField };
  if (mark.kind === 'transform') {
    return {
      kind: 'transform',
      x: mark.x,
      y: mark.y,
      ...(mark.deltaPosition !== undefined ? { deltaPosition: mark.deltaPosition } : {}),
      ...(mark.deltaRotation !== undefined ? { deltaRotation: mark.deltaRotation } : {}),
      ...(mark.scaleFactor !== undefined ? { scaleFactor: mark.scaleFactor } : {}),
      note: mark.note,
      ...timeField,
    };
  }
  return { x: mark.x, y: mark.y, note: mark.note, ...timeField };
}
function drawPill(context, x, y, text) {
  context.font = '600 11px system-ui, sans-serif';
  const width = Math.ceil(context.measureText(text).width) + 12;
  const height = 18;
  const left = Math.max(4, Math.min(limits.width - width - 4, x));
  const top = Math.max(4, Math.min(limits.height - height - 4, y));
  context.fillStyle = 'rgba(24,33,38,0.88)';
  context.fillRect(left, top, width, height);
  context.lineWidth = 1;
  context.strokeStyle = '#fff';
  context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
  context.fillStyle = '#fff';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, left + 6, top + height / 2 + 0.5);
}
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.width;
  canvas.height = limits.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, limits.width, limits.height);
  marks.forEach(mark => {
    if (mark.points === undefined) return;
    context.beginPath();
    mark.points.forEach((point, index) => (index === 0 ? context.moveTo(point[0], point[1]) : context.lineTo(point[0], point[1])));
    context.closePath();
    context.fillStyle = 'rgba(255,90,79,0.22)';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#ff5a4f';
    context.stroke();
  });
  let viewBadgeRow = 0;
  marks.forEach((mark, index) => {
    if (mark.kind === 'view') {
      if (mark.time !== undefined) {
        drawPill(context, 8, 8 + viewBadgeRow * 22, (index + 1) + ' view ' + mark.time + 's');
        viewBadgeRow += 1;
      }
      return;
    }
    const [centreX, centreY] = markCentre(mark);
    context.beginPath();
    context.arc(centreX, centreY, 14, 0, Math.PI * 2);
    context.fillStyle = mark.kind === 'color' ? mark.hex : (mark.kind === 'transform' ? '#0f766e' : '#ff5a4f');
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.font = '600 15px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = mark.kind === 'color' ? contrastTextColor(mark.hex) : '#fff';
    context.fillText(String(index + 1), centreX, centreY + 1);
    if (mark.kind === 'transform' || mark.time !== undefined) {
      const parts = [];
      if (mark.kind === 'transform') parts.push('T ' + transformSummary(mark));
      if (mark.time !== undefined) parts.push(mark.time + 's');
      const label = parts.join(' ');
      const pillX = centreX + 18 + label.length * 6.5 > limits.width - 6 ? centreX - 18 - label.length * 6.5 - 12 : centreX + 18;
      drawPill(context, pillX, centreY - 9, label);
    }
  });
  return canvas.toDataURL('image/png').split(',')[1];
}
function finish(kind, text) {
  const icon = kind === 'ok'
    ? '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>'
    : '<svg class="stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>';
  document.getElementById('side').innerHTML = '<div class="done">' + icon + '<span>' + text + '</span></div>';
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()) || 'The request failed.');
}
sendButton.addEventListener('click', async () => {
  if (tool === 'view' && !hasPixelMarks()) {
    markingCamera = cloneCamera(viewCamera);
    markingFrameSource = frame.src;
  } else if (tool === 'view' && !camerasMatch(viewCamera, markingCamera)) {
    frame.src = markingFrameSource;
  }
  sendButton.disabled = true;
  try {
    const payload = { marks: marks.map(serializeMark), image: markedImage() };
    if (limits.canRender && !camerasMatch(markingCamera, initialCamera)) payload.camera = markingCamera;
    await post('send', payload);
    finish('ok', 'Sent to the agent. You can close this tab.');
  } catch (error) {
    sendButton.disabled = false;
    hint.textContent = error.message;
  }
});
document.getElementById('cancel').addEventListener('click', async () => {
  await post('cancel', {}).catch(() => {});
  finish('stop', 'Cancelled. You can close this tab.');
});
syncMotionControls();
updateViewReadout();
render();
})();`;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > MAXIMUM_BODY_BYTES) {
        reject(new RangeError('The request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Serves one annotate page and waits for the person. `open(url)` shows the page (the runtime opens the browser; a test fetches it).
 * `renderView(camera, motionTime)` optionally re-renders the live scene preview when the person frames a camera or scrubs motion time.
 * `signal` ends the wait early with outcome 'aborted'; the server and the timer are released at once.
 * Resolves { outcome: 'sent' | 'cancelled' | 'timeout' | 'aborted', url, marks?, image?, camera? }; a rejected `open` rejects with the page address.
 */
export async function runAnnotateSession({ png, width, height, prompt = '', maxMarks = ANNOTATE_LIMITS.maxMarks, camera = DEFAULT_CAMERA, motion, renderView, waitMs, open, signal }) {
  const token = randomBytes(16).toString('hex');
  const base = `/${token}/`;
  const frameBytes = Buffer.from(png, 'base64');
  const initialCamera = {
    eye: Array.from(camera?.eye ?? DEFAULT_CAMERA.eye),
    target: Array.from(camera?.target ?? DEFAULT_CAMERA.target),
    up: Array.from(camera?.up ?? DEFAULT_CAMERA.up),
    fov: camera?.fov ?? DEFAULT_CAMERA.fov,
  };
  const html = pageHtml({ prompt, width, height, maxMarks, maxNoteLength: ANNOTATE_LIMITS.maxNoteLength, camera: initialCamera, motion, canRender: typeof renderView === 'function' });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'");
    const port = server.address()?.port;
    if (!port || !isPreviewHost(request.headers.host, port) || !request.url.startsWith(base)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const route = request.url.slice(base.length);
    try {
      if (request.method === 'GET' && route === '') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      } else if (request.method === 'GET' && route === 'app.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(PAGE_SCRIPT);
      } else if (request.method === 'GET' && route === 'frame.png') {
        response.setHeader('Content-Type', 'image/png');
        response.end(frameBytes);
      } else if (request.method === 'POST' && route === 'render' && typeof renderView === 'function') {
        const body = JSON.parse(await readBody(request));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Expected a JSON object body.');
        const requestedCamera = validateViewCamera(body.camera, 'camera');
        let requestedTime;
        if (body.motionTime !== undefined) {
          if (typeof body.motionTime !== 'number' || !Number.isFinite(body.motionTime) || body.motionTime < 0 || body.motionTime > ANNOTATE_LIMITS.maxMotionTime) {
            throw new TypeError(`motionTime must be a number of seconds from 0 to ${ANNOTATE_LIMITS.maxMotionTime}.`);
          }
          requestedTime = Math.round(body.motionTime * 1000) / 1000;
        }
        const renderedPng = await renderView({ ...requestedCamera, up: body.camera.up ?? initialCamera.up }, requestedTime);
        response.setHeader('Content-Type', 'image/png');
        response.end(Buffer.from(renderedPng, 'base64'));
      } else if (request.method === 'POST' && route === 'cancel') {
        response.end('ok');
        finish({ outcome: 'cancelled' });
      } else if (request.method === 'POST' && route === 'send') {
        const body = JSON.parse(await readBody(request));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Expected a JSON object body.');
        const marks = validateMarks(body.marks, { width, height, maxMarks });
        if (!marks.length) throw new TypeError('Add at least one mark before sending.');
        if (!isBoundedPng(body.image)) throw new TypeError('The marked picture is not a PNG within 1 MiB.');
        const sentCamera = body.camera === undefined ? undefined : { ...validateViewCamera(body.camera, 'camera'), up: initialCamera.up };
        response.end('ok');
        finish({ outcome: 'sent', marks, image: body.image, ...(sentCamera ? { camera: sentCamera } : {}) });
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}${base}`;
  let timer;
  const onAbort = () => finish({ outcome: 'aborted' });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      await open(url);
    } catch (error) {
      throw new Error(`Could not open the browser (${error.message}). The annotate page was ${url}`);
    }
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'timeout' }), waitMs); });
    return { url, ...await Promise.race([finished, timeout]) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Let the answer to the page finish: close idle connections now and any straggler after a second.
    const straggler = setTimeout(() => server.closeAllConnections?.(), 1000);
    await new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
    clearTimeout(straggler);
  }
}
