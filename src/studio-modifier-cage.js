// Live modifier-stack preview and surface preview helpers for Studio edit mode.
// When a mesh carries modifiers (subdivision, mirror, array, bevel, solidify), edit mode operates on its pre-modifier cage
// while re-evaluating the modifier stack live for the viewport surface.
import { defaultSmoothAngle, waterFoamGeometry } from './agent-mesh.js';
import { evaluateMeshStack } from './mesh-recipe.js';
import { extractRender } from './mesh-render.js';

const DEFAULT_PREVIEW_MAX_VERTICES = 250_000;

/**
 * Smooth normals for a drag preview: the area weighted sum of the triangles that share each render vertex, so a cube whose
 * corners are split per face stays flat and a shared vertex is averaged. Writes into `normals` (3 per vertex) and returns it;
 * the release builds the real ones.
 */
export function previewNormalsOf(indices, positions, normals) {
  normals.fill(0);
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const first = indices[corner] * 3;
    const second = indices[corner + 1] * 3;
    const third = indices[corner + 2] * 3;
    const edgeOneX = positions[second] - positions[first];
    const edgeOneY = positions[second + 1] - positions[first + 1];
    const edgeOneZ = positions[second + 2] - positions[first + 2];
    const edgeTwoX = positions[third] - positions[first];
    const edgeTwoY = positions[third + 1] - positions[first + 1];
    const edgeTwoZ = positions[third + 2] - positions[first + 2];
    const crossX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
    const crossY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
    const crossZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
    for (const vertexOffset of [first, second, third]) {
      normals[vertexOffset] += crossX;
      normals[vertexOffset + 1] += crossY;
      normals[vertexOffset + 2] += crossZ;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (length < 1e-12) {
      normals[offset + 1] = 1;
    } else {
      normals[offset] /= length;
      normals[offset + 1] /= length;
      normals[offset + 2] /= length;
    }
  }
  return normals;
}

/** True when `stack` has at least one enabled modifier node that runs after the mesh edit log. */
export function hasActiveModifiers(stack) {
  if (stack === undefined || stack === null) return false;
  if (!Array.isArray(stack)) {
    throw new TypeError(`hasActiveModifiers expected an array stack, got ${typeof stack}.`);
  }
  return stack.some(node => node?.enabled !== false);
}

/**
 * Preview capability and stack metadata for `geometrySpec` and `part`. A mesh with active modifiers previews by re-evaluating
 * its stack into a temporary render geometry rather than mutating the evaluated part's vertex buffer in place.
 */
export function modifierPreviewState(geometrySpec, part, renderVertexSource) {
  if (!geometrySpec || typeof geometrySpec !== 'object') {
    throw new TypeError('modifierPreviewState requires a geometrySpec object.');
  }
  if (!part || !part.geometry) {
    throw new TypeError('modifierPreviewState requires a rendered part with geometry.');
  }
  const stack = geometrySpec.stack ?? [];
  const stackedPreview = hasActiveModifiers(stack);
  const rigidPart = !part.skin && !part.geometry.morphTargets && !part.lods;
  const previewable = stackedPreview
    ? rigidPart
    : Boolean(renderVertexSource) && renderVertexSource.length * 3 === part.geometry.positions.length;
  return {
    stack,
    smoothAngle: geometrySpec.smoothAngle ?? defaultSmoothAngle(geometrySpec.edits ?? [], stack),
    stackedPreview,
    previewable,
    previewGeometry: null,
    previewPart: null,
  };
}

/**
 * Re-evaluates `state.stack` on the edited cage positions (`state.positions`) and returns render geometry so a drag or held
 * face tool previews the live modifier output while the overlay draws the base cage.
 */
export function evaluateModifierPreview(state, { maxVertices = DEFAULT_PREVIEW_MAX_VERTICES } = {}) {
  if (!state?.mesh || !(state.positions instanceof Float32Array)) {
    throw new TypeError('evaluateModifierPreview requires edit state with a mesh and Float32Array positions.');
  }
  const stack = state.stack ?? [];
  const cageMesh = { ...state.mesh, positions: state.positions };
  const evaluated = evaluateMeshStack(cageMesh, stack, { maxVertices, maxFaces: maxVertices });
  const sharpAngle = (state.smoothAngle ?? defaultSmoothAngle([], stack)) * Math.PI / 180;
  const { geometry } = extractRender(evaluated.mesh, { sharpAngle });
  if (geometry.positions.length / 3 > maxVertices) {
    throw new RangeError(`Preview exceeds ${maxVertices} render vertices.`);
  }
  return state.part?.material ? waterFoamGeometry(geometry, state.part.material) : geometry;
}

/** Returns the part replacement for `partsToDraw` when see-through or a live modifier preview is active, else null. */
export function previewPartForCage(part, ghostPart, previewGeometry) {
  if (!part) return null;
  if (!previewGeometry) return ghostPart ?? null;
  const basePart = ghostPart ?? part;
  return Object.freeze({ ...basePart, geometry: previewGeometry });
}
