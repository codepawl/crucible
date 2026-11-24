// Page of the transparent order benchmark: stacks of overlapping blended panes. window.runStill() draws coloured glass from four
// sides into one picture, window.runCost(count) times frames with that many blended panes. run.mjs drives both.
import { CrucibleRenderer } from '/src/renderer.js';
import { createAgentScene } from '/src/agent-scene.js';

const GLASS_COLOURS = [[0.95, 0.1, 0.1], [0.1, 0.85, 0.2], [0.1, 0.25, 1]];

// One geometry per colour: parts that share a geometry and alpha state share a batch, and the batches are what interleave.
export function glassRecipe(paneCount, spread, geometryKinds = GLASS_COLOURS.length, stacked = false) {
  const materials = GLASS_COLOURS.map((color, index) => ({ id: `glass-${index}`, color, opacity: 0.7, alphaMode: 'blend', roughness: 0.2 }));
  const nodes = Array.from({ length: paneCount }, (unused, index) => ({
    id: `pane-${index}`,
    // Stacked: each geometry holds one block of the stack, so the batches never interleave.
    geometry: `pane-${stacked ? Math.floor(index * geometryKinds / paneCount) : index % geometryKinds}`,
    material: `glass-${index % GLASS_COLOURS.length}`,
    translation: [Math.sin(index * 1.7) * spread * 0.25, 1.1 + Math.cos(index * 2.3) * spread * 0.1, (index - paneCount / 2) * (spread / paneCount)],
    scale: [1.6, 1.6, 0.03],
  }));
  return { format: 'crucible.scene', schemaVersion: 1, geometries: Array.from({ length: geometryKinds }, (unused, index) => ({ id: `pane-${index}`, type: 'box', bevel: index * 0.001 })), materials, nodes };
}

export function createRenderer(canvas, paneCount, spread, geometryKinds, stacked) {
  const scene = createAgentScene(glassRecipe(paneCount, spread, geometryKinds, stacked));
  const environment = { ...scene.environment, world: true };
  const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: true, hdr: true, depth: true, samples: 4, pixelRatio: 1, world: true, environment });
  renderer.resize();
  return { renderer, environment };
}

export function cameraAt(angle) {
  const radius = 5;
  return { eye: [Math.sin(angle) * radius, 1.6, Math.cos(angle) * radius], target: [0, 1.1, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
}

const synchronizationPixel = new Uint8Array(4);

function finishFrame(context) {
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, synchronizationPixel);
}

window.runStill = async function runStill({ label = '', paneCount = 9, tileWidth = 480, tileHeight = 360 } = {}) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${tileWidth}px`;
  canvas.style.height = `${tileHeight}px`;
  const { renderer, environment } = createRenderer(canvas, paneCount, 3);
  const sheet = document.createElement('canvas');
  sheet.width = tileWidth * 2;
  sheet.height = tileHeight * 2;
  const sheetContext = sheet.getContext('2d');
  const angles = [0.35, -0.35, Math.PI - 0.35, Math.PI + 0.35];
  for (const [index, angle] of angles.entries()) {
    renderer.render({ ...cameraAt(angle), environment, time: 0, exposure: 1 });
    sheetContext.drawImage(canvas, (index % 2) * tileWidth, Math.floor(index / 2) * tileHeight, tileWidth, tileHeight);
  }
  sheetContext.font = 'bold 22px sans-serif';
  sheetContext.fillStyle = '#ffffff';
  sheetContext.strokeStyle = '#000000';
  sheetContext.lineWidth = 4;
  const captions = ['front left', 'front right', 'back left', 'back right'].map(side => `${label}: ${side}`);
  captions.forEach((caption, index) => {
    const x = (index % 2) * tileWidth + 12;
    const y = Math.floor(index / 2) * tileHeight + 30;
    sheetContext.strokeText(caption, x, y);
    sheetContext.fillText(caption, x, y);
  });
  return { image: sheet.toDataURL('image/png').split(',')[1] };
};

window.runCost = async function runCost({ count = 500, kinds = 3, stacked = false, frames = 60, width = 960, height = 540 } = {}) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const { renderer, environment } = createRenderer(canvas, count, 6, kinds, stacked);
  const context = renderer.context;
  const times = [];
  for (let index = 0; index < frames + 10; index++) {
    const start = performance.now();
    renderer.render({ ...cameraAt(index * 0.03), environment, time: 0, exposure: 1 });
    const submitted = performance.now();
    finishFrame(context);
    if (index >= 10) times.push([performance.now() - start, submitted - start]);
  }
  const median = values => values.slice().sort((first, second) => first - second)[Math.floor(values.length / 2)];
  return {
    count,
    kinds,
    stacked,
    drawCalls: renderer.stats?.drawCalls,
    frameMilliseconds: Number(median(times.map(pair => pair[0])).toFixed(2)),
    submitMilliseconds: Number(median(times.map(pair => pair[1])).toFixed(2)),
  };
};
window.harnessReady = true;
