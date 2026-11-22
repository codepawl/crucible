import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { blenderNoise, compileMaterialGraph } from '../src/material-graph.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const SAMPLES_PER_SIDE = 64;

function evaluatorOf(node) {
  return compileMaterialGraph({ height: node }).outputs.height.evaluate;
}

function sampleGrid(evaluate) {
  const values = new Float64Array(SAMPLES_PER_SIDE * SAMPLES_PER_SIDE);
  for (let row = 0; row < SAMPLES_PER_SIDE; row++) {
    for (let column = 0; column < SAMPLES_PER_SIDE; column++) {
      values[row * SAMPLES_PER_SIDE + column] = evaluate((column + 0.5) / SAMPLES_PER_SIDE, (row + 0.5) / SAMPLES_PER_SIDE);
    }
  }
  return values;
}

function meanAbsoluteDifference(first, second) {
  let total = 0;
  for (let index = 0; index < first.length; index++) total += Math.abs(first[index] - second[index]);
  return total / first.length;
}

test('graphs that use no new noise field evaluate to the same numbers as before #2856', () => {
  // Hash of the Float64 values of these graphs on a 64 by 64 grid, taken from origin/main before the change.
  const graphs = [
    { noise: { scale: 8, seed: 3, octaves: 5 } },
    { noise: { scale: 10, octaves: 3, tile: false } },
    { noise: { scale: 6, seed: 1, octaves: 4, at: { mul: [{ uv: 'both' }, 2] } } },
  ];
  const hash = createHash('sha256');
  for (const graph of graphs) hash.update(Buffer.from(sampleGrid(evaluatorOf(graph)).buffer));
  assert.equal(hash.digest('hex'), 'c7d0bcfd54fcba03af8547b1b15fb4c0f40dd2f99bed351454b1ba78a94ad253');
});

test('naming the default kind, lacunarity and gain changes nothing', () => {
  const plain = sampleGrid(evaluatorOf({ noise: { scale: 6, octaves: 4 } }));
  const explicit = sampleGrid(evaluatorOf({ noise: { scale: 6, octaves: 4, kind: 'fbm', lacunarity: 2, gain: 0.5 } }));
  assert.deepEqual(explicit, plain);
});

test('ridged and billow noise stay in 0 to 1 and differ from fbm and from each other', () => {
  const grids = {};
  for (const kind of ['fbm', 'ridged', 'billow']) {
    grids[kind] = sampleGrid(evaluatorOf({ noise: { scale: 6, octaves: 4, kind } }));
    for (const value of grids[kind]) assert.ok(value >= 0 && value <= 1, `${kind} value ${value}`);
  }
  assert.ok(meanAbsoluteDifference(grids.fbm, grids.ridged) > 0.05);
  assert.ok(meanAbsoluteDifference(grids.fbm, grids.billow) > 0.05);
  assert.ok(meanAbsoluteDifference(grids.ridged, grids.billow) > 0.05);
});

test('a ridged noise peaks where the plain noise crosses zero and a billow where it peaks', () => {
  const tileCells = 6;
  const signed = blenderNoise(1.3, 2.7, 1, tileCells) * 2 - 1;
  const ridged = blenderNoise(1.3, 2.7, 1, tileCells, { kind: 'ridged' });
  const billow = blenderNoise(1.3, 2.7, 1, tileCells, { kind: 'billow' });
  assert.ok(Math.abs(billow - Math.abs(signed)) < 1e-9);
  assert.ok(Math.abs(ridged - (1 - Math.abs(signed)) ** 2) < 1e-9);
});

test('lacunarity and gain change the detail, and a gain of 0 leaves the first octave alone', () => {
  const base = sampleGrid(evaluatorOf({ noise: { scale: 4, octaves: 5 } }));
  const sharper = sampleGrid(evaluatorOf({ noise: { scale: 4, octaves: 5, gain: 0.9 } }));
  const wider = sampleGrid(evaluatorOf({ noise: { scale: 4, octaves: 5, lacunarity: 3 } }));
  assert.ok(meanAbsoluteDifference(base, sharper) > 0.005);
  assert.ok(meanAbsoluteDifference(base, wider) > 0.005);
  const singleOctave = sampleGrid(evaluatorOf({ noise: { scale: 4, octaves: 1 } }));
  const noGain = sampleGrid(evaluatorOf({ noise: { scale: 4, octaves: 5, gain: 0 } }));
  assert.ok(meanAbsoluteDifference(singleOctave, noGain) < 1e-12);
});

test('every kind tiles at a lacunarity that is not a whole number', () => {
  for (const kind of ['fbm', 'ridged', 'billow']) {
    const evaluate = evaluatorOf({ noise: { scale: 5, octaves: 4, kind, lacunarity: 2.5 } });
    for (const [u, v] of [[0.13, 0.4], [0.5, 0.77], [0.91, 0.02]]) {
      assert.ok(Math.abs(evaluate(u, v) - evaluate(u + 1, v + 2)) < 1e-9, `${kind} at ${u}, ${v}`);
    }
  }
});

test('noise kind, lacunarity and gain errors say what failed and what to pass', () => {
  assert.throws(() => evaluatorOf({ noise: { kind: 'perlin' } }), /noise kind must be one of fbm, ridged, billow/);
  assert.throws(() => evaluatorOf({ noise: { lacunarity: 0.5 } }), /noise lacunarity must be a number from 1 to 4, got 0.5/);
  assert.throws(() => evaluatorOf({ noise: { lacunarity: 5 } }), /noise lacunarity must be a number from 1 to 4/);
  assert.throws(() => evaluatorOf({ noise: { lacunarity: '2' } }), /noise lacunarity must be a number from 1 to 4/);
  assert.throws(() => evaluatorOf({ noise: { gain: -0.1 } }), /noise gain must be a number from 0 to 1/);
  assert.throws(() => evaluatorOf({ noise: { gain: 1.5 } }), /noise gain must be a number from 0 to 1, got 1.5/);
  assert.doesNotThrow(() => evaluatorOf({ noise: { lacunarity: 1, gain: 0 } }));
  assert.doesNotThrow(() => evaluatorOf({ noise: { lacunarity: 4, gain: 1 } }));
});

test('a warp moves the lookup of a noise, a wave and a vector-driven checker', () => {
  const warper = { noise: { scale: 3, seed: 7 } };
  const plain = sampleGrid(evaluatorOf({ wave: { frequency: 4, direction: 'u' } }));
  const warped = sampleGrid(evaluatorOf({ wave: { frequency: 4, direction: 'u', warp: { node: warper, strength: 1 } } }));
  assert.ok(meanAbsoluteDifference(plain, warped) > 0.05);
  const noWarp = sampleGrid(evaluatorOf({ noise: { scale: 6 } }));
  const zeroStrength = sampleGrid(evaluatorOf({ noise: { scale: 6, warp: { node: warper, strength: 0 } } }));
  assert.deepEqual(zeroStrength, noWarp);
  const vectorWarp = { node: { vec: [{ noise: { scale: 3, seed: 1 } }, { noise: { scale: 3, seed: 2 } }, 0] }, strength: 1 };
  const checkerPlain = sampleGrid(evaluatorOf({ checker: { count: 8 } }));
  const checkerWarped = sampleGrid(evaluatorOf({ checker: { count: 8, warp: vectorWarp } }));
  assert.ok(meanAbsoluteDifference(checkerPlain, checkerWarped) > 0.05);
});

test('a warped texture still tiles, because the warp node is periodic', () => {
  const evaluate = evaluatorOf({ noise: { scale: 6, warp: { node: { noise: { scale: 3 } }, strength: 2 } } });
  for (const [u, v] of [[0.2, 0.3], [0.6, 0.9]]) {
    assert.ok(Math.abs(evaluate(u, v) - evaluate(u + 1, v + 1)) < 1e-9);
  }
});

test('a warp costs its node and two work units, and is held to the node limits', () => {
  const plainCost = compileMaterialGraph({ height: { noise: { scale: 6 } } }).cost;
  const warpedCost = compileMaterialGraph({ height: { noise: { scale: 6, warp: { node: 0.5 } } } }).cost;
  assert.equal(warpedCost - plainCost, 3);
  assert.equal(compileMaterialGraph({ height: { noise: { warp: { node: 0.5 } } } }).nodeCount, 2);
});

test('warp errors say what failed and what to pass', () => {
  assert.throws(() => evaluatorOf({ noise: { warp: 1 } }), /warp takes \{ node, strength \}/);
  assert.throws(() => evaluatorOf({ noise: { warp: { strength: 1 } } }), /warp needs "node"/);
  assert.throws(() => evaluatorOf({ noise: { warp: { node: 0.5, amount: 1 } } }), /warp does not take "amount"; fields: node, strength/);
  assert.throws(() => evaluatorOf({ noise: { warp: { node: 0.5, strength: 5 } } }), /warp strength must be a number from 0 to 4 \(tiles\), got 5/);
  assert.throws(() => evaluatorOf({ noise: { warp: { node: 0.5, strength: -1 } } }), /warp strength must be a number from 0 to 4/);
  assert.throws(() => evaluatorOf({ noise: { warp: { node: { glow: 1 } } } }), /unknown operator "glow"/);
});

test('every position-reading texture node takes a warp, and vertexGroup does not', () => {
  const warp = { node: { noise: { scale: 2 } }, strength: 1 };
  const nodes = [
    { noise: { warp } }, { voronoi: { warp } }, { wave: { warp } }, { checker: { warp } }, { gradient: { warp } },
    { brick: { warp } }, { whiteNoise: { warp } },
  ];
  for (const node of nodes) assert.doesNotThrow(() => evaluatorOf(node), Object.keys(node)[0]);
  assert.throws(() => evaluatorOf({ vertexGroup: { name: 'edge', warp } }), /does not take "warp"/);
});

test('scene_capabilities describes the noise kinds, lacunarity, gain and warp', () => {
  const { nodes } = AGENT_SCENE_CAPABILITIES.materialGraph;
  for (const word of ['ridged', 'billow', 'lacunarity', 'gain']) assert.ok(nodes.textures.noise.includes(word), word);
  assert.ok(nodes.textures.note.includes('warp'));
});
