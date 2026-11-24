// Camera maths for the voxel stills: the renderer's world mode uses a 45 degree vertical field of view, so a vertex
// lands on screen where this projects it. Used to measure the margins of a still and to fit a view around a mesh.

const VERTICAL_FIELD_OF_VIEW = Math.PI / 4;

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

export function cameraBasis(eye, target) {
  const forward = normalize(subtract(target, eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { forward, right, up };
}

/** Pixel position of a world point, or null when it is behind the camera. */
export function projectPoint(point, view, width, height) {
  const { forward, right, up } = cameraBasis(view.eye, view.target);
  const offset = subtract(point, view.eye);
  const depth = dot(offset, forward);
  if (depth <= 0) return null;
  const scale = Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = dot(offset, right) / (depth * scale * (width / height));
  const ndcY = dot(offset, up) / (depth * scale);
  return [(ndcX + 1) / 2 * width, (1 - ndcY) / 2 * height];
}

/** Pixel bounding box of every vertex of the parts, and the space left on each side. */
export function screenMargins(parts, view, width, height) {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const part of parts) {
    const { positions } = part.geometry;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const pixel = projectPoint([positions[offset], positions[offset + 1], positions[offset + 2]], view, width, height);
      if (!pixel) return null;
      box.left = Math.min(box.left, pixel[0]);
      box.right = Math.max(box.right, pixel[0]);
      box.top = Math.min(box.top, pixel[1]);
      box.bottom = Math.max(box.bottom, pixel[1]);
    }
  }
  return { ...box, marginLeft: box.left, marginRight: width - box.right, marginTop: box.top, marginBottom: height - box.bottom };
}

/**
 * A view looking along `direction` (from the target towards the eye) that keeps the parts inside the frame with
 * `margin` pixels on every side, centred, as close as that allows.
 */
export function fitView(parts, direction, centre, width, height, margin) {
  const unit = normalize(direction);
  let target = [...centre];
  let distance = 40;
  for (let round = 0; round < 60; round++) {
    const view = { eye: target.map((value, axis) => value + unit[axis] * distance), target };
    const box = screenMargins(parts, view, width, height);
    if (!box) {
      distance *= 1.5;
      continue;
    }
    const smallest = Math.min(box.marginLeft, box.marginRight, box.marginTop, box.marginBottom);
    const centreOffsetX = (box.marginLeft - box.marginRight) / 2;
    const centreOffsetY = (box.marginTop - box.marginBottom) / 2;
    if (smallest >= margin && smallest < margin + 12 && Math.abs(centreOffsetX) < 6 && Math.abs(centreOffsetY) < 6) return view;
    const { right, up } = cameraBasis(view.eye, view.target);
    const metresPerPixel = 2 * distance * Math.tan(VERTICAL_FIELD_OF_VIEW / 2) / height;
    target = target.map((value, axis) => value + (right[axis] * centreOffsetX - up[axis] * centreOffsetY) * metresPerPixel * 0.8);
    distance *= smallest < margin ? 1.04 : 0.99;
  }
  throw new Error('fitView did not settle; check the direction and the margin.');
}

/**
 * The lowest elevation, from `lowestElevation` upwards in 2 degree steps, at which a view around `yawDegrees` that fits
 * the parts (see fitView) fills at least `minimumHeightShare` of the frame height. A steeper view looks more like a map
 * and uses more of a tall frame. Returns the view and its height share.
 */
export function fitSteepView(parts, yawDegrees, centre, width, height, margin, { minimumHeightShare, lowestElevation = 40 }) {
  const yaw = yawDegrees * Math.PI / 180;
  for (let elevationDegrees = lowestElevation; elevationDegrees <= 88; elevationDegrees += 2) {
    const elevation = elevationDegrees * Math.PI / 180;
    const direction = [Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation)];
    const view = fitView(parts, direction, centre, width, height, margin);
    const { top, bottom } = screenMargins(parts, view, width, height);
    const heightShare = (bottom - top) / height;
    if (heightShare >= minimumHeightShare) return { view, heightShare, elevationDegrees };
  }
  throw new Error(`No elevation up to 88 degrees gives a height share of ${minimumHeightShare}; use a smaller margin or a different yaw.`);
}
