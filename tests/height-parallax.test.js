import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFragmentShader } from '../src/shaders.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';

await loadAllAgentSceneModules();

const HEIGHT_IMAGE = 'a'.repeat(64);
const GREY_FRAME = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(100) };

function sceneWith(material) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', heightMap: HEIGHT_IMAGE, ...material }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: new Map([[HEIGHT_IMAGE, GREY_FRAME]]) });
}

test('heightScale, heightFade and heightSteps are bounded and name what to pass', () => {
  assert.throws(() => sceneWith({ heightScale: 0.9 }), /heightScale/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightFade: 0 }), /heightFade/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightSteps: 2 }), /heightSteps/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightSteps: 8.5 }), /whole number/);
  const material = sceneWith({ heightScale: 0.02, heightFade: 12, heightSteps: 16 }).parts[0].material;
  assert.deepEqual([material.heightScale, material.heightFade, material.heightSteps], [0.02, 12, 16]);
});

test('the parallax fields need a heightMap', () => {
  assert.throws(() => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', heightScale: 0.02 }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }), /heightMap/);
});

test('a shader without the heightMap feature keeps its source, and the feature adds the march and the shifted UV', () => {
  const plain = createFragmentShader(['baseMap', 'normalMap']);
  assert.doesNotMatch(plain, /parallax|heightState/);
  const hash = createHash('sha256').update(plain).digest('hex');
  assert.equal(createHash('sha256').update(createFragmentShader(['baseMap', 'normalMap'])).digest('hex'), hash);
  const relief = createFragmentShader(['baseMap', 'normalMap', 'heightMap']);
  assert.match(relief, /textureGrad\(heightMap/);
  assert.match(relief, /textureUV \+ parallaxShift/);
  assert.match(relief, /dFdx\(frameCoordinates\)/);
});
