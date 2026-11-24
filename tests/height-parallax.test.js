import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFragmentShader } from '../src/shaders.js';
import { referenceParallaxShift } from '../src/height-parallax-shader.js';
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

test('the march lands on a flat floor at its depth, ignores a surface at the top and clamps at full depth', () => {
  const fullShift = [0.2, -0.1];
  const floorAtHalf = referenceParallaxShift(() => 0.5, fullShift, 16);
  assert.ok(Math.abs(floorAtHalf[0] + 0.1) < 1e-9 && Math.abs(floorAtHalf[1] - 0.05) < 1e-9, `a floor half way down shifts by half: ${floorAtHalf}`);
  assert.deepEqual(referenceParallaxShift(() => 1, fullShift, 16), [-0, 0], 'a surface at the top does not shift');
  const deepest = referenceParallaxShift(() => 0, fullShift, 16);
  assert.ok(Math.abs(deepest[0] + 0.2) < 1e-9 && Math.abs(deepest[1] - 0.1) < 1e-9, `a floor at full depth shifts by the full amount: ${deepest}`);
});

test('the march crosses a bump top between two steps at the interpolated depth', () => {
  const bump = offsetU => (offsetU < -0.05 ? 0.2 : 0.9);
  const shift = referenceParallaxShift(bump, [0.2, 0], 8);
  assert.ok(Math.abs(shift[0] + 0.02) < 1e-9, `the ray meets the top of the bump a tenth of the way down: ${shift[0]}`);
});

test('the program reads every UV set 0 map through the shifted UV, with no ternary the GPU compiler leaves unshifted', () => {
  const features = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'heightMap'];
  const relief = createFragmentShader(features);
  assert.doesNotMatch(relief, /BOX_MAPPED \?/);
  for (const [sampler, flag] of [['baseMap', 'hasBaseMap'], ['emissiveMap', 'hasEmissiveMap'], ['metallicRoughnessMap', 'hasMetallicRoughnessMap']]) {
    assert.ok(relief.includes(`mappedSample(${sampler}, ${flag})`), `${sampler} is read through mappedSample`);
  }
  assert.ok(relief.includes('mappedOrBoxNormal(normal)'));
  assert.match(relief, /if \(BOX_MAPPED\) return sampleBox\(source\);\n  return texture\(source, mapUV\(flag\)\);/);
  assert.match(createFragmentShader(['baseMap', 'normalMap']), /BOX_MAPPED \? sampleBox\(baseMap\)/, 'a program without the feature keeps the ternary');
});

test('heightMap without heightScale is reported as ignored, and a heightScale above 0 clears the warning', () => {
  const ignored = scene => (scene.inspect().diagnostics ?? []).filter(problem => problem.kind === 'ignored-material-field');
  assert.equal(ignored(sceneWith({})).length, 1);
  assert.match(ignored(sceneWith({}))[0].message, /heightMap is ignored: heightScale/);
  assert.equal(ignored(sceneWith({ heightScale: 0.02 })).length, 0);
});
