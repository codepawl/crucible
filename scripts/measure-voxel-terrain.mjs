// Times the voxel terrain mesher: node scripts/measure-voxel-terrain.mjs [cellsX cellsY cellsZ] [runs]
import { createVoxelTerrain } from '../src/voxel-terrain.js';
import { makeLandscape } from './voxel-landscape.mjs';

const grid = process.argv.slice(2, 5).map(Number);
const gridSize = grid.length === 3 && grid.every(Number.isInteger) ? grid : [256, 64, 256];
const runs = Number(process.argv[5] ?? 3);
const { occupancy, materials } = makeLandscape(gridSize);
for (let run = 0; run < runs; run++) {
  const result = createVoxelTerrain({ grid: gridSize, cellSize: 1, occupancy, materials });
  const { vertices, triangles, milliseconds } = result.stats;
  console.log(`${gridSize.join('x')} run ${run + 1}: ${Math.round(milliseconds)} ms, ${vertices} vertices, ${triangles} triangles`);
}
