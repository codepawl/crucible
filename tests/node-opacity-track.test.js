import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { instanceOpacity } from '../src/renderer.js';
import { splitText, staggerNodeTracks } from '../src/kinetic-text.js';

const FADE_IN = [{ time: 0, value: 0 }, { time: 1, value: 1 }];

function recipeWith({ material = {}, tracks, extraNodes = [] }) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'paint', color: [0.8, 0.2, 0.2], roughness: 0.5, ...material }],
    nodes: [{ id: 'fading', geometry: 'box', material: 'paint' }, { id: 'steady', geometry: 'box', material: 'paint', translation: [3, 0, 0] }, ...extraNodes],
    ...(tracks === undefined ? {} : { motion: { duration: 1, tracks } }),
  };
}

function fadeTrack(keyframes = FADE_IN, extra = {}) {
  return [{ kind: 'node', id: 'fading', property: 'opacity', keyframes, ...extra }];
}

const partOf = (scene, id) => scene.parts.find(part => part.name === id);

test('an opacity track fades a part from 0 to 1 at sample time', () => {
  const scene = createAgentScene(recipeWith({ tracks: fadeTrack() }));
  scene.sampleMotion(0);
  assert.equal(partOf(scene, 'fading').opacityScale.value, 0);
  assert.equal(instanceOpacity(partOf(scene, 'fading').material, partOf(scene, 'fading')), 0);
  scene.sampleMotion(0.5);
  assert.ok(Math.abs(partOf(scene, 'fading').opacityScale.value - 0.5) < 1e-9);
  scene.sampleMotion(1);
  assert.equal(partOf(scene, 'fading').opacityScale.value, 1);
  assert.equal(instanceOpacity(partOf(scene, 'fading').material, partOf(scene, 'fading')), 1);
});

test('the sampled opacity multiplies the material opacity and follows keyframe easing', () => {
  const scene = createAgentScene(recipeWith({ material: { alphaMode: 'blend', opacity: 0.5 }, tracks: fadeTrack([{ time: 0, value: 0, easing: 'easeInQuad' }, { time: 1, value: 1 }]) }));
  scene.sampleMotion(0.5);
  const part = partOf(scene, 'fading');
  assert.ok(Math.abs(part.opacityScale.value - 0.25) < 1e-9, 'easeInQuad at half time is 0.25');
  assert.ok(Math.abs(instanceOpacity(part.material, part) - 0.125) < 1e-9, '0.5 material opacity times 0.25');
});

test('a child of a faded node fades with it, multiplied by its own track', () => {
  const scene = createAgentScene(recipeWith({
    extraNodes: [{ id: 'child', parent: 'fading', geometry: 'box', material: 'paint', translation: [0, 2, 0] }],
    tracks: [...fadeTrack(), { kind: 'node', id: 'child', property: 'opacity', keyframes: [{ time: 0, value: 0.5 }, { time: 1, value: 0.5 }] }],
  }));
  scene.sampleMotion(0.5);
  assert.ok(Math.abs(partOf(scene, 'child').opacityScale.value - 0.25) < 1e-9);
});

test('values outside 0 to 1 name the allowed range', () => {
  assert.throws(() => createAgentScene(recipeWith({ tracks: fadeTrack([{ time: 0, value: 0 }, { time: 1, value: 1.5 }]) })), /opacity from 0 \(clear\) to 1 \(opaque\)/);
  assert.throws(() => createAgentScene(recipeWith({ tracks: fadeTrack([{ time: 0, value: -0.1 }, { time: 1, value: 1 }]) })), /opacity from 0 \(clear\) to 1 \(opaque\)/);
});

test('a shared material is not changed for the nodes that do not fade', () => {
  const scene = createAgentScene(recipeWith({ tracks: fadeTrack() }));
  scene.sampleMotion(0.25);
  const steady = partOf(scene, 'steady');
  assert.equal(partOf(scene, 'fading').material.alphaMode, 'blend', 'the fading part draws blended');
  assert.equal(steady.material.alphaMode, 'opaque', 'the other node keeps the shared opaque material');
  assert.equal(steady.opacityScale, undefined);
  assert.equal(instanceOpacity(steady.material, steady), 1);
});

test('a scene without an opacity track builds the same parts as before', () => {
  const otherTrack = [{ kind: 'node', id: 'fading', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 1, 0] }] }];
  for (const scene of [createAgentScene(recipeWith({ tracks: otherTrack })), createAgentScene(recipeWith({}))]) {
    for (const part of scene.parts) {
      assert.equal(Object.hasOwn(part, 'opacityScale'), false);
      assert.equal(part.material.alphaMode, 'opaque');
      assert.equal(instanceOpacity(part.material, part), 1);
    }
  }
});

test('staggerNodeTracks fades letters in one after another', () => {
  const title = splitText('CRU', { id: 'title', split: 'letters', material: 'paint' });
  const { tracks, duration } = staggerNodeTracks(title.nodes, { property: 'opacity', keyframes: FADE_IN, offset: 0.5 });
  const scene = createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: title.geometries, materials: [{ id: 'paint', color: [1, 1, 1], roughness: 0.4 }], nodes: title.nodes, motion: { duration, tracks } });
  scene.sampleMotion(0.5);
  const values = title.nodes.map(node => partOf(scene, node.id).opacityScale.value);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-9 && values[1] === 0 && values[2] === 0, `first letter half faded, later letters still clear: ${values}`);
  scene.sampleMotion(duration);
  assert.deepEqual(title.nodes.map(node => partOf(scene, node.id).opacityScale.value), [1, 1, 1]);
  assert.throws(() => staggerNodeTracks(title.nodes, { property: 'opacity', keyframes: [{ time: 0, value: 2 }], offset: 0.1 }), /opacity from 0 \(clear\) to 1 \(opaque\)/);
});

test('a copy of the fading material keeps every field of the shared material', () => {
  const scene = createAgentScene(recipeWith({ tracks: fadeTrack() }));
  const shared = partOf(scene, 'steady').material;
  const copy = { ...partOf(scene, 'fading').material };
  assert.deepEqual(copy.color, shared.color);
  assert.equal(copy.roughness, shared.roughness);
  assert.equal(copy.alphaMode, 'blend');
});

test('without an opacity track every part keeps the shared material object and the same fields', () => {
  const scene = createAgentScene(recipeWith({}));
  const [first, second] = scene.parts;
  assert.equal(first.material, second.material, 'nodes that share a material share one material object');
  assert.equal(first.material.alphaMode, 'opaque');
  assert.equal(first.material.opacity, 1);
  assert.equal(Object.hasOwn(first, 'opacityScale'), false);
});
