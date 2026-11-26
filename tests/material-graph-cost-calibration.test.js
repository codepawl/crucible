import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMaterialGraph, WORK_UNIT_NANOSECONDS } from '../src/material-graph.js';
import { MATERIAL_GRAPH_LIMITS } from '../src/agent-scene-capabilities.js';

const noise = (scale, octaves, extra = {}) => ({ noise: { scale, seed: 1, octaves, ...extra } });

// Real bake times at 512 by 512 in Node, the median of 9 runs with the graphs interleaved (#3147, re-measured with 2-read bump edge caching).
// They are fixed here so the test needs no clock: it checks that the cost table still tracks them.
const MEASURED = [
  { name: 'noise colour', nanosecondsPerPixel: 322, graph: { color: { mix: [[0.1, 0.1, 0.1], [0.9, 0.8, 0.7], noise(6, 4)] } } },
  { name: 'four octave bump', nanosecondsPerPixel: 448, graph: { height: noise(10, 4) } },
  { name: 'smooth voronoi', nanosecondsPerPixel: 528, graph: { roughness: { voronoi: { scale: 8, output: 'smoothF1' } } } },
  {
    name: 'rust with warp',
    nanosecondsPerPixel: 1182,
    graph: {
      color: { mix: [[0.3, 0.1, 0.05], [0.6, 0.3, 0.1], noise(8, 6)] },
      roughness: { add: [0.5, { mul: [0.3, noise(12, 3, { warp: { node: noise(3, 2), strength: 1 } })] }] },
      height: noise(16, 3),
    },
  },
  {
    name: 'hue of a ramp',
    nanosecondsPerPixel: 620,
    graph: {
      color: { hue: { color: { ramp: { value: noise(5, 2), stops: [[0, [0.1, 0.2, 0.7]], [1, [0.9, 0.4, 0.1]]] } }, shift: 0.3 } },
      roughness: { curve: { value: noise(7, 2), points: [[0, 0.2], [0.5, 0.9], [1, 0.4]] } },
    },
  },
];

test('work units stay proportional to measured bake time (#3147)', () => {
  const nanosecondsPerUnit = MEASURED.map(({ graph, nanosecondsPerPixel }) => nanosecondsPerPixel / compileMaterialGraph(graph).cost);
  const spread = Math.max(...nanosecondsPerUnit) / Math.min(...nanosecondsPerUnit);
  assert.ok(spread < 1.7, `ns per unit ranges ${nanosecondsPerUnit.map(value => value.toFixed(1)).join(', ')}, a spread of ${spread.toFixed(2)}`);
  const middle = [...nanosecondsPerUnit].sort((first, second) => first - second)[Math.floor(nanosecondsPerUnit.length / 2)];
  assert.ok(Math.abs(middle - WORK_UNIT_NANOSECONDS) < WORK_UNIT_NANOSECONDS * 0.4, `the middle graph takes ${middle.toFixed(1)} ns a unit, not about ${WORK_UNIT_NANOSECONDS}`);
});

test('a height field is charged for the two reads of its bump', () => {
  const flat = compileMaterialGraph({ roughness: noise(10, 2) }).cost;
  const bumped = compileMaterialGraph({ height: noise(10, 2) }).cost;
  // The bump reads the field twice, so one more read of two octaves (node 0.1 + 2 x 1.9), plus 2.5 for the slope normalize.
  assert.equal(Math.round((bumped - flat) * 100), 1 * 390 + 250);
});

test('the budget is about two seconds of baking', () => {
  assert.equal(MATERIAL_GRAPH_LIMITS.maxWork, 60_000_000);
  assert.ok(MATERIAL_GRAPH_LIMITS.maxWork * WORK_UNIT_NANOSECONDS / 1e9 < 2.5);
});
