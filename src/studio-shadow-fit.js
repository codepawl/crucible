import { mat4 } from 'gl-matrix';
import { everyCasterOutsideShadowView } from './frame-diagnostics.js';
import { sceneBoundsOfParts } from './near-plane-fit.js';
import { fitWorldShadowView, resolveShadowLight, writeShadowLightMatrix } from './shadow-light.js';

// A skinned, morphed or crowd part has no fixed box, so it is boxed where it rests: the view only has to reach roughly where the scene ends.
function partAtRest(part) {
  return { ...part, skin: null, morph: null, crowd: null };
}

function boxOfParts(parts) {
  return sceneBoundsOfParts(parts.map(partAtRest));
}

/** True when all eight corners of `bounds` ({ minimum, maximum }) lie inside the box a light matrix (from writeShadowLightMatrix) draws. */
export function boxInsideClipVolume(bounds, lightMatrix) {
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.maximum[0] : bounds.minimum[0];
    const y = corner & 2 ? bounds.maximum[1] : bounds.minimum[1];
    const z = corner & 4 ? bounds.maximum[2] : bounds.minimum[2];
    for (let axis = 0; axis < 3; axis++) {
      const clip = lightMatrix[axis] * x + lightMatrix[axis + 4] * y + lightMatrix[axis + 8] * z + lightMatrix[axis + 12];
      if (clip < -1 || clip > 1) return false;
    }
  }
  return true;
}

/**
 * The sun view for a scene that wrote no shadow bounds and is bigger than the default 7 m studio view (issue #3392): a view fitted to
 * the scene's box, so a caster or receiver past the default view is not left out. A receiver outside the map reads as lit, which
 * let a hard-edged patch of sun onto the interior wall of a 13 m classroom (luma 204 against 158 path traced).
 *
 * Returns null, which keeps the default view, when the scene fits inside it (so small scenes keep their shadows pixel for pixel),
 * when every caster lies outside it (the shadow-view-misses-casters warning already says to pass shadowBounds), and when the
 * scene is as large as the fixed world view. `casterParts` and `receiverParts` are the parts of the shadow-casting and of all
 * non-floor batches.
 */
export function fitStudioShadowView(casterParts, receiverParts, lightDirection) {
  if (casterParts.length === 0) return null;
  const defaultMatrix = writeShadowLightMatrix(mat4.create(), resolveShadowLight(false, lightDirection));
  const casterBoxes = casterParts.map(part => boxOfParts([part]));
  if (casterBoxes.includes(null) || everyCasterOutsideShadowView(casterBoxes, defaultMatrix)) return null;
  const sceneBox = boxOfParts(receiverParts);
  if (!sceneBox || boxInsideClipVolume(sceneBox, defaultMatrix)) return null;
  return fitWorldShadowView(sceneBox);
}
