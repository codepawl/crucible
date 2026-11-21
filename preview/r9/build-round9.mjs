// Round 6: a stationary ship. Flags: --contact (thin static contact foam rim on the sea), --contact-width <pixels>, --coverage <-1..1> (ocean foam bias), --no-wake, --no-particles, --no-spray. Round 5 text follows.
// Round 5: the sea uses the water material's `ripples` control (#2843) instead of the 48 fps blend workaround. Flags: --ripple-strength <0..1> (default 0.25), --ripple-speed <0..2> (default 1), --no-wind-ripples, --default-ripples (the unchanged round 4 water).
// Stage 1 preview of the Dutch galleon on Crucible water (#2758). Builds the recipe, writes a still and a short clip through the MCP render job.
// Usage: node build.mjs [--still-only] [--width 480] [--height 270] [--duration 6] [--fps 24] [--still-time 2.5] [--out <folder>]
// The folder holds assets/galleon.glb (CC0 Dutch ship, see the issue branch CREDITS.md) and assets/sky.hdr (Poly Haven kloofendal_48d_partly_cloudy_puresky, CC0).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { hullFoamSnippet, seaFollow } from './ship-follow.mjs';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const width = Number(option('width', 480));
const height = Number(option('height', 270));
const duration = Number(option('duration', 6));
const framesPerSecond = Number(option('fps', 24));
const stillTime = Number(option('still-time', 2.5));
const outputFolder = resolve(option('out', 'artifacts/2758-galleon'));
const assetFolder = join(outputFolder, 'assets');
const jobsFolder = resolve(option('jobs', join(outputFolder, 'jobs')));
const draft = Number(option('draft', 3.9));
const seaSize = 300;
const seaTag = option('tag', 'preview');
const waterline = Number(option('waterline', 2.6));
const followed = process.argv.includes('--follow') ? seaFollow(duration, waterline) : null;
if (followed) console.log(JSON.stringify({ heaveRange: followed.heaveRange, pitchDegrees: followed.pitchDegrees, rollDegrees: followed.rollDegrees }));
const has = name => process.argv.includes(`--${name}`);
const rippleStrength = Number(option('ripple-strength', 0.25));
const rippleSpeed = Number(option('ripple-speed', 1));
// The ocean's wind blows toward direction 0 degrees (+x); the ripples run downwind with it.
const contactRim = has('contact') ? { alphaMode: 'blend', contactFoam: { width: Number(option('contact-width', 3)), hardness: 0.7, noise: 0.3, drift: 0 } } : {};
const oceanCoverage = has('coverage') ? { coverage: Number(option('coverage', 0)) } : {};
const rippleControl = has('default-ripples') ? {} : { ripples: { strength: rippleStrength, speed: rippleSpeed, ...(has('no-wind-ripples') ? {} : { windDirection: 0 }) } };

// The ship is 34 m long, bow toward +x, keel at y = 0 and its middle at x = 3.3 in the GLB.
const SHIP_HALF_LENGTH = 17.1;
const SHIP_HALF_WIDTH = 4.2;
const SHIP_MIDDLE_X = 3.3;

/** Half width of the hull at the waterline, `x` metres along the ship from its middle; the bow (+x) is narrower. */
function waterlineHalfWidth(x) {
  const fraction = x / SHIP_HALF_LENGTH;
  const rounded = SHIP_HALF_WIDTH * Math.sqrt(Math.max(0, 1 - fraction * fraction));
  return fraction > 0 ? rounded * (1 - 0.45 * fraction) : rounded;
}

/** Foam points [x, z, strength, width] around the hull, along the wake behind the stern and along the two bow-wave arms. */
function wakePoints() {
  const points = [];
  for (let x = -SHIP_HALF_LENGTH + 1; x <= SHIP_HALF_LENGTH - 1; x += 5) {
    const halfWidth = waterlineHalfWidth(x);
    points.push([x, halfWidth, 0.9, 2.4], [x, -halfWidth, 0.9, 2.4]);
  }
  if (has('hull-ring')) {
    return points;
  }
  points.push([SHIP_HALF_LENGTH + 0.5, 0, 1, 3]);
  for (let step = 0; step < 4; step += 1) {
    points.push([-SHIP_HALF_LENGTH - 3 - step * 7, Math.sin(step * 2.1) * 0.8, 0.95 - step * 0.12, 3 + step * 0.8]);
  }
  for (let step = 0; step < 16; step += 1) {
    const behind = 2 + step * 6;
    const spread = SHIP_HALF_WIDTH * 0.7 + behind * 0.24 + Math.sin(step * 1.9) * 0.6;
    const strength = Math.max(0.35, 1 - step * 0.04);
    const width = 2.4 + step * 0.35;
    points.push([-SHIP_HALF_LENGTH - behind, spread, strength, width], [-SHIP_HALF_LENGTH - behind, -spread, strength, width]);
  }
  for (let step = 0; step < 6; step += 1) {
    const behind = 1.5 + step * 5;
    const spread = waterlineHalfWidth(SHIP_HALF_LENGTH - behind) + 0.6 + behind * 0.3;
    points.push([SHIP_HALF_LENGTH - behind, spread, 1 - step * 0.08, 2.6], [SHIP_HALF_LENGTH - behind, -spread, 1 - step * 0.08, 2.6]);
  }
  return points;
}

const FAR_SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 2 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [9000, 1, 9000]] } },
];

const SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 4 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [seaSize, 1, seaSize]] } },
];

// A round soft puff from the card's own uv, so a flat card reads as a cloud of spray and not a square.
const PUFF_SNIPPET = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n'
  + '  float distanceFromMiddle = length(uv - vec2(0.5)) * 2.0;\n'
  + '  alpha *= smoothstep(1.0, 0.15, distanceFromMiddle);\n}';

/** Static foam painted on the water around the hull outline. It reads the water point's world position, so it rides every wave, never depends on time and cannot pop. */
function legacyHullFoamSnippet() {
  const lines = [
    `const float SHIP_MIDDLE_X = 0.0;`,
    `const float HALF_LENGTH = ${SHIP_HALF_LENGTH.toFixed(2)};`,
    `const float HALF_WIDTH = ${SHIP_HALF_WIDTH.toFixed(2)};`,
    `const float BAND_WIDTH = ${Number(option('band-width', 1.1)).toFixed(2)};`,
    'float hullFoamHash(vec2 cell) { return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453); }',
    'float hullFoamNoise(vec2 point) {',
    '  vec2 cell = floor(point);',
    '  vec2 blend = fract(point);',
    '  blend = blend * blend * (3.0 - 2.0 * blend);',
    '  return mix(mix(hullFoamHash(cell), hullFoamHash(cell + vec2(1.0, 0.0)), blend.x), mix(hullFoamHash(cell + vec2(0.0, 1.0)), hullFoamHash(cell + vec2(1.0, 1.0)), blend.x), blend.y);',
    '}',
    'vec3 hullPoint = vec3(0.0);',
    'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) { hullPoint = worldPosition; }',
    'void waterHook(inout vec3 color, WaterInputs water) {',
    '  float along = hullPoint.x - SHIP_MIDDLE_X;',
    '  float semiLength = HALF_LENGTH - 1.0;',
    '  float semiWidth = HALF_WIDTH - 0.3;',
    '  vec2 scaled = vec2(along / semiLength, hullPoint.z / semiWidth);',
    '  float ellipse = max(length(scaled), 0.001);',
    '  vec2 gradient = vec2(along / (semiLength * semiLength), hullPoint.z / (semiWidth * semiWidth)) / ellipse;',
    '  float outside = (ellipse - 1.0) / max(length(gradient), 0.001);',
    '  float breakup = hullFoamNoise(hullPoint.xz * 0.8);',
    '  float reach = BAND_WIDTH * (0.45 + 0.9 * breakup);',
    '  float foam = 1.0 - smoothstep(reach * 0.15, reach, outside);',
    '  foam *= smoothstep(-0.6, -0.1, outside);',
    '  vec3 foamColor = vec3(0.78, 0.82, 0.85);',
    '  color = mix(color, foamColor, foam * 0.92);',
    '}',
  ];
  return lines.join('\n');
}

/** Quaternion [x, y, z, w] for a roll about the ship's long axis (x) then a pitch about its beam axis (z), angles in radians. */
function rollPitchQuaternion(roll, pitch) {
  const halfRoll = roll / 2;
  const halfPitch = pitch / 2;
  const rollQuaternion = [Math.sin(halfRoll), 0, 0, Math.cos(halfRoll)];
  const pitchQuaternion = [0, 0, Math.sin(halfPitch), Math.cos(halfPitch)];
  const [ax, ay, az, aw] = pitchQuaternion;
  const [bx, by, bz, bw] = rollQuaternion;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Gentle swell motion for the hull: heave, roll and pitch on slightly different periods so it never looks mechanical. Keys every 0.25 s over the clip. */
function shipSwellTracks(clipDuration) {
  const heaveKeys = [];
  const rotationKeys = [];
  for (let time = 0; time <= clipDuration + 1e-9; time += 0.25) {
    const heave = 0.28 * Math.sin((2 * Math.PI * time) / 4.2) + 0.08 * Math.sin((2 * Math.PI * time) / 2.3 + 1);
    const roll = (1.7 * Math.PI / 180) * Math.sin((2 * Math.PI * time) / 5.1 + 0.6);
    const pitch = (1.1 * Math.PI / 180) * Math.sin((2 * Math.PI * time) / 4.2 - 0.8);
    heaveKeys.push({ time, value: [-SHIP_MIDDLE_X, -draft + heave, 0] });
    rotationKeys.push({ time, value: rollPitchQuaternion(roll, pitch) });
  }
  return [
    { kind: 'node', id: 'ship', property: 'translation', interpolation: 'SMOOTH', keyframes: heaveKeys },
    { kind: 'node', id: 'ship', property: 'rotation', interpolation: 'SMOOTH', keyframes: rotationKeys },
  ];
}

/**
 * Foam seen from a low camera is foreshortened to a hair line when it lies flat on the water, so the collar stands up: flattened torus rings attached to the ship
 * at its waterline, following the hull outline (an ellipse of 12.3 m by 4.3 m centred 2.1 m behind the ship's middle fits the waterline within 0.4 m). A dark thin ring
 * sits right at the water for the contact shadow, a pale ring above it is the foam, and an arc around the stem is the bow wave. Their only texture is a fixed cell noise on the uv.
 */
function addFoamCollar(recipe) {
  const collarHeight = Number(option('collar-height', 0.9));
  const waterlineLocal = Number(option('waterline', 2.6));
  const centreX = SHIP_MIDDLE_X - 2.1;
  const halfBeam = waterlineLocal >= 4 ? 3.95 - (waterlineLocal - 4) * 0.3 : 4.25;
  const foamSnippet = 'float ringHash(vec2 cell) { return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453); }\n'
    + 'float ringNoise(vec2 point) {\n  vec2 cell = floor(point);\n  vec2 blend = fract(point);\n  blend = blend * blend * (3.0 - 2.0 * blend);\n'
    + '  return mix(mix(ringHash(cell), ringHash(cell + vec2(1.0, 0.0)), blend.x), mix(ringHash(cell + vec2(0.0, 1.0)), ringHash(cell + vec2(1.0, 1.0)), blend.x), blend.y);\n}\n'
    + 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n'
    + '  float breakup = ringNoise(vec2(uv.x * 70.0, uv.y * 3.0)) * 0.6 + ringNoise(vec2(uv.x * 190.0, uv.y * 7.0)) * 0.4;\n'
    + '  float topFade = smoothstep(0.0, 0.45, abs(sin(uv.y * 6.28318)));\n'
    + '  alpha *= smoothstep(0.25, 0.7, breakup) * (0.55 + 0.45 * topFade);\n}';
  const darkSnippet = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n'
    + '  alpha *= 0.5 + 0.5 * abs(sin(uv.y * 6.28318));\n}';
  recipe.geometries.push(
    { id: 'collar-ring', type: 'torus', tubeRadius: 0.04, segments: 128, sides: 12 },
    { id: 'collar-dark', type: 'torus', tubeRadius: 0.03, segments: 128, sides: 12 },
    { id: 'collar-bow', type: 'torus', tubeRadius: 0.09, segments: 48, sides: 12, arc: 1.5, start: -0.75 },
  );
  recipe.materials.push(
    { id: 'collar-foam', tag: 'unlit', color: [0.68, 0.72, 0.75], alphaMode: 'blend', opacity: Number(option('collar-opacity', 0.85)), doubleSided: true, snippet: { fragment: foamSnippet } },
    { id: 'collar-shadow', tag: 'unlit', color: [0.02, 0.05, 0.07], alphaMode: 'blend', opacity: 0.7, doubleSided: true, snippet: { fragment: darkSnippet } },
  );
  const ring = (id, geometry, material, scale, rise) => ({ id, parent: 'ship', geometry, material, translation: [centreX, waterlineLocal + rise, 0], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [scale[0], scale[2], scale[1]] });
  recipe.nodes.push(
    ring('collar-dark-node', 'collar-dark', 'collar-shadow', [12.45, 8, halfBeam + 0.12], -0.2),
    ring('collar-foam-node', 'collar-ring', 'collar-foam', [12.4, collarHeight / 0.08, halfBeam + 0.05], 0.15),
    ring('collar-bow-node', 'collar-bow', 'collar-foam', [12.7, 1.3 / 0.18, halfBeam + 0.2], 0.2),
  );
}

/** `--mode ship` drops the sea, `--mode empty` drops the sea and the ship: the two reference passes of the hull-visibility measurement. */
function restrictToMode(recipe) {
  const mode = option('mode', 'full');
  if (has('collar')) addFoamCollar(recipe);
  if (has('pole')) {
    // A thin red post 8 m tall standing in the sea at x, z (its foot 3 m under the calm level): where the sea cuts it shows the rendered sea height.
    const [poleX, poleZ] = option('pole', '3,-12').split(',').map(Number);
    recipe.geometries.push({ id: 'pole-geometry', type: 'mesh', base: { type: 'box', bevel: 0 } });
    recipe.materials.push({ id: 'pole-material', tag: 'unlit', color: [1, 0, 0] });
    recipe.nodes.push({ id: 'pole', geometry: 'pole-geometry', material: 'pole-material', translation: [poleX, 1.5, poleZ], scale: [0.15, 9, 0.15] });
  }
  if (mode === 'full') return recipe;
  const removed = new Set(['sea', 'far-sea', ...(mode === 'empty' ? ['ship'] : [])]);
  recipe.nodes = recipe.nodes.filter(node => !removed.has(node.id));
  if (recipe.motion) recipe.motion.tracks = recipe.motion.tracks.filter(track => track.kind !== 'node' || !removed.has(track.id));
  return recipe;
}

function buildRecipe(shipAssetId, skyAssetId) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: SEA_EDITS,
        stack: [{ op: 'ocean', windSpeed: 10, choppiness: 1.5, size: 70, seed: 23, resolution: 6, spray: !has('no-spray'), ...oceanCoverage, ...(has('no-wake') ? {} : { wake: { points: wakePoints(), height: has('hull-ring') ? 0.15 : 0.45 } }) }] },
      { id: 'far-sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: FAR_SEA_EDITS,
        stack: [{ op: 'ocean', windSpeed: 13, choppiness: 0, size: 900, seed: 5, resolution: 3 }] },
      { id: 'card', type: 'plane', segments: 1 },
    ],
    materials: [
      { id: 'water', color: [0.001, 0.008, 0.028], tag: 'water', waterPreset: 'sea', roughness: 0.035, turbidity: 0.3, ...rippleControl, ...contactRim, ...(has('painted-foam') ? { snippet: { fragment: hullFoamSnippet({ sideWidth: Number(option('side-width', 0.55)), endWidth: Number(option('end-width', 1.3)), opacity: Number(option('foam-opacity', 0.6)) }) } } : {}) },
      { id: 'spray', tag: 'unlit', color: [0.92, 0.96, 1], alphaMode: 'add', opacity: 0.7, doubleSided: true, snippet: { fragment: PUFF_SNIPPET } },
      { id: 'bowmist', tag: 'unlit', color: [0.9, 0.95, 1], alphaMode: 'blend', opacity: 0.22, doubleSided: true, snippet: { fragment: PUFF_SNIPPET } },
      { id: 'mist', tag: 'unlit', color: [0.85, 0.9, 0.95], alphaMode: 'blend', opacity: 0.07, doubleSided: true, snippet: { fragment: PUFF_SNIPPET } },
    ],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      ...(has('no-far') ? [] : [{ id: 'far-sea', geometry: 'far-sea', material: 'water', translation: [0, -0.6, 0] }]),
      { id: 'ship', asset: { id: shipAssetId }, translation: [-SHIP_MIDDLE_X, -draft, 0] },
      { id: 'bow-spray', geometry: 'card', material: 'spray' },
      { id: 'bow-mist', geometry: 'card', material: 'bowmist' },
      { id: 'low-mist', geometry: 'card', material: 'mist' },
    ],
    camera: has('side') ? { eye: [0, 1.2, -45], target: [0, 4, 0], fov: 40 } : has('top') ? { eye: [0, 70, 0.1], target: [0, 0, 0], fov: 42 } : { eye: [30, 3.6, -27], target: [2, 8, 0], fov: 42 },
    environment: {
      world: true, hdri: skyAssetId, environmentIntensity: 1, environmentRotation: 0,
      keyIntensity: 1.4, lightDirection: [0.5, 0.7, -0.4], keyColor: [2.4, 2.1, 1.8], fogColor: [0.6, 0.72, 0.86], fogDensity: 0.0011,
      ...(process.argv.includes('--shafts') ? { volumeFog: { density: 0.0015, steps: 24, minimum: [-120, 0, -120], maximum: [120, 70, 120], anisotropy: 0.75, noiseAmount: 0.3 } } : {}),
    },
    particles: has('no-particles') ? undefined : {
      systems: [
        { node: 'bow-spray', seed: 7, count: 2000, rate: 330, lifetime: [0.6, 1.2], speed: [4, 10], spread: 22, size: [0.12, 0.45], drag: 0.4, orient: 'random', scale: 'shrink',
          emitter: { shape: 'box', position: [SHIP_HALF_LENGTH - 1.5, 0.5, 0], halfExtents: [1.2, 0.3, 2.2] }, direction: [0.55, 1, 0] },
        { node: 'bow-mist', seed: 19, count: 700, rate: 120, lifetime: [1.2, 2.2], speed: [1.5, 4], spread: 40, size: [1.2, 3], drag: 1.2, orient: 'random', scale: 'grow',
          emitter: { shape: 'box', position: [SHIP_HALF_LENGTH - 3, 0.6, 0], halfExtents: [2.5, 0.3, 2.6] }, direction: [0.3, 1, 0] },
        { node: 'low-mist', seed: 3, count: 400, rate: 50, lifetime: [4, 7], speed: [0.2, 0.9], spread: 90, size: [6, 12], drag: 1, orient: 'random',
          emitter: { shape: 'box', position: [0, 1.5, 0], halfExtents: [70, 0.8, 50] }, direction: [1, 0.1, 0] },
      ],
    },
    motion: has('no-motion') ? undefined : {
      duration,
      tracks: [
        ...(has('follow') ? followed.tracks : has('ship') ? shipSwellTracks(duration) : []),
        ...(has('no-ocean-track') ? [] : [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: duration, value: has('freeze-ocean') ? 0 : duration }] }]),
        ...(has('freeze-camera') ? [] : [{ kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [30, 3.6, -27] }, { time: duration, value: [24, 3.3, -33] }] }]),
      ],
    },
  };
}

await mkdir(jobsFolder, { recursive: true });
const serverArguments = [resolve('bin/crucible-mcp.mjs'), '--backend', 'gpu', '--memory', '768', '--assets', assetFolder, '--jobs', jobsFolder];
if (process.env.CHROME_PATH) serverArguments.push('--browser', process.env.CHROME_PATH);
const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, stderr: 'inherit', env: { ...process.env, COOK_DISABLE: '1' } });
const client = new Client({ name: 'crucible-galleon-preview', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
  return result;
}

try {
  await client.connect(transport);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const ship = catalog.assets.find(asset => JSON.stringify(asset).includes('galleon'));
  const sky = catalog.assets.find(asset => JSON.stringify(asset).includes('sky.hdr'));
  if (!ship || !sky) throw new Error(`The catalog lacks the galleon or the sky: ${JSON.stringify(catalog).slice(0, 500)}`);
  const created = (await call('scene_create', { recipe: restrictToMode(buildRecipe(ship.assetId, sky.assetId)) }, 300000)).structuredContent;
  const inspected = (await call('scene_inspect', { sessionId: created.sessionId })).structuredContent;
  console.log(JSON.stringify({ particles: inspected.particles, warnings: inspected.warnings }).slice(0, 1500));
  if (has('dump-inspect')) console.log('INSPECT ' + JSON.stringify(inspected).slice(0, 6000));
  if (!has('no-still')) {
  const still = (await call('scene_look', { sessionId: created.sessionId, width: Number(option('still-width', 960)), height: Number(option('still-height', 540)), motionTime: stillTime }, 300000)).content.find(item => item.type === 'image');
  await writeFile(join(outputFolder, `galleon-${seaTag}.png`), Buffer.from(still.data, 'base64'));
  console.log(`wrote galleon-${seaTag}.png`);
  }
  if (has('look-times')) {
    for (const time of option('look-times', '0').split(',')) {
      const frame = (await call('scene_look', { sessionId: created.sessionId, width: Number(option('still-width', 480)), height: Number(option('still-height', 270)), motionTime: Number(time) }, 300000)).content.find(item => item.type === 'image');
      await writeFile(join(outputFolder, `galleon-${seaTag}-t${time}.png`), Buffer.from(frame.data, 'base64'));
    }
  }
  if (process.argv.includes('--still-only')) {
    await client.close();
    process.exit(0);
  }
  const job = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: has('stills') ? { kind: 'stills', width, height, fps: framesPerSecond, stillCount: Math.round(duration * framesPerSecond) + 1, motion: { start: 0 } } : { kind: 'video', width, height, fps: framesPerSecond, duration, motion: { start: 0 } } })).structuredContent;
  for (;;) {
    const state = (await call('scene_render_status', { jobId: job.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      if (state.state !== 'completed') throw new Error(`Render ${state.state}: ${JSON.stringify(state).slice(0, 600)}`);
      break;
    }
    await delay(1000);
  }
  const result = (await call('scene_render_result', { jobId: job.jobId })).structuredContent;
  console.log(JSON.stringify(result).slice(0, 800));
  await client.close();
  process.exit(0);
} catch (error) {
  console.error(String(error.stack ?? error));
  process.exit(1);
}
