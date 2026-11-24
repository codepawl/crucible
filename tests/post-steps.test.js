import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mat4, vec3 } from 'gl-matrix';
import { resolveEffects } from '../src/effects.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installPostSteps, resolvePostSteps, glareFragment, lensDistortionFragment, colorBalanceFragment, stylizeFragment, compositeFragment, usesObjectMask, sunScreenPosition } from '../src/post-steps.js';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeUserPasses, buildPassFragment, installUserPasses, describeUserPasses } from '../src/user-pass.js';

function recordingContext(calls) {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => 1;
      return (...args) => {
        calls.push([name, ...args]);
        return true;
      };
    },
  });
}

function fakeRenderer(context) {
  return {
    postStages: [], context, canvas: { width: 16, height: 9 }, hdr: false, depthTexture: 'depth',
    inverseViewProjection: mat4.create(), viewProjection: mat4.create(), viewForward: [0, 0, -1],
    activeLightDirection: [0, 0, 1], lighting: { keyColor: [3, 2, 1] },
  };
}

const STAGE_NAMES = ['Distortion', 'Flash', 'Glare', 'Local tone mapping', 'Lens distortion', 'Color balance', 'Color correction', 'Sun rays', 'Stylize', 'Composite'];

test('a look that names no step resolves exactly as before', async () => {
  await loadAgentSceneModules({});
  const effects = normalizeAgentLook({}).effects;
  for (const field of ['colorBalance', 'glare', 'lensDistortion', 'stylize']) assert.equal(Object.hasOwn(effects, field), false);
  assert.deepEqual(resolveEffects({}), resolveEffects({ saturation: 1 }));
});

test('each named step resolves with defaults and refuses bad input', () => {
  assert.deepEqual(resolvePostSteps({ colorBalance: {} }).colorBalance, { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });
  assert.deepEqual(resolvePostSteps({ glare: { streaks: 0.5 } }).glare, { streaks: 0.5, count: 4, angle: 0, fogGlow: 0, threshold: 1, size: 0.15 });
  assert.deepEqual(resolvePostSteps({ glare: { streaks: 1, count: 2, angle: 30 } }).glare, { streaks: 1, count: 2, angle: 30, fogGlow: 0, threshold: 1, size: 0.15 });
  assert.throws(() => resolvePostSteps({ glare: { count: 2.5 } }), /whole number/);
  assert.throws(() => resolvePostSteps({ glare: { count: 9 } }), /glare.count must be between/);
  assert.throws(() => resolvePostSteps({ glare: { angle: 400 } }), /glare.angle must be between/);
  assert.deepEqual(resolvePostSteps({ lensDistortion: { dispersion: 1 } }).lensDistortion, { distortion: 0, dispersion: 1 });
  assert.deepEqual(resolvePostSteps({ saturation: 1 }), {});
  assert.throws(() => resolvePostSteps({ colorBalance: { lift: [0, 0] } }), /three numbers/);
  assert.throws(() => resolvePostSteps({ colorBalance: { gamma: [0, 1, 1] } }), /colorBalance.gamma\[0\] must be between/);
  assert.throws(() => resolvePostSteps({ colorBalance: { shadows: 1 } }), /Unknown colorBalance field/);
  assert.throws(() => resolvePostSteps({ glare: { streaks: 2 } }), /glare.streaks must be between/);
  assert.throws(() => resolvePostSteps({ glare: [] }), /glare must be an object/);
  assert.throws(() => resolvePostSteps({ lensDistortion: { distortion: -2 } }), /lensDistortion.distortion must be between/);
});

test('a recipe that names a step loads the module, validates it and keeps the group in the look', async () => {
  const look = { effects: { glare: { fogGlow: 0.4 }, lensDistortion: { distortion: 0.2 } } };
  assert.ok(agentSceneModulesNeeded(look).includes('postSteps'));
  assert.equal(agentSceneModulesNeeded({ effects: { bloom: { strength: 0.3 } } }).includes('postSteps'), false);
  await loadAgentSceneModules(look);
  const effects = normalizeAgentLook(look).effects;
  assert.equal(effects.glare.fogGlow, 0.4);
  assert.equal(effects.lensDistortion.distortion, 0.2);
  assert.equal(Object.hasOwn(effects, 'colorBalance'), false);
  assert.throws(() => normalizeAgentLook({ effects: { glare: { streaks: 3 } } }), /glare.streaks/);
  assert.throws(() => normalizeAgentLook({ effects: { sparkle: 1 } }), /sparkle/);
  // The resolved group resolves to itself, so a frame can carry the look's effects as they are.
  assert.deepEqual(resolvePostSteps(effects).glare, effects.glare);
});

test('an edit adds a step to a scene that has none', async () => {
  await loadAgentSceneModules({ effects: { colorBalance: {} } });
  const scene = createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
  scene.apply([{ type: 'set-effects', effects: { colorBalance: { gain: [1.2, 1, 0.8] } } }], { expectedRevision: scene.revision });
  assert.deepEqual(scene.effects.colorBalance.gain, [1.2, 1, 0.8]);
});

test('each stage draws only for a frame that sets its step, and frees its target', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = installPostSteps(installCameraEffects(fakeRenderer(context)));
  assert.deepEqual(renderer.postStages.slice(2).map(stage => stage.name), STAGE_NAMES);
  assert.equal(installPostSteps(renderer).postStages.length, 12);
  const unset = { eye: [0, 1, 5], effects: {} };
  const neutral = { eye: [0, 1, 5], effects: { colorBalance: {}, colorCorrection: { brightness: 0, contrast: 0, saturation: 0, tint: [1, 1, 1] }, sunRays: { intensity: 0 }, glare: {}, lensDistortion: {}, stylize: {}, composite: {} } };
  const named = [
    ['Glare', { glare: { streaks: 0.6 } }],
    ['Lens distortion', { lensDistortion: { distortion: 0.5, dispersion: 0.5 } }],
    ['Color balance', { colorBalance: { gain: [1.1, 1, 0.9] } }],
    ['Color correction', { colorCorrection: { saturation: -0.5 } }],
    ['Sun rays', { sunRays: { intensity: 0.5 } }],
    ['Stylize', { stylize: { posterize: 4 } }],
    ['Composite', { composite: { background: { color: [0.1, 0.2, 0.6] }, key: { luma: { low: 0.1, high: 0.4 } } } }],
  ];
  const effects = resolveEffects({});
  for (const [name, input] of named) {
    const stage = renderer.postStages.find(candidate => candidate.name === name);
    assert.equal(stage.apply(renderer, unset, effects, 'source'), null, `${name} is off when unset`);
    assert.equal(stage.apply(renderer, neutral, effects, 'source'), null, `${name} is off at its neutral values`);
    assert.ok(stage.apply(renderer, { eye: [0, 1, 5], effects: input }, effects, 'source'), `${name} draws`);
    stage.releaseTargets(context);
    stage.dispose(context);
  }
  assert.ok(calls.filter(call => call[0] === 'drawArrays').length === 8, 'the sun rays draw a gather and a composite');
  assert.ok(calls.filter(call => call[0] === 'deleteTexture').length === 8);
});

test('a stylize step resolves its filters and a mask, and refuses bad input', () => {
  assert.deepEqual(resolvePostSteps({ stylize: {} }).stylize, {});
  assert.deepEqual(resolvePostSteps({ stylize: { sharpen: 1, kuwahara: 3, posterize: 5, pixelate: 8 } }).stylize, { sharpen: 1, kuwahara: 3, posterize: 5, pixelate: 8 });
  assert.throws(() => resolvePostSteps({ stylize: { kuwahara: 9 } }), /stylize.kuwahara must be between/);
  assert.throws(() => resolvePostSteps({ stylize: { pixelate: 2.5 } }), /whole number/);
  assert.throws(() => resolvePostSteps({ stylize: { sharpen: -1 } }), /stylize.sharpen must be between/);
  assert.throws(() => resolvePostSteps({ stylize: { blur: 1 } }), /Unknown stylize field/);
});

test('a mask names parts or a depth range, and says what to pass when it is wrong', () => {
  const mask = resolvePostSteps({ colorBalance: { mask: { objects: ['hero'], depth: { near: 2, far: 8 }, invert: true } } }).colorBalance.mask;
  assert.deepEqual(mask, { invert: true, objects: ['hero'], depth: { near: 2, far: 8, feather: 0 } });
  assert.deepEqual(resolvePostSteps({ stylize: { mask: { depth: { far: 5 } } } }).stylize.mask, { invert: false, depth: { near: 0, far: 5, feather: 0 } });
  assert.equal(resolvePostSteps({ colorBalance: {} }).colorBalance.mask, undefined);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: {} } }), /colorBalance.mask needs a source/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: [] } } }), /1 to 16 part names/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: Array(17).fill('a') } } }), /1 to 16 part names/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: [3] } } }), /mask.objects\[0\] must be a part name/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { depth: { near: 5, far: 5 } } } }), /far must be greater than near/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { depth: { feather: -1 } } } }), /feather must be between/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: ['a'], color: 1 } } }), /Unknown colorBalance.mask field/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: ['a'], invert: 1 } } }), /invert must be true or false/);
  assert.equal(usesObjectMask(resolvePostSteps({ colorBalance: { mask: { objects: ['hero'] } } })), true);
  assert.equal(usesObjectMask(resolvePostSteps({ colorBalance: { mask: { depth: { far: 5 } } }, stylize: { pixelate: 4 } })), false);
});

test('a stage binds the part numbers of a masked step and refuses an unknown part', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = installPostSteps(installCameraEffects(fakeRenderer(context)));
  renderer.passSupport = { texture: 'ids', objectNames: () => ['floor', 'hero', 'post', 'hero'] };
  const stage = renderer.postStages.find(candidate => candidate.name === 'Color balance');
  const effects = resolveEffects({});
  const frame = mask => ({ eye: [0, 1, 5], effects: { colorBalance: { gain: [1.2, 1, 1], mask } } });
  assert.ok(stage.apply(renderer, frame({ objects: ['hero'] }), effects, 'source'));
  const bound = calls.find(call => call[0] === 'uniform1iv');
  assert.deepEqual([...bound[2]].slice(0, 3), [2, 4, 0]);
  assert.throws(() => stage.apply(renderer, frame({ objects: ['ghost'] }), effects, 'source'), /"ghost" is not a part in the frame\. Fix: use a part name such as "floor"/);
  const afterDraw = calls.slice(calls.findIndex(call => call[0] === 'drawArrays') + 1);
  const unbind = afterDraw.findIndex(call => call[0] === 'bindTexture' && call[2] === null);
  assert.ok(unbind > 0 && afterDraw[unbind - 1][0] === 'activeTexture', 'the object ID texture is unbound from its unit after the draw');
  renderer.passSupport = null;
  assert.throws(() => stage.apply(renderer, frame({ objects: ['hero'] }), effects, 'source'), /installRenderPasses/);
  stage.releaseTargets(context);
  stage.dispose(context);
});

test('a mask cannot be combined with an active lens distortion, which warps the image the mask is not warped with', () => {
  const masked = { colorBalance: { gain: [1.2, 1, 1], mask: { depth: { far: 5 } } } };
  assert.throws(() => resolvePostSteps({ ...masked, lensDistortion: { distortion: 0.2 } }), /colorBalance.mask cannot be combined with lensDistortion/);
  assert.throws(() => resolvePostSteps({ stylize: { pixelate: 4, mask: { depth: { far: 5 } } }, lensDistortion: { dispersion: 0.3 } }), /stylize.mask cannot be combined/);
  assert.ok(resolvePostSteps({ ...masked, lensDistortion: {} }).colorBalance.mask);
  assert.ok(resolvePostSteps({ lensDistortion: { distortion: 0.2 }, colorBalance: { gain: [1.2, 1, 1] } }).lensDistortion);
});

test('a composite step resolves a background and a key, and says what to pass when it is wrong', () => {
  const resolved = resolvePostSteps({ composite: { background: { top: [1, 0, 0], bottom: [0, 0, 1] }, key: { chroma: { color: [0, 1, 0] } } } }).composite;
  assert.deepEqual(resolved, { background: { top: [1, 0, 0], bottom: [0, 0, 1] }, key: { chroma: { color: [0, 1, 0], tolerance: 0.3, softness: 0.1 } } });
  assert.deepEqual(resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { luma: { low: 0.1, high: 0.5, invert: true } } } }).composite.key, { luma: { low: 0.1, high: 0.5, invert: true } });
  assert.deepEqual(resolvePostSteps({ composite: {} }).composite, {});
  assert.throws(() => resolvePostSteps({ composite: { key: { luma: {} } } }), /composite.key needs composite.background/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0], top: [0, 0, 0] } } }), /not both/);
  assert.throws(() => resolvePostSteps({ composite: { background: { top: [0, 0, 0] } } }), /both top and bottom/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: {} } }), /exactly one of chroma/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { chroma: {} } } }), /key.chroma.color must be three numbers/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { chroma: { color: [0, 1, 0], tolerance: 2 } } } }), /tolerance must be between/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { luma: { low: 0.5, high: 0.5 } } } }), /high must be greater than low/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, mask: { depth: { far: 5 } } } }), /mask limits the key/);
  assert.throws(() => resolvePostSteps({ composite: { image: 'plate.png' } }), /Unknown composite field/);
  const masked = { composite: { background: { color: [0, 0, 0] }, key: { luma: {} }, mask: { objects: ['hero'] } } };
  assert.equal(usesObjectMask(resolvePostSteps(masked)), true);
  assert.throws(() => resolvePostSteps({ ...masked, lensDistortion: { distortion: 0.2 } }), /composite.mask cannot be combined with lensDistortion/);
});

const PASS_FRAGMENT = 'vec4 userPass(vec2 uv) { return objectSlotAt(uv) == 0 ? vec4(1.0) : texture(sceneColor, uv); }';

test('a user pass lists the parts it reads and says what to pass when the list is wrong', () => {
  const [pass] = normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, objects: ['hero', 'floor'] }]);
  assert.deepEqual(pass.objects, ['hero', 'floor']);
  assert.deepEqual(describeUserPasses([pass])[0].objects, ['hero', 'floor']);
  assert.equal(Object.hasOwn(normalizeUserPasses([{ name: 'plain', fragment: 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv); }' }])[0], 'objects'), false);
  assert.throws(() => normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, objects: [] }]), /postPasses\[0\]\.objects must be a list of 1 to 16 part names/);
  assert.throws(() => normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, objects: [3] }]), /postPasses\[0\]\.objects\[0\] must be a part name/);
  assert.throws(() => normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, objects: Array(17).fill('a') }]), /1 to 16 part names/);
  assert.throws(() => normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, uniforms: { objectSlotAt: 1 } }]), /objectSlotAt/);
  assert.match(buildPassFragment(pass).source, /int objectSlotAt\(vec2 uv\)/);
});

test('a user pass binds the object ID pass for its parts and unbinds it after the draw', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = {
    context, canvas: { width: 16, height: 9 }, postStages: [], depthTexture: 'depth', whiteTexture: 'white',
    inverseViewProjection: mat4.create(), resolveFrame() {}, benchmark: false,
    passSupport: { texture: 'ids', objectNames: () => ['floor', 'hero'] },
  };
  installUserPasses(renderer);
  renderer.userPasses.set([{ name: 'tint', fragment: PASS_FRAGMENT, objects: ['hero'] }]);
  renderer.resolveFrame({ time: 0 });
  const uploaded = calls.find(call => call[0] === 'uniform1iv');
  assert.deepEqual(Array.from(uploaded[2]).slice(0, 2), [2, 0], 'the hero part has object ID 2, and the rest of the list is padded');
  assert.ok(calls.some(call => call[0] === 'bindTexture' && call[2] === 'ids'));
  const afterDraw = calls.slice(calls.findIndex(call => call[0] === 'drawArrays') + 1);
  assert.ok(afterDraw.some(call => call[0] === 'bindTexture' && call[2] === null), 'the object ID texture is unbound after the draw');
  renderer.userPasses.set([{ name: 'tint', fragment: PASS_FRAGMENT, objects: ['missing'] }]);
  assert.throws(() => renderer.resolveFrame({ time: 0 }), /Mask object "missing" is not a part in the frame/);
});

test('a user pass slot is the position in its objects list, also when a name matches several parts', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = {
    context, canvas: { width: 16, height: 9 }, postStages: [], depthTexture: 'depth', whiteTexture: 'white',
    inverseViewProjection: mat4.create(), resolveFrame() {}, benchmark: false,
    passSupport: { texture: 'ids', objectNames: () => ['hero', 'hero', 'floor'] },
  };
  installUserPasses(renderer);
  renderer.userPasses.set([{ name: 'tint', fragment: PASS_FRAGMENT, objects: ['hero', 'floor'] }]);
  renderer.resolveFrame({ time: 0 });
  const [identifiers, slots] = calls.filter(call => call[0] === 'uniform1iv').map(call => Array.from(call[2]));
  assert.deepEqual(identifiers.slice(0, 4), [1, 2, 3, 0], 'both hero parts and the floor are uploaded');
  assert.deepEqual(slots.slice(0, 3), [0, 0, 1], 'both hero parts report slot 0 and the floor reports slot 1');
  // The shader walks the uploaded IDs and returns the matching slot entry; the same walk in JavaScript.
  const slotOf = identifier => {
    const index = identifiers.slice(0, 3).indexOf(identifier);
    return index === -1 ? -1 : slots[index];
  };
  assert.deepEqual([1, 2, 3, 4].map(slotOf), [0, 0, 1, -1]);
  assert.match(buildPassFragment(normalizeUserPasses([{ name: 'tint', fragment: PASS_FRAGMENT, objects: ['hero'] }])[0]).source, /return u67_objectSlots\[slot\]/);
});

test('the shaders keep their fixed sample patterns and read no history', () => {
  for (const fragment of [glareFragment, lensDistortionFragment, colorBalanceFragment, stylizeFragment, compositeFragment]) {
    assert.match(fragment, /^#version 300 es/);
    assert.doesNotMatch(fragment, /previousViewProjection|time/);
  }
});

test('a user pass reads its time from the motion clock when the frame has one, else from the renderer time', () => {
  const calls = [];
  const renderer = { context: recordingContext(calls), canvas: { width: 16, height: 9 }, postStages: [], depthTexture: 'depth', whiteTexture: 'white',
    inverseViewProjection: mat4.create(), resolveFrame() {}, benchmark: false };
  installUserPasses(renderer);
  renderer.userPasses.set([{ name: 'clock', fragment: 'vec4 userPass(vec2 uv) { return vec4(vec3(time), 1.0); }' }]);
  const uploads = [{ time: 0, passTime: 2 }, { time: 0, passTime: 6.5 }, { time: 3 }, { time: 0, passTime: 0 }].map(frame => {
    calls.length = 0;
    renderer.resolveFrame(frame);
    return calls.filter(call => call[0] === 'uniform1f').at(-1)[2];
  });
  assert.deepEqual(uploads, [2, 6.5, 3, 0]);
});

// Draws the default frame and each step in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 node --test tests/post-steps.test.js (on a shared GPU, start it through the machine GPU lock)
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const rendersEnabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);
const STEP_CASES = ['defocus', 'color-balance', 'glare-streaks', 'glare-streaks-6', 'glare-anamorphic', 'glare-fog', 'lens-distortion', 'lens-dispersion',
  'grade-hero', 'grade-depth', 'user-pass-hero', 'sharpen', 'kuwahara', 'posterize', 'pixelate', 'pixelate-hero', 'key-chroma', 'key-luma'];

test('each named step changes the picture and the default still keeps its hash', { skip: !rendersEnabled, timeout: 300000 }, () => {
  const output = execFileSync('node', ['bench/post/post-steps.mjs', '--rounds=1', `--out=${join(tmpdir(), 'post-steps-test')}`], { encoding: 'utf8' });
  const { summary } = JSON.parse(output);
  for (const name of STEP_CASES) {
    assert.notEqual(summary[name].hash, summary.default.hash, `${name} differs from the default`);
    assert.ok(summary[name].medianMilliseconds > 0, `${name} has a frame time`);
  }
  // A grade masked to the hero part changes the hero and leaves the floor as the default drew it; the unmasked grade changes both.
  // A green-screen hero keyed out shows the background there; the floor is untouched. A key limited by a depth mask that leaves the hero out changes nothing.
  assert.notDeepEqual(summary['key-chroma'].regions.hero, summary['green-default'].regions.hero);
  assert.deepEqual(summary['key-chroma'].regions.floor, summary['green-default'].regions.floor);
  assert.deepEqual(summary['key-chroma-masked'].regions.hero, summary['green-default'].regions.hero);
  assert.notDeepEqual(summary['grade-hero'].regions.hero, summary.default.regions.hero);
  assert.deepEqual(summary['grade-hero'].regions.floor, summary.default.regions.floor);
  assert.notDeepEqual(summary['color-balance'].regions.floor, summary.default.regions.floor);
  assert.deepEqual(summary['pixelate-hero'].regions.floor, summary.default.regions.floor);
  // A user pass that lists the hero part and tints where objectSlotAt says 0 changes the hero and leaves the floor alone.
  assert.notDeepEqual(summary['user-pass-hero'].regions.hero, summary.default.regions.hero);
  assert.deepEqual(summary['user-pass-hero'].regions.floor, summary.default.regions.floor);
  // Hash of the default still as origin/main drew it before the named steps (bench/post/post-steps.mjs --root=<origin/main checkout>).
  assert.equal(summary.default.hash, '8741ffc3aaace9a8');
});

test('a user pass reads the camera eye of the frame it draws, so a camera track moves it', () => {
  const calls = [];
  const renderer = { context: recordingContext(calls), canvas: { width: 16, height: 9 }, postStages: [], depthTexture: 'depth', whiteTexture: 'white',
    inverseViewProjection: mat4.create(), resolveFrame() {}, benchmark: false };
  installUserPasses(renderer);
  renderer.userPasses.set([{ name: 'shafts', fragment: 'vec4 userPass(vec2 uv) { return vec4(cameraEye, 1.0); }' }]);
  assert.match(buildPassFragment(normalizeUserPasses([{ name: 'shafts', fragment: 'vec4 userPass(vec2 uv) { return vec4(cameraEye, 1.0); }' }])[0]).source, /uniform vec3 cameraEye;/);
  const uploads = [[0, 1, 5], [4, 2, -3]].map(eye => {
    calls.length = 0;
    renderer.resolveFrame({ time: 0, eye });
    return calls.filter(call => call[0] === 'uniform3fv').at(-1)[2];
  });
  assert.deepEqual(uploads, [[0, 1, 5], [4, 2, -3]]);
});

test('a mask or user pass names a placed asset by its node id and gets every part of it as one slot (#3055)', async () => {
  const { objectIdentifierSlots } = await import('../src/post-mask.js');
  const parts = ['floor', 'loco/0', 'loco/1', 'tender/0', 'loco/2'];
  const renderer = {
    passSupport: {
      objectNames: () => parts,
      objectNodes: () => ({ floor: [1], loco: [2, 3, 5], tender: [4] }),
    },
  };
  assert.deepEqual(objectIdentifierSlots(renderer, ['loco', 'tender']), { identifiers: [2, 3, 5, 4], slots: [0, 0, 0, 1] });
  assert.deepEqual(objectIdentifierSlots(renderer, ['loco/1', 'floor']).identifiers, [3, 1], 'a part name still works');
  assert.throws(() => objectIdentifierSlots(renderer, ['ghost']), /"ghost" is not a part in the frame/);
  const wide = { passSupport: { objectNames: () => [], objectNodes: () => ({ train: Array.from({ length: 40 }, (_, index) => index + 1) }) } };
  assert.equal(objectIdentifierSlots(wide, ['train']).identifiers.length, 40, 'a 40-part asset fits in one mask');
});

test('colorCorrection resolves with identity defaults and names the fix in each error', () => {
  assert.deepEqual(resolvePostSteps({ colorCorrection: {} }).colorCorrection, { brightness: 0, contrast: 0, saturation: 0, tint: [1, 1, 1] });
  assert.deepEqual(resolvePostSteps({ colorCorrection: { tint: [1, 0.9, 0.8], saturation: -0.2 } }).colorCorrection.tint, [1, 0.9, 0.8]);
  assert.throws(() => resolvePostSteps({ colorCorrection: { brightness: 2 } }), /colorCorrection\.brightness is 2: pass a number from -1 to 1/);
  assert.throws(() => resolvePostSteps({ colorCorrection: { tint: [1, 1] } }), /colorCorrection\.tint.*three numbers from 0 to 4/);
  assert.throws(() => resolvePostSteps({ colorCorrection: { hue: 1 } }), /colorCorrection\.hue.*one of the fields brightness, contrast, saturation, tint/);
});

test('sunRays resolves with defaults and names the fix in each error', () => {
  assert.deepEqual(resolvePostSteps({ sunRays: {} }).sunRays, { intensity: 0.25, spread: 1 });
  assert.throws(() => resolvePostSteps({ sunRays: { intensity: 5 } }), /effects\.sunRays\.intensity is 5: pass a number from 0 to 4/);
  assert.throws(() => resolvePostSteps({ sunRays: { spread: -1 } }), /effects\.sunRays\.spread is -1: pass a number from 0 to 1/);
  assert.throws(() => resolvePostSteps({ sunRays: { color: 1 } }), /effects\.sunRays\.color.*one of the fields intensity, spread/);
});

function cameraRenderer(context, towardSun) {
  const eye = [0, 1.7, 7];
  const projection = mat4.perspective(mat4.create(), 50 * Math.PI / 180, 16 / 9, 0.1, 500);
  const view = mat4.lookAt(mat4.create(), eye, [0, 2.2, -10], [0, 1, 0]);
  const renderer = fakeRenderer(context);
  renderer.viewProjection = mat4.multiply(mat4.create(), projection, view);
  renderer.activeLightDirection = towardSun;
  return { renderer, frame: { eye, effects: { sunRays: { intensity: 0.5, spread: 0.7 } } } };
}

function screenOf(renderer, point) {
  const clip = [0, 1, 3].map(row => renderer.viewProjection[row] * point[0] + renderer.viewProjection[row + 4] * point[1] + renderer.viewProjection[row + 8] * point[2] + renderer.viewProjection[row + 12]);
  return [clip[0] / clip[2] * 0.5 + 0.5, clip[1] / clip[2] * 0.5 + 0.5];
}

test('the sun rays start at the sun: its direction projected through the camera, in line with every cast shadow', () => {
  const context = recordingContext([]);
  const forward = vec3.normalize(vec3.create(), [0, 0.5, -17]);
  const ahead = cameraRenderer(context, [...forward]);
  const centre = sunScreenPosition(ahead.renderer, ahead.frame);
  assert.ok(Math.abs(centre[0] - 0.5) < 1e-3 && Math.abs(centre[1] - 0.5) < 1e-3, `a sun on the view axis is at the screen centre, got ${centre}`);
  const yawed = vec3.rotateY(vec3.create(), forward, [0, 0, 0], -0.2);
  const side = cameraRenderer(context, [...yawed]);
  const expectedX = 0.5 + 0.5 * Math.tan(0.2) / (Math.tan(25 * Math.PI / 180) * 16 / 9);
  assert.ok(Math.abs(sunScreenPosition(side.renderer, side.frame)[0] - expectedX) < 0.02, 'a sun 0.2 rad to the right lands where the lens puts it');
  // A pole of height 3 casts a shadow along -sun; on screen the sun, the pole top and the shadow tip lie on one line, in that order.
  const towardSun = vec3.normalize(vec3.create(), [0.3, 0.45, -1]);
  const view = cameraRenderer(context, [...towardSun]);
  const sun = sunScreenPosition(view.renderer, view.frame);
  const top = [1, 3, -12];
  const shadowTip = [top[0] - towardSun[0] * 3 / towardSun[1], 0, top[2] - towardSun[2] * 3 / towardSun[1]];
  const topOnScreen = screenOf(view.renderer, top);
  const tipOnScreen = screenOf(view.renderer, shadowTip);
  const along = [topOnScreen[0] - tipOnScreen[0], topOnScreen[1] - tipOnScreen[1]];
  const toSun = [sun[0] - topOnScreen[0], sun[1] - topOnScreen[1]];
  const cross = (along[0] * toSun[1] - along[1] * toSun[0]) / (Math.hypot(...along) * Math.hypot(...toSun));
  assert.ok(Math.abs(cross) < 0.01, `the shadow line points at the sun's screen position (sine of the angle ${cross})`);
  assert.ok(along[0] * toSun[0] + along[1] * toSun[1] > 0, 'from the shadow tip through the pole top and on to the sun');
  const behind = cameraRenderer(context, [0, 0.3, 1]);
  assert.equal(sunScreenPosition(behind.renderer, behind.frame), null, 'a sun behind the camera has no screen position');
});

test('the sun rays gather half resolution toward the projected sun, and a sun behind the camera draws nothing', () => {
  const calls = [];
  const context = recordingContext(calls);
  const { renderer, frame } = cameraRenderer(context, [0.3, 0.45, -1]);
  installPostSteps(renderer);
  const stage = renderer.postStages.find(candidate => candidate.name === 'Sun rays');
  const position = sunScreenPosition(renderer, frame);
  assert.ok(stage.apply(renderer, frame, resolveEffects({}), 'source'));
  const viewports = calls.filter(call => call[0] === 'viewport').map(call => call.slice(1));
  assert.deepEqual(viewports, [[0, 0, 8, 5], [0, 0, 16, 9]], 'the gather covers a quarter of the pixels, then the upsample covers the frame');
  assert.ok(calls.some(call => call[0] === 'uniform2f' && call[2] === position[0] && call[3] === position[1]), 'the gather is told the projected sun position');
  calls.length = 0;
  const behind = cameraRenderer(context, [0, 0.3, 1]);
  assert.equal(stage.apply(behind.renderer, behind.frame, resolveEffects({}), 'source'), null);
  assert.equal(calls.filter(call => call[0] === 'drawArrays').length, 0, 'no pass runs for a sun behind the camera');
});
