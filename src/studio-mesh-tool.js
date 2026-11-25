// Studio edit mode, the held face tools: E extrudes the picked faces and I insets them. The pointer sets the amount while the key
// is held; a click or Enter confirms it as one entry of the mesh edit log, Esc or a right click puts everything back.
//
// This file holds the parts that need no editor state: which faces a pick stands for, what the engine does to them at a given
// amount (the same `extrude_face_region` and `inset_region` an agent writes, so the preview is the result), and the pointer wiring.
import { editMesh } from './mesh-edit.js';
import { selectFaces } from './mesh-select.js';
import { connectedRegions, extrudeFaceRegion, insetRegion } from './mesh-ops.js';

export const FACE_TOOLS = Object.freeze({
  extrude: Object.freeze({ verb: 'extrude', past: 'Extruded', hint: 'Extrude: move the pointer to set the distance, click or Enter to confirm, Esc or right click to cancel.' }),
  inset: Object.freeze({ verb: 'inset', past: 'Inset', hint: 'Inset: move the pointer to set the thickness, click or Enter to confirm, Esc or right click to cancel.' }),
});

export const PICK_FACES_FIRST = verb => `Pick whole faces to ${verb}: press 3 for face mode, then click the faces.`;

// Amounts are written to the recipe at this many decimals, and the preview uses the same rounded number.
const AMOUNT_DECIMALS = 4;

export function roundAmount(amount) {
  return Number(amount.toFixed(AMOUNT_DECIMALS));
}

/** The log entry of a face tool at `amount` (a distance along the faces' normal, or an inset thickness). */
export function faceToolEdit(kind, faces, amount) {
  const select = { faces: [...faces] };
  if (kind === 'extrude') return { op: 'extrude_face_region', select, offset: roundAmount(amount) };
  if (kind === 'inset') return { op: 'inset_region', select, thickness: roundAmount(amount) };
  throw new RangeError(`Unknown face tool "${String(kind)}"; use extrude or inset.`);
}

/**
 * Where the corners of the picked faces end up after the tool at `amount`: a map from vertex of the mesh to its new local position.
 * The engine runs on a copy; the cap of each face keeps the corner order of the face, which pairs the corners.
 */
export function faceToolTargets(mesh, kind, faces, amount) {
  const sortedFaces = [...faces].sort((first, second) => first - second);
  const before = editMesh(mesh);
  const orderedFaces = connectedRegions(before, sortedFaces).flat();
  const after = editMesh(mesh);
  const mask = selectFaces(mesh, { faces: sortedFaces });
  const result = kind === 'extrude'
    ? extrudeFaceRegion(after, mask, { offset: amount })
    : insetRegion(after, mask, { thickness: amount });
  const targets = new Map();
  orderedFaces.forEach((face, index) => {
    const corners = before.faceVertices(face);
    const capCorners = after.faceVertices(result.capFaces[index]);
    corners.forEach((vertex, corner) => targets.set(vertex, after.vertexPosition(capCorners[corner])));
  });
  return targets;
}

/**
 * How the pointer maps to an amount: the centre of the picked faces, how far one unit of the mesh reaches on screen, and for an
 * extrude the direction of the average normal. Throws the engine's sentence when the faces cannot be extruded or inset
 * (for example faces that face opposite ways, whose normals cancel).
 */
export function faceToolFrame(mesh, kind, faces) {
  const unit = faceToolTargets(mesh, kind, faces, kind === 'extrude' ? 1 : 1e-4);
  const cornerPoints = [...unit.keys()].map(vertex => [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis]));
  const centre = [0, 1, 2].map(axis => cornerPoints.reduce((sum, point) => sum + point[axis], 0) / cornerPoints.length);
  const radius = Math.max(1e-6, ...cornerPoints.map(point => Math.hypot(...[0, 1, 2].map(axis => point[axis] - centre[axis]))));
  // An extrude of one unit moves every cap corner by the region normal, which is the direction the pointer follows.
  const [firstVertex, firstTarget] = unit.entries().next().value;
  const normal = kind === 'extrude' ? [0, 1, 2].map(axis => firstTarget[axis] - mesh.positions[firstVertex * 3 + axis]) : null;
  return { centre, normal, radius, cornerPoints };
}

// The pointer must move this far (pixels) along the normal's screen line for the line to count; end-on it has no direction.
const MINIMUM_NORMAL_PIXELS = 12;
const FALLBACK_PIXELS_PER_UNIT = 100;

/**
 * The amount for a pointer at `pointer`, started at `start`. `project` takes a local point and returns pixels. An extrude follows
 * the pointer along the screen line of the normal (up the screen when the normal points at the camera); an inset grows with
 * the pointer's distance from where the key was pressed, one face radius of screen travel for one face radius of thickness.
 */
export function faceToolAmount(kind, frame, project, start, pointer) {
  const deltaX = pointer.x - start.x;
  const deltaY = pointer.y - start.y;
  const origin = project(frame.centre);
  const screenRadius = Math.max(...frame.cornerPoints.map(point => {
    const projected = project(point);
    return Math.hypot(projected.x - origin.x, projected.y - origin.y);
  }));
  const pixelsPerUnit = screenRadius > 1 ? screenRadius / frame.radius : FALLBACK_PIXELS_PER_UNIT;
  if (kind === 'inset') return Math.hypot(deltaX, deltaY) / pixelsPerUnit;
  const tip = project([0, 1, 2].map(axis => frame.centre[axis] + frame.normal[axis]));
  const lineX = tip.x - origin.x;
  const lineY = tip.y - origin.y;
  const lineLength = Math.hypot(lineX, lineY);
  if (lineLength < MINIMUM_NORMAL_PIXELS) return -deltaY / pixelsPerUnit;
  return (deltaX * lineX + deltaY * lineY) / (lineLength * lineLength);
}

/**
 * The pointer and key wiring of a held face tool. `editor` is the mesh editor: it starts, moves, confirms and cancels the tool.
 * While a tool is held every key belongs to it (`handleKey`), and the press that confirms or cancels is kept from reaching
 * what lies under the pointer.
 */
export function createFaceToolInput({ documentReference, editor, localCoordinates, onChange = () => {} }) {
  let held = false;
  let swallowClick = false;
  let swallowContextMenu = false;
  const windowReference = documentReference.defaultView;

  function onPointerMove(event) {
    const { x, y } = localCoordinates(event);
    editor.moveFaceTool(x, y);
    onChange();
  }

  function onPointerDown(event) {
    event.preventDefault();
    event.stopPropagation();
    swallowClick = event.button === 0;
    swallowContextMenu = event.button === 2;
    if (event.button === 0 || event.button === 2) stop(event.button === 0);
  }

  function onContextMenu(event) {
    if (!held && !swallowContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    swallowContextMenu = false;
  }

  function onClick(event) {
    if (!swallowClick) return;
    event.preventDefault();
    event.stopPropagation();
    swallowClick = false;
  }

  const onBlur = () => stop(false);

  function stop(confirmed) {
    if (!held) return;
    held = false;
    documentReference.removeEventListener('pointermove', onPointerMove);
    documentReference.removeEventListener('pointerdown', onPointerDown, true);
    windowReference?.removeEventListener?.('blur', onBlur);
    if (confirmed) {
      editor.finishFaceTool();
    } else {
      editor.cancelFaceTool();
    }
    onChange();
  }

  documentReference.addEventListener('contextmenu', onContextMenu, true);
  documentReference.addEventListener('click', onClick, true);

  return Object.freeze({
    get held() { return held; },
    /** Starts the tool at the pointer; false (with a notice from the editor) when the pick cannot take it. */
    start(kind, pointer) {
      if (held || !pointer) return false;
      if (!editor.beginFaceTool(kind, pointer.x, pointer.y).ok) {
        onChange();
        return false;
      }
      held = true;
      documentReference.addEventListener('pointermove', onPointerMove);
      documentReference.addEventListener('pointerdown', onPointerDown, true);
      windowReference?.addEventListener?.('blur', onBlur);
      onChange();
      return true;
    },
    /** Enter confirms, Esc cancels; every other key is spent so it cannot act on the object meanwhile. */
    handleKey(event) {
      if (!held) return false;
      if (event.key !== 'Shift') event.preventDefault();
      if (event.repeat) return true;
      if (event.key === 'Enter') stop(true);
      if (event.key === 'Escape') stop(false);
      return true;
    },
    cancel() {
      stop(false);
    },
  });
}
