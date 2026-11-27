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
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
const outline = document.getElementById('outline');
const svgNamespace = outline.namespaceURI;
let tool = 'pin';
let drawing = null;
let orbiting = null;
let initialCamera = cloneCamera(defaultCamera);
let viewCamera = cloneCamera(defaultCamera);
const toolButtons = {
  pin: document.getElementById('tool-pin'),
  lasso: document.getElementById('tool-lasso'),
  color: document.getElementById('tool-color'),
  view: document.getElementById('tool-view'),
};
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
window.addEventListener('message', event => {
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
// The nonce travels in the result _meta, which the host gives the view and not the model.
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
  Object.entries(toolButtons).forEach(([key, button]) => button.setAttribute('aria-pressed', String(key === name)));
  updateViewReadout();
  reportSize();
}
toolButtons.pin.addEventListener('click', () => chooseTool('pin'));
toolButtons.lasso.addEventListener('click', () => chooseTool('lasso'));
toolButtons.color.addEventListener('click', () => chooseTool('color'));
toolButtons.view.addEventListener('click', () => chooseTool('view'));
colorPicker.addEventListener('input', () => { colorHex.textContent = colorPicker.value.toLowerCase(); });
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
      const pin = document.createElement('div');
      pin.className = 'pin';
      pin.textContent = index + 1;
      pin.style.left = (centre[0] / limits.view.width * 100) + '%';
      pin.style.top = (centre[1] / limits.view.height * 100) + '%';
      if (mark.kind === 'color') {
        pin.style.background = mark.hex;
        pin.style.color = contrastTextColor(mark.hex);
      }
      stage.appendChild(pin);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = mark.kind === 'view' ? 'badge view' : 'badge';
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
    }
    const input = document.createElement('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = mark.kind === 'view' ? 'Why this view?' : (mark.kind === 'color' ? 'Colour note' : 'What should change here?');
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove mark';
    remove.setAttribute('aria-label', 'Remove mark ' + (index + 1));
    remove.innerHTML = trash;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); reportSize(); });
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
  initialCamera = cloneCamera(details.view && details.view.camera);
  viewCamera = cloneCamera(initialCamera);
  document.getElementById('title').textContent = details.prompt || 'Click the scene to mark what you mean';
  frame.width = details.view.width;
  frame.height = details.view.height;
  outline.setAttribute('viewBox', '0 0 ' + details.view.width + ' ' + details.view.height);
  frame.src = 'data:image/png;base64,' + image.data;
  hint.textContent = 'Click the picture to drop a pin, draw with lasso, pick a colour, or frame and save a view.';
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
stage.addEventListener('click', event => {
  if (!limits || (tool !== 'pin' && tool !== 'color') || marks.length >= limits.maxMarks) return;
  const [x, y] = pixelOf(event);
  if (tool === 'color') {
    marks.push({ kind: 'color', x, y, hex: colorPicker.value.toLowerCase(), note: '' });
  } else {
    marks.push({ x, y, note: '' });
  }
  render();
  marks[marks.length - 1].input.focus();
  reportSize();
});
stage.addEventListener('contextmenu', event => { if (tool === 'view') event.preventDefault(); });
stage.addEventListener('pointerdown', event => {
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
stage.addEventListener('pointermove', event => {
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
  if (points.length >= minLassoPoints && polygonArea(points) >= 1) marks.push({ kind: 'lasso', points, note: '' });
  render();
  if (marks.length && marks[marks.length - 1].points === points) marks[marks.length - 1].input.focus();
  reportSize();
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', event => {
  if (tool !== 'view') return;
  event.preventDefault();
  zoomCameraBy(event.deltaY);
  updateViewReadout();
}, { passive: false });
viewFovInput.addEventListener('change', () => {
  const parsed = Number(viewFovInput.value);
  const minFov = (limits && limits.minViewFov) || 5;
  const maxFov = (limits && limits.maxViewFov) || 120;
  viewCamera.fov = Number.isFinite(parsed) ? Math.max(minFov, Math.min(maxFov, parsed)) : viewCamera.fov;
  updateViewReadout();
});
captureViewButton.addEventListener('click', () => {
  if (!limits || marks.length >= limits.maxMarks) return;
  marks.push({
    kind: 'view',
    camera: { eye: roundVector(viewCamera.eye), target: roundVector(viewCamera.target), fov: Math.round(viewCamera.fov * 100) / 100 },
    note: '',
  });
  render();
  marks[marks.length - 1].input.focus();
  reportSize();
});
resetViewButton.addEventListener('click', () => {
  viewCamera = cloneCamera(initialCamera);
  updateViewReadout();
});
function serializeMark(mark) {
  if (mark.kind === 'lasso') return { kind: 'lasso', points: mark.points, note: mark.note };
  if (mark.kind === 'color') return { kind: 'color', x: mark.x, y: mark.y, hex: mark.hex, note: mark.note };
  if (mark.kind === 'view') return { kind: 'view', camera: mark.camera, note: mark.note };
  return { x: mark.x, y: mark.y, note: mark.note };
}
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.view.width;
  canvas.height = limits.view.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  context.font = '600 15px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
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
  marks.forEach((mark, index) => {
    if (mark.kind === 'view') return;
    const [centreX, centreY] = markCentre(mark);
    context.beginPath();
    context.arc(centreX, centreY, 14, 0, Math.PI * 2);
    context.fillStyle = mark.kind === 'color' ? mark.hex : '#ff5a4f';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = mark.kind === 'color' ? contrastTextColor(mark.hex) : '#fff';
    context.fillText(String(index + 1), centreX, centreY + 1);
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
sendButton.addEventListener('click', async () => {
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
document.getElementById('cancel').addEventListener('click', async () => {
  finish('stop', 'Cancelled.');
  await tellChat('I closed the scene annotate view without marking anything.');
});
request('ui/initialize', { appInfo: { name: 'crucible-annotate', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}' })
  .then(() => post({ method: 'ui/notifications/initialized', params: {} }))
  .catch(error => { hint.textContent = error.message; });
})();`;

/** The whole page as one string: inline style and script, no remote reference, nothing taken from the model. */
export function annotateViewHtml() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mark the scene</title><style>${annotateStyle(768)}</style></head><body>
<h1 id="title">Waiting for the scene</h1>
<main>
<div class="stage" id="stage"><img id="frame" width="768" height="512" alt="Rendered scene"><svg class="outline" id="outline" preserveAspectRatio="none"></svg></div>
<aside id="side">
${annotateToolbarMarkup()}
<div class="hint" id="hint">Loading the view.</div>
<div id="rows" style="display:flex;flex-direction:column;gap:8px"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="send" disabled>Send</button><button id="cancel">Cancel</button></div>
</aside>
</main>
<script>${VIEW_SCRIPT}</script>
</body></html>`;
  if (Buffer.byteLength(html) > MAXIMUM_VIEW_BYTES) throw new RangeError(`The annotate view is larger than ${MAXIMUM_VIEW_BYTES} bytes.`);
  return html;
}
