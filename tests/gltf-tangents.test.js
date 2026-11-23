import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshoptTangents } from 'meshoptimizer';
import { parseGltf } from '../src/gltf.js';
import { generateTangents } from '../src/gltf-tangents.js';
import { createFragmentShader, createVertexShader, TANGENT_FEATURE } from '../src/shaders.js';
import { decodeTangentCode, encodeTangentCode, packNormalsWithTangents, validateGeometryTangents } from '../src/tangent-encoding.js';
import { shaderFeaturesOfParts } from '../src/renderer.js';

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';
const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
// glTF v runs down the image, so the vertex at y = 1 has v = 0.
const PLAIN_UVS = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);

function dataUri(...arrays) {
  const bytes = Buffer.concat(arrays.map(array => Buffer.from(array.buffer)));
  return `data:application/octet-stream;base64,${bytes.toString('base64')}`;
}

/** Stands in for the browser image decoder, which Node does not have. */
async function withImageDecoder(run) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  try {
    return await run();
  } finally {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  }
}

/** A quad with a normal map. `tangents` (a Float32Array of VEC4) and `uvs` are optional; `material` extends the material. */
function quadDocument({ tangents, uvs = PLAIN_UVS, material = {} } = {}) {
  const arrays = [QUAD_POSITIONS, QUAD_NORMALS, uvs, ...(tangents ? [tangents] : []), QUAD_INDICES];
  const sizes = arrays.map(array => array.byteLength);
  const offsets = sizes.map((_, index) => sizes.slice(0, index).reduce((total, size) => total + size, 0));
  const attributes = { POSITION: 0, NORMAL: 1 };
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
  ];
  if (uvs) {
    attributes.TEXCOORD_0 = accessors.push({ bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }) - 1;
  }
  if (tangents) {
    attributes.TANGENT = accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC4' }) - 1;
  }
  const indexView = arrays.length - 1;
  accessors.push({ bufferView: indexView, componentType: 5123, count: 6, type: 'SCALAR' });
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: accessors.length - 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: {}, normalTexture: { index: 0 }, ...material }],
    accessors,
    bufferViews: arrays.map((array, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: array.byteLength })),
    buffers: [{ byteLength: sizes.reduce((total, size) => total + size, 0), uri: dataUri(...arrays) }],
    textures: [{ source: 0 }],
    images: [{ uri: PNG_IMAGE }],
  });
}

async function loadGeometry(options) {
  const { parts, warnings } = await withImageDecoder(() => parseGltf(quadDocument(options)));
  return { geometry: parts[0].geometry, parts, warnings };
}

function tangentRows(tangents) {
  return Array.from({ length: tangents.length / 4 }, (_, vertex) => Array.from(tangents.subarray(vertex * 4, vertex * 4 + 4)).map(value => Math.round(value * 1e4) / 1e4));
}

test('an authored TANGENT reaches the geometry with its handedness sign', async () => {
  const authored = new Float32Array([1, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0, 1, 0, 1, 0, -1]);
  const { geometry, warnings } = await loadGeometry({ tangents: authored });
  assert.deepEqual(Array.from(geometry.tangents), Array.from(authored));
  assert.deepEqual(warnings, []);
  const packed = packNormalsWithTangents(geometry.normals, geometry.tangents);
  const decoded = [0, 1, 2, 3].map(vertex => decodeTangentCode([0, 0, 1], packed[vertex * 4 + 3]));
  assert.deepEqual(decoded.map(frame => frame.handedness), [1, -1, 1, -1]);
  decoded.forEach((frame, vertex) => {
    frame.tangent.forEach((value, axis) => assert.ok(Math.abs(value - authored[vertex * 4 + axis]) < 1e-6, `vertex ${vertex} axis ${axis}`));
  });
});

test('a primitive without TANGENT gets tangents generated from its UVs', async () => {
  const { geometry } = await loadGeometry();
  assert.deepEqual(tangentRows(geometry.tangents), Array(4).fill([1, 0, 0, 1]));
});

test('generated tangents follow a skewed, a mirrored and a rotated UV layout', () => {
  const layouts = {
    skewed: [[0, 1, 1, 1, 1.5, 0, 0.5, 0], [1, 0, 0, 1]],
    mirrored: [[1, 1, 0, 1, 0, 0, 1, 0], [-1, 0, 0, -1]],
    rotated: [[0, 0, 0, 1, 1, 1, 1, 0], [0, 1, 0, 1]],
  };
  for (const [name, [uvs, expected]] of Object.entries(layouts)) {
    const tangents = generateTangents(QUAD_POSITIONS, QUAD_NORMALS, new Float32Array(uvs), Uint32Array.from(QUAD_INDICES));
    assert.deepEqual(tangentRows(tangents), Array(4).fill(expected), name);
  }
});

test('generated tangents match meshoptimizer MikkTSpace tangents on a curved mesh with the glTF v axis', async () => {
  await MeshoptTangents.ready;
  const columns = 12;
  const rows = 8;
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const azimuth = column / columns * Math.PI * 2;
      const polar = row / rows * Math.PI;
      const normal = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      positions.push(...normal);
      normals.push(...normal);
      uvs.push(column / columns, row / rows);
    }
  }
  const indices = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const second = first + columns + 1;
      // Counter-clockwise seen from outside, so the triangle winding agrees with the vertex normals.
      indices.push(first, first + 1, second, first + 1, second + 1, second);
    }
  }
  const sphere = [new Float32Array(positions), new Float32Array(normals), new Float32Array(uvs), Uint32Array.from(indices)];
  const ours = generateTangents(...sphere);
  // MikkTSpace takes v up the image; glTF stores v down it.
  const flippedUvs = Float32Array.from(uvs, (value, index) => (index % 2 ? 1 - value : value));
  const oracle = MeshoptTangents.generateTangents(sphere[3], sphere[0], 3, sphere[1], 3, flippedUvs, 2, ['Compatible']);
  // meshoptimizer returns one tangent per index (per triangle corner); ours is one per vertex.
  let compared = 0;
  sphere[3].forEach((vertex, corner) => {
    const polarRow = Math.floor(vertex / (columns + 1));
    if (polarRow === 0 || polarRow === rows) return;
    const alignment = [0, 1, 2].reduce((total, axis) => total + ours[vertex * 4 + axis] * oracle[corner * 4 + axis], 0);
    assert.ok(alignment > 0.999, `corner ${corner} (vertex ${vertex}) tangent alignment ${alignment}`);
    assert.equal(ours[vertex * 4 + 3], oracle[corner * 4 + 3], `corner ${corner} handedness`);
    compared++;
  });
  assert.ok(compared > 50);
});

test('a primitive without UVs gets no tangents and keeps the derivative frame', async () => {
  const { parts } = await withImageDecoder(async () => {
    try {
      return await parseGltf(quadDocument({ uvs: null }));
    } catch (error) {
      return { parts: [], error };
    }
  });
  // A normal map without TEXCOORD_0 is dropped by the loader's fallbacks, so no part carries tangents.
  for (const part of parts) assert.equal(part.geometry.tangents, undefined);
});

test('an unusable authored TANGENT is replaced by generated tangents with a repair note', async () => {
  const withNaN = new Float32Array([NaN, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const { geometry, warnings } = await loadGeometry({ tangents: withNaN });
  assert.deepEqual(tangentRows(geometry.tangents), Array(4).fill([1, 0, 0, 1]));
  assert.ok(warnings.some(warning => /TANGENT has non-finite values/.test(warning)), warnings.join('|'));
});

test('a rotated KHR_texture_transform drops the authored TANGENT for generated ones', async () => {
  const authored = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const transform = { extensions: { KHR_texture_transform: { rotation: Math.PI / 2 } } };
  const document = JSON.parse(quadDocument({ tangents: authored }));
  document.materials[0].normalTexture = { index: 0, ...transform };
  document.materials[0].pbrMetallicRoughness = { baseColorTexture: { index: 0, ...transform } };
  document.extensionsUsed = ['KHR_texture_transform'];
  const { parts, warnings } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.ok(warnings.some(warning => /does not fit the normal map UVs/.test(warning)), warnings.join('|'));
  assert.notDeepEqual(tangentRows(parts[0].geometry.tangents)[0], [1, 0, 0, 1]);
});

test('a primitive with TANGENT but no normal map carries no tangents', async () => {
  const authored = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const document = JSON.parse(quadDocument({ tangents: authored }));
  delete document.materials[0].normalTexture;
  const { parts } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.equal(parts[0].geometry.tangents, undefined);
});

test('the shader reads vertex tangents only when the tangents feature is on', () => {
  const plainVertex = createVertexShader(['normalMap']);
  const plainFragment = createFragmentShader(['normalMap']);
  assert.ok(!/worldTangent|normalAndTangentCode/.test(plainVertex + plainFragment));
  const vertex = createVertexShader(['normalMap', TANGENT_FEATURE]);
  const fragment = createFragmentShader(['normalMap', TANGENT_FEATURE]);
  assert.match(vertex, /layout\(location=1\) in vec4 normalAndTangentCode;/);
  assert.match(vertex, /out vec4 worldTangent;/);
  assert.match(fragment, /in vec4 worldTangent;/);
  assert.match(fragment, /if \(worldTangent\.w != 0\.0\)/);
  assert.ok(fragment.includes('derivative') || fragment.includes('dFdx(worldPosition)'), 'the derivative frame stays as the fallback');
});

test('the renderer asks for the tangents feature for a normal-mapped part whose geometry has tangents', async () => {
  const { parts } = await loadGeometry();
  assert.ok(shaderFeaturesOfParts(parts).has(TANGENT_FEATURE));
  const unmapped = parts.map(part => ({ ...part, material: { ...part.material, normalMap: undefined } }));
  assert.ok(!shaderFeaturesOfParts(unmapped).has(TANGENT_FEATURE));
  const boxMapped = parts.map(part => ({ ...part, material: { ...part.material, boxMapScale: 1 } }));
  assert.ok(!shaderFeaturesOfParts(boxMapped).has(TANGENT_FEATURE));
});

test('tangent codes round-trip, and a vertex without a direction encodes as no tangent', () => {
  for (const normal of [[0, 0, 1], [0, 1, 0], [0.6, 0, 0.8], [-0.267, 0.534, -0.802]]) {
    const length = Math.hypot(...normal);
    const unitNormal = normal.map(value => value / length);
    const helper = Math.abs(unitNormal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const tangent = [helper[1] * unitNormal[2] - helper[2] * unitNormal[1], helper[2] * unitNormal[0] - helper[0] * unitNormal[2], helper[0] * unitNormal[1] - helper[1] * unitNormal[0]];
    const tangentLength = Math.hypot(...tangent);
    const unitTangent = tangent.map(value => value / tangentLength);
    for (const handedness of [1, -1]) {
      const decoded = decodeTangentCode(unitNormal, encodeTangentCode(unitNormal, unitTangent, handedness));
      assert.equal(decoded.handedness, handedness);
      unitTangent.forEach((value, axis) => assert.ok(Math.abs(value - decoded.tangent[axis]) < 1e-9));
    }
  }
  assert.equal(encodeTangentCode([0, 0, 1], [0, 0, 1], 1), 0);
  assert.equal(decodeTangentCode([0, 0, 1], 1), null, 'the attribute default of 1 means no tangent');
});

test('tangents of the wrong length are refused with what to pass', () => {
  assert.throws(() => validateGeometryTangents(new Float32Array(9), 3), /four values .* for each of the 3 vertices/);
  assert.doesNotThrow(() => validateGeometryTangents(new Float32Array(12), 3));
});
