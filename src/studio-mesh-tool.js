// Studio edit mode, the held face tools: E extrudes the picked faces and I insets them. The pointer sets the amount while the key
// is held; a click or Enter confirms it as one entry of the mesh edit log, Esc or a right click puts everything back.
//
// This file holds the parts that need no editor state: what the engine does to the picked faces at a given amount (the same
// `extrude_face_region` and `inset_region` an agent writes), and the pointer wiring. While the tool is held the preview moves the
// existing corners of the faces to where the cap will stand; the new side faces appear when the tool is confirmed.
import { editMesh } from './mesh-edit.js';
import { selectFaces } from './mesh-select.js';
import { connectedRegions, extrudeFaceRegion, insetRegion } from './mesh-ops.js';

export const FACE_TOOLS = Object.freeze({
  extrude: Object.freeze({ verb: 'extrude', past: 'Extruded', cannotStart: 'These faces cannot extrude as one region: their normals cancel out, as on a ring of faces round a cylinder. Pick faces that face one way.', hint: 'Extrude: move the pointer to set the distance, click or Enter to confirm, Esc or right click to cancel.' }),
  inset: Object.freeze({ verb: 'inset', past: 'Inset', cannotStart: 'These faces are too small to inset. Pick larger faces.', hint: 'Inset: move the pointer to set the thickness, click or Enter to confirm, Esc or right click to cancel.' }),
});

export const PICK_FACES_FIRST = verb => `Pick whole faces to ${verb}: press 3 for face mode, then click the faces.`;
export const MAX_LOG_ENTRIES = 64;

// Amounts are written to the recipe at this many decimals, and the preview uses the same rounded number.
const AMOUNT_DECIMALS = 4;
const WHEEL_PIXELS_PER_STEP = 100;
const WHEEL_PIXELS_PER_LINE = WHEEL_PIXELS_PER_STEP / 3;
const WHEEL_PIXELS_PER_PAGE = WHEEL_PIXELS_PER_STEP * 3;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

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
 * Where the corners of the picked faces end up after the tool at `amount`: `targets` maps each vertex of the mesh to its new local
 * position, and `usedAmount` is the amount the engine kept (an inset past what the faces hold is clamped to the largest that works).
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
  return { targets, usedAmount: kind === 'inset' ? result.thickness : amount };
}

/**
 * How the pointer maps to an amount: the centre of the picked faces, how far one unit of the mesh reaches on screen, and for an
 * extrude the direction of the average normal. Throws the engine's sentence when the faces cannot be extruded or inset
 * (for example faces that face opposite ways, whose normals cancel).
 */
export function faceToolFrame(mesh, kind, faces) {
  const { targets: unit } = faceToolTargets(mesh, kind, faces, kind === 'extrude' ? 1 : 1e-4);
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
  let activeKind = null;
  let wheelTravel = 0;
  let swallowClick = false;
  let swallowContextMenu = false;
  const windowReference = documentReference.defaultView;
  const isTopologyTool = kind => kind === 'bevel' || kind === 'loopCut';

  // The scene can change under a held tool (a reload, an undo from outside): the editor has put the tool away, so it is over.
  function stopWhenEditorLetGo() {
    const active = isTopologyTool(activeKind) ? editor.holdingTopologyTool : editor.holdingFaceTool;
    if (held && !active) stop(false);
    return !held;
  }

  function onPointerMove(event) {
    if (stopWhenEditorLetGo()) return;
    const { x, y } = localCoordinates(event);
    if (isTopologyTool(activeKind)) editor.moveTopologyTool(x, y);
    else editor.moveFaceTool(x, y);
    onChange();
  }

  function detachListeners() {
    documentReference.removeEventListener('pointermove', onPointerMove);
    documentReference.removeEventListener('pointerdown', onPointerDown, true);
    windowReference?.removeEventListener?.('blur', onBlur);
  }

  function onPointerDown(event) {
    event.preventDefault();
    event.stopPropagation();
    swallowClick = event.button === 0;
    swallowContextMenu = event.button === 2;
    if (event.button === 2) {
      stop(false);
      return;
    }
    if (event.button !== 0) return;
    if (isTopologyTool(activeKind)) {
      const { x, y } = localCoordinates(event);
      if (editor.clickTopologyTool(x, y)) {
        held = false;
        activeKind = null;
        wheelTravel = 0;
        detachListeners();
      }
      onChange();
      return;
    }
    stop(true);
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
    const kind = activeKind;
    held = false;
    activeKind = null;
    wheelTravel = 0;
    detachListeners();
    if (isTopologyTool(kind)) {
      if (confirmed) editor.finishTopologyTool();
      else editor.cancelTopologyTool();
    } else if (confirmed) {
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
      const result = isTopologyTool(kind)
        ? editor.beginTopologyTool(kind, pointer.x, pointer.y)
        : editor.beginFaceTool(kind, pointer.x, pointer.y);
      if (!result.ok) {
        onChange();
        return false;
      }
      held = true;
      activeKind = kind;
      wheelTravel = 0;
      documentReference.addEventListener('pointermove', onPointerMove);
      documentReference.addEventListener('pointerdown', onPointerDown, true);
      windowReference?.addEventListener?.('blur', onBlur);
      onChange();
      return true;
    },
    /** Enter confirms, Esc cancels, + / - step segments or cuts; every other key is spent so it cannot act on the object meanwhile. */
    handleKey(event) {
      if (stopWhenEditorLetGo()) return false;
      if (event.key !== 'Shift') event.preventDefault();
      if (isTopologyTool(activeKind)) {
        if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
          editor.stepTopologyTool(1);
          onChange();
          return true;
        }
        if (event.key === '-' || event.code === 'NumpadSubtract') {
          editor.stepTopologyTool(-1);
          onChange();
          return true;
        }
      }
      if (event.repeat) return true;
      if (event.key === 'Enter') stop(true);
      if (event.key === 'Escape') stop(false);
      return true;
    },
    /** Wheel adjusts bevel segments or loop-cut count while one of those tools is held. */
    handleWheel(event) {
      if (stopWhenEditorLetGo()) return false;
      if (!isTopologyTool(activeKind)) return false;
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return true;
      const pixelsPerUnit = event.deltaMode === WHEEL_DELTA_PAGE ? WHEEL_PIXELS_PER_PAGE : event.deltaMode === WHEEL_DELTA_LINE ? WHEEL_PIXELS_PER_LINE : 1;
      const travel = -event.deltaY * pixelsPerUnit;
      if (Math.sign(travel) !== Math.sign(wheelTravel)) wheelTravel = 0;
      wheelTravel += travel;
      const steps = Math.trunc(wheelTravel / WHEEL_PIXELS_PER_STEP);
      if (steps !== 0) {
        wheelTravel -= steps * WHEEL_PIXELS_PER_STEP;
        editor.stepTopologyTool(steps);
        onChange();
      }
      return true;
    },
    cancel() {
      stop(false);
    },
    /** Takes every listener off the page, for when Studio is disposed. */
    dispose() {
      stop(false);
      documentReference.removeEventListener('contextmenu', onContextMenu, true);
      documentReference.removeEventListener('click', onClick, true);
    },
  });
}
