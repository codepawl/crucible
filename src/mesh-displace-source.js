import { compileMaterialGraph, checkMaterialGraphWork, graphImageAssets, graphVertexGroupNames } from './material-graph.js';
import { displaceSourceFailure as sourceFailure, heightPatternOf } from './mesh-displace-keys.js';

// The height a mesh `displace` edit reads from a material graph or a catalog image instead of a field expression, so
// the same height shapes the silhouette and shades the bumps (#2863). Both are sampled at the mesh UVs, with the
// convention of a baked texture: u runs across the columns, v down the rows (row 0 on top), and the image repeats.

const wrapUnit = value => value - Math.floor(value);

function wrapIndex(index, size) {
  return ((index % size) + size) % size;
}

// Red channel of an image as a 0 to 1 height, read as bytes without a colour decode, with bilinear filtering.
function imageHeightSampler(frame, id) {
  const { width, height, data } = frame ?? {};
  if (!data || !(width > 0) || !(height > 0)) throw sourceFailure(`image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before the scene is created.`);
  const read = (column, row) => data[(wrapIndex(row, height) * width + wrapIndex(column, width)) * 4] / 255;
  return (u, v) => {
    const texelU = wrapUnit(u) * width - 0.5;
    const texelV = wrapUnit(v) * height - 0.5;
    const column = Math.floor(texelU);
    const row = Math.floor(texelV);
    const shareU = texelU - column;
    const shareV = texelV - row;
    const top = read(column, row) * (1 - shareU) + read(column + 1, row) * shareU;
    const bottom = read(column, row + 1) * (1 - shareU) + read(column + 1, row + 1) * shareU;
    return top * (1 - shareV) + bottom * shareV;
  };
}

function graphHeightSampler(pattern, id, images, vertexCount) {
  const graph = { height: pattern.graph.height };
  if (graphVertexGroupNames(graph).length) throw sourceFailure(`the height of material ${id} reads a vertex group, which a displace edit cannot sample. Use a height without vertexGroup nodes.`);
  const pool = new Map();
  for (const asset of graphImageAssets(graph)) {
    const frame = images?.get(asset.toLowerCase());
    if (!frame) throw sourceFailure(`the height of material ${id} reads image ${asset.slice(0, 12)}, which was not loaded. The host decodes catalog images before the scene is created.`);
    pool.set(asset.toLowerCase(), frame);
  }
  const compiled = compileMaterialGraph(graph, { size: pattern.size, images: pool });
  // One evaluation per vertex: bound the graph's cost as a texture of the same number of pixels.
  checkMaterialGraphWork(compiled, Math.max(1, Math.ceil(Math.sqrt(vertexCount))));
  const { evaluate } = compiled.outputs.height;
  return (u, v) => {
    const value = evaluate(u, v);
    return Number.isFinite(value) ? value : 0;
  };
}

/**
 * A resolver for mesh edits: `resolve(source, mesh)` returns the height at each vertex of the mesh. `materials` maps a recipe material
 * ID to the material, `images` maps a catalog image ID to its decoded frame ({ width, height, data } RGBA bytes).
 */
export function createHeightSourceResolver({ materials, images } = {}) {
  return (source, mesh) => {
    const vertexCount = mesh.vertexCount;
    if (source.image) return sourceHeightsAtVertices(mesh, imageHeightSampler(images?.get(source.image), source.image));
    const material = materials?.get(source.material);
    if (!material) throw sourceFailure(`material ${source.material} is not in the recipe. Use one of ${[...(materials?.keys() ?? [])].join(', ') || 'none yet; add the material first'}.`);
    return sourceHeightsAtVertices(mesh, graphHeightSampler(heightPatternOf(material, source.material), source.material, images, vertexCount));
  };
}

/**
 * The height at each vertex: the mean of the height at the UVs of its corners, so a vertex on a UV seam gets one value
 * and the surface stays closed. A mesh with no UVs cannot be sampled.
 */
export function sourceHeightsAtVertices(mesh, height) {
  const uv = mesh.attributes.corner.uv;
  if (!uv || uv.size !== 2) throw sourceFailure('the mesh has no UVs to sample. Add a uv_project or uv_unwrap edit before the displace, or start from a primitive that has UVs, such as a plane or grid.');
  const sums = new Float64Array(mesh.vertexCount);
  const counts = new Uint32Array(mesh.vertexCount);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const vertex = mesh.cornerVertices[corner];
    sums[vertex] += height(uv.data[corner * 2], uv.data[corner * 2 + 1]);
    counts[vertex]++;
  }
  const heights = new Float64Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) heights[vertex] = counts[vertex] ? sums[vertex] / counts[vertex] : 0;
  return heights;
}
