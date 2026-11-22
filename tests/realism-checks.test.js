import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { albedoDiagnostics, metallicOnDielectricDiagnostics } from '../src/realism-checks.js';
import { realismReport, tilingDiagnostic } from '../scripts/review-realism.mjs';
import { recipeDiagnostics } from '../src/agent-diagnostics.js';
import { detectTiling } from '../scripts/review-tiling.mjs';
import { normalizeReview } from '../scripts/agent-review.mjs';

const recipeWith = (materials, nodes = []) => ({ materials, nodes, geometries: [] });
const material = (id, fields = {}) => ({ id, tag: 'surface', color: [0.3, 0.3, 0.3], metallic: 0, ...fields });

test('albedo-out-of-range fails coal-black and paper-white plain surfaces and passes real ranges', () => {
  const tooDark = albedoDiagnostics(recipeWith([material('soot', { color: [0, 0, 0] })]));
  assert.equal(tooDark.length, 1);
  assert.equal(tooDark[0].kind, 'albedo-out-of-range');
  assert.match(tooDark[0].message, /darker than charcoal/);
  assert.match(tooDark[0].fix, /scene_apply set-material/);
  const tooBright = albedoDiagnostics(recipeWith([material('wall', { color: [1, 1, 1] })]));
  assert.match(tooBright[0].message, /brighter than fresh snow/);
  const real = [[0.04, 0.04, 0.04], [0.015, 0.015, 0.02], [0.5, 0.5, 0.5], [0.85, 0.85, 0.85], [0.9, 0.1, 0.1]];
  assert.deepEqual(albedoDiagnostics(recipeWith(real.map((color, index) => material(`real-${index}`, { color })))), []);
});

test('albedo-out-of-range exempts snow, metals, emitters, glass, textured and non-surface materials', () => {
  const white = [1, 1, 1];
  const exempt = [
    material('fresh-snow', { color: white }),
    material('silver', { color: white, metallic: 1 }),
    material('lamp', { color: white, emission: 2 }),
    material('window', { color: [0, 0, 0], transmission: 1 }),
    material('painted', { color: white, pattern: { type: 'noise' } }),
    material('sea', { tag: 'water', color: [0, 0.01, 0.02] }),
    material('glow', { tag: 'unlit', color: white }),
  ];
  assert.deepEqual(albedoDiagnostics(recipeWith(exempt)), []);
});

test('metallic-on-dielectric fails ground, rock, grass and wood with metallic and passes them at zero', () => {
  const bad = recipeWith([material('ground', { metallic: 0.3 }), material('cliff-rock', { metallic: 1 }), material('blades', { tag: 'grass', metallic: 0.1 }), material('plank', { metallic: 0.2 })],
    [{ id: 'floor-1', material: 'plank', label: 'Wooden plank' }]);
  const findings = metallicOnDielectricDiagnostics(bad);
  assert.deepEqual(findings.map(entry => entry.target), ['ground', 'cliff-rock', 'blades', 'plank']);
  assert.match(findings[0].fix, /metallic to 0/);
  const good = recipeWith([material('ground'), material('cliff-rock'), material('blades', { tag: 'grass' }), material('plank')]);
  assert.deepEqual(metallicOnDielectricDiagnostics(good), []);
});

test('metallic-on-dielectric reads names whole: background and rocket are not ground or rock, and wood-and-metal may be metallic', () => {
  const recipe = recipeWith([material('background', { metallic: 1 }), material('rocket', { metallic: 1 }), material('wood-and-steel-trim', { metallic: 1 })],
    [{ id: 'ground-node', material: 'wood-and-steel-trim' }]);
  assert.deepEqual(metallicOnDielectricDiagnostics(recipe), []);
});

test('a node name finds a ground material whose own name does not', () => {
  const recipe = recipeWith([material('brown', { metallic: 0.5 })], [{ id: 'n1', material: 'brown', label: 'Ground plane' }]);
  assert.equal(metallicOnDielectricDiagnostics(recipe).length, 1);
});

test('recipeDiagnostics lists both material checks', () => {
  const recipe = { ...recipeWith([material('ground', { metallic: 0.3, color: [0, 0, 0] })], [{ id: 'g', material: 'ground' }]), geometries: [] };
  const kinds = recipeDiagnostics(recipe).map(entry => entry.kind);
  assert.ok(kinds.includes('albedo-out-of-range'));
  assert.ok(kinds.includes('metallic-on-dielectric'));
});

function plane(width, height, valueAt) {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) values[row * width + column] = valueAt(column, row);
  return { width, height, values };
}

// Small deterministic hash noise in 0..255.
function noise(column, row, seed = 1) {
  let hash = (column * 374761393 + row * 668265263 + seed * 2147483647) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0;
  return (hash ^ (hash >>> 16)) % 256;
}

test('visible-tiling finds a noise tile repeated in a grid, at its period', () => {
  const tile = 24;
  const tiled = plane(192, 192, (column, row) => noise(column % tile, row % tile));
  const tiling = detectTiling(tiled);
  assert.ok(tiling, 'a repeating tile is found');
  assert.ok(tiling.periodX === 0 || tiling.periodX % tile === 0 || tiling.periodX % tile <= 2 || tile - (tiling.periodX % tile) <= 2, `period ${tiling.periodX}`);
  assert.ok(tiling.strength >= 0.5);
  assert.match(tilingDiagnostic('View 1', tiling).message, /repeats every/);
});

test('visible-tiling passes noise, a smooth gradient, a flat picture and a single object', () => {
  assert.equal(detectTiling(plane(192, 192, (column, row) => noise(column, row))), null);
  assert.equal(detectTiling(plane(192, 192, (column, row) => (column + row) / 3)), null);
  assert.equal(detectTiling(plane(192, 192, () => 128)), null);
  const disc = plane(192, 192, (column, row) => (Math.hypot(column - 96, row - 96) < 40 ? 220 : 40));
  assert.equal(detectTiling(disc), null);
});

test('visible-tiling cost does not grow with the picture size', () => {
  const large = plane(960, 960, (column, row) => noise(column, row));
  const start = performance.now();
  detectTiling(large);
  assert.ok(performance.now() - start < 3000);
});

test('realismReport lists every check with its fix, fails the material checks and only warns for tiling', () => {
  const passing = realismReport(recipeWith([material('ground')]));
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.checks.map(entry => [entry.check, entry.status]), [['albedo-out-of-range', 'pass'], ['metallic-on-dielectric', 'pass'], ['visible-tiling', 'pass']]);
  assert.ok(passing.checks.every(entry => entry.fix.length > 10));
  const failing = realismReport(recipeWith([material('ground', { metallic: 0.3, color: [1, 1, 1] })]), [tilingDiagnostic('View 1', { periodX: 24, periodY: 0, strength: 0.8 })]);
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.checks.map(entry => entry.status), ['fail', 'fail', 'warn']);
  assert.equal(failing.checks[0].findings[0].target, 'ground');
  const tilingOnly = realismReport(recipeWith([material('ground')]), [tilingDiagnostic('View 1', { periodX: 24, periodY: 0, strength: 0.8 })]);
  assert.equal(tilingOnly.passed, true);
});

test('scene_review accepts checks "realism" only', () => {
  const base = { sessionId: 's', expectedRevision: 0, shots: [{}] };
  assert.equal(normalizeReview({ ...base, checks: 'realism' }).checks, 'realism');
  assert.equal(normalizeReview(base).checks, undefined);
  assert.throws(() => normalizeReview({ ...base, checks: 'everything' }), /realism/);
});

const RECIPE_FILES = execFileSync('git', ['ls-files', '*.json'], { encoding: 'utf8' }).split('\n').filter(Boolean).filter(file => {
  if (file.includes('package')) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.materials) && Array.isArray(parsed.nodes);
  } catch { return false; }
});

test('the tiling reader takes the cell of each shot from the review grid PNG', async () => {
  const { encodePng } = await import('../scripts/agent-icon-png.mjs');
  const { reviewTilingFindings } = await import('../scripts/review-realism.mjs');
  const settings = { width: 128, height: 128, columns: 2, shots: [{ label: 'Plain' }, { label: 'Tiled' }] };
  const gridWidth = 256;
  const gridHeight = 128 + 24;
  const data = Buffer.alloc(gridWidth * gridHeight * 4, 255);
  for (let row = 0; row < 128; row++) {
    for (let column = 0; column < 128; column++) {
      for (const [shot, value] of [[0, noise(column, row)], [1, noise(column % 16, row % 16)]]) {
        const offset = ((row + 24) * gridWidth + shot * 128 + column) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
      }
    }
  }
  const png = encodePng({ width: gridWidth, height: gridHeight, data }).toString('base64');
  assert.deepEqual(reviewTilingFindings(png, settings).map(entry => entry.target), ['Tiled']);
  assert.deepEqual(reviewTilingFindings('bm90IGEgcG5n', settings), []);
});

test('no repo recipe (examples, packs, bench recipes, fixtures) trips a material realism check', () => {
  assert.ok(RECIPE_FILES.length >= 10, `found ${RECIPE_FILES.length} recipes`);
  for (const file of RECIPE_FILES) {
    const report = realismReport(JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(report.passed, true, `${file}: ${JSON.stringify(report.checks.flatMap(entry => entry.findings ?? []))}`);
  }
});
