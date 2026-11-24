import assert from 'node:assert/strict';
import test from 'node:test';

import { CrucibleRenderer, additiveBatchesBehindShells } from '../src/renderer.js';

const GEOMETRY = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint16Array([0, 1, 2]),
};

// The camera looks down -z with an identity view, so a more negative z is farther away.
function batchAt(name, alphaMode, depthZ, extra = {}) {
  const instanceData = new Float32Array(42);
  instanceData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, depthZ, 1]);
  return {
    alphaMode,
    pass: extra.pass ?? 'opaque',
    depthTest: true,
    instanceCount: 1,
    instanceData,
    layerState: extra.layerState ?? new Float32Array(32),
    parts: [{ name, geometry: GEOMETRY, material: { color: [1, 1, 1], alphaMode } }],
  };
}

function glassAt(name, depthZ) {
  const layerState = new Float32Array(32);
  layerState[9] = 1;
  return batchAt(name, 'blend', depthZ, { pass: 'liquid', layerState });
}

function makeRenderer(batches, draws) {
  const context = new Proxy({ DEPTH_TEST: 1, BLEND: 2 }, { get: (target, key) => target[key] ?? (() => {}) });
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.context = context;
  renderer.canvas = { width: 8, height: 8 };
  renderer.multisampleFramebuffer = {};
  renderer.program = {};
  renderer.shadowTexture = {};
  renderer.uniforms = { shadowMap: null };
  renderer.view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  renderer.batches = batches;
  renderer.applyDepthRank = () => {};
  renderer.uploadSortedInstances = () => {};
  renderer.drawAlphaBatch = batch => draws.push(batch.parts[0].name);
  return renderer;
}

test('an additive batch farther than every transmissive shell is picked, one in front or between is not', () => {
  const near = glassAt('near-pane', -2);
  const far = glassAt('far-pane', -4);
  const renderer = makeRenderer([], []);
  const behind = batchAt('behind', 'add', -6);
  const between = batchAt('between', 'add', -3);
  const inFront = batchAt('front', 'add', -1);
  const picked = additiveBatchesBehindShells(renderer, [behind, between, inFront], [near, far]);
  assert.deepEqual(picked.map(batch => batch.parts[0].name), ['behind']);
});

test('a beam behind a pane draws before the pane reads the scene, a beam in front draws after it (#3206)', () => {
  const draws = [];
  const pane = glassAt('pane', -2);
  const behind = batchAt('beam-behind', 'add', -5);
  const front = batchAt('beam-front', 'add', -1);
  const renderer = makeRenderer([behind, front, pane], draws);

  renderer.drawAdditiveBehindShells([pane]);
  draws.push('PANE');
  renderer.drawBlendBatches({ eye: [0, 0, 5] });

  assert.deepEqual(draws, ['beam-behind', 'PANE', 'beam-front']);
});

test('a scene without a transmissive shell draws its additive batches in the old place', () => {
  const draws = [];
  const renderer = makeRenderer([batchAt('beam', 'add', -5)], draws);
  renderer.drawAdditiveBehindShells([]);
  renderer.drawBlendBatches({ eye: [0, 0, 5] });
  assert.deepEqual(draws, ['beam']);
});
