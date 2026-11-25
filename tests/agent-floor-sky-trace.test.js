import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { applyDefaultFloorSky, lastDefaultFloorSkyReport, skyTraceProblems, stageFloorSky } from '../src/floor-sky-visibility.js';

// A closed room: a floor, four walls and a closed roof, lit by a sun.
function room(environment = {}) {
  const wall = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.5, 0.45, 0.4], roughness: 0.8 }],
    nodes: [
      wall('floor', [0, -0.05, 0], [10, 0.1, 10]),
      wall('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      wall('wall-right', [5, 2, 0], [0.2, 4, 10]),
      wall('wall-front', [0, 2, 5], [10, 4, 0.2]),
      wall('wall-back', [0, 2, -5], [10, 4, 0.2]),
      wall('roof-a', [-2.5, 4.1, 0], [5.2, 0.2, 10.4]),
      wall('roof-b', [2.5, 4.1, 0], [5.2, 0.2, 10.4]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment,
  };
}

function floorHasSkyVisibility(scene) {
  return Boolean(scene.parts.find(part => part.name === 'floor').geometry.skyVisibility);
}

// The recipe path runs the same call with the default texel count, which takes seconds; the test keeps the trace small.
test('a closed room lit by a sun gets the floor sky trace by default', () => {
  const { parts } = createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }));
  const result = applyDefaultFloorSky(parts, { keyColor: [3, 3, 3] }, { maximumTexels: 400 });
  assert.equal(result.report.reason, null);
  assert.ok(result.parts.find(part => part.name === 'floor').geometry.skyVisibility);
});

test('environment.floorSkyTrace false turns the trace off', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }))), false);
});

test('environment.floorSkyTrace that is not a boolean is refused, not read as on', () => {
  for (const value of ['off', 0, null, { enabled: false }]) {
    assert.throws(() => createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: value })), /environment\.floorSkyTrace: got .*; expected true or false/);
  }
});

test('a room with no sun and open ground are left as they were', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [0, 0, 0] }))), false);
  const open = room({ keyColor: [3, 3, 3] });
  open.nodes = open.nodes.filter(node => node.id === 'floor' || node.id === 'roof-a');
  assert.equal(floorHasSkyVisibility(createAgentScene(open)), false);
});

// The demo room without its one boolean geometry. Moving the pendant bulb changes whether the sky trace cuts the ground, and
// a retained part keeps its old matrix until the commit, so an edit in place used to stage the trace against the old place (#3064).
test('a node moved in place gives the ground the geometry a build of the edited recipe gives', () => {
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  delete recipe.bake;
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'organiser');
  recipe.geometries = recipe.geometries.filter(geometry => geometry.id !== 'organiser');
  const edited = createAgentScene(recipe);
  const movedBulb = { type: 'set-node', id: 'pendant-bulb', translation: [0.3, 1.7, 0.2] };
  const groundOf = scene => scene.parts.find(part => part.name === 'ground').geometry;
  const plainGroundVertices = groundOf(edited).positions.length;
  const movedRecipe = structuredClone(edited.exportRecipe());
  movedRecipe.nodes.find(node => node.id === movedBulb.id).translation = movedBulb.translation;
  edited.apply([movedBulb], { expectedRevision: edited.revision });
  const freshGround = groundOf(createAgentScene(movedRecipe));
  assert.ok(freshGround.positions.length > plainGroundVertices, 'the moved bulb makes the sky trace cut the ground');
  for (const field of Object.keys(freshGround)) {
    assert.deepEqual(groundOf(edited)[field], freshGround[field], field);
  }
});

// #2806: a camera edit copies the environment, and the trace (seconds on a big scene) was run again for the copy.
test('a camera edit keeps the traced ground of the room instead of tracing it again', () => {
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  delete recipe.bake;
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'organiser');
  recipe.geometries = recipe.geometries.filter(geometry => geometry.id !== 'organiser');
  const scene = createAgentScene(recipe);
  const groundOf = () => scene.parts.find(part => part.name === 'ground');
  const groundBefore = groundOf();
  scene.apply([{ type: 'set-camera', fov: 40 }], { expectedRevision: scene.revision });
  assert.equal(groundOf(), groundBefore, 'the ground is the same part with the same trace');
  const turnedSun = { type: 'set-environment', environment: { lightDirection: [0.6, 0.7, 0.2] } };
  scene.apply([turnedSun], { expectedRevision: scene.revision });
  const fresh = createAgentScene(structuredClone(scene.exportRecipe()));
  const freshGround = fresh.parts.find(part => part.name === 'ground').geometry;
  for (const field of Object.keys(freshGround)) {
    assert.deepEqual(groundOf().geometry[field], freshGround[field], `a turned sun is traced again: ${field}`);
  }
});

// #2806: the lighthouse scene is open ground, so every camera edit ran the floor search over all its parts and found no room.
test('the floor search runs once for the same parts and the same sun, however often the environment is copied', () => {
  const open = room({ keyColor: [3, 3, 3] });
  open.nodes = open.nodes.filter(node => node.id === 'floor' || node.id === 'roof-a');
  const scene = createAgentScene(open);
  let geometryReads = 0;
  const parts = Object.freeze(scene.parts.map(part => ({
    ...part,
    geometry: new Proxy(part.geometry, { get(target, field) { geometryReads++; return target[field]; } }),
  })));
  const matrixOf = name => scene.parts.find(part => part.name === name).matrix;
  const environment = { keyColor: [3, 3, 3], lightDirection: [0.2, 1, 0.1] };
  assert.equal(stageFloorSky(environment, parts, matrixOf), parts, 'open ground comes back unchanged');
  const readsForFirstSearch = geometryReads;
  assert.ok(readsForFirstSearch > 0, 'the first call searches the parts');
  assert.equal(stageFloorSky(structuredClone(environment), parts, matrixOf), parts);
  assert.equal(geometryReads, readsForFirstSearch, 'a copy of the same environment reads no geometry');
  stageFloorSky({ ...environment, lightDirection: [1, 1, 0] }, parts, matrixOf);
  assert.ok(geometryReads > readsForFirstSearch, 'a turned sun is searched again');
});

// #3389: the demo room is a set open on one side. Its trace once cost 4.9 million rays and 109 thousand texels (now 1.56 million and 66 thousand), which ran past the 20 second
// limit on a slow machine and silently left the ground plain. The bound pins the cost, so the cliff cannot come back unseen.
test('the demo room is traced as an open-sided room within a ray bound that leaves room under the time limit', () => {
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  delete recipe.bake;
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'organiser');
  recipe.geometries = recipe.geometries.filter(geometry => geometry.id !== 'organiser');
  recipe.nodes.find(node => node.id === 'pendant-bulb').translation = [0.3, 1.7, 0.2];
  createAgentScene(recipe);
  const report = lastDefaultFloorSkyReport();
  assert.equal(report.branch, 'open-sided room, every surface traced');
  assert.equal(report.reason, null);
  assert.ok(report.rays <= 1_700_000, `the trace shot ${report.rays} rays`);
  assert.ok(report.texels <= 75_000, `the trace cut ${report.texels} texels`);
});

test('a sky trace that stops at its time limit says so and what to change', () => {
  const { parts } = createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }));
  const result = applyDefaultFloorSky(parts, { keyColor: [3, 3, 3] }, { maximumTexels: 400, maxSeconds: 0 });
  assert.equal(result.report.reason, 'passed maxSeconds');
  assert.equal(result.report.warnings.length, 1);
  assert.match(result.report.warnings[0], /time limit.*ground.*plain.*maxSeconds/s);
  assert.equal(result.parts.find(part => part.name === 'floor').geometry.skyVisibility, undefined);
});

// A set open on one side whose walls are 2.5 m high: a long low wall and a wall split into panels. The prop rule once read "no second side over 3 m", which made any wall under 3 m
// high a prop, whatever its length, and gave it the coarse cut and half the rays that drew stripes on a wall.
function lowOpenSet({ panels }) {
  const slab = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  const nodes = [
    slab('floor', [0, -0.1, 0], [8, 0.2, 10]),
    slab('wall-back', [0, 1.25, -5], [8, 2.5, 0.2]),
    slab('wall-left', [-4, 1.25, 0], [0.2, 2.5, 10]),
    slab('ceiling', [0, 2.6, 0], [8.2, 0.2, 10.2]),
    slab('stool', [1, 0.25, -1], [0.4, 0.5, 0.4]),
  ];
  if (panels) {
    for (let panel = 0; panel < 5; panel++) nodes.push(slab(`wall-right-${panel}`, [4, 1.25, -4 + panel * 2], [0.2, 2.5, 2]));
  } else {
    nodes.push(slab('wall-right', [4, 1.25, 0], [0.2, 2.5, 10]));
  }
  const recipe = { ...room({ keyColor: [3, 3, 3], floorSkyTrace: false }), nodes };
  recipe.camera = { eye: [0, 1.5, 9], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 };
  return recipe;
}

for (const panels of [false, true]) {
  test(`a low wall ${panels ? 'split into panels' : 'of one piece'} keeps the fine cut and all its rays while a stool is a prop`, () => {
    const { parts } = createAgentScene(lowOpenSet({ panels }));
    const { report } = applyDefaultFloorSky(parts, { keyColor: [3, 3, 3] }, { maximumTexels: 4000 });
    assert.equal(report.branch, 'open-sided room, every surface traced');
    assert.ok(report.reducedParts.includes('stool'), 'the stool is a prop');
    const walls = parts.filter(part => part.name.startsWith('wall-')).map(part => part.name);
    assert.ok(walls.length >= 3);
    for (const wall of walls) assert.ok(!report.reducedParts.includes(wall), `${wall} is not a prop`);
    assert.ok(!report.reducedParts.includes('floor') && !report.reducedParts.includes('ceiling'));
    // The cut edge and the rays per point of each part, as the trace used them: the stool is cut at four times the walls' edge with half the rays.
    const perPart = new Map(report.floors.map(floor => [floor.name, floor]));
    const stool = perPart.get('stool');
    const fullRayParts = [...walls, 'floor', 'ceiling'];
    for (const name of fullRayParts) {
      assert.equal(perPart.get(name).raysPerPoint, 64, `${name} keeps all its rays`);
      assert.equal(perPart.get(name).maximumEdge, perPart.get('floor').maximumEdge, `${name} keeps the fine cut`);
    }
    assert.equal(stool.raysPerPoint, 32);
    assert.equal(stool.maximumEdge, perPart.get('floor').maximumEdge * 4);
  });
}

test('a sky trace that stops at its time limit shows in the scene diagnostics of an open-sided set', () => {
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  delete recipe.bake;
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'organiser');
  recipe.geometries = recipe.geometries.filter(geometry => geometry.id !== 'organiser');
  recipe.nodes.find(node => node.id === 'pendant-bulb').translation = [0.3, 1.7, 0.2];
  const hasStoppedTrace = scene => (scene.inspect().diagnostics ?? []).some(diagnostic => diagnostic.kind === 'sky-trace-stopped');
  const normal = createAgentScene(structuredClone(recipe));
  assert.equal(lastDefaultFloorSkyReport().branch, 'open-sided room, every surface traced');
  assert.deepEqual(lastDefaultFloorSkyReport().warnings, []);
  assert.equal(hasStoppedTrace(normal), false);
  // A clock that jumps 30 s per read stands in for a slow machine, so the limit of 20 s is passed on the first vertex.
  const realNow = performance.now;
  let fakeNow = 0;
  performance.now = () => (fakeNow += 30_000);
  let stopped;
  try {
    stopped = createAgentScene(structuredClone(recipe));
  } finally {
    performance.now = realNow;
  }
  assert.equal(lastDefaultFloorSkyReport().reason, 'passed maxSeconds');
  const diagnostic = stopped.inspect().diagnostics.find(entry => entry.kind === 'sky-trace-stopped');
  assert.ok(diagnostic, 'scene_inspect names the stopped trace');
  assert.equal(diagnostic.severity, 'warning');
  assert.match(diagnostic.message, /time limit of 20 s.*plain/);
  assert.match(diagnostic.fix, /maxSeconds.*maximumTexels.*floorSkyTrace/);
  // The next build that finishes in time clears it.
  const again = createAgentScene(structuredClone(recipe));
  assert.equal(hasStoppedTrace(again), false);
});

// #3433: five thin boxes over 8 by 10 m with no prop in them. The open-sided cut is twice as fine for walls, ceiling and floor, and with nothing to take the budget it came to 17 million
// rays, so the trace was skipped and the ground stayed plain. It is cut coarser until it fits instead.
function fiveThinSlabs() {
  const slab = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  const nodes = [
    slab('floor', [0, -0.05, 0], [8, 0.1, 10]),
    slab('wall-back', [0, 1.5, -5], [8, 3, 0.1]),
    slab('wall-left', [-4, 1.5, 0], [0.1, 3, 10]),
    slab('wall-right', [4, 1.5, 0], [0.1, 3, 10]),
    slab('ceiling', [0, 3.05, 0], [8.2, 0.1, 10.2]),
  ];
  return { ...room({ keyColor: [3, 3, 3] }), nodes, camera: { eye: [0, 1.5, 9], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 } };
}

test('a bare open set of five thin slabs is cut coarser and traced within the ray limit', () => {
  const scene = createAgentScene(fiveThinSlabs());
  const report = lastDefaultFloorSkyReport();
  assert.equal(report.branch, 'open-sided room, every surface traced');
  assert.equal(report.reason, null);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.edgeScale > 1, `the trace was cut coarser (edge scale ${report.edgeScale})`);
  assert.ok(report.rays <= 4_500_000, `the trace shot ${report.rays} rays`);
  assert.ok(report.rays >= 1_000_000, `the trace shot only ${report.rays} rays, coarser than it needs`);
  assert.ok(scene.parts.find(part => part.name === 'wall-back').geometry.skyVisibility, 'the wall carries the trace');
  assert.equal(scene.inspect().diagnostics?.some(diagnostic => diagnostic.kind === 'sky-trace-stopped') ?? false, false);
});

test('a trace that stays over the ray limit says so in a scene diagnostic with what to change', () => {
  const { parts } = createAgentScene({ ...fiveThinSlabs(), environment: { keyColor: [3, 3, 3], floorSkyTrace: false } });
  const { report } = applyDefaultFloorSky(parts, { keyColor: [3, 3, 3] }, { maximumTexels: 400, maximumRays: 100 });
  assert.equal(report.reason, 'too many rays');
  assert.equal(report.rays, 0);
  const [problem] = skyTraceProblems(report);
  assert.equal(problem.kind, 'sky-trace-stopped');
  assert.equal(problem.severity, 'warning');
  assert.match(problem.message, /more than 100 rays.*coarser cuts.*plain/);
  assert.doesNotMatch(problem.message, /floorSkyTrace/);
  assert.match(problem.fix, /fewer ones.*floorSkyTrace false/);
});
