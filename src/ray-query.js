// Ray queries against a triangle world ({ positions, indices, bvh }). The traversal is written out here instead of going
// through the generic visitor in triangle-bvh.js: a path trace asks for hundreds of millions of rays, and a callback
// per box or triangle, plus boxed numbers on a plain-array stack, dominated the time (issue #129).

const STACK_SIZE = 160;
const MINIMUM_DIRECTION = 1e-30;
const BOX_TOLERANCE = 1e-12;
const TRIANGLE_STRIDE = 9;
// Indexed by whether a box was hit: a miss lifts its entry distance to Infinity without a branch.
const MISS_PENALTY = new Float64Array([Infinity, 0]);

/** Each triangle as corner and two edges, in leaf order, so a leaf reads one run of memory and no index lookups. */
function packLeafTriangles(positions, indices, triangleOrder) {
  const packed = new Float64Array(triangleOrder.length * TRIANGLE_STRIDE);
  for (let slot = 0; slot < triangleOrder.length; slot++) {
    const first = indices[triangleOrder[slot] * 3] * 3;
    const second = indices[triangleOrder[slot] * 3 + 1] * 3;
    const third = indices[triangleOrder[slot] * 3 + 2] * 3;
    const target = slot * TRIANGLE_STRIDE;
    for (let axis = 0; axis < 3; axis++) {
      packed[target + axis] = positions[first + axis];
      packed[target + 3 + axis] = positions[second + axis] - positions[first + axis];
      packed[target + 6 + axis] = positions[third + axis] - positions[first + axis];
    }
  }
  return packed;
}

function safeInverse(component) {
  if (component > MINIMUM_DIRECTION || component < -MINIMUM_DIRECTION) return 1 / component;
  return component < 0 ? -1 / MINIMUM_DIRECTION : 1 / MINIMUM_DIRECTION;
}

/**
 * Ray queries with preallocated state. `trace` returns a shared state object, so read it before the next query.
 * Visits nodes nearest first and skips any whose box starts past the nearest hit found so far.
 *
 * The box tests and the triangle test are written out inside `trace` on purpose: they run per node and per triangle of every
 * ray, and under test coverage each call and each branch also pays a counter, so the sky trace of a room (millions of rays)
 * cost five times its plain time with them split into helpers (#3454). The nearest distance lives in a local and is written
 * to `state` once, when the query ends.
 */
export function createTracer(world) {
  const { nodeBounds, rightChild, rangeStart, rangeCount } = world.bvh;
  const leafTriangles = packLeafTriangles(world.positions, world.indices, world.bvh.triangleOrder);
  const triangleOrder = world.bvh.triangleOrder;
  const nodeStack = new Int32Array(STACK_SIZE);
  const entryStack = new Float64Array(STACK_SIZE);
  const state = { nearestDistance: Infinity, nearestTriangle: -1, stopAtAnyHit: false };

  function trace(originX, originY, originZ, directionX, directionY, directionZ, limit, stopAtAnyHit) {
    let nearestDistance = limit;
    let nearestTriangle = -1;
    const inverseX = safeInverse(directionX);
    const inverseY = safeInverse(directionY);
    const inverseZ = safeInverse(directionZ);
    let stackSize = 1;
    nodeStack[0] = 0;
    // The root is always entered, so a query that misses the whole mesh still reports the triangles it tested.
    entryStack[0] = 0;
    search: while (stackSize > 0) {
      stackSize--;
      const node = nodeStack[stackSize];
      if (!(entryStack[stackSize] < nearestDistance)) continue;
      const right = rightChild[node];
      if (right < 0) {
        const end = rangeStart[node] + rangeCount[node];
        for (let slot = rangeStart[node]; slot < end; slot++) {
          const base = slot * TRIANGLE_STRIDE;
          const edgeSecondX = leafTriangles[base + 6];
          const edgeSecondY = leafTriangles[base + 7];
          const edgeSecondZ = leafTriangles[base + 8];
          const pivotX = directionY * edgeSecondZ - directionZ * edgeSecondY;
          const pivotY = directionZ * edgeSecondX - directionX * edgeSecondZ;
          const pivotZ = directionX * edgeSecondY - directionY * edgeSecondX;
          const edgeFirstX = leafTriangles[base + 3];
          const edgeFirstY = leafTriangles[base + 4];
          const edgeFirstZ = leafTriangles[base + 5];
          const determinant = edgeFirstX * pivotX + edgeFirstY * pivotY + edgeFirstZ * pivotZ;
          const offsetX = originX - leafTriangles[base];
          const offsetY = originY - leafTriangles[base + 1];
          const offsetZ = originZ - leafTriangles[base + 2];
          const firstWeight = (offsetX * pivotX + offsetY * pivotY + offsetZ * pivotZ) / determinant;
          const queryX = offsetY * edgeFirstZ - offsetZ * edgeFirstY;
          const queryY = offsetZ * edgeFirstX - offsetX * edgeFirstZ;
          const queryZ = offsetX * edgeFirstY - offsetY * edgeFirstX;
          const secondWeight = (directionX * queryX + directionY * queryY + directionZ * queryZ) / determinant;
          const distance = (edgeSecondX * queryX + edgeSecondY * queryY + edgeSecondZ * queryZ) / determinant;
          // One test for the whole triangle (a parallel triangle divides by zero and fails it too): each separate early exit would cost a counter under coverage.
          if ((firstWeight >= 0) & (firstWeight <= 1) & (secondWeight >= 0) & (firstWeight + secondWeight <= 1) & (distance >= 0) & (distance < nearestDistance)) {
            nearestDistance = distance;
            nearestTriangle = triangleOrder[slot];
            if (stopAtAnyHit) break search;
          }
        }
        continue;
      }
      // Distance along the ray to each child box (zero when the origin is inside), or Infinity for a miss.
      const left = node + 1;
      const leftOffset = left * 6;
      const leftFirstX = (nodeBounds[leftOffset] - originX) * inverseX;
      const leftSecondX = (nodeBounds[leftOffset + 3] - originX) * inverseX;
      const leftFirstY = (nodeBounds[leftOffset + 1] - originY) * inverseY;
      const leftSecondY = (nodeBounds[leftOffset + 4] - originY) * inverseY;
      const leftFirstZ = (nodeBounds[leftOffset + 2] - originZ) * inverseZ;
      const leftSecondZ = (nodeBounds[leftOffset + 5] - originZ) * inverseZ;
      const leftNear = Math.max(0, Math.min(leftFirstX, leftSecondX), Math.min(leftFirstY, leftSecondY), Math.min(leftFirstZ, leftSecondZ));
      const leftFar = Math.min(Math.max(leftFirstX, leftSecondX), Math.max(leftFirstY, leftSecondY), Math.max(leftFirstZ, leftSecondZ));
      const leftEntry = Math.max(leftNear, MISS_PENALTY[+(leftNear <= leftFar * (1 + BOX_TOLERANCE) + BOX_TOLERANCE)]);
      const rightOffset = right * 6;
      const rightFirstX = (nodeBounds[rightOffset] - originX) * inverseX;
      const rightSecondX = (nodeBounds[rightOffset + 3] - originX) * inverseX;
      const rightFirstY = (nodeBounds[rightOffset + 1] - originY) * inverseY;
      const rightSecondY = (nodeBounds[rightOffset + 4] - originY) * inverseY;
      const rightFirstZ = (nodeBounds[rightOffset + 2] - originZ) * inverseZ;
      const rightSecondZ = (nodeBounds[rightOffset + 5] - originZ) * inverseZ;
      const rightNear = Math.max(0, Math.min(rightFirstX, rightSecondX), Math.min(rightFirstY, rightSecondY), Math.min(rightFirstZ, rightSecondZ));
      const rightFar = Math.min(Math.max(rightFirstX, rightSecondX), Math.max(rightFirstY, rightSecondY), Math.max(rightFirstZ, rightSecondZ));
      const rightEntry = Math.max(rightNear, MISS_PENALTY[+(rightNear <= rightFar * (1 + BOX_TOLERANCE) + BOX_TOLERANCE)]);
      if (leftEntry <= rightEntry) {
        nodeStack[stackSize] = right;
        entryStack[stackSize] = rightEntry;
        nodeStack[stackSize + 1] = left;
        entryStack[stackSize + 1] = leftEntry;
      } else {
        nodeStack[stackSize] = left;
        entryStack[stackSize] = leftEntry;
        nodeStack[stackSize + 1] = right;
        entryStack[stackSize + 1] = rightEntry;
      }
      stackSize += 2;
    }
    state.nearestDistance = nearestDistance;
    state.nearestTriangle = nearestTriangle;
    state.stopAtAnyHit = stopAtAnyHit;
    return state;
  }
  return { trace, triangleOwner: world.triangleOwner };
}

/** Inverse-square falloff of a point or spot light, with the optional smooth range cutoff and a floor at its radius. */
export function pointLightFalloff(distanceSquared, light) {
  let cutoff = 1;
  if (light.range > 0) {
    const ratio = distanceSquared / (light.range * light.range);
    const fade = Math.max(1 - ratio * ratio, 0);
    cutoff = fade * fade;
  }
  return cutoff / Math.max(distanceSquared, light.radius * light.radius);
}
