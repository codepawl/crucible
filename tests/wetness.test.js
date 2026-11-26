import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { createFragmentShader, fragmentShader, HEIGHT_MAP_FEATURE, WETNESS_FEATURE, SHADER_FEATURES } from '../src/shaders.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { wetnessUniformValues, wetnessResponse, puddleShare, PUDDLE_SOURCES, PUDDLE_SHARE_CAP } from '../src/wetness.js';
import { puddleFillLevel, PUDDLE_LEVEL_TABLE, SOAKED_ROAD_ROUGHNESS_SCALE, WATER_BED_TRANSMITTANCE, WATER_SURFACE_ROUGHNESS } from '../src/wetness-shader.js';
import { groundMaskBounds, PUDDLE_CAVITY_FEATURE, PUDDLE_MASK_FEATURE, PUDDLE_MASK_UNIT, registerPuddleMask, rewriteWetnessPuddles } from '../src/wetness-puddles.js';
import { HEIGHT_MAP_UNIT, lightShapeSupport } from '../src/shader-registry.js';
import { wetnessKeepOutBoxes, wetnessGroundHeight, KEEP_OUT_LIMIT } from '../src/wetness-keep-out.js';
import { findWaterSurface, flagWetMirrorParts, wetMirrorSurface } from '../src/water-reflection.js';
import { wetStone } from './support/wetness-noise-port.mjs';
import * as waterReflectionModule from '../src/water-reflection.js';
import * as wetShader from '../src/wetness-shader.js';

function emptySession() {
  return createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
}

test('a dry look has no wetness fields and the lighting state stays dry', () => {
  const { environment } = normalizeAgentLook({ environment: {} });
  assert.equal('wetness' in environment, false);
  assert.equal('puddles' in environment, false);
  const state = updateLightingState(createLightingState(), environment);
  assert.equal(state.wetness, 0);
  assert.deepEqual([...state.wetnessState], [0, 0, 0, 0]);
});

test('wetness and puddles are bounded, and puddles fill in their defaults', () => {
  const { environment } = normalizeAgentLook({ environment: { wetness: 0.5, puddles: {} } });
  assert.equal(environment.wetness, 0.5);
  assert.deepEqual({ ...environment.puddles }, { coverage: 0.5, from: 'height' });
  for (const wetness of [-0.1, 1.1, 'wet']) {
    assert.throws(() => normalizeAgentLook({ environment: { wetness } }), /environment\.wetness/);
  }
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { coverage: 2 } } }), /puddles\.coverage/);
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { depth: 1 } } }), /puddles\.depth/);
  assert.throws(() => normalizeAgentLook({ environment: { puddles: 'many' } }), /environment\.puddles/);
});

const MASK_ASSET_ID = 'b'.repeat(64);

test('puddle sources validate height, cavity, and mask with strict input checks', () => {
  assert.deepEqual(PUDDLE_SOURCES, ['height', 'cavity', 'mask']);
  assert.equal(normalizeAgentLook({ environment: { puddles: { from: 'cavity' } } }).environment.puddles.from, 'cavity');
  const normalizedMask = normalizeAgentLook({ environment: { puddles: { coverage: 0.7, from: 'mask', mask: MASK_ASSET_ID.toUpperCase() } } }).environment.puddles;
  assert.deepEqual({ ...normalizedMask }, { coverage: 0.7, from: 'mask', mask: MASK_ASSET_ID });
  for (const from of ['noise', 'slope', 42]) {
    assert.throws(() => normalizeAgentLook({ environment: { puddles: { from } } }), /puddles\.from.*height.*cavity.*mask/);
  }
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { from: 'mask' } } }), /puddles\.mask.*64 hexadecimal/);
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { from: 'mask', mask: 'https://example.com/puddles.png' } } }), /puddles\.mask.*no URLs/);
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { from: 'height', mask: MASK_ASSET_ID } } }), /puddles\.mask.*not "mask"/);
  assert.throws(() => normalizeAgentLook({ environment: { puddles: { from: 'cavity', mask: MASK_ASSET_ID } } }), /puddles\.mask.*not "mask"/);
});

test('the puddle share is a quarter of the ground at most, and grows with wetness and coverage', () => {
  assert.equal(PUDDLE_SHARE_CAP, 0.25);
  assert.equal(puddleShare(1, 1), 0.25);
  assert.equal(puddleShare(0.5, 0.5), 0.25 * 0.5 * 0.25);
  assert.equal(puddleShare(0, 1), 0);
  assert.deepEqual(wetnessUniformValues({ puddles: { coverage: 0.8 } }), [0, 0, 0, 0]);
  assert.deepEqual(wetnessUniformValues({ wetness: 1, puddles: { coverage: 0 } }), [1, 0, 0, 0]);
  const state = updateLightingState(createLightingState(), { wetness: 0.5, puddles: { coverage: 0.8 } });
  assert.equal(state.wetness, 0.75);
  assert.ok(Math.abs(state.wetnessState[1] - puddleFillLevel(puddleShare(0.5, 0.8))) < 1e-6);
});

test('the wetness curve is visible by the middle of the range and keeps its ends', () => {
  assert.equal(wetnessResponse(0), 0);
  assert.equal(wetnessResponse(1), 1);
  assert.equal(wetnessResponse(0.5), 0.75);
  assert.ok(wetnessResponse(0.1) > 0.15);
});

test('the wetness code joins the fragment shader only when the feature is on', () => {
  const dry = createFragmentShader(SHADER_FEATURES);
  assert.equal(dry, fragmentShader);
  assert.equal(dry.includes('wetnessState'), false);
  const wet = createFragmentShader([...SHADER_FEATURES, WETNESS_FEATURE]);
  assert.match(wet, /uniform vec4 wetnessState;/);
  assert.match(wet, /float wetBasin\(/);
  assert.match(wet, /\(1\.0 - metallic\)/);
});

test('set-environment sets wetness and puddles and null clears them', () => {
  const session = emptySession();
  session.apply([{ type: 'set-environment', environment: { wetness: 1, puddles: { coverage: 0.6 } } }], { expectedRevision: session.revision });
  let recipe = session.exportRecipe();
  assert.equal(recipe.environment.wetness, 1);
  assert.equal(recipe.environment.puddles.coverage, 0.6);
  session.apply([{ type: 'set-environment', environment: { wetness: null, puddles: null } }], { expectedRevision: session.revision });
  recipe = session.exportRecipe();
  assert.equal(Object.hasOwn(recipe.environment, 'wetness'), false);
  assert.equal(Object.hasOwn(recipe.environment, 'puddles'), false);
});

test('scene_capabilities names the wetness topic with the sources the validator accepts', () => {
  const topic = AGENT_SCENE_CAPABILITIES.wetness;
  assert.deepEqual(topic.environment, ['environment.wetness', 'environment.puddles']);
  assert.deepEqual([...topic.puddles.from], PUDDLE_SOURCES);
  assert.match(topic.renderers, /path tracers ignore it/);
});

function partWithFootprint(minimumX, minimumZ, maximumX, maximumZ, matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) {
  const positions = new Float32Array([minimumX, 0, minimumZ, maximumX, 0.01, maximumZ]);
  return { geometry: { positions }, matrix };
}

test('keep-out boxes list thin parts at their world footprint and skip wide ones', () => {
  const marking = partWithFootprint(-0.1, -5, 0.1, 5, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 2, 1]);
  const road = partWithFootprint(-10, -20, 10, 20);
  const { boxes, count } = wetnessKeepOutBoxes([road, marking]);
  assert.equal(count, 1);
  assert.deepEqual([...boxes.slice(0, 4)].map((value) => Math.round(value * 100) / 100), [2.9, -3, 3.1, 7]);
});

test('keep-out boxes stop at the shader limit and ignore parts that deform', () => {
  const posts = Array.from({ length: KEEP_OUT_LIMIT + 5 }, (_, index) => partWithFootprint(index, 0, index + 0.2, 0.2));
  assert.equal(wetnessKeepOutBoxes(posts).count, KEEP_OUT_LIMIT);
  const skinned = { ...partWithFootprint(0, 0, 0.1, 0.1), skin: {} };
  assert.equal(wetnessKeepOutBoxes([skinned]).count, 0);
});

test('the wet shader fades puddles out near keep-out boxes', () => {
  const wet = createFragmentShader(new Set([...SHADER_FEATURES, WETNESS_FEATURE]));
  assert.match(wet, /wetnessKeepOut\[24\]/);
  assert.match(wet, /clearance = wetKeepOutDistance[(]worldPosition[)]/);
});

function groundPart(minimumX, minimumZ, maximumX, maximumZ, roughness = 0.95, metallic = 0) {
  const positions = new Float32Array([minimumX, -0.1, minimumZ, maximumX, 0, maximumZ]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return { geometry: { positions }, matrix: identity, material: { roughness, metallic } };
}

test('wet mirror mode takes a rough flat ground part that a dry scene would leave out', () => {
  const road = groundPart(-10, -20, 10, 20);
  assert.equal(findWaterSurface([road]), null);
  assert.equal(findWaterSurface([road], { wet: true }).height, 0);
});

test('wet mirror mode skips metal and flags the ground so the renderer can mirror it', () => {
  const metalSheet = groundPart(-10, -20, 10, 20, 0.2, 1);
  assert.equal(findWaterSurface([metalSheet], { wet: true }), null);
  const road = groundPart(-10, -20, 10, 20);
  const [flagged] = flagWetMirrorParts([road]);
  assert.equal(flagged.material.waterReflection, true);
  assert.equal(wetMirrorSurface([flagged]).height, 0);
  assert.equal(wetMirrorSurface([road]), null);
});

function wetShaderSource() {
  return createFragmentShader(new Set([...SHADER_FEATURES, WETNESS_FEATURE]));
}

test('the fill level falls as the share grows, through the measured table', () => {
  const levels = [0, 0.005, 0.01, 0.02, 0.03, 0.0625, 0.1, 0.125, 0.2, 0.25].map(puddleFillLevel);
  for (let index = 1; index < levels.length; index++) assert.ok(levels[index] < levels[index - 1], `level ${index} falls`);
  for (const [share, level] of PUDDLE_LEVEL_TABLE) assert.ok(Math.abs(puddleFillLevel(share) - level) < 1e-9);
  assert.equal(puddleFillLevel(1), puddleFillLevel(0.25));
});

function raisedGround(height) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, height, 0, 1];
  return { geometry: { positions: new Float32Array([-10, -0.1, -20, 10, 0, 20]) }, matrix: identity, material: { roughness: 0.95, metallic: 0 } };
}

test('the ground height is the top of the widest part, so a raised or sunk road is measured from itself', () => {
  assert.equal(wetnessGroundHeight([]), 0);
  for (const height of [3, -2, 0]) {
    const marking = partWithFootprint(-0.1, -5, 0.1, 5, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, height + 50, 0, 1]);
    assert.ok(Math.abs(wetnessGroundHeight([marking, raisedGround(height)]) - height) < 1e-6);
  }
});

test('the shader measures the water depth from the ground height, not from world y', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('6.0 * (worldPosition.y - wetnessState.w)'));
  assert.equal(wet.includes('6.0 * worldPosition.y'), false);
});

test('only standing water mirrors: the road is set rough after the lighting and the water smooth', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes(`roughness = mix(0.5, ${WATER_SURFACE_ROUGHNESS.toFixed(2)}, smoothstep(${wetShader.WATER_RIM_MIRROR_START}, 1.0, wetStanding));`), 'the mirror fades in over the anti-aliased edge');
  assert.ok(wet.includes(`roughness * ${SOAKED_ROAD_ROUGHNESS_SCALE.toFixed(2)}`));
  assert.ok(WATER_SURFACE_ROUGHNESS < 0.1 && SOAKED_ROAD_ROUGHNESS_SCALE > 0.5, 'water is a mirror, soaked road is satin');
});

test('the water edge is narrow and pixel-wide, and the interior is flat and smooth', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('standing = smoothstep(-edgeWidth, edgeWidth, stoneDepth) * gate'));
  assert.ok(wet.includes(`float edgeWidth = max(2.0 * fwidth(puddleDepth), ${wetShader.WET_SHORE_MINIMUM_SOFTNESS});`), 'the shore is anti-aliased over two pixels of the smooth basin and never thinner than the minimum softness, so stones cannot cut it into single pixels');
  assert.ok(Number(wetShader.WET_SHORE_MINIMUM_SOFTNESS) >= 0.002, 'the minimum softness is a few millimetres of ground');
  assert.ok(wet.includes('normal = normalize(mix(normal, normalize(vec3(wetRipple.x, 1.0, wetRipple.y)), standing));'));
  assert.ok(wet.includes('float gate = smoothstep(0.996, 0.9995, geometricNormal.y)'));
});

test('grain and fine detail fade with the pixel footprint so the horizon does not speckle', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('float pixelSize = sqrt(length(dFdx(worldPosition)) * length(dFdy(worldPosition)));'));
  assert.ok(wet.includes('float wallGrainFade = 1.0 - smoothstep(0.006, 0.03, pixelSize);'), 'walls keep the grain fade they had');
  assert.match(wet, /wetBasin[(]worldPosition, detailFade[)]/);
});

test('the water ripple is a faint slow tilt that moves with time and stays well under the mirror blur', () => {
  const wet = wetShaderSource();
  const ripple = wet.match(/vec2 wetRipple = [\s\S]*?\) \* ([0-9.]+);/);
  assert.ok(ripple, 'the water normal carries a ripple');
  assert.ok(Number(ripple[1]) <= 0.006, 'a ripple of a fifth of a degree or less keeps the reflection sharp');
  assert.ok(ripple[0].includes('time *'), 'the ripple moves with the frame time and so is the same for the same time');
});

test('the soak band only darkens the road, so no bright ring of sky glints sits around a puddle', () => {
  const wet = wetShaderSource();
  assert.equal(wet.includes('roughness * 0.75'), false, 'a smoother soak band lit a halo of glints around the water');
  assert.ok(wet.includes(`color *= (1.0 - ${wetShader.WET_SOAK_BAND_DARKENING} * soakBand) * (1.0 - ${wetShader.WET_FRINGE_DARKENING} * shoreDarkening * ${wetShader.WET_SHORE_BAND_STONE_SHARE});`));
});

// The fringe is the damp band just outside the water. A damp band is darker than the dry road beside it, never a bright outline.
function fringeColourMultiplier(depthOutsideRim, stoneHeight) {
  const smooth = (low, high, value) => {
    const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const stoneDepth = depthOutsideRim - Number(wetShader.WET_SHORE_STONE_BREAK) * (stoneHeight - 0.5);
  const fringe = smooth(-Number(wetShader.WET_SHORE_BAND_REACH), 0, stoneDepth) ** 1.5;
  return (1 - Number(wetShader.WET_FRINGE_DARKENING) * fringe * Number(wetShader.WET_SHORE_BAND_STONE_SHARE));
}

test('the damp fringe is darker than the road beside it and never brighter, and reaches only a few centimetres out', () => {
  assert.ok(Number(wetShader.WET_FRINGE_DARKENING) > 0 && Number(wetShader.WET_FRINGE_DARKENING) <= 0.15, 'the fringe darkening is a named, small constant (round 17: 0.45 drew an ink outline)');
  assert.ok(Number(wetShader.WET_FRINGE_WIDTH) > 0 && Number(wetShader.WET_FRINGE_WIDTH) <= 0.03, 'the dark band is a few centimetres wide (about 3 cm per 0.01 of depth)');
  for (let stoneHeight = 0; stoneHeight <= 1; stoneHeight += 0.1) {
    for (let depth = -0.2; depth <= 0; depth += 0.002) {
      assert.ok(fringeColourMultiplier(depth, stoneHeight) <= 1, 'the fringe never brightens the road');
    }
  }
  // Mean luminance of the band 3 to 6 cm outside the rim (depth -0.01 to -0.02) over the road 20 cm away (depth -0.067, beyond the band).
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const bandSamples = [];
  for (let stoneHeight = 0.2; stoneHeight <= 0.8; stoneHeight += 0.1) {
    for (let depth = -0.015; depth <= -0.005; depth += 0.001) bandSamples.push(fringeColourMultiplier(depth, stoneHeight));
  }
  assert.ok(mean(bandSamples) <= 0.99 * fringeColourMultiplier(-0.067, 0.5), 'the band 1.5 to 4.5 cm out is darker than the road 20 cm out');
  assert.equal(fringeColourMultiplier(-0.067, 0.5), 1, 'the road 20 cm out is untouched by the fringe');
});

test('the grazing glints in the damp band are sparse: only the tallest stone tops, and only at a grazing view', () => {
  const wet = wetShaderSource();
  const [low, high] = wetShader.WET_FRINGE_GLINT_STONE.map(Number);
  assert.ok(low >= 0.65 && high > low && high <= 0.95, 'glint stones are the top of the height range');
  assert.ok(wet.includes('smoothstep(0.55, 0.2, dot(geometricNormal, viewDirection))'), 'a glint needs a grazing view');
  assert.ok(wet.includes(`roughness = mix(roughness, 0.26, fringeGlint * ${wetShader.WET_FRINGE_GLINT_STRENGTH});`), 'a glint is satin, never a mirror');
});

test('the wet grit eases in from the first drop of wetness and never touches a dry road', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('if (!TAG_WATER && !TAG_FIRE && !TAG_SMOKE && wetnessState.x > 0.0) {'), 'a dry road never enters the wet code');
  assert.ok(wet.includes('float wetGrit = wetnessState.x * sqrt(wetnessState.x);'));
  const gritAt = wetness => wetnessResponse(wetness) ** 1.5;
  assert.equal(gritAt(0), 0);
  assert.ok(gritAt(0.05) > 0.02 && gritAt(0.05) < gritAt(0.25) && gritAt(0.25) < gritAt(0.5) && gritAt(1) === 1);
});

test('the road stones are a mix of sizes on rotated lattices, mostly small, and lose their finest octave first', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('float wetStone(vec3 position, vec3 fades) {'));
  assert.ok(wet.includes('vec3 stoneFades = 1.0 - vec3(smoothstep(0.009, 0.03, pixelSize), smoothstep(0.0055, 0.016, pixelSize), smoothstep(0.0018, 0.0049, pixelSize));'));
  const heights = [];
  for (let x = 0; x < 3; x += 0.01) {
    for (let z = 0; z < 3; z += 0.01) heights.push(wetStone(x, 0, z));
  }
  const mean = heights.reduce((sum, value) => sum + value, 0) / heights.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, 'the height is centred on 0.5');
  let neighbourStep = 0;
  let spread = 0;
  for (let index = 1; index < heights.length; index++) {
    neighbourStep += Math.abs(heights[index] - heights[index - 1]);
    spread += Math.abs(heights[index] - mean);
  }
  assert.ok(neighbourStep / spread > 0.04, 'the smallest stones dominate the change from one centimetre to the next');
});

test('the grit tilt fades at a grazing view, so the glare patch does not glitter', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('float grazingShare = smoothstep(0.06, 0.4, dot(geometricNormal, viewDirection));'));
  assert.ok(wet.includes('* mix(0.15, 1.0, grazingShare);'), 'the stone tilt shrinks toward a grazing view');
  assert.ok(wet.includes('roughness = sqrt(roughness * roughness + 0.045 * (1.0 - grazingShare)'), 'the lost slope variance widens the highlight');
});

test('the wet darkening varies in patches on the ground only, and fades where a pixel is wider than a patch', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('wetPatch *= (1.0 - smoothstep(0.05, 0.2, pixelSize)) * wetGroundFacing;'));
  assert.ok(wet.includes('color *= 1.0 - 0.6 * patchyPorosity;'));
  assert.ok(wet.includes('float patchyPorosity = clamp(wetPorosity * (1.0 + 0.9 * wetPatch), 0.0, 1.0);'));
});

test('the bed under standing water keeps the wet road light: no second darkening, no ambient shading (round 14 path-trace check)', () => {
  // A CPU path trace of the same puddle (water IOR 1.33 over wet asphalt) is about 3 times brighter than the round 13 shader, which darkened
  // the bed to 0.35 and shaded its ambient light by 0.3 on top of the wet-road darkening; the bed now loses at most a tenth.
  assert.ok(WATER_BED_TRANSMITTANCE.shore === 1 && WATER_BED_TRANSMITTANCE.deep >= 0.85, 'a clear film of water absorbs under 15 percent of the light');
  const wet = wetShaderSource();
  assert.ok(wet.includes(`color *= mix(1.0, mix(${WATER_BED_TRANSMITTANCE.shore.toFixed(2)}, ${WATER_BED_TRANSMITTANCE.deep.toFixed(2)}, interior), standing);`));
  assert.ok(wet.includes('splatCavity *= 1.0 - 0.4 * wetPorosity * (1.0 - standing);'), 'water takes no part in the porous road shading');
  assert.equal(wet.includes('splatCavity *= 1.0 - 0.7 * standing'), false);
});

test('wet ground keeps the light the water surface does not reflect: bed share is one minus Fresnel (round 15)', () => {
  const { waterBedShare, waterFresnelReflectance } = waterReflectionModule;
  assert.equal(typeof waterBedShare, 'function', 'water-reflection.js exports the bed share');
  for (const viewCosine of [0.05, 0.25, 0.447, 0.8, 1]) {
    assert.ok(Math.abs(waterBedShare(viewCosine) + waterFresnelReflectance(viewCosine) - 1) < 1e-12, 'reflected plus transmitted is all the light');
  }
  assert.ok(waterBedShare(0.447) > 0.92 && waterBedShare(0.447) < 0.94, 'the 1.6 m eye over a puddle 3.2 m away loses about 7 percent to the mirror');
  assert.ok(waterBedShare(0.05) < 0.6, 'at a grazing angle the mirror takes over from the bed');
  assert.ok(waterBedShare(1) > 0.97, 'looking straight down the bed is nearly all there is');
  const source = createFragmentShader(['studioLighting', 'waterReflection']);
  assert.ok(source.includes('* (1.0 - fresnelWeight * waterBedFresnelShare)'), 'the bed is weighted by what Fresnel leaves');
  assert.ok(source.includes('float waterBedFresnelShare = 0.0;'), 'a lake sets no bed share, so it keeps its look');
});

test('standing water hides the bed grit and the road tint, and the shore keeps no sky highlight (round 15 path-trace check)', () => {
  const { WATER_BED_GRIT_VISIBLE, WATER_BED_COLOUR_KEPT, WET_EDGE_STRIP_FROM, WET_EDGE_STRIP_TO } = wetShader;
  assert.ok(WATER_BED_GRIT_VISIBLE <= 0.25, 'under a film of water at most a quarter of the grit contrast shows');
  assert.ok(WATER_BED_COLOUR_KEPT <= 0.35, 'the olive of the scanned asphalt is mostly gone under water');
  assert.ok(Number(WET_EDGE_STRIP_FROM) < Number(WET_EDGE_STRIP_TO), 'the edge loses its sky highlight over a range');
  assert.ok(Number(WET_EDGE_STRIP_FROM) >= Number(wetShader.WATER_RIM_MIRROR_START), 'the sky highlight is never taken off before the mirror starts to replace it (round 17: stripping from 0.05 while the mirror began at 0.6 left a 10 px dark ring)');
  const wet = wetShaderSource();
  assert.ok(wet.includes('mix(1.0, 1.2, wetPorosity * gritGround * (1.0 - standing))'), 'no extra saturation under water');
  assert.ok(wet.includes('waterEdgeCover = wetGroundFacing > 0.5'));
  assert.ok(createFragmentShader(['studioLighting', 'waterReflection']).includes('skyLight * max(mirrorWeight, waterEdgeCover)'));
});

test('the shore is a smooth anti-aliased edge: stones move it by less than its width, the band takes no per-pixel stone term (round 16)', () => {
  const { WET_SHORE_MINIMUM_SOFTNESS, WET_SHORE_STONE_BREAK, WET_SHORE_BAND_STONE_SHARE, WET_FRINGE_GLINT_STRENGTH, WET_FRINGE_WIDTH, WET_BED_FLATTEN_SHARE } = wetShader;
  assert.ok(Number(WET_SHORE_STONE_BREAK) <= Number(WET_SHORE_MINIMUM_SOFTNESS), 'a stone moves the shore by at most one anti-aliased edge width, so it cannot cut single pixels out of the rim');
  assert.ok(Number(WET_SHORE_MINIMUM_SOFTNESS) >= 0.005, 'the edge is at least about 15 mm of ground wide');
  assert.ok(Number(WET_SHORE_STONE_BREAK) < Number(WET_FRINGE_WIDTH) / 1.5, 'the stones are narrower than the damp band they would stipple');
  assert.ok(Number(WET_FRINGE_GLINT_STRENGTH) <= 0.2, 'the damp band glints only faintly, so no light outline sits around a far puddle');
  assert.ok(Number(WET_SHORE_BAND_STONE_SHARE) > 0 && Number(WET_SHORE_BAND_STONE_SHARE) <= 1);
  assert.ok(Number(WET_BED_FLATTEN_SHARE[1]) <= 0.6, 'the bed grit is flat once half the pixel is water');
  const wet = wetShaderSource();
  assert.equal(wet.includes('shoreDarkening * (1.0 - 0.5 * stoneTop)'), false, 'a per-pixel stone term stippled the dark band');
  assert.ok(wet.includes('float bedFlatten = smoothstep('), 'the bed flattens over the shore, not linearly with the water share');
  // The band darkening across a shore pixel may not jump between neighbouring stones: sweep stone heights over the same depth.
  for (const depth of [-0.012, -0.006, -0.002, 0, 0.002, 0.006]) {
    const lowStone = fringeColourMultiplier(depth, 0.1);
    const highStone = fringeColourMultiplier(depth, 0.9);
    assert.ok(Math.abs(lowStone - highStone) < 0.15, 'two stones at the same depth differ by under 15 percent of the light (' + depth + ': ' + lowStone + ' against ' + highStone + ')');
  }
});

test('the wet shore darkens the road gradually and is never an ink outline darker than both road and water (round 17)', () => {
  const road = depth => roadMultiplier(depth);
  const darkest = Math.min(...[-0.1, -0.06, -0.03, -0.015, -0.008, -0.004, -0.001, 0].map(road));
  assert.ok(darkest >= 0.85, 'the wet edge takes at most 15 percent off the road at the shore (was 38 percent plus 15 percent: ' + darkest + ')');
  assert.ok(Number(wetShader.WET_SHORE_BAND_REACH) >= 0.02, 'the darkening eases in over several centimetres, not a thin line');
  assert.ok(Number(wetShader.WET_SHORE_BAND_HOLD) === 0, 'the band is gone across the anti-aliased edge, so it never rings the bed');
  const step = road;
  for (const [outer, inner] of [[-0.03, -0.015], [-0.015, -0.006], [-0.006, 0]]) {
    assert.ok(step(inner) <= step(outer) + 1e-9, 'darkening only grows toward the water (' + outer + ' to ' + inner + ')');
  }
});

// What the shader applies to the road beside the water: the broad soak band and the eased shore band (the damp halo is declared inside its block and does not reach the colour).
function roadMultiplier(depth) {
  const shore = smoothStepDepth(-Number(wetShader.WET_SHORE_BAND_REACH), 0, depth) ** 1.5;
  return (1 - Number(wetShader.WET_SOAK_BAND_DARKENING) * smoothStepDepth(-0.1, 0, depth)) * (1 - Number(wetShader.WET_FRINGE_DARKENING) * shore * Number(wetShader.WET_SHORE_BAND_STONE_SHARE));
}

function smoothStepDepth(low, high, value) {
  const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
}

test('the basin detail fades on the longest pixel footprint axis, so far grazing puddles do not get a stair-stepped outline (round 18)', () => {
  const wet = wetShaderSource();
  assert.ok(wet.includes('max(length(dFdx(worldPosition)), length(dFdy(worldPosition)))'), 'the detail fade reads the longer footprint axis');
  assert.equal(wet.includes('dampHalo'), false, 'the damp halo was declared twice and never reached the colour: it is gone');
  const [fadeStart, fadeEnd] = wetShader.WET_DETAIL_FADE.map(Number);
  assert.ok(fadeEnd <= 0.0833, 'the detail (period about 17 cm) is gone before a footprint reaches half its period (' + fadeEnd + ')');
  assert.ok(fadeStart < fadeEnd);
});

test('cavity and mask puddle sources load on demand, collect mask IDs, and activate extra shader features only when wet', () => {
  assert.equal(agentSceneModulesNeeded({ environment: { wetness: 1, puddles: { from: 'height' } } }).includes('wetnessPuddles'), false);
  assert.equal(agentSceneModulesNeeded({ environment: { wetness: 1, puddles: { from: 'cavity' } } }).includes('wetnessPuddles'), true);
  assert.equal(agentSceneModulesNeeded({ environment: { wetness: 1, puddles: { from: 'mask', mask: MASK_ASSET_ID } } }).includes('wetnessPuddles'), true);
  assert.deepEqual(sequenceFrameIds({ environment: { wetness: 1, puddles: { from: 'mask', mask: MASK_ASSET_ID.toUpperCase() } } }), [MASK_ASSET_ID]);

  const dryCavity = updateLightingState(createLightingState(), { wetness: 0, puddles: { from: 'cavity' } });
  assert.equal(dryCavity.wetness, 0);
  assert.deepEqual(dryCavity.extraFeatures ?? [], []);

  const wetHeight = updateLightingState(createLightingState(), { wetness: 1, puddles: { from: 'height', coverage: 0.5 } });
  assert.deepEqual(wetHeight.extraFeatures ?? [], []);

  const wetCavity = updateLightingState(createLightingState(), { wetness: 1, puddles: { from: 'cavity', coverage: 0.5 } });
  assert.ok(wetCavity.extraFeatures.includes(PUDDLE_CAVITY_FEATURE));

  const wetMask = updateLightingState(createLightingState(), { wetness: 1, puddles: { from: 'mask', coverage: 1, mask: MASK_ASSET_ID } });
  assert.ok(wetMask.extraFeatures.includes(PUDDLE_MASK_FEATURE));
  assert.ok(Math.abs(wetMask.wetnessState[1] - 0.15) < 1e-6);

  const zeroMask = updateLightingState(createLightingState(), { wetness: 1, puddles: { from: 'mask', coverage: 0, mask: MASK_ASSET_ID } });
  assert.equal(zeroMask.wetnessState[1], 0);
  assert.equal((zeroMask.extraFeatures ?? []).includes(PUDDLE_MASK_FEATURE), false);
});

test('cavity shader reads occlusionMap when present, falls back to crevices otherwise, and preserves height-mode GLSL when inactive', () => {
  const heightOnly = createFragmentShader([...SHADER_FEATURES, WETNESS_FEATURE]);
  assert.equal(rewriteWetnessPuddles(heightOnly), heightOnly);
  assert.equal(heightOnly.includes('puddleSource'), false);

  const cavityShader = rewriteWetnessPuddles(createFragmentShader([...SHADER_FEATURES, WETNESS_FEATURE, PUDDLE_CAVITY_FEATURE]));
  assert.match(cavityShader, /uniform float puddleSource;/);
  assert.match(cavityShader, /if \(USES_OCCLUSION_MAP\)/);
  assert.match(cavityShader, /texture\(occlusionMap, mapUV\(hasOcclusionMap\)\)/);
  assert.match(cavityShader, /stoneCrevice = smoothstep\(0\.62, 0\.25, stoneHeight\)/);
  assert.match(cavityShader, /splatCrevice = smoothstep\(0\.95, 0\.60, splatCavity\)/);
  assert.match(cavityShader, /skyCrevice = smoothstep\(0\.95, 0\.55, vertexSkyVisibility\)/);

  const parallaxCavity = rewriteWetnessPuddles(createFragmentShader([...SHADER_FEATURES, HEIGHT_MAP_FEATURE, WETNESS_FEATURE, PUDDLE_CAVITY_FEATURE]));
  assert.match(parallaxCavity, /mappedSample\(occlusionMap, hasOcclusionMap\)\.r/);
});

test('mask shader declares sampler and bounds on its own texture unit and combines cleanly with cavity', () => {
  assert.ok(PUDDLE_MASK_UNIT > HEIGHT_MAP_UNIT && PUDDLE_MASK_UNIT < 32);
  const maskShader = rewriteWetnessPuddles(createFragmentShader([...SHADER_FEATURES, WETNESS_FEATURE, PUDDLE_MASK_FEATURE]));
  assert.match(maskShader, /uniform sampler2D puddleMask;/);
  assert.match(maskShader, /uniform vec4 puddleMaskBounds;/);
  assert.match(maskShader, /texture\(puddleMask, maskUv\)\.r/);
  assert.match(maskShader, /float edgeWidth = clamp\(2\.0 \* fwidth\(puddleDepth\), 0\.006, puddleEdgeCap\)/);

  const combined = rewriteWetnessPuddles(createFragmentShader([...SHADER_FEATURES, WETNESS_FEATURE, PUDDLE_CAVITY_FEATURE, PUDDLE_MASK_FEATURE]));
  assert.match(combined, /if \(puddleSource > 1\.5\)/);
  assert.match(combined, /else if \(puddleSource > 0\.5\)/);
  assert.match(combined, /puddleSignal = wetBasin\(worldPosition, detailFade\)/);
});

test('groundMaskBounds maps flat ground XZ footprint while ignoring tall props and handles missing masks cleanly', () => {
  assert.deepEqual(groundMaskBounds([]), [-1, -1, 1, 1]);
  const road = groundPart(-10, -20, 10, 20);
  const kerb = groundPart(10, -20, 12, 20);
  const tower = { geometry: { positions: new Float32Array([-2, 0, -2, 2, 15, 2]) }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 30, 1], material: { roughness: 0.5, metallic: 0 } };
  assert.deepEqual(groundMaskBounds([road, kerb, tower]), [-10, -20, 12, 20]);

  const missingId = 'c'.repeat(64);
  const state = updateLightingState(createLightingState(), { wetness: 1, puddles: { from: 'mask', coverage: 0.8, mask: missingId } });
  const fakeRenderer = {
    shaderFeatures: new Set([WETNESS_FEATURE, PUDDLE_MASK_FEATURE]),
    program: {},
    fitParts: [road],
    whiteTexture: {},
    context: {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      getUniformLocation: (_program, name) => ({ name }),
      uniform1f() {},
      uniform1i() {},
      uniform4f() {},
      activeTexture() {},
      bindTexture() {},
    },
    createTexture(descriptor) { return descriptor; },
  };
  assert.throws(() => state.bind(fakeRenderer), /environment\.puddles\.mask.*was not loaded/);

  const maskData = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'road', type: 'box' }],
    materials: [{ id: 'asphalt', roughness: 0.9 }],
    nodes: [{ id: 'road', geometry: 'road', material: 'asphalt', scale: [20, 0.2, 40] }],
    environment: { wetness: 1, puddles: { coverage: 0.75, from: 'mask', mask: MASK_ASSET_ID } },
  }, {}, { sequenceFrames: new Map([[MASK_ASSET_ID, { width: 2, height: 2, data: maskData }]]) });
  assert.equal(scene.exportRecipe().environment.puddles.mask, MASK_ASSET_ID);
  assert.equal(scene.parts[0].material.waterReflection, true);

  const bound = [];
  fakeRenderer.context.uniform1f = (location, value) => bound.push([location.name, value]);
  fakeRenderer.context.uniform4f = (location, ...values) => bound.push([location.name, ...values]);
  fakeRenderer.context.bindTexture = (_target, texture) => bound.push(['texture', texture]);
  registerPuddleMask(MASK_ASSET_ID, { width: 2, height: 2, data: maskData });
  const maskState = updateLightingState(createLightingState(), scene.environment);
  maskState.bind(fakeRenderer);
  assert.ok(bound.some(([name, value]) => name === 'puddleSource' && value === 2));
  assert.ok(bound.some(([name, minX, minZ, maxX, maxZ]) => name === 'puddleMaskBounds' && minX === -10 && minZ === -20 && maxX === 10 && maxZ === 20));
  assert.ok(bound.some(([name, value]) => name === 'texture' && value?.colorSpace === 'linear'));
});

test('lightShapeSupport.update wrapper composes light shapes and puddle sources in any assignment order', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(lightShapeSupport, 'update');
  assert.equal(descriptor?.configurable, true);
  assert.equal(descriptor?.enumerable, true);

  const areaEnvironment = {
    wetness: 1,
    puddles: { from: 'cavity', coverage: 0.6 },
    areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 2, width: 1, height: 1, castShadow: true }],
  };
  const combinedState = updateLightingState(createLightingState(), areaEnvironment);
  assert.ok(combinedState.extraFeatures?.includes('areaShadows'));
  assert.ok(combinedState.extraFeatures?.includes(PUDDLE_CAVITY_FEATURE));

  const wrapper = lightShapeSupport.update;
  const seenCalls = [];
  try {
    // Setting lightShapeSupport.update after wetness-puddles loads (simulating late light-shapes import) keeps both hooks active.
    lightShapeSupport.update = (state, spotLights, areaLights) => {
      seenCalls.push({ spotCount: spotLights.length, areaCount: areaLights.length });
      state.extraFeatures = ['lateCustomFeature'];
    };
    assert.equal(lightShapeSupport.update, wrapper);
    const lateState = updateLightingState(createLightingState(), {
      wetness: 1,
      puddles: { from: 'cavity', coverage: 0.5 },
      spotLights: [{ position: [1, 3, 1], direction: [0, -1, 0], color: [1, 1, 1], intensity: 3 }],
    });
    assert.deepEqual(seenCalls, [{ spotCount: 1, areaCount: 0 }]);
    assert.deepEqual(lateState.extraFeatures, ['lateCustomFeature', PUDDLE_CAVITY_FEATURE]);

    // Clearing the base updater (standalone wetness-puddles without light-shapes) resets extraFeatures cleanly on dry frames.
    lightShapeSupport.update = undefined;
    const wetThenDry = createLightingState();
    wetThenDry.extraFeatures = ['staleFeature'];
    updateLightingState(wetThenDry, { wetness: 0 });
    assert.equal(wetThenDry.extraFeatures, undefined);
    updateLightingState(wetThenDry, { wetness: 1, puddles: { from: 'cavity', coverage: 0.5 } });
    assert.deepEqual(wetThenDry.extraFeatures, [PUDDLE_CAVITY_FEATURE]);
  } finally {
    await import('../src/light-shapes.js?restore=1');
  }

  const afterLateImport = updateLightingState(createLightingState(), areaEnvironment);
  assert.ok(afterLateImport.extraFeatures?.includes('areaShadows'));
  assert.ok(afterLateImport.extraFeatures?.includes(PUDDLE_CAVITY_FEATURE));
});
