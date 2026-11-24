import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sphere } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { compileField, evaluateField, meshFieldContext, validateField } from '../src/mesh-fields.js';

// Mesh `displace` takes the noise kinds and the voronoi of the material graph (#3203).

// Loaded on demand so that, with the change reverted, each test fails at its own assertion instead of at import.
const loadVoronoi = () => import('../src/field-voronoi.js').catch(() => ({ cellularNoise3: () => ({}), VORONOI_OUTPUTS: ['distance', 'edge', 'cell', 'f2', 'f2MinusF1', 'smoothF1'] }));

const rock = () => meshFromGeometry(sphere(24, 12));
const displaced = field => applyMeshEdits(rock(), [{ op: 'displace', field, strength: 0.3 }]).mesh;
const digestOf = mesh => createHash('sha256').update(Buffer.from(mesh.positions.buffer)).digest('hex').slice(0, 16);
const valuesOf = expression => evaluateField(expression, meshFieldContext(rock(), 'point')).values;

test('recipes written before the noise kinds give the bytes they gave on main', () => {
  // Digests taken on origin/main before this change.
  assert.equal(digestOf(displaced({ noise: { scale: 3, seed: 7 } })), '1fb5d4f10616ab29');
  assert.equal(digestOf(displaced({ noise: { scale: 3, seed: 7, octaves: 4 } })), '24be1e098b4dfaf7');
  const worked = { mul: [{ abs: { sub: [{ noise: { scale: 2, seed: 3, octaves: 2 } }, 0.5] } }, 2] };
  assert.equal(digestOf(displaced(worked)), '0a31a40d2fd98692');
  const explicitDefaults = { noise: { scale: 3, seed: 7, kind: 'fbm', lacunarity: 2, gain: 0.5 } };
  assert.equal(digestOf(displaced(explicitDefaults)), '1fb5d4f10616ab29');
});

test('ridged and billow noise displace a mesh, byte for byte on every run', () => {
  const ridged = { noise: { scale: 3, seed: 7, octaves: 4, kind: 'ridged' } };
  const billow = { noise: { scale: 3, seed: 7, octaves: 4, kind: 'billow' } };
  const plain = { noise: { scale: 3, seed: 7, octaves: 4 } };
  assert.equal(digestOf(displaced(ridged)), digestOf(displaced(ridged)));
  assert.equal(digestOf(displaced(billow)), digestOf(displaced(billow)));
  assert.equal(new Set([plain, ridged, billow].map(field => digestOf(displaced(field)))).size, 3);
  const steeper = { noise: { scale: 3, seed: 7, octaves: 4, kind: 'ridged', gain: 0.8, lacunarity: 3 } };
  assert.notEqual(digestOf(displaced(steeper)), digestOf(displaced(ridged)));
});

test('every noise kind stays in 0 to 1', () => {
  for (const kind of ['fbm', 'ridged', 'billow']) {
    const values = valuesOf({ noise: { scale: 5, seed: 2, octaves: 4, kind, gain: 0.9, lacunarity: 4 } });
    assert.ok(values.every(value => value >= 0 && value <= 1), kind);
    assert.ok(Math.max(...values) - Math.min(...values) > 0.2, kind);
  }
});

test('voronoi displaces a mesh with every output, byte for byte on every run, and the seed moves the cells', async () => {
  const { VORONOI_OUTPUTS } = await loadVoronoi();
  const digests = new Set();
  for (const output of VORONOI_OUTPUTS) {
    const field = { voronoi: { scale: 3, seed: 5, output } };
    assert.equal(digestOf(displaced(field)), digestOf(displaced(field)), output);
    digests.add(digestOf(displaced(field)));
  }
  assert.ok(digests.size >= 5);
  assert.notEqual(digestOf(displaced({ voronoi: { scale: 3, seed: 5 } })), digestOf(displaced({ voronoi: { scale: 3, seed: 6 } })));
});

test('voronoi reads 3D cells: distance is 0 on a feature point, f2MinusF1 is 0 between cells, cell is flat inside one', async () => {
  const { cellularNoise3, VORONOI_OUTPUTS } = await loadVoronoi();
  assert.equal(cellularNoise3(0.5, 0.5, 0.5, 4, 0).nearest, 0);
  const between = cellularNoise3(1, 0.5, 0.5, 4, 0);
  assert.equal(between.second - between.nearest, 0);
  const inside = [[0.45, 0.5, 0.5], [0.55, 0.52, 0.48]].map(point => cellularNoise3(...point, 4, 0).cell);
  assert.equal(inside[0], inside[1]);
  for (const output of VORONOI_OUTPUTS) {
    const values = valuesOf({ voronoi: { scale: 4, seed: 1, output } });
    assert.ok(values.every(value => value >= 0 && value <= 1), output);
    assert.ok(new Set(values).size > 10, output);
  }
});

test('voronoi counts as several nodes against the field limits', () => {
  const single = compileField({ voronoi: { scale: 2 } });
  assert.equal(single.nodeCount, 8);
  assert.equal(compileField({ noise: { scale: 2 } }).nodeCount, 1);
  assert.equal(validateField({ voronoi: { at: { vec: [1, 2, 3] } } }, { kind: 'scalar' }), 'scalar');
});

test('an unsupported node names the accepted list, and bad settings say what to pass', () => {
  assert.throws(() => displaced({ worley: { scale: 3 } }), /unknown operator "worley". Use one of add.*noise, random.*voronoi./);
  assert.throws(() => validateField({ noise: { kind: 'swirl' } }), /noise kind must be one of fbm, billow, ridged/);
  assert.throws(() => validateField({ noise: { gain: 2 } }), /noise gain must be a number from 0 to 1/);
  assert.throws(() => validateField({ noise: { lacunarity: 9 } }), /noise lacunarity must be a number from 1 to 4/);
  assert.throws(() => validateField({ voronoi: { output: 'blob' } }), /voronoi output must be one of distance, edge, cell/);
  assert.throws(() => validateField({ voronoi: { smoothness: 0.5 } }), /only applies to output "smoothF1"/);
  assert.throws(() => validateField({ voronoi: { colour: 1 } }), /voronoi does not take "colour"; fields: scale, seed, output/);
  assert.throws(() => validateField({ voronoi: { at: 1 } }), /voronoi "at" needs a vector/);
  assert.throws(() => validateField({ voronoi: { scale: 0 } }), /voronoi scale must be above 0/);
});
