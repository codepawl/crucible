import { mat4, vec3 } from 'gl-matrix';
import { rejectThreeObject } from './field-error.js';
export { attachOrbitControls, createOrbitController, eyeFromOrbit, orbitFromCamera } from './orbit-controller.js';

/** Lens fields a camera may carry on top of eye, target, up, fov, near and far; each is absent unless the scene sets it. */
export const CAMERA_LENS_FIELDS = Object.freeze(['projection', 'orthoScale', 'focalLength', 'sensorWidth', 'shift', 'fStop', 'focusDistance']);

/** Image-centre shift as fractions of the frame width and height, like Blender's lens shift; positive moves the frame right and up. */
export function validateCameraShift(shift) {
  if (!Array.isArray(shift) || shift.length !== 2 || !shift.every(component => Number.isFinite(component) && Math.abs(component) <= 1)) {
    throw new RangeError('Camera shift must be [x, y], each between -1 and 1 as a fraction of the frame.');
  }
}

export function applyProjection(matrix, frame, aspect, { world = false } = {}) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('Camera aspect must be positive and finite');
  const hasLens = frame.projection !== undefined || frame.fov !== undefined || frame.focalLength !== undefined;
  const hasClipping = frame.near !== undefined || frame.far !== undefined;
  if (!hasLens && !hasClipping) return matrix;
  const near = frame.near ?? 0.1;
  const far = frame.far ?? (world ? 600 : 100);
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) throw new RangeError('Camera clipping planes must satisfy 0 < near < far');
  if (!hasLens) {
    // Only the clipping planes are given: keep the renderer's own lens (its field of view and off-centre shift) and replace the planes.
    const fieldOfView = 2 * Math.atan(1 / matrix[5]);
    const shift = matrix[8];
    mat4.perspective(matrix, fieldOfView, aspect, near, far);
    matrix[8] = shift;
    return matrix;
  }
  if (frame.shift !== undefined) validateCameraShift(frame.shift);
  if (frame.projection === 'orthographic') {
    const height = frame.orthographicHeight ?? frame.orthoScale ?? 4;
    if (!Number.isFinite(height) || height <= 0) throw new RangeError('Orthographic height must be positive and finite');
    const halfHeight = height / 2;
    mat4.ortho(matrix, -halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, near, far);
    // An orthographic window moves sideways in clip space: x' = x + translation.
    if (frame.shift) {
      matrix[12] -= 2 * frame.shift[0];
      matrix[13] -= 2 * frame.shift[1];
    }
    return matrix;
  }
  if (frame.projection && frame.projection !== 'perspective') throw new RangeError(`Unsupported camera projection: ${frame.projection}`);
  mat4.perspective(matrix, cameraFieldOfView(frame, aspect) * Math.PI / 180, aspect, near, far);
  // The z column of x and y moves the image centre by -matrix / depth in clip space, so +2 per frame fraction.
  if (frame.shift) {
    matrix[8] += 2 * frame.shift[0];
    matrix[9] += 2 * frame.shift[1];
  }
  return matrix;
}

/** Vertical field of view in degrees: `fov`, or a focal length on a sensor `sensorWidth` wide (default 36, full frame) across the image. */
export function cameraFieldOfView(frame, aspect) {
  if (frame.focalLength !== undefined) {
    const { focalLength, sensorWidth = 36 } = frame;
    if (!Number.isFinite(focalLength) || focalLength <= 0 || !Number.isFinite(sensorWidth) || sensorWidth <= 0) throw new RangeError('Focal length and sensor width must be positive and finite');
    return 2 * Math.atan(sensorWidth / aspect / focalLength / 2) * 180 / Math.PI;
  }
  const fov = frame.fov ?? 45;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new RangeError('Camera field of view must be between 0 and 180 degrees');
  return fov;
}

export const MAX_APERTURE_BLADES = 64;

export function requirePositiveFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Camera ${name} must be a positive finite number, got ${JSON.stringify(value)}.`);
  }
}

/** Focal length in millimetres: `focalLength` as given, or the one that gives `fov` on a sensor `sensorWidth` wide across the image. */
export function cameraFocalLength(frame, aspect) {
  if (frame.focalLength !== undefined) {
    requirePositiveFinite(frame.focalLength, 'focalLength');
    return frame.focalLength;
  }
  const sensorWidth = frame.sensorWidth ?? 36;
  requirePositiveFinite(sensorWidth, 'sensorWidth');
  const fieldOfView = cameraFieldOfView(frame, aspect);
  return sensorWidth / aspect / (2 * Math.tan(fieldOfView * Math.PI / 360));
}

/**
 * The kernel's aperture rotation in radians for a Blender-style rotation in degrees (Blender's aperture_rotation reaches Cycles'
 * bladesrotation as radians, unchanged, in intern/cycles/blender/camera.cpp).
 * Cook's cam_sample_regular_polygon places the corners as Cycles' regular_polygon_sample does (at rotation + pi/n + 2 pi k / n,
 * codepawl/cook#13), so the kernel takes Cycles' rotation unchanged: degrees to radians, for any number of blades.
 */
function kernelApertureRotation(rotationDegrees) {
  return rotationDegrees * Math.PI / 180;
}

/**
 * The thin lens a camera with an `fStop` describes, for the native path tracer (Cycles' camera model): the aperture radius in
 * scene units (focalLength / (2 * fStop), millimetres to metres), the focus distance along the view axis (`focusDistance`, by
 * default the distance from eye to target), and the optional polygonal blades (`apertureBlades`, 0 or 3 to 64) turned by
 * `apertureRotation` degrees. Returns null for a camera without `fStop`: a pinhole.
 */
export function resolveThinLens(frame, { aspect, eye, target }) {
  if (frame.fStop === undefined) return null;
  requirePositiveFinite(frame.fStop, 'fStop');
  const focusDistance = frame.focusDistance ?? Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  requirePositiveFinite(focusDistance, 'focusDistance');
  const blades = frame.apertureBlades ?? 0;
  if (!Number.isInteger(blades) || blades < 0 || blades === 1 || blades === 2 || blades > MAX_APERTURE_BLADES) {
    throw new RangeError(`Camera apertureBlades must be 0 (a round aperture) or a whole number from 3 to ${MAX_APERTURE_BLADES}, got ${JSON.stringify(frame.apertureBlades)}.`);
  }
  const rotationDegrees = frame.apertureRotation ?? 0;
  if (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees)) {
    throw new RangeError(`Camera apertureRotation must be a finite number of degrees, got ${JSON.stringify(frame.apertureRotation)}.`);
  }
  return {
    apertureRadius: cameraFocalLength(frame, aspect) / 1000 / (2 * frame.fStop),
    focalDistance: focusDistance,
    apertureBlades: blades,
    apertureRotation: kernelApertureRotation(rotationDegrees),
  };
}

const viewDirections = { front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0], perspective: [0.58, 0.34, 0.74] };

export function cameraView(name = 'front', { target = [0, 1.5, 0], height = 3.8, distance = 8 } = {}) {
  const direction = viewDirections[name];
  if (!direction) throw new RangeError(`Unsupported camera view: ${name}`);
  if (!Number.isFinite(height) || height <= 0) throw new RangeError('Orthographic height must be positive and finite');
  if (target.length !== 3 || !target.every(Number.isFinite) || !Number.isFinite(distance) || distance <= 0) throw new RangeError('Camera target and positive distance must be finite');
  const unitDirection = vec3.normalize(vec3.create(), direction);
  const eye = Array.from(vec3.scaleAndAdd(vec3.create(), target, unitDirection, distance));
  return { eye, target: [...target], up: name === 'top' ? [0, 0, -1] : [0, 1, 0], projection: name === 'perspective' ? 'perspective' : 'orthographic', orthographicHeight: height, fov: 45 };
}

/** Throws unless the eye, target and up of `view` are finite, the eye differs from the target and up is not parallel to the view; `subject` starts each message. */
export function requireNonDegenerateView(view, subject = 'Fit') {
  const up = view?.up ?? [0, 1, 0];
  const isFiniteVector = vector => vector?.length === 3 && Array.from(vector).every(value => typeof value === 'number' && Number.isFinite(value));
  if (!isFiniteVector(view?.eye) || !isFiniteVector(view?.target) || !isFiniteVector(up)) {
    throw new RangeError(`${subject} camera eye, target and up must be three finite numbers each.`);
  }
  const forward = [0, 1, 2].map(axis => view.target[axis] - view.eye[axis]);
  const forwardLength = Math.hypot(...forward);
  const upLength = Math.hypot(...up);
  if (forwardLength === 0 || upLength === 0) {
    throw new RangeError(`${subject} eye and target must differ and up must be nonzero.`);
  }
  const alignment = forward.reduce((sum, component, axis) => sum + component * up[axis], 0) / (forwardLength * upLength);
  if (Math.abs(alignment) >= 1 - 1e-10) {
    throw new RangeError(`${subject} up must not be parallel to the view direction; pass another up, such as [0, 0, -1] for a top view.`);
  }
}

export function fitOrthographicHeight(bounds, view, aspect, padding = 1.15) {
  rejectThreeObject(view, 'Fit camera');
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(padding) || padding < 1) throw new RangeError('Fit aspect must be positive and padding at least one');
  if (bounds.minimum.length !== 3 || bounds.maximum.length !== 3 || !bounds.minimum.every(Number.isFinite) || !bounds.maximum.every((value, axis) => Number.isFinite(value) && value >= bounds.minimum[axis])) throw new RangeError('Fit bounds must be finite and ordered');
  requireNonDegenerateView(view);
  const basis = mat4.lookAt(mat4.create(), view.eye, view.target, view.up ?? [0, 1, 0]);
  const minimum = [Infinity, Infinity];
  const maximum = [-Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.maximum[axis] : bounds.minimum[axis]);
    const projected = vec3.transformMat4(vec3.create(), point, basis);
    for (let axis = 0; axis < 2; axis++) {
      minimum[axis] = Math.min(minimum[axis], projected[axis]);
      maximum[axis] = Math.max(maximum[axis], projected[axis]);
    }
  }
  return Math.max(maximum[1] - minimum[1], (maximum[0] - minimum[0]) / aspect) * padding;
}

// Return the eye-to-target distance needed to contain a box without changing the lens.
export function fitPerspectiveDistance(bounds, view, aspect, padding = 1.15) {
  rejectThreeObject(view, 'Fit camera');
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(padding) || padding < 1) {
    throw new RangeError('Fit aspect must be positive and padding at least one');
  }
  const finiteVector = vector => vector?.length === 3 && Array.from(vector).every(value => typeof value === 'number' && Number.isFinite(value));
  if (!finiteVector(bounds?.minimum) || !finiteVector(bounds?.maximum) || !bounds.maximum.every((value, axis) => value >= bounds.minimum[axis])) {
    throw new RangeError('Fit bounds must be finite and ordered');
  }
  const up = view?.up ?? [0, 1, 0];
  if (!finiteVector(view?.eye) || !finiteVector(view?.target) || !finiteVector(up)) {
    throw new RangeError('Fit camera vectors must be finite');
  }
  if (view.projection && view.projection !== 'perspective') {
    throw new RangeError('Perspective fit requires a perspective camera');
  }
  const fov = view.fov ?? 45;
  const near = view.near ?? 0.1;
  const far = view.far ?? 100;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180 || !Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    throw new RangeError('Fit lens must have 0 < fov < 180 and 0 < near < far');
  }
  const forward = vec3.subtract([], view.target, view.eye);
  const forwardLength = Math.hypot(...forward);
  if (!Number.isFinite(forwardLength) || forwardLength === 0) {
    throw new RangeError('Fit eye and target must differ');
  }
  for (let axis = 0; axis < 3; axis++) forward[axis] /= forwardLength;
  const upLength = Math.hypot(...up);
  if (!Number.isFinite(upLength) || upLength === 0) {
    throw new RangeError('Fit up must have a finite nonzero length');
  }
  const normalizedUp = Array.from(up, component => component / upLength);
  const right = vec3.cross([], forward, normalizedUp);
  const rightLength = Math.hypot(...right);
  if (!Number.isFinite(rightLength) || rightLength === 0) {
    throw new RangeError('Fit up must not be parallel to the view direction');
  }
  for (let axis = 0; axis < 3; axis++) right[axis] /= rightLength;
  const vertical = vec3.cross([], right, forward);
  const verticalTangent = Math.tan(fov * Math.PI / 360);
  const horizontalTangent = verticalTangent * aspect;
  if (!Number.isFinite(horizontalTangent) || horizontalTangent <= 0) {
    throw new RangeError('Fit aspect and lens exceed the supported numeric range');
  }
  let distance = near;
  let maximumDepth = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const offset = [0, 1, 2].map(axis => (corner & (1 << axis) ? bounds.maximum[axis] : bounds.minimum[axis]) - view.target[axis]);
    const horizontal = vec3.dot(offset, right);
    const height = vec3.dot(offset, vertical);
    const depth = vec3.dot(offset, forward);
    distance = Math.max(distance, Math.abs(horizontal) * padding / horizontalTangent - depth, Math.abs(height) * padding / verticalTangent - depth, near - depth);
    maximumDepth = Math.max(maximumDepth, depth);
  }
  if (!Number.isFinite(distance) || distance <= 0 || distance + maximumDepth > far) {
    throw new RangeError('Fit bounds cannot fit within the camera clipping planes');
  }
  const fittedEye = view.target.map((component, axis) => Math.fround(component - forward[axis] * distance));
  const roundedTarget = view.target.map(component => Math.fround(component));
  if (!fittedEye.every(Number.isFinite) || !roundedTarget.every(Number.isFinite)
    || fittedEye.every((component, axis) => component === roundedTarget[axis])) {
    throw new RangeError('Fit camera collapses or overflows after Float32 rounding; use coordinates closer to the origin');
  }
  return distance;
}

/**
 * Projects a 3D world `point` `[x, y, z]` into 2D screen coordinates `{ x, y, depth, inFront }` using the same view and
 * `applyProjection` setup as `renderer.render(frame)` (`x` left-to-right, `y` top-to-bottom in pixels, `depth` forward distance from the eye).
 */
export function projectToScreen(frame, point, width, height, { world = false } = {}) {
  rejectThreeObject(frame, 'Project camera');
  rejectThreeObject(point, 'Project point');
  requireNonDegenerateView(frame, 'Project');
  if (!point || point.length !== 3 || !Array.from(point).every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new RangeError('Project point must be three finite numbers.');
  }
  requirePositiveFinite(width, 'width');
  requirePositiveFinite(height, 'height');
  const aspect = width / height;
  const view = mat4.lookAt(mat4.create(), frame.eye, frame.target, frame.up ?? [0, 1, 0]);
  const projection = mat4.create();
  mat4.perspective(projection, world ? Math.PI / 4 : Math.PI / 5.5, aspect, 0.1, world ? 600 : 100);
  applyProjection(projection, frame, aspect, { world });
  const [px, py, pz] = point;
  const vx = view[0] * px + view[4] * py + view[8] * pz + view[12];
  const vy = view[1] * px + view[5] * py + view[9] * pz + view[13];
  const vz = view[2] * px + view[6] * py + view[10] * pz + view[14];
  const vw = view[3] * px + view[7] * py + view[11] * pz + view[15];
  const clipX = projection[0] * vx + projection[4] * vy + projection[8] * vz + projection[12] * vw;
  const clipY = projection[1] * vx + projection[5] * vy + projection[9] * vz + projection[13] * vw;
  const clipW = projection[3] * vx + projection[7] * vy + projection[11] * vz + projection[15] * vw;
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (0.5 - ndcY * 0.5) * height,
    depth: -vz,
    inFront: vz < 0,
  };
}
