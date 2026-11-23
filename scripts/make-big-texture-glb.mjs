// Writes a synthetic hero GLB for measuring how long the MCP preview takes to create a scene with big textures (#2896):
// a UV sphere of about 130,000 triangles with an 8192x8192 JPEG base colour and two 4096x4096 JPEG maps (normal, metallic-roughness).
//
//   node scripts/make-big-texture-glb.mjs <output.glb> [--base 8192] [--map 4096] [--triangles 130000]
//
// The images are noise under a gradient so the JPEGs have realistic entropy. Nothing is read from the network.
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { writeGlb, padded } from './agent-glb-io.mjs';

function parseArguments(argv) {
  const options = { base: 8192, map: 4096, triangles: 130000 };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) { positional.push(argv[index]); continue; }
    const key = argv[index].slice(2);
    const value = Number(argv[++index]);
    if (!(key in options) || !Number.isInteger(value) || value < 1) throw new Error(`Unknown or invalid option ${argv[index - 1]}; pass --base, --map or --triangles with a whole number.`);
    options[key] = value;
  }
  if (positional.length !== 1) throw new Error('Usage: node scripts/make-big-texture-glb.mjs <output.glb> [--base 8192] [--map 4096] [--triangles 130000]');
  return { ...options, output: positional[0] };
}

async function noiseJpeg(size, seed) {
  const channels = 3;
  const pixels = Buffer.alloc(size * size * channels);
  let state = seed;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const grain = (state >>> 24) / 255;
      const offset = (row * size + column) * channels;
      pixels[offset] = Math.min(255, 40 + (column / size) * 150 + grain * 14);
      pixels[offset + 1] = Math.min(255, 40 + (row / size) * 150 + grain * 14);
      pixels[offset + 2] = Math.min(255, 90 + grain * 20);
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels } }).jpeg({ quality: 80 }).toBuffer();
}

function sphereBuffers(targetTriangles) {
  const rings = Math.round(Math.sqrt(targetTriangles / 2));
  const segments = rings;
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (segment / segments) * Math.PI * 2;
      const x = Math.sin(polar) * Math.cos(azimuth);
      const y = Math.cos(polar);
      const z = Math.sin(polar) * Math.sin(azimuth);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(segment / segments, ring / rings);
    }
  }
  const indices = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const first = ring * (segments + 1) + segment;
      const second = first + segments + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

const options = parseArguments(process.argv.slice(2));
const sphere = sphereBuffers(options.triangles);
const images = [await noiseJpeg(options.base, 1), await noiseJpeg(options.map, 2), await noiseJpeg(options.map, 3)];
const chunks = [];
const bufferViews = [];
const accessors = [];
function addView(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const offset = chunks.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(padded(bytes, 0));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target && { target }) });
  return bufferViews.length - 1;
}
const positionView = addView(sphere.positions, 34962);
const normalView = addView(sphere.normals, 34962);
const uvView = addView(sphere.uvs, 34962);
const indexView = addView(sphere.indices, 34963);
const vertexCount = sphere.positions.length / 3;
accessors.push({ bufferView: positionView, componentType: 5126, count: vertexCount, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] });
accessors.push({ bufferView: normalView, componentType: 5126, count: vertexCount, type: 'VEC3' });
accessors.push({ bufferView: uvView, componentType: 5126, count: vertexCount, type: 'VEC2' });
accessors.push({ bufferView: indexView, componentType: 5125, count: sphere.indices.length, type: 'SCALAR' });
const imageDefinitions = images.map(bytes => ({ bufferView: addView(new Uint8Array(bytes)), mimeType: 'image/jpeg' }));
const binary = Buffer.concat(chunks);
const document = {
  asset: { version: '2.0', generator: 'crucible make-big-texture-glb' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'hero' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{ name: 'hero-material', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1 } }],
  textures: [{ source: 0 }, { source: 1 }, { source: 2 }], images: imageDefinitions,
  accessors, bufferViews, buffers: [{ byteLength: binary.length }],
};
writeFileSync(options.output, writeGlb(document, binary));
console.log(`${options.output}: ${sphere.indices.length / 3} triangles, ${(binary.length / 1024 ** 2).toFixed(1)} MiB of binary`);
