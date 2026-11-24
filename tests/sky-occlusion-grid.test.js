import assert from 'node:assert/strict';
import test from 'node:test';
import { canopyStreetParts } from './helpers/canopy-street-glb.mjs';
import { withFileSceneInteriorLight } from '../src/dense-lods.js';
import {
  applySkyOcclusionGrid, skyOcclusionLayout, traceSkyOcclusionGrid, SKY_OCCLUSION_MAXIMUM_NODES,
} from '../src/sky-occlusion-grid.js';

const COEFFICIENTS_PER_NODE = 16;
const SKY_SLOT = 12;

function skyShareAt(grid, point) {
  const index = point.map((value, axis) => Math.round((value - grid.origin[axis]) / grid.cellSize));
  const node = index[0] + grid.size[0] * (index[1] + grid.size[1] * index[2]);
  return grid.data[node * COEFFICIENTS_PER_NODE + SKY_SLOT];
}

test('the layout keeps the node count under the limit by growing the cells', () => {
  const small = skyOcclusionLayout([0, 0, 0], [10, 4, 10]);
  assert.equal(small.cellSize, 2);
  assert.deepEqual(small.size, [6, 3, 6]);
  const large = skyOcclusionLayout([0, 0, 0], [2000, 50, 2000], { maximumNodes: 1000 });
  assert.ok(large.size.reduce((product, count) => product * count, 1) <= 1000);
  assert.ok(large.cellSize > 2);
  assert.throws(() => skyOcclusionLayout([0, 0, 0], [1, 1, 1], { cellSize: 0 }), /cellSize must be a positive number/);
});

test('a node under a canopy sees less than half of what an open lawn sees, and the bytes repeat', () => {
  const grid = traceSkyOcclusionGrid(canopyStreetParts());
  assert.ok(grid.nodes <= SKY_OCCLUSION_MAXIMUM_NODES);
  const underCanopy = skyShareAt(grid, [0, 1, -6]);
  const underEave = skyShareAt(grid, [-12, 3, 2]);
  const openLawn = skyShareAt(grid, [12, 1, 0]);
  assert.equal(openLawn, 1);
  assert.ok(underCanopy < 0.5 * openLawn, `under the canopy ${underCanopy}`);
  assert.ok(underEave < 0.5 * openLawn, `under the eave ${underEave}`);
  const again = traceSkyOcclusionGrid(canopyStreetParts());
  assert.deepEqual(Buffer.from(again.data.buffer), Buffer.from(grid.data.buffer));
});

test('a street with nothing over it reads fully open, so it draws as before', () => {
  const grid = traceSkyOcclusionGrid(canopyStreetParts({ cover: false }));
  let darkest = 1;
  for (let node = 0; node < grid.nodes; node++) {
    darkest = Math.min(darkest, grid.data[node * COEFFICIENTS_PER_NODE + SKY_SLOT]);
  }
  assert.equal(darkest, 1);
});

test('applySkyOcclusionGrid gives every part a sky-only grid and leaves baked scenes alone', () => {
  const parts = canopyStreetParts();
  const { parts: placed, report } = applySkyOcclusionGrid(parts);
  assert.equal(report.reason, null);
  assert.ok(report.coveredShare > 0 && report.coveredShare < 0.5);
  assert.ok(placed.every(part => part.material.irradianceGrid.skyOnly === true));
  assert.deepEqual(placed.map(part => part.material.color), parts.map(part => part.material.color));
  const baked = parts.map(part => ({ ...part, material: { ...part.material, lightMap: {} } }));
  assert.equal(applySkyOcclusionGrid(baked).report.reason, 'baked light');
  assert.equal(applySkyOcclusionGrid([]).report.reason, 'no parts');
});

test('a file scene takes the grid only when environment.skyOcclusion is true', async () => {
  const parts = canopyStreetParts();
  const off = await withFileSceneInteriorLight(parts, {});
  assert.equal(off.parts, parts);
  const on = await withFileSceneInteriorLight(parts, { skyOcclusion: true });
  assert.ok(on.parts[0].material.irradianceGrid);
  assert.ok(on.skyOcclusionReport.nodes > 0);
});

test('the fog is lit by a baked grid but not by a sky-only one, so its shader state is the same with the flag on and off', async () => {
  const { fogIsLitByGrid } = await import('../src/fog-shader.js');
  const parts = canopyStreetParts();
  const occluded = applySkyOcclusionGrid(parts).parts;
  assert.equal(fogIsLitByGrid(parts), false);
  assert.equal(fogIsLitByGrid(occluded), false);
  const baked = parts.map(part => ({ ...part, material: { ...part.material, irradianceGrid: { size: [2, 2, 2] } } }));
  assert.equal(fogIsLitByGrid(baked), true);
});

test('the grid scales the sky light term only: the sun and point lights never read occlusion, and the grid adds no light', async () => {
  const { createFragmentShader, SHADER_FEATURES } = await import('../src/shaders.js');
  const { evaluateIrradianceGrid } = await import('../src/irradiance-grid.js');
  const source = createFragmentShader([...SHADER_FEATURES, 'irradianceGrid']);
  const lines = source.split('\n');
  const gridOcclusion = lines.findIndex(line => line.includes('occlusion *= min(irradianceGridValue.a, 1.0)'));
  const skyLight = lines.findIndex(line => line.includes('radiance += environmentLighting('));
  assert.ok(gridOcclusion > 0 && gridOcclusion < skyLight, 'the grid scales occlusion before the HDRI light is added');
  const directLights = lines.filter(line => /illuminate\(/.test(line) && !line.startsWith('vec3 illuminate'));
  assert.ok(directLights.length > 0);
  assert.deepEqual(directLights.filter(line => /\bocclusion\b/.test(line)), []);
  const grid = applySkyOcclusionGrid(canopyStreetParts()).parts[0].material.irradianceGrid;
  assert.deepEqual(evaluateIrradianceGrid(grid, [0, 1, -6], [0, -1, 0]), [0, 0, 0]);
});

test('the report says when the cells had to grow past the requested size', () => {
  assert.equal(applySkyOcclusionGrid(canopyStreetParts()).report.coarsened, false);
  const coarse = applySkyOcclusionGrid(canopyStreetParts(), { maximumNodes: 200 }).report;
  assert.equal(coarse.coarsened, true);
  assert.ok(coarse.cellSize > 2);
});
