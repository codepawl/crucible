// A directional light that carries its sun size reaches the scene file's environment and cascade resolver, so the sun's shadow edge has the width the source scene had (#2761).
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSceneFileCascades } from '../src/cascaded-shadows.js';
import { mergePartLights, sceneFileLighting, withSceneFileLights } from '../src/dense-lods.js';
import { parseGltf } from '../src/gltf.js';

const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const CLASSROOM_SUN_RADIUS = (1.72 / 2) * (Math.PI / 180);

function sunDocument(extras) {
  const bytes = new Uint8Array(TRIANGLE_POSITIONS.buffer);
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Triangle', mesh: 0 }, { name: 'Sun node', extensions: { KHR_lights_punctual: { light: 0 } } }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'directional', name: 'Sun', ...(extras === undefined ? {} : { extras }) }] } },
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  });
}

test('a sun light with extras.sunAngularRadius gives the environment that radius', async () => {
  const asset = await parseGltf(sunDocument({ sunAngularRadius: CLASSROOM_SUN_RADIUS }));
  assert.equal(asset.lights.sunAngularRadius, CLASSROOM_SUN_RADIUS);
  assert.equal(withSceneFileLights(asset.lights, {}).sunAngularRadius, CLASSROOM_SUN_RADIUS);
  assert.equal(mergePartLights([asset.lights]).sunAngularRadius, CLASSROOM_SUN_RADIUS);
  const lit = sceneFileLighting(null, asset.lights, {});
  assert.equal(lit.environment.sunAngularRadius, CLASSROOM_SUN_RADIUS);
  assert.equal(resolveSceneFileCascades({}, lit.environment, { extent: 12 }).count, 1);
  assert.equal(resolveSceneFileCascades({}, lit.environment, { extent: 85 }).count, 3);
});

test('a scene file that names its own sun size overrides the light', async () => {
  const asset = await parseGltf(sunDocument({ sunAngularRadius: CLASSROOM_SUN_RADIUS }));
  assert.equal(withSceneFileLights(asset.lights, { sunAngularRadius: 0.05 }).sunAngularRadius, 0.05);
});

test('a sun light without a size leaves the environment without one and keeps the single shadow map', async () => {
  const asset = await parseGltf(sunDocument());
  assert.equal('sunAngularRadius' in asset.lights, false);
  assert.equal(resolveSceneFileCascades({}, asset.lights, { extent: 12 }), undefined);
});

test('a size outside the range the renderer accepts is ignored with a warning that says what to pass', async () => {
  for (const sunAngularRadius of [0, 0.5, -1, Number.NaN, 'wide']) {
    const asset = await parseGltf(sunDocument({ sunAngularRadius }));
    assert.equal('sunAngularRadius' in asset.lights, false);
    assert.ok(asset.warnings.some(warning => /sun size of "Sun"/.test(warning) && /0\.0005 to 0\.2/.test(warning)), asset.warnings.join('|'));
  }
});

test('an explicit shadowCascades option wins over the sun size from the GLB', async () => {
  const asset = await parseGltf(sunDocument({ sunAngularRadius: CLASSROOM_SUN_RADIUS }));
  assert.equal(resolveSceneFileCascades({ shadowCascades: 0 }, asset.lights, { extent: 85 }), undefined);
  assert.equal(resolveSceneFileCascades({ shadowCascades: 2 }, asset.lights, { extent: 85 }).count, 2);
});
