import { cosineDirection, hashUnit, radicalInverse } from './light-bake.js';
import { buildOccupancyGrid, rayEscapes, rayHitDistance } from './sky-voxel-proxy.js';
import { partDiffuseAlbedo } from './ground-bounce.js';

// The room shell the sun bounce reads when a scene has more triangles than the light bake takes (#2771). The shell is the
// boundary of the occupancy grid of src/sky-voxel-proxy.js: every face between an occupied cell and an empty one is a piece of
// surface with the face's axis as its normal and the albedo of the part that marked the cell. It is a function of the geometry
// alone, so the same scene gives the same shell, and the same patches, whatever the mesh density and whichever limit sent it
// here; no triangle budget picks "the largest parts".

/** The most sun-facing faces examined; more are thinned by a fixed hash of the face, each kept one standing for the rest. */
export const SHELL_MAXIMUM_CANDIDATES = 60_000;
// A ray starts this many cells off the face, as the sky proxy's do.
const START_OFFSET_CELLS = 1.5;
const FACE_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function isOccupied(grid, cellX, cellY, cellZ) {
  const { size, occupied } = grid;
  if (cellX < 0 || cellY < 0 || cellZ < 0 || cellX >= size[0] || cellY >= size[1] || cellZ >= size[2]) return false;
  return occupied[(cellZ * size[1] + cellY) * size[0] + cellX] === 1;
}

// The faces of the shell that look toward the sun, as cell index x 6 + face axis, in cell order.
function sunFacingFaces(grid, sunDirection) {
  const { size } = grid;
  const facing = FACE_AXES.map(axis => axis[0] * sunDirection[0] + axis[1] * sunDirection[1] + axis[2] * sunDirection[2]);
  const faces = [];
  for (let cellZ = 0; cellZ < size[2]; cellZ++) {
    for (let cellY = 0; cellY < size[1]; cellY++) {
      for (let cellX = 0; cellX < size[0]; cellX++) {
        if (!isOccupied(grid, cellX, cellY, cellZ)) continue;
        const cell = (cellZ * size[1] + cellY) * size[0] + cellX;
        for (let face = 0; face < 6; face++) {
          if (facing[face] <= 0) continue;
          const [stepX, stepY, stepZ] = FACE_AXES[face];
          if (!isOccupied(grid, cellX + stepX, cellY + stepY, cellZ + stepZ)) faces.push(cell * 6 + face);
        }
      }
    }
  }
  return faces;
}

/**
 * The lit, enclosed samples of the room shell of `surfaces` and the free-distance lookup over the same grid, in the form
 * `findSunBounceLights` groups into patches: `{ samples, freeDistanceOf, cellSize }`, a sample being `{ point, normal, flux }`.
 * `sun` is `{ irradiance, direction }`; `roomRays` and `enclosedShare` are the room test of the triangle path.
 */
export function sampleShellSurfaces(surfaces, sun, { roomRays, enclosedShare }) {
  const grid = buildOccupancyGrid(surfaces, { recordOwners: true });
  const { minimum, cellSize, size, owners } = grid;
  const albedoOfPart = surfaces.map(part => partDiffuseAlbedo(part.material ?? {}));
  const faces = sunFacingFaces(grid, sun.direction);
  const keepShare = Math.min(1, SHELL_MAXIMUM_CANDIDATES / Math.max(faces.length, 1));
  const faceArea = cellSize * cellSize / keepShare;
  const fan = [0, 0, 0];
  const samples = [];
  for (const entry of faces) {
    const cell = Math.floor(entry / 6);
    const face = entry - cell * 6;
    if (keepShare < 1 && hashUnit(cell, face, 3) >= keepShare) continue;
    const normal = FACE_AXES[face];
    const cellX = cell % size[0];
    const cellY = Math.floor(cell / size[0]) % size[1];
    const cellZ = Math.floor(cell / (size[0] * size[1]));
    const centre = [minimum[0] + (cellX + 0.5) * cellSize, minimum[1] + (cellY + 0.5) * cellSize, minimum[2] + (cellZ + 0.5) * cellSize];
    const origin = centre.map((value, axis) => value + normal[axis] * cellSize * START_OFFSET_CELLS);
    if (!rayEscapes(grid, origin[0], origin[1], origin[2], sun.direction[0], sun.direction[1], sun.direction[2])) continue;
    let blocked = 0;
    for (let ray = 0; ray < roomRays; ray++) {
      cosineDirection(normal, (ray + 0.5) / roomRays, radicalInverse(ray + 1), fan);
      if (!rayEscapes(grid, origin[0], origin[1], origin[2], fan[0], fan[1], fan[2])) blocked++;
    }
    if (blocked / roomRays < enclosedShare) continue;
    const cosine = normal[0] * sun.direction[0] + normal[1] * sun.direction[1] + normal[2] * sun.direction[2];
    const albedo = albedoOfPart[owners[cell] - 1];
    samples.push({ point: centre.map((value, axis) => value + normal[axis] * cellSize * 0.5), normal, flux: sun.irradiance.map((channel, index) => channel * cosine * faceArea * albedo[index]) });
  }
  const freeDistanceOf = (point, normal) => {
    const start = point.map((value, axis) => value + normal[axis] * cellSize * START_OFFSET_CELLS);
    return cellSize * START_OFFSET_CELLS + rayHitDistance(grid, start[0], start[1], start[2], normal[0], normal[1], normal[2]);
  };
  return { samples, freeDistanceOf, cellSize };
}
