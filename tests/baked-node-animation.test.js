import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createFileSceneClipPlayer } from '../src/file-scene-clip.js';
import { buildBakedRigGlb, expectedWorldMatrices } from './helpers/baked-rig-glb.mjs';

const TOLERANCE = 1e-4;

async function loadRig(options) {
  const rig = buildBakedRigGlb(options);
  const bytes = rig.bytes;
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const parts = [...asset.parts];
  const player = createFileSceneClipPlayer({ asset, posedParts: parts, sceneParts: parts, rendererParts: parts.map(part => ({ ...part })) });
  return { rig, parts, player };
}

function worstDifference(parts, expected) {
  let worst = 0;
  parts.forEach(part => {
    const nodeIndex = Number(part.label.slice(1));
    expected[nodeIndex].forEach((value, element) => {
      worst = Math.max(worst, Math.abs(value - part.matrix[element]));
    });
  });
  return worst;
}

test('a 120 node by 90 frame baked rig poses every node at the baked world matrix on every rendered frame', async () => {
  const { rig, parts, player } = await loadRig();
  assert.equal(parts.length, 120);
  for (let frame = 0; frame < rig.frameCount; frame += 1) {
    player.applyAt(frame / rig.framesPerSecond);
    assert.ok(worstDifference(parts, expectedWorldMatrices(rig, frame)) < TOLERANCE, `frame ${frame} differs from the baked values`);
  }
});

test('the last baked frame is posed as the last frame, not wrapped to the first', async () => {
  const { rig, parts, player } = await loadRig();
  const last = rig.frameCount - 1;
  player.applyAt(last / rig.framesPerSecond);
  assert.ok(worstDifference(parts, expectedWorldMatrices(rig, last)) < TOLERANCE);
  assert.ok(worstDifference(parts, expectedWorldMatrices(rig, 0)) > 0.01, 'the last pose must differ from the first, or the test pins nothing');
});

test('a time past the clip loops back inside it', async () => {
  const { rig, parts, player } = await loadRig();
  player.applyAt((rig.frameCount + 5) / rig.framesPerSecond);
  assert.ok(worstDifference(parts, expectedWorldMatrices(rig, 6)) < TOLERANCE);
});

// Float32 key times make the clip one rounding step shorter than frame / fps for many lengths (30 frames at 30 fps is one),
// and a time equal to the length used to wrap to the first pose.
for (const frameCount of [16, 30, 31, 60]) {
  test(`the last of ${frameCount} baked frames at 30 fps is posed as itself`, async () => {
    const { rig, parts, player } = await loadRig({ frameCount, chainCount: 2 });
    const last = frameCount - 1;
    player.applyAt(last / rig.framesPerSecond);
    assert.ok(worstDifference(parts, expectedWorldMatrices(rig, last)) < TOLERANCE);
  });
}
