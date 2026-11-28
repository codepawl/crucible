import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSceneModule } from '../src/agent-scene-modules.js';
import { createStudio } from '../src/studio.js';
import { STUDIO_ICON_PATHS } from '../src/studio-icons.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

const FOAM_FRAGMENT = 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv) * strength; }';
const GRAIN_FRAGMENT = 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv) + vec4(grain); }';
const DEPTH_FRAGMENT = 'vec4 userPass(vec2 uv) { return vec4(vec3(depthAt(uv)), 1.0); }';

function passRecipe(postPasses, extra = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
    postPasses,
    ...extra,
  };
}

const TWO_PASSES = [
  { name: 'foam', fragment: FOAM_FRAGMENT, uniforms: { strength: 0.75 }, scale: 0.5 },
  { name: 'grain', fragment: GRAIN_FRAGMENT, uniforms: { grain: [0.1, 0.2, 0.3, 0] } },
];

// Behaves like a renderer with the user pass stage: the stage compiles on the frame, so a bad pass throws from render.
function createPassRenderer({ depth = true, canTakePasses = true } = {}) {
  const renderer = createFakeRenderer();
  renderer.depth = depth;
  if (canTakePasses) {
    renderer.postStages = [];
    renderer.resolveFrame = () => null;
  }
  renderer.compileFailures = new Map();
  const render = renderer.render;
  renderer.render = frame => {
    render(frame);
    const drawnPasses = renderer.userPasses?.passes ?? [];
    for (const pass of drawnPasses) {
      const failure = renderer.compileFailures.get(pass.name);
      if (failure) {
        throw new Error(`Post pass "${pass.name}" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.\n\n${failure}\nsecond line`);
      }
    }
  };
  return renderer;
}

// A loader the test resolves or rejects when it chooses, standing in for the lazy render pass chunk.
function createControlledLoader() {
  const loader = { requested: 0 };
  loader.load = () => {
    loader.requested += 1;
    return new Promise((resolve, reject) => {
      loader.resolve = () => resolve({ installRenderPasses: installFakeRenderPasses });
      loader.reject = reason => reject(reason);
    });
  };
  return loader;
}

function installFakeRenderPasses(renderer) {
  renderer.passSupport = {};
  return renderer;
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

function mountPassStudio(testContext, recipe, renderer = createPassRenderer(), studioOptions = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer, ...studioOptions });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  // Build draws plainly (#3594), so the tests of the full look open Look.
  studio.setWorkspace('look');
  studio.renderNow();
  return {
    dom,
    studio,
    renderer,
    root,
    notice: () => root.querySelector('.crucible-studio-pass-notice'),
    paused: () => root.querySelector('.crucible-studio-paused'),
    noticeLines: () => root.querySelector('.crucible-studio-pass-notice').querySelectorAll('p').map(line => line.textContent),
  };
}

test('the passes of the recipe are set on the renderer, with the antialias mode', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES, { postPassesAntialias: 'off' }));
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam', 'grain']);
  assert.equal(ui.renderer.userPasses.passes[0].scale, 0.5);
  assert.equal(ui.notice().hidden, true);
  assert.equal(ui.paused().hidden, true);
  assert.ok(ui.renderer.frames.length > 0);
});

test('Build draws no pass, no shadows and no effects, and Look draws them again without touching the recipe (#3594)', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES, { effects: { bloom: { strength: 1 } } }));
  assert.equal(ui.renderer.shadowsHidden, false);
  ui.studio.setWorkspace('build');
  ui.studio.renderNow();
  assert.deepEqual(ui.renderer.userPasses.passes, []);
  assert.equal(ui.renderer.shadowsHidden, true);
  assert.equal(ui.renderer.frames.at(-1).effects.bloom.strength, 0);
  assert.equal(ui.notice().hidden, true);
  ui.studio.setWorkspace('look');
  ui.studio.renderNow();
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam', 'grain']);
  assert.equal(ui.renderer.shadowsHidden, false);
  assert.equal(ui.renderer.frames.at(-1).effects.bloom.strength, 1);
});

const OBJECT_PASS = { name: 'edge', fragment: FOAM_FRAGMENT.replace('strength', '1.0'), objects: ['hero'] };

test('a pass with objects gets the object ID render before the frame, on a renderer that has render passes', testContext => {
  const ui = mountPassStudio(testContext, passRecipe([OBJECT_PASS]), installFakeRenderPasses(createPassRenderer()));
  const frames = ui.renderer.frames;
  const objectFrameIndex = frames.findIndex(frame => frame.pass === 'objectId');
  assert.ok(objectFrameIndex >= 0, 'the object ID frame is drawn');
  assert.equal(frames[objectFrameIndex + 1].pass, undefined, 'the lit frame follows it');
});

test('a pass that fails to compile is named, left out of the frame, and not tried again until its fragment changes', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES));
  ui.renderer.compileFailures.set('grain', "ERROR: 0:7: 'grain' : undeclared identifier");
  ui.renderer.frames.length = 0;
  ui.studio.renderNow();
  ui.dom.runTimers();

  assert.equal(ui.paused().hidden, true, 'a bad pass does not pause the picture');
  assert.equal(ui.notice().hidden, false);
  assert.equal(ui.notice().getAttribute('role'), 'status');
  assert.ok(ui.notice().querySelector('svg'), 'the notice leads with an icon');
  assert.deepEqual(ui.noticeLines(), ['Post pass "grain" is not drawn here: ERROR: 0:7: \'grain\' : undeclared identifier']);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam'], 'the other pass still draws');

  const framesAfterRefusal = ui.renderer.frames.length;
  assert.ok(framesAfterRefusal >= 1, 'the frame was drawn again in the same tick');
  ui.renderer.compileFailures.delete('grain');
  ui.studio.renderNow();
  ui.studio.renderNow();
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam'], 'the broken pass is not set again');

  const recipe = ui.studio.exportRecipe();
  recipe.postPasses[1].fragment = GRAIN_FRAGMENT.replace('vec4(grain)', 'vec4(grain + 0.0)');
  ui.studio.loadRecipe(recipe);
  ui.studio.renderNow();
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam', 'grain'], 'a changed fragment is tried again');
  assert.equal(ui.notice().hidden, true, 'the notice goes when the pass draws');
});

test('a pass that leaves the recipe takes its notice with it', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES));
  ui.renderer.compileFailures.set('grain', 'ERROR: 0:1: broken');
  ui.studio.renderNow();
  assert.equal(ui.notice().hidden, false);
  const recipe = ui.studio.exportRecipe();
  recipe.postPasses = [recipe.postPasses[0]];
  ui.studio.loadRecipe(recipe);
  ui.studio.renderNow();
  assert.equal(ui.notice().hidden, true);
});

test('an error that does not name a pass of the scene still pauses the picture', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES));
  const render = ui.renderer.render;
  ui.renderer.render = frame => {
    render.call(ui.renderer, frame);
    throw new Error('Post pass "ghost" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.\nERROR: 0:1: nope');
  };
  ui.studio.controller.orbitCamera({ zoomScale: 2 });
  ui.dom.runAnimationFrames(100);
  assert.equal(ui.paused().hidden, false);
  assert.match(ui.paused().textContent, /ghost/);
  assert.equal(ui.notice().hidden, true);

  ui.renderer.render = () => {
    throw new Error('WebGL render failed with error 1282.');
  };
  ui.studio.controller.orbitCamera({ zoomScale: 2 });
  ui.dom.runAnimationFrames(200);
  assert.match(ui.paused().textContent, /1282/);
});

test('a scene without passes shows no notice', testContext => {
  const ui = mountPassStudio(testContext, passRecipe([]));
  assert.equal(ui.notice().hidden, true);
  assert.equal(ui.renderer.userPasses.passes.length, 0);
});

test('a renderer that cannot take passes names every pass and still draws the scene', testContext => {
  const ui = mountPassStudio(testContext, passRecipe(TWO_PASSES), createPassRenderer({ canTakePasses: false }));
  assert.equal(ui.notice().hidden, false);
  assert.deepEqual(ui.noticeLines(), [
    'Post pass "foam" is not drawn here: this renderer cannot draw post passes',
    'Post pass "grain" is not drawn here: this renderer cannot draw post passes',
  ]);
  assert.equal(ui.paused().hidden, true);
  assert.ok(ui.renderer.frames.length > 0);
});

test('a renderer without depth names only the pass that reads the scene depth', testContext => {
  const passes = [{ name: 'fog', fragment: DEPTH_FRAGMENT }, TWO_PASSES[0]];
  const ui = mountPassStudio(testContext, passRecipe(passes), createPassRenderer({ depth: false }));
  assert.deepEqual(ui.noticeLines(), ['Post pass "fog" is not drawn here: it reads the scene depth and this renderer has none']);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam']);
});

test('the notice uses the warning icon, a shape of its own', () => {
  assert.ok(STUDIO_ICON_PATHS.warning);
  assert.notEqual(STUDIO_ICON_PATHS.warning, STUDIO_ICON_PATHS.pause);
});

test('opening and saving a recipe leaves its post passes as the normalised input, through an edit and an undo', testContext => {
  const input = passRecipe(TWO_PASSES, { postPassesAntialias: 'off' });
  const expected = agentSceneModule('userPass').normalizeUserPasses(TWO_PASSES);
  const ui = mountPassStudio(testContext, input);
  ui.renderer.compileFailures.set('grain', 'ERROR: 0:1: broken');
  ui.studio.renderNow();

  assert.deepEqual(ui.studio.exportRecipe().postPasses, expected, 'a pass the viewport refused is still saved');
  assert.equal(ui.studio.exportRecipe().postPassesAntialias, 'off');
  assert.equal(expected[0].scale, 0.5);
  assert.deepEqual(expected[0].uniforms, { strength: { type: 'float', value: 0.75 } });

  ui.studio.controller.setCameraLensMillimetres(85);
  assert.deepEqual(ui.studio.exportRecipe().postPasses, expected, 'an edit leaves the passes alone');
  ui.studio.controller.undo();
  assert.deepEqual(ui.studio.exportRecipe().postPasses, expected, 'an undo leaves the passes alone');

  ui.studio.loadRecipe(JSON.parse(JSON.stringify(ui.studio.exportRecipe())));
  assert.deepEqual(ui.studio.exportRecipe().postPasses, expected, 'the saved text opens to the same passes');
});

test('a pass with objects waits quietly while the render pass code loads, then is drawn after the object ID render', async testContext => {
  const loader = createControlledLoader();
  const passes = [OBJECT_PASS, TWO_PASSES[0]];
  const ui = mountPassStudio(testContext, passRecipe(passes), createPassRenderer(), { renderPassesLoader: loader.load });
  assert.equal(loader.requested, 1);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam'], 'the object pass is absent while loading');
  assert.equal(ui.notice().hidden, true, 'loading is not a refusal');
  assert.equal(ui.renderer.frames.some(frame => frame.pass === 'objectId'), false);

  loader.resolve();
  await settle();
  assert.equal(ui.dom.pendingAnimationFrameCount, 1, 'a frame is requested once the code is in');
  ui.renderer.frames.length = 0;
  ui.dom.runAnimationFrames(100);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['edge', 'foam']);
  assert.equal(ui.notice().hidden, true);
  assert.equal(ui.renderer.frames[0].pass, 'objectId', 'the object ID render comes first');
  assert.equal(loader.requested, 1, 'the code is fetched once');
});

test('a render pass chunk that fails to load names the object passes and draws the others', async testContext => {
  const loader = createControlledLoader();
  const passes = [OBJECT_PASS, TWO_PASSES[0]];
  const ui = mountPassStudio(testContext, passRecipe(passes), createPassRenderer(), { renderPassesLoader: loader.load });
  loader.reject(new Error('network down'));
  await settle();
  ui.dom.runAnimationFrames(100);
  assert.deepEqual(ui.noticeLines(), ['Post pass "edge" is not drawn here: the render pass code could not be loaded: network down']);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam']);
  assert.equal(ui.paused().hidden, true);
});

test('an object ID render that throws never pauses the picture: the object passes are named and the rest draw', testContext => {
  const renderer = installFakeRenderPasses(createPassRenderer());
  const render = renderer.render;
  renderer.render = frame => {
    if (frame.pass === 'objectId') {
      throw new Error('Render passes need installRenderPasses(renderer)\nsecond line');
    }
    render(frame);
  };
  const passes = [OBJECT_PASS, TWO_PASSES[0]];
  const ui = mountPassStudio(testContext, passRecipe(passes), renderer);
  assert.equal(ui.paused().hidden, true);
  assert.deepEqual(ui.noticeLines(), ['Post pass "edge" is not drawn here: the object ID render failed here: Render passes need installRenderPasses(renderer)']);
  assert.deepEqual(ui.renderer.userPasses.passes.map(pass => pass.name), ['foam']);
  assert.ok(ui.renderer.frames.length > 0, 'the frame still draws');
  const framesBefore = ui.renderer.frames.length;
  ui.studio.renderNow();
  assert.equal(ui.renderer.frames.length, framesBefore + 1, 'one frame, with no object ID render tried again');
});
