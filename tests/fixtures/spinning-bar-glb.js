/**
 * A GLB of a floor slab and a red bar that turns once a second about the view axis (z), as rigid node animation: the kind of
 * scene a part-by-part export makes. The bar is at the origin, 2 m long, so a quarter turn moves its tip about 1.4 m.
 */
const CORNERS = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

function unitBox() {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const face of CORNERS) {
    const first = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(...corner.map(flag => (flag ? 0.5 : -0.5)));
      normals.push(...face.normal);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions, normals, indices };
}

function padded(buffer, fill) {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

export function spinningBarGlb() {
  const box = unitBox();
  const quarterTurns = [0, 1, 2, 3, 4];
  const times = quarterTurns.map(turn => turn / 4);
  const rotations = quarterTurns.flatMap(turn => [0, 0, Math.sin(turn * Math.PI / 4), Math.cos(turn * Math.PI / 4)]);
  const chunks = [
    Buffer.from(new Float32Array(box.positions).buffer),
    Buffer.from(new Float32Array(box.normals).buffer),
    Buffer.from(new Uint16Array(box.indices).buffer),
    Buffer.from(new Float32Array(times).buffer),
    Buffer.from(new Float32Array(rotations).buffer),
  ];
  const views = [];
  let offset = 0;
  const padChunks = chunks.map(chunk => padded(chunk, 0));
  padChunks.forEach((chunk, index) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: chunks[index].length });
    offset += chunk.length;
  });
  const vertexCount = box.positions.length / 3;
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'floor', mesh: 0, translation: [0, -1.2, 0], scale: [14, 0.2, 14] },
      { name: 'bar', mesh: 1, scale: [2, 0.25, 0.25] },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 1 }] },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.55, 0.55, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
      { pbrMetallicRoughness: { baseColorFactor: [0.9, 0.12, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.5 } },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: box.indices.length, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: times.length, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: times.length, type: 'VEC4' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    animations: [{
      name: 'spin',
      samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    }],
  };
  const json = padded(Buffer.from(JSON.stringify(document)), 0x20);
  const binary = Buffer.concat(padChunks);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.write('JSON', 4, 'latin1');
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.write('BIN\0', 4, 'latin1');
  return Buffer.concat([header, jsonHeader, json, binaryHeader, binary]);
}
