/**
 * The scene file effects that read the renderer's depth buffer. Each entry says which `frame.effects` setting turns the
 * effect on, so a scene file that asks for one gets a renderer with depth even when `renderer.depth` is not written.
 * Without depth, ambient occlusion is skipped without an error, and the others throw when the frame draws (#3388).
 */
const DEFAULT_SUN_RAYS_INTENSITY = 0.25;

const EFFECTS_NEEDING_DEPTH = [
  { name: 'ambientOcclusion', isRequested: effects => Number(effects.ambientOcclusion) > 0 },
  { name: 'depthOfField', isRequested: effects => Number(effects.depthOfField?.blur) > 0 },
  { name: 'motionBlur', isRequested: effects => Number(effects.motionBlur?.shutter) > 0 },
  { name: 'sunRays', isRequested: effects => Number(effects.sunRays?.intensity ?? (effects.sunRays ? DEFAULT_SUN_RAYS_INTENSITY : 0)) > 0 },
];

/** The names of the requested effects in `frame.effects` that need the depth buffer. */
export function effectsNeedingDepth(frameEffects) {
  const effects = frameEffects ?? {};
  return EFFECTS_NEEDING_DEPTH.filter(entry => entry.isRequested(effects)).map(entry => entry.name);
}

/**
 * The renderer options of a scene file with depth on when a requested effect reads it. The file asked for the effect, so
 * that wins over a `renderer.depth: false` left in the file, as it does for motion blur.
 */
export function withDepthForRequestedEffects(rendererOptions, frameEffects) {
  return effectsNeedingDepth(frameEffects).length ? { ...rendererOptions, depth: true } : rendererOptions;
}
