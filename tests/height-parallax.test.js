import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFragmentShader } from '../src/shaders.js';
import { referenceParallaxShift, HEIGHT_MAP_UNIT } from '../src/height-parallax-shader.js';
import { readdirSync, readFileSync } from 'node:fs';
import { SPLAT_UNITS } from '../src/shader-registry.js';
import { IRRADIANCE_GRID_TEXTURE_UNIT } from '../src/irradiance-grid.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';

await loadAllAgentSceneModules();

const HEIGHT_IMAGE = 'a'.repeat(64);
const GREY_FRAME = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(100) };

function sceneWith(material) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', heightMap: HEIGHT_IMAGE, ...material }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: new Map([[HEIGHT_IMAGE, GREY_FRAME]]) });
}

test('heightScale, heightFade and heightSteps are bounded and name what to pass', () => {
  assert.throws(() => sceneWith({ heightScale: 0.9 }), /heightScale/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightFade: 0 }), /heightFade/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightSteps: 2 }), /heightSteps/);
  assert.throws(() => sceneWith({ heightScale: 0.02, heightSteps: 8.5 }), /whole number/);
  const material = sceneWith({ heightScale: 0.02, heightFade: 12, heightSteps: 16 }).parts[0].material;
  assert.deepEqual([material.heightScale, material.heightFade, material.heightSteps], [0.02, 12, 16]);
});

test('the parallax fields need a heightMap', () => {
  assert.throws(() => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', heightScale: 0.02 }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }), /heightMap/);
});

test('a shader without the heightMap feature keeps its source, and the feature adds the march and the shifted UV', () => {
  const plain = createFragmentShader(['baseMap', 'normalMap']);
  assert.doesNotMatch(plain, /parallax|heightState/);
  const hash = createHash('sha256').update(plain).digest('hex');
  assert.equal(createHash('sha256').update(createFragmentShader(['baseMap', 'normalMap'])).digest('hex'), hash);
  const relief = createFragmentShader(['baseMap', 'normalMap', 'heightMap']);
  assert.match(relief, /textureGrad\(heightMap/);
  assert.match(relief, /textureUV \+ parallaxShift/);
  assert.match(relief, /dFdx\(frameCoordinates\)/);
});

test('the march lands on a flat floor at its depth, ignores a surface at the top and clamps at full depth', () => {
  const fullShift = [0.2, -0.1];
  const floorAtHalf = referenceParallaxShift(() => 0.5, fullShift, 16);
  assert.ok(Math.abs(floorAtHalf[0] + 0.1) < 1e-9 && Math.abs(floorAtHalf[1] - 0.05) < 1e-9, `a floor half way down shifts by half: ${floorAtHalf}`);
  assert.deepEqual(referenceParallaxShift(() => 1, fullShift, 16), [-0, 0], 'a surface at the top does not shift');
  const deepest = referenceParallaxShift(() => 0, fullShift, 16);
  assert.ok(Math.abs(deepest[0] + 0.2) < 1e-9 && Math.abs(deepest[1] - 0.1) < 1e-9, `a floor at full depth shifts by the full amount: ${deepest}`);
});

test('the march crosses a bump top between two steps at the interpolated depth', () => {
  const bump = offsetU => (offsetU < -0.05 ? 0.2 : 0.9);
  const shift = referenceParallaxShift(bump, [0.2, 0], 8);
  assert.ok(Math.abs(shift[0] + 0.02) < 1e-9, `the ray meets the top of the bump a tenth of the way down: ${shift[0]}`);
});

test('the program reads every UV set 0 map through the shifted UV, with no ternary the GPU compiler leaves unshifted', () => {
  const features = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'heightMap'];
  const relief = createFragmentShader(features);
  assert.doesNotMatch(relief, /BOX_MAPPED \?/);
  for (const [sampler, flag] of [['baseMap', 'hasBaseMap'], ['emissiveMap', 'hasEmissiveMap'], ['metallicRoughnessMap', 'hasMetallicRoughnessMap']]) {
    assert.ok(relief.includes(`mappedSample(${sampler}, ${flag})`), `${sampler} is read through mappedSample`);
  }
  assert.ok(relief.includes('mappedOrBoxNormal(normal)'));
  assert.match(relief, /if \(BOX_MAPPED\) return sampleBox\(source\);\n  return mapTexture\(source, flag\);/);
  assert.match(createFragmentShader(['baseMap', 'normalMap']), /BOX_MAPPED \? sampleBox\(baseMap\)/, 'a program without the feature keeps the ternary');
});

test('heightMap without heightScale is reported as ignored, and a heightScale above 0 clears the warning', () => {
  const ignored = scene => (scene.inspect().diagnostics ?? []).filter(problem => problem.kind === 'ignored-material-field');
  assert.equal(ignored(sceneWith({})).length, 1);
  assert.match(ignored(sceneWith({}))[0].message, /heightMap is ignored: heightScale/);
  assert.equal(ignored(sceneWith({ heightScale: 0.02 })).length, 0);
});

test('the relief reads each map at the shifted UV with the unshifted mip gradients, and keeps the tangent frame on the unshifted UV', () => {
  const relief = createFragmentShader(['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'heightMap']);
  assert.doesNotMatch(relief, /texture\(\w+, mapUV\(/, 'no map is read by a plain texture() at the shifted UV: its implicit gradient jumps with the shift and blurs the mip');
  assert.match(relief, /textureGrad\(normalMap, normalCoordinates, mapGradientX\(hasNormalMap\), mapGradientY\(hasNormalMap\)\)/);
  assert.doesNotMatch(relief, /dFdx\(normalCoordinates\)/, 'a normal frame built from the shifted UV bends the tangents where the shift jumps');
  assert.match(relief, /frameCoordinates = normalCoordinates - \(hasNormalMap > 1\.5 \? vec2\(0\.0\) : parallaxShift\);\n  vec2 uvX = dFdx\(frameCoordinates\);/);
});

test('the clearcoat normal frame of a relief program is rebuilt from the unshifted UV too', () => {
  const relief = createFragmentShader(['baseMap', 'normalMap', 'clearcoatNormalTexture', 'heightMap']);
  assert.match(relief, /vec3 coatMappedNormal/);
  assert.doesNotMatch(relief, /dFdx\(normalCoordinates\)/);
  assert.equal(relief.split('dFdx(frameCoordinates)').length - 1, 2, 'the main and the clearcoat frame');
});

test('the height map sampler has a unit of its own, past every other registered fragment sampler unit', () => {
  const units = new Map([['irradianceGrid', IRRADIANCE_GRID_TEXTURE_UNIT], ...Object.entries(SPLAT_UNITS)]);
  for (const [name, unit] of units) assert.notEqual(unit, HEIGHT_MAP_UNIT, `heightMap and ${name} would share unit ${unit}`);
  const declared = [];
  for (const entry of readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^(?:export )?const (\w+_UNIT) = (\d+);/gm)) declared.push([entry, match[1], Number(match[2])]);
  }
  assert.ok(declared.length > 10, 'the scan finds the unit constants');
  for (const [entry, name, unit] of declared.filter(([, name]) => name !== 'GAS_SIM_TEMPERATURE_UNIT')) {
    assert.ok(unit < HEIGHT_MAP_UNIT, `${name} (${entry}) is unit ${unit}; the height map unit ${HEIGHT_MAP_UNIT} must stay past it`);
  }
  assert.ok(HEIGHT_MAP_UNIT < 32, 'WebGL2 guarantees 32 combined texture units');
});

test('a high plateau on the eye side hides the pit edge: the ray of a pixel in the pit near the far wall lands in the wall', () => {
  // Texel 1 is the top, 0 is the deepest. The pit (height 0) lies at offsets 0.02 and above along u; the plateau (height 1) below it.
  const heightAt = offsetU => (offsetU > -0.0099 ? 0 : 1);
  const toward = referenceParallaxShift(heightAt, [0.2, 0], 16);
  assert.ok(toward[0] < 0, 'with the eye on the +u side the ray runs toward -u and the sample moves to -u: ' + toward[0]);
  assert.ok(Math.abs(toward[0]) < 0.2, 'a ray that meets the wall stops short of full depth');
  const away = referenceParallaxShift(heightAt, [-0.2, 0], 16);
  assert.ok(away[0] > 0 && Math.abs(away[0] - 0.2) < 1e-9, 'the other eye side sees the pit floor at full depth: ' + away[0]);
});

test('the binary refine puts the crossing within a sixteenth of a step of the true crossing, closer than the plain line', () => {
  // A curved surface whose depth along the ray is 0.2 + 0.8 d squared meets the ray at d = 0.25.
  const trueDepth = 0.25;
  const heightAt = offsetU => 1 - (0.2 + 0.8 * (offsetU / 0.2) ** 2);
  const steps = 3;
  const plain = referenceParallaxShift(heightAt, [0.2, 0], steps, 0);
  const refined = referenceParallaxShift(heightAt, [0.2, 0], steps, 4);
  const plainError = Math.abs(-plain[0] / 0.2 - trueDepth);
  const refinedError = Math.abs(-refined[0] / 0.2 - trueDepth);
  assert.ok(refinedError < (1 / steps) / 16, 'refined error ' + refinedError + ' plain ' + plainError);
  assert.ok(refinedError < plainError / 4, 'plain error ' + plainError + ', refined ' + refinedError);
});

test('a parallax field out of range is rejected with its range even when the material has no heightMap', () => {
  const withoutMap = fields => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', ...fields }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  });
  assert.throws(() => withoutMap({ heightScale: 0.9 }), /heightScale.*0\.5/s);
  assert.throws(() => withoutMap({ heightFade: 0 }), /heightFade.*0\.1.*1000/s);
  assert.throws(() => withoutMap({ heightSteps: 2 }), /heightSteps.*4.*32/s);
  assert.throws(() => withoutMap({ heightScale: 0.02 }), /heightMap/);
});
