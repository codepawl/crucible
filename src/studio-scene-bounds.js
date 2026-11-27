import { vec3 } from 'gl-matrix';

/** The box around every part of the scene, or null for a scene with no geometry. */
export function measureSceneBounds(scene) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const point = vec3.create();
  for (const part of scene.parts) {
    const positions = part.matrix && part.geometry?.positions;
    for (let offset = 0; positions && offset < positions.length; offset += 3) {
      vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
      vec3.transformMat4(point, point, part.matrix);
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
  }
  return minimum[0] === Infinity ? null : { min: minimum, max: maximum };
}

/** Remembers the bounds of a scene until its revision changes, so a mark that asks every frame does not walk every vertex. */
export function createSceneBoundsCache() {
  let cached = { scene: null, revision: -1, bounds: null };
  return {
    read(scene) {
      if (cached.scene !== scene || cached.revision !== scene.revision) {
        cached = { scene, revision: scene.revision, bounds: measureSceneBounds(scene) };
      }
      return cached.bounds;
    },
  };
}
