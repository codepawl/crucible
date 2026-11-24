import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const close = (actual, expected, label) => {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-4, `${label}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`));
};

function recipeWith(environment, extraNodes = [], motion = undefined) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'white', color: [0.8, 0.8, 0.8] }],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'white', translation: [0, -0.05, 0], scale: [12, 0.1, 6] },
      { id: 'cart', geometry: 'box', material: 'white', translation: [0, 0.5, 0] },
      ...extraNodes,
    ],
    camera: { eye: [0, 3, 8], target: [0, 0.5, 0], fov: 60, near: 0.05, far: 40 },
    environment,
    ...(motion ? { motion } : {}),
  };
}

const cartMotion = { duration: 2, tracks: [{ kind: 'node', id: 'cart', property: 'translation', keyframes: [{ time: 0, value: [-3, 0.5, 0] }, { time: 2, value: [3, 0.5, 0] }] }] };

test('point and spot lights follow a moving parent node and its rotation across frames', () => {
  const motion = { duration: 2, tracks: [
    { kind: 'node', id: 'cart', property: 'translation', keyframes: [{ time: 0, value: [-3, 0.5, 0] }, { time: 2, value: [3, 0.5, 0] }] },
    { kind: 'node', id: 'cart', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, 0, 0, 1] }] },
  ] };
  const scene = createAgentScene(recipeWith({
    pointLights: [{ parent: 'cart', position: [0, 1, 0], intensity: 4 }],
    spotLights: [{ parent: 'cart', position: [0, 1, 0], direction: [0, -1, 0] }],
  }, [], motion));
  const positions = [];
  for (const time of [0, 1, 2]) {
    scene.sampleMotion(time);
    const { pointLights, spotLights } = scene.environment;
    assert.equal(pointLights[0].parent, undefined);
    close(spotLights[0].position, pointLights[0].position, `spot at ${time}`);
    close(spotLights[0].direction, [0, -1, 0], 'spot direction');
    positions.push(pointLights[0].position);
  }
  close(positions[0], [-3, 1.5, 0], 'frame 0');
  close(positions[1], [0, 1.5, 0], 'frame 1');
  close(positions[2], [3, 1.5, 0], 'frame 2');
});

test('a light follows the animation of a parent group through a child part, and a rotated parent turns the spot direction', () => {
  const nodes = [{ id: 'arm', translation: [0, 2, 0] }, { id: 'hand', parent: 'arm', geometry: 'box', material: 'white', translation: [1, 0, 0], scale: [0.2, 0.2, 0.2] }];
  const half = Math.SQRT1_2;
  const motion = { duration: 1, tracks: [{ kind: 'node', id: 'arm', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, half, half] }] }] };
  const scene = createAgentScene(recipeWith({ spotLights: [{ parent: 'hand', direction: [0, -1, 0] }] }, nodes, motion));
  scene.sampleMotion(0);
  close(scene.environment.spotLights[0].position, [1, 2, 0], 'rest');
  scene.sampleMotion(1);
  close(scene.environment.spotLights[0].position, [0, 3, 0], 'arm turned 90 degrees about z');
  close(scene.environment.spotLights[0].direction, [1, 0, 0], 'direction turned with the arm');
});

test('a surface light takes the size, normal and place of one face of a scaled part', () => {
  const panel = { id: 'panel', geometry: 'box', material: 'white', translation: [1, 2, 3], scale: [2, 1, 0.5] };
  const scene = createAgentScene(recipeWith({
    areaLights: [{ parent: 'panel', face: '+y', intensity: 3 }, { parent: 'panel', face: '+x', faceOffset: 0 }, { parent: 'panel', face: '-z' }],
  }, [panel]));
  const [top, side, back] = scene.environment.areaLights;
  close(top.direction, [0, 1, 0], 'top normal');
  assert.ok(Math.abs(top.width - 2) < 1e-5 && Math.abs(top.height - 0.5) < 1e-5, `top size ${top.width} x ${top.height}`);
  close(top.position, [1, 2.502, 3], 'top position');
  close(side.direction, [1, 0, 0], 'side normal');
  assert.ok(Math.abs(side.width - 0.5) < 1e-5 && Math.abs(side.height - 1) < 1e-5, `side size ${side.width} x ${side.height}`);
  close(side.position, [2, 2, 3], 'side position');
  close(back.direction, [0, 0, -1], 'back normal');
  assert.ok(Math.abs(back.width - 2) < 1e-5 && Math.abs(back.height - 1) < 1e-5);
  for (const light of [top, side, back]) assert.equal(light.face, undefined);
  const trace = buildTraceScene(scene.parts, scene.environment);
  close(Array.from(trace.lights.areas[0].normal), [0, 1, 0], 'path tracer normal');
  assert.ok(Math.abs(trace.lights.areas[0].width - 2) < 1e-5);
});

test('a surface light rides a moving part and keeps the face size under rotation', () => {
  const half = Math.SQRT1_2;
  const motion = { duration: 1, tracks: [{ kind: 'node', id: 'cart', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, half, 0, half] }] }] };
  const scene = createAgentScene(recipeWith({ areaLights: [{ parent: 'cart', face: '+x' }] }, [], motion));
  scene.sampleMotion(1);
  const [light] = scene.environment.areaLights;
  close(light.direction, [0, 0, -1], 'the +x face looks along -z after a quarter turn about y');
  assert.ok(Math.abs(light.width - 1) < 1e-5 && Math.abs(light.height - 1) < 1e-5);
});

test('the authored recipe keeps the parent and face fields', () => {
  const scene = createAgentScene(recipeWith({ areaLights: [{ parent: 'cart', face: '+y' }], pointLights: [{ parent: 'cart' }] }, [], cartMotion));
  const exported = scene.exportRecipe?.() ?? null;
  if (exported) assert.equal(exported.environment.areaLights[0].face, '+y');
});

test('light parents fail at the boundary with the fix named', () => {
  const build = environment => () => createAgentScene(recipeWith(environment));
  assert.throws(build({ pointLights: [{ parent: 'nope' }] }), /environment\.pointLights\[0\]\.parent: got "nope"; expected a node ID/);
  assert.throws(build({ pointLights: [{ parent: 7 }] }), /parent: got 7; expected a node ID or glTF part name/);
  assert.throws(build({ areaLights: [{ parent: 'cart', face: 'top' }] }), /face: got "top"; expected one of \+x, -x/);
  assert.throws(build({ areaLights: [{ face: '+y' }] }), /parent: got undefined; expected the node ID of the part/);
  assert.throws(build({ areaLights: [{ parent: 'cart', face: '+y', width: 2 }] }), /width: got 2; expected left out/);
  assert.throws(build({ areaLights: [{ parent: 'cart', faceOffset: 1 }] }), /faceOffset: got 1/);
  assert.throws(build({ areaLights: [{ parent: 'cart', face: '+y', faceOffset: -1 }] }), /faceOffset/);
  assert.throws(build({ spotLights: [{ parent: 'cart', position: [0, 1, 0] }] }), /direction/);
});

test('a recipe with a parented light loads the module, and one without does not', async () => {
  const { agentSceneModulesNeeded } = await import('../src/agent-scene-modules.js');
  const parented = { environment: { pointLights: [{ parent: 'cart', position: [0, 1, 0] }] } };
  const surface = { environment: { spotLights: [{ position: [0, 1, 0], direction: [0, -1, 0] }], areaLights: [{ parent: 'p', face: '+y' }] } };
  const plain = { nodes: [{ id: 'a', parent: 'b' }], environment: { pointLights: [{ position: [0, 1, 0] }] } };
  assert.ok(agentSceneModulesNeeded(parented).includes('lightParenting'));
  assert.ok(agentSceneModulesNeeded(surface).includes('lightParenting'));
  assert.ok(!agentSceneModulesNeeded(plain).includes('lightParenting'));
});
