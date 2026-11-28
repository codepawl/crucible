// Fast opt-in scene health hints for code-first `CrucibleRenderer` callers (`devHints: true`).
import { geometryBoundingSphere } from './render-culling.js';

const MAX_PAIRWISE_PARTS = 128;
const COPLANAR_FACE_TOLERANCE = 2e-3;
const FLOATING_CLEARANCE = 0.05;
const MINIMUM_OVERLAP = 1e-3;

function partName(part, index) {
  return part.id ?? part.name ?? `part-${index}`;
}

function worldBoundsOfPart(part) {
  const { minimum, maximum } = geometryBoundingSphere(part.geometry);
  const matrix = part.matrix;
  if (!matrix) {
    return { min: [...minimum], max: [...maximum] };
  }
  const worldMin = [Infinity, Infinity, Infinity];
  const worldMax = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? maximum[0] : minimum[0];
    const y = corner & 2 ? maximum[1] : minimum[1];
    const z = corner & 4 ? maximum[2] : minimum[2];
    const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    worldMin[0] = Math.min(worldMin[0], worldX);
    worldMin[1] = Math.min(worldMin[1], worldY);
    worldMin[2] = Math.min(worldMin[2], worldZ);
    worldMax[0] = Math.max(worldMax[0], worldX);
    worldMax[1] = Math.max(worldMax[1], worldY);
    worldMax[2] = Math.max(worldMax[2], worldZ);
  }
  return { min: worldMin, max: worldMax };
}

function overlapsOnOtherAxes(first, second, skipAxis) {
  for (let axis = 0; axis < 3; axis++) {
    if (axis === skipAxis) continue;
    const overlap = Math.min(first.max[axis], second.max[axis]) - Math.max(first.min[axis], second.min[axis]);
    if (overlap <= MINIMUM_OVERLAP) return false;
  }
  return true;
}

function hasCoplanarFacePair(first, second) {
  for (let axis = 0; axis < 3; axis++) {
    if (!overlapsOnOtherAxes(first, second, axis)) continue;
    // Flag same-facing coplanar faces (same min or same max plane); a part resting cleanly on top of a support (min == other.max) is valid contact.
    if (
      Math.abs(first.min[axis] - second.min[axis]) <= COPLANAR_FACE_TOLERANCE
      || Math.abs(first.max[axis] - second.max[axis]) <= COPLANAR_FACE_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
}

function hasXzFootprintOverlap(first, second) {
  return Math.min(first.max[0], second.max[0]) - Math.max(first.min[0], second.min[0]) > MINIMUM_OVERLAP
    && Math.min(first.max[2], second.max[2]) - Math.max(first.min[2], second.min[2]) > MINIMUM_OVERLAP;
}

function detectUnlitOrFlatScene(parts, { shading = 'full' } = {}) {
  if (parts.length === 0) return null;
  if (shading === 'unlit') {
    return {
      code: 'PLAIN_UNLIT_GEOMETRY',
      severity: 'warn',
      message: 'CrucibleRenderer was constructed with shading: "unlit", bypassing all directional and environment lighting.',
      fix: 'Use default shading: "full" unless intentionally rendering an unlit overlay.',
    };
  }
  const missingNormalsCount = parts.filter(part => !part.geometry?.normals).length;
  if (missingNormalsCount === parts.length) {
    return {
      code: 'PLAIN_UNLIT_GEOMETRY',
      severity: 'warn',
      message: `All ${parts.length} part(s) have no vertex normals, so surfaces look flat.`,
      fix: 'Ensure geometries include normals (built-in primitives provide normals; custom meshes need computeVertexNormals or normals).',
    };
  }
  if (parts.length >= 2 && parts.every(part => part.material?.tag === 'unlit')) {
    return {
      code: 'PLAIN_UNLIT_GEOMETRY',
      severity: 'warn',
      message: `All ${parts.length} part(s) use material.tag = "unlit", disabling physical shading.`,
      fix: 'Remove tag: "unlit" on hero/architecture surfaces so scene lighting shades them cleanly.',
    };
  }
  return null;
}

/**
 * Inspect `CrucibleRenderer` parts and render options for plain/unlit setup, coplanar overlaps, and floating parts.
 * Returns `{ ok, hints }`.
 */
export function analyzeDevSceneHints(parts, { shading = 'full', resolveCoplanar = false, ground = true, groundY } = {}) {
  const hints = [];
  const unlitHint = detectUnlitOrFlatScene(parts, { shading });
  if (unlitHint) hints.push(unlitHint);

  const boundedCount = Math.min(parts.length, MAX_PAIRWISE_PARTS);
  const bounds = parts.slice(0, boundedCount).map(part => worldBoundsOfPart(part));

  if (!resolveCoplanar) {
    const coplanarTargets = [];
    for (let firstIndex = 0; firstIndex < boundedCount; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < boundedCount; secondIndex++) {
        if (hasCoplanarFacePair(bounds[firstIndex], bounds[secondIndex])) {
          coplanarTargets.push(`${partName(parts[firstIndex], firstIndex)} / ${partName(parts[secondIndex], secondIndex)}`);
          if (coplanarTargets.length >= 4) break;
        }
      }
      if (coplanarTargets.length >= 4) break;
    }
    if (coplanarTargets.length > 0) {
      hints.push({
        code: 'COPLANAR_OVERLAP',
        severity: 'warn',
        target: coplanarTargets.join(', '),
        message: `Coplanar or flush overlapping faces detected (${coplanarTargets.join(', ')}) with resolveCoplanar disabled.`,
        fix: 'Inset/offset overlapping faces by >= 2 mm, or pass resolveCoplanar from @codepawlhq/crucible/addons/coplanar-overlap.',
      });
    }
  }

  const inferredGroundY = typeof groundY === 'number'
    ? groundY
    : typeof ground === 'object' && ground?.geometry
      ? worldBoundsOfPart(ground).max[1]
      : bounds.reduce((lowest, item) => Math.min(lowest, item.min[1]), Infinity);

  if (Number.isFinite(inferredGroundY)) {
    const floatingTargets = [];
    for (let index = 0; index < boundedCount; index++) {
      const part = parts[index];
      if (part.ground || part.floating || part.material?.tag === 'sky' || part.material?.tag === 'cloud') continue;
      const item = bounds[index];
      if (item.min[1] - inferredGroundY <= FLOATING_CLEARANCE) continue;
      const supported = bounds.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        return hasXzFootprintOverlap(item, other) && item.min[1] >= other.min[1] - 0.02 && item.min[1] <= other.max[1] + FLOATING_CLEARANCE;
      });
      if (!supported) {
        floatingTargets.push(`${partName(part, index)} (+${(item.min[1] - inferredGroundY).toFixed(2)} m)`);
        if (floatingTargets.length >= 4) break;
      }
    }
    if (floatingTargets.length > 0) {
      hints.push({
        code: 'FLOATING_PARTS',
        severity: 'warn',
        target: floatingTargets.join(', '),
        message: `Floating part(s) with no supporting surface underneath: ${floatingTargets.join(', ')}.`,
        fix: 'Lower floating parts onto their support surface, or use scene relations / @codepawlhq/crucible/addons/scene-audit.',
      });
    }
  }

  return { ok: hints.length === 0, hints };
}

/** Format dev-mode scene hints into one concise terminal warning string. */
export function formatDevSceneHints(report) {
  if (!report || report.hints.length === 0) return '';
  const summary = report.hints.map(hint => `[${hint.code}] ${hint.message} Fix: ${hint.fix}`).join('\n');
  return `Crucible devHints found ${report.hints.length} scene issue(s):\n${summary}`;
}

/**
 * Inspect a `CrucibleRenderer` (matching `installCoplanarDiagnostics` from `./addons/coplanar-overlap`) and emit dev health hints.
 * Keeps zero bytes out of `entry:core`.
 */
export function installDevSceneHints(renderer, { onReport, logger = console.warn, groundY } = {}) {
  const report = analyzeDevSceneHints(renderer.sceneParts ?? [], {
    shading: renderer.shading ?? 'full',
    resolveCoplanar: Boolean(renderer.coplanarDiagnostics),
    ground: renderer.groundPart ?? true,
    groundY,
  });
  renderer.devHealthReport = report;
  if (typeof onReport === 'function') {
    onReport(report);
  } else if (report.hints.length > 0 && typeof logger === 'function') {
    logger(formatDevSceneHints(report));
  }
  return report;
}
