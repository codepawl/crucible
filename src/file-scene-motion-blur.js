import { installCameraEffects } from './camera-effects.js';
import { installRenderPasses } from './render-passes.js';
import { installObjectMotionBlur, packObjectMotion, sampleWorldMatrices } from './object-motion-blur.js';

// Motion blur for a scene-file page (#3233). The scene file asks for it in "frame.effects.motionBlur", the same fields the
// recipe look uses: `shutter` (seconds of motion to smear, 0 to 0.5) and `objects` (0 to 1, how much of each moving part's own
// motion to smear). Both come from the frame time alone, so the same frame always gives the same pixels. This module loads
// only for a scene that asks, so a scene without blur pays nothing.

/** The motion blur fields a scene file's frame asks for, as numbers (0 when absent). */
export function requestedMotionBlur(frame) {
  const motionBlur = frame?.effects?.motionBlur ?? {};
  return { shutter: Number(motionBlur.shutter ?? 0), objects: Number(motionBlur.objects ?? 0) };
}

/** Installs the stages the requested blur needs on the renderer. Call before the first frame. */
export function installFileSceneMotionBlur(renderer, { objects }) {
  installCameraEffects(renderer);
  if (objects > 0) {
    installRenderPasses(renderer);
    installObjectMotionBlur(renderer);
  }
}

/**
 * Draws one frame at `seconds` with the blur of a shutter that opened `shutter` seconds earlier. `poseClip(time)` poses the
 * scene's moving parts without drawing (null when the scene has no clip), `camera` is the camera sampler or null, `pose` is
 * the camera pose of this frame and `draw(frame)` renders one frame.
 */
export function drawWithMotionBlur({ renderer, rendererParts, frame, seconds, camera, poseClip, pose, draw }) {
  const { shutter, objects } = requestedMotionBlur(frame);
  const start = Math.max(0, seconds - shutter);
  const previousCamera = camera ? camera.sample(start) : undefined;
  const drawn = { ...frame, ...pose, previousCamera };
  if (objects > 0 && poseClip && shutter > 0) {
    poseClip(start);
    const previous = sampleWorldMatrices(rendererParts);
    poseClip(seconds);
    const current = sampleWorldMatrices(rendererParts);
    draw({ ...drawn, pass: 'objectId', previousCamera: undefined });
    drawn.objectMotion = packObjectMotion(renderer, current, previous);
  }
  draw(drawn);
}
