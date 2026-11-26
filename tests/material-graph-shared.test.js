import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bakeMaterialGraph, checkMaterialGraphWork, compileMaterialGraph, graphSurfaceSettings, surfaceMapKey } from '../src/material-graph.js';
import { MATERIAL_GRAPH_LIMITS } from '../src/material-name-lists.js';
import { normalMapFromHeightFunction } from '../src/material-texture-kit.js';

const SLOPE = { surface: { output: 'slope' } };
const MASK = { smoothstep: [0.2, 0.6, { add: [{ noise: { scale: 6, seed: 1, octaves: 3 } }, { mul: [{ uv: 'u' }, 0.3] }] }] };
const MASK_WITH_SLOPE = { smoothstep: [0.2, 0.6, { add: [{ invert: SLOPE }, { mul: [{ noise: { scale: 6, seed: 1, octaves: 3 } }, 0.3] }] }] };

const gatedByMask = mask => ({
  color: { layer: { base: [0.1, 0.1, 0.1], top: [0.9, 0.9, 1], mask, edge: 0.5, softness: 0.1 } },
  roughness: { mix: [0.95, 0.3, mask] },
  height: { mul: [mask, { noise: { scale: 10, octaves: 2 } }] },
});
const costOf = graph => compileMaterialGraph(graph).cost;

// Every graph pays the fixed per-pixel cost once (2.5 units).
const PIXEL_COST = 2.5;

test('a mask used by colour and roughness is costed once, and the bump still pays for each of its two reads', () => {
  const full = gatedByMask(MASK);
  const separate = ['color', 'roughness', 'height'].map(output => costOf({ [output]: full[output] }));
  const maskCost = costOf({ roughness: MASK }) - PIXEL_COST;
  // Colour and roughness share one evaluation of the mask. The height does not: its two shifted reads each work the mask out again.
  const expected = separate.reduce((sum, cost) => sum + cost, 0) - maskCost - 2 * PIXEL_COST;
  assert.ok(Math.abs(costOf(full) - expected) < 1e-9, `${costOf(full)} against ${expected}`);
});

test('a shared mask counts once toward the node limit', () => {
  const crowdedMask = { smoothstep: [0.2, 0.6, { add: [{ noise: { scale: 6 } }, { noise: { scale: 9 } }] }] };
  const outputs = {};
  for (const name of ['color', 'roughness', 'metallic', 'height', 'opacity']) outputs[name] = { mix: [0.1, 0.9, { mul: [crowdedMask, { add: [crowdedMask, 1] }] }] };
  const compiled = compileMaterialGraph(outputs);
  assert.ok(compiled.nodeCount < 30, `${compiled.nodeCount} nodes`);
});

test('every output reads one evaluation of a shared mask per texel', () => {
  let reads = 0;
  const data = new Proxy(new Uint8ClampedArray(4 * 4 * 4).fill(120), {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return target[key];
    },
  });
  const countReads = graph => {
    reads = 0;
    const groups = new Map(graphSurfaceSettings(graph).map(settings => [surfaceMapKey(settings), { width: 4, height: 4, data }]));
    bakeMaterialGraph(graph, { resolution: 8, bump: 1 }, undefined, groups);
    return reads;
  };
  const once = countReads({ roughness: { mix: [0.9, 0.3, MASK_WITH_SLOPE] } });
  const threeOutputs = countReads({ color: { mix: [[0.1, 0.1, 0.1], [0.9, 0.9, 1], MASK_WITH_SLOPE] }, roughness: { mix: [0.9, 0.3, MASK_WITH_SLOPE] }, metallic: MASK_WITH_SLOPE });
  assert.ok(once > 0);
  assert.equal(threeOutputs, once);
});

test('the cost of a noise follows its octaves', () => {
  const costWith = octaves => costOf({ roughness: { noise: { scale: 6, octaves } } });
  assert.equal(Math.round((costWith(4) - costWith(1)) * 100), 570);
  assert.equal(Math.round((costWith(6) - costWith(2)) * 100), 760);
});

test('a graph nested past the depth limit still fails with the nesting error', () => {
  let graph = 0.5;
  for (let level = 0; level < 600; level++) graph = { abs: graph };
  assert.throws(() => compileMaterialGraph({ height: graph }), /nesting deeper/);
});

// Sixteen hex digits of the SHA-256 of every baked map. The values were taken from main before sharing existed (#3147),
// so a graph that shares a subgraph must still bake the same bytes.
const GOLDEN_GRAPHS = {
  gatedSnow: [gatedByMask(MASK), '29140dd066ef9f52'],
  vectorShared: [{
    color: { mix: [{ vec: [MASK, 0.2, 0.1] }, { vec: [0.1, MASK, 0.4] }, MASK] },
    aov: { vec: [MASK, MASK, 0.5] },
    metallic: { sub: [1, MASK] },
  }, 'f9ef1a40e974e162'],
  negativeZero: [{ roughness: { add: [{ add: [{ div: [1, 0] }, { div: [1, -0] }] }, { noise: { scale: 3 } }] } }, '353de6593f380c11'],
};

function bakedDigest(graph) {
  const maps = bakeMaterialGraph(graph, { resolution: 64, bump: 3 });
  const hash = createHash('sha256');
  for (const descriptor of [maps.map, maps.metallicRoughnessMap, maps.layerMaps?.clearcoatTexture, maps.aovMap, maps.normalMap]) {
    hash.update(descriptor ? Buffer.from(descriptor.image.data) : 'none');
  }
  return hash.digest('hex').slice(0, 16);
}

for (const [name, [graph, digest]] of Object.entries(GOLDEN_GRAPHS)) {
  test(`${name} bakes the same bytes as before subgraphs were shared`, () => {
    assert.equal(bakedDigest(graph), digest);
  });
}

test('snow gated fits within the 1024 work budget with two-read bump caching (#3147)', () => {
  for (const mask of [MASK, MASK_WITH_SLOPE]) {
    const compiled = compileMaterialGraph(gatedByMask(mask));
    assert.ok(compiled.cost * 1024 * 1024 <= MATERIAL_GRAPH_LIMITS.maxWork, `${compiled.cost * 1024 * 1024} over ${MATERIAL_GRAPH_LIMITS.maxWork}`);
    assert.doesNotThrow(() => checkMaterialGraphWork(compiled, 1024));
  }
});

test('normalMapFromHeightFunction caches adjacent edges and matches four-read golden hashes (#3147)', () => {
  const compiled = compileMaterialGraph({ height: gatedByMask(MASK).height });
  const goldenNormalDigests = {
    64: '2f9186a00342511459f2eef8107d1f060f52b5865c9ba4df62226164b84790aa',
    256: 'd9cc864ad410837d81828d8f58552e178cda3004caef52db8c211dba85931e6c',
    512: '56dfd8d32769347c7e99578f1b41960c83240c8ad2e5fabb47592d3dc7a9af77',
  };
  for (const [resolutionText, expectedDigest] of Object.entries(goldenNormalDigests)) {
    const resolution = Number(resolutionText);
    let calls = 0;
    const bytes = normalMapFromHeightFunction((u, v) => {
      calls++;
      return compiled.outputs.height.evaluate(u, v);
    }, resolution, 3);
    assert.equal(calls, 2 * resolution * resolution + 2 * resolution);
    const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    assert.equal(digest, expectedDigest);
  }
});

test('height shares cost and node count symmetrically with outputs before and after it (#3147)', () => {
  const colorAndHeight = compileMaterialGraph({ color: MASK, height: MASK });
  for (const other of ['roughness', 'metallic', 'opacity', 'clearcoat', 'transmission']) {
    const paired = compileMaterialGraph({ height: MASK, [other]: MASK });
    assert.ok(Math.abs(paired.cost - colorAndHeight.cost) < 1e-9, `${other}: ${paired.cost} against ${colorAndHeight.cost}`);
    assert.equal(paired.nodeCount, colorAndHeight.nodeCount, `${other} nodeCount`);
  }
  const nestedBefore = compileMaterialGraph({ color: MASK, height: { mix: [MASK, MASK, 0.5] } });
  const nestedAfter = compileMaterialGraph({ height: { mix: [MASK, MASK, 0.5] }, clearcoat: MASK });
  assert.ok(Math.abs(nestedAfter.cost - nestedBefore.cost) < 1e-9, `${nestedAfter.cost} against ${nestedBefore.cost}`);
  assert.equal(nestedAfter.nodeCount, nestedBefore.nodeCount);
});

test('plain objects with the same keys in a different order share one subgraph (#3147)', () => {
  const sameOrder = compileMaterialGraph({ color: { noise: { scale: 6, seed: 1 } }, roughness: { noise: { scale: 6, seed: 1 } } });
  const swappedOrder = compileMaterialGraph({ color: { noise: { scale: 6, seed: 1 } }, roughness: { noise: { seed: 1, scale: 6 } } });
  assert.equal(swappedOrder.cost, sameOrder.cost);
  assert.equal(swappedOrder.nodeCount, sameOrder.nodeCount);
  const single = compileMaterialGraph({ roughness: { noise: { scale: 6, seed: 1 } } });
  assert.equal(swappedOrder.nodeCount, single.nodeCount);
});

test('nested shared subgraphs keep nodeCount bounded and still enforce maxDepth at reuse sites (#3147)', () => {
  let dag = { noise: { scale: 4, octaves: 1 } };
  for (let level = 0; level < 6; level++) dag = { add: [dag, dag] };
  const single = compileMaterialGraph({ color: dag });
  const shared = compileMaterialGraph({ color: dag, roughness: dag });
  assert.equal(single.nodeCount, 7);
  assert.equal(shared.nodeCount, single.nodeCount);
  assert.ok(Math.abs(shared.cost - single.cost) < 1e-9);

  // Inner shared node compiled at depth 0, then wrapped and reused past maxDepth.
  const inner = { abs: { abs: 0.5 } };
  const outer = { abs: inner };
  let deepOk = outer;
  for (let level = 0; level < MATERIAL_GRAPH_LIMITS.maxDepth - 3; level++) deepOk = { abs: deepOk };
  assert.doesNotThrow(() => compileMaterialGraph({ metallic: inner, color: outer, roughness: deepOk }));
  assert.throws(
    () => compileMaterialGraph({ metallic: inner, color: outer, roughness: { abs: deepOk } }),
    /nesting deeper than 12/,
  );
});

test('colour ramp and scalar warp evaluate their scalar input once per texel (#3147)', () => {
  let reads = 0;
  const data = new Proxy(new Uint8ClampedArray(4 * 4 * 4).fill(120), {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return target[key];
    },
  });
  const surfaceNode = { surface: { output: 'slope' } };
  const groups = new Map([[surfaceMapKey({ output: 'slope', space: 'world' }), { width: 4, height: 4, data }]]);
  const scalarRamp = { roughness: { ramp: { value: surfaceNode, stops: [[0, 0.2], [1, 0.9]] } } };
  const colorRamp = { color: { ramp: { value: surfaceNode, stops: [[0, [0.1, 0.2, 0.3]], [1, [0.8, 0.9, 1]]] } } };
  reads = 0;
  bakeMaterialGraph(scalarRamp, { resolution: 8, bump: 1 }, undefined, groups);
  const scalarReads = reads;
  reads = 0;
  bakeMaterialGraph(colorRamp, { resolution: 8, bump: 1 }, undefined, groups);
  assert.equal(reads, scalarReads);

  const warped = { roughness: { noise: { scale: 4, octaves: 1, warp: { node: surfaceNode, strength: 0.5 } } } };
  reads = 0;
  bakeMaterialGraph(warped, { resolution: 8, bump: 1 }, undefined, groups);
  assert.equal(reads, scalarReads);
});

test('snow-on-mountain graph with shared slope, height, fine noise and sparkle fits at 1024 (#3147)', () => {
  const height = { surface: { output: 'height', space: 'world', range: [0, 10] } };
  const macroNoise = { noise: { scale: 6, seed: 1, octaves: 2 } };
  const fineNoise = { noise: { scale: 32, seed: 2, octaves: 1 } };
  const sparkle = { whiteNoise: { scale: 64, seed: 3 } };
  const snowMask = {
    smoothstep: [0.35, 0.55, {
      add: [
        { invert: SLOPE },
        { add: [
          { mul: [{ sub: [macroNoise, 0.5] }, 0.3] },
          { add: [{ mul: [{ sub: [fineNoise, 0.5] }, 0.15] }, { mul: [height, 0.2] }] },
        ] },
      ],
    }],
  };
  const mountainGraph = {
    color: {
      mix: [
        { mix: [[0.18, 0.16, 0.14], [0.32, 0.29, 0.25], macroNoise] },
        { mix: [[0.85, 0.9, 0.96], [1, 1, 1], { mul: [sparkle, 0.3] }] },
        snowMask,
      ],
    },
    roughness: { mix: [0.92, { mix: [0.55, 0.15, { smoothstep: [0.92, 0.99, sparkle] }] }, snowMask] },
    height: { mix: [macroNoise, { mul: [fineNoise, 0.2] }, snowMask] },
  };
  const compiled = compileMaterialGraph(mountainGraph);
  assert.ok(compiled.nodeCount <= MATERIAL_GRAPH_LIMITS.maxNodes, `${compiled.nodeCount} nodes`);
  assert.ok(compiled.cost * 1024 * 1024 <= MATERIAL_GRAPH_LIMITS.maxWork, `${compiled.cost * 1024 * 1024} over ${MATERIAL_GRAPH_LIMITS.maxWork}`);
  assert.doesNotThrow(() => checkMaterialGraphWork(compiled, 1024));
});
