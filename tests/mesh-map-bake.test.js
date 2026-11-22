import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { compileMaterialGraph } from '../src/material-graph.js';
import { normalizeMaterialPattern } from '../src/material-patterns.js';
import { bakeHighToLowNormalMap, bakeMeshMap, meshMapForGeometry, MESH_MAP_LIMITS } from '../src/mesh-map-bake.js';

const RESOLUTION = 128;

// A box of the given size with one UV cell per face (3 columns by 2 rows), so every face is its own island.
function boxGeometry(sizeX, sizeY, sizeZ) {
  const faces = [
    { origin: [0, 0, sizeZ], across: [sizeX, 0, 0], up: [0, sizeY, 0] },
    { origin: [sizeX, 0, 0], across: [-sizeX, 0, 0], up: [0, sizeY, 0] },
    { origin: [sizeX, 0, sizeZ], across: [0, 0, -sizeZ], up: [0, sizeY, 0] },
    { origin: [0, 0, 0], across: [0, 0, sizeZ], up: [0, sizeY, 0] },
    { origin: [0, sizeY, 0], across: [0, 0, sizeZ], up: [sizeX, 0, 0] },
    { origin: [0, 0, sizeZ], across: [0, 0, -sizeZ], up: [sizeX, 0, 0] },
  ];
  const positions = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const first = positions.length / 3;
    for (const [alongAcross, alongUp] of corners) {
      for (let axis = 0; axis < 3; axis++) positions.push(face.origin[axis] + face.across[axis] * alongAcross + face.up[axis] * alongUp);
      uvs.push(((faceIndex % 3) + 0.02 + 0.96 * alongAcross) / 3, (Math.floor(faceIndex / 3) + 0.02 + 0.96 * alongUp) / 2);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

// A floor and a wall meeting at a right angle: the floor next to the wall is a cavity.
function cornerGeometry() {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 0.5, 0, 0.5, 1, 0, 1, 0.5, 0, 1, 0, 1, 1, 0.5, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]),
  };
}

function bevelledCube() {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'mesh', base: { type: 'box', bevel: 0.1, subdivisions: 1 }, edits: [{ op: 'uv_project', mode: 'cube' }] }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }],
  };
  return createAgentScene(recipe).parts[0].geometry;
}

function redChannel(map) {
  const values = new Uint8Array(map.width * map.height);
  for (let texel = 0; texel < values.length; texel++) values[texel] = map.data[texel * 4];
  return values;
}

function share(values, test) {
  let count = 0;
  for (const value of values) if (test(value)) count++;
  return count / values.length;
}

test('curvature of a bevelled cube is flat on the faces, high on the bevels and never strongly concave', () => {
  const values = redChannel(bakeMeshMap(bevelledCube(), 'curvature', { resolution: 256 }));
  assert.ok(share(values, value => value >= 126 && value <= 129) > 0.15, 'the middle of each face sits at 0.5');
  assert.ok(share(values, value => value > 160) > 0.02, 'the bevels are convex');
  assert.equal(share(values, value => value > 0 && value < 100), 0, 'a convex solid has no concave texel');
  assert.ok(Math.max(...values) <= 255);
});

// The profile of a box corner with a chamfer, extruded along z: the side, the chamfer and the top, each its own UV island,
// so the middle of the chamfer sits on a seam between the two halves of a bevel in a cube projection.
function chamferGeometry() {
  const profile = [[0.06, -1.06], [0.06, -0.06], [0, 0], [-1, 0]];
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let segment = 0; segment < 3; segment++) {
    const [from, to] = [profile[segment], profile[segment + 1]];
    const first = positions.length / 3;
    positions.push(from[0], from[1], 0, to[0], to[1], 0, to[0], to[1], 1, from[0], from[1], 1);
    uvs.push(segment / 3, 0, (segment + 1) / 3, 0, (segment + 1) / 3, 1, segment / 3, 1);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

test('a bevel reads as one band: the middle of the strip is at least as convex as its borders', () => {
  const resolution = 192;
  const map = bakeMeshMap(chamferGeometry(), 'curvature', { resolution });
  const at = (fractionAcrossChamfer) => map.data[(Math.floor(resolution / 2) * resolution + Math.floor((1 + fractionAcrossChamfer) * resolution / 3)) * 4];
  const profile = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map(at);
  assert.ok(profile[3] >= profile[0] && profile[3] >= profile[6], `middle ${profile[3]} against borders ${profile[0]} and ${profile[6]}: ${profile}`);
  assert.ok(Math.min(...profile) > 150, `no unworn gap across the strip: ${profile}`);
  const flatTop = map.data[(Math.floor(resolution / 2) * resolution + Math.floor(2.1 * resolution / 3)) * 4];
  assert.ok(flatTop < Math.min(...profile), `the flat face beyond the bevel stays lower: ${flatTop}`);
});

// A crate whose edges are cut into 4 segments: the band edge of a wear mask must not scallop at the period of the cuts or of
// any grid the bake uses. The top face's island starts at column 150 of a 1024 map; walking down a column from its first
// row, the band ends where the value falls below 150.
test('the band edge along a straight bevel stays straight (within 1 px), not scalloped', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0.06, subdivisions: 1 }, edits: [{ op: 'subdivide_edges', edges: { all: true }, cuts: 3 }, { op: 'uv_project', mode: 'cube' }] }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'crate', geometry: 'crate', material: 'paint' }],
  };
  const resolution = 1024;
  const map = bakeMeshMap(createAgentScene(recipe).parts[0].geometry, 'curvature', { resolution });
  const bandEndRows = [];
  for (let column = 175; column < 290; column++) {
    let row = 20;
    while (row < 100 && map.data[(row * resolution + column) * 4] >= 150) row++;
    bandEndRows.push(row);
  }
  const spread = Math.max(...bandEndRows) - Math.min(...bandEndRows);
  assert.ok(spread <= 1, `the band edge wanders ${spread} px along a straight bevel: ${bandEndRows}`);
  assert.ok(Math.min(...bandEndRows) > 30, 'the band covers the bevel strip');
});

test('curvature sees a fold on a seam between islands, and a larger radius widens the band', () => {
  const seamed = redChannel(bakeMeshMap(boxGeometry(1, 1, 1), 'curvature', { resolution: 128 }));
  assert.ok(share(seamed, value => value > 140) > 0.02, 'each face of this box is its own island, and its edges are still convex');
  const wide = redChannel(bakeMeshMap(bevelledCube(), 'curvature', { resolution: 256, radius: 0.12 }));
  const narrow = redChannel(bakeMeshMap(bevelledCube(), 'curvature', { resolution: 256, radius: 0.03 }));
  assert.ok(share(wide, value => value > 140) > share(narrow, value => value > 140), 'a larger radius widens the band');
});

test('ambient occlusion is zero on a convex cube and high in the corner of a floor and a wall', () => {
  assert.equal(Math.max(...redChannel(bakeMeshMap(boxGeometry(1, 1, 1), 'ao', { resolution: RESOLUTION }))), 0);
  const map = bakeMeshMap(cornerGeometry(), "ao", { resolution: 128, distance: 0.5 });
  const at = (u, v) => map.data[(Math.floor(v * 128) * 128 + Math.floor(u * 128)) * 4];
  // The floor spans u 0 to 0.5 and v 0 to 1, with v running along z: v 0.04 is beside the wall, v 0.96 is far from it.
  assert.ok(at(0.25, 0.04) > 60, `beside the wall ${at(0.25, 0.04)}`);
  assert.equal(at(0.25, 0.96), 0, 'far from the wall nothing is within reach');
  assert.ok(Math.min(...redChannel(map)) >= 0 && Math.max(...redChannel(map)) <= 255);
});

test('thickness is the depth of the solid behind each texel: a slab is thinner than a cube', () => {
  const cube = redChannel(bakeMeshMap(boxGeometry(1, 1, 1), 'thickness', { resolution: 64, distance: 1 }));
  const slab = redChannel(bakeMeshMap(boxGeometry(1, 1, 0.05), 'thickness', { resolution: 64, distance: 1 }));
  const meanOf = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(meanOf(cube) > 2 * meanOf(slab), `cube ${meanOf(cube)} against slab ${meanOf(slab)}`);
  assert.ok(Math.max(...slab) < 0.35 * 255, 'no slab texel is as deep as the cube');
});

test('a map is deterministic, the seed changes the rays, and the geometry cache returns one map', () => {
  const geometry = cornerGeometry();
  const first = bakeMeshMap(geometry, 'ao', { resolution: 64, distance: 0.5 });
  assert.deepEqual(bakeMeshMap(geometry, 'ao', { resolution: 64, distance: 0.5 }).data, first.data);
  assert.notDeepEqual(bakeMeshMap(geometry, 'ao', { resolution: 64, distance: 0.5, seed: 9 }).data, first.data);
  assert.equal(meshMapForGeometry(geometry, 'curvature', 32), meshMapForGeometry(geometry, 'curvature', 32));
});

test('the high-to-low normal map reads the tilt of the high mesh in tangent space', () => {
  const low = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  const high = { positions: Float32Array.from([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
  const map = bakeHighToLowNormalMap(low, high, { resolution: 16, cage: 2 });
  const texel = (8 * 16 + 8) * 4;
  assert.ok(Math.abs(map.data[texel] - 37) <= 2, `red ${map.data[texel]}: the slope leans against the u direction`);
  assert.ok(Math.abs(map.data[texel + 1] - 128) <= 2, `green ${map.data[texel + 1]}`);
  assert.ok(Math.abs(map.data[texel + 2] - 218) <= 2, `blue ${map.data[texel + 2]}`);
  const away = bakeHighToLowNormalMap(low, { positions: Float32Array.from([5, 5, 5, 6, 5, 5, 6, 6, 5]) }, { resolution: 16, cage: 0.2 });
  assert.deepEqual([...away.data.slice(texel, texel + 4)], [128, 128, 255, 255], 'nothing in reach leaves the flat normal');
});

test('bad input is refused with what to pass instead', () => {
  const noUvs = { positions: cornerGeometry().positions };
  assert.throws(() => bakeMeshMap(noUvs, 'curvature'), /meshMap.*a mesh with UVs/);
  assert.throws(() => bakeMeshMap(cornerGeometry(), 'normal'), /one of curvature, ao, thickness.*bakeHighToLowNormalMap/);
  assert.throws(() => bakeMeshMap(cornerGeometry(), 'ao', { resolution: 4096 }), /resolution.*from 1 to 2048/);
  assert.throws(() => bakeMeshMap(cornerGeometry(), 'ao', { rays: 0 }), /rays.*from 1 to 64/);
  assert.throws(() => bakeMeshMap(cornerGeometry(), 'ao', { radius: -1 }), /radius.*positive number of metres/);
  assert.throws(() => bakeMeshMap({ positions: new Float32Array(3) }, 'ao'), /geometry.*at least one triangle/);
  assert.throws(() => bakeMeshMap(boxGeometry(1, 1, 1), 'ao', { resolution: 2048, rays: 64 }), /would cast.*limit is 16000000.*smaller resolution or fewer rays/);
  assert.throws(() => bakeHighToLowNormalMap(cornerGeometry(), cornerGeometry(), { cage: -1 }), /cage/);
  assert.equal(MESH_MAP_LIMITS.resolution[1], 2048);
});

const curvaturePattern = { type: 'graph', mapping: 'uv', resolution: 256, graph: { color: { mul: [[1, 1, 1], { meshMap: { name: 'curvature' } }] } } };

function sceneWith(pattern, geometryEdits) {
  return createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'mesh', base: { type: 'box', bevel: 0.1, subdivisions: 1 }, edits: geometryEdits }],
    materials: [{ id: 'paint', pattern }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }],
  });
}

test('the meshMap node reads the baked map, so a graph can wear edges from the curvature', () => {
  const scene = sceneWith(curvaturePattern, [{ op: 'uv_project', mode: 'cube' }]);
  const colors = redChannel({ width: 256, height: 256, data: scene.parts[0].material.map.image.data });
  assert.ok(Math.max(...colors) > 210, "the bevels are bright");
  assert.ok(share(colors, value => value > 150 && value < 215) > 0.3, "the faces are mid grey (0.5 linear is about 188)");
});

test('the meshMap node validates its name and needs uv mapping and a mesh with UVs', () => {
  assert.ok(compileMaterialGraph(curvaturePattern.graph).outputs.color);
  assert.throws(() => compileMaterialGraph({ roughness: { meshMap: { name: 'rust' } } }), /meshMap name must be one of curvature, ao, thickness, got "rust"/);
  assert.throws(() => compileMaterialGraph({ roughness: { meshMap: { name: 'ao', extra: 1 } } }), /meshMap/);
  assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph: curvaturePattern.graph }), /meshMap node.*"mapping": "uv"/);
  assert.throws(() => sceneWith(curvaturePattern, []), /meshMap.*a mesh with UVs/);
});
