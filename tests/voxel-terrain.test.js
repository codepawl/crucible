import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createVoxelTerrain, VOXEL_TERRAIN_LIMITS } from '../src/voxel-terrain.js';
import { createVoxelTerrain as createFromAddon } from '../src/terrain.js';
import { GRASS, ROCK, SAND, WATER, makeLandscape } from '../scripts/voxel-landscape.mjs';

const GRID = [40, 20, 40];

function landscapeInput(overrides = {}) {
  const { occupancy, materials } = makeLandscape(GRID);
  return { grid: GRID, cellSize: 2, occupancy, materials, ...overrides };
}

function hashOf(result) {
  const hash = createHash('sha256');
  for (const part of result.parts) {
    for (const field of ['positions', 'normals', 'uvs', 'colors', 'indices']) {
      const array = part.geometry[field];
      if (array) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    }
  }
  return hash.digest('hex');
}

function edgeUses(indices) {
  const uses = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const from = indices[offset + side];
      const to = indices[offset + (side + 1) % 3];
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

test('the same voxel input meshes to the same bytes, from fresh arrays each time', () => {
  const first = createVoxelTerrain(landscapeInput());
  const second = createVoxelTerrain(landscapeInput());
  assert.equal(hashOf(first), hashOf(second));
  assert.deepEqual(first.materialIds, second.materialIds);
  const firstLand = first.parts[0].geometry;
  const secondLand = second.parts[0].geometry;
  assert.ok(firstLand.indices.length > 0);
  for (const field of ['positions', 'normals', 'colors', 'indices']) {
    assert.deepEqual(Buffer.from(firstLand[field].buffer), Buffer.from(secondLand[field].buffer), field);
  }
});

test('the addon entry exports the voxel mesher', () => {
  assert.equal(createFromAddon, createVoxelTerrain);
});

test('a landscape gives a land part and a water part inside the grid bounds', () => {
  const result = createVoxelTerrain(landscapeInput({ origin: [10, 0, -5] }));
  assert.deepEqual(result.parts.map(part => part.name), ['Voxel terrain', 'Voxel water']);
  assert.deepEqual(result.bounds, { min: [10, 0, -5], max: [90, 40, 75] });
  for (const part of result.parts) {
    const { positions, indices } = part.geometry;
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[offset + axis];
        assert.ok(value >= result.bounds.min[axis] - 1e-3 && value <= result.bounds.max[axis] + 1e-3, `${part.name} vertex outside the grid`);
      }
    }
    assert.ok(indices.every(index => index < positions.length / 3));
    assert.equal(part.geometry.normals.length, positions.length);
  }
});

test('the land mesh has no hole away from the grid border', () => {
  const { indices, positions } = createVoxelTerrain(landscapeInput({ cellSize: 1 })).parts[0].geometry;
  for (const [key, count] of edgeUses(indices)) {
    const [from, to] = key.split(',').map(Number);
    const middle = [0, 1, 2].map(axis => (positions[from * 3 + axis] + positions[to * 3 + axis]) / 2);
    const onBorder = middle[0] < 0.6 || middle[0] > GRID[0] - 0.6 || middle[2] < 0.6 || middle[2] > GRID[2] - 0.6 || middle[1] < 0.6;
    assert.ok(count === 2 || (count === 1 && onBorder), `edge ${key} has ${count} triangles away from the border`);
  }
});

test('materials show as distinct colours and blend across the seam', () => {
  const grid = [12, 12, 12];
  const occupancy = new Float32Array(12 * 12 * 12);
  const materials = new Uint8Array(occupancy.length);
  for (let z = 0; z < 12; z++) {
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 12; x++) {
        const cell = (z * 12 + y) * 12 + x;
        occupancy[cell] = 1;
        materials[cell] = x < 6 ? GRASS : ROCK;
      }
    }
  }
  const result = createVoxelTerrain({ grid, cellSize: 1, occupancy, materials });
  const { positions, colors } = result.parts[0].geometry;
  const colorAt = x => {
    const distance = vertex => Math.abs(positions[vertex * 3] - x) + Math.abs(positions[vertex * 3 + 1] - 6) + Math.abs(positions[vertex * 3 + 2] - 6);
    let best = 0;
    for (let vertex = 1; vertex < positions.length / 3; vertex++) {
      if (distance(vertex) < distance(best)) best = vertex;
    }
    return [colors[best * 3], colors[best * 3 + 1], colors[best * 3 + 2]];
  };
  const grassColor = colorAt(1.5);
  const rockColor = colorAt(10.5);
  const seamColor = colorAt(6);
  assert.ok(grassColor[1] > grassColor[0] * 1.8, 'grass is green');
  assert.ok(Math.abs(rockColor[0] - rockColor[1]) < 0.08, 'rock is grey');
  assert.ok(seamColor[0] > grassColor[0] * 1.2 && seamColor[1] < grassColor[1], 'the seam sits between the two looks');
  assert.equal(result.parts.length, 1, 'no water part without water cells');
});

test('a shore cell that is partly ground still gets water against it', () => {
  const grid = [8, 6, 8];
  const occupancy = new Float32Array(8 * 6 * 8);
  const materials = new Uint8Array(occupancy.length).fill(SAND);
  for (let z = 0; z < 8; z++) {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 3; y++) occupancy[(z * 6 + y) * 8 + x] = 1;
      const shoreCell = (z * 6 + 3) * 8 + x;
      if (x < 4) {
        occupancy[shoreCell] = 1;
        materials[shoreCell] = WATER;
      } else {
        occupancy[shoreCell] = 0.5;
      }
    }
  }
  const { parts } = createVoxelTerrain({ grid, cellSize: 1, occupancy, materials });
  const water = parts.find(part => part.name === 'Voxel water');
  assert.ok(water, 'water part');
  let farthest = 0;
  for (let offset = 0; offset < water.geometry.positions.length; offset += 3) farthest = Math.max(farthest, water.geometry.positions[offset]);
  assert.ok(farthest > 4.5, 'the water reaches over the partly full shore cells');
});

test('input errors name the field, what was received and what to pass', () => {
  const good = landscapeInput();
  assert.throws(() => createVoxelTerrain(null), /voxelTerrain: got null; expected an object/);
  assert.throws(() => createVoxelTerrain({ ...good, grid: [40, 20] }), /grid: got \[40,20\]; expected three whole numbers from 2 to 512/);
  assert.throws(() => createVoxelTerrain({ ...good, grid: [1, 20, 40] }), /grid: got \[1,20,40\]/);
  assert.throws(() => createVoxelTerrain({ ...good, cellSize: 0 }), /cellSize: got 0; expected a number above 0/);
  assert.throws(() => createVoxelTerrain({ ...good, occupancy: new Float32Array(10) }), /occupancy\.length: got 10; expected an array of 32000 numbers/);
  const badOccupancy = good.occupancy.slice();
  badOccupancy[5] = 2;
  assert.throws(() => createVoxelTerrain({ ...good, occupancy: badOccupancy }), /occupancy\[5\]: got 2; expected a number from 0/);
  const badMaterials = good.materials.slice();
  badMaterials[7] = 9;
  assert.throws(() => createVoxelTerrain({ ...good, materials: badMaterials }), /materials\[7\]: got 9; expected a whole number from 0 to 3/);
  assert.throws(() => createVoxelTerrain({ ...good, palette: ['grass', 'lava'] }), /palette\["lava"\]: got "lava"; expected one of grass, rock, sand, dirt, snow, water/);
  assert.throws(() => createVoxelTerrain({ ...good, smoothing: 9 }), /smoothing: got 9; expected a whole number from 0 to 4/);
  assert.throws(() => createVoxelTerrain({ ...good, edges: 'wrap' }), /edges: got "wrap"; expected one of open, closed/);
});

test('the grid is bounded before any array is read', () => {
  const huge = { grid: [512, 512, 512], occupancy: [], materials: [] };
  assert.throws(() => createVoxelTerrain(huge), /grid: got \[512,512,512\]; expected a grid of at most 16777216 cells/);
  assert.equal(VOXEL_TERRAIN_LIMITS.maxCells, 16_777_216);
});

test('an empty grid says there is no surface', () => {
  const empty = landscapeInput({ occupancy: new Float32Array(32000) });
  assert.throws(() => createVoxelTerrain(empty), /no surface/);
});

test('a pond has one flat water level, with no surface climbing the bank', () => {
  const grid = [16, 10, 16];
  const occupancy = new Float32Array(16 * 10 * 16);
  const materials = new Uint8Array(occupancy.length).fill(SAND);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const distance = Math.max(Math.abs(x - 7.5), Math.abs(z - 7.5));
      const bankHeight = 1.5 + Math.max(0, distance - 3) * 1.2;
      for (let y = 0; y < 10; y++) {
        const cell = (z * 10 + y) * 16 + x;
        occupancy[cell] = Math.min(1, Math.max(0, bankHeight - y));
        if (occupancy[cell] === 0 && y < 3) {
          occupancy[cell] = 1;
          materials[cell] = WATER;
        }
      }
    }
  }
  const water = createVoxelTerrain({ grid, cellSize: 1, occupancy, materials }).parts.find(part => part.name === 'Voxel water');
  assert.ok(water, 'water part');
  const heights = [];
  for (let offset = 1; offset < water.geometry.positions.length; offset += 3) heights.push(water.geometry.positions[offset]);
  const spread = Math.max(...heights) - Math.min(...heights);
  assert.ok(spread < 0.05, `water heights spread over ${spread.toFixed(2)} cells`);
});

test('closed edges give the side walls one flat earth colour and leave the top surface its own colours', () => {
  const closed = createVoxelTerrain(landscapeInput({ edges: 'closed' }));
  const open = createVoxelTerrain(landscapeInput({ edges: 'open' }));
  assert.equal(open.stats.wallTriangles, 0);
  assert.ok(closed.stats.wallTriangles > 0, 'a closed landscape has wall triangles');
  const { colors, indices } = closed.parts[0].geometry;
  const wallStart = indices.length - closed.stats.wallTriangles * 3;
  const wallVertices = new Set(indices.subarray(wallStart));
  const topVertices = new Set(indices.subarray(0, wallStart));
  const [first] = wallVertices;
  const earth = [colors[first * 3], colors[first * 3 + 1], colors[first * 3 + 2]];
  assert.ok(earth[0] > earth[1] && earth[1] > earth[2], `earth is warm, got ${earth}`);
  for (const vertex of wallVertices) {
    assert.deepEqual([colors[vertex * 3], colors[vertex * 3 + 1], colors[vertex * 3 + 2]], earth, 'every wall vertex has the earth colour');
    assert.equal(topVertices.has(vertex), false, 'a wall vertex is not shared with the top surface');
  }
  for (const vertex of topVertices) {
    const matches = [0, 1, 2].every(channel => colors[vertex * 3 + channel] === earth[channel]);
    assert.equal(matches, false, 'a top vertex does not get the earth colour');
  }
  const { normals } = closed.parts[0].geometry;
  for (const vertex of wallVertices) assert.ok(Math.abs(normals[vertex * 3 + 1]) < 0.75 || normals[vertex * 3 + 1] < 0, 'wall normals do not face up');
});

test('a closed wall hangs from the smooth surface boundary, not from per-cell heights', () => {
  const closed = createVoxelTerrain(landscapeInput({ edges: 'closed' }));
  const open = createVoxelTerrain(landscapeInput({ edges: 'open' }));
  const openGeometry = open.parts[0].geometry;
  const openHeights = new Map();
  for (let vertex = 0; vertex < openGeometry.positions.length / 3; vertex++) {
    const key = `${openGeometry.positions[vertex * 3]},${openGeometry.positions[vertex * 3 + 2]}`;
    openHeights.set(key, [...(openHeights.get(key) ?? []), openGeometry.positions[vertex * 3 + 1]]);
  }
  const { positions, indices } = closed.parts[0].geometry;
  const wallStart = indices.length - closed.stats.wallTriangles * 3;
  const bottom = 0;
  let checked = 0;
  for (const vertex of new Set(indices.subarray(wallStart))) {
    const height = positions[vertex * 3 + 1];
    if (height === bottom) continue;
    const surfaceHeights = openHeights.get(`${positions[vertex * 3]},${positions[vertex * 3 + 2]}`);
    assert.notEqual(surfaceHeights, undefined, 'a wall top vertex sits on a vertex of the smooth surface');
    assert.ok(surfaceHeights.some(surfaceHeight => Math.abs(height - surfaceHeight) < 1e-6), `wall top height ${height} should equal a surface boundary height (${surfaceHeights})`);
    checked++;
  }
  assert.ok(checked > 40, `checked ${checked} wall top vertices`);
});

function landHeightAt(land, x, z) {
  const { positions, indices } = land;
  let highest = -Infinity;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [first, second, third] = [0, 1, 2].map(corner => indices[offset + corner] * 3);
    const determinant = (positions[second + 2] - positions[third + 2]) * (positions[first] - positions[third]) + (positions[third] - positions[second]) * (positions[first + 2] - positions[third + 2]);
    if (Math.abs(determinant) < 1e-12) continue;
    const weightFirst = ((positions[second + 2] - positions[third + 2]) * (x - positions[third]) + (positions[third] - positions[second]) * (z - positions[third + 2])) / determinant;
    const weightSecond = ((positions[third + 2] - positions[first + 2]) * (x - positions[third]) + (positions[first] - positions[third]) * (z - positions[third + 2])) / determinant;
    const weightThird = 1 - weightFirst - weightSecond;
    if (weightFirst < -1e-9 || weightSecond < -1e-9 || weightThird < -1e-9) continue;
    highest = Math.max(highest, weightFirst * positions[first + 1] + weightSecond * positions[second + 1] + weightThird * positions[third + 1]);
  }
  return highest;
}

test('the water outline lies under land that is above the water level, so the shoreline is where the ground crosses the water plane', () => {
  const result = createVoxelTerrain(landscapeInput({ edges: 'closed' }));
  const land = result.parts[0].geometry;
  const water = result.parts.find(part => part.material.tag === 'water').geometry;
  const wallStart = land.indices.length - result.stats.wallTriangles * 3;
  const topLand = { positions: land.positions, indices: land.indices.subarray(0, wallStart) };
  const directed = new Set();
  for (let corner = 0; corner < water.indices.length; corner++) directed.add(`${water.indices[corner]},${water.indices[corner - (corner % 3) + (corner + 1) % 3]}`);
  const bounds = result.bounds;
  let checked = 0;
  for (let corner = 0; corner < water.indices.length; corner++) {
    const from = water.indices[corner];
    const to = water.indices[corner - (corner % 3) + (corner + 1) % 3];
    if (directed.has(`${to},${from}`)) continue;
    const middle = [0, 1, 2].map(axis => (water.positions[from * 3 + axis] + water.positions[to * 3 + axis]) / 2);
    const nearBounds = [0, 2].some(axis => middle[axis] <= bounds.min[axis] + 1e-6 || middle[axis] >= bounds.max[axis] - 1e-6);
    if (nearBounds) continue;
    const landHeight = landHeightAt(topLand, middle[0], middle[2]);
    if (landHeight === -Infinity) continue;
    assert.ok(landHeight >= middle[1] - 1e-3, `the water outline at (${middle[0].toFixed(2)}, ${middle[2].toFixed(2)}) is at ${middle[1].toFixed(3)} but the ground there is only ${landHeight.toFixed(3)}: a visible step`);
    checked++;
  }
  assert.ok(checked > 20, `checked ${checked} outline edges`);
  for (let offset = 0; offset < water.indices.length; offset += 3) {
    const [first, second, third] = [0, 1, 2].map(corner => water.indices[offset + corner] * 3);
    const upward = (water.positions[second + 2] - water.positions[first + 2]) * (water.positions[third] - water.positions[first]) - (water.positions[second] - water.positions[first]) * (water.positions[third + 2] - water.positions[first + 2]);
    assert.ok(upward >= -1e-9, 'every water triangle faces up');
  }
});

test('a slanted material border is a straight, monotonic blend, not a staircase of cells', () => {
  const grid = [40, 8, 40];
  const occupancy = new Float32Array(grid[0] * grid[1] * grid[2]);
  const materials = new Uint8Array(occupancy.length);
  for (let z = 0; z < grid[2]; z++) {
    for (let y = 0; y < grid[1]; y++) {
      for (let x = 0; x < grid[0]; x++) {
        const cell = (z * grid[1] + y) * grid[0] + x;
        occupancy[cell] = y < 4 ? 1 : y === 4 ? 0.5 : 0;
        materials[cell] = 0.4 * (x + 0.5) - (z + 0.5) + 9 > 0 ? 1 : 0;
      }
    }
  }
  const looks = { mud: { color: [1, 0, 0], variation: 0 }, clay: { color: [0, 0, 1], variation: 0 } };
  const { parts } = createVoxelTerrain({ grid, cellSize: 1, occupancy, materials, palette: ['mud', 'clay'], looks, smoothing: 1 });
  const { positions, normals, colors } = parts[0].geometry;
  const rows = new Map();
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const [x, y, z] = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    if (y < 3.8 || y > 5 || x < 3 || x > 37 || z < 9 || z > 30 || normals[vertex * 3 + 1] < 0.9) continue;
    const key = Math.round(z * 4);
    rows.set(key, [...(rows.get(key) ?? []), [x, colors[vertex * 3]]]);
  }
  const crossings = [];
  for (const [key, row] of rows) {
    row.sort((first, second) => first[0] - second[0]);
    for (let index = 1; index < row.length; index++) {
      assert.ok(row[index][1] <= row[index - 1][1] + 1e-6, 'the share of the first material only falls across the border');
    }
    for (let index = 1; index < row.length; index++) {
      const [x0, share0] = row[index - 1];
      const [x1, share1] = row[index];
      if (share0 >= 0.5 && share1 < 0.5) {
        crossings.push([key / 4, x0 + (share0 - 0.5) / (share0 - share1) * (x1 - x0)]);
        break;
      }
    }
  }
  assert.ok(crossings.length >= 10, `found the border in ${crossings.length} rows`);
  const meanZ = crossings.reduce((total, [z]) => total + z, 0) / crossings.length;
  const meanX = crossings.reduce((total, [, x]) => total + x, 0) / crossings.length;
  const slope = crossings.reduce((total, [z, x]) => total + (z - meanZ) * (x - meanX), 0) / crossings.reduce((total, [z]) => total + (z - meanZ) ** 2, 0);
  for (const [z, x] of crossings) {
    assert.ok(Math.abs(x - (meanX + slope * (z - meanZ))) < 0.05, `the border at z ${z} is ${Math.abs(x - (meanX + slope * (z - meanZ))).toFixed(3)} cells off a straight line`);
  }
});
