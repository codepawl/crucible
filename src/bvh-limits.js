// The bounds of a BVH import, in a file of their own so the scene capabilities can name them without loading the parser.

export const BVH_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxJoints: 256,
  maxFrames: 100_000,
  maxChannelValues: 8_000_000,
  maxFrameTime: 1,
  minFrameTime: 0.0001,
  minScale: 0.0001,
  maxScale: 1000,
});
