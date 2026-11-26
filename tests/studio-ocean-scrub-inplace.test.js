import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveGeometry, isReindexedGeometry } from '../src/live-geometry.js';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio } from '../src/studio.js';
import { createStudioController } from '../src/studio-controller.js';
import { syncLiveGeometryParts } from '../src/studio-live-parts.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };

function seaRecipe({ spray = false } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      {
        id: 'sea',
        type: 'mesh',
        base: { type: 'box', bevel: 0 },
        edits: [{ op: 'subdivide', levels: 3 }],
        stack: [{ op: 'ocean', coverage: 1, seed: 5, windSpeed: 12, choppiness: 1.5, size: 12, resolution: 4, time: 0, ...(spray ? { spray: true } : {}) }],
      },
    ],
    materials: [
      { id: 'paint', tag: 'surface', color: [0.6, 0.4, 0.3], roughness: 0.5, metallic: 0 },
      { id: 'water', tag: 'water', color: [0.1, 0.35, 0.55] },
    ],
    nodes: [
      { id: 'hero', geometry: 'box', material: 'paint', translation: [0, 1, 0] },
      { id: 'companion', geometry: 'box', material: 'paint', translation: [3, 1, 0] },
      { id: 'surface', geometry: 'sea', material: 'water', translation: [0, -1, 0] },
    ],
    camera: { eye: [10, 6, 12], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
    motion: {
      duration: 4,
      tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 4 }] }],
    },
  };
}

function createRecordingRenderer() {
  const base = createFakeRenderer();
  const uploads = [];
  let forgetFitsCalls = 0;
  base.partLocations = new Map();
  base.geometryBuffers = new Map();
  base.shadowCascades = {
    forgetFits() {
      forgetFitsCalls += 1;
    },
  };
  base.context = {
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    bindVertexArray() {},
    bindBuffer() {},
    bufferSubData(target, offset, data) {
      uploads.push({ target, offset, length: data.length, first: data[0] });
    },
  };
  const registerParts = parts => {
    base.partLocations.clear();
    base.geometryBuffers.clear();
    for (const part of parts) {
      const batch = { parts, bounds: null };
      base.partLocations.set(part, { batch, geometry: part.geometry });
      base.geometryBuffers.set(part.geometry, new Map([
        ['positions', 'positionsBuffer'],
        ['normals', 'normalsBuffer'],
        ['colors', 'colorsBuffer'],
        ['indices', 'indicesBuffer'],
      ]));
    }
  };
  const originalReplaceParts = base.replaceParts;
  base.replaceParts = parts => {
    originalReplaceParts(parts);
    registerParts(parts);
  };
  return { renderer: base, uploads, getForgetFitsCalls: () => forgetFitsCalls };
}

function controllerFor(options = {}) {
  return createStudioController({ scene: createAgentScene(seaRecipe(options)) });
}

test('undo of a transform keeps identical untouched part objects', () => {
  const controller = controllerFor();
  const heroBefore = controller.scene.parts.find(part => part.name === 'hero');
  const companionBefore = controller.scene.parts.find(part => part.name === 'companion');
  const topologyBefore = controller.scene.topologyRevision;

  controller.updateNodeTransform('hero', { translation: [2, 1.5, -1] });
  controller.undo();

  const heroAfter = controller.scene.parts.find(part => part.name === 'hero');
  const companionAfter = controller.scene.parts.find(part => part.name === 'companion');
  assert.equal(controller.scene.topologyRevision, topologyBefore);
  assert.equal(companionAfter, companionBefore);
  assert.equal(heroAfter, heroBefore);
});

for (const spray of [false, true]) {
  test(`setMotionTime on an oceanTime sea (spray=${spray}) keeps topologyRevision and part identity`, () => {
    const controller = controllerFor({ spray });
    const topologyBefore = controller.scene.topologyRevision;
    const seaPartBefore = controller.scene.parts.find(part => part.name === 'surface');
    const seaGeometryBefore = seaPartBefore.geometry;
    const positionsAtZero = Float32Array.from(seaGeometryBefore.positions);
    const vectorsAtZero = spray ? Float32Array.from(seaGeometryBefore.vertexVectors.spray) : null;

    controller.setMotionTime(1.5);
    const seaPartAtMid = controller.scene.parts.find(part => part.name === 'surface');
    assert.equal(controller.scene.topologyRevision, topologyBefore);
    assert.equal(seaPartAtMid, seaPartBefore);
    assert.equal(seaPartAtMid.geometry, seaGeometryBefore);
    assert.equal(isLiveGeometry(seaPartAtMid.geometry), true);
    assert.equal(isReindexedGeometry(seaPartAtMid.geometry), true);
    assert.notDeepEqual(Array.from(seaPartAtMid.geometry.positions), Array.from(positionsAtZero));
    if (spray) {
      assert.notDeepEqual(Array.from(seaPartAtMid.geometry.vertexVectors.spray), Array.from(vectorsAtZero));
    }

    controller.setMotionTime(2.75);
    assert.equal(controller.scene.topologyRevision, topologyBefore);
    assert.equal(controller.scene.parts.find(part => part.name === 'surface'), seaPartBefore);
    assert.equal(controller.scene.parts.find(part => part.name === 'surface').geometry, seaGeometryBefore);
  });
}

test('syncLiveGeometryParts uploads live reindexed parts and skips static or unknown parts', () => {
  const controller = controllerFor({ spray: true });
  const { renderer, uploads, getForgetFitsCalls } = createRecordingRenderer();
  renderer.replaceParts(controller.scene.parts);
  uploads.length = 0;

  const updated = syncLiveGeometryParts(renderer, controller.scene.parts);
  assert.equal(updated, 1);
  assert.equal(uploads.length, 4);
  assert.equal(getForgetFitsCalls(), 1);
});

test('Studio viewport syncs live sea vertices in place on scrub and skips upload on camera orbit', testContext => {
  const dom = installStudioDom();
  const { renderer, uploads, getForgetFitsCalls } = createRecordingRenderer();
  const studio = createStudio(dom.container, {
    recipe: seaRecipe({ spray: true }),
    createRenderer: () => renderer,
  });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  dom.container.firstElementChild.querySelector('.crucible-studio-viewport').box = VIEWPORT_BOX;

  studio.renderNow();
  assert.equal(renderer.calls.filter(name => name === 'replaceParts').length, 1);
  assert.equal(uploads.length, 0);

  studio.controller.moveViewportCamera({ eye: [11, 6, 12] });
  studio.renderNow();
  assert.equal(renderer.calls.filter(name => name === 'replaceParts').length, 1);
  assert.equal(renderer.calls.filter(name => name === 'updateParts').length, 2);
  assert.equal(uploads.length, 0, 'camera-only redraw skips vertex buffer uploads');

  const topologyBeforeScrub = studio.controller.scene.topologyRevision;
  const positionsBefore = Float32Array.from(studio.controller.scene.parts.find(part => part.name === 'surface').geometry.positions);
  studio.controller.setMotionTime(1.5);
  studio.renderNow();

  assert.equal(studio.controller.scene.topologyRevision, topologyBeforeScrub);
  assert.equal(renderer.calls.filter(name => name === 'replaceParts').length, 1);
  assert.equal(renderer.calls.filter(name => name === 'updateParts').length, 3);
  assert.equal(uploads.length, 4, 'scrub uploads positions, normals, skyVisibility and indices in place');
  assert.equal(getForgetFitsCalls(), 1);
  const positionsAfter = studio.controller.scene.parts.find(part => part.name === 'surface').geometry.positions;
  assert.notDeepEqual(Array.from(positionsAfter), Array.from(positionsBefore));

  uploads.length = 0;
  studio.controller.moveViewportCamera({ eye: [12, 7, 13] });
  studio.renderNow();
  assert.equal(uploads.length, 0, 'camera orbit after scrub skips redundant vertex uploads');

  studio.controller.setMotionTime(0);
  studio.renderNow();
  assert.equal(uploads.length, 4, 'scrubbing back to 0 uploads the t=0 vertices');
});
