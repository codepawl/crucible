import { cosineDirection, hashUnit, radicalInverse } from './light-bake.js';
import { buildOccupancyGrid, PROXY_MAXIMUM_CELLS, rayEscapes, rayHitDistance } from './sky-voxel-proxy.js';
import { partDiffuseAlbedo } from './ground-bounce.js';

// The room shell the sun bounce reads when a scene has more triangles than the light bake takes (#2771). The shell is the
// boundary of the occupancy grid of src/sky-voxel-proxy.js: every face between an occupied cell and an empty one is a piece of
// surface with the face's axis as its normal and the albedo of the part that marked the cell. It is a function of the geometry
// alone, so the same scene gives the same shell, and the same patches, whatever the mesh density and whichever limit sent it
// here; no triangle budget picks "the largest parts".

/** The most sun-facing faces examined; more are thinned by a fixed hash of the face, each kept one standing for the rest. */
export const SHELL_MAXIMUM_CANDIDATES = 60_000;
/** The most faces of the whole shell examined for the interior's area and mean albedo. */
export const SHELL_MAXIMUM_INTERIOR_FACES = 20_000;
// A ray starts this many cells off the face, as the sky proxy's do.
const START_OFFSET_CELLS = 1.5;
const FACE_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Extracts both all boundary faces and the sun-facing subset in one pass over the occupied cells.
function collectShellFaces(grid, sunDirection) {
  const { size, occupied } = grid;
  const strideZ = size[0] * size[1];
  const facing = FACE_AXES.map(axis => axis[0] * sunDirection[0] + axis[1] * sunDirection[1] + axis[2] * sunDirection[2]);
  const allFaces = [];
  const sunFaces = [];
  for (let cell = 0; cell < occupied.length; cell++) {
    if (!occupied[cell]) continue;
    const cellX = cell % size[0];
    const cellY = Math.floor(cell / size[0]) % size[1];
    const cellZ = Math.floor(cell / strideZ);
    for (let face = 0; face < 6; face++) {
      const [stepX, stepY, stepZ] = FACE_AXES[face];
      const nextX = cellX + stepX;
      const nextY = cellY + stepY;
      const nextZ = cellZ + stepZ;
      const neighborOccupied = nextX >= 0 && nextY >= 0 && nextZ >= 0 && nextX < size[0] && nextY < size[1] && nextZ < size[2] && occupied[(nextZ * size[1] + nextY) * size[0] + nextX] === 1;
      if (!neighborOccupied) {
        const entry = cell * 6 + face;
        allFaces.push(entry);
        if (facing[face] > 0) sunFaces.push(entry);
      }
    }
  }
  return { allFaces, sunFaces };
}

function faceGeometry(grid, entry) {
  const { minimum, cellSize, size } = grid;
  const cell = Math.floor(entry / 6);
  const face = entry - cell * 6;
  const normal = FACE_AXES[face];
  const cellX = cell % size[0];
  const cellY = Math.floor(cell / size[0]) % size[1];
  const cellZ = Math.floor(cell / (size[0] * size[1]));
  const centre = [minimum[0] + (cellX + 0.5) * cellSize, minimum[1] + (cellY + 0.5) * cellSize, minimum[2] + (cellZ + 0.5) * cellSize];
  const origin = centre.map((value, axis) => value + normal[axis] * cellSize * START_OFFSET_CELLS);
  return { cell, face, normal, centre, origin };
}

function isInteriorFace(grid, origin, normal, roomRays, enclosedShare, fan) {
  let blocked = 0;
  for (let ray = 0; ray < roomRays; ray++) {
    cosineDirection(normal, (ray + 0.5) / roomRays, radicalInverse(ray + 1), fan);
    if (!rayEscapes(grid, origin[0], origin[1], origin[2], fan[0], fan[1], fan[2])) blocked++;
  }
  return blocked / roomRays >= enclosedShare;
}

// Bounding box surface area of the interior points: furniture adds inner shell faces and staircasing without adding room volume,
// so capping the shell area at its outer envelope keeps furnished rooms from diluting their multi-bounce budget.
function interiorEnvelopeArea(points) {
  if (points.length < 4) return 0;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      if (point[axis] < minimum[axis]) minimum[axis] = point[axis];
      if (point[axis] > maximum[axis]) maximum[axis] = point[axis];
    }
  }
  const spanX = maximum[0] - minimum[0];
  const spanY = maximum[1] - minimum[1];
  const spanZ = maximum[2] - minimum[2];
  return 2 * (spanX * spanY + spanY * spanZ + spanX * spanZ);
}

function sampleInterior(grid, allFaces, albedoOfPart, { roomRays, enclosedShare }) {
  const { cellSize, owners } = grid;
  const keepShare = Math.min(1, SHELL_MAXIMUM_INTERIOR_FACES / Math.max(allFaces.length, 1));
  const faceArea = (cellSize * cellSize) / keepShare;
  const fan = [0, 0, 0];
  const points = [];
  const albedoTotal = [0, 0, 0];
  let testedCount = 0;
  for (const entry of allFaces) {
    const { cell, face, normal, origin } = faceGeometry(grid, entry);
    if (keepShare < 1 && hashUnit(cell, face, 4) >= keepShare) continue;
    testedCount++;
    if (!isInteriorFace(grid, origin, normal, roomRays, enclosedShare, fan)) continue;
    const albedo = albedoOfPart[owners[cell] - 1];
    for (let channel = 0; channel < 3; channel++) albedoTotal[channel] += albedo[channel];
    points.push(origin);
  }
  const albedo = points.length ? albedoTotal.map(total => total / points.length) : [0, 0, 0];
  const meanAlbedo = (albedo[0] + albedo[1] + albedo[2]) / 3;
  const rawArea = points.length * faceArea;
  const envelopeArea = interiorEnvelopeArea(points);
  const area = envelopeArea > 0 ? Math.min(rawArea, envelopeArea) : rawArea;
  return { area, meanAlbedo, albedo, interiorShare: testedCount ? points.length / testedCount : 0, points };
}

/**
 * The lit, enclosed samples of the room shell of `surfaces`, the free-distance lookup over the same grid, and the room's
 * interior summary (`area`, `albedo`, `meanAlbedo`, `interiorShare`, `points`) in the form `findSunBounceLights` groups into
 * patches: `{ samples, freeDistanceOf, cellSize, interior }`, each sample being `{ point, normal, flux }`.
 * `sun` is `{ irradiance, direction }`; `roomRays` and `enclosedShare` are the room test of the triangle path.
 */
export function sampleShellSurfaces(surfaces, sun, { roomRays, enclosedShare, maximumCells = PROXY_MAXIMUM_CELLS }) {
  const grid = buildOccupancyGrid(surfaces, { maximumCells, recordOwners: true });
  const { cellSize, owners } = grid;
  const albedoOfPart = surfaces.map(part => partDiffuseAlbedo(part.material ?? {}));
  const { allFaces, sunFaces } = collectShellFaces(grid, sun.direction);
  const keepShare = Math.min(1, SHELL_MAXIMUM_CANDIDATES / Math.max(sunFaces.length, 1));
  const faceArea = (cellSize * cellSize) / keepShare;
  const fan = [0, 0, 0];
  const samples = [];
  for (const entry of sunFaces) {
    const { cell, face, normal, centre, origin } = faceGeometry(grid, entry);
    if (keepShare < 1 && hashUnit(cell, face, 3) >= keepShare) continue;
    if (!rayEscapes(grid, origin[0], origin[1], origin[2], sun.direction[0], sun.direction[1], sun.direction[2])) continue;
    if (!isInteriorFace(grid, origin, normal, roomRays, enclosedShare, fan)) continue;
    const cosine = normal[0] * sun.direction[0] + normal[1] * sun.direction[1] + normal[2] * sun.direction[2];
    const albedo = albedoOfPart[owners[cell] - 1];
    samples.push({
      point: centre.map((value, axis) => value + normal[axis] * cellSize * 0.5),
      normal,
      flux: sun.irradiance.map((channel, index) => channel * cosine * faceArea * albedo[index]),
    });
  }
  const freeDistanceOf = (point, normal) => {
    const start = point.map((value, axis) => value + normal[axis] * cellSize * START_OFFSET_CELLS);
    return cellSize * START_OFFSET_CELLS + rayHitDistance(grid, start[0], start[1], start[2], normal[0], normal[1], normal[2]);
  };
  const interior = sampleInterior(grid, allFaces, albedoOfPart, { roomRays, enclosedShare });
  return { samples, freeDistanceOf, cellSize, interior };
}
