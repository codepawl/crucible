import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

const mode = process.argv[2] ?? 'draft';
const only = process.argv[3] ?? 'all';
const root = process.cwd();
mkdirSync(`${root}/artifacts/ev/r12`, { recursive: true });
const parameters = {
  keyIntensity: 1, keyDirection: [-0.45, 1, -0.3], warmRange: 2.2, cartZ: [1, -2], fixtureX: -2.5, fixtureY: 2.8, area: 12, wallWidth: 14, wallHeight: 6,
  wallCamera: { eye: [15.8, 25.7, 14.5], target: [-3.9, 1.7, 0.74], fov: 34 },
  cartLength: 3.8, lampOffset: 1.8, warmIntensity: 40, lampHeight: 1.2, blueIntensity: 85, blueColor: [0.2, 0.42, 1],
  blueAngle: 0.35, blueHeight: 2.4, blueAim: [0.6, -2, 0], blueRange: 7, cartCamera: { eye: [2.3, 25, 19.6], target: [2.3, 0, -1.2], fov: 48 },
  ...JSON.parse(process.env.P8 ?? '{}'),
};
const transport = new StdioClientTransport({ command: 'node', args: ['bin/crucible-mcp.mjs', '--backend', 'cpu', '--jobs', `${root}/artifacts/ev/r12/jobs`], env: { ...process.env, COOK_DISABLE: '1' } });
const client = new Client({ name: 'ev', version: '1' });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 900));
  return result;
};
const materials = [
  { id: 'floor', color: [0.4, 0.38, 0.36], roughness: 0.95, pattern: { type: 'fabric' } },
  { id: 'wall', color: [0.7, 0.68, 0.64], roughness: 1, pattern: { type: 'fabric' } },
  { id: 'cart', color: [0.06, 0.06, 0.065], roughness: 1 },
  { id: 'post', color: [0.2, 0.2, 0.22], roughness: 0.5 },
  { id: 'bulb', color: [1, 0.9, 0.6], emission: 0.9, emissiveColor: [1, 0.8, 0.5] },
  { id: 'bluelamp', color: [0.15, 0.35, 1], emission: 0.5, emissiveColor: [0.2, 0.45, 1] },
  { id: 'glow', color: [0.9, 0.72, 0.45], emission: 1.0, emissiveColor: [1, 0.78, 0.45] },
  { id: 'glowOff', color: [0.5, 0.42, 0.3], emission: 0 },
  { id: 'mask', color: [1, 1, 1], emission: 4, emissiveColor: [1, 1, 1] },
  { id: 'black', color: [0, 0, 0], emission: 0 },
  { id: 'wallFloor', color: [0.5, 0.5, 0.52], roughness: 1, pattern: { type: 'fabric' } },
];
const geometries = [{ id: 'box', type: 'box' }, { id: 'panel', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }];
const dark = { setup: 'studio', ambientIntensity: 0.03, keyIntensity: parameters.keyIntensity, keyColor: [1, 1, 1], lightDirection: parameters.keyDirection, fillIntensity: 0 };
const fixtureX = parameters.fixtureX;
const length = parameters.cartLength;
const lampOffset = parameters.lampOffset;
const cartScene = {
  format: 'crucible.scene', schemaVersion: 1, geometries, materials,
  camera: parameters.cartCamera,
  nodes: [
    { id: 'floor', geometry: 'panel', material: 'floor', translation: [0, -0.05, -3], scale: [400, 0.1, 400] },
    { id: 'cart', geometry: 'box', material: 'cart', translation: [0, 0.3, parameters.cartZ[0]], scale: [length, 0.5, 0.7] },
    { id: 'post', parent: 'cart', geometry: 'box', material: 'post', translation: [-lampOffset / length, (0.4 + parameters.lampHeight) / 2, 0], scale: [0.06 / length, parameters.lampHeight - 0.6, 0.0857] },
    { id: 'stalk', parent: 'cart', geometry: 'box', material: 'post', translation: [lampOffset / length, (0.5 + parameters.blueHeight - 0.2) / 2, 0], scale: [0.06 / length, parameters.blueHeight - 0.7, 0.1143] },
    { id: 'spothead', parent: 'cart', geometry: 'box', material: 'bluelamp', translation: [lampOffset / length, parameters.blueHeight, 0], scale: [0.25 / length, 0.4, 0.4286] },
    { id: 'lamp', parent: 'cart', geometry: 'ball', material: 'bulb', translation: [-lampOffset / length, parameters.lampHeight, 0], scale: [0.1 / length, 0.2, 0.1429] },
  ],
  environment: { ...dark,
    pointLights: [{ parent: 'lamp', intensity: parameters.warmIntensity, range: parameters.warmRange, radius: 0.1, color: [1, 0.75, 0.45] }],
    spotLights: [{ parent: 'cart', position: [lampOffset / length, parameters.blueHeight, 0], direction: parameters.blueAim, angle: parameters.blueAngle, penumbra: 0.95, intensity: parameters.blueIntensity, range: parameters.blueRange ?? 14, color: parameters.blueColor }] },
  motion: { duration: 2, tracks: [{ kind: 'node', id: 'cart', property: 'translation', keyframes: [{ time: 0, value: [0, 0.3, parameters.cartZ[0]] }, { time: 2, value: [0, 0.3, parameters.cartZ[1]] }] }] },
};
const wallScene = {
  format: 'crucible.scene', schemaVersion: 1, geometries, materials,
  camera: parameters.wallCamera,
  nodes: [
    { id: 'base', geometry: 'box', material: 'post', translation: [fixtureX, 0.03, 0], scale: [0.5, 0.06, 0.5] },
    { id: 'floor', geometry: 'panel', material: 'wallFloor', translation: [0, -0.05, 0], scale: [400, 0.1, 400] },
    { id: 'wall', geometry: 'panel', material: 'wall', translation: [-4.3, parameters.wallHeight / 2, 0], scale: [0.2, parameters.wallHeight, parameters.wallWidth] },
    { id: 'fixture', geometry: 'box', material: 'glow', translation: [fixtureX, parameters.fixtureY, 0], scale: [0.3, 0.8, 1.2] },
    { id: 'stand', geometry: 'box', material: 'post', translation: [fixtureX, (parameters.fixtureY - 0.4) / 2, 0], scale: [0.08, parameters.fixtureY - 0.4, 0.08] },
  ],
  environment: { ...dark, lightDirection: parameters.wallKeyDirection ?? parameters.keyDirection, ground: false, areaLights: [{ parent: 'fixture', face: '-x', faceOffset: 0.03, intensity: parameters.area, color: [1, 0.9, 0.75] }] },
};
const withIntensityZero = list => list.map(light => ({ ...light, intensity: 0 }));
const switchedOff = recipe => ({ ...recipe, environment: { ...recipe.environment,
  ...(recipe.environment.areaLights ? { areaLights: withIntensityZero(recipe.environment.areaLights) } : {}),
  ...(recipe.environment.pointLights ? { pointLights: withIntensityZero(recipe.environment.pointLights) } : {}),
  ...(recipe.environment.spotLights ? { spotLights: withIntensityZero(recipe.environment.spotLights) } : {}) } });
const recolored = (recipe, mapping) => ({ ...recipe, nodes: recipe.nodes.map(node => ({ ...node, material: mapping[node.material] ?? node.material })) });
const create = async recipe => (await call('scene_create', { recipe })).structuredContent.sessionId;
const recipes = {
  wallOn: wallScene,
  wallOff: recolored(switchedOff(wallScene), { glow: 'glowOff' }),
  wallMask: recolored(switchedOff(wallScene), { glow: 'mask' }),
  cartOn: cartScene,
  cartOff: switchedOff(cartScene),
  cartWarm: { ...cartScene, environment: { ...cartScene.environment, spotLights: withIntensityZero(cartScene.environment.spotLights) } },
  cartBlue: { ...cartScene, environment: { ...cartScene.environment, pointLights: withIntensityZero(cartScene.environment.pointLights) } },
  cartMask: recolored(switchedOff(cartScene), { floor: 'black', cart: 'mask', post: 'mask', bulb: 'mask', bluelamp: 'mask' }),
};
async function shoot(recipeName, time, file) {
  const session = await create(recipes[recipeName]);
  if (mode === 'draft') {
    const result = await call('scene_look', { sessionId: session, ...(time === null ? {} : { motionTime: time }), width: 540, height: 960 });
    const image = result.content.find(part => part.type === 'image');
    writeFileSync(`artifacts/ev/r12/draft-${file}`, Buffer.from(image.data, 'base64'));
    return;
  }
  const settings = { kind: 'image', width: 1080, height: 1920, quality: 'realtime-high', ...(time === null ? {} : { motion: { start: time } }) };
  const inspect = await call('scene_inspect', { sessionId: session });
  const submitted = (await call('scene_render_submit', { sessionId: session, expectedRevision: inspect.structuredContent.revision, settings })).structuredContent;
  const jobId = submitted.jobId ?? submitted.id;
  for (;;) {
    const status = (await call('scene_render_status', { jobId, response_format: 'concise' })).structuredContent ?? {};
    const state = status.state ?? status.status;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state)) { if (state !== 'completed') throw new Error(JSON.stringify(status)); break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const result = (await call('scene_render_result', { jobId, images: false })).structuredContent;
  const png = result.artifacts.find(entry => String(entry.path ?? entry).endsWith('.png'));
  copyFileSync(png.path ?? png, `artifacts/ev/r12/${file}`);
}
if (only !== 'wall') {
  await shoot('cartOn', 1, 'cart-1.png');
  await shoot('cartOff', 1, 'cart-off-1.png');
  await shoot('cartMask', 1, 'cart-mask-1.png');
  await shoot('cartWarm', 1, 'cart-warm-1.png');
  await shoot('cartBlue', 1, 'cart-blue-1.png');
  if (mode !== 'draft') {
    await shoot('cartOn', 0, 'cart-0.png');
    await shoot('cartOn', 2, 'cart-2.png');
    for (const frame of [0, 2]) {
      await shoot('cartOff', frame, `cart-off-${frame}.png`);
      await shoot('cartMask', frame, `cart-mask-${frame}.png`);
    }
  }
}
if (only !== 'cart') {
  await shoot('wallOn', null, 'wall-on.png');
  await shoot('wallOff', null, 'wall-off.png');
  await shoot('wallMask', null, 'wall-mask.png');
}
await client.close();
