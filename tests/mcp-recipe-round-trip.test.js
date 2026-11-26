import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';
import { MOTION_TRACK_KINDS } from '../src/agent-motion.js';
import { MOTION_TRACK_KIND_NAMES } from '../src/motion-track-kinds.js';
import { createAgentScene, loadPhysicsEngine, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

await loadPhysicsEngine();

function oneBoxRecipe(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'red', color: [1, 0, 0] }],
    nodes: [{ id: 'a', geometry: 'cube', material: 'red' }],
    ...extra,
  };
}

function fractureRecipe() {
  return oneBoxRecipe({
    nodes: [
      { id: 'floor', geometry: 'cube', material: 'red', scale: [10, 0.2, 10], translation: [0, -0.1, 0] },
      { id: 'crate', geometry: 'cube', material: 'red', translation: [0, 2, 0] },
    ],
    physics: { duration: 1, bodies: [{ node: 'floor', type: 'fixed' }] },
  });
}

async function withRoundTripClient(use) {
  let scene;
  const runtime = {
    activeSessionId() { return scene ? 'round-trip' : null; },
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { sessionId: 'round-trip', revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { sessionId: 'round-trip', revision: scene.revision };
    },
    async exportRecipe() { return { sessionId: 'round-trip', revision: scene.revision, recipe: scene.exportRecipe() }; },
    async close() {},
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-recipe-round-trip-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await use(client, () => scene);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  return { isError: result.isError === true, text, structured: result.structuredContent };
}

async function exportedRecipe(client) {
  const exported = await call(client, 'scene_export_recipe', {});
  assert.equal(exported.isError, false, exported.text);
  return exported.structured.recipe;
}

async function applyOperations(client, operations) {
  const revision = (await call(client, 'scene_export_recipe', {})).structured.revision;
  return call(client, 'scene_apply', { expectedRevision: revision, operations });
}

async function assertAccepted(client, recipe) {
  const created = await call(client, 'scene_create', { recipe });
  assert.equal(created.isError, false, created.text);
}

test('an exported one-box recipe is accepted by scene_create unchanged', async () => {
  await withRoundTripClient(async client => {
    await assertAccepted(client, oneBoxRecipe());
    await assertAccepted(client, await exportedRecipe(client));
    await assertAccepted(client, oneBoxRecipe({ environment: { setup: 'sunset' } }));
    const sunset = await exportedRecipe(client);
    await assertAccepted(client, sunset);
    const applied = await applyOperations(client, [{ type: 'set-environment', environment: sunset.environment }]);
    assert.equal(applied.isError, false, applied.text);
  });
});

test('an exported recipe with fracture joints is accepted by scene_create', async () => {
  await withRoundTripClient(async client => {
    await assertAccepted(client, fractureRecipe());
    const fractured = await applyOperations(client, [{ type: 'fracture-node', node: 'crate', cells: 4, strength: 10, seed: 1 }]);
    assert.equal(fractured.isError, false, fractured.text);
    const recipe = await exportedRecipe(client);
    const joint = recipe.physics.joints[0];
    assert.equal(typeof joint.name, 'string');
    assert.equal(joint.breakImpulse, 10);
    await assertAccepted(client, recipe);
  });
});

test('scene_create accepts physics events, fields and ragdoll', async () => {
  await withRoundTripClient(async client => {
    const withEvents = fractureRecipe();
    withEvents.physics.bodies.push({ node: 'crate', type: 'dynamic' });
    withEvents.physics.events = [{ time: 0.1, body: 'crate', impulse: [1, 0, 0] }];
    withEvents.physics.fields = [{ type: 'wind', direction: [1, 0, 0], strength: 2 }];
    await assertAccepted(client, withEvents);
    await assertAccepted(client, await exportedRecipe(client));
    const ragdoll = fractureRecipe();
    ragdoll.physics.ragdoll = { armature: 'missing-rig' };
    const refused = await call(client, 'scene_create', { recipe: ragdoll });
    assert.doesNotMatch(refused.text, /Unrecognized key/);
    assert.match(refused.text, /armature/);
  });
});

test('scene_create accepts effects flash and distortion', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      effects: {
        flash: { node: 'a', startTime: 0, attack: 0, decay: 0.15, intensity: 3.5, radius: 6, ambient: 0.15 },
        distortion: [{ shape: 'ring', node: 'a', startTime: 0, speed: 45, thickness: 2.2, strength: 1 }],
      },
    });
    await assertAccepted(client, recipe);
    const applied = await applyOperations(client, [{ type: 'set-effects', effects: recipe.effects }]);
    assert.equal(applied.isError, false, applied.text);
  });
});

test('scene_create accepts the grid mesh base the docs use for decals', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      geometries: [{ id: 'badge', type: 'mesh', base: { type: 'grid', segments: 16 }, edits: [{ op: 'solidify', thickness: 0.02, offset: -1 }] }],
      nodes: [{ id: 'a', geometry: 'badge', material: 'red' }],
    });
    await assertAccepted(client, recipe);
  });
});

test('scene_create names the bad field and the allowed ones for a malformed motion track', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      motion: { duration: 1, tracks: [{ node: 'a', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] },
    });
    const created = await call(client, 'scene_create', { recipe });
    assert.equal(created.isError, true);
    assert.match(created.text, /Unknown or unsupported motion track field: node/);
    assert.match(created.text, /Allowed fields: kind, id, property/);
  });
});

test('scene_create accepts a recipe ragdoll on a real armature', async () => {
  await withRoundTripClient(async client => {
    const recipe = walkerRecipe();
    delete recipe.motion;
    recipe.geometries.push({ id: 'slab', type: 'box' });
    recipe.nodes.push({ id: 'floor', geometry: 'slab', material: 'cloth', translation: [0, -0.25, 0], scale: [8, 0.5, 8] });
    recipe.armatures[0].translation = [0, 1, 0];
    recipe.physics = { duration: 1, bodies: [{ node: 'floor', type: 'fixed' }], ragdoll: { armature: 'rig' } };
    await assertAccepted(client, recipe);
  });
});

test('scene_create accepts the plane mesh base and refuses segments outside 1 to 64', async () => {
  await withRoundTripClient(async client => {
    const withSegments = segments => oneBoxRecipe({
      geometries: [{ id: 'sheet', type: 'mesh', base: { type: 'plane', segments } }],
      nodes: [{ id: 'a', geometry: 'sheet', material: 'red' }],
    });
    await assertAccepted(client, withSegments(8));
    for (const segments of [0, 65]) {
      const refused = await call(client, 'scene_create', { recipe: withSegments(segments) });
      assert.equal(refused.isError, true);
    }
  });
});

test('scene_create names the valid kinds and properties for a motion track with a wrong kind or property', async () => {
  await withRoundTripClient(async client => {
    const keyframes = [{ time: 0, value: [0, 0, 0] }];
    const createdWith = track => call(client, 'scene_create', { recipe: oneBoxRecipe({ motion: { duration: 1, tracks: [track] } }) });
    const missingKind = await createdWith({ id: 'a', property: 'translation', keyframes });
    assert.match(missingKind.text, /needs kind \(node, material, camera, morph, geometry, light, sun, environment, effects\)/);
    const wrongKind = await createdWith({ kind: 'sky', id: 'a', property: 'translation', keyframes });
    assert.match(wrongKind.text, /Unknown motion track kind: "sky"\. Kinds: node, material/);
    const wrongProperty = await createdWith({ kind: 'node', id: 'a', property: 'bogus', keyframes });
    assert.match(wrongProperty.text, /Unknown node track property: "bogus"\. node properties: translation, rotation, scale, opacity, visible\./);
  });
});

function morphTrackRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'face', type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 2 }, shapeKeys: [{ name: 'lift', offsets: [{ select: { tag: 'top' }, offset: [0, 0.5, 0] }] }] }],
    materials: [{ id: 'skin' }],
    nodes: [{ id: 'head', geometry: 'face', material: 'skin' }],
    camera: { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 },
    motion: { duration: 2, tracks: [{ kind: 'morph', id: 'lift', property: 'weight', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] },
  };
}

test('scene_create accepts a morph motion track and the shape key weight animates', async () => {
  await withRoundTripClient(async (client, currentScene) => {
    const created = await call(client, 'scene_create', { recipe: morphTrackRecipe() });
    assert.notEqual(created.isError, true, created.text);
    const weightAt = time => {
      currentScene().sampleMotion(time);
      return Array.from(currentScene().parts.find(part => part.morph).morph.weights)[0];
    };
    assert.equal(weightAt(0), 0);
    assert.equal(weightAt(1), 1);
  });
});

test('scene_create takes every motion track kind the backend lists', async () => {
  assert.deepEqual([...MOTION_TRACK_KIND_NAMES], [...MOTION_TRACK_KINDS], 'the MCP leaf list matches the motion backend');
  assert.deepEqual([...MOTION_TRACK_KINDS], ['node', 'material', 'camera', 'morph', 'geometry', 'light', 'sun', 'environment', 'effects']);
  await withRoundTripClient(async client => {
    const wrongKind = await call(client, 'scene_create', { recipe: oneBoxRecipe({ motion: { duration: 1, tracks: [{ kind: 'sky', id: 'a', property: 'x', keyframes: [{ time: 0, value: 0 }] }] } }) });
    assert.match(wrongKind.text, new RegExp(`Kinds: ${MOTION_TRACK_KINDS.join(', ')}\\.`));
  });
});

const MODIFIER_EXAMPLES = [
  { type: 'cycles', before: 'mirror', after: 'offset', beforeCount: 2, afterCount: 3 },
  { type: 'stepped', step: 0.2, offset: 0.05 },
  { type: 'noise', scale: 0.5, strength: 0.3, phase: 0.1, seed: 7 },
  { type: 'generator', coefficients: [0, 1, 0.5], additive: true },
  { type: 'limits', min: -5, max: 5 },
  { type: 'envelope', points: [{ time: 0, min: -1, max: 1 }, { time: 1, min: -2, max: 2 }], referenceMin: -1, referenceMax: 1 },
];

function everyMotionFieldRecipe() {
  const keyframes = (first, second) => [{ time: 0, value: first }, { time: 1, value: second }];
  return oneBoxRecipe({
    nodes: [
      { id: 'a', geometry: 'cube', material: 'red' },
      { id: 'b', geometry: 'cube', material: 'red', translation: [3, 0, 0] },
    ],
    motion: {
      duration: 2,
      tracks: [
        { kind: 'node', id: 'a', property: 'translation', interpolation: 'LINEAR', extrapolation: 'linear', modifiers: MODIFIER_EXAMPLES.slice(1, 3), keyframes: keyframes([0, 0, 0], [1, 0, 0]) },
        { kind: 'node', id: 'a', property: 'scale', keyframes: keyframes([1, 1, 1], [2, 2, 2]), modifiers: [MODIFIER_EXAMPLES[0]] },
        { kind: 'node', id: 'b', property: 'translation', modifiers: [MODIFIER_EXAMPLES[3], MODIFIER_EXAMPLES[4], MODIFIER_EXAMPLES[5]], keyframes: keyframes([3, 0, 0], [3, 1, 0]) },
        { kind: 'material', id: 'red', property: 'roughness', extrapolation: 'linear', keyframes: keyframes(0.2, 0.6) },
        { kind: 'camera', property: 'eye', extrapolation: 'linear', keyframes: keyframes([0, 1, 6], [0, 1, 5]) },
      ],
    },
  });
}

function everyJointFieldRecipe() {
  const bodyNode = (id, x) => ({ id, geometry: 'cube', material: 'red', translation: [x, 1, 0] });
  const motor = { mode: 'position', target: 0.5, stiffness: 50, damping: 2, maxForce: 500 };
  return oneBoxRecipe({
    nodes: [
      { id: 'floor', geometry: 'cube', material: 'red', scale: [20, 0.2, 20], translation: [0, -0.1, 0] },
      bodyNode('p', 0), bodyNode('q', 1.5), bodyNode('r', 3), bodyNode('s', 4.5), bodyNode('t', 6), bodyNode('u', 7.5),
    ],
    physics: {
      duration: 1,
      bodies: [
        { node: 'floor', type: 'fixed' },
        ...['p', 'q', 'r', 's', 't', 'u'].map(node => ({ node, type: 'dynamic' })),
      ],
      joints: [
        { name: 'hinge', type: 'revolute', bodyA: 'p', bodyB: 'q', anchorA: [0.75, 0, 0], anchorB: [-0.75, 0, 0], axis: [0, 0, 1], limits: [-1, 1], motor, contactsEnabled: true },
        { name: 'slide', type: 'prismatic', bodyA: 'q', bodyB: 'r', axis: [1, 0, 0], limits: [0, 2], motor: { mode: 'velocity', target: 1, damping: 5, maxForce: 100 }, contactsEnabled: false },
        { name: 'glue', type: 'fixed', bodyA: 'r', bodyB: 's', breakImpulse: 25 },
        { name: 'ball', type: 'spherical', bodyA: 's', bodyB: 't', contactsEnabled: true },
        { name: 'band', type: 'spring', bodyA: 't', bodyB: 'u', restLength: 1.2, stiffness: 30, damping: 1.5, contactsEnabled: false },
      ],
    },
  });
}

for (const [label, buildRecipe, section] of [
  ['motion track', everyMotionFieldRecipe, 'motion'],
  ['physics joint', everyJointFieldRecipe, 'physics'],
]) {
  test(`every ${label} field the backend supports survives export, scene_create and export again`, async () => {
    await withRoundTripClient(async client => {
      await assertAccepted(client, buildRecipe());
      const firstExport = await exportedRecipe(client);
      assert.ok(firstExport[section], `${section} is exported`);
      await assertAccepted(client, firstExport);
      assert.deepEqual(await exportedRecipe(client), firstExport);
    });
  });
}

test('the exported motion and joint recipes keep each field that was authored', async () => {
  await withRoundTripClient(async client => {
    await assertAccepted(client, everyMotionFieldRecipe());
    const tracks = (await exportedRecipe(client)).motion.tracks;
    assert.ok(tracks.some(track => track.extrapolation === 'linear'));
    const modifierTypes = new Set(tracks.flatMap(track => (track.modifiers ?? []).map(modifier => modifier.type)));
    assert.deepEqual([...modifierTypes].sort(), MODIFIER_EXAMPLES.map(modifier => modifier.type).sort());
    await assertAccepted(client, everyJointFieldRecipe());
    const joints = (await exportedRecipe(client)).physics.joints;
    for (const field of ['name', 'motor', 'contactsEnabled', 'breakImpulse', 'restLength', 'stiffness', 'damping']) {
      assert.ok(joints.some(joint => joint[field] !== undefined), `joint field ${field} is exported`);
    }
  });
});

test('more than 8 modifiers and a spring joint without stiffness are refused', async () => {
  await withRoundTripClient(async client => {
    const tooMany = everyMotionFieldRecipe();
    tooMany.motion.tracks[0].modifiers = Array.from({ length: 9 }, () => MODIFIER_EXAMPLES[1]);
    assert.equal((await call(client, 'scene_create', { recipe: tooMany })).isError, true);
    const noStiffness = everyJointFieldRecipe();
    delete noStiffness.physics.joints[4].stiffness;
    const refusedSpring = await call(client, 'scene_create', { recipe: noStiffness });
    assert.equal(refusedSpring.isError, true);
    assert.match(refusedSpring.text, /stiffness/);
  });
});

function shapeDropRecipe(bodyFields) {
  return oneBoxRecipe({
    nodes: [
      { id: 'floor', geometry: 'cube', material: 'red', scale: [10, 0.2, 10], translation: [0, -0.1, 0] },
      { id: 'piece', geometry: 'cube', material: 'red', translation: [0, 2, 0] },
    ],
    physics: { duration: 2, bodies: [{ node: 'floor', type: 'fixed', shape: 'box' }, { node: 'piece', ...bodyFields }] },
  });
}

const BODY_SHAPE_CASES = [
  ['cylinder', { shape: 'cylinder' }],
  ['cone', { shape: 'cone' }],
  ['compound', { shape: 'compound', shapes: [{ shape: 'box', halfExtents: [0.5, 0.5, 0.5] }, { shape: 'cone', radius: 0.2, halfHeight: 0.2, translation: [0, 0.7, 0] }] }],
];

for (const [label, bodyFields] of BODY_SHAPE_CASES) {
  test(`scene_create accepts a ${label} physics body and it falls and rests on the floor`, async () => {
    await withRoundTripClient(async client => {
      const recipe = shapeDropRecipe(bodyFields);
      await assertAccepted(client, recipe);
      const exported = await exportedRecipe(client);
      assert.equal(exported.physics.bodies[1].shape, label);
      await assertAccepted(client, exported);
    });
    const scene = createAgentScene(shapeDropRecipe(bodyFields));
    scene.sampleMotion(2);
    const piece = scene.inspect({}).physics.bodies.find(body => body.node === 'piece');
    assert.ok(Math.abs(piece.finalPosition[1] - 0.5) < 0.03, `${label} rests on the floor, got ${piece.finalPosition[1]}`);
  });
}

test('the physics body schema error and scene_capabilities list every accepted shape', async () => {
  await withRoundTripClient(async client => {
    const refused = await call(client, 'scene_create', { recipe: shapeDropRecipe({ shape: 'torus' }) });
    assert.equal(refused.isError, true);
    for (const shape of AGENT_SCENE_CAPABILITIES.physics.shapes) assert.match(refused.text, new RegExp(`"${shape}"`));
    const capabilities = await call(client, 'scene_capabilities', { topic: 'physics' });
    for (const shape of ['cylinder', 'cone', 'compound']) assert.match(capabilities.text, new RegExp(shape));
    assert.match(capabilities.text, /shapes/);
  });
});

test('scene_create accepts node visible tracks and up to 256 keys per track, and refuses over 256 with the cap (#3427)', async () => {
  await withRoundTripClient(async client => {
    const keys256 = Array.from({ length: 256 }, (_, index) => ({ time: index / 255, value: index % 2 }));
    const visibleRecipe = oneBoxRecipe({
      motion: {
        duration: 1,
        tracks: [{ kind: 'node', id: 'a', property: 'visible', interpolation: 'STEP', keyframes: keys256 }],
      },
    });
    await assertAccepted(client, visibleRecipe);
    const badValue = oneBoxRecipe({
      motion: { duration: 1, tracks: [{ kind: 'node', id: 'a', property: 'visible', keyframes: [{ time: 0, value: 0.5 }] }] },
    });
    const refusedValue = await call(client, 'scene_create', { recipe: badValue });
    assert.equal(refusedValue.isError, true);
    assert.match(refusedValue.text, /visible.*1.*0/);
    const keys257 = Array.from({ length: 257 }, (_, index) => ({ time: index / 256, value: 1 }));
    const tooMany = oneBoxRecipe({
      motion: { duration: 1, tracks: [{ kind: 'node', id: 'a', property: 'visible', keyframes: keys257 }] },
    });
    const refusedCount = await call(client, 'scene_create', { recipe: tooMany });
    assert.equal(refusedCount.isError, true);
    assert.match(refusedCount.text, /256/);
  });
});

test('scene_capabilities camera topic clarifies that roll is in radians (#3444)', async () => {
  await withRoundTripClient(async client => {
    const cameraTopic = await call(client, 'scene_capabilities', { topic: 'camera' });
    assert.equal(cameraTopic.isError, false);
    assert.match(cameraTopic.text, /roll.*radians/i);
  });
});

test('scene_create map.sequence schema accepts frames or catalog and rejects neither or both (#3434)', async () => {
  await withRoundTripClient(async client => {
    const frameIds = ['a'.repeat(64), 'b'.repeat(64)];
    const withCatalog = oneBoxRecipe({
      materials: [{ id: 'red', map: { sequence: { catalog: 'frame_####.png', fps: 24, loop: true } } }],
    });
    // The mock runtime does not resolve catalog names, so reaching createAgentScene proves the MCP schema accepted catalog.
    const catalogResult = await call(client, 'scene_create', { recipe: withCatalog });
    assert.match(catalogResult.text, /the MCP server turns a catalog sequence name into its frame IDs/);
    const withFrames = oneBoxRecipe({
      materials: [{ id: 'red', map: { sequence: { frames: frameIds, fps: 12 } } }],
    });
    const framesResult = await call(client, 'scene_create', { recipe: withFrames });
    assert.match(framesResult.text, /was not loaded/);
    const withBoth = oneBoxRecipe({
      materials: [{ id: 'red', map: { sequence: { frames: frameIds, catalog: 'frame_####.png', fps: 12 } } }],
    });
    const refusedBoth = await call(client, 'scene_create', { recipe: withBoth });
    assert.equal(refusedBoth.isError, true);
    assert.match(refusedBoth.text, /frames.*catalog|not both/i);
    const withNeither = oneBoxRecipe({
      materials: [{ id: 'red', map: { sequence: { fps: 12 } } }],
    });
    const refusedNeither = await call(client, 'scene_create', { recipe: withNeither });
    assert.equal(refusedNeither.isError, true);
    assert.match(refusedNeither.text, /frames.*catalog|not both/i);
  });
});
