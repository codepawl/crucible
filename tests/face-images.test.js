import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { FACE_NAMES } from '../src/agent-face-images.js';
import { textureDescriptorInfo } from '../src/renderer.js';

await loadAllAgentSceneModules();

const IMAGE = 'a'.repeat(64);
const FRAME_IDS = ['b', 'c', 'd', 'e'].map(letter => letter.repeat(64));
const FRAME_REDS = [100, 140, 180, 220];

function solid(red) {
  const data = new Uint8ClampedArray(16);
  for (let offset = 0; offset < data.length; offset += 4) data.set([red, 0, 0, 128], offset);
  return { width: 2, height: 2, data };
}

const pool = new Map([[IMAGE, solid(10)], ...FRAME_IDS.map((id, index) => [id, solid(FRAME_REDS[index])])]);

function sceneWith(faceImages, nodeFields = {}) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }],
    materials: [{ id: 'wood', color: [0.5, 0.3, 0.1] }],
    nodes: [{ id: 'wall', geometry: 'block', material: 'wood', scale: [4, 2, 0.5], ...nodeFields, faceImages }],
    camera: { eye: [0, 3, 6], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: pool });
}

function decalParts(scene) {
  return scene.parts.filter(part => part.material.alphaMode === 'blend');
}

function decalPart(scene) {
  return decalParts(scene)[0];
}

function transformPoint(matrix, point) {
  return [0, 1, 2].map(row => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row]);
}

function transformDirection(matrix, direction) {
  return [0, 1, 2].map(row => matrix[row] * direction[0] + matrix[4 + row] * direction[1] + matrix[8 + row] * direction[2]);
}

function uvRange(part, axis) {
  const values = Array.from(part.geometry.uvs).filter((_, index) => index % 2 === axis);
  return Math.max(...values) - Math.min(...values);
}

const NORMALS = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

test('each face name puts the image quad outside that face, facing out', () => {
  const half = [2, 1, 0.25];
  for (const face of FACE_NAMES) {
    const part = decalPart(sceneWith([{ face, colorMap: IMAGE }]));
    assert.ok(part, `${face} has a quad part`);
    const normal = transformDirection(part.matrix, [0, 0, 1]);
    const length = Math.hypot(...normal);
    normal.forEach((value, axis) => assert.ok(Math.abs(value / length - NORMALS[face][axis]) < 1e-6, `${face} faces outward`));
    const centre = transformPoint(part.matrix, [0, 0, 0]);
    const axis = NORMALS[face].findIndex(value => value !== 0);
    const distance = Math.abs(centre[axis]);
    assert.ok(distance > half[axis] && distance < half[axis] + 0.001, `${face} sits a hair outside the face, got ${distance}`);
    assert.equal(Math.sign(centre[axis]), NORMALS[face][axis]);
    [0, 1, 2].filter(index => index !== axis).forEach(index => assert.ok(Math.abs(centre[index]) < 1e-9, `${face} is centred on the face`));
  }
});

test('the quad covers the whole face', () => {
  const part = decalPart(sceneWith([{ face: '+x', colorMap: IMAGE }]));
  const corner = transformPoint(part.matrix, [0.5, 0.5, 0]);
  const centre = transformPoint(part.matrix, [0, 0, 0]);
  assert.ok(Math.abs(Math.abs(corner[2] - centre[2]) - 0.25) < 1e-6, 'half the face depth of 0.5 m along z');
  assert.ok(Math.abs(Math.abs(corner[1] - centre[1]) - 1) < 1e-6, 'half the face height of 2 m along y');
});

test('a tile size in metres keeps the tiling constant when the part is resized', () => {
  const tile = [0.5, 0.25];
  const base = decalPart(sceneWith([{ face: '+z', colorMap: IMAGE, tile }]));
  assert.ok(Math.abs(uvRange(base, 0) - 8) < 1e-5, 'a 4 m face at 0.5 m a tile is 8 tiles across');
  assert.ok(Math.abs(uvRange(base, 1) - 8) < 1e-5, 'a 2 m face at 0.25 m a tile is 8 tiles up');
  const wider = decalPart(sceneWith([{ face: '+z', colorMap: IMAGE, tile }], { scale: [8, 2, 0.5] }));
  assert.ok(Math.abs(uvRange(wider, 0) - 16) < 1e-5, 'twice as wide, twice the tiles, the same metres per tile');
  assert.ok(Math.abs(uvRange(wider, 1) - 8) < 1e-5, 'the height did not change');
  const side = decalPart(sceneWith([{ face: '+x', colorMap: IMAGE, tile: [1, 1] }]));
  assert.ok(Math.abs(uvRange(side, 0) - 0.5) < 1e-5, 'the +x face is 0.5 m deep');
  assert.ok(Math.abs(uvRange(side, 1) - 2) < 1e-5, 'and 2 m tall');
});

test('alpha mode, tint and opacity reach the quad material and offset moves the tiles', () => {
  const part = decalPart(sceneWith([{ face: '+z', colorMap: IMAGE, color: [1, 0.5, 0.5], opacity: 0.5, offset: [0.25, 0] }]));
  assert.equal(part.material.alphaMode, 'blend');
  assert.equal(part.material.opacity, 0.5);
  assert.deepEqual(Array.from(part.material.color), [1, 0.5, 0.5]);
  assert.ok(part.material.map, 'the image is the colour map');
  assert.ok(Math.abs(Math.min(...Array.from(part.geometry.uvs).filter((_, index) => index % 2 === 0)) - 0.25) < 1e-6);
});

test('a frame sequence shows the right image on each frame of the scene clock, stepped and never blended', () => {
  const fps = 30;
  const scene = sceneWith([{ face: '+z', map: { sequence: { frames: FRAME_IDS, fps, loop: true } } }]);
  const sequence = scene.sequenceTextures()[0];
  for (let frame = 0; frame < 9; frame++) {
    const expected = frame % FRAME_IDS.length;
    scene.sampleMotion(frame / fps);
    assert.equal(sequence.index, expected, `frame ${frame} picks image ${expected}`);
    assert.equal(sequence.image.data[0], FRAME_REDS[expected]);
    scene.sampleMotion((frame + 0.99) / fps);
    assert.equal(sequence.index, expected, 'the image holds until the next frame starts');
  }
});

test('a held sequence stays on its last image and stacked images on one face take depth layers', () => {
  const scene = sceneWith([
    { face: '+z', map: { sequence: { frames: FRAME_IDS, fps: 10, loop: false } } },
    { face: '+z', colorMap: IMAGE },
  ]);
  scene.sampleMotion(5);
  assert.equal(scene.sequenceTextures()[0].index, 3);
  assert.equal(decalParts(scene).length, 2);
  assert.deepEqual(scene.exportRecipe().nodes.filter(node => node.id.startsWith('wall.face-')).map(node => node.depthLayer ?? 0), [0, 1]);
});

test('changing faceImages again replaces the earlier quads', () => {
  const first = sceneWith([{ face: '+z', colorMap: IMAGE }, { face: '-z', colorMap: IMAGE }]);
  const again = createAgentScene({ ...first.exportRecipe(), nodes: first.exportRecipe().nodes.map(node => (node.id === 'wall' ? { ...node, faceImages: [{ face: '+x', colorMap: IMAGE }] } : node)) }, {}, { sequenceFrames: pool });
  assert.equal(decalParts(again).length, 1);
  assert.equal(again.exportRecipe().nodes.filter(node => node.id.startsWith('wall.face-')).length, 1);
});

test('faceImages errors say what to pass', () => {
  assert.throws(() => sceneWith([{ face: 'front', colorMap: IMAGE }]), /faceImages\[0\]\.face.*one of \+z, -z/);
  assert.throws(() => sceneWith([{ face: '+z' }]), /exactly one of colorMap/);
  assert.throws(() => sceneWith([{ face: '+z', colorMap: IMAGE, map: { sequence: { frames: FRAME_IDS, fps: 1 } } }]), /exactly one/);
  assert.throws(() => sceneWith([{ face: '+z', colorMap: IMAGE, tile: [0, 1] }]), /tile.*\[u, v\]/);
  assert.throws(() => sceneWith([{ face: '+z', colorMap: IMAGE, size: 3 }]), /faceImages\[0\]\.size.*no such field/);
  assert.throws(() => sceneWith(new Array(7).fill({ face: '+z', colorMap: IMAGE })), /at most 6 entries/);
  assert.throws(() => sceneWith([{ face: '+z', colorMap: 'not-an-id' }]), /colorMap/);
  assert.throws(() => sceneWith([{ face: '+z', map: { sequence: { frames: [FRAME_IDS[0]], fps: 12 } } }]), /2 to 4096/);
  assert.throws(() => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ball', type: 'sphere' }], materials: [],
    nodes: [{ id: 'ball', geometry: 'ball', material: 'default', faceImages: [{ face: '+z', colorMap: IMAGE }] }],
  }, {}, { sequenceFrames: pool }), /geometry is a box/);
});

test('a tiled face image is mipmapped by default, so a wall seen at a grazing angle does not alias', () => {
  const part = decalPart(sceneWith([{ face: '+z', colorMap: IMAGE, tile: [0.5, 0.5] }]));
  const info = textureDescriptorInfo(part.material.map);
  assert.equal(info.mipmaps, true, 'a mip chain is built');
  assert.equal(info.minFilter, 9987, 'with trilinear minification; the renderer adds anisotropic filtering to such a texture');
  assert.equal(info.wrapS, 10497, 'and the tiles repeat');
});
