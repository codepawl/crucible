// A flat-shaded triangle collector for the floor plan builder, plus the two triangulators it needs:
// a strip between two polylines (no vertex is skipped, so neighbouring faces share every vertex they touch)
// and an ear clipper for the floor and ceiling loops.

const DEGENERATE_AREA = 1e-12;

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

// One metre of wall is one texture unit, projected along the dominant axis of the face normal.
function planarUv(point, normal) {
  const [absoluteX, absoluteY, absoluteZ] = normal.map(Math.abs);
  if (absoluteY >= absoluteX && absoluteY >= absoluteZ) return [point[0], point[2]];
  if (absoluteX >= absoluteZ) return [point[2], point[1]];
  return [point[0], point[1]];
}

/** Collects triangles. Each one gets its own vertices and a flat normal, and is wound to face `outward`. */
export function createMeshBuilder() {
  const positions = [];
  const normals = [];
  const uvs = [];

  function addTriangle(first, second, third, outward) {
    let normal = cross(subtract(second, first), subtract(third, first));
    const doubleArea = Math.hypot(...normal);
    if (doubleArea < DEGENERATE_AREA) return;
    let corners = [first, second, third];
    if (dot(normal, outward) < 0) {
      corners = [first, third, second];
      normal = normal.map(component => -component);
    }
    const unit = normal.map(component => component / doubleArea);
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...unit);
      uvs.push(...planarUv(corner, unit));
    }
  }

  function addQuad(first, second, third, fourth, outward) {
    addTriangle(first, second, third, outward);
    addTriangle(first, third, fourth, outward);
  }

  /** Triangles between two polylines that both run from the same start to the same end, advancing by `key`. */
  function addStrip(lowSide, highSide, key, outward) {
    let low = 0;
    let high = 0;
    while (low < lowSide.length - 1 || high < highSide.length - 1) {
      const advanceLow = high === highSide.length - 1
        || (low < lowSide.length - 1 && key(lowSide[low + 1]) <= key(highSide[high + 1]));
      if (advanceLow) {
        addTriangle(lowSide[low], highSide[high], lowSide[low + 1], outward);
        low += 1;
      } else {
        addTriangle(lowSide[low], highSide[high], highSide[high + 1], outward);
        high += 1;
      }
    }
  }

  function vertexCount() {
    return positions.length / 3;
  }

  function finish() {
    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from({ length: positions.length / 3 }, (_, index) => index),
    };
  }

  return { addTriangle, addQuad, addStrip, vertexCount, finish };
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[(index + 1) % points.length];
    area += x * nextY - nextX * y;
  }
  return area / 2;
}

function turn(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function strictlyInside(point, first, second, third) {
  return turn(first, second, point) > DEGENERATE_AREA
    && turn(second, third, point) > DEGENERATE_AREA
    && turn(third, first, point) > DEGENERATE_AREA;
}

function findEar(points, remaining) {
  const count = remaining.length;
  for (let position = 0; position < count; position++) {
    const previous = remaining[(position + count - 1) % count];
    const current = remaining[position];
    const next = remaining[(position + 1) % count];
    if (turn(points[previous], points[current], points[next]) <= DEGENERATE_AREA) continue;
    const blocked = remaining.some(other => other !== previous && other !== current && other !== next
      && strictlyInside(points[other], points[previous], points[current], points[next]));
    if (!blocked) return position;
  }
  return -1;
}

function findFlatVertex(points, remaining) {
  const count = remaining.length;
  return remaining.findIndex((current, position) => Math.abs(turn(
    points[remaining[(position + count - 1) % count]], points[current], points[remaining[(position + 1) % count]],
  )) <= DEGENERATE_AREA);
}

/** Triangles of a simple 2D polygon, as index triples counter-clockwise in the polygon's own axes. */
export function triangulatePolygon(points) {
  const indices = points.map((_, index) => index);
  const remaining = signedArea(points) >= 0 ? indices : indices.reverse();
  const triangles = [];
  while (remaining.length > 3) {
    const earPosition = findEar(points, remaining);
    if (earPosition >= 0) {
      const count = remaining.length;
      triangles.push([remaining[(earPosition + count - 1) % count], remaining[earPosition], remaining[(earPosition + 1) % count]]);
      remaining.splice(earPosition, 1);
      continue;
    }
    const flatPosition = findFlatVertex(points, remaining);
    if (flatPosition < 0) throw new RangeError('floorPlan: a room loop could not be triangulated; pass walls that form a simple closed loop that does not cross itself.');
    remaining.splice(flatPosition, 1);
  }
  if (remaining.length === 3) triangles.push([...remaining]);
  return triangles;
}
