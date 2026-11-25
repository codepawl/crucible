// Limits for curve and text geometry, kept apart from agent-scene-capabilities.js so the packed runtime does not load it.
// A text geometry is bounded by vertices per curve segment: the bundled font stays under
// 640 per character and a registered font is held to 128 outline points per glyph (2400).
export const CURVE_TEXT_LIMITS = Object.freeze({
  maxCurvePoints: 1024, maxProfilePoints: 256, maxTextCharacters: 256, maxTextLines: 16,
  verticesPerCharacterSegment: 640, verticesPerCustomCharacterSegment: 2400, maxPointsPerGlyph: 128,
});
