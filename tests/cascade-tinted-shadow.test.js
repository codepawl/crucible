// The tinted shadow of a blended or transmissive pane under the soft cascade shadows (#3259). The unit tests pin the wiring
// (shaders, which casters draw where, the uniforms the filter reads); the browser test draws a pane in front of a wall in
// headless Chrome and reads the wall, and skips where Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { createCascadedShadows } from '../src/cascaded-shadows.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';
import { createFragmentShader } from '../src/shaders.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

function recordingContext() {
  const calls = [];
  const context = new Proxy({}, {
    get(_, name) {
      if (name === 'checkFramebufferStatus') return () => context.FRAMEBUFFER_COMPLETE;
      if (name === 'FRAMEBUFFER_COMPLETE') return 1;
      if (name === 'createTexture' || name === 'createFramebuffer') return () => ({});
      if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return 1;
      return (...args) => calls.push([name, ...args]);
    },
  });
  return { context, calls };
}

const opaqueBatch = { castShadow: true, tintedShadow: false, parts: [{}] };
const glassBatch = { castShadow: true, tintedShadow: true, alphaMode: 'blend', layerState: new Array(10).fill(0), parts: [{ material: {}, castShadow: true }] };

function rendererWith(batches) {
  const { context, calls } = recordingContext();
  const instance = Object.create(CrucibleRenderer.prototype);
  const drawn = [];
  Object.assign(instance, {
    context, batches, renderTargets: new RenderTargetLedger(), world: null, activeLightDirection: [1, 2, 3], shadowBounds: { extent: 4 },
    lightProjection: new Float32Array(16), windState: { time: 0, strength: 0 }, tintedShadowsActive: true,
    depthAlphaUniforms: { opaqueShadow: 'opaqueShadow' }, depthWindUniforms: {}, shadowBiasPerSlope: 0.001, shadowTexture: {},
    applyAlphaState() {}, drawBatch: batch => drawn.push(batch), selectShadowInstances: () => null, bindPlaceholderOpaqueShadow() {},
  });
  return { instance, calls, drawn };
}

test('the cascade filter reads the sun tint map, and a shader without cascades keeps the plain tint lookup', () => {
  const cascaded = createFragmentShader(['cascadedShadows', 'tintedShadows']);
  assert.match(cascaded, /#define tintedShadowTransmittance\(normal\) cascadeTintTransmittance\(normal\)/);
  assert.match(cascaded, /uniform vec3 cascadeTintView;/);
  assert.doesNotMatch(createFragmentShader(['tintedShadows']), /cascadeTint/);
  assert.doesNotMatch(createFragmentShader([]), /cascadeTint/);
});

test('a sun cascade leaves blended and transmissive casters to the tint map, and a local light tile still draws them opaque', () => {
  const { instance, drawn } = rendererWith([opaqueBatch, glassBatch]);
  instance.drawShadowCasters(new Float32Array(16), 2048, true);
  assert.deepEqual(drawn, [opaqueBatch], 'the sun draws the opaque caster only');
  drawn.length = 0;
  instance.drawShadowCasters(new Float32Array(16), 512, false);
  assert.deepEqual(drawn, [opaqueBatch, glassBatch], 'a spot or point tile has no tint map');
});

test('every cascade slice draws as a sun map, so the tint map owns the glass there too', () => {
  const { context } = recordingContext();
  const sunMapFlags = [];
  const cascades = createCascadedShadows({ count: 2, resolution: 256 });
  cascades.fitToCamera = () => true;
  cascades.layerCount = 2;
  cascades.update({ context, renderTargets: { record() {} }, drawShadowCasters: (matrix, resolution, sunMap) => sunMapFlags.push(sunMap) }, true);
  assert.deepEqual(sunMapFlags, [true, true]);
});

test('a one texel sun map draws no casters, so the tint pass is never cut against one texel', () => {
  const { instance, drawn, calls } = rendererWith([opaqueBatch, glassBatch]);
  instance.drawShadowCasters(new Float32Array(16), 1, true);
  assert.deepEqual(drawn, []);
  assert.ok(calls.some(([name, location]) => name === 'uniform1i' && location === 'opaqueShadow'), 'the shadow program samplers are still set up');
});

test('the sun pass records the size of the tint view and the bias of one tint texel', () => {
  const { instance } = rendererWith([glassBatch]);
  instance.createShadowMap();
  assert.ok(instance.tintView, 'the view is recorded');
  assert.ok(instance.tintView.depthRange > 0);
  assert.equal(instance.tintView.uvPerMetre, 1 / 8, 'one map unit per 2 x shadow.extent metres');
  assert.ok(instance.tintView.biasPerSlope > 0 && instance.tintView.biasPerSlope < 0.01);
});

test('the cascades upload the tint view beside the sun angle', () => {
  const { context, calls } = recordingContext();
  const cascades = createCascadedShadows({ count: 1, resolution: 256 });
  cascades.bindUniforms({ context, program: {}, environment: { sunAngularRadius: 0.05 }, tintView: { depthRange: 30, uvPerMetre: 0.125, biasPerSlope: 0.002 } });
  const upload = calls.find(([name]) => name === 'uniform3f');
  assert.deepEqual(upload.slice(2), [30, 0.125, 0.002]);
});

// Draws a small pane in front of a wall seen almost head on, from the sun side, and reads the wall at the pane's shadow.
async function drawPane(page, settings) {
  const task = async ({ distance, cascaded, withPane }) => {
    await import('/src/liquid-shader.js');
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createCascadedShadows } = await import('/src/cascaded-shadows.js');
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    document.body.append(canvas);
    const place = (scaleX, scaleY, scaleZ, x, y, z) => new Float32Array([scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, x, y, z, 1]);
    const wall = { name: 'wall', geometry: box(0, 1), matrix: place(8, 8, 0.2, 0, 2, -distance - 0.1), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.9, emission: 0 } };
    const pane = { name: 'pane', geometry: box(0, 1), matrix: place(0.9, 0.3, 0.04, 0, 3, 0), material: { tag: 'surface', color: [1, 0.1, 0.05], metallic: 0, roughness: 0.9, emission: 0, alphaMode: 'blend', opacity: 0.4, transmission: 0.7 } };
    const sunAngularRadius = 0.05;
    const options = { samples: 1, pixelRatio: 1, ground: false, depth: true, shadowBounds: { extent: 6 }, environment: cascaded ? { sunAngularRadius } : {}, ...(cascaded ? { shadowCascades: createCascadedShadows({ count: 1, resolution: 1024 }) } : {}) };
    const instance = new CrucibleRenderer(canvas, withPane ? [wall, pane] : [wall], options);
    const sky = [0.3, 0.3, 0.3];
    const frame = { eye: [0, 2.5, 40], target: [0, 2.5, 0], fov: 8, environment: { skyTop: sky, skyBottom: sky, lightDirection: [0.3, 0.7, 0.65], ...(cascaded ? { sunAngularRadius } : {}) } };
    instance.render(frame);
    instance.render(frame);
    const toPixels = (distanceFromCamera, x, y) => {
      const halfHeight = distanceFromCamera * Math.tan((frame.fov * Math.PI) / 360);
      return [Math.round(size / 2 + (x / halfHeight) * (size / 2)), Math.round(size / 2 - ((y - 2.5) / halfHeight) * (size / 2))];
    };
    // The shadow of the pane centre on the wall: along the light, back to the wall plane.
    const light = frame.environment.lightDirection;
    const shadowCentre = [0 - distance * light[0] / light[2], 3 - distance * light[1] / light[2]];
    const [column, rowFromTop] = toPixels(40 + distance, shadowCentre[0], shadowCentre[1]);
    const row = new Uint8Array(size * 4);
    instance.context.readPixels(0, size - 1 - rowFromTop, size, 1, instance.context.RGBA, instance.context.UNSIGNED_BYTE, row);
    return { column, row: Array.from(row), error: instance.context.getError() };
  };
  return page.evaluate(task, settings);
}

const greenAt = (result, column) => result.row[column * 4 + 1];

// Width in pixels of the left edge of the shadow, from 10 to 90 percent of the drop in green.
function leftEdgeWidth(shadowed, lit, column) {
  const drop = x => lit.row[x * 4 + 1] - shadowed.row[x * 4 + 1];
  const inside = drop(column);
  let outer = column;
  while (outer > 0 && drop(outer) > 0.1 * inside) outer--;
  let inner = outer;
  while (inner < column && drop(inner) < 0.9 * inside) inner++;
  return { width: inner - outer, inside };
}

test('under the soft cascades a pane throws its tinted shadow, with a penumbra that widens with the distance to the wall', async (context) => {
  await withDevServerPage(context, async (page) => {
    const measurements = {};
    for (const distance of [0.4, 1.6]) {
      const lit = await drawPane(page, { distance, cascaded: true, withPane: false });
      const cascaded = await drawPane(page, { distance, cascaded: true, withPane: true });
      assert.equal(cascaded.error, 0, 'no WebGL error');
      measurements[distance] = { cascaded, lit, edge: leftEdgeWidth(cascaded, lit, cascaded.column) };
    }
    const far = measurements[1.6];
    const single = await drawPane(page, { distance: 1.6, cascaded: false, withPane: true });
    const singleLit = await drawPane(page, { distance: 1.6, cascaded: false, withPane: false });
    const column = far.cascaded.column;
    const tintedShare = (shadowed, lit) => greenAt(shadowed, column) / greenAt(lit, column);
    assert.ok(tintedShare(far.cascaded, far.lit) < 0.97, `the pane darkens the wall under the cascades (green share ${tintedShare(far.cascaded, far.lit)})`);
    assert.ok(Math.abs(tintedShare(far.cascaded, far.lit) - tintedShare(single, singleLit)) < 0.03, 'the cascade shadow has the tint of the single map shadow');
    assert.ok(far.edge.width >= 2 * measurements[0.4].edge.width, `the penumbra widens with the gap: ${measurements[0.4].edge.width} px at 0.4 m, ${far.edge.width} px at 1.6 m`);
  });
});
