// Each part keeps its assembled matrix; its explode offset and detailOffset are added by the shader, and an exporter can write the same pose with assemblyOffset.
export function assemblyOffset(part, amount = 0) {
  if (!Number.isFinite(amount)) throw new TypeError('Assembly amount must be finite');
  const progress = Math.max(0, Math.min(1, amount));
  if (progress === 0) return [0, 0, 0];
  const detailProgress = Math.max(0, Math.min(1, (progress - 0.3) / 0.7));
  const detailAmount = detailProgress * detailProgress * (3 - 2 * detailProgress);
  const offset = part.assembly?.offset ?? [0, 0, 0];
  const detailOffset = part.assembly?.detailOffset ?? [0, 0, 0];
  return offset.map((value, axis) => value * progress + detailOffset[axis] * detailAmount);
}

/**
 * The axis-aligned world bounds of the parts at an assembly amount, as { minimum, maximum }: each part's matrix, then its
 * assemblyOffset. Used to frame the camera on the pose that is on screen.
 */
export function assemblyBounds(parts, amount = 0) {
  if (!Array.isArray(parts) || parts.length === 0) throw new TypeError('assemblyBounds expects a non-empty array of parts with geometry.positions and a matrix.');
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const positions = part.geometry?.positions;
    if (!positions || !part.matrix) throw new TypeError(`Part "${part.name}" needs geometry.positions and a matrix to be measured.`);
    const matrix = part.matrix;
    const offset = assemblyOffset(part, amount);
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const y = positions[index + 1];
      const z = positions[index + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12] + offset[axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { minimum, maximum };
}

/**
 * The camera distance at which a box of `size` ([width, height], in view-plane units) fills `fill` of the shorter side of the
 * visible area, for a perspective camera with the given vertical field of view in radians and aspect ratio (width / height).
 */
export function distanceToFill(size, { verticalFov, aspect, fill = 0.8 }) {
  if (![verticalFov, aspect, fill, ...size].every(Number.isFinite) || verticalFov <= 0 || verticalFov >= Math.PI || aspect <= 0 || fill <= 0 || fill > 1) {
    throw new RangeError('distanceToFill needs a finite size, a verticalFov between 0 and PI, a positive aspect and a fill between 0 and 1.');
  }
  const halfHeight = Math.tan(verticalFov / 2);
  const halfWidth = halfHeight * aspect;
  return Math.max(size[0] / 2 / halfWidth, size[1] / 2 / halfHeight) / fill;
}
