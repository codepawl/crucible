// What a recipe motion holds, read by the Studio controller when an edit may leave it empty.

/** True when a motion has no track and nothing else that animates, so it can be dropped from the recipe. */
export function motionIsEmpty(motion) {
  return !(
    motion.tracks?.length ||
    motion.ik?.length ||
    motion.layers?.length ||
    motion.drivers?.length ||
    motion.constraints?.length ||
    motion.springs ||
    motion.drive
  );
}
