// Setting the point the Studio view orbits: the surface under a pixel, and a camera move that keeps the angle and distance.

/**
 * `ensureQuery()` gives the scene query, `screenRay(x, y)` the ray of a pixel, `viewCamera()` the camera in force and
 * `moveViewportCamera(patch)` moves it without an undo step.
 */
export function createOrbitPivot({ ensureQuery, screenRay, viewCamera, moveViewportCamera }) {
  // The point on a surface under a pixel, or null over empty space. It never touches the selection.
  function surfacePointAt(pixelX, pixelY) {
    const hit = ensureQuery().raycast(screenRay(pixelX, pixelY));
    return hit ? Array.from(hit.point) : null;
  }

  // Makes `point` the centre the view orbits: eye and target move by the same offset, so the view angle and distance stay.
  function setOrbitPivot(point) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      throw new TypeError('setOrbitPivot requires a point of three finite numbers, such as [0, 1, 0].');
    }
    const camera = viewCamera();
    const offset = point.map((component, axis) => component - camera.target[axis]);
    return moveViewportCamera({ eye: camera.eye.map((component, axis) => component + offset[axis]), target: [...point] });
  }

  return { surfacePointAt, setOrbitPivot };
}
