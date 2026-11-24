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
// A vertex whose welded normal is steeper than STEEP_FROM (slope 0.8, 72 degrees) keeps it; the keep fades in from FADE_FROM. The choice is made per
// vertex and blended, never per triangle, so the mask stays continuous across triangle edges (a per-triangle switch between
// two normal fields left stair steps along every triangle edge that borders a steep face).
const FADE_FROM = 0.62;
const STEEP_FROM = 0.8;
const RIGHT_ANGLE = Math.PI / 2;
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

function keepSteepVertices(welded, smoothed) {
  const result = new Float32Array(smoothed);
  for (let offset = 0; offset < welded.length; offset += 3) {
    const length = Math.hypot(welded[offset], welded[offset + 1], welded[offset + 2]) || 1;
    const slope = Math.acos(Math.min(1, Math.max(-1, welded[offset + 1] / length))) / RIGHT_ANGLE;
    const fraction = Math.min(1, Math.max(0, (slope - FADE_FROM) / (STEEP_FROM - FADE_FROM)));
    const keep = fraction * fraction * (3 - 2 * fraction);
    const mixedX = (1 - keep) * smoothed[offset] + keep * welded[offset] / length;
    const mixedY = (1 - keep) * smoothed[offset + 1] + keep * welded[offset + 1] / length;
    const mixedZ = (1 - keep) * smoothed[offset + 2] + keep * welded[offset + 2] / length;
    const mixedLength = Math.hypot(mixedX, mixedY, mixedZ) || 1;
    result[offset] = mixedX / mixedLength;
    result[offset + 1] = mixedY / mixedLength;
    result[offset + 2] = mixedZ / mixedLength;
  }
  return result;
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
  const result = keepSteepVertices(weldedNormals, current);
  smoothedByGeometry.set(geometry, result);
  return result;
}
