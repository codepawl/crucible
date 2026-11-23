import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { grid, sphere, torus } from '../src/geometry.js';
import { buildLathe, buildTube } from '../src/modeling-shapes.js';

// Crucible UVs put v = 0 at the top of the image, so an image reads the right way round from outside when
// (d position / d u) x (d position / d v) points into the surface, against the outward normal.
function handednessCounts(mesh) {
  let mirrored = 0;
  let readable = 0;
  const positionOf = vertex => [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis]);
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const [first, second, third] = [0, 1, 2].map(corner => mesh.indices[triangle + corner]);
    const edgeToSecond = positionOf(second).map((value, axis) => value - positionOf(first)[axis]);
    const edgeToThird = positionOf(third).map((value, axis) => value - positionOf(first)[axis]);
    const uvSecond = [mesh.uvs[second * 2] - mesh.uvs[first * 2], mesh.uvs[second * 2 + 1] - mesh.uvs[first * 2 + 1]];
    const uvThird = [mesh.uvs[third * 2] - mesh.uvs[first * 2], mesh.uvs[third * 2 + 1] - mesh.uvs[first * 2 + 1]];
    const determinant = uvSecond[0] * uvThird[1] - uvSecond[1] * uvThird[0];
    if (Math.abs(determinant) < 1e-12) continue;
    const alongU = edgeToSecond.map((value, axis) => (value * uvThird[1] - edgeToThird[axis] * uvSecond[1]) / determinant);
    const alongV = edgeToSecond.map((value, axis) => (edgeToThird[axis] * uvSecond[0] - value * uvThird[0]) / determinant);
    const cross = [alongU[1] * alongV[2] - alongU[2] * alongV[1], alongU[2] * alongV[0] - alongU[0] * alongV[2], alongU[0] * alongV[1] - alongU[1] * alongV[0]];
    const outward = [0, 1, 2].map(axis => mesh.normals[first * 3 + axis]);
    const facing = cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2];
    if (facing > 0) mirrored++;
    else readable++;
  }
  return { mirrored, readable };
}

const shapes = {
  grid: () => grid(4),
  sphere: () => sphere(16, 8),
  torus: () => torus(0.2, 16, 8),
  'torus arc': () => torus(0.2, 16, 8, Math.PI),
  'lathe bottom to top': () => buildLathe([[0.5, -0.5], [1, 0], [0.5, 0.5]], 12, 0, Math.PI * 2),
  'lathe top to bottom': () => buildLathe([[0.5, 0.5], [1, 0], [0.5, -0.5]], 12, 0, Math.PI * 2),
  tube: () => buildTube([[0, 0, 0], [0, 0, 1], [0, 1, 2]], false, 0.1, 8, 8),
  'tube along x': () => buildTube([[0, 0, 0], [1, 0, 0], [1, 1, 0]], false, 0.1, 8, 8),
};
for (const [name, make] of Object.entries(shapes)) {
  test(`${name}: an image reads the right way round from outside (#3017)`, () => {
    const { mirrored, readable } = handednessCounts(make());
    assert.equal(mirrored, 0, `${mirrored} triangles are mirrored`);
    assert.ok(readable > 0);
  });
}

test('sphere: u grows to the right for a viewer on +Z with Y up (#3017)', () => {
  const mesh = sphere(16, 8);
  const equatorRow = 4;
  const columns = 16 + 1;
  const front = [];
  for (let column = 0; column < columns; column++) {
    const vertex = equatorRow * columns + column;
    if (mesh.positions[vertex * 3 + 2] > 0.5) front.push({ x: mesh.positions[vertex * 3], u: mesh.uvs[vertex * 2] });
  }
  assert.ok(front.length >= 3);
  front.sort((first, second) => first.x - second.x);
  for (let index = 1; index < front.length; index++) assert.ok(front[index].u > front[index - 1].u, 'u must increase with x on the +Z side');
  const poleRow = mesh.uvs[1];
  assert.equal(poleRow, 0, 'v stays 0 at the north pole');
});

test('a sphere exported to GLB keeps UVs that read the right way round when the file is read back (#3017)', async () => {
  const matrix = mat4.fromRotationTranslationScale(mat4.create(), [0, 0, 0, 1], [0, 0, 0], [1, 1, 1]);
  const material = { color: [1, 1, 1], roughness: 0.5, metallic: 0 };
  const asset = await parseGltf(exportGlb([{ name: 'ball', geometry: sphere(16, 8), matrix, material }]));
  const readBack = asset.parts[0].geometry;
  assert.ok(readBack.uvs, 'the exported sphere carries TEXCOORD_0');
  const { mirrored, readable } = handednessCounts(readBack);
  assert.equal(mirrored, 0);
  assert.ok(readable > 0);
});
