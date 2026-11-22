import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { retargetAssetClip } from '../src/agent-retarget.js';
import { BVH_LIMITS, parseBvh } from '../src/bvh.js';
import { bvhToGlb } from '../src/bvh-gltf.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';
import { MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints } from './fixtures/humanoid-glb.js';

/** parseGltf takes an ArrayBuffer, and a Buffer is a view into a larger pool. */
function parseGlb(bytes) {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const SAMPLE_PATH =new URL('./fixtures/walk-sample.bvh', import.meta.url);
const sampleText = await readFile(SAMPLE_PATH, 'utf8');

/** One root with one child and an End Site; `channels` is the child's channel list and `row` the numbers of one frame (root: 6). */
function smallBvh({ rootChannels = 'Xposition Yposition Zposition', childChannels = 'Zrotation Xrotation Yrotation', rows = ['0 0 0 0 0 0'], frameTime = '0.04', frames = rows.length } = {}) {
  const rootCount = rootChannels.split(' ').length;
  const childCount = childChannels.split(' ').length;
  return `HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS ${rootCount} ${rootChannels}
  JOINT Child
  {
    OFFSET 0 1 0
    CHANNELS ${childCount} ${childChannels}
    End Site
    {
      OFFSET 0 0.5 0
    }
  }
}
MOTION
Frames: ${frames}
Frame Time: ${frameTime}
${rows.join('\n')}
`;
}

function rotateVector(quaternion, vector) {
  const [x, y, z, w] = quaternion;
  const [vectorX, vectorY, vectorZ] = vector;
  const crossX = y * vectorZ - z * vectorY + w * vectorX;
  const crossY = z * vectorX - x * vectorZ + w * vectorY;
  const crossZ = x * vectorY - y * vectorX + w * vectorZ;
  return [
    vectorX + 2 * (y * crossZ - z * crossY),
    vectorY + 2 * (z * crossX - x * crossZ),
    vectorZ + 2 * (x * crossY - y * crossX),
  ];
}

function assertVectorClose(actual, expected) {
  actual.forEach((component, axis) => assert.ok(Math.abs(component - expected[axis]) < 1e-6, `${actual} is not ${expected}`));
}

async function childRotationAt(channels, rowAfterRoot) {
  const text = smallBvh({ childChannels: channels, rows: [`0 0 0 ${rowAfterRoot}`] });
  const asset = await parseGlb(bvhToGlb(text).glb);
  const clip = clipFromGltfAnimation(asset.animations[0]);
  return clip.tracks.find(track => track.target === 'Child' && track.property === 'rotation').keyframes[0].value;
}

test('the parser reads joints, End Sites, channels and frames in file order', () => {
  const parsed = parseBvh(sampleText);
  assert.equal(parsed.joints.length, 15 + 5);
  assert.deepEqual(parsed.joints.slice(0, 3).map(joint => [joint.name, joint.parent]), [['Hips', -1], ['Spine', 0], ['Head', 1]]);
  assert.deepEqual(parsed.joints[3], { name: 'Head_End', parent: 2, offset: [0, 20, 0], channels: [], endSite: true });
  assert.deepEqual(parsed.joints[0].channels, ['Xposition', 'Yposition', 'Zposition', 'Zrotation', 'Xrotation', 'Yrotation']);
  assert.equal(parsed.channelCount, 48);
  assert.equal(parsed.frameCount, 4);
  assert.equal(parsed.values.length, 4 * 48);
  assert.equal(parsed.values[48 + 1], 99);
  assert.equal(parsed.values[48 + 31], 30);
});

test('Frame Time gives the frame rate and the clip times', async () => {
  const parsed = parseBvh(sampleText);
  assert.ok(Math.abs(parsed.frameRate - 30) < 1e-3);
  const asset = await parseGlb(bvhToGlb(sampleText).glb);
  const clip = clipFromGltfAnimation(asset.animations[0]);
  assert.ok(Math.abs(clip.duration - 3 * 0.0333333) < 1e-6);
  const hips = clip.tracks.find(track => track.target === 'Hips' && track.property === 'translation');
  assert.deepEqual(hips.keyframes.map(key => Number(key.time.toFixed(4))), [0, 0.0333, 0.0667, 0.1]);
});

test('rotation channels compose in the listed order, first listed outermost', async () => {
  // Rz(90) * Rx(90) takes +X to +Y (Rx leaves X alone, Rz turns it) but Rx(90) * Rz(90) takes +X to +Z.
  assertVectorClose(rotateVector(await childRotationAt('Zrotation Xrotation Yrotation', '90 90 0'), [1, 0, 0]), [0, 1, 0]);
  assertVectorClose(rotateVector(await childRotationAt('Xrotation Zrotation Yrotation', '90 90 0'), [1, 0, 0]), [0, 0, 1]);
  assertVectorClose(rotateVector(await childRotationAt('Yrotation Xrotation Zrotation', '90 0 0'), [0, 0, 1]), [1, 0, 0]);
});

test('a joint with fewer than three rotation channels rotates about those axes only', async () => {
  assertVectorClose(rotateVector(await childRotationAt('Zrotation', '90'), [1, 0, 0]), [0, 1, 0]);
});

test('the rest pose is the OFFSETs with no rotation, in metres, and a moving root rests at its first frame position', async () => {
  const asset = await parseGlb(bvhToGlb(sampleText).glb);
  const byName = new Map(asset.nodes.map(node => [node.name, node]));
  assert.deepEqual(Array.from(byName.get('Hips').translation).map(value => Number(value.toFixed(6))), [0, 0.98, 0]);
  assert.deepEqual(Array.from(byName.get('LeftLeg').translation).map(value => Number(value.toFixed(6))), [0, -0.5, 0]);
  assert.deepEqual(Array.from(byName.get('LeftLeg').rotation), [0, 0, 0, 1]);
  assert.equal(byName.get('LeftFoot_End').joint, true);
  assert.equal(byName.get('LeftFoot_End').parent, byName.get('LeftFoot').id);
  assert.equal(asset.parts.length, 0);
});

test('scale: a tall skeleton reads as centimetres, a given scale wins, a short one stays metres', () => {
  const centimetres = parseBvh(sampleText);
  assert.equal(centimetres.unit, 'centimetres');
  assert.equal(centimetres.scale, 0.01);
  assert.equal(centimetres.restHeight, 190);
  const metres = parseBvh(smallBvh());
  assert.deepEqual([metres.unit, metres.scale], ['metres', 1]);
  const cmu = parseBvh(smallBvh().replace('OFFSET 0 1 0', 'OFFSET 0 25 0'));
  assert.equal(cmu.unit, 'cmu');
  assert.ok(Math.abs(cmu.scale - 0.056444) < 1e-6, 'one CMU unit is 1 / 0.45 inch');
  const given = parseBvh(sampleText, { scale: 0.0254 });
  assert.deepEqual([given.unit, given.scale], ['given', 0.0254]);
  assert.equal(parseBvh(sampleText, { scale: 'auto' }).scale, 0.01);
});

test('scale multiplies the root translation of every frame as well as the offsets', async () => {
  const text = smallBvh({ rows: ['0 3 4 0 0 0', '0 5 6 0 0 0'] });
  const asset = await parseGlb(bvhToGlb(text, { scale: 0.5 }).glb);
  const clip = clipFromGltfAnimation(asset.animations[0]);
  const root = clip.tracks.find(track => track.target === 'Root' && track.property === 'translation');
  assert.deepEqual(root.keyframes.map(key => key.value.map(value => Number(value.toFixed(6)))), [[0, 1.5, 2], [0, 2.5, 3]]);
  assert.deepEqual(Array.from(asset.nodes.find(node => node.name === 'Child').translation).map(value => Number(value.toFixed(6))), [0, 0.5, 0]);
});

test('a position channel gives its axis outright and an axis without one keeps the OFFSET', async () => {
  const text = smallBvh({ rootChannels: 'Yposition Xposition', rows: ['5 7 0 0 0'] }).replace('ROOT Root\n{\n  OFFSET 0 0 0', 'ROOT Root\n{\n  OFFSET 1 2 3');
  const asset = await parseGlb(bvhToGlb(text).glb);
  const root = clipFromGltfAnimation(asset.animations[0]).tracks.find(track => track.target === 'Root' && track.property === 'translation');
  assert.deepEqual(root.keyframes[0].value.map(value => Number(value.toFixed(6))), [7, 5, 3]);
});

test('bounds and bad scales are refused with the limit named', () => {
  assert.throws(() => parseBvh(sampleText, { scale: 0 }), /scale must be "auto" or a number from 0.0001 to 1000 \(metres per file unit; 0.01 for centimetres\), got 0/);
  assert.throws(() => parseBvh(smallBvh({ frames: BVH_LIMITS.maxFrames + 1, rows: ['0 0 0 0 0 0'] })), RangeError);
  assert.throws(() => parseBvh(smallBvh({ frameTime: '5' })), /Frame Time is 5; expected seconds from 0.0001 to 1/);
  assert.throws(() => parseBvh(smallBvh({ frameTime: '0' })), /Frame Time is 0/);
  const manyJoints = `HIERARCHY\nROOT A\n{\nOFFSET 0 0 0\nCHANNELS 3 Xposition Yposition Zposition\n${'JOINT B\n{\nOFFSET 0 1 0\nCHANNELS 0\n'}}\n}\nMOTION\nFrames: 1\nFrame Time: 0.1\n0 0 0\n`;
  assert.equal(parseBvh(manyJoints).joints.length, 2);
  const chain = Array.from({ length: BVH_LIMITS.maxJoints }, (_, index) => `JOINT J${index}\n{\nOFFSET 0 1 0\nCHANNELS 0\n`).join('');
  const deep = `HIERARCHY\nROOT A\n{\nOFFSET 0 0 0\nCHANNELS 3 Xposition Yposition Zposition\n${chain}${'}\n'.repeat(BVH_LIMITS.maxJoints)}}\nMOTION\nFrames: 1\nFrame Time: 0.1\n0 0 0\n`;
  assert.throws(() => parseBvh(deep), /more than 256 joints/);
  assert.throws(() => parseBvh('x'.repeat(BVH_LIMITS.maxBytes + 1)), /over the limit of 33554432/);
  assert.throws(() => parseBvh(''), /needs the text of a BVH file/);
});

test('syntax errors name the line and what was expected', () => {
  assert.throws(() => parseBvh(smallBvh().replace('OFFSET 0 1 0', 'OFFSET 0 one 0')), /line 8: expected a y offset number, found "one"/);
  assert.throws(() => parseBvh(smallBvh().replace('JOINT Child\n  {', 'JOINT Child\n  [')), /line 7: expected "\{", found "\["/);
  assert.throws(() => parseBvh(smallBvh({ childChannels: 'Zrotation Wrotation' })), /line 9: channel "Wrotation" of Child is unknown; expected one of Xposition/);
  assert.throws(() => parseBvh(smallBvh({ childChannels: 'Zrotation Zrotation' })), /lists channel Zrotation twice/);
  assert.throws(() => parseBvh(smallBvh().replace('CHANNELS 3 Zrotation Xrotation Yrotation', 'CHANNELS 2 Zrotation Xrotation Yrotation')), /declares 2 channels but lists more/);
  assert.throws(() => parseBvh(smallBvh().replace('End Site', 'Leaf')), /line 10: expected "JOINT", "End Site" or "\}", found "Leaf"/);
  assert.throws(() => parseBvh(smallBvh().replace('Frame Time:', 'Frame Rate:')), /line 18: expected "Time:", found "Rate:"/);
  assert.throws(() => parseBvh(smallBvh({ rows: ['0 0 0 0 0 0'], frames: 2 })), /expected 2 frames of 6 numbers \(12 in total\), but the file ends after 1 complete frames/);
  assert.throws(() => parseBvh(smallBvh({ rows: ['0 0 0 0 0 0', '1 1 1 1 1 1'], frames: 1 })), /expected the end of the file after 1 frames of 6 numbers/);
  assert.throws(() => parseBvh(smallBvh({ rows: ['0 0 0 0 0 x'] })), /line 19: expected a number for frame 0, channel 5, found "x"/);
  assert.throws(() => parseBvh('MOTION'), /line 1: expected "HIERARCHY", found "MOTION"/);
  assert.throws(() => parseBvh('HIERARCHY\nROOT A\n{\nOFFSET 0 0 0'), /expected "CHANNELS", found the end of the file/);
  assert.throws(() => parseBvh(smallBvh().replace('JOINT Child', 'JOINT Root')), /joint name "Root" is used twice/);
});

test('the converted file retargets onto a humanoid with the existing retarget code', async () => {
  const source = await parseGlb(bvhToGlb(sampleText, { name: 'walk' }).glb);
  assert.equal(source.animations[0].name, 'walk');
  const targetJoints = humanoidJoints({ hipsHeight: 1.1, thigh: 0.62, shin: 0.48 });
  const target = await parseGltf(humanoidGlb({ names: UNREAL_LIKE, joints: targetJoints }));
  const retargeted = retargetAssetClip(source.nodes, target.nodes, clipFromGltfAnimation(source.animations[0]));
  const thigh = retargeted.tracks.find(track => track.target === UNREAL_LIKE.leftUpperLeg && track.property === 'rotation');
  assert.ok(thigh, 'the left thigh of the target is driven');
  const first = thigh.keyframes[0].value;
  const swung = thigh.keyframes.find(key => Math.abs(key.value[0]) > 0.2).value;
  assertVectorClose(first.map(Math.abs), [0, 0, 0, 1]);
  assert.ok(Math.abs(2 * Math.asin(Math.abs(swung[0])) * 180 / Math.PI - 30) < 1, 'a 30 degree swing about X stays 30 degrees');
  const pelvis = retargeted.tracks.find(track => track.target === UNREAL_LIKE.hips && track.property === 'translation');
  const rise = pelvis.keyframes.at(-1).value[1] - pelvis.keyframes[0].value[1];
  assert.ok(rise > 0, 'the hips keep their motion');
  assert.ok(pelvis.keyframes[0].value[1] > 0.9 && pelvis.keyframes[0].value[1] < 1.3, `hips height is rescaled to the target, in metres: ${pelvis.keyframes[0].value}`);
});

test('a BVH skeleton is a motion layer source for an asset recipe', async () => {
  const sourceId = 'ef'.repeat(32);
  const targetId = '12'.repeat(32);
  const source = await parseGlb(bvhToGlb(sampleText).glb);
  const target = await parseGltf(humanoidGlb({ names: MIXAMO_LIKE, joints: humanoidJoints() }));
  const recipe = {
    format: 'crucible.asset', schemaVersion: 1, assetId: targetId,
    motion: { duration: 0.1, loop: true, layers: [{ from: { asset: sourceId, clip: 0 } }] },
  };
  const scene = createAgentAssetScene(target, recipe, { sources: { [sourceId]: source } });
  scene.sampleMotion(0.05);
  const report = scene.inspect({ kind: 'hierarchy' }).retargets[0];
  assert.equal(report.source.mapped, 15);
  assert.deepEqual(report.source.missing, []);
  assert.equal(report.target.mapped, 15);
});

test('the catalog lists a .bvh as a skeleton-only GLB with one clip and serves its bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-bvh-'));
  try {
    await writeFile(join(directory, 'walk.bvh'), sampleText);
    const catalog = await createAgentAssetCatalog(directory);
    const [entry] = catalog.list().assets;
    assert.deepEqual([entry.name, entry.kind, entry.meshes, entry.skins, entry.animationCount], ['walk.bvh', 'glb', 0, 1, 1]);
    assert.deepEqual(entry.animations, [{ index: 0, name: 'walk' }]);
    assert.equal(catalog.resolveName('walk.bvh'), entry.assetId);
    const bytes = await catalog.read(entry.assetId);
    assert.equal(bytes.readUInt32LE(0), 0x46546c67);
    const asset = await parseGlb(bytes);
    assert.equal(asset.animations.length, 1);
    assert.equal(asset.nodes.filter(node => node.joint).length, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the catalog stops on a malformed .bvh with its name and line, and skips one over a limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-bvh-'));
  try {
    await writeFile(join(directory, 'broken.bvh'), smallBvh().replace('OFFSET 0 1 0', 'OFFSET 0 one 0'));
    await assert.rejects(createAgentAssetCatalog(directory), /broken\.bvh: BVH line 8: expected a y offset number, found "one"/);
    await rm(join(directory, 'broken.bvh'));
    await writeFile(join(directory, 'slow.bvh'), smallBvh({ frameTime: '9' }));
    await writeFile(join(directory, 'walk.bvh'), sampleText);
    const listing = (await createAgentAssetCatalog(directory)).list();
    assert.deepEqual(listing.assets.map(asset => asset.name), ['walk.bvh']);
    assert.match(listing.skipped[0].reason, /slow\.bvh: BVH line \d+: Frame Time is 9/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A child bone splayed 45 degrees in the OFFSETs; frame 0 is the straight reference pose (root Z rotation 45 turns it upright), frame 1 a 30 degree pose. */
const SPLAYED_ZERO_POSE_BVH = `HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Child
  {
    OFFSET 1 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 0 0.5
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.04
0 0 0 45 0 0 0 0 0
0 0 0 30 0 0 0 0 0
`;

function zAngleDegrees(quaternion) {
  return 2 * Math.atan2(quaternion[2], quaternion[3]) * 180 / Math.PI;
}

test('a straight first frame becomes the rest pose and is not played, so a splayed zero pose is not copied by a retarget', async () => {
  const converted = bvhToGlb(SPLAYED_ZERO_POSE_BVH);
  assert.equal(converted.restPose, 'firstFrame');
  assert.equal(converted.frameCount, 1);
  const asset = await parseGlb(converted.glb);
  const root = asset.nodes.find(node => node.name === 'Root');
  assert.ok(Math.abs(zAngleDegrees(Array.from(root.rotation)) - 45) < 1e-4, `the rest rotation is the first frame: ${Array.from(root.rotation)}`);
  const clip = clipFromGltfAnimation(asset.animations[0]);
  const track = clip.tracks.find(candidate => candidate.target === 'Root' && candidate.property === 'rotation');
  assert.equal(track.keyframes[0].time, 0);
  assert.ok(Math.abs(zAngleDegrees(track.keyframes[0].value) - 30) < 1e-4);
});

test('restPose offsets keeps the zero pose and every frame; firstFrame forces the first frame; a bad value is refused', async () => {
  const offsets = bvhToGlb(SPLAYED_ZERO_POSE_BVH, { restPose: 'offsets' });
  assert.equal(offsets.frameCount, 2);
  const root = (await parseGlb(offsets.glb)).nodes.find(node => node.name === 'Root');
  assert.deepEqual(Array.from(root.rotation), [0, 0, 0, 1]);
  assert.equal(bvhToGlb(sampleText).restPose, 'offsets');
  assert.equal(bvhToGlb(sampleText, { restPose: 'firstFrame' }).frameCount, 3);
  assert.throws(() => bvhToGlb(sampleText, { restPose: 'middle' }), /restPose must be one of auto, offsets, firstFrame/);
});

test('a root with OFFSET 0 and an absolute height in the frames does not lift the retargeted hips by that height', async () => {
  const lines = sampleText.split('\n');
  const rootOffsetLine = lines.findIndex(line => line.trim() === 'OFFSET 0 100 0');
  assert.ok(rootOffsetLine > 0, 'the fixture root has OFFSET 0 100 0');
  lines[rootOffsetLine] = lines[rootOffsetLine].replace('OFFSET 0 100 0', 'OFFSET 0 0 0');
  const source = await parseGlb(bvhToGlb(lines.join('\n')).glb);
  const target = await parseGltf(humanoidGlb({ names: UNREAL_LIKE, joints: humanoidJoints({ hipsHeight: 1.1, thigh: 0.62, shin: 0.48 }) }));
  const retargeted = retargetAssetClip(source.nodes, target.nodes, clipFromGltfAnimation(source.animations[0]));
  const pelvis = retargeted.tracks.find(track => track.target === UNREAL_LIKE.hips && track.property === 'translation');
  assert.ok(Math.abs(pelvis.keyframes[0].value[1] - 1.1) < 0.1, `hips start at the target's rest height: ${pelvis.keyframes[0].value}`);
});
