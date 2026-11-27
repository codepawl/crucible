import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { defaultSmoothAngle, OCEAN_SMOOTH_ANGLE_DEFAULT } from '../src/agent-mesh.js';
import { MESH_SMOOTH_ANGLE_DEFAULT } from '../src/agent-scene-capabilities.js';
import { createFragmentShader } from '../src/shaders.js';
import { bindWaterFoamStyle } from '../src/world-material-shader.js';
import { layerTextureSupport } from '../src/shader-registry.js';

function seaRecipe({ tag, smoothAngle, inStack = false }) {
  const edits = [
    { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
    { op: 'subdivide_edges', edges: { all: true }, cuts: 4 },
    { op: 'subdivide', levels: 2 },
    { op: 'set_position', position: { mul: [{ attr: 'position' }, [100, 1, 100]] } },
  ];
  const ocean = { op: 'ocean', windSpeed: 16, choppiness: 1.5, size: 50, seed: 3, resolution: 3, foamMemory: 2 };
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: inStack ? edits : [...edits, ocean], stack: inStack ? [ocean] : [], ...(smoothAngle === undefined ? {} : { smoothAngle }) }],
    materials: [{ id: 'surface', color: [0.1, 0.2, 0.3], ...(tag ? { tag } : {}) }],
    nodes: [{ id: 'sea', geometry: 'sea', material: 'surface' }],
  };
}

test('a water part of an ocean mesh carries 1 - foam in its sky visibility channel', () => {
  const water = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const foam = water.vertexGroups.foam;
  assert.ok(foam.some(weight => weight > 0.05), 'the sea folds somewhere');
  assert.equal(water.skyVisibility.length, foam.length);
  assert.ok(water.skyVisibility.every((value, index) => Math.abs(value - (1 - foam[index])) < 1e-6));
});

test('a part that is not water keeps its geometry untouched', () => {
  const plain = createAgentScene(seaRecipe({})).parts[0].geometry;
  assert.equal(plain.skyVisibility, undefined);
});

test('ocean output smooths over 180 degrees unless the recipe says otherwise', () => {
  assert.equal(defaultSmoothAngle([{ op: 'ocean' }], []), OCEAN_SMOOTH_ANGLE_DEFAULT);
  assert.equal(defaultSmoothAngle([], [{ op: 'ocean' }]), 180);
  assert.equal(defaultSmoothAngle([{ op: 'subdivide' }], []), MESH_SMOOTH_ANGLE_DEFAULT);
  const defaulted = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const stacked = createAgentScene(seaRecipe({ tag: 'water', inStack: true })).parts[0].geometry;
  const split = createAgentScene(seaRecipe({ tag: 'water', smoothAngle: 0 })).parts[0].geometry;
  assert.equal(defaulted.positions.length, stacked.positions.length, 'edit and stack give the same welded render mesh');
  assert.ok(split.positions.length > defaulted.positions.length, 'an explicit smoothAngle is still honoured');
});

test('the water shader reads the foam mask, a fresnel sky and a sun glint', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /float foamMask = clamp\(2\.0 \* \(1\.0 - vertexSkyVisibility\)/);
  assert.match(shader, /float reflectivity = \(0\.02 \+ 0\.98 \* pow\(1\.0 - cosine, 5\.0\)\)/);
  assert.match(shader, /pow\(max\(dot\(normal, halfVector\), 0\.0\), glintSharpness\)/);
  assert.match(shader, /normal = normalize\(normal \+ rippleTilt\)/);
});

test('the ocean foam of a rough sea reaches the water material as 1 - foam', () => {
  const water = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const foam = water.vertexGroups.foam;
  const whitecaps = foam.filter(weight => weight > 0.05).length;
  assert.ok(whitecaps > 0, 'a rough sea has vertices with foam');
  assert.ok(Math.min(...water.skyVisibility) < 0.95, 'the foam reaches the shader as a lower sky visibility');
  assert.equal(water.skyVisibility.filter(value => value < 0.95).length, whitecaps);
});

test('wind ripples break the glint into facets and the foam into streaks', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /vec2 waterDetailSlope\(/);
  assert.ok(shader.includes("float foamBand = mix(0.13, 0.0, foamHard) + 1.5 * fwidth(foamDensity)"));
  assert.match(shader, /rippleTilt\.xz \+= detailSlope/);
  assert.match(shader, /terrainNoise\(position \* wavenumber \* 0\.09/);
  assert.match(shader, /1\.0 \/ \(1\.0 \/ 500\.0 \+ 0\.35 \* waterLostVariance\)/);
  assert.match(shader, /terrainNoise\(crestPosition \* vec2\(3\.1, 14\.0\)/);
});

// The GLSL function is plain scalar math, so its text runs as JavaScript once the types and the three built-ins are renamed.
function waterWaveVisibilityOf(shader) {
  const source = shader.match(/float waterWaveVisibility\(float footprint, float wavenumber\) \{([^}]*)\}/);
  assert.ok(source, 'the shader has waterWaveVisibility(footprint, wavenumber)');
  const body = source[1].replace(/\bfloat\b/g, 'let').replace(/\bsin\(/g, 'Math.sin(');
  const clamp = (value, lowest, highest) => Math.min(Math.max(value, lowest), highest);
  return new Function('clamp', 'footprint', 'wavenumber', body).bind(null, clamp);
}

test('a pixel keeps a wave scaled by the average over its own width, the limit a supersampled render converges to (#853)', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  const visibility = waterWaveVisibilityOf(shader);
  const wavenumber = 2.1;
  const wavelength = (2 * Math.PI) / wavenumber;
  const sinc = pixelsPerWave => Math.sin(Math.PI / pixelsPerWave) / (Math.PI / pixelsPerWave);
  assert.ok(Math.abs(visibility(0, wavenumber) - 1) < 1e-6, 'a pixel far narrower than the wave shows all of it');
  for (const pixelsPerWave of [8, 5, 3, 2, 1.25]) {
    const footprint = wavelength / pixelsPerWave;
    assert.ok(Math.abs(visibility(footprint, wavenumber) - sinc(pixelsPerWave)) < 1e-6, `${pixelsPerWave} pixels per wave keep sinc of its width`);
  }
  assert.ok(visibility(wavelength / 2, wavenumber) > 0.6, 'at the two-pixel sampling limit a wave still shows, as an averaged wave, not a cut-off');
  assert.ok(Math.abs(visibility(wavelength, wavenumber)) < 1e-6, 'one pixel per wavelength averages the wave to nothing');
  assert.ok(Math.abs(visibility(wavelength * 20, wavenumber)) < 1e-6, 'finer waves stay at nothing instead of coming back as the sinc side lobes');
});

test('each detail wave is filtered by the pixel size along its own direction, and so are the two fixed swells', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /float footprint = abs\(dot\(positionDx, direction\)\) \+ abs\(dot\(positionDy, direction\)\);\n\s+float visible = waterWaveVisibility\(footprint, wavenumber\);/);
  assert.match(shader, /lostVariance \+= 0\.5 \* amplitude \* amplitude \* \(1\.0 - visible \* visible\)/);
  assert.match(shader, /float swellVisibleX = waterWaveVisibility\(abs\(positionDx\.x\) \+ abs\(positionDy\.x\), 1\.4\)/);
  assert.match(shader, /float swellVisibleZ = waterWaveVisibility\(abs\(positionDx\.y\) \+ abs\(positionDy\.y\), 1\.8\)/);
});

test('a hard foam edge is a flat shape with a one pixel edge, and the soft default keeps its lace', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /uniform vec2 waterFoamStyle/);
  assert.match(shader, /float foamHard = waterFoamStyle.x/);
  assert.ok(shader.includes("waterFoam = mix(max(foamBody"));
});

function waterRecipe(fields) {
  const recipe = seaRecipe({ tag: 'water' });
  Object.assign(recipe.materials[0], fields);
  return recipe;
}

test('a water material takes foamEdge and foamWidth, and other materials refuse them', () => {
  const material = createAgentScene(waterRecipe({ foamEdge: 'hard', foamWidth: 2 })).parts[0].material;
  assert.equal(material.foamEdge, 'hard');
  assert.equal(material.foamWidth, 2);
  assert.equal(createAgentScene(waterRecipe({})).parts[0].material.foamEdge, undefined);
  for (const bad of [{ foamEdge: 'sharp' }, { foamWidth: 0 }, { foamWidth: 5 }, { foamWidth: 'wide' }]) {
    assert.throws(() => createAgentScene(waterRecipe(bad)), /foamEdge|foamWidth/, JSON.stringify(bad));
  }
  const plain = seaRecipe({});
  plain.materials[0].foamEdge = 'hard';
  assert.throws(() => createAgentScene(plain), /need the water tag/);
});

test('a water material takes foamVeins with defaults, and refuses bad values with what to pass', () => {
  const defaults = createAgentScene(waterRecipe({ foamVeins: {} })).parts[0].material.foamVeins;
  assert.deepEqual({ ...defaults }, { amount: 0.6, scale: 1 });
  const given = createAgentScene(waterRecipe({ foamVeins: { amount: 1, scale: 2 } })).parts[0].material.foamVeins;
  assert.deepEqual({ ...given }, { amount: 1, scale: 2 });
  assert.equal(createAgentScene(waterRecipe({})).parts[0].material.foamVeins, undefined);
  const refusals = [
    [{ foamVeins: 0.5 }, /foamVeins must be an object such as/],
    [{ foamVeins: { strength: 1 } }, /no field strength; pass amount or scale/],
    [{ foamVeins: { amount: 2 } }, /foamVeins\.amount must be a number from 0 to 1, such as 0\.6/],
    [{ foamVeins: { scale: 0.1 } }, /foamVeins\.scale must be a number from 0\.25 to 4/],
    [{ foamVeins: { stretch: 3 } }, /no field stretch; pass amount or scale/],
    [{ foamVeins: { scale: 'fine' } }, /foamVeins\.scale/],
  ];
  for (const [bad, message] of refusals) {
    assert.throws(() => createAgentScene(waterRecipe(bad)), message, JSON.stringify(bad));
  }
  const plain = seaRecipe({});
  plain.materials[0].foamVeins = {};
  assert.throws(() => createAgentScene(plain), /foamVeins need the water tag/);
});

test('foam veins are a ridged, warped streak mask gated on amount and the foam mask, so off draws nothing', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /uniform vec2 waterFoamVeins/);
  assert.ok(shader.includes('if (waterFoamVeins.x > 0.0) {'), 'amount 0 skips the veins');
  assert.ok(shader.includes('float veinRidge = 1.0 - abs(2.0 * terrainNoise('), 'ridged noise makes the lines');
  assert.ok(shader.includes('veinWarp'), 'a second noise warps them');
  assert.ok(shader.includes('float veinTrail = smoothstep(0.0, 0.8, clamp(1.0 - vertexSkyVisibility, 0.0, 1.0))'), 'the reach reads the whole foam group, not only the crest cap mask, so lace trails out');
  assert.ok(/float veinFade = smoothstep\(0\.0, 0\.6, veinTrail[^;]*veinPatch/.test(shader), 'a slow noise breaks the trail into patches as the foam weight falls');
  assert.ok(shader.includes('waterFoam = max(waterFoam, veinLine * veinFade * waterFoamVeins.x)'), 'veins only add foam');
  assert.ok(!/float veinReach/.test(shader), 'the reach is no longer gated by the crest cap mask');
  const veinPosition = shader.match(/vec2 veinPosition = ([^;]+);/)[1];
  assert.equal(veinPosition, 'worldPosition.xz * 4.0 * waterFoamVeins.y', 'one scalar step on the world position, the same in every direction');
  assert.ok(!veinPosition.includes('crestPosition'), 'no frame that turns with the surface normal, which smears the veins');
  assert.ok(!/vec2\(/.test(veinPosition), 'no per axis factor: veins are not stretched along one axis');
  assert.ok(!/veinPosition \* vec2\(|veinPosition\.[xy] \*|vec2\([^)]*\) \* veinPosition/.test(shader), 'the ridge noise is not scaled per axis either');
});

test('a water batch sends its veins, and a batch without foamVeins sends amount 0', () => {
  const sent = [];
  const renderer = {
    shaderFeatures: new Set(['water']),
    program: {},
    batches: [],
    context: new Proxy({}, {
      get: (_target, name) => {
        if (name === 'getUniformLocation') return (_program, uniform) => uniform;
        if (name === 'uniform2f') return (uniform, ...values) => uniform === 'waterFoamVeins' && sent.push(values);
        return () => null;
      },
    }),
  };
  const bind = (material) => layerTextureSupport.bind(renderer, {}, {}, { parts: [{ material }] });
  bind({ tag: 'water', foamVeins: { amount: 0.9, scale: 2 } });
  bind({ tag: 'water' });
  assert.deepEqual(sent, [[0.9, 2], [0, 1]]);
});

test('a water material takes foamColor as three linear numbers, and refuses anything else with what to pass', () => {
  const tinted = createAgentScene(waterRecipe({ foamColor: [0.8, 0.95, 1] })).parts[0].material;
  assert.deepEqual([...tinted.foamColor], [0.8, 0.95, 1]);
  assert.equal(createAgentScene(waterRecipe({})).parts[0].material.foamColor, undefined);
  for (const bad of [[1, 1], [1, 1, 2], [-0.1, 0, 0], ['white', 1, 1], 'white']) {
    assert.throws(() => createAgentScene(waterRecipe({ foamColor: bad })), /foamColor must be three numbers from 0 to 1, such as \[0\.8, 0\.95, 1\]/, JSON.stringify(bad));
  }
  const plain = seaRecipe({});
  plain.materials[0].foamColor = [1, 1, 1];
  assert.throws(() => createAgentScene(plain), /foamColor need the water tag/);
});

function foamColorUploads(foamColor) {
  const uploads = {};
  const context = new Proxy({}, {
    get: (_, name) => name === 'getUniformLocation' ? (_program, uniform) => uniform : (...values) => { uploads[`${String(name)}:${values[0]}`] = values.slice(1); },
  });
  const material = createAgentScene(waterRecipe(foamColor === undefined ? {} : { foamColor })).parts[0].material;
  const renderer = { context, program: {}, shaderFeatures: new Set(['water']) };
  bindWaterFoamStyle(renderer, { parts: [{ material }] });
  return uploads['uniform3f:waterFoamColor'];
}

test('foamColor tints the foam through its own uniform, and leaving it out uploads white so the default pixels do not change', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /uniform vec3 waterFoamColor;/);
  assert.ok(shader.includes('radiance *= vec3(1.0) + (waterFoamColor - vec3(1.0)) * waterFoam * (1.0 - waterContactShare);'), 'the whole foam pixel is tinted, and white adds zero');
  assert.ok(!shader.includes('waterFoamColor *'), 'no partial tint is left on one term');
  assert.deepEqual(foamColorUploads(undefined), [1, 1, 1], 'no foamColor uploads exact white');
  assert.deepEqual(foamColorUploads([1, 1, 1]), foamColorUploads(undefined), 'white given equals the default');
  assert.deepEqual(foamColorUploads([0.8, 0.95, 1]), [0.8, 0.95, 1]);
});

test('foam light replaces the light the foam albedo already got, so foam never outshines a white diffuse surface', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  const replaceLight = shader.indexOf('radiance *= 1.0 - waterFoam;');
  const addFoamLight = shader.indexOf('radiance += mix(vec3(0.85, 0.9, 0.95), waterContactColor, waterContactShare) * waterFoam');
  const tintFoam = shader.indexOf('radiance *= vec3(1.0) + (waterFoamColor - vec3(1.0))');
  assert.ok(replaceLight > 0, 'the foam pixel drops the light it already had');
  assert.ok(replaceLight < addFoamLight, 'the foam add comes after the drop, not before it');
  assert.ok(addFoamLight < tintFoam, 'the tint scales the finished foam pixel');
});

test('foam lace fades to fixed axes where the surface is level, so a wake draws no fan of rays (#3070)', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.ok(shader.includes('float crestSteadiness = smoothstep(0.01, 0.05, length(crestNormal.xz))'), 'the weight follows how far the normal leans');
  assert.match(shader, /float broadLace = mix\(terrainNoise\(worldPosition\.xz/);
  assert.match(shader, /float fineLace = mix\(terrainNoise\(worldPosition\.xz/);
});

test('water body and horizon distance fog avoid neon-cyan glow and blend toward sky haze (#3637)', () => {
  const waterShader = createFragmentShader(['water']);
  assert.ok(!waterShader.includes('0.0137, 0.147, 0.195'), 'grazing color follows waterAbsorption instead of hardcoded cyan');
  assert.ok(!waterShader.includes('daylight * 1.7'), 'water body removes unconditional 1.7x neon boost');
  assert.match(waterShader, /exp\(-waterAbsorption \* 1\.2\)/);
  assert.match(waterShader, /surroundingsColor\(vec3\(fogDirection\.x/);
  assert.ok(waterShader.includes('environmentEnabled > 1.5'), 'environment haze only blends into surroundingsColor when the environment map draws the background');
});
