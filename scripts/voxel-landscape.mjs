// A deterministic voxel landscape for tests, the timing script and the still: hills, a lake, a sandy shore and rocky peaks.
// Material indexes follow the default palette: 0 grass, 1 rock, 2 sand, 3 water.

export const GRASS = 0;
export const ROCK = 1;
export const SAND = 2;
export const WATER = 3;

function heightAt(column, row, grid) {
  const x = column / grid[0];
  const z = row / grid[2];
  const ridge = Math.sin(x * 7.1 + 0.4) * Math.cos(z * 5.3) * 0.5 + Math.sin(x * 15.3 + z * 11.7) * 0.18 + Math.sin(x * 31 - z * 27) * 0.05;
  const mountain = Math.exp(-(((x - 0.72) ** 2) + ((z - 0.3) ** 2)) * 14) * 1.15;
  const lake = Math.exp(-(((x - 0.3) ** 2) + ((z - 0.68) ** 2)) * 26) * 1.0;
  return grid[1] * (0.34 + 0.16 * ridge + 0.5 * mountain - 0.3 * lake);
}

export function makeLandscape(grid) {
  const [cellsX, cellsY, cellsZ] = grid;
  const occupancy = new Float32Array(cellsX * cellsY * cellsZ);
  const materials = new Uint8Array(occupancy.length);
  const waterLevel = Math.floor(grid[1] * 0.3);
  for (let z = 0; z < cellsZ; z++) {
    for (let x = 0; x < cellsX; x++) {
      const top = heightAt(x, z, grid);
      const slope = Math.hypot(heightAt(x + 1, z, grid) - top, heightAt(x, z + 1, grid) - top);
      for (let y = 0; y < cellsY; y++) {
        const cell = (z * cellsY + y) * cellsX + x;
        if (y < top) {
          // The cell the ground ends in is partly full, as in Roblox terrain, so heights are finer than one cell.
          occupancy[cell] = Math.min(1, top - y);
          const depth = top - y;
          if (depth > 3 || slope > 1.1 || top > grid[1] * 0.62) materials[cell] = ROCK;
          else if (top < waterLevel + 2.5) materials[cell] = SAND;
          else materials[cell] = GRASS;
        } else if (y <= waterLevel) {
          occupancy[cell] = 1;
          materials[cell] = WATER;
        }
      }
    }
  }
  return { occupancy, materials };
}
