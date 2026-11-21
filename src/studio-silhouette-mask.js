// The exact screen outline of a dense mesh. The triangles are filled into a small mask the size of the object on screen,
// and the edge of that mask is read back as line segments, so the outline follows the shape at any triangle count and
// costs the pixels the object covers, not a path with one entry per triangle.

// Past this many mask pixels the mask is drawn smaller (and its edges scaled back up), so a very large object on a 4K
// screen stays interactive.
const MAXIMUM_MASK_PIXELS = 1_500_000;

// Marks the pixels along one line, so a triangle thinner than a pixel (a rope, a blade of grass) still shows as a line.
function markLine(mask, maskWidth, maskHeight, fromX, fromY, toX, toY) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY))));
  for (let step = 0; step <= steps; step += 1) {
    const column = Math.floor(fromX + ((toX - fromX) * step) / steps);
    const row = Math.floor(fromY + ((toY - fromY) * step) / steps);
    if (column >= 0 && column < maskWidth && row >= 0 && row < maskHeight) {
      mask[row * maskWidth + column] = 1;
    }
  }
}

function fillTriangle(mask, maskWidth, maskHeight, ax, ay, bx, by, cx, cy) {
  const twiceArea = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  const longestSide = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
  if (twiceArea < longestSide) {
    // Under a pixel thick: sampling pixel centres would drop pieces of it and leave dashes, so its three sides are drawn.
    markLine(mask, maskWidth, maskHeight, ax, ay, bx, by);
    markLine(mask, maskWidth, maskHeight, bx, by, cx, cy);
    markLine(mask, maskWidth, maskHeight, cx, cy, ax, ay);
    return;
  }
  const top = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
  const bottom = Math.min(maskHeight - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
  for (let row = top; row <= bottom; row += 1) {
    const sampleY = row + 0.5;
    let left = Infinity;
    let right = -Infinity;
    for (let edge = 0; edge < 3; edge += 1) {
      const fromX = edge === 0 ? ax : edge === 1 ? bx : cx;
      const fromY = edge === 0 ? ay : edge === 1 ? by : cy;
      const toX = edge === 0 ? bx : edge === 1 ? cx : ax;
      const toY = edge === 0 ? by : edge === 1 ? cy : ay;
      if ((fromY <= sampleY) === (toY <= sampleY)) {
        continue;
      }
      const crossing = fromX + ((sampleY - fromY) * (toX - fromX)) / (toY - fromY);
      left = Math.min(left, crossing);
      right = Math.max(right, crossing);
    }
    const first = Math.max(0, Math.ceil(left - 0.5));
    const last = Math.min(maskWidth - 1, Math.floor(right - 0.5));
    if (first <= last) {
      mask.fill(1, row * maskWidth + first, row * maskWidth + last + 1);
    }
  }
}

// Boundary runs of the mask: a horizontal run where a row differs from the row above it, a vertical run where a column
// differs from the one to its left. Each run is x1, y1, x2, y2 in mask pixels.
function maskBoundarySegments(mask, maskWidth, maskHeight) {
  const segments = [];
  for (let line = 0; line <= maskHeight; line += 1) {
    let runStart = -1;
    for (let column = 0; column <= maskWidth; column += 1) {
      const above = line > 0 && column < maskWidth ? mask[(line - 1) * maskWidth + column] : 0;
      const below = line < maskHeight && column < maskWidth ? mask[line * maskWidth + column] : 0;
      const differs = above !== below;
      if (differs && runStart < 0) {
        runStart = column;
      } else if (!differs && runStart >= 0) {
        segments.push(runStart, line, column, line);
        runStart = -1;
      }
    }
  }
  for (let column = 0; column <= maskWidth; column += 1) {
    let runStart = -1;
    for (let row = 0; row <= maskHeight; row += 1) {
      const before = column > 0 && row < maskHeight ? mask[row * maskWidth + column - 1] : 0;
      const after = column < maskWidth && row < maskHeight ? mask[row * maskWidth + column] : 0;
      const differs = before !== after;
      if (differs && runStart < 0) {
        runStart = row;
      } else if (!differs && runStart >= 0) {
        segments.push(column, runStart, column, row);
        runStart = -1;
      }
    }
  }
  return segments;
}

/**
 * The outline of the union of the given screen-space triangles, in the screen's own pixels.
 * `meshes` is a list of { screen: Float32Array of x, y pairs per vertex, indices: triangle vertex indices }.
 * Returns a flat Int32Array-like list of x1, y1, x2, y2 segments, or null when nothing lands on the screen.
 */
export function silhouetteContourSegments(meshes, viewportWidth, viewportHeight) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { screen } of meshes) {
    for (let offset = 0; offset < screen.length; offset += 2) {
      left = Math.min(left, screen[offset]);
      right = Math.max(right, screen[offset]);
      top = Math.min(top, screen[offset + 1]);
      bottom = Math.max(bottom, screen[offset + 1]);
    }
  }
  left = Math.max(Math.floor(left), -1);
  top = Math.max(Math.floor(top), -1);
  right = Math.min(Math.ceil(right), viewportWidth + 1);
  bottom = Math.min(Math.ceil(bottom), viewportHeight + 1);
  if (!(right > left) || !(bottom > top)) {
    return null;
  }
  const scale = Math.min(1, Math.sqrt(MAXIMUM_MASK_PIXELS / ((right - left) * (bottom - top))));
  const maskWidth = Math.max(1, Math.ceil((right - left) * scale));
  const maskHeight = Math.max(1, Math.ceil((bottom - top) * scale));
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (const { screen, indices } of meshes) {
    for (let offset = 0; offset < indices.length; offset += 3) {
      const first = indices[offset] * 2;
      const second = indices[offset + 1] * 2;
      const third = indices[offset + 2] * 2;
      fillTriangle(
        mask,
        maskWidth,
        maskHeight,
        (screen[first] - left) * scale,
        (screen[first + 1] - top) * scale,
        (screen[second] - left) * scale,
        (screen[second + 1] - top) * scale,
        (screen[third] - left) * scale,
        (screen[third + 1] - top) * scale,
      );
    }
  }
  const segments = maskBoundarySegments(mask, maskWidth, maskHeight);
  if (segments.length === 0) {
    return null;
  }
  const contour = new Float32Array(segments.length);
  for (let index = 0; index < segments.length; index += 2) {
    contour[index] = segments[index] / scale + left;
    contour[index + 1] = segments[index + 1] / scale + top;
  }
  return contour;
}

/**
 * The screen rectangle around the given meshes, as the four sides in the same x1, y1, x2, y2 form as the contour. For a
 * model with too many triangles to fill every frame: it never cuts across the model and costs one pass over its vertices.
 */
export function silhouetteRectangleSegments(meshes) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { screen } of meshes) {
    for (let offset = 0; offset < screen.length; offset += 2) {
      left = Math.min(left, screen[offset]);
      right = Math.max(right, screen[offset]);
      top = Math.min(top, screen[offset + 1]);
      bottom = Math.max(bottom, screen[offset + 1]);
    }
  }
  if (!(right > left) || !(bottom > top)) {
    return null;
  }
  return new Float32Array([left, top, right, top, right, top, right, bottom, right, bottom, left, bottom, left, bottom, left, top]);
}
