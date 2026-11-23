import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { oceanMesh } from '../src/mesh-ocean-modifier.js';
import { registerModifierRunner } from '../src/mesh-modifiers.js';
import { createMeshSource } from '../src/particle-emitter-mesh.js';

// A spray emitter on a big sea that an oceanTime track moves must bake in seconds, not past the 30 s preview limit (#2823).

// The ocean times the modifier is asked to build, seen through the same runner the scene uses.
function recordOceanTimes(build) {
  const times = [];
  registerModifierRunner('ocean', (mesh, edit) => {
    times.push(edit.time);
    return { mesh: oceanMesh(mesh, edit), result: {} };
  });
  try {
    build();
  } finally {
    registerModifierRunner('ocean', (mesh, edit) => ({ mesh: oceanMesh(mesh, edit), result: {} }));
  }
  return times;
}

const STEP = 1 / 24;

test('a sea of 75,000 vertices is built at every 4th 1/24 s, not at all of them', () => {
  const times = recordOceanTimes(() => createAgentScene(bigSeaRecipe('vertices', 13, 3)));
  const distinct = [...new Set(times)];
  assert.ok(distinct.length <= 96 / 4 + 4, `${distinct.length} ocean times built; 1/24 s steps would build about 96`);
  const snapped = distinct.filter(time => time > 0 && Math.abs(time / (4 * STEP) - Math.round(time / (4 * STEP))) < 1e-9);
  assert.ok(snapped.length >= distinct.length - 2, 'the built times sit on multiples of 4/24 s');
});

test('a small sea is still built at every 1/24 s', () => {
  const times = recordOceanTimes(() => createAgentScene(bigSeaRecipe('vertices', 1)));
  assert.ok(new Set(times).size >= 40, `${new Set(times).size} ocean times built`);
});

function bigSeaRecipe(from, cuts = 7, levels = 2) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'subdivide_edges', edges: { all: true }, cuts }, { op: 'subdivide', levels }, { op: 'transform_selection', select: { all: true }, scale: [140, 1, 140] }],
        stack: [{ op: 'ocean', windSpeed: 6, choppiness: 0.8, size: 40, seed: 11, resolution: 6, spray: true }] },
      { id: 'drop', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'water' }],
    nodes: [{ id: 'surface', geometry: 'sea', material: 'water' }, { id: 'droplet', geometry: 'drop', material: 'water', scale: [0.05, 0.05, 0.05] }],
    particles: { systems: [{ node: 'droplet', count: 200, rate: 50, speed: [0, 1], lifetime: [0.6, 1.4], size: 0.02,
      emitter: { shape: 'mesh', mesh: 'surface', from, group: 'spray', groupThreshold: 0.25, velocityFrom: 'spray' } }] },
    motion: { duration: 4, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 4 }] }] },
  };
}

function dropletPositions(scene) {
  scene.sampleMotion(3.5);
  return Array.from(scene.parts.find(part => part.name === 'droplet').geometry.positions);
}

test('a vertices emitter on a sea over 8192 triangles builds, and gives the same droplets every run', () => {
  const first = dropletPositions(createAgentScene(bigSeaRecipe('vertices')));
  assert.equal(first.length / 3, 200 * 24);
  assert.ok(first.some(value => Math.abs(value) > 1), 'droplets are born on the sea');
  assert.deepEqual(dropletPositions(createAgentScene(bigSeaRecipe('vertices'))), first);
});

test('a surface emitter still stops at the triangle limit and says what to use', () => {
  assert.throws(() => createAgentScene(bigSeaRecipe('surface')), /at most 8192 triangles/);
});

test('a vertices source over a big mesh counts its triangles without building them', () => {
  const vertexCount = 30_000;
  const positions = new Float32Array(vertexCount * 3).map((_, index) => index % 7);
  const indices = Uint32Array.from({ length: (vertexCount - 2) * 3 }, (_, index) => Math.floor(index / 3) + (index % 3));
  const source = createMeshSource(positions, new Float32Array(positions.length), indices, 'vertices');
  assert.equal(source.triangleCount, vertexCount - 2);
});
