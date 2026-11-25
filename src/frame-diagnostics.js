import { resolveShadowLight } from './shadow-light.js';
import { resolveEffects } from './effects.js';
import { postStepSupport } from './shader-registry.js';

/**
 * Diagnostics for a frame that renders without error but not as asked. They use the shape of `agent-diagnostics.js`
 * (kind, severity, target, message, fix) and are read from `renderer.diagnostics`.
 */
const SHADOW_DISAGREEMENT_DEGREES = 10;
const NO_DIAGNOSTICS = Object.freeze([]);

function warning(kind, target, message, fix) {
  return { kind, severity: 'warning', target, message, fix };
}

function angleBetweenDegrees(first, second) {
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const lengths = Math.hypot(...first) * Math.hypot(...second);
  if (!(lengths > 1e-6)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * 180 / Math.PI;
}

function shadowDirectionProblem(world, lightDirection, shadowBounds) {
  const light = resolveShadowLight(world, lightDirection, shadowBounds);
  const towardShadowEye = light.eye.map((value, axis) => value - light.target[axis]);
  const degrees = angleBetweenDegrees(towardShadowEye, lightDirection);
  if (degrees < SHADOW_DISAGREEMENT_DEGREES) return null;
  return warning('shadow-light-direction-mismatch', 'shadowBounds.eye',
    `shadowBounds.eye is ${Math.round(degrees)} degrees off lightDirection; the eye sets the shadow direction.`,
    'Drop shadowBounds.eye, or point lightDirection from shadowBounds.target to it.');
}

const DRAWN_EFFECTS = resolveEffects({ motionBlur: { objects: 1 } });
const DRAWN_NAMES = Object.keys(DRAWN_EFFECTS).join(', ');

/** One warning per effect key, or group field, that renderer.render reads nothing from, so the frame never shows it. */
function unsupportedEffectProblems(requestedEffects, frameExposure) {
  const problems = [];
  const postStepsLoaded = postStepSupport.fields.length > 0;
  const notDrawn = (target, fix) => problems.push(warning('effect-not-drawn', target, `${target} is not drawn by renderer.render, so the frame ignores it.`, fix));
  for (const [key, value] of Object.entries(requestedEffects ?? {})) {
    // A scene recipe repeats effects.exposure as the frame's exposure and loads the post steps that draw the rest.
    if (key === 'exposure' && value === frameExposure) continue;
    if (postStepsLoaded && postStepSupport.fields.includes(key)) continue;
    const drawn = DRAWN_EFFECTS[key];
    if (drawn === undefined) {
      notDrawn(`effects.${key}`, key === 'exposure' ? 'Pass exposure on the frame: render({ exposure }).' : `Remove it, or render a scene recipe, which runs the post steps. Drawn here: ${DRAWN_NAMES}.`);
    } else if (value && typeof value === 'object' && typeof drawn === 'object') {
      for (const field of Object.keys(value).filter(name => !(name in drawn))) notDrawn(`effects.${key}.${field}`, `Use only ${Object.keys(drawn).join(', ')} in effects.${key}.`);
    }
  }
  return problems;
}

/**
 * True when every caster's bounding box lies wholly outside the box the sun's shadow map draws (`lightMatrix`, from
 * writeShadowLightMatrix), so none of them can shadow anything. `casterBounds` is a list of { minimum, maximum } boxes.
 */
export function everyCasterOutsideShadowView(casterBounds, lightMatrix) {
  if (casterBounds.length === 0) return false;
  return casterBounds.every(bounds => boxOutsideClipVolume(bounds, lightMatrix));
}

// A box is outside when all eight corners are past the same clip plane (conservative: a box that straddles a corner stays "inside").
function boxOutsideClipVolume(bounds, matrix) {
  const outsideCounts = new Array(6).fill(0);
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.maximum[0] : bounds.minimum[0];
    const y = corner & 2 ? bounds.maximum[1] : bounds.minimum[1];
    const z = corner & 4 ? bounds.maximum[2] : bounds.minimum[2];
    const clip = [0, 1, 2, 3].map(row => matrix[row] * x + matrix[row + 4] * y + matrix[row + 8] * z + matrix[row + 12]);
    for (let axis = 0; axis < 3; axis++) {
      if (clip[axis] < -clip[3]) outsideCounts[axis * 2]++;
      if (clip[axis] > clip[3]) outsideCounts[axis * 2 + 1]++;
    }
  }
  return outsideCounts.some(count => count === 8);
}

function shadowViewMissesCastersProblem(view) {
  return warning('shadow-view-misses-casters', 'shadowBounds',
    `Every shadow caster lies outside the default shadow view (${view.extent} m round [${view.target.map(value => +value.toFixed(2)).join(', ')}]), so the scene casts no shadows.`,
    'Pass renderer.shadowBounds: { target, extent } round the casters, such as the middle of the set and half its width.');
}

export function frameDiagnostics({ world, depth, effects, requestedEffects = null, requestedExposure, lightDirection, shadowBounds, shadowViewMissesCasters = null, coplanarProblems = null, skinProblems = null }) {
  const problems = unsupportedEffectProblems(requestedEffects, requestedExposure);
  if (shadowViewMissesCasters) problems.push(shadowViewMissesCastersProblem(shadowViewMissesCasters));
  if (effects.ambientOcclusion > 0 && !depth) {
    problems.push(warning('ambient-occlusion-without-depth', 'effects.ambientOcclusion',
      `ambientOcclusion is ${effects.ambientOcclusion} but the renderer has no depth, so the pass is skipped.`,
      'Build the renderer with depth: true, or set ambientOcclusion to 0.'));
  }
  if (shadowBounds?.eye && lightDirection) {
    const problem = shadowDirectionProblem(world, lightDirection, shadowBounds);
    if (problem) problems.push(problem);
  }
  if (coplanarProblems?.length) problems.push(...coplanarProblems);
  if (skinProblems?.length) problems.push(...skinProblems);
  return problems.length ? problems : NO_DIAGNOSTICS;
}
