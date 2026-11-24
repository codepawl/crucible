import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { curveAt, flipbookFrame, flipbookUv, normalizeCurve } from '../src/particle-curves.js';
import { buildRibbonMesh } from '../src/particle-ribbons.js';

test.before(() => loadPhysicsEngine({ buoyancy: true }));

function track(id, from, to, duration = 4) {
  return { kind: 'node', id, property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: from }, { time: duration, value: to }] };
}

function recipeWith(systems, extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'card', type: 'plane' }, { id: 'marker', type: 'box', bevel: 0 }],
    materials: [{ id: 'glow', color: [1, 1, 1], alphaMode: 'add' }, { id: 'soft', color: [1, 1, 1], alphaMode: 'blend' }],
    nodes: [
      { id: 'fx', geometry: 'card', material: 'glow' },
      { id: 'start', geometry: 'marker', material: 'glow' },
      { id: 'finish', geometry: 'marker', material: 'glow', translation: [0, 0, 4] },
    ],
    motion: { duration: 4, tracks: [track('start', [0, 0, 0], [4, 0, 0]), track('finish', [0, 0, 4], [4, 2, 4])] },
    particles: { gravity: [0, 0, 0], systems },
    ...extra,
  };
}

function sampled(recipe, time) {
  const scene = createAgentScene(recipe);
  scene.sampleMotion(time);
  return scene.parts.find(part => part.name === 'fx').geometry;
}

// The middle of ring `index` of a strip: the mean of its two vertices.
function ringCenter(geometry, index) {
  return [0, 1, 2].map(axis => (geometry.positions[index * 6 + axis] + geometry.positions[index * 6 + 3 + axis]) / 2);
}

function assertClose(actual, expected, message) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-4, `${message}: got [${actual}], expected [${expected}]`));
}

test('flipbook frame follows the life, or plays at fps and loops', () => {
  const sheet = { rows: 2, columns: 4, frames: 8 };
  assert.equal(flipbookFrame(sheet, 0, 0), 0);
  assert.equal(flipbookFrame(sheet, 0.5, 0.5), 4);
  assert.equal(flipbookFrame(sheet, 1, 1), 7);
  const playing = { ...sheet, fps: 8 };
  assert.equal(flipbookFrame(playing, 0.3, 0.1), 2);
  assert.equal(flipbookFrame(playing, 1.1, 0.1), 0, 'a loop wraps after the 8 cells');
  assert.equal(flipbookFrame({ ...playing, loop: false }, 5, 0.9), 7, 'without a loop it holds the last cell');
  const uv = [0, 0];
  flipbookUv(sheet, 5, 0.5, 0.5, uv, 0);
  assertClose(uv, [(1 + 0.5) / 4, (1 + 0.5) / 2], 'cell 5 is row 1, column 1');
});

test('a flipbook particle shows the cell of its age through its UVs', () => {
  const recipe = recipeWith([{ node: 'fx', seed: 2, count: 1, lifetime: 4, speed: 0, size: 1, drag: 0, emitter: { shape: 'point', position: [0, 1, 0] }, flipbook: { rows: 2, columns: 2 } }]);
  const frameAt = time => {
    const uvs = sampled(recipe, time).uvs;
    const columns = Math.min(...Array.from(uvs).filter((_, slot) => slot % 2 === 0));
    const rows = Math.min(...Array.from(uvs).filter((_, slot) => slot % 2 === 1));
    return Math.round(rows * 2) * 2 + Math.round(columns * 2);
  };
  assert.equal(frameAt(0.1), 0);
  assert.equal(frameAt(1.5), 1);
  assert.equal(frameAt(2.5), 2);
  assert.equal(frameAt(3.9), 3);
});

test('size, alpha and colour curves shape a particle over its life', () => {
  assert.deepEqual(normalizeCurve([[0, 0], [0.5, 1], [1, 0]], 'size', 0, 10), [[0, 0], [0.5, 1], [1, 0]]);
  assert.equal(curveAt([[0, 0], [0.5, 1], [1, 0]], 0.25), 0.5);
  const recipe = recipeWith([{ node: 'fx', seed: 2, count: 1, lifetime: 4, speed: 0, size: 1, drag: 0, emitter: { shape: 'point' }, sizeOverLife: [[0, 0], [0.5, 2], [1, 0]], alpha: [[0, 0], [0.5, 1], [1, 0]], color: [[0, [1, 0, 0]], [1, [0, 0, 1]]], fade: 'opacity' }], { materials: recipeWith([]).materials.map(material => ({ ...material, alphaMode: 'blend' })) });
  const spanAt = time => {
    const positions = sampled(recipe, time).positions;
    return Math.max(...Array.from(positions).filter((_, slot) => slot % 3 === 0)) - Math.min(...Array.from(positions).filter((_, slot) => slot % 3 === 0));
  };
  assert.ok(spanAt(2) > spanAt(1) * 1.5, 'it is largest at half its life');
  assert.ok(spanAt(3.9) < spanAt(2) / 4, 'and small again at the end');
  const opacity = sampled(recipe, 2).vertexOpacity;
  assert.ok(Math.abs(opacity[0] - 1) < 1e-6, 'fully opaque at half its life');
});

test('the same seed gives the same positions and another seed does not', () => {
  const system = seed => ({ node: 'fx', seed, count: 40, rate: 20, lifetime: 2, speed: [1, 3], size: 0.1, spread: 40, emitter: { shape: 'disc', radius: 0.5 }, preset: 'sparkles' });
  const first = sampled(recipeWith([system(7)]), 1.3).positions;
  const second = sampled(recipeWith([system(7)]), 1.3).positions;
  const other = sampled(recipeWith([system(8)]), 1.3).positions;
  assert.deepEqual(Array.from(first), Array.from(second));
  assert.notDeepEqual(Array.from(first), Array.from(other));
});

test('a beam strip ends at its two nodes at every time', () => {
  const recipe = recipeWith([{ type: 'beam', node: 'fx', from: 'start', to: { node: 'finish', offset: [0, 1, 0] }, width: 0.2, segments: 6 }]);
  for (const time of [0, 1, 2.5]) {
    const geometry = sampled(recipe, time);
    assert.equal(geometry.positions.length / 3, 14, 'seven rings of two vertices');
    assertClose(ringCenter(geometry, 0), [time, 0, 0], `start at ${time} s`);
    assertClose(ringCenter(geometry, 6), [time, 0.5 * time + 1, 4], `end at ${time} s`);
  }
});

test('a beam bows through its curve and scrolls its texture', () => {
  const recipe = recipeWith([{ type: 'beam', node: 'fx', from: 'start', to: 'finish', segments: 8, curve: [0, 1, 0], scroll: 2, repeat: 3 }]);
  const geometry = sampled(recipe, 1);
  assertClose(ringCenter(geometry, 4), [1, 1.25, 2], 'the middle is lifted by the curve');
  assert.ok(Math.abs(geometry.uvs[0] - 2) < 1e-6, 'u starts at scroll times time');
  assert.ok(Math.abs(geometry.uvs[8 * 4] - 5) < 1e-6, 'and ends repeat further');
});

test('a trail at time N depends only on N, not on the times visited before', () => {
  const recipe = recipeWith([{ type: 'trail', node: 'fx', follow: 'start', lifetime: 1, segments: 10, width: [0.2, 0] }]);
  const fresh = sampled(recipe, 2.5);
  const visited = createAgentScene(recipe);
  for (const time of [3.9, 0.2, 1.7, 2.5]) visited.sampleMotion(time);
  const again = visited.parts.find(part => part.name === 'fx').geometry;
  assert.deepEqual(Array.from(again.positions), Array.from(fresh.positions));
  assertClose(ringCenter(fresh, 0), [2.5, 0, 0], 'the head is the node now');
  assertClose(ringCenter(fresh, 10), [1.5, 0, 0], 'the tail is where it was a lifetime ago');
});

test('a trail starts where the node started and hides ages before the scene', () => {
  const recipe = recipeWith([{ type: 'trail', node: 'fx', follow: 'start', lifetime: 1, segments: 4, fade: 'opacity' }], { materials: recipeWith([]).materials.map(material => ({ ...material, alphaMode: 'blend' })) });
  const geometry = sampled(recipe, 0.5);
  assert.equal(geometry.vertexOpacity[0], 1);
  assert.equal(geometry.vertexOpacity[8], 0, 'the point 0.75 s old is before the scene');
});

test('errors name the field and the fix', () => {
  const cases = [
    [{ node: 'fx', preset: 'rain' }, /preset/],
    [{ node: 'fx', flipbook: { rows: 2, columns: 2, frames: 5 } }, /frames/],
    [{ type: 'beam', node: 'fx', from: 'fx', to: 'finish' }, /another node than the system node/],
    [{ type: 'beam', node: 'fx', from: 'start', to: 'missing' }, /ID of a node/],
    [{ type: 'trail', node: 'fx', follow: 'start', lifetime: 100 }, /lifetime/],
    [{ type: 'trail', node: 'fx', follow: 'start', segments: 500 }, /segments/],
    [{ type: 'beam', node: 'fx', from: 'start', to: 'finish', alpha: [[0.2, 1], [1, 0]] }, /alpha/],
    [{ type: 'beam', node: 'fx', from: 'start', to: 'finish', fade: 'opacity' }, /alphaMode "blend"/],
  ];
  for (const [system, pattern] of cases) assert.throws(() => createAgentScene(recipeWith([system])), pattern, JSON.stringify(system));
});

test('smoke, fire and sparkles presets build bounded systems that rise or twinkle', () => {
  const soft = recipeWith([]).materials.map(material => ({ ...material, alphaMode: 'blend' }));
  const smoke = sampled(recipeWith([{ node: 'fx', preset: 'smoke', emitter: { position: [0, 0, 0] } }], { materials: soft }), 2);
  const fire = sampled(recipeWith([{ node: 'fx', preset: 'fire' }]), 0.6);
  const sparkles = sampled(recipeWith([{ node: 'fx', preset: 'sparkles', count: 30 }]), 1);
  const topOf = geometry => Math.max(...Array.from(geometry.positions).filter((_, slot) => slot % 3 === 1));
  assert.ok(topOf(smoke) > 0.8, 'smoke rises although the scene gravity is zero or down');
  assert.ok(topOf(fire) > 0.3, 'fire rises');
  assert.equal(sparkles.positions.length / 3 % 30, 0, 'thirty sparkles, one card each');
  assert.throws(() => createAgentScene(recipeWith([{ node: 'fx', preset: 'smoke', count: 5000 }])), /count/);
});

// A particle frozen at a known age: its vertex colour is the colour curve at that age (the tint a surface material multiplies by).
test('the colour curve reaches the vertex colour of a particle at a known age (#3240)', () => {
  const stops = [[0, [1, 0, 0]], [0.5, [0, 1, 0]], [1, [0, 0, 1]]];
  const recipe = recipeWith([{ node: 'fx', seed: 2, count: 1, lifetime: 4, speed: 0, size: 1, drag: 0, emitter: { shape: 'point' }, color: stops }]);
  const colorAt = time => Array.from(sampled(recipe, time).colors.subarray(0, 3));
  assertClose(colorAt(2), [0, 1, 0], 'half way through the life is the middle stop');
  assertClose(colorAt(1), [0.5, 0.5, 0], 'a quarter in is half red and half green');
  const preset = recipeWith([{ node: 'fx', preset: 'fire', count: 1, lifetime: 2, speed: 0, emitter: { shape: 'point' } }]);
  const fire = Array.from(sampled(preset, 0.8).colors.subarray(0, 3));
  assert.ok(fire[0] > fire[1] && fire[1] > fire[2], `fire is orange (red above green above blue), got [${fire.map(value => value.toFixed(3))}]`);
});

test('a ribbon bend is mitred: a 90 degree corner keeps its width and no quad folds over (#3240)', () => {
  const points = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  const mesh = buildRibbonMesh(points, [0.2, 0.2, 0.2], [1, 1, 1], [0, 0.5, 1], {}, { eye: [0, 0, 10] });
  const corner = [0, 1, 2].map(axis => (mesh.positions[6 + axis] + mesh.positions[9 + axis]) / 2);
  assertClose(corner, [1, 0, 0], 'the corner ring is centred on the point');
  const half = Math.hypot(...[0, 1, 2].map(axis => mesh.positions[9 + axis] - mesh.positions[6 + axis])) / 2;
  assert.ok(Math.abs(half - 0.1 * Math.SQRT2) < 1e-4, `the corner is mitred to width over the cosine of half the turn, got ${half}`);
  const sideOf = quad => {
    const [firstVertex, secondVertex, thirdVertex] = [mesh.indices[quad * 6], mesh.indices[quad * 6 + 1], mesh.indices[quad * 6 + 2]];
    const edge = (from, to) => [0, 1].map(axis => mesh.positions[to * 3 + axis] - mesh.positions[from * 3 + axis]);
    const [first, second] = [edge(firstVertex, secondVertex), edge(firstVertex, thirdVertex)];
    return Math.sign(first[0] * second[1] - first[1] * second[0]);
  };
  assert.equal(sideOf(0), sideOf(1), 'both quads face the same way, so none folds over');
});

// An agent gives a plane and a preset and nothing else: every preset must fit the vertex budget with its own defaults (#3240).
for (const preset of ['smoke', 'fire', 'sparkles']) {
  test(`the ${preset} preset fits the vertex budget on a default plane with no extra setting`, () => {
    const scene = createAgentScene(recipeWith([{ node: 'fx', preset }]));
    scene.sampleMotion(1);
    const vertices = scene.parts.find(part => part.name === 'fx').geometry.positions.length / 3;
    assert.ok(vertices <= 100000, `${preset} drew ${vertices} vertices`);
    assert.equal(vertices % 4, 0, 'each card is one quad of 4 vertices');
  });
}

test('a segments value the recipe gives wins over the preset card', () => {
  const recipe = recipeWith([{ node: 'fx', preset: 'smoke' }]);
  recipe.geometries[0] = { id: 'card', type: 'plane', segments: 16 };
  assert.throws(() => createAgentScene(recipe), /vertices/);
});
