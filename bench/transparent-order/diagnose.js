// Round 3 diagnostics for the transparent order benchmark: window.runDiagnose proves where one pane went, window.runOrbit
// records the draw order of every pane over an orbit. harness.js loads this file after it defines its helpers.
import { CrucibleRenderer } from '/src/renderer.js';
import { createAgentScene } from '/src/agent-scene.js';
import { cameraAt, createRenderer, glassRecipe } from './harness.js';

const BLUE_MATERIAL = 'glass-2';
const GREEN_MATERIAL = 'glass-1';
const STRIDE = 42;

// Only the view-space depth row of a look-at matrix is needed: the dot product with the view direction, offset by the eye.
function viewMatrixAt(angle) {
  const { eye, target } = cameraAt(angle);
  const forward = target.map((value, axis) => value - eye[axis]);
  const length = Math.hypot(...forward);
  const direction = forward.map(value => value / length);
  const view = new Float32Array(16);
  view[2] = -direction[0];
  view[6] = -direction[1];
  view[10] = -direction[2];
  view[14] = direction[0] * eye[0] + direction[1] * eye[1] + direction[2] * eye[2];
  return view;
}

function paneViewDepth(node, view) {
  const [x, y, z] = node.translation;
  return view[2] * x + view[6] * y + view[10] * z + view[14];
}

function countBluePixels(context2d, width, height) {
  const { data } = context2d.getImageData(0, 0, width, height);
  let count = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 2] > data[offset] + 30 && data[offset + 2] > data[offset + 1] + 20) count++;
  }
  return count;
}

function drawVariant(canvas, recipe, angle, keep) {
  const scene = createAgentScene({ ...recipe, nodes: recipe.nodes.filter(keep) });
  const environment = { ...scene.environment, world: true };
  const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: true, hdr: true, depth: true, samples: 4, pixelRatio: 1, world: true, environment });
  renderer.resize();
  renderer.render({ ...cameraAt(angle), environment, time: 0, exposure: 1 });
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const copyContext = copy.getContext('2d', { willReadFrequently: true });
  copyContext.drawImage(canvas, 0, 0);
  return { copy, copyContext };
}

function caption(context2d, text, x, y) {
  context2d.lineWidth = 3;
  context2d.strokeStyle = '#000000';
  context2d.fillStyle = '#ffffff';
  context2d.strokeText(text, x, y);
  context2d.fillText(text, x, y);
}

window.runDiagnose = async function runDiagnose({ label = '', paneCount = 9, tileWidth = 480, tileHeight = 360 } = {}) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${tileWidth}px`;
  canvas.style.height = `${tileHeight}px`;
  const recipe = glassRecipe(paneCount, 3);
  const angle = -0.35;
  const view = viewMatrixAt(angle);
  const depths = recipe.nodes.map(node => ({ pane: node.id, material: node.material, viewDepth: Number(paneViewDepth(node, view).toFixed(3)) }));
  const variants = [
    ['all panes', () => true],
    ['no blue panes', node => node.material !== BLUE_MATERIAL],
    ['blue and green only', node => node.material === BLUE_MATERIAL || node.material === GREEN_MATERIAL],
  ];
  const sheet = document.createElement('canvas');
  sheet.width = tileWidth * 3;
  sheet.height = tileHeight;
  const sheetContext = sheet.getContext('2d');
  sheetContext.font = 'bold 22px sans-serif';
  const bluePixels = {};
  for (const [index, [name, keep]] of variants.entries()) {
    const { copy, copyContext } = drawVariant(canvas, recipe, angle, keep);
    bluePixels[name] = countBluePixels(copyContext, copy.width, copy.height);
    sheetContext.drawImage(copy, index * tileWidth, 0, tileWidth, tileHeight);
    caption(sheetContext, `${label}: ${name}`, index * tileWidth + 12, 30);
  }
  return { image: sheet.toDataURL('image/png').split(',')[1], depths, bluePixels };
};

// Records, per frame, the order the panes were drawn in, read from the instance data that reaches the GPU just before each
// blended draw. An order change is a frame whose draw order differs from the frame before.
window.runOrbit = async function runOrbit({ label = '', frames = 60, paneCount = 9, tileWidth = 240, tileHeight = 180 } = {}) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${tileWidth}px`;
  canvas.style.height = `${tileHeight}px`;
  const recipe = glassRecipe(paneCount, 3);
  const paneByDepthKey = new Map(recipe.nodes.map((node, index) => [Math.round(node.translation[2] * 1000), index]));
  const { renderer, environment } = createRenderer(canvas, paneCount, 3);
  const context = renderer.context;
  let lastUpload = null;
  let boundBuffer = null;
  let uploadedBuffer = null;
  const originalBind = context.bindBuffer.bind(context);
  context.bindBuffer = (target, buffer) => {
    boundBuffer = buffer;
    return originalBind(target, buffer);
  };
  const originalUpload = context.bufferSubData.bind(context);
  context.bufferSubData = (target, offset, data, start, length) => {
    uploadedBuffer = boundBuffer;
    lastUpload = start === undefined ? data : data.subarray(start, start + length);
    return start === undefined ? originalUpload(target, offset, data) : originalUpload(target, offset, data, start, length);
  };
  let drawnPanes = [];
  const originalDraw = renderer.drawAlphaBatch.bind(renderer);
  renderer.drawAlphaBatch = (batch, textured, culled) => {
    // The data a batch draws is whatever was last uploaded to its own buffer; a lone instance is never re-uploaded.
    const source = uploadedBuffer === batch.instanceBuffer && lastUpload ? lastUpload : batch.instanceData;
    for (let slot = 0; slot < batch.instanceCount; slot++) drawnPanes.push(paneByDepthKey.get(Math.round(source[slot * STRIDE + 14] * 1000)));
    return originalDraw(batch, textured, culled);
  };
  const sheet = document.createElement('canvas');
  sheet.width = tileWidth * 5;
  sheet.height = tileHeight * 2;
  const sheetContext = sheet.getContext('2d');
  sheetContext.font = 'bold 16px sans-serif';
  const orders = [];
  const ideals = [];
  let framesOutOfViewDepthOrder = 0;
  for (let frame = 0; frame < frames; frame++) {
    const angle = -0.35 + frame * 0.05;
    drawnPanes = [];
    renderer.render({ ...cameraAt(angle), environment, time: 0, exposure: 1 });
    const view = viewMatrixAt(angle);
    const ideal = recipe.nodes.map((node, index) => [index, paneViewDepth(node, view)]).sort((first, second) => first[1] - second[1]).map(pair => pair[0]);
    if (drawnPanes.join('') !== ideal.join('')) framesOutOfViewDepthOrder++;
    orders.push(drawnPanes.join(''));
    ideals.push(ideal.join(''));
    if (frame % 6 === 0 && frame / 6 < 10) {
      const tile = frame / 6;
      sheetContext.drawImage(canvas, (tile % 5) * tileWidth, Math.floor(tile / 5) * tileHeight, tileWidth, tileHeight);
      caption(sheetContext, `${label} frame ${frame}`, (tile % 5) * tileWidth + 8, Math.floor(tile / 5) * tileHeight + 20);
    }
  }
  // A flip is real when the true view-depth order changed between the two frames, and spurious when only the draw order did.
  let spuriousFlipFrames = 0;
  let orderChangeFrames = 0;
  let swappedPairs = 0;
  for (let frame = 1; frame < orders.length; frame++) {
    if (orders[frame] === orders[frame - 1]) continue;
    orderChangeFrames++;
    if (ideals[frame] === ideals[frame - 1]) spuriousFlipFrames++;
    for (let first = 0; first < paneCount; first++) {
      for (let second = first + 1; second < paneCount; second++) {
        const wasFirst = orders[frame - 1].indexOf(String(first)) < orders[frame - 1].indexOf(String(second));
        const isFirst = orders[frame].indexOf(String(first)) < orders[frame].indexOf(String(second));
        if (wasFirst !== isFirst) swappedPairs++;
      }
    }
  }
  return { image: sheet.toDataURL('image/png').split(',')[1], frames, orderChangeFrames, spuriousFlipFrames, swappedPairs, framesOutOfViewDepthOrder, sampleOrders: orders.slice(0, 2), sampleIdeals: ideals.slice(0, 2) };
};

// Frame by frame orbit for stills and video: window.startOrbit sets the renderer up, window.renderOrbitFrame(index) draws one
// frame and returns its picture with the draw order read from the data uploaded before each blended draw.
window.startOrbit = function startOrbit({ paneCount = 9, width = 1080, height = 1920 } = {}) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const recipe = glassRecipe(paneCount, 3);
  const paneByDepthKey = new Map(recipe.nodes.map((node, index) => [Math.round(node.translation[2] * 1000), index]));
  const { renderer, environment } = createRenderer(canvas, paneCount, 3);
  const context = renderer.context;
  const state = { canvas, recipe, renderer, environment, drawnPanes: [] };
  let lastUpload = null;
  let boundBuffer = null;
  let uploadedBuffer = null;
  const originalBind = context.bindBuffer.bind(context);
  context.bindBuffer = (target, buffer) => {
    boundBuffer = buffer;
    return originalBind(target, buffer);
  };
  const originalUpload = context.bufferSubData.bind(context);
  context.bufferSubData = (target, offset, data, start, length) => {
    uploadedBuffer = boundBuffer;
    lastUpload = start === undefined ? data : data.subarray(start, start + length);
    return start === undefined ? originalUpload(target, offset, data) : originalUpload(target, offset, data, start, length);
  };
  const originalDraw = renderer.drawAlphaBatch.bind(renderer);
  renderer.drawAlphaBatch = (batch, textured, culled) => {
    const source = uploadedBuffer === batch.instanceBuffer && lastUpload ? lastUpload : batch.instanceData;
    for (let slot = 0; slot < batch.instanceCount; slot++) state.drawnPanes.push(paneByDepthKey.get(Math.round(source[slot * STRIDE + 14] * 1000)));
    return originalDraw(batch, textured, culled);
  };
  window.orbitState = state;
  return true;
};

window.renderOrbitFrame = function renderOrbitFrame(frame) {
  const { canvas, recipe, renderer, environment } = window.orbitState;
  const angle = -0.35 + frame * 0.05;
  window.orbitState.drawnPanes = [];
  renderer.render({ ...cameraAt(angle), environment, time: 0, exposure: 1 });
  const view = viewMatrixAt(angle);
  const ideal = recipe.nodes.map((node, index) => [index, paneViewDepth(node, view)]).sort((first, second) => first[1] - second[1]).map(pair => pair[0]);
  return { image: canvas.toDataURL('image/png').split(',')[1], order: window.orbitState.drawnPanes.join(''), ideal: ideal.join('') };
};
