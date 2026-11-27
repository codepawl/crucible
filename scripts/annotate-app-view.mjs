// The scene_ask_user annotate view as an MCP Apps UI resource (issue #923), following the MCP Apps extension spec of
// 2026-01-26 (SEP-1865, github.com/modelcontextprotocol/ext-apps). A host that advertises the extension renders this page in a
// sandboxed iframe; the page needs no network and no remote asset: the scene picture arrives in the tool result as base64, and
// the marks go back through the host with a tools/call to scene_ask_user_submit. The protocol is a few postMessage JSON-RPC
// calls, written here instead of importing @modelcontextprotocol/ext-apps so the core gains no dependency.
import { annotateStyle, annotateToolbarMarkup } from './annotate-session.mjs';

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const ANNOTATE_VIEW_URI = 'ui://crucible/annotate';
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
export const MAXIMUM_VIEW_BYTES = 32 * 1024;

/** True when the client's initialize capabilities list the MCP Apps extension with the HTML app mime type. */
export function clientSupportsMcpApps(capabilities) {
  const mimeTypes = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID]?.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APPS_MIME_TYPE);
}

const VIEW_SCRIPT = `(() => {
const submitTool = 'scene_ask_user_submit';
const defaultCamera = { eye: [0, 2, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
let limits = null;
let nonce = null;
const marks = [];
const byId = id => document.getElementById(id);
const on = (node, type, listener, options) => node.addEventListener(type, listener, options);
const make = (name, className, text) => {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const stage = byId('stage');
const frame = byId('frame');
const rows = byId('rows');
const count = byId('count');
const hint = byId('hint');
const sendButton = byId('send');
const colorOptions = byId('color-options');
const colorPicker = byId('color-picker');
const colorHex = byId('color-hex');
const viewOptions = byId('view-options');
const viewFovInput = byId('view-fov');
const viewSummary = byId('view-summary');
const captureViewButton = byId('capture-view');
const resetViewButton = byId('reset-view');
const transformOptions = byId('transform-options');
const posInputs = ['dx', 'dy', 'dz'].map(axis => byId('tf-' + axis));
const rotInputs = ['rx', 'ry', 'rz'].map(axis => byId('tf-' + axis));
const scaleInput = byId('tf-s');
const resetTransformButton = byId('reset-transform');
const motionOptions = byId('motion-options');
const motionScrub = byId('motion-scrub');
const motionTimeInput = byId('motion-time');
const motionDuration = byId('motion-duration');
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
const outline = byId('outline');
const svgNamespace = outline.namespaceURI;
let tool = 'pin';
let drawing = null;
let orbiting = null;
let hasMotion = false;
let activeTime = 0;
let initialCamera = cloneCamera(defaultCamera);
let viewCamera = cloneCamera(defaultCamera);
const toolButtons = {};
for (const key of ['pin', 'lasso', 'color', 'view', 'transform']) {
  toolButtons[key] = byId('tool-' + key);
  on(toolButtons[key], 'click', () => chooseTool(key));
}
let nextId = 1;
const waiting = new Map();
function post(message) { window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*'); }
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    post({ id, method, params });
  });
}
on(window, 'message', event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
  if (message.method === 'ui/notifications/tool-result') {
    showResult(message.params);
  } else if (message.id !== undefined && !message.method && waiting.has(message.id)) {
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'The host refused the request.'));
    else pending.resolve(message.result);
  }
});
function textOf(result) {
  const part = (result && result.content || []).find(item => item.type === 'text');
  return part ? part.text : '';
}
function nonceOf(result) {
  const meta = result && result._meta && result._meta["crucible/annotate"];
  return meta && meta.nonce;
}
function cloneCamera(source) {
  const camera = source || defaultCamera;
  return { eye: (camera.eye || defaultCamera.eye).slice(0, 3), target: (camera.target || defaultCamera.target).slice(0, 3), up: (camera.up || defaultCamera.up).slice(0, 3), fov: camera.fov || defaultCamera.fov };
}
function roundVector(vector) {
  return vector.map(component => Math.round(component * 1000) / 1000);
}
function roundTime(value) {
  return Math.round(Math.max(0, Math.min(3600, value)) * 1000) / 1000;
}
function syncMotionControls() {
  if (!hasMotion || !limits || !limits.motion) {
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
  viewSummary.textContent = 'eye [' + roundVector(viewCamera.eye).join(', ') + '] target [' + roundVector(viewCamera.target).join(', ') + ']';
}
function chooseTool(name) {
  tool = name;
  stage.classList.toggle('lasso', name === 'lasso');
  stage.classList.toggle('view', name === 'view');
  colorOptions.hidden = name !== 'color';
  viewOptions.hidden = name !== 'view';
  transformOptions.hidden = name !== 'transform';
  Object.entries(toolButtons).forEach(([key, button]) => button.setAttribute('aria-pressed', String(key === name)));
  updateViewReadout();
  reportSize();
}
on(colorPicker, 'input', () => { colorHex.textContent = colorPicker.value.toLowerCase(); });
on(resetTransformButton, 'click', () => {
  posInputs.concat(rotInputs).forEach(input => { input.value = '0'; });
  scaleInput.value = '1';
});
on(motionScrub, 'input', () => {
  const parsed = Number(motionScrub.value);
  if (!Number.isFinite(parsed)) return;
  activeTime = roundTime(parsed);
  motionTimeInput.value = String(activeTime);
});
on(motionTimeInput, 'change', () => {
  const parsed = Number(motionTimeInput.value);
  if (Number.isFinite(parsed)) activeTime = roundTime(parsed);
  syncMotionControls();
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
function thinned(points) {
  const maxLassoPoints = (limits && limits.maxLassoPoints) || 64;
  if (points.length <= maxLassoPoints) return points;
  return Array.from({ length: maxLassoPoints }, (unused, index) => points[Math.floor(index * points.length / maxLassoPoints)]);
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
  const pos = posInputs.map(input => Number(input.value));
  const rot = rotInputs.map(input => Number(input.value));
  const scale = Number(scaleInput.value);
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
    posInputs[0].focus();
    return null;
  }
  return {
    ...(hasMove ? { deltaPosition: cleanPos } : {}),
    ...(hasRotate ? { deltaRotation: cleanRot } : {}),
    ...(hasScale ? { scaleFactor: cleanScale } : {}),
  };
}
function render() {
  if (!limits) return;
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  outline.textContent = '';
  rows.textContent = '';
  marks.forEach((mark, index) => {
    if (mark.kind !== 'view') {
      const centre = markCentre(mark);
      if (mark.points !== undefined) {
        const shape = document.createElementNS(svgNamespace, 'polygon');
        shape.setAttribute('points', pointsText(mark.points));
        outline.appendChild(shape);
      }
      const pin = make('div', mark.kind === 'transform' ? 'pin transform' : 'pin', index + 1);
      pin.style.left = (centre[0] / limits.view.width * 100) + '%';
      pin.style.top = (centre[1] / limits.view.height * 100) + '%';
      if (mark.kind === 'color') {
        pin.style.background = mark.hex;
        pin.style.color = contrastTextColor(mark.hex);
      } else if (mark.kind === 'transform') {
        pin.title = transformSummary(mark);
      }
      stage.appendChild(pin);
    }
    const row = make('div', 'row');
    const badge = make('span', mark.kind === 'view' ? 'badge view' : (mark.kind === 'transform' ? 'badge transform' : 'badge'), index + 1);
    if (mark.kind === 'color') {
      badge.style.background = mark.hex;
      badge.style.color = contrastTextColor(mark.hex);
    }
    row.appendChild(badge);
    if (mark.kind === 'color') {
      const swatch = make('input', 'row-swatch');
      swatch.type = 'color';
      swatch.value = mark.hex;
      swatch.setAttribute('aria-label', 'Mark ' + (index + 1) + ' colour');
      on(swatch, 'input', () => {
        mark.hex = swatch.value.toLowerCase();
        render();
      });
      row.appendChild(swatch);
    } else if (mark.kind === 'view') {
      const meta = make('span', 'row-meta', 'FOV ' + Math.round(mark.camera.fov));
      meta.title = 'eye [' + mark.camera.eye.join(', ') + '] target [' + mark.camera.target.join(', ') + ']';
      row.appendChild(meta);
    } else if (mark.kind === 'transform') {
      row.appendChild(make('span', 'row-meta', transformSummary(mark)));
    }
    if (mark.time !== undefined) {
      row.appendChild(make('span', 'row-meta', mark.time + 's'));
    }
    const input = make('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = mark.kind === 'view' ? 'Why this view?' : (mark.kind === 'color' ? 'Colour note' : (mark.kind === 'transform' ? 'Transform note' : 'What should change here?'));
    on(input, 'input', () => { mark.note = input.value; });
    const remove = make('button', 'icon');
    remove.title = 'Remove mark';
    remove.setAttribute('aria-label', 'Remove mark ' + (index + 1));
    remove.innerHTML = trash;
    on(remove, 'click', () => { marks.splice(index, 1); render(); reportSize(); });
    row.append(input, remove);
    rows.appendChild(row);
    mark.input = input;
  });
  count.textContent = marks.length + ' of ' + limits.maxMarks + ' marks';
  sendButton.disabled = marks.length === 0;
  captureViewButton.disabled = marks.length >= limits.maxMarks;
}
function showResult(result) {
  const image = (result.content || []).find(item => item.type === 'image');
  let details;
  try { details = JSON.parse(textOf(result)); } catch (error) { details = null; }
  if (!image || !details || details.outcome !== 'pending' || typeof nonceOf(result) !== 'string') {
    hint.textContent = (details && details.message) || 'This view has no scene to mark.';
    return;
  }
  limits = details;
  nonce = nonceOf(result);
  hasMotion = Boolean(details.motion);
  activeTime = hasMotion ? roundTime(Number(details.motion.time) || 0) : 0;
  initialCamera = cloneCamera(details.view && details.view.camera);
  viewCamera = cloneCamera(initialCamera);
  byId('title').textContent = details.prompt || 'Click the scene to mark what you mean';
  frame.width = details.view.width;
  frame.height = details.view.height;
  outline.setAttribute('viewBox', '0 0 ' + details.view.width + ' ' + details.view.height);
  frame.src = 'data:image/png;base64,' + image.data;
  hint.textContent = 'Click the picture to drop a pin, draw with lasso, pick a colour, save a view, or set a transform.';
  syncMotionControls();
  updateViewReadout();
  render();
  reportSize();
}
function reportSize() {
  post({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
}
function pixelOf(event) {
  const box = frame.getBoundingClientRect();
  const x = Math.min(limits.view.width, Math.max(0, (event.clientX - box.left) / box.width * limits.view.width));
  const y = Math.min(limits.view.height, Math.max(0, (event.clientY - box.top) / box.height * limits.view.height));
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
on(stage, 'click', event => {
  if (!limits || (tool !== 'pin' && tool !== 'color' && tool !== 'transform') || marks.length >= limits.maxMarks) return;
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
  reportSize();
});
on(stage, 'contextmenu', event => { if (tool === 'view') event.preventDefault(); });
on(stage, 'pointerdown', event => {
  if (!limits) return;
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
on(stage, 'pointermove', event => {
  if (orbiting) {
    const deltaX = event.clientX - orbiting.lastX;
    const deltaY = event.clientY - orbiting.lastY;
    orbiting.lastX = event.clientX;
    orbiting.lastY = event.clientY;
    if (orbiting.pan || event.shiftKey) panCameraBy(deltaX, deltaY);
    else orbitCameraBy(deltaX, deltaY);
    updateViewReadout();
    return;
  }
  if (!drawing) return;
  const point = pixelOf(event);
  const last = drawing.points[drawing.points.length - 1];
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 3) return;
  drawing.points.push(point);
  drawing.trail.setAttribute('points', pointsText(drawing.points));
});
function endPointer() {
  if (orbiting) {
    orbiting = null;
    return;
  }
  if (!drawing) return;
  const points = thinned(drawing.points);
  drawing = null;
  const minLassoPoints = (limits && limits.minLassoPoints) || 3;
  if (points.length >= minLassoPoints && polygonArea(points) >= 1) {
    marks.push({ kind: 'lasso', points, note: '', ...(hasMotion ? { time: activeTime } : {}) });
  }
  render();
  if (marks.length && marks[marks.length - 1].points === points) marks[marks.length - 1].input.focus();
  reportSize();
}
on(stage, 'pointerup', endPointer);
on(stage, 'pointercancel', endPointer);
on(stage, 'wheel', event => {
  if (tool !== 'view') return;
  event.preventDefault();
  zoomCameraBy(event.deltaY);
  updateViewReadout();
}, { passive: false });
on(viewFovInput, 'change', () => {
  const parsed = Number(viewFovInput.value);
  const minFov = (limits && limits.minViewFov) || 5;
  const maxFov = (limits && limits.maxViewFov) || 120;
  viewCamera.fov = Number.isFinite(parsed) ? Math.max(minFov, Math.min(maxFov, parsed)) : viewCamera.fov;
  updateViewReadout();
});
on(captureViewButton, 'click', () => {
  if (!limits || marks.length >= limits.maxMarks) return;
  marks.push({
    kind: 'view',
    camera: { eye: roundVector(viewCamera.eye), target: roundVector(viewCamera.target), fov: Math.round(viewCamera.fov * 100) / 100 },
    note: '',
    ...(hasMotion ? { time: activeTime } : {}),
  });
  render();
  marks[marks.length - 1].input.focus();
  reportSize();
});
on(resetViewButton, 'click', () => {
  viewCamera = cloneCamera(initialCamera);
  updateViewReadout();
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
function drawPill(context, x, y, text, width, height) {
  context.font = '600 11px system-ui, sans-serif';
  const pillW = Math.ceil(context.measureText(text).width) + 12;
  const pillH = 18;
  const left = Math.max(4, Math.min(width - pillW - 4, x));
  const top = Math.max(4, Math.min(height - pillH - 4, y));
  context.fillStyle = 'rgba(24,33,38,0.88)';
  context.fillRect(left, top, pillW, pillH);
  context.lineWidth = 1;
  context.strokeStyle = '#fff';
  context.strokeRect(left + 0.5, top + 0.5, pillW - 1, pillH - 1);
  context.fillStyle = '#fff';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, left + 6, top + pillH / 2 + 0.5);
}
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.view.width;
  canvas.height = limits.view.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
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
        drawPill(context, 8, 8 + viewBadgeRow * 22, (index + 1) + ' view ' + mark.time + 's', canvas.width, canvas.height);
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
      const pillX = centreX + 18 + label.length * 6.5 > canvas.width - 6 ? centreX - 18 - label.length * 6.5 - 12 : centreX + 18;
      drawPill(context, pillX, centreY - 9, label, canvas.width, canvas.height);
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
function tellChat(text) {
  return request('ui/message', { role: 'user', content: { type: 'text', text } }).catch(() => {});
}
on(sendButton, 'click', async () => {
  sendButton.disabled = true;
  try {
    const answer = await request('tools/call', { name: submitTool, arguments: { nonce, marks: marks.map(serializeMark), image: markedImage() } });
    if (answer.isError) throw new Error(textOf(answer) || 'The marks were refused.');
    finish('ok', 'Sent to the agent.');
    await tellChat('Marks from the scene annotate view: ' + textOf(answer));
  } catch (error) {
    sendButton.disabled = false;
    hint.textContent = error.message;
  }
});
on(byId('cancel'), 'click', async () => {
  finish('stop', 'Cancelled.');
  await tellChat('I closed the scene annotate view without marking anything.');
});
request('ui/initialize', { appInfo: { name: 'crucible-annotate', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}' })
  .then(() => post({ method: 'ui/notifications/initialized', params: {} }))
  .catch(error => { hint.textContent = error.message; });
})();`;

/** The whole page as one string: inline style and script, no remote reference, nothing taken from the model. */
export function annotateViewHtml() {
  const script = VIEW_SCRIPT.replace(/^[ \t]+/gm, '').replace(/^\/\/[^\n]*\n/gm, '').replace(/\n+/g, '\n');
  const style = annotateStyle(768).replace(/\n+/g, '');
  const toolbar = annotateToolbarMarkup().replace(/\n+/g, '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mark the scene</title><style>${style}</style></head><body><h1 id="title">Waiting for the scene</h1><main><div class="stage" id="stage"><img id="frame" width="768" height="512" alt="Rendered scene"><svg class="outline" id="outline" preserveAspectRatio="none"></svg></div><aside id="side">${toolbar}<div class="hint" id="hint">Loading the view.</div><div id="rows" style="display:flex;flex-direction:column;gap:8px"></div><div class="count" id="count"></div><div class="actions"><button class="primary" id="send" disabled>Send</button><button id="cancel">Cancel</button></div></aside></main><script>${script}</script></body></html>`;
  if (Buffer.byteLength(html) > MAXIMUM_VIEW_BYTES) throw new RangeError(`The annotate view is larger than ${MAXIMUM_VIEW_BYTES} bytes.`);
  return html;
}
