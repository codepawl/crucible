// The local page behind scene_ask_user (issue #922): it shows one rendered view, lets the person pin points on it with a short
// note each, and returns the marks when they press Send. It listens on loopback only, under a random path, with no remote assets.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isPreviewHost } from './preview-host.mjs';
import { ANNOTATE_LIMITS, validateMarks, isBoundedPng } from '../src/agent-annotate.js';

const MAXIMUM_BODY_BYTES = 2 * 1024 * 1024;

// Shared with the inline MCP Apps view (scripts/annotate-app-view.mjs) so both look the same.
export function annotateStyle(width) {
  return `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#182126;color:#e8eef0;font:15px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:16px;padding:20px}
h1{margin:0;font-size:18px;font-weight:600}
main{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.stage{position:relative;line-height:0;flex:0 1 ${width}px;max-width:100%;cursor:crosshair;user-select:none}
.stage img{width:100%;height:auto;border-radius:8px;display:block}
.stage.lasso{cursor:cell;touch-action:none}
.outline{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.outline polygon,.outline polyline{fill:rgba(255,90,79,.22);stroke:#ff5a4f;stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.outline polyline{fill:none;stroke:#fff}
.tools{display:flex;gap:4px}
button[aria-pressed=true]{background:#26343b;box-shadow:inset 0 0 0 2px #6fb7ff}
.pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none}
aside{flex:1 1 280px;max-width:380px;display:flex;flex-direction:column;gap:12px;user-select:none}
.row{display:flex;gap:10px;align-items:center}
.badge{flex:none;width:26px;height:26px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center}
input{flex:1;min-width:0;height:36px;border:0;border-radius:6px;background:#26343b;color:inherit;padding:0 10px;font:inherit;user-select:text}
input:focus{outline:2px solid #6fb7ff}
button{height:36px;border:0;border-radius:6px;padding:0 14px;font:inherit;color:inherit;background:transparent;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
button:hover{background:#26343b}
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

function pageHtml({ prompt, width, height, maxMarks, maxNoteLength }) {
  const escaped = prompt.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mark the scene</title><style>${annotateStyle(width)}</style></head><body>
<h1>${escaped || 'Click the scene to mark what you mean'}</h1>
<main>
<div class="stage" id="stage"><img id="frame" src="frame.png" width="${width}" height="${height}" alt="Rendered scene"></div>
<aside id="side">
<div class="tools" role="group" aria-label="Mark type">
<button class="icon" id="tool-pin" aria-pressed="true" aria-label="Pin" title="Pin: click a spot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.500-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg></button>
<button class="icon" id="tool-lasso" aria-pressed="false" aria-label="Lasso" title="Lasso: draw around a region"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4C7 4 3 6.500 3 10s4 6 9 6 9-2.500 9-6-4-6-9-6z"/><path d="M9 16c-1 2-1 3.500 1 4"/></svg></button>
</div>
<div class="hint" id="hint">Click the picture to drop a pin, or draw around a region with the lasso, then say what to change.</div>
<div id="rows" style="display:flex;flex-direction:column;gap:8px"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="send">Send</button><button id="cancel">Cancel</button></div>
</aside>
</main>
<script type="application/json" id="limits">${JSON.stringify({ width, height, maxMarks, maxNoteLength, minLassoPoints: ANNOTATE_LIMITS.minLassoPoints, maxLassoPoints: ANNOTATE_LIMITS.maxLassoPoints })}</script>
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
const sendButton = document.getElementById('send');
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
const svgNamespace = 'http://www.w3.org/2000/svg';
const outline = document.createElementNS(svgNamespace, 'svg');
outline.setAttribute('class', 'outline');
outline.setAttribute('viewBox', '0 0 ' + limits.width + ' ' + limits.height);
outline.setAttribute('preserveAspectRatio', 'none');
stage.appendChild(outline);
let tool = 'pin';
let drawing = null;
const toolButtons = { pin: document.getElementById('tool-pin'), lasso: document.getElementById('tool-lasso') };
function chooseTool(name) {
  tool = name;
  stage.classList.toggle('lasso', name === 'lasso');
  Object.entries(toolButtons).forEach(([key, button]) => button.setAttribute('aria-pressed', String(key === name)));
}
toolButtons.pin.addEventListener('click', () => chooseTool('pin'));
toolButtons.lasso.addEventListener('click', () => chooseTool('lasso'));
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
function render() {
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  outline.textContent = '';
  rows.textContent = '';
  marks.forEach((mark, index) => {
    const centre = markCentre(mark);
    if (mark.points !== undefined) {
      const shape = document.createElementNS(svgNamespace, 'polygon');
      shape.setAttribute('points', pointsText(mark.points));
      outline.appendChild(shape);
    }
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = index + 1;
    pin.style.left = (centre[0] / limits.width * 100) + '%';
    pin.style.top = (centre[1] / limits.height * 100) + '%';
    stage.appendChild(pin);
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = index + 1;
    const input = document.createElement('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = 'What should change here?';
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove mark';
    remove.setAttribute('aria-label', 'Remove mark ' + (index + 1));
    remove.innerHTML = trash;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); });
    row.append(badge, input, remove);
    rows.appendChild(row);
    mark.input = input;
  });
  count.textContent = marks.length + ' of ' + limits.maxMarks + ' marks';
  sendButton.disabled = marks.length === 0;
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
  if (tool !== 'pin' || marks.length >= limits.maxMarks) return;
  const [x, y] = pixelOf(event);
  marks.push({ x, y, note: '' });
  render();
  marks[marks.length - 1].input.focus();
});
stage.addEventListener('pointerdown', event => {
  if (tool !== 'lasso' || marks.length >= limits.maxMarks || event.button !== 0) return;
  event.preventDefault();
  stage.setPointerCapture(event.pointerId);
  const trail = document.createElementNS(svgNamespace, 'polyline');
  outline.appendChild(trail);
  drawing = { points: [pixelOf(event)], trail };
});
stage.addEventListener('pointermove', event => {
  if (!drawing) return;
  const point = pixelOf(event);
  const last = drawing.points[drawing.points.length - 1];
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 3) return;
  drawing.points.push(point);
  drawing.trail.setAttribute('points', pointsText(drawing.points));
});
function endLasso() {
  if (!drawing) return;
  const points = thinned(drawing.points);
  drawing = null;
  if (points.length >= limits.minLassoPoints && polygonArea(points) >= 1) marks.push({ kind: 'lasso', points, note: '' });
  render();
  if (marks.length && marks[marks.length - 1].points === points) marks[marks.length - 1].input.focus();
}
stage.addEventListener('pointerup', endLasso);
stage.addEventListener('pointercancel', endLasso);
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.width;
  canvas.height = limits.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, limits.width, limits.height);
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
    const [centreX, centreY] = markCentre(mark);
    context.beginPath();
    context.arc(centreX, centreY, 14, 0, Math.PI * 2);
    context.fillStyle = '#ff5a4f';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
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
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()) || 'The request failed.');
}
sendButton.addEventListener('click', async () => {
  sendButton.disabled = true;
  try {
    await post('send', { marks: marks.map(mark => (mark.points === undefined ? { x: mark.x, y: mark.y, note: mark.note } : { kind: 'lasso', points: mark.points, note: mark.note })), image: markedImage() });
    finish('ok', 'Sent to the agent. You can close this tab.');
  } catch (error) {
    sendButton.disabled = false;
    document.getElementById('hint').textContent = error.message;
  }
});
document.getElementById('cancel').addEventListener('click', async () => {
  await post('cancel', {}).catch(() => {});
  finish('stop', 'Cancelled. You can close this tab.');
});
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
 * `signal` ends the wait early with outcome 'aborted'; the server and the timer are released at once.
 * Resolves { outcome: 'sent' | 'cancelled' | 'timeout' | 'aborted', url, marks?, image? }; a rejected `open` rejects with the page address.
 */
export async function runAnnotateSession({ png, width, height, prompt = '', maxMarks = ANNOTATE_LIMITS.maxMarks, waitMs, open, signal }) {
  const token = randomBytes(16).toString('hex');
  const base = `/${token}/`;
  const frameBytes = Buffer.from(png, 'base64');
  const html = pageHtml({ prompt, width, height, maxMarks, maxNoteLength: ANNOTATE_LIMITS.maxNoteLength });
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
      } else if (request.method === 'POST' && route === 'cancel') {
        response.end('ok');
        finish({ outcome: 'cancelled' });
      } else if (request.method === 'POST' && route === 'send') {
        const body = JSON.parse(await readBody(request));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Expected a JSON object body.');
        const marks = validateMarks(body.marks, { width, height, maxMarks });
        if (!marks.length) throw new TypeError('Add at least one pin before sending.');
        if (!isBoundedPng(body.image)) throw new TypeError('The marked picture is not a PNG within 1 MiB.');
        response.end('ok');
        finish({ outcome: 'sent', marks, image: body.image });
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
