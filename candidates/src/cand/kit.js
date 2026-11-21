import { mat4, quat } from 'gl-matrix';
import { createSceneGraph } from '../scene-graph.js';

/** Catmull-Rom smoothing of a lathe profile so turned silhouettes have no facets. */
export function smoothProfile(points, perSpan = 6) {
  const result = [];
  for (let index = 0; index < points.length - 1; index++) {
    const before = points[Math.max(0, index - 1)];
    const start = points[index];
    const end = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    for (let step = 0; step < perSpan; step++) {
      const t = step / perSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push([0, 1].map(axis => 0.5 * (2 * start[axis] + (-before[axis] + end[axis]) * t + (2 * before[axis] - 5 * start[axis] + 4 * end[axis] - after[axis]) * t2 + (-before[axis] + 3 * start[axis] - 3 * end[axis] + after[axis]) * t3)));
    }
  }
  result.push(points.at(-1));
  return result.map(([radius, height]) => [Math.max(0, radius), height]);
}

export function createPartList() {
  const parts = [];
  function add(name, geometry, material, position = [0, 0, 0], scale = [1, 1, 1], angles = [0, 0, 0]) {
    const matrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), ...angles), position, scale);
    parts.push({ name, geometry, material, matrix });
    return parts.at(-1);
  }
  return { parts, add };
}

/** Parent every part under one root so the graph carries hierarchy, and let `animated` entries move their local matrix over time. */
export function finishScene({ name, rootName, parts, animated = [], rootMotion, portraitScale = 1.6, sample }) {
  const graph = createSceneGraph([{ name: rootName }, ...parts.map(part => ({ ...part, parent: rootName }))]);
  for (const entry of animated) entry.localMatrix = graph.getNode(entry.part.name).localMatrix;
  const root = graph.getNode(rootName);
  const rootBase = rootMotion ? root.localMatrix.slice() : undefined;
  const first = sample(0, 16 / 9);
  const offset = first.eye.map((value, axis) => value - first.target[axis]);
  const distance = Math.hypot(...offset);
  return {
    name, parts: graph.parts, graph,
    view: { yaw: Math.atan2(offset[0], offset[2]), pitch: Math.asin(offset[1] / distance), distance, portraitScale },
    sample(time = 0, aspect = 16 / 9) {
      for (const entry of animated) {
        entry.localMatrix.set(entry.base);
        entry.apply(entry.localMatrix, time);
      }
      if (rootMotion) {
        root.localMatrix.set(rootBase);
        rootMotion(root.localMatrix, time);
      }
      graph.update();
      return sample(time, aspect);
    },
  };
}

export const effects = { bloom: { strength: 0.1, threshold: 1, radius: 1.2 }, saturation: 0.95, contrast: 1.04, temperature: 0.03, vignette: 0.11, grain: 0.004 };
