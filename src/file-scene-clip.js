import { loopedClipTime } from './hero-lab/loop/clip-time.js';

// Key times are stored as float32, so a clip's length can be a rounding step shorter than the frame time of its last key
// (frame / fps in doubles). That frame must pose the last key, not wrap to the first (#3232). The slack is far below one frame.
const CLIP_END_SLACK_SECONDS = 1e-4;

export function fileSceneClipTime(seconds, clipDuration) {
  if (clipDuration > 0 && seconds >= clipDuration && seconds <= clipDuration + CLIP_END_SLACK_SECONDS) return clipDuration;
  return loopedClipTime(seconds, clipDuration);
}

// Plays the first animation clip of a scene file's GLB, the way the showcase page does, so a headless frame shows the pose the
// page shows instead of the bind pose. The clip loops: the time inside it is the frame time modulo the clip length.
//
// The renderer holds the parts of the scene as it was built: water reflection and dense levels of detail swap some parts for
// copies, one per original part and in the same order. A copy shares the original's matrix and skin arrays, so posing the asset
// moves it too, but `renderer.updateParts` only knows the copies. `sceneParts` is the list the asset's parts were joined into
// (its order is the one `rendererParts` follows), `rendererParts` is the list the renderer was built from and `posedParts` are
// the parts the asset itself poses (its own parts, before the staged files were joined in).
export function createFileSceneClipPlayer({ asset, posedParts, sceneParts, rendererParts }) {
  const clip = asset.animations?.[0];
  if (!clip) return null;
  if (sceneParts.length !== rendererParts.length) {
    throw new Error(`The renderer parts (${rendererParts.length}) must match the scene parts (${sceneParts.length}) one for one.`);
  }
  const posed = new Set(posedParts);
  const partsToUpdate = rendererParts.filter((part, index) => posed.has(sceneParts[index]));
  return {
    clip,
    // Poses the asset's parts without a renderer: the native path tracer packs the parts themselves (skinned vertices included),
    // so it needs the pose and no updateParts call.
    applyAt(seconds) {
      asset.applyAnimation(fileSceneClipTime(seconds, clip.duration), 0);
    },
    poseAt(renderer, seconds) {
      this.applyAt(seconds);
      renderer.updateParts(partsToUpdate, { shadows: true });
    },
  };
}

// The frame function of a scene-file page: it poses the clip (when the GLB has one) and then renders at the camera's pose for the
// time. `camera` is a camera sampler or null; without one the scene file's own eye and target are used. The returned function
// carries its clip player as `clipPlayer` (null without a clip), so the native path tracer can pose the same clip.
export function createFileSceneRenderAt({ asset, posedParts, sceneParts, rendererParts, renderer, camera, description, frame, motionBlur = null }) {
  const clipPlayer = createFileSceneClipPlayer({ asset, posedParts, sceneParts, rendererParts });
  const renderAt = seconds => {
    clipPlayer?.poseAt(renderer, seconds);
    const pose = camera ? camera.sample(seconds) : { eye: description.eye, target: description.target };
    if (!motionBlur) {
      renderer.render({ ...frame, ...pose });
      return;
    }
    // Motion blur (#3233): the blur module poses the shutter's start and end itself, then the frame is posed again at its own time.
    motionBlur.drawWithMotionBlur({
      renderer, rendererParts, frame, seconds, camera, pose,
      poseClip: clipPlayer ? time => clipPlayer.poseAt(renderer, time) : null,
      draw: drawn => renderer.render(drawn),
    });
  };
  renderAt.clipPlayer = clipPlayer;
  return renderAt;
}
