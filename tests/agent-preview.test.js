import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';
import { previewHarness } from './support/preview-harness.mjs';

test('HDR fallback rejects enabling or restoring volume fog before canonical publication', () => {
  const harness = previewHarness();
  const sessionId = 'fog-fallback';
  harness.preview.create({ recipe: recipe(), sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  harness.preview.apply({ sessionId, expectedRevision: 0, operations: [
    { type: 'set-environment', environment: { volumeFog: { density: 0.1 } } },
  ] });
  harness.preview.checkpoint({ sessionId, checkpointId: 'fog' });
  harness.preview.apply({ sessionId, expectedRevision: 1, operations: [
    { type: 'set-environment', environment: { volumeFog: { density: 0 } } },
  ] });
  harness.disableHdr();
  const before = harness.preview.exportRecipe({ sessionId });
  assert.throws(() => harness.preview.apply({ sessionId, expectedRevision: 2, operations: [
    { type: 'set-node', id: 'cube', translation: [1, 2, 3] },
    { type: 'set-environment', environment: { volumeFog: { density: 0.2 } } },
  ] }), /HDR support/);
  assert.throws(() => harness.preview.restore({ sessionId, checkpointId: 'fog', expectedRevision: 2 }), /HDR support/);
  assert.deepEqual(harness.preview.exportRecipe({ sessionId }), before);
});

test('private review samples reset independently and camera overrides do not publish edits', () => {
  const harness = previewHarness();
  const input = recipe();
  input.motion = { duration: 2, tracks: [{ kind: 'node', id: 'cube', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [4, 0, 0] }] }] };
  const { preview } = harness;
  const sessionId = 'review';
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  const before = preview.exportRecipe({ sessionId });
  preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const first = preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2,
    shot: { label: 'Moving', motionTime: 1, rendererTime: 2, camera: { eye: [4, 3, 5] } } });
  const second = preview.reviewShot({ sessionId, index: 1, width: 384, height: 384, columns: 2,
    shot: { label: 'Base', motionTime: null, rendererTime: 0 } });
  assert.equal(harness.tiles[0].parts[0].matrix[12], 2);
  assert.equal(harness.tiles[1].parts[0].matrix[12], 0);
  assert.deepEqual(Array.from(first.camera.eye), [4, 3, 5]);
  assert.deepEqual(second.camera, before.recipe.camera);
  assert.equal(second.motionTime, null);
  assert.deepEqual(preview.exportRecipe({ sessionId }), before);
  assert.equal(preview.reviewResult({ sessionId }).data, 'cG5n');
});

// Issue 2206: a review shot with fov failed on a scene camera that uses focalLength ("expected only one of fov or focalLength").
test('a review shot with fov or no camera works on a scene camera that uses focalLength', () => {
  const { preview } = previewHarness();
  const input = recipe();
  input.camera = { eye: [3, 2, 5], target: [0, 0, 0], focalLength: 30, sensorWidth: 36 };
  const sessionId = 'review-focal-length';
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  const before = preview.exportRecipe({ sessionId });
  preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const wide = preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2,
    shot: { label: 'Wide', motionTime: null, rendererTime: 0, camera: { fov: 80 } } });
  const same = preview.reviewShot({ sessionId, index: 1, width: 384, height: 384, columns: 2,
    shot: { label: 'Authored', motionTime: null, rendererTime: 0, camera: { eye: [4, 2, 5] } } });
  assert.equal(wide.camera.fov, 80);
  assert.equal(wide.camera.focalLength, undefined);
  assert.equal(same.camera.focalLength, 30);
  assert.deepEqual(preview.exportRecipe({ sessionId }), before);
});

test('source suspend and resume preserve transient motion pose and checkpoints', () => {
  const harness = previewHarness();
  const input = recipe();
  input.motion = { duration: 2, tracks: [{ kind: 'node', id: 'cube', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [4, 0, 0] }] }] };
  const { preview } = harness;
  const sessionId = 'source';
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  preview.checkpoint({ sessionId, checkpointId: 'saved' });
  preview.frame({ sessionId, motionTime: 1.5 });
  const before = preview.exportRecipe({ sessionId });
  preview.suspend({ sessionId });
  preview.resume({ sessionId });
  assert.equal(harness.scene().motionTime, 1.5);
  assert.equal(harness.renders.at(-1).parts[0].matrix[12], 3);
  assert.deepEqual(preview.exportRecipe({ sessionId }), before);
  assert.equal(preview.restore({ sessionId, checkpointId: 'saved', expectedRevision: 0 }).revision, 1);
});

test('asset review samples imported clips and motion atomically and resets to authored clip pose', async () => {
  const harness = previewHarness();
  const sessionId = 'asset-review';
  const input = { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    animation: { clip: 0, time: 0.25 }, motion: { duration: 2, tracks: [
      { kind: 'node', id: 'node-0', property: 'translation', keyframes: [
        { time: 0, value: [0, 0, 0] }, { time: 2, value: [2, 0, 0] } ] },
    ] } };
  await harness.preview.createAsset({ sessionId, recipe: input,
    data: Buffer.from(skinnedStripAsset()).toString('base64'), backend: 'cpu', memoryBudgetMiB: 64 });
  const before = harness.preview.exportRecipe({ sessionId });
  harness.preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const shot = (index, animation, motionTime) => harness.preview.reviewShot({ sessionId, index,
    width: 384, height: 384, columns: 2, shot: { label: 'Asset', rendererTime: 0, motionTime,
      ...(animation === undefined ? {} : { animation }) } });
  shot(0, { clip: 0, time: 1.5 }, 1);
  const posed = harness.renders.at(-1).parts;
  const reset = shot(1, undefined, null);
  assert.notDeepEqual(harness.renders.at(-1).parts, posed);
  harness.scene().sampleFrame({ animation: input.animation, motionTime: null });
  assert.deepEqual(harness.renders.at(-1).parts, harness.scene().parts.map(part => ({
    matrix: Array.from(part.matrix), joints: Array.from(part.skin?.jointMatrices ?? []) })));
  assert.deepEqual(JSON.parse(JSON.stringify(reset.animation)), input.animation);
  assert.deepEqual(harness.preview.exportRecipe({ sessionId }), before);
  const poseBeforeFailure = harness.renders.at(-1).parts;
  assert.throws(() => shot(1, { clip: 999, time: 0 }, 1), /clip/i);
  assert.deepEqual(harness.scene().parts.map(part => ({ matrix: Array.from(part.matrix),
    joints: Array.from(part.skin?.jointMatrices ?? []) })), poseBeforeFailure);
});

test('review private cameras reject Float32 overflow and preserve canonical revision after a partial grid', () => {
  const harness = previewHarness();
  const sessionId = 'invalid-review-camera';
  harness.preview.create({ recipe: recipe(), sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  const before = harness.preview.exportRecipe({ sessionId });
  harness.preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const shot = camera => harness.preview.reviewShot({ sessionId, index: 0,
    width: 384, height: 384, columns: 2, shot: { label: 'Camera', motionTime: null, rendererTime: 0, camera } });
  shot({ eye: [4, 3, 5] });
  assert.throws(() => shot({ fov: 1e-36 }), /aspect ratios/);
  assert.equal(harness.tiles.length, 1);
  assert.deepEqual(harness.preview.exportRecipe({ sessionId }), before);
});

function recipe() {
  return { format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.4, 0.5, 0.6] }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }] };
}

test('preview rejects a camera that overflows at a permitted aspect before committing edits', () => {
  const { preview } = previewHarness();
  const input = recipe();
  input.camera = { fov: 1e-36 };
  assert.throws(() => preview.create({ recipe: input, sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 }), /aspect ratios/);
  preview.create({ recipe: recipe(), sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 });
  assert.throws(() => preview.apply({ sessionId: 'scene', expectedRevision: 0, operations: [
    { type: 'set-node', id: 'cube', translation: [1, 2, 3] },
    { type: 'set-camera', fov: 1e-36 },
  ] }), /aspect ratios/);
  assert.equal(preview.exportRecipe({ sessionId: 'scene' }).revision, 0);
  assert.deepEqual(preview.exportRecipe({ sessionId: 'scene' }).recipe.nodes[0].translation, [0, 0, 0]);
});

test('topology driver failure discloses committed recipe and retries reconciliation with the current revision', () => {
  const harness = previewHarness();
  const sessionId = 'test-topology';
  harness.preview.create({ recipe: recipe(), sessionId, memoryBudgetMiB: 192, backend: 'cpu' });
  const checkpoint = harness.preview.checkpoint({ sessionId, checkpointId: 'initial' });
  harness.rejectReplacement(true);
  const added = harness.preview.apply({ sessionId, expectedRevision: 0, operations: [
    { type: 'add-node', node: { id: 'second', geometry: 'cube', material: 'paint', translation: [2, 0, 0] } },
  ] });
  assert.equal(added.committed, true);
  assert.equal(added.revision, 1);
  assert.equal(added.renderSucceeded, false);
  assert.match(added.renderError, /allocation failure/);
  assert.equal(harness.preview.inspect({ sessionId }).counts.parts, 2);
  assert.equal(harness.replacementCount(), 0);
  harness.rejectReplacement(false);
  const recovered = harness.preview.apply({ sessionId, expectedRevision: 1, operations: [
    { type: 'set-material', id: 'paint', color: [0.3, 0.6, 0.8] },
  ] });
  assert.equal(recovered.renderSucceeded, true);
  assert.equal(harness.replacementCount(), 1);
  const restored = harness.preview.restore({ sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 2 });
  assert.equal(restored.renderSucceeded, true);
  assert.equal(harness.preview.inspect({ sessionId }).counts.parts, 1);
  assert.equal(harness.replacementCount(), 2);
});

test('driver errors disclose committed revision and context loss preserves recipe recovery', () => {
  const harness = previewHarness();
  const { preview } = harness;
  preview.create({ recipe: recipe(), sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 });
  preview.checkpoint({ sessionId: 'scene', checkpointId: 'checkpoint' });
  harness.injectError(1285);
  const result = preview.apply({ sessionId: 'scene', expectedRevision: 0, operations: [
    { type: 'set-node', id: 'cube', translation: [1, 2, 3] },
  ] });
  assert.equal(result.committed, true);
  assert.equal(result.renderSucceeded, false);
  assert.equal(result.revision, 1);
  assert.match(result.renderError, /1285/);
  assert.deepEqual(preview.exportRecipe({ sessionId: 'scene' }).recipe.nodes[0].translation, [1, 2, 3]);
  const restored = preview.restore({ sessionId: 'scene', checkpointId: 'checkpoint', expectedRevision: 1 });
  assert.equal(restored.committed, true);
  assert.equal(restored.renderSucceeded, false);
  assert.equal(restored.revision, 2);
  harness.loseContext();
  assert.equal(preview.exportRecipe({ sessionId: 'scene' }).revision, 2);
  assert.equal(preview.inspect({ sessionId: 'scene' }).revision, 2);
  assert.equal(preview.dispose({ sessionId: 'scene' }).disposed, true);
});

test('scene_look with labels names the parts of an imported asset instead of throwing', async () => {
  const harness = previewHarness();
  const sessionId = 'asset-labels';
  const input = { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) };
  await harness.preview.createAsset({ sessionId, recipe: input,
    data: Buffer.from(skinnedStripAsset()).toString('base64'), backend: 'cpu', memoryBudgetMiB: 64 });
  const { metadata } = harness.preview.look({ sessionId, labels: true });
  assert.ok(Array.isArray(metadata.labels));
  assert.ok(metadata.labels.length > 0);
  for (const label of metadata.labels) {
    assert.match(label.id, /^mesh-\d+$/);
    assert.equal(label.tag, null);
  }
});

test('annotateFrame returns the camera and pickMarks turns pixels into part hits', async () => {
  const { preview } = previewHarness();
  const input = recipe();
  input.camera = { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 50 };
  preview.create({ recipe: input, sessionId: 'marks', backend: 'cpu', memoryBudgetMiB: 64 });
  const frame = preview.annotateFrame({ sessionId: 'marks' });
  assert.equal(frame.width, 768);
  assert.equal(frame.height, 512);
  assert.deepEqual(frame.camera.eye, [0, 0, 5]);
  const picked = await preview.pickMarks({ sessionId: 'marks', camera: frame.camera, width: frame.width, height: frame.height,
    marks: [{ x: 384, y: 256, note: 'scuffed' }, { x: 2, y: 2, note: 'empty' }] });
  assert.equal(picked.revision, 0);
  const [onCube, onSky] = picked.marks;
  assert.equal(onCube.partId, 'cube');
  assert.equal(onCube.note, 'scuffed');
  assert.ok(Math.abs(onCube.point[2] - 0.5) < 0.05, `front face near z 0.5, got ${onCube.point}`);
  assert.deepEqual(onCube.normal.map(Math.round), [0, 0, 1]);
  assert.equal(onCube.material, 'paint');
  assert.equal(onSky.partId, null);
  await assert.rejects(preview.pickMarks({ sessionId: 'marks', camera: frame.camera, width: 768, height: 512, marks: [{ x: 900, y: 1 }] }), /mark 1 x/);
});

test('a frame at a motion time gives the renderer that time as the post pass clock, and a frame without one does not', () => {
  const { preview, renders } = previewHarness();
  const sessionId = 'pass-clock';
  const input = recipe();
  input.motion = { duration: 8, tracks: [{ kind: 'node', id: 'cube', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 8, value: [4, 0, 0] }] }] };
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  for (const motionTime of [2, 6.5, 0]) preview.frame({ sessionId, motionTime });
  preview.frame({ sessionId });
  assert.deepEqual(renders.slice(1).map(frame => frame.camera.passTime), [2, 6.5, 0, undefined]);
});

function rolledTrackRecipe() {
  return { ...recipe(), camera: { eye: [10, 5, 10], target: [0, 2, 0], fov: 40 },
    motion: { duration: 4, tracks: [
      { kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [10, 5, 10] }, { time: 4, value: [-10, 5, 10] }] },
      { kind: 'camera', property: 'roll', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 0.28 }] },
    ] } };
}

test('a review shot draws the same track camera, roll included, as a look and a render job at that time', () => {
  const harness = previewHarness();
  const sessionId = 'review-roll';
  harness.preview.create({ recipe: rolledTrackRecipe(), sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  harness.preview.frame({ sessionId, motionTime: 2 });
  const rendered = harness.renders.at(-1).camera;
  harness.preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const reviewed = harness.preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2,
    shot: { label: 'Roll', motionTime: 2, rendererTime: 0 } });
  const drawn = harness.renders.at(-1).camera;
  assert.deepEqual(drawn.eye, rendered.eye);
  assert.deepEqual(drawn.up, rendered.up);
  assert.deepEqual(reviewed.camera.up, rendered.up);
  assert.ok(Math.abs(drawn.up[0] - 0.1337) < 1e-3, `a roll of 0.14 radians tilts up by sin 0.14, got ${drawn.up}`);
});

test('a review shot passes projection and orthoScale through to the drawn camera', () => {
  const harness = previewHarness();
  const sessionId = 'review-ortho';
  harness.preview.create({ recipe: recipe(), sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  harness.preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const reviewed = harness.preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2,
    shot: { label: 'Ortho', motionTime: null, rendererTime: 0, camera: { projection: 'orthographic', orthoScale: 8 } } });
  assert.equal(reviewed.camera.projection, 'orthographic');
  assert.equal(reviewed.camera.orthoScale, 8);
  assert.equal(harness.renders.at(-1).camera.projection, 'orthographic');
  assert.equal(harness.renders.at(-1).camera.orthoScale, 8);
});

test('a review shot at a motion time gives the post pass the same clock as a frame at that time', () => {
  const { preview, renders } = previewHarness();
  const sessionId = 'review-pass-clock';
  const input = recipe();
  input.motion = { duration: 8, tracks: [{ kind: 'node', id: 'cube', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 8, value: [4, 0, 0] }] }] };
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  preview.reviewBegin({ sessionId, width: 768, height: 408 });
  const reviewClocks = [];
  const frameClocks = [];
  for (const [index, motionTime] of [5.65, 2].entries()) {
    preview.reviewShot({ sessionId, index, width: 384, height: 384, columns: 2, shot: { label: `t${motionTime}`, motionTime } });
    reviewClocks.push({ passTime: renders.at(-1).camera.passTime, anchorX: renders.at(-1).parts[0].matrix[12] });
    preview.frame({ sessionId, motionTime });
    frameClocks.push({ passTime: renders.at(-1).camera.passTime, anchorX: renders.at(-1).parts[0].matrix[12] });
  }
  assert.deepEqual(reviewClocks, frameClocks);
  assert.equal(reviewClocks[0].passTime, 5.65);
  preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2, shot: { label: 'base', motionTime: null } });
  assert.equal(renders.at(-1).camera.passTime, undefined);
});

test('a look at a motion time gives the post pass the same clock as a frame at that time', () => {
  const { preview, renders } = previewHarness();
  const sessionId = 'look-pass-clock';
  const input = recipe();
  input.motion = { duration: 8, tracks: [{ kind: 'node', id: 'cube', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 8, value: [4, 0, 0] }] }] };
  preview.create({ recipe: input, sessionId, backend: 'cpu', memoryBudgetMiB: 192 });
  const lookClocks = [];
  const frameClocks = [];
  for (const motionTime of [5.65, 2]) {
    preview.look({ sessionId, motionTime });
    lookClocks.push({ passTime: renders.at(-1).camera.passTime, anchorX: renders.at(-1).parts[0].matrix[12] });
    preview.frame({ sessionId, motionTime });
    frameClocks.push({ passTime: renders.at(-1).camera.passTime, anchorX: renders.at(-1).parts[0].matrix[12] });
  }
  assert.deepEqual(lookClocks, frameClocks);
  assert.equal(lookClocks[0].passTime, 5.65);
  preview.look({ sessionId, motionTime: null });
  assert.equal(renders.at(-1).camera.passTime, undefined);
});

test('scene_inspect without profile keeps its answer, and profile adds a cost profile and nothing else', () => {
  const { preview } = previewHarness();
  const sessionId = 'profile';
  preview.create({ recipe: recipe(), sessionId, backend: 'gpu', memoryBudgetMiB: 192 });
  // The page runs in a VM realm, so compare as JSON.
  const asJson = value => JSON.parse(JSON.stringify(value));
  const plain = asJson(preview.inspect({ sessionId }));
  assert.equal('profile' in plain, false);
  assert.deepEqual(asJson(preview.inspect({ sessionId, profile: false })), plain);
  const { profile, ...rest } = asJson(preview.inspect({ sessionId, profile: true }));
  assert.deepEqual(rest, plain);
  assert.deepEqual(Object.keys(profile).sort(), ['drawCalls', 'frames', 'heaviestNodes', 'height', 'millisecondsMaximum', 'millisecondsMinimum', 'millisecondsPerFrame', 'splatBytes', 'textureBytes', 'triangles', 'width']);
  assert.equal(profile.frames, 30);
  assert.equal(profile.drawCalls, 1);
  assert.equal(profile.triangles, 2);
  assert.equal(profile.textureBytes, 4096);
  assert.equal(profile.splatBytes, 1024);
  assert.deepEqual(profile.heaviestNodes, [{ id: 'cube', triangles: 12, parts: 1 }]);
  assert.ok(profile.millisecondsPerFrame >= 0);
});

test('scene_inspect profileFrames sets the number of measured frames within bounds', () => {
  const harness = previewHarness();
  const sessionId = 'profile-frames';
  harness.preview.create({ recipe: recipe(), sessionId, backend: 'gpu', memoryBudgetMiB: 192 });
  const rendersBefore = harness.renders.length;
  assert.equal(harness.preview.inspect({ sessionId, profile: true, profileFrames: 5 }).profile.frames, 5);
  assert.equal(harness.renders.length - rendersBefore, 6, 'one unmeasured frame and five measured ones');
  assert.equal(harness.preview.inspect({ sessionId, profile: true, profileFrames: 120 }).profile.frames, 120);
  assert.throws(() => harness.preview.inspect({ sessionId, profile: true, profileFrames: 121 }), /from 1 to 120/);
  assert.throws(() => harness.preview.inspect({ sessionId, profile: true, profileFrames: 0 }), /from 1 to 120/);
  assert.throws(() => harness.preview.inspect({ sessionId, profileFrames: 5 }), /only applies with profile: true/);
});

test('an asset scene answers an edit with the findings inspect reports', async () => {
  const harness = previewHarness();
  await harness.preview.createAsset({ sessionId: 'asset', recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) },
    data: Buffer.from(skinnedStripAsset()).toString('base64'), backend: 'cpu', memoryBudgetMiB: 64 });
  const scene = harness.scene();
  const { diagnostics } = scene.inspect();
  assert.deepEqual(scene.editDiagnostics(), diagnostics?.length ? { diagnostics } : {});
});
