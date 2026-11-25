// A deterministic outdoor street written as code (no third-party assets) for the sky occlusion work (#3289): grey ground, three
// trees with wide canopies, a house with an eave and a porch roof, and an open lawn at the far end with nothing above it.
// The same scene is a GLB for `--scene file` and a list of parts for the tests.

const COMPONENTS_PER_TYPE = { SCALAR: 1, VEC3: 3 };

function paddedTo4(bytes, fill) {
  return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4, fill)]);
}

function chunk(bytes, type) {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(bytes.length, 0);
  prefix.write(type, 4, 'latin1');
  return Buffer.concat([prefix, bytes]);
}

const BOX_FACES = [
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
];

/** A box as outward-facing triangles: `center` and `size` in metres. */
export function boxMesh(center, size) {
  const positions = [];
  const indices = [];
  for (const face of BOX_FACES) {
    const base = positions.length / 3;
    for (const corner of face) {
      for (let axis = 0; axis < 3; axis++) positions.push(center[axis] + (corner[axis] - 0.5) * size[axis]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

/** A UV sphere stretched to `radii`, outward facing, with `segments` around and half as many from pole to pole. */
export function ellipsoidMesh(center, radii, segments = 16) {
  const rings = segments / 2;
  const positions = [];
  const indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = Math.PI * ring / rings;
    for (let step = 0; step <= segments; step++) {
      const azimuth = 2 * Math.PI * step / segments;
      positions.push(center[0] + radii[0] * Math.sin(polar) * Math.cos(azimuth), center[1] + radii[1] * Math.cos(polar), center[2] + radii[2] * Math.sin(polar) * Math.sin(azimuth));
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let step = 0; step < segments; step++) {
      const first = ring * (segments + 1) + step;
      const second = first + segments + 1;
      indices.push(first, first + 1, second, first + 1, second + 1, second);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

const BARK = [0.18, 0.11, 0.06, 1];
const LEAVES = [0.12, 0.3, 0.08, 1];
const WALL = [0.75, 0.7, 0.62, 1];
const ROOF = [0.45, 0.2, 0.15, 1];
const ASPHALT = [0.22, 0.22, 0.24, 1];
const GRASS = [0.22, 0.4, 0.12, 1];

/** The named meshes of the street. The trees stand at z = -6 on the street side; the lawn at x = 12 has nothing over it. */
export function canopyStreetMeshes({ cover = true } = {}) {
  const meshes = [
    { name: 'street', color: ASPHALT, ...boxMesh([0, -0.1, 8], [60, 0.2, 40]) },
    { name: 'lawn', color: GRASS, ...boxMesh([12, 0.02, 0], [8, 0.04, 10]) },
    ...(cover ? [{ name: 'house-body', color: WALL, ...boxMesh([-12, 2, 6], [9, 4, 7]) },
      { name: 'house-eave', color: ROOF, ...boxMesh([-12, 4.1, 2.2], [11, 0.2, 3.4]) },
      { name: 'porch-roof', color: ROOF, ...boxMesh([-5, 2.8, 2.2], [3, 0.15, 3]) }] : []),
  ];
  if (!cover) return meshes;
  [-5, 0, 5].forEach((x, index) => {
    meshes.push({ name: `trunk-${index}`, color: BARK, ...boxMesh([x, 1.3, -6], [0.5, 2.6, 0.5]) });
    meshes.push({ name: `canopy-${index}`, color: LEAVES, ...ellipsoidMesh([x, 4.2, -6], [3, 1.6, 3], 20) });
  });
  return meshes;
}

/** The meshes as renderer parts (identity matrices), the shape the sky grid traces. */
export function canopyStreetParts(options) {
  return canopyStreetMeshes(options).map(mesh => ({
    name: mesh.name,
    geometry: { positions: mesh.positions, indices: Uint32Array.from(mesh.indices) },
    matrix: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    material: { color: mesh.color.slice(0, 3), metallic: 0, roughness: 0.9 },
  }));
}

/** A binary glTF of the street, one mesh and one material per named piece. */
export function buildCanopyStreetGlb(options) {
  return buildGlbFromMeshes(canopyStreetMeshes(options));
}

/** A binary glTF of named meshes ({ name, color, positions, indices }), one mesh and one material per piece. */
export function buildGlbFromMeshes(meshes) {
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;
  const addAccessor = (data, componentType, type, target, extra = {}) => {
    const bytes = paddedTo4(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target });
    buffers.push(bytes);
    byteOffset += bytes.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: data.length / COMPONENTS_PER_TYPE[type], type, ...extra });
    return accessors.length - 1;
  };
  const glbMeshes = meshes.map(mesh => {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < mesh.positions.length; index++) {
      minimum[index % 3] = Math.min(minimum[index % 3], mesh.positions[index]);
      maximum[index % 3] = Math.max(maximum[index % 3], mesh.positions[index]);
    }
    const position = addAccessor(mesh.positions, 5126, 'VEC3', 34962, { min: minimum, max: maximum });
    const indices = addAccessor(mesh.indices, 5123, 'SCALAR', 34963);
    return { name: mesh.name, primitives: [{ attributes: { POSITION: position }, indices, material: meshes.indexOf(mesh) }] };
  });
  const materials = meshes.map(mesh => ({ name: mesh.name, pbrMetallicRoughness: { baseColorFactor: mesh.color, metallicFactor: 0, roughnessFactor: 0.9 } }));
  const binary = Buffer.concat(buffers);
  const json = paddedTo4(Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((mesh, index) => index) }],
    nodes: meshes.map((mesh, index) => ({ name: mesh.name, mesh: index })),
    meshes: glbMeshes, materials, accessors, bufferViews, buffers: [{ byteLength: binary.length }],
  })), 0x20);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  return Buffer.concat([header, chunk(json, 'JSON'), chunk(binary, 'BIN\0')]);
}
