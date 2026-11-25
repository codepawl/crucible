// A small indoor set as code (#3389): a floor, a warm back wall and two side walls, and a ceiling. With `closed` the front wall is there
// too, so the same set is a sealed room. The camera stands at the open side, where a TV set's cameras stand.
import { boxMesh, buildGlbFromMeshes } from './canopy-street-glb.mjs';

const WARM_WALL = [0.85, 0.62, 0.3, 1];
const WOOD_FLOOR = [0.5, 0.38, 0.26, 1];
const WIDTH = 10;
const DEPTH = 8;
const HEIGHT = 4;
const THICKNESS = 0.2;

/** The named meshes of the set. The room is centred on the origin; the open side faces +z. */
export function openSetMeshes({ closed = false } = {}) {
  const meshes = [
    { name: 'floor', color: WOOD_FLOOR, ...boxMesh([0, -0.1, 0], [WIDTH, THICKNESS, DEPTH]) },
    { name: 'wall-back', color: WARM_WALL, ...boxMesh([0, HEIGHT / 2, -DEPTH / 2], [WIDTH, HEIGHT, THICKNESS]) },
    { name: 'wall-left', color: WARM_WALL, ...boxMesh([-WIDTH / 2, HEIGHT / 2, 0], [THICKNESS, HEIGHT, DEPTH]) },
    { name: 'wall-right', color: WARM_WALL, ...boxMesh([WIDTH / 2, HEIGHT / 2, 0], [THICKNESS, HEIGHT, DEPTH]) },
    { name: 'ceiling', color: WARM_WALL, ...boxMesh([0, HEIGHT + THICKNESS / 2, 0], [WIDTH + THICKNESS, THICKNESS, DEPTH + THICKNESS]) },
  ];
  if (closed) meshes.push({ name: 'wall-front', color: WARM_WALL, ...boxMesh([0, HEIGHT / 2, DEPTH / 2], [WIDTH, HEIGHT, THICKNESS]) });
  return meshes;
}

export function buildOpenSetGlb(options) {
  return buildGlbFromMeshes(openSetMeshes(options));
}
