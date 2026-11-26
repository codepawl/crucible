// Maps the look of a native film frame to the `post` option of a Cook session (issue 1123), so the display bytes come from the GPU
// instead of the per-pixel JavaScript in toneMapToRgba8. The JavaScript helpers (src/view-transform.js, toneMapToRgba8) stay the
// reference: Cook's post stage matches them within POST_TOLERANCE_BYTES per channel, and anything it cannot say keeps the JavaScript path.
import { isLocalToneMappingActive, resolveLocalToneMapping } from '../src/local-tone-mapping.js';

/** Largest per-channel difference, in 8-bit steps, between Cook's display bytes and toneMapToRgba8 (Cook documents 2/255). */
export const POST_TOLERANCE_BYTES = 2;

const COOK_VIEW_TRANSFORMS = new Set(['aces', 'agx', 'neutral']);

/**
 * @param {{ viewTransform?: string, look?: object|null, exposure?: number, localToneMapping?: object|null }} look The look the frame is drawn with: the display
 *   transform, an optional 3D look table, exposure multiplier, and optional local tone mapping. Other frame effects (grain, bloom, vignette, saturation,
 *   contrast, temperature) are not part of a native film frame today, so they are not mapped.
 * @returns {{ post: object } | { post: undefined, reason: string }} The `post` object for `session.render`, or why the JavaScript
 *   path must make the frame.
 */
export function mapLookToCookPost({ viewTransform = 'aces', look = null, exposure = 1, localToneMapping = null } = {}) {
  if (!COOK_VIEW_TRANSFORMS.has(viewTransform)) {
    return { post: undefined, reason: `Cook's post stage has no "${viewTransform}" view transform; pass one of ${[...COOK_VIEW_TRANSFORMS].join(', ')} to use it.` };
  }
  if (look) {
    return { post: undefined, reason: 'Cook\'s post stage has no 3D look table, so the JavaScript path applies the look.' };
  }
  const resolvedLocalToneMapping = localToneMapping == null ? null : resolveLocalToneMapping(localToneMapping);
  if (isLocalToneMappingActive(resolvedLocalToneMapping)) {
    return { post: undefined, reason: 'Cook\'s post stage has no localToneMapping, so the JavaScript path applies it.' };
  }
  if (typeof exposure !== 'number' || !Number.isFinite(exposure) || exposure < 0.01 || exposure > 16) {
    return { post: undefined, reason: `exposure ${exposure} is outside Cook's post range 0.01 to 16, so the JavaScript path made the frame.` };
  }
  return { post: { viewTransform, exposure } };
}
