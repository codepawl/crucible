import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';

// Each check runs in a fresh Node process, because a module that an earlier test imported would stay registered for the rest of this file.
function runInFreshProcess(script) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop());
}

const RELIEF_FEATURES = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'heightMap'];
// The sha256 of createFragmentShader(RELIEF_FEATURES) when height-parallax-shader.js was a static import of shaders.js (origin/main at #3359).
const RELIEF_SHADER_HASH_BEFORE_THE_MOVE = '22937848b211fd711a0ae91f10a9a9980bde13477640a05bd80cf9b642c9b001';

test('a recipe without a height scale does not ask for the relief module, and one with it does', () => {
  const recipe = materialFields => ({ materials: [{ id: 'rock', roughness: 0.5, ...materialFields }] });
  assert.ok(!agentSceneModulesNeeded(recipe({ colorMap: 'rock.png' })).includes('heightParallaxShader'));
  assert.ok(agentSceneModulesNeeded(recipe({ heightMap: 'rock-height.png', heightScale: 0.02 })).includes('heightParallaxShader'));
});

test('the renderer, the shader builder, the cascaded shadows and the agent scene never load the relief module', () => {
  const result = runInFreshProcess(`
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
    const registry = await import('./src/shader-registry.js');
    for (const entry of ['shaders', 'renderer', 'cascaded-shadows', 'agent-scene']) await import('./src/' + entry + '.js');
    console.log(JSON.stringify({ loaded: loaded.some(url => url.includes('height-parallax-shader')), registered: registry.registeredFeatureCode.has('heightMap') }));
  `);
  assert.equal(result.loaded, false, 'a module in the static graph of these entries imports height-parallax-shader.js');
  assert.equal(result.registered, false);
});

test('a relief shader without the module says which import to add, and a loaded recipe builds the same source as before the move', () => {
  const result = runInFreshProcess(`
    import { createHash } from 'node:crypto';
    const { createFragmentShader } = await import('./src/shaders.js');
    const { loadAgentSceneModules } = await import('./src/agent-scene-modules.js');
    const features = ${JSON.stringify(RELIEF_FEATURES)};
    let message = null;
    try {
      createFragmentShader(features);
    } catch (error) {
      message = error.message;
    }
    await loadAgentSceneModules({ materials: [{ id: 'rock', heightMap: 'rock-height.png', heightScale: 0.02 }] });
    const hash = createHash('sha256').update(createFragmentShader(features)).digest('hex');
    console.log(JSON.stringify({ message, hash }));
  `);
  assert.match(result.message, /height-parallax-shader/);
  assert.match(result.message, /loadAgentSceneModules/);
  assert.equal(result.hash, RELIEF_SHADER_HASH_BEFORE_THE_MOVE);
});

test('the parallax binding sends the march off for a batch without a height map, and its texture on its own unit for one with', async () => {
  const { bindHeightParallax, heightParallaxState } = await import('../src/height-parallax-shader.js');
  const { HEIGHT_MAP_UNIT } = await import('../src/shader-registry.js');
  const calls = [];
  const context = {
    TEXTURE0: 100, TEXTURE_2D: 1,
    uniform4f: (...values) => calls.push(['uniform4f', ...values]),
    uniform1i: (...values) => calls.push(['uniform1i', ...values]),
    activeTexture: unit => calls.push(['activeTexture', unit]),
    bindTexture: (target, texture) => calls.push(['bindTexture', target, texture]),
  };
  const uniforms = { heightState: 'state', heightMap: 'sampler' };
  bindHeightParallax(context, uniforms, [], null);
  assert.deepEqual(calls, [['uniform4f', 'state', 0, 12, 16, 0], ['uniform1i', 'sampler', HEIGHT_MAP_UNIT]]);
  calls.length = 0;
  const map = { colorSpace: 'linear' };
  const state = heightParallaxState({ heightMap: map, heightScale: 0.02, heightSteps: 8 }, new Set());
  assert.deepEqual(state, [map, 0.02, 12, 8]);
  bindHeightParallax(context, uniforms, state, 'texture');
  assert.deepEqual(calls, [['uniform4f', 'state', 0.02, 12, 8, 1], ['uniform1i', 'sampler', HEIGHT_MAP_UNIT], ['activeTexture', 100 + HEIGHT_MAP_UNIT], ['bindTexture', 1, 'texture']]);
  assert.throws(() => heightParallaxState({ heightMap: map, heightScale: 0.9 }, new Set()), /heightScale must be between/);
  assert.throws(() => heightParallaxState({ heightMap: map, heightScale: 0.02, tag: 'water' }, new Set(['water'])), /standard PBR material/);
});
