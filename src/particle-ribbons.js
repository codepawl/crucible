// Beams and trails (#3240): a textured strip between two nodes, and a ribbon that follows one moving node. Both are a pure function of the
// time asked and of the node poses at that time. A trail never keeps the points it drew before: frame N reads the pose of its node at
// N, N minus a little, N minus a little more, so a seek or a frame-range render repeats exactly.

import { curveAt, colorCurveAt } from './particle-curves.js';

export const RIBBON_LIMITS = Object.freeze({ maxBeamSegments: 64, maxTrailSegments: 128, maxWidth: 100, maxTrailLifetime: 10, minTrailLifetime: 0.05 });

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function unit(vector, fallback) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 1e-9 ? [vector[0] / length, vector[1] / length, vector[2] / length] : fallback;
}

/** World position of `offset` (in the node's own frame) under a column-major 4x4 `matrix`. */
export function transformPoint(matrix, offset) {
  return [0, 1, 2].map(row => matrix[12 + row] + matrix[row] * offset[0] + matrix[4 + row] * offset[1] + matrix[8 + row] * offset[2]);
}

// The side direction of the strip along the segment from `from` to `to`: across the segment and across the view, so the strip faces the camera.
function segmentSide(from, to, camera, fallback) {
  const tangent = unit(subtract(to, from), null);
  if (!tangent) return fallback;
  const middle = [0, 1, 2].map(axis => (from[axis] + to[axis]) / 2);
  const toCamera = camera ? subtract(camera.eye, middle) : [0, 0, 1];
  const side = unit(cross(tangent, toCamera), null);
  return side ?? unit(cross(tangent, Math.abs(tangent[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]), [1, 0, 0]);
}

// Longest a mitred corner may stretch the width: a sharper turn is cut at this factor, so a hairpin never throws a spike.
const MAX_MITRE = 2;

/**
 * A strip through `points`, `widths[i]` wide at point i, turned around its own axis to face `camera` ({ eye }). Without a camera the strip
 * keeps the side of its first tangent against +Y. Each ring sits on the mitre of its two segments (the side that bisects the corner, the
 * width stretched by 1 over the cosine of half the turn, up to MAX_MITRE), so a bend keeps its width and neighbouring quads share an
 * edge instead of overlapping. `alphas[i]` is the opacity and `u[i]` the texture coordinate along the strip; v runs 0 to 1 across it.
 */
export function buildRibbonMesh(points, widths, alphas, u, look = {}, camera = undefined) {
  const count = points.length;
  const positions = new Float32Array(count * 6);
  const normals = new Float32Array(count * 6);
  const uvs = new Float32Array(count * 4);
  const colors = new Float32Array(count * 6);
  const vertexOpacity = look.fade === 'opacity' ? new Float32Array(count * 2) : undefined;
  const indices = new Uint32Array((count - 1) * 6);
  const segmentSides = [];
  let previousSide = [1, 0, 0];
  for (let index = 0; index < count - 1; index++) {
    previousSide = segmentSide(points[index], points[index + 1], camera, previousSide);
    segmentSides.push(previousSide);
  }
  const tint = [1, 1, 1];
  for (let index = 0; index < count; index++) {
    const point = points[index];
    const before = segmentSides[Math.max(index - 1, 0)];
    const after = segmentSides[Math.min(index, count - 2)];
    const side = unit([before[0] + after[0], before[1] + after[1], before[2] + after[2]], after);
    const stretch = Math.min(1 / Math.max(side[0] * after[0] + side[1] * after[1] + side[2] * after[2], 1 / MAX_MITRE), MAX_MITRE);
    const tangent = unit(subtract(points[Math.min(index + 1, count - 1)], points[Math.max(index - 1, 0)]), [0, 1, 0]);
    const facing = unit(cross(side, tangent), [0, 0, 1]);
    const alpha = alphas[index];
    if (look.colorCurve) colorCurveAt(look.colorCurve, index / (count - 1), tint);
    else tint.fill(1);
    for (let corner = 0; corner < 2; corner++) {
      const vertex = index * 2 + corner;
      const sign = corner === 0 ? -1 : 1;
      for (let axis = 0; axis < 3; axis++) {
        positions[vertex * 3 + axis] = point[axis] + side[axis] * sign * widths[index] * stretch / 2;
        normals[vertex * 3 + axis] = facing[axis];
        colors[vertex * 3 + axis] = tint[axis] * (vertexOpacity ? 1 : alpha);
      }
      uvs[vertex * 2] = u[index];
      uvs[vertex * 2 + 1] = corner;
      if (vertexOpacity) vertexOpacity[vertex] = alpha;
    }
    if (index < count - 1) {
      const base = index * 2;
      indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], index * 6);
    }
  }
  const mesh = { positions, normals, uvs, colors, indices };
  if (vertexOpacity) mesh.vertexOpacity = vertexOpacity;
  return mesh;
}

/**
 * The two ends of a beam in world space at `time`: `poseOf(nodeId, time)` is a node's world matrix, and each end adds its own `offset`
 * in that node's frame (an attachment point).
 */
export function beamEndpoints(beam, poseOf, time) {
  return [beam.from, beam.to].map(end => transformPoint(poseOf(end.node, time), end.offset));
}

/** The beam strip at `time` between the endpoints `start` and `end`: a straight line, or a bow whose middle is lifted by `beam.curve`. */
export function buildBeamMesh(beam, start, end, time, camera) {
  const segments = beam.segments;
  const middle = [0, 1, 2].map(axis => (start[axis] + end[axis]) / 2 + 2 * beam.curve[axis]);
  const points = [];
  const widths = [];
  const alphas = [];
  const u = [];
  for (let index = 0; index <= segments; index++) {
    const along = index / segments;
    const point = [0, 1, 2].map(axis => (1 - along) * (1 - along) * start[axis] + 2 * (1 - along) * along * middle[axis] + along * along * end[axis]);
    points.push(point);
    widths.push(curveAt(beam.width, along));
    alphas.push(curveAt(beam.alpha, along));
    u.push(along * beam.repeat + beam.scroll * time);
  }
  return buildRibbonMesh(points, widths, alphas, u, beam, camera);
}

/**
 * The trail of a node at `time`: ring i is where the node was `lifetime * i / segments` seconds earlier, read from its pose at that
 * time (never earlier than 0). `poseOf(nodeId, time)` is the node's world matrix. Width and alpha follow the age of the point.
 */
export function buildTrailMesh(trail, poseOf, time, camera) {
  const points = [];
  const widths = [];
  const alphas = [];
  const u = [];
  for (let index = 0; index <= trail.segments; index++) {
    const age = index / trail.segments;
    const sampleTime = Math.max(time - age * trail.lifetime, 0);
    points.push(transformPoint(poseOf(trail.follow, sampleTime), trail.offset));
    widths.push(curveAt(trail.width, age));
    // A point older than the scene has no history: the trail starts where the node started.
    alphas.push(time - age * trail.lifetime < 0 ? 0 : curveAt(trail.alpha, age));
    u.push(age * trail.repeat);
  }
  return buildRibbonMesh(points, widths, alphas, u, trail, camera);
}
