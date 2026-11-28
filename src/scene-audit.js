// Public instancing-aware scene geometry audit addon (@codepawlhq/crucible/addons/scene-audit).
// Deduplicates work per unique geometry template so 2,000+ instances / 4M+ triangles run in milliseconds
// and reports coplanar overlaps, OBB intersections, floating parts, and inverted exterior shells.

export const AUDIT_KINDS = Object.freeze(['coplanar', 'intersection', 'floating', 'inverted-shell']);

export const DEFAULT_AUDIT_OPTIONS = Object.freeze({
  coplanarTolerance: 1e-3,
  minOverlapArea: 1e-4,
  clearanceTolerance: 5e-3,
  supportTolerance: 0.02,
  maxFindings: 64,
  maxClustersPerTemplate: 24,
  maxClusterSampleTriangles: 16384,
});

const LARGE_CELL_SPAN_THRESHOLD = 48;

function matrixDeterminant3x3(matrix) {
  const a00 = matrix[0], a01 = matrix[4], a02 = matrix[8];
  const a10 = matrix[1], a11 = matrix[5], a12 = matrix[9];
  const a20 = matrix[2], a21 = matrix[6], a22 = matrix[10];
  return a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
}

function normalMatrixElements(matrix) {
  const a00 = matrix[0], a01 = matrix[4], a02 = matrix[8];
  const a10 = matrix[1], a11 = matrix[5], a12 = matrix[9];
  const a20 = matrix[2], a21 = matrix[6], a22 = matrix[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(determinant) < 1e-12) return null;
  const inverseDeterminant = 1 / determinant;
  return [
    c00 * inverseDeterminant, c01 * inverseDeterminant, c02 * inverseDeterminant,
    c10 * inverseDeterminant, c11 * inverseDeterminant, c12 * inverseDeterminant,
    c20 * inverseDeterminant, c21 * inverseDeterminant, c22 * inverseDeterminant,
  ];
}

function tangentFrame(nx, ny, nz) {
  const refX = Math.abs(ny) < 0.9 ? 0 : 1;
  const refY = Math.abs(ny) < 0.9 ? 1 : 0;
  const refZ = 0;
  let ux = refY * nz - refZ * ny;
  let uy = refZ * nx - refX * nz;
  let uz = refX * ny - refY * nx;
  const uLength = Math.hypot(ux, uy, uz);
  if (uLength < 1e-9) return { u: [1, 0, 0], v: [0, 1, 0] };
  ux /= uLength;
  uy /= uLength;
  uz /= uLength;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  return { u: [ux, uy, uz], v: [vx, vy, vz] };
}

function analyzeGeometryTemplate(geometry, options) {
  const positions = geometry?.positions;
  if (!positions || positions.length < 3) {
    throw new TypeError('auditScene: each part geometry must expose a non-empty positions array.');
  }
  const indices = geometry.indices;
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  const vertexCount = Math.floor(positions.length / 3);
  const localMin = [Infinity, Infinity, Infinity];
  const localMax = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
    if (x < localMin[0]) localMin[0] = x;
    if (y < localMin[1]) localMin[1] = y;
    if (z < localMin[2]) localMin[2] = z;
    if (x > localMax[0]) localMax[0] = x;
    if (y > localMax[1]) localMax[1] = y;
    if (z > localMax[2]) localMax[2] = z;
  }
  const centerX = (localMin[0] + localMax[0]) * 0.5;
  const centerY = (localMin[1] + localMax[1]) * 0.5;
  const centerZ = (localMin[2] + localMax[2]) * 0.5;

  const stride = Math.max(1, Math.floor(triangleCount / options.maxClusterSampleTriangles));
  let signedVolumeSix = 0;
  let outwardDotArea = 0;
  let totalArea = 0;
  const clusters = new Map();

  for (let triangle = 0; triangle < triangleCount; triangle += stride) {
    const base0 = indices ? indices[triangle * 3] * 3 : triangle * 9;
    const base1 = indices ? indices[triangle * 3 + 1] * 3 : triangle * 9 + 3;
    const base2 = indices ? indices[triangle * 3 + 2] * 3 : triangle * 9 + 6;
    const x0 = positions[base0], y0 = positions[base0 + 1], z0 = positions[base0 + 2];
    const x1 = positions[base1], y1 = positions[base1 + 1], z1 = positions[base1 + 2];
    const x2 = positions[base2], y2 = positions[base2 + 1], z2 = positions[base2 + 2];

    const edge1X = x1 - x0, edge1Y = y1 - y0, edge1Z = z1 - z0;
    const edge2X = x2 - x0, edge2Y = y2 - y0, edge2Z = z2 - z0;
    const crossX = edge1Y * edge2Z - edge1Z * edge2Y;
    const crossY = edge1Z * edge2X - edge1X * edge2Z;
    const crossZ = edge1X * edge2Y - edge1Y * edge2X;
    const doubleArea = Math.hypot(crossX, crossY, crossZ);
    if (!(doubleArea > 1e-12)) continue;

    if (stride === 1) {
      const c12X = y1 * z2 - z1 * y2;
      const c12Y = z1 * x2 - x1 * z2;
      const c12Z = x1 * y2 - y1 * x2;
      signedVolumeSix += x0 * c12X + y0 * c12Y + z0 * c12Z;
    }

    const area = doubleArea * 0.5;
    totalArea += area;
    const invLen = 1 / doubleArea;
    const nx = crossX * invLen, ny = crossY * invLen, nz = crossZ * invLen;
    const midX = (x0 + x1 + x2) / 3 - centerX;
    const midY = (y0 + y1 + y2) / 3 - centerY;
    const midZ = (z0 + z1 + z2) / 3 - centerZ;
    outwardDotArea += (midX * nx + midY * ny + midZ * nz) * area;

    const planeDistance = nx * x0 + ny * y0 + nz * z0;
    const key = `${Math.round(nx * 200)}:${Math.round(ny * 200)}:${Math.round(nz * 200)}:${Math.round(planeDistance * 500)}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      const frame = tangentFrame(nx, ny, nz);
      cluster = {
        normal: [nx, ny, nz],
        point: [x0, y0, z0],
        uAxis: frame.u,
        vAxis: frame.v,
        uMin: Infinity,
        uMax: -Infinity,
        vMin: Infinity,
        vMax: -Infinity,
        area: 0,
      };
      clusters.set(key, cluster);
    }
    cluster.area += area * stride;
    const { uAxis, vAxis } = cluster;
    const verts = [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]];
    for (const vertex of verts) {
      const u = vertex[0] * uAxis[0] + vertex[1] * uAxis[1] + vertex[2] * uAxis[2];
      const v = vertex[0] * vAxis[0] + vertex[1] * vAxis[1] + vertex[2] * vAxis[2];
      if (u < cluster.uMin) cluster.uMin = u;
      if (u > cluster.uMax) cluster.uMax = u;
      if (v < cluster.vMin) cluster.vMin = v;
      if (v > cluster.vMax) cluster.vMax = v;
    }
  }

  const boundedVolume = stride === 1 && Math.abs(signedVolumeSix) > 1e-7;
  const closedThinSpan = localMax[0] - localMin[0] > 1e-4 && localMax[1] - localMin[1] > 1e-4 && localMax[2] - localMin[2] > 1e-4;
  const templateInverted = triangleCount >= 4 && closedThinSpan
    ? (boundedVolume ? signedVolumeSix < 0 : outwardDotArea < -1e-5 * totalArea)
    : false;

  const sortedClusters = [...clusters.values()]
    .filter(cluster => cluster.area >= options.minOverlapArea)
    .sort((first, second) => second.area - first.area)
    .slice(0, options.maxClustersPerTemplate);

  return {
    localMin,
    localMax,
    halfExtents: [
      (localMax[0] - localMin[0]) * 0.5,
      (localMax[1] - localMin[1]) * 0.5,
      (localMax[2] - localMin[2]) * 0.5,
    ],
    localCenter: [centerX, centerY, centerZ],
    triangleCount,
    vertexCount,
    templateInverted,
    clusters: sortedClusters,
  };
}

function buildInstanceRecord({ target, template, matrix, isGround, supportsFloating, skipAudit }) {
  const transform = matrix;
  const localMin = template.localMin;
  const localMax = template.localMax;
  const minX = transform[0] * (transform[0] >= 0 ? localMin[0] : localMax[0]) + transform[4] * (transform[4] >= 0 ? localMin[1] : localMax[1]) + transform[8] * (transform[8] >= 0 ? localMin[2] : localMax[2]) + transform[12];
  const minY = transform[1] * (transform[1] >= 0 ? localMin[0] : localMax[0]) + transform[5] * (transform[5] >= 0 ? localMin[1] : localMax[1]) + transform[9] * (transform[9] >= 0 ? localMin[2] : localMax[2]) + transform[13];
  const minZ = transform[2] * (transform[2] >= 0 ? localMin[0] : localMax[0]) + transform[6] * (transform[6] >= 0 ? localMin[1] : localMax[1]) + transform[10] * (transform[10] >= 0 ? localMin[2] : localMax[2]) + transform[14];
  const maxX = transform[0] * (transform[0] >= 0 ? localMax[0] : localMin[0]) + transform[4] * (transform[4] >= 0 ? localMax[1] : localMin[1]) + transform[8] * (transform[8] >= 0 ? localMax[2] : localMin[2]) + transform[12];
  const maxY = transform[1] * (transform[1] >= 0 ? localMax[0] : localMin[0]) + transform[5] * (transform[5] >= 0 ? localMax[1] : localMin[1]) + transform[9] * (transform[9] >= 0 ? localMax[2] : localMin[2]) + transform[13];
  const maxZ = transform[2] * (transform[2] >= 0 ? localMax[0] : localMin[0]) + transform[6] * (transform[6] >= 0 ? localMax[1] : localMin[1]) + transform[10] * (transform[10] >= 0 ? localMax[2] : localMin[2]) + transform[14];

  const localCenter = template.localCenter;
  const worldCenter = [
    transform[0] * localCenter[0] + transform[4] * localCenter[1] + transform[8] * localCenter[2] + transform[12],
    transform[1] * localCenter[0] + transform[5] * localCenter[1] + transform[9] * localCenter[2] + transform[13],
    transform[2] * localCenter[0] + transform[6] * localCenter[1] + transform[10] * localCenter[2] + transform[14],
  ];
  const scaleX = Math.hypot(transform[0], transform[1], transform[2]);
  const scaleY = Math.hypot(transform[4], transform[5], transform[6]);
  const scaleZ = Math.hypot(transform[8], transform[9], transform[10]);
  const axes = [
    scaleX > 1e-9 ? [transform[0] / scaleX, transform[1] / scaleX, transform[2] / scaleX] : [1, 0, 0],
    scaleY > 1e-9 ? [transform[4] / scaleY, transform[5] / scaleY, transform[6] / scaleY] : [0, 1, 0],
    scaleZ > 1e-9 ? [transform[8] / scaleZ, transform[9] / scaleZ, transform[10] / scaleZ] : [0, 0, 1],
  ];
  const halfExtents = [
    template.halfExtents[0] * scaleX,
    template.halfExtents[1] * scaleY,
    template.halfExtents[2] * scaleZ,
  ];
  const determinant = matrixDeterminant3x3(transform);

  return {
    target,
    template,
    matrix: transform,
    determinant,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    worldCenter,
    axes,
    halfExtents,
    isGround,
    supportsFloating,
    skipAudit,
  };
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function obbPenetrationDepth(first, second) {
  const centerDelta = [
    second.worldCenter[0] - first.worldCenter[0],
    second.worldCenter[1] - first.worldCenter[1],
    second.worldCenter[2] - first.worldCenter[2],
  ];
  let minimumOverlap = Infinity;
  const candidateAxes = [...first.axes, ...second.axes];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const a = first.axes[i];
      const b = second.axes[j];
      const cx = a[1] * b[2] - a[2] * b[1];
      const cy = a[2] * b[0] - a[0] * b[2];
      const cz = a[0] * b[1] - a[1] * b[0];
      const length = Math.hypot(cx, cy, cz);
      if (length > 1e-5) candidateAxes.push([cx / length, cy / length, cz / length]);
    }
  }
  for (const axis of candidateAxes) {
    const distance = Math.abs(centerDelta[0] * axis[0] + centerDelta[1] * axis[1] + centerDelta[2] * axis[2]);
    const radiusFirst =
      first.halfExtents[0] * Math.abs(first.axes[0][0] * axis[0] + first.axes[0][1] * axis[1] + first.axes[0][2] * axis[2])
      + first.halfExtents[1] * Math.abs(first.axes[1][0] * axis[0] + first.axes[1][1] * axis[1] + first.axes[1][2] * axis[2])
      + first.halfExtents[2] * Math.abs(first.axes[2][0] * axis[0] + first.axes[2][1] * axis[1] + first.axes[2][2] * axis[2]);
    const radiusSecond =
      second.halfExtents[0] * Math.abs(second.axes[0][0] * axis[0] + second.axes[0][1] * axis[1] + second.axes[0][2] * axis[2])
      + second.halfExtents[1] * Math.abs(second.axes[1][0] * axis[0] + second.axes[1][1] * axis[1] + second.axes[1][2] * axis[2])
      + second.halfExtents[2] * Math.abs(second.axes[2][0] * axis[0] + second.axes[2][1] * axis[1] + second.axes[2][2] * axis[2]);
    const overlap = radiusFirst + radiusSecond - distance;
    if (overlap <= 0) return 0;
    if (overlap < minimumOverlap) minimumOverlap = overlap;
  }
  return minimumOverlap;
}

function worldClusterQuad(instance, cluster) {
  const normalMat = normalMatrixElements(instance.matrix);
  if (!normalMat) return null;
  const ln = cluster.normal;
  const wnx = normalMat[0] * ln[0] + normalMat[3] * ln[1] + normalMat[6] * ln[2];
  const wny = normalMat[1] * ln[0] + normalMat[4] * ln[1] + normalMat[7] * ln[2];
  const wnz = normalMat[2] * ln[0] + normalMat[5] * ln[1] + normalMat[8] * ln[2];
  const nLen = Math.hypot(wnx, wny, wnz);
  if (!(nLen > 1e-9)) return null;
  const flip = instance.determinant < 0 ? -1 : 1;
  const normal = [flip * wnx / nLen, flip * wny / nLen, flip * wnz / nLen];

  const transform = instance.matrix;
  const clusterPoint = cluster.point;
  const wx = transform[0] * clusterPoint[0] + transform[4] * clusterPoint[1] + transform[8] * clusterPoint[2] + transform[12];
  const wy = transform[1] * clusterPoint[0] + transform[5] * clusterPoint[1] + transform[9] * clusterPoint[2] + transform[13];
  const wz = transform[2] * clusterPoint[0] + transform[6] * clusterPoint[1] + transform[10] * clusterPoint[2] + transform[14];

  const { uAxis, vAxis } = cluster;
  const cornersLocal = [
    [uAxis[0] * cluster.uMin + vAxis[0] * cluster.vMin, uAxis[1] * cluster.uMin + vAxis[1] * cluster.vMin, uAxis[2] * cluster.uMin + vAxis[2] * cluster.vMin],
    [uAxis[0] * cluster.uMax + vAxis[0] * cluster.vMin, uAxis[1] * cluster.uMax + vAxis[1] * cluster.vMin, uAxis[2] * cluster.uMax + vAxis[2] * cluster.vMin],
    [uAxis[0] * cluster.uMax + vAxis[0] * cluster.vMax, uAxis[1] * cluster.uMax + vAxis[1] * cluster.vMax, uAxis[2] * cluster.uMax + vAxis[2] * cluster.vMax],
    [uAxis[0] * cluster.uMin + vAxis[0] * cluster.vMax, uAxis[1] * cluster.uMin + vAxis[1] * cluster.vMax, uAxis[2] * cluster.uMin + vAxis[2] * cluster.vMax],
  ];
  const planeOffset = cluster.normal[0] * clusterPoint[0] + cluster.normal[1] * clusterPoint[1] + cluster.normal[2] * clusterPoint[2];
  const cornersWorld = cornersLocal.map(offsetVec => {
    const localX = offsetVec[0] + cluster.normal[0] * planeOffset;
    const localY = offsetVec[1] + cluster.normal[1] * planeOffset;
    const localZ = offsetVec[2] + cluster.normal[2] * planeOffset;
    return [
      transform[0] * localX + transform[4] * localY + transform[8] * localZ + transform[12],
      transform[1] * localX + transform[5] * localY + transform[9] * localZ + transform[13],
      transform[2] * localX + transform[6] * localY + transform[10] * localZ + transform[14],
    ];
  });
  return { normal, point: [wx, wy, wz], corners: cornersWorld };
}

function projectCoplanarOverlapArea(firstQuad, secondQuad, tolerance) {
  const nA = firstQuad.normal;
  const nB = secondQuad.normal;
  const alignment = nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2];
  // Flag same-facing coplanar overlaps so clean stacked opposite faces stay quiet.
  if (alignment <= 0.995) return 0;
  const deltaX = secondQuad.point[0] - firstQuad.point[0];
  const deltaY = secondQuad.point[1] - firstQuad.point[1];
  const deltaZ = secondQuad.point[2] - firstQuad.point[2];
  const planeGap = Math.abs(deltaX * nA[0] + deltaY * nA[1] + deltaZ * nA[2]);
  if (planeGap > tolerance) return 0;

  const { u, v } = tangentFrame(nA[0], nA[1], nA[2]);
  const projectBounds = corners => {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const corner of corners) {
      const pu = corner[0] * u[0] + corner[1] * u[1] + corner[2] * u[2];
      const pv = corner[0] * v[0] + corner[1] * v[1] + corner[2] * v[2];
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
      if (pv < vMin) vMin = pv;
      if (pv > vMax) vMax = pv;
    }
    return { uMin, uMax, vMin, vMax };
  };
  const rectA = projectBounds(firstQuad.corners);
  const rectB = projectBounds(secondQuad.corners);
  const overlapU = Math.min(rectA.uMax, rectB.uMax) - Math.max(rectA.uMin, rectB.uMin);
  const overlapV = Math.min(rectA.vMax, rectB.vMax) - Math.max(rectA.vMin, rectB.vMin);
  return overlapU > 0 && overlapV > 0 ? overlapU * overlapV : 0;
}

function aabbsTouchOrOverlap(first, second, padding) {
  return first.max[0] + padding >= second.min[0] && second.max[0] + padding >= first.min[0]
    && first.max[1] + padding >= second.min[1] && second.max[1] + padding >= first.min[1]
    && first.max[2] + padding >= second.min[2] && second.max[2] + padding >= first.min[2];
}

function medianSpan(instances) {
  if (instances.length === 0) return 1;
  const spans = instances.map(item => Math.max(
    item.max[0] - item.min[0],
    item.max[1] - item.min[1],
    item.max[2] - item.min[2],
  )).sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)] || 1;
}

/**
 * Audit an array of Crucible parts (single or `instanceMatrices` batches) for coplanar overlaps,
 * OBB intersections, floating props, and inverted exterior shells without truncating instanced geometry.
 */
export function auditScene(parts, userOptions = {}) {
  if (!Array.isArray(parts)) {
    throw new TypeError('auditScene: parts must be an array of { geometry, matrix } objects.');
  }
  const startedAt = performance.now();
  const options = { ...DEFAULT_AUDIT_OPTIONS, ...userOptions };
  const templates = new Map();
  const instances = [];
  let totalTriangles = 0;

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (!part || typeof part !== 'object' || !part.geometry) {
      throw new TypeError(`auditScene: parts[${partIndex}] must have a geometry object.`);
    }
    let template = templates.get(part.geometry);
    if (!template) {
      template = analyzeGeometryTemplate(part.geometry, options);
      templates.set(part.geometry, template);
    }
    const baseName = String(part.id ?? part.name ?? `part-${partIndex}`);
    const isGround = Boolean(part.ground || part.role === 'ground');
    const supportsFloating = Boolean(part.supportsFloating || part.material?.tag === 'sky' || part.material?.tag === 'cloud');
    const skipAudit = Boolean(part.skipAudit);

    if (part.instanceMatrices) {
      const matrices = part.instanceMatrices;
      const isFlatBuffer = ArrayBuffer.isView(matrices);
      const count = isFlatBuffer ? Math.floor(matrices.length / 16) : matrices.length;
      totalTriangles += template.triangleCount * count;
      for (let instanceIndex = 0; instanceIndex < count; instanceIndex++) {
        const subMatrix = isFlatBuffer ? matrices.subarray(instanceIndex * 16, instanceIndex * 16 + 16) : matrices[instanceIndex];
        instances.push(buildInstanceRecord({
          target: `${baseName}[${instanceIndex}]`,
          template,
          matrix: subMatrix ?? IDENTITY_MATRIX,
          isGround,
          supportsFloating,
          skipAudit,
        }));
      }
    } else {
      totalTriangles += template.triangleCount;
      instances.push(buildInstanceRecord({
        target: baseName,
        template,
        matrix: part.matrix ?? IDENTITY_MATRIX,
        isGround,
        supportsFloating,
        skipAudit,
      }));
    }
  }

  const findings = [];
  const counts = { coplanar: 0, intersection: 0, floating: 0, 'inverted-shell': 0 };
  function pushFinding(entry) {
    counts[entry.kind] += 1;
    if (findings.length < options.maxFindings) {
      findings.push(entry);
    }
  }

  // 1. Inverted exterior shell check (template winding XOR negative-scale mirror).
  for (const instance of instances) {
    if (instance.skipAudit) continue;
    const isInverted = instance.template.templateInverted !== (instance.determinant < 0);
    if (isInverted) {
      pushFinding({
        kind: 'inverted-shell',
        severity: 'warn',
        target: instance.target,
        message: instance.determinant < 0
          ? `Shell "${instance.target}" has negative transform determinant (${instance.determinant.toFixed(3)}), flipping face normals inward.`
          : `Shell "${instance.target}" has inward-wound triangles.`,
        fix: instance.determinant < 0
          ? 'Use positive scale on the instance matrix and mirror geometry with outward winding.'
          : 'Run flip or recalculate outward normals on the source geometry.',
      });
    }
  }

  // 2. Build spatial hash grid for fast O(1) neighbor lookup.
  const cellSize = Math.max(0.25, Math.min(16, medianSpan(instances) * 1.25));
  const inverseCell = 1 / cellSize;
  const grid = new Map();
  const largeParts = [];

  for (let index = 0; index < instances.length; index++) {
    const item = instances[index];
    if (item.skipAudit) continue;
    const x0 = Math.floor(item.min[0] * inverseCell);
    const y0 = Math.floor(item.min[1] * inverseCell);
    const z0 = Math.floor(item.min[2] * inverseCell);
    const x1 = Math.floor(item.max[0] * inverseCell);
    const y1 = Math.floor(item.max[1] * inverseCell);
    const z1 = Math.floor(item.max[2] * inverseCell);
    const spanCount = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (item.isGround || spanCount > LARGE_CELL_SPAN_THRESHOLD) {
      largeParts.push(index);
      continue;
    }
    item.cells = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const cellKey = `${cx},${cy},${cz}`;
          item.cells.push(cellKey);
          let bucket = grid.get(cellKey);
          if (!bucket) {
            bucket = [];
            grid.set(cellKey, bucket);
          }
          bucket.push(index);
        }
      }
    }
  }

  // 3. Pairwise coplanar + OBB intersection checks over broad-phase neighbors.
  const worldQuadCache = new Map();
  function quadsFor(index) {
    let cached = worldQuadCache.get(index);
    if (cached) return cached;
    const item = instances[index];
    cached = item.template.clusters.map(cluster => worldClusterQuad(item, cluster)).filter(Boolean);
    worldQuadCache.set(index, cached);
    return cached;
  }

  const visitedPairs = new Set();
  const neighborPadding = Math.max(options.coplanarTolerance, options.clearanceTolerance);

  function evaluatePair(firstIndex, secondIndex) {
    const low = firstIndex < secondIndex ? firstIndex : secondIndex;
    const high = firstIndex < secondIndex ? secondIndex : firstIndex;
    if (low === high) return;
    const pairKey = low * instances.length + high;
    if (visitedPairs.has(pairKey)) return;
    visitedPairs.add(pairKey);

    const first = instances[low];
    const second = instances[high];
    if (first.skipAudit || second.skipAudit || (first.isGround && second.isGround)) return;
    if (!aabbsTouchOrOverlap(first, second, neighborPadding)) return;

    // Intersection check via 15-axis SAT OBB test (skip ground resting contacts).
    if (!first.isGround && !second.isGround) {
      const penetration = obbPenetrationDepth(first, second);
      if (penetration > options.clearanceTolerance) {
        pushFinding({
          kind: 'intersection',
          severity: 'warn',
          target: `${first.target} / ${second.target}`,
          penetration: Number(penetration.toFixed(4)),
          message: `Parts "${first.target}" and "${second.target}" intersect by ${penetration.toFixed(3)} m.`,
          fix: `Separate "${first.target}" and "${second.target}" by at least ${penetration.toFixed(3)} m along their contact normal.`,
        });
      }
    }

    // Coplanar overlap check over cached world face clusters.
    if (!first.isGround && !second.isGround) {
      const firstQuads = quadsFor(low);
      const secondQuads = quadsFor(high);
      let largestArea = 0;
      for (const quadA of firstQuads) {
        for (const quadB of secondQuads) {
          const overlapArea = projectCoplanarOverlapArea(quadA, quadB, options.coplanarTolerance);
          if (overlapArea > largestArea) largestArea = overlapArea;
        }
      }
      if (largestArea >= options.minOverlapArea) {
        pushFinding({
          kind: 'coplanar',
          severity: 'warn',
          target: `${first.target} / ${second.target}`,
          overlapArea: Number(largestArea.toFixed(4)),
          message: `Coplanar faces on "${first.target}" and "${second.target}" overlap (${largestArea.toFixed(4)} m^2).`,
          fix: 'Offset one surface by >= 1 mm or mark thin overlays with decal/depthLayer.',
        });
      }
    }
  }

  for (let index = 0; index < instances.length; index++) {
    const item = instances[index];
    if (item.skipAudit) continue;
    if (item.cells) {
      for (const cellKey of item.cells) {
        const bucket = grid.get(cellKey);
        if (!bucket) continue;
        for (const neighborIndex of bucket) {
          if (neighborIndex > index) evaluatePair(index, neighborIndex);
        }
      }
    }
    for (const largeIndex of largeParts) {
      if (largeIndex !== index) evaluatePair(index, largeIndex);
    }
  }

  // 4. Floating check against groundY and neighbor top surfaces.
  let groundY = typeof options.groundY === 'number' ? options.groundY : undefined;
  if (groundY === undefined) {
    let explicitGroundTop = -Infinity;
    let lowestY = Infinity;
    for (const item of instances) {
      if (item.isGround && item.max[1] > explicitGroundTop) explicitGroundTop = item.max[1];
      if (item.min[1] < lowestY) lowestY = item.min[1];
    }
    groundY = explicitGroundTop > -Infinity ? explicitGroundTop : (Number.isFinite(lowestY) ? lowestY : 0);
  }

  for (let index = 0; index < instances.length; index++) {
    const item = instances[index];
    if (item.skipAudit || item.isGround || item.supportsFloating) continue;
    const gapToGround = item.min[1] - groundY;
    if (gapToGround <= options.supportTolerance) continue;

    let supported = false;
    const checkSupport = candidateIndex => {
      if (candidateIndex === index) return false;
      const other = instances[candidateIndex];
      const xzOverlap = Math.min(item.max[0], other.max[0]) - Math.max(item.min[0], other.min[0]) > 1e-4
        && Math.min(item.max[2], other.max[2]) - Math.max(item.min[2], other.min[2]) > 1e-4;
      if (!xzOverlap) return false;
      return item.min[1] >= other.min[1] - options.supportTolerance && item.min[1] <= other.max[1] + options.supportTolerance;
    };

    for (const largeIndex of largeParts) {
      if (checkSupport(largeIndex)) {
        supported = true;
        break;
      }
    }
    if (!supported && item.cells) {
      const belowCellY = Math.floor((item.min[1] - options.supportTolerance) * inverseCell);
      const x0 = Math.floor(item.min[0] * inverseCell);
      const x1 = Math.floor(item.max[0] * inverseCell);
      const z0 = Math.floor(item.min[2] * inverseCell);
      const z1 = Math.floor(item.max[2] * inverseCell);
      outer: for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          for (let cy = belowCellY; cy <= Math.floor(item.min[1] * inverseCell); cy++) {
            const bucket = grid.get(`${cx},${cy},${cz}`);
            if (!bucket) continue;
            for (const neighborIndex of bucket) {
              if (checkSupport(neighborIndex)) {
                supported = true;
                break outer;
              }
            }
          }
        }
      }
    }

    if (!supported) {
      pushFinding({
        kind: 'floating',
        severity: 'warn',
        target: item.target,
        gap: Number(gapToGround.toFixed(4)),
        message: `Part "${item.target}" floats ${gapToGround.toFixed(3)} m above support/ground with nothing underneath.`,
        fix: `Lower "${item.target}" onto its support surface or bind it with a scene relation.`,
      });
    }
  }

  let uniqueTriangles = 0;
  for (const template of templates.values()) uniqueTriangles += template.triangleCount;
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  const totalFindings = counts.coplanar + counts.intersection + counts.floating + counts['inverted-shell'];

  return {
    ok: totalFindings === 0,
    stats: {
      partCount: parts.length,
      instanceCount: instances.length,
      uniqueGeometries: templates.size,
      totalTriangles,
      uniqueTriangles,
      elapsedMs,
    },
    counts,
    findings,
  };
}
