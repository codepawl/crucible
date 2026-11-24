// A smoother normal field for slope masks. The welded normals of a coarse terrain mesh are linear inside each triangle, so a
// threshold on them bends at every triangle edge. Here each vertex normal is averaged, a few passes, with the normals of
// the vertices around it (every vertex at a neighbouring position, whichever side of a crease it sits on) that point
// within the crease angle of its own, so a ramp across several triangles becomes one curve while a real crease (a rock
// face against a tread, a cube edge) is not averaged away. Shading never sees this array; the answer depends only on the mesh.
import { verticesByPosition } from './mesh-weld-normals.js';

// Three passes of 1-ring averaging, over normals within 35 degrees of the vertex's own (measured on the six snow tiles: 2 passes
// leave more corners, 6 passes and a 25 degree gate lose more snow).
const PASSES = 3;
const CREASE_COSINE = Math.cos((35 * Math.PI) / 180);
const smoothedByGeometry = new WeakMap();

function groupNeighbours(geometry, groupOfVertex, groupCount) {
  const neighbours = Array.from({ length: groupCount }, () => new Set());
  const { indices } = geometry;
  for (let start = 0; start + 2 < indices.length; start += 3) {
    for (let slot = 0; slot < 3; slot++) {
      const group = groupOfVertex[indices[start + slot]];
      neighbours[group].add(groupOfVertex[indices[start + (slot + 1) % 3]]);
      neighbours[group].add(groupOfVertex[indices[start + (slot + 2) % 3]]);
    }
  }
  return neighbours;
}

function unitNormals(normals) {
  const unit = new Float32Array(normals.length);
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    unit[offset] = normals[offset] / length;
    unit[offset + 1] = normals[offset + 1] / length;
    unit[offset + 2] = normals[offset + 2] / length;
  }
  return unit;
}

function smoothPass(current, groups, groupOfVertex, neighbours) {
  const next = new Float32Array(current);
  for (let vertex = 0; vertex < groupOfVertex.length; vertex++) {
    const own = vertex * 3;
    let sumX = current[own];
    let sumY = current[own + 1];
    let sumZ = current[own + 2];
    for (const group of [groupOfVertex[vertex], ...neighbours[groupOfVertex[vertex]]]) {
      for (const other of groups[group]) {
        if (other === vertex) continue;
        const slot = other * 3;
        const dot = current[own] * current[slot] + current[own + 1] * current[slot + 1] + current[own + 2] * current[slot + 2];
        if (dot < CREASE_COSINE) continue;
        sumX += current[slot];
        sumY += current[slot + 1];
        sumZ += current[slot + 2];
      }
    }
    const length = Math.hypot(sumX, sumY, sumZ);
    if (length === 0) continue;
    next[own] = sumX / length;
    next[own + 1] = sumY / length;
    next[own + 2] = sumZ / length;
  }
  return next;
}

export function smoothedMaskNormals(geometry, weldedNormals) {
  if (!weldedNormals || !geometry.indices) return weldedNormals;
  const remembered = smoothedByGeometry.get(geometry);
  if (remembered) return remembered;
  const vertexCount = geometry.positions.length / 3;
  const groups = [...verticesByPosition(geometry.positions, vertexCount).values()];
  const groupOfVertex = new Uint32Array(vertexCount);
  groups.forEach((members, group) => members.forEach(vertex => { groupOfVertex[vertex] = group; }));
  const neighbours = groupNeighbours(geometry, groupOfVertex, groups.length);
  let current = unitNormals(weldedNormals);
  for (let pass = 0; pass < PASSES; pass++) current = smoothPass(current, groups, groupOfVertex, neighbours);
  smoothedByGeometry.set(geometry, current);
  return current;
}
