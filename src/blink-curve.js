// The eyelid curve of a blink, shared by the film rig and motion.face so both close the lids the same way.

export const BLINK_HALF_DURATION = 0.13;

/** Eyelid closure of a blink `offset` seconds from its middle: 1 shut, 0 open. */
export function blinkClosure(offset, halfDuration = BLINK_HALF_DURATION) {
  const phase = Math.abs(offset) / halfDuration;
  return phase < 1 ? Math.cos(phase * Math.PI / 2) ** 2 : 0;
}
