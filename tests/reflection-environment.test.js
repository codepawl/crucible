import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentMap } from '../src/environment.js';
import { withReflectionEnvironment } from '../src/reflection-environment.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { registerCatalogEnvironment, catalogLookReferences } from '../src/look-catalog.js';
import { pathTraceEnvironment } from '../src/path-trace-terms.js';
import { prepareFileScene } from '../scripts/file-scene.mjs';

const PALE_ID = 'a'.repeat(64);
const SUNSET_ID = 'b'.repeat(64);

// A recipe that names reflectionHdri loads its module first, as one that names a skybox does.
await loadAgentSceneModules({ environment: { reflectionHdri: SUNSET_ID } });

function flatMap(color, options = {}) {
  const data = new Float32Array(8 * 4 * 3);
  for (let index = 0; index < data.length; index += 3) data.set(color, index);
  return createEnvironmentMap({ width: 8, height: 4, data, ...options });
}

function registerSkies() {
  registerCatalogEnvironment(PALE_ID, { width: 8, height: 4, data: flatMap([0.6, 0.6, 0.6]).data });
  registerCatalogEnvironment(SUNSET_ID, { width: 8, height: 4, data: flatMap([1.4, 0.4, 0.5]).data });
}

test('the combined map reflects the reflection pixels and lights from the lighting pixels', () => {
  const lighting = flatMap([0.6, 0.6, 0.6], { intensity: 2, rotation: 0.5, showBackground: true });
  const reflection = flatMap([1.4, 0.4, 0.5], { intensity: 9, rotation: 3 });
  const combined = withReflectionEnvironment(lighting, reflection);
  assert.equal(combined.data, reflection.data);
  assert.equal(combined.irradianceSource.data, lighting.data);
  assert.equal(combined.intensity, 2);
  assert.equal(combined.rotation, 0.5);
  assert.equal(combined.showBackground, true);
});

test('the same two maps give the same object, and a turned lighting map keeps one irradiance source, so the renderer prefilters once', () => {
  const lighting = flatMap([0.6, 0.6, 0.6]);
  const reflection = flatMap([1.4, 0.4, 0.5]);
  assert.equal(withReflectionEnvironment(lighting, reflection), withReflectionEnvironment(lighting, reflection));
  const turned = Object.freeze({ ...lighting, rotation: 1 });
  const first = withReflectionEnvironment(lighting, reflection);
  const second = withReflectionEnvironment(turned, reflection);
  assert.equal(second.irradianceSource, first.irradianceSource);
  assert.equal(second.data, first.data);
});

test('a lighting map that already has an irradiance source keeps it as the diffuse light', () => {
  const bounced = flatMap([0.1, 0.1, 0.1]);
  const lighting = Object.freeze({ ...flatMap([0.6, 0.6, 0.6]), irradianceSource: bounced });
  const combined = withReflectionEnvironment(lighting, flatMap([1, 0, 0]));
  assert.equal(combined.irradianceSource.data, bounced.data);
});

test('a reflection that is not an environment map says what to pass', () => {
  assert.throws(() => withReflectionEnvironment(flatMap([1, 1, 1]), { data: new Float32Array(3) }), /pass the HDRI that glass and water should reflect/);
  assert.throws(() => withReflectionEnvironment(flatMap([1, 1, 1]), null), TypeError);
});

test('environment.reflectionHdri feeds specular only: the agent map takes its pixels and the diffuse source stays the lighting HDRI', () => {
  registerSkies();
  const { environment } = normalizeAgentLook({ environment: { hdri: PALE_ID, reflectionHdri: SUNSET_ID } });
  assert.equal(environment.reflectionHdri, SUNSET_ID);
  const map = agentEnvironmentMap(environment);
  const lightingOnly = agentEnvironmentMap({ ...environment, reflectionHdri: undefined });
  assert.equal(map.data[0], Math.fround(1.4));
  assert.equal(map.irradianceSource.data[0], Math.fround(0.6));
  assert.equal(lightingOnly.data[0], Math.fround(0.6));
  assert.equal(agentEnvironmentMap(environment), map);
});

test('a scene without reflectionHdri returns the very map it returned before, with no irradiance source added', () => {
  registerSkies();
  const { environment } = normalizeAgentLook({ environment: { hdri: PALE_ID } });
  assert.equal('reflectionHdri' in environment, false);
  const map = agentEnvironmentMap(environment);
  assert.equal(map.irradianceSource, undefined);
  assert.equal(agentEnvironmentMap(environment), map);
});

test('reflectionHdri is validated with errors that say what to pass', () => {
  assert.throws(() => normalizeAgentLook({ environment: { reflectionHdri: 'https://example.com/sky.hdr' } }), /environment\.reflectionHdri.*64-character ID of a \.hdr file/);
  assert.throws(() => normalizeAgentLook({ environment: { reflectionHdri: 3 } }), /environment\.reflectionHdri/);
  assert.throws(() => normalizeAgentLook({ environment: { reflectionHdri: SUNSET_ID, skybox: { front: 'c'.repeat(64) } } }), /remove "reflectionHdri", or remove "skybox"/);
});

test('the path trace keeps the lighting HDRI for every bounce, and the catalog loads both HDRIs', () => {
  registerSkies();
  const { environment } = normalizeAgentLook({ environment: { hdri: PALE_ID, reflectionHdri: SUNSET_ID } });
  assert.equal(pathTraceEnvironment(environment).map.data[0], Math.fround(0.6));
  assert.deepEqual(catalogLookReferences({ environment }).environments, [PALE_ID, SUNSET_ID].sort());
});

test('a scene file routes reflectionHdri like hdri and rejects anything else', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'reflection-hdri-'));
  await writeFile(join(folder, 'scene.glb'), 'glb');
  await writeFile(join(folder, 'pale.hdr'), 'hdr');
  await writeFile(join(folder, 'sunset.hdr'), 'hdr');
  const configPath = join(folder, 'scene.json');
  await writeFile(configPath, JSON.stringify({ glb: 'scene.glb', hdri: 'pale.hdr', reflectionHdri: 'sunset.hdr' }));
  const { description } = prepareFileScene({ configPath });
  assert.equal(description.hdri, '/__file/asset/1/pale.hdr');
  assert.equal(description.reflectionHdri, '/__file/asset/2/sunset.hdr');
  await writeFile(configPath, JSON.stringify({ glb: 'scene.glb', hdri: 'pale.hdr', reflectionHdri: 7 }));
  assert.throws(() => prepareFileScene({ configPath }), /"reflectionHdri" must be the path of a local Radiance \.hdr file/);
  await writeFile(configPath, JSON.stringify({ glb: 'scene.glb', hdri: 'pale.hdr', reflectionHdri: 'https://example.com/sky.hdr' }));
  assert.throws(() => prepareFileScene({ configPath }), /Remote asset URLs are not allowed/);
});

test('only a recipe or edit that names reflectionHdri loads the reflection module', () => {
  assert.deepEqual(agentSceneModulesNeeded({ environment: { hdri: PALE_ID } }).filter(name => name === 'reflectionEnvironment'), []);
  assert.deepEqual(agentSceneModulesNeeded({ environment: { hdri: PALE_ID, reflectionHdri: SUNSET_ID } }).filter(name => name === 'reflectionEnvironment'), ['reflectionEnvironment']);
  assert.deepEqual(agentSceneModulesNeeded([{ type: 'set-environment', environment: { reflectionHdri: null } }]).filter(name => name === 'reflectionEnvironment'), ['reflectionEnvironment']);
});
