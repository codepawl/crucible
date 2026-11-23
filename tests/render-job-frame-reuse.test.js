import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installCoplanarDiagnostics } from '../src/coplanar-overlap.js';
import { previewHarness } from './support/preview-harness.mjs';

// Issue 3038: every later frame of a render job rebuilt the renderer and searched the layout for coplanar faces again.

function seaWithTexturedBox() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 2 }, { op: 'ocean', coverage: 1, seed: 3, windSpeed: 4, size: 2, resolution: 4 }] },
      { id: 'cube', type: 'box' },
    ],
    materials: [{ id: 'water', color: [0.1, 0.3, 0.5] }, { id: 'bricks', color: [1, 1, 1], pattern: { type: 'bricks', size: 1 } }],
    nodes: [{ id: 'surface', geometry: 'sea', material: 'water' }, { id: 'wall', geometry: 'cube', material: 'bricks', translation: [0, 2, 0] }],
    camera: { eye: [30, 20, 30], target: [0, 0, 0] },
    motion: {
      duration: 4,
      tracks: [
        { kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 8 }] },
        { kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [30, 20, 30] }, { time: 4, value: [20, 20, 30] }] },
      ],
    },
  };
}

test('frames that move only the sea of a textured scene keep the renderer and its textured batches', () => {
  const harness = previewHarness();
  const sessionId = 'sea-frames';
  harness.preview.create({ recipe: seaWithTexturedBox(), sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  const renderersAfterCreate = harness.rendererOptions.length;
  for (const motionTime of [1, 2, 3]) harness.preview.frame({ sessionId, motionTime });
  assert.equal(harness.rendererOptions.length, renderersAfterCreate, 'no frame builds a new renderer');
  assert.ok(harness.replacementCount() >= 3, 'each new sea is uploaded by replaceParts');
});

test('a frame falls back to a new renderer when replaceParts refuses the change', () => {
  const harness = previewHarness();
  const sessionId = 'sea-refused';
  harness.preview.create({ recipe: seaWithTexturedBox(), sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  const renderersAfterCreate = harness.rendererOptions.length;
  harness.rejectReplacement(true);
  harness.preview.frame({ sessionId, motionTime: 1 });
  assert.equal(harness.rendererOptions.length, renderersAfterCreate + 1);
});

function countingBatches(partCounter) {
  const part = { name: 'floor', geometry: { positions: new Float32Array(9), indices: new Uint32Array(3) }, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  return [{ get parts() { partCounter.searches++; return [part]; } }];
}

test('renderers of one moving scene search the coplanar layout once while the revision holds', () => {
  const searchCounter = { searches: 0 };
  const held = {};
  let revision = 4;
  const carry = { held, key: () => revision };
  const firstRenderer = installCoplanarDiagnostics({}, null, carry);
  firstRenderer.coplanarDiagnostics(countingBatches(searchCounter));
  const secondRenderer = installCoplanarDiagnostics({}, null, carry);
  secondRenderer.coplanarDiagnostics(countingBatches(searchCounter));
  secondRenderer.coplanarDiagnostics(countingBatches(searchCounter));
  assert.equal(searchCounter.searches, 1, 'later layouts take the held warnings');
  revision = 5;
  secondRenderer.coplanarDiagnostics(countingBatches(searchCounter));
  assert.equal(searchCounter.searches, 2, 'an edit searches again');
});

test('a scene with no sampled time never takes held coplanar warnings', () => {
  const searchCounter = { searches: 0 };
  const carry = { held: {}, key: () => undefined };
  installCoplanarDiagnostics({}, null, carry).coplanarDiagnostics(countingBatches(searchCounter));
  installCoplanarDiagnostics({}, null, carry).coplanarDiagnostics(countingBatches(searchCounter));
  assert.equal(searchCounter.searches, 2);
});
