import { MESH_SMOOTH_ANGLE_DEFAULT } from './agent-scene-capabilities.js';
import { MAX_BEVEL_SEGMENTS, bevelEdges } from './mesh-bevel.js';
import { MAX_LOOP_CUTS, traceLoopCutRing } from './mesh-loopcut.js';
import { MAX_SELECTED_ELEMENTS } from './mesh-operations.js';
import { extractRender } from './mesh-render.js';
import { MAX_LOG_ENTRIES, roundAmount } from './studio-mesh-tool.js';
import { edgesOfSelection } from './studio-mesh-tools.js';

export { MAX_BEVEL_SEGMENTS, MAX_LOOP_CUTS };
export const MIN_BEVEL_SEGMENTS = 1;
export const MIN_LOOP_CUTS = 1;
export const MIN_LOOP_FACTOR = 0.01;
export const MAX_LOOP_FACTOR = 0.99;

const FALLBACK_PIXELS_PER_UNIT = 100;
const MINIMUM_EDGE_PIXELS = 8;
const PROBE_BEVEL_WIDTH = 1e-4;
const PREVIEW_FACE_LIMIT = 4000;
const SEE_THROUGH_OPACITY = 0.1;

function clampNumber(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function vertexLocalPosition(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

function edgeOtherVertex(mesh, edge, vertex) {
  const first = mesh.edgeVertices[edge * 2];
  return first === vertex ? mesh.edgeVertices[edge * 2 + 1] : first;
}

function interpolatePoint(first, second, fraction) {
  return [
    first[0] + (second[0] - first[0]) * fraction,
    first[1] + (second[1] - first[1]) * fraction,
    first[2] + (second[2] - first[2]) * fraction,
  ];
}

/** Whether `mesh` has at least one quad face that a loop cut can walk across. */
export function meshHasQuads(mesh) {
  for (let face = 0; face < mesh.faceCount; face += 1) {
    if (mesh.faceOffsets[face + 1] - mesh.faceOffsets[face] === 4) return true;
  }
  return false;
}

/**
 * Resolves the edges to bevel from `mode` and `selected`, validates them against `bevelEdges`,
 * and returns `{ edges, pairs, frame }` for interactive dragging.
 */
export function bevelSelectionEdges(mesh, mode, selected) {
  const edges = edgesOfSelection(mesh, mode, selected);
  if (edges.length === 0) {
    throw new RangeError('Pick at least one edge or face to bevel (press 2 for edge mode or 3 for face mode; in vertex mode, pick both ends of an edge).');
  }
  if (edges.length > MAX_SELECTED_ELEMENTS) {
    throw new RangeError(`Beveling more than ${MAX_SELECTED_ELEMENTS} edges at once is not possible; pick fewer.`);
  }
  const pairs = edges.map(edge => [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]);
  bevelEdges(mesh, { edges: pairs }, { width: PROBE_BEVEL_WIDTH, segments: 1, clampOverlap: true });
  const vertexSet = new Set();
  for (const edge of edges) {
    vertexSet.add(mesh.edgeVertices[edge * 2]);
    vertexSet.add(mesh.edgeVertices[edge * 2 + 1]);
  }
  const cornerPoints = [...vertexSet].map(vertex => vertexLocalPosition(mesh, vertex));
  const centre = [0, 1, 2].map(axis => cornerPoints.reduce((sum, point) => sum + point[axis], 0) / cornerPoints.length);
  const radius = Math.max(1e-6, ...cornerPoints.map(point => Math.hypot(point[0] - centre[0], point[1] - centre[1], point[2] - centre[2])));
  return { edges, pairs, frame: { centre, radius, cornerPoints } };
}

/** The bevel width for a pointer at `pointer`, started at `start`. */
export function bevelToolWidth(frame, project, start, pointer) {
  const origin = project(frame.centre);
  const screenRadius = Math.max(...frame.cornerPoints.map(point => {
    const projected = project(point);
    return Math.hypot(projected.x - origin.x, projected.y - origin.y);
  }));
  const pixelsPerUnit = screenRadius > 1 ? screenRadius / frame.radius : FALLBACK_PIXELS_PER_UNIT;
  return Math.hypot(pointer.x - start.x, pointer.y - start.y) / pixelsPerUnit;
}

/** The recipe edit entry for beveling the selected edges at `width` and `segments`. */
export function planMeshBevel(mesh, mode, selected, { width, segments = 1 } = {}) {
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError(`Bevel width must be a finite number above 0, not ${String(width)}.`);
  }
  if (!Number.isInteger(segments) || segments < MIN_BEVEL_SEGMENTS || segments > MAX_BEVEL_SEGMENTS) {
    throw new RangeError(`Bevel segments must be a whole number from ${MIN_BEVEL_SEGMENTS} to ${MAX_BEVEL_SEGMENTS}, not ${String(segments)}.`);
  }
  const { pairs } = bevelSelectionEdges(mesh, mode, selected);
  return { op: 'bevel', edges: { edges: pairs }, width: roundAmount(width), segments };
}

/** The recipe edit entry for a loop cut across the ring of `seedEdge`. */
export function planMeshLoopCut(mesh, seedEdge, { cuts = 1, factor = 0.5 } = {}) {
  if (!Number.isInteger(seedEdge) || seedEdge < 0 || seedEdge >= mesh.edgeCount) {
    throw new RangeError(`Loop cut edge must be a whole number from 0 to ${mesh.edgeCount - 1}; got ${String(seedEdge)}.`);
  }
  if (!Number.isInteger(cuts) || cuts < MIN_LOOP_CUTS || cuts > MAX_LOOP_CUTS) {
    throw new RangeError(`Loop cut count must be a whole number from ${MIN_LOOP_CUTS} to ${MAX_LOOP_CUTS}, not ${String(cuts)}.`);
  }
  const pair = [mesh.edgeVertices[seedEdge * 2], mesh.edgeVertices[seedEdge * 2 + 1]];
  if (cuts > 1) return { op: 'loop_cut', edges: { edges: [pair] }, cuts };
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) {
    throw new RangeError(`Loop cut factor must be a number strictly between 0 and 1, not ${String(factor)}.`);
  }
  return { op: 'loop_cut', edges: { edges: [pair] }, cuts: 1, factor: roundAmount(factor) };
}

function tryRingCandidate(mesh, edge) {
  if (edge === null || edge === undefined) return null;
  try {
    const ring = traceLoopCutRing(mesh, edge);
    if (ring.quads.length === 0) return null;
    return { seedEdge: edge, pair: [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]], ring };
  } catch {
    return null;
  }
}

/** Picks the edge ring candidate under `(pixelX, pixelY)` when `faceHit` or nearest edge touches a quad ring. */
export function loopCutCandidateAt(mesh, projected, faceHit, pixelX, pixelY, nearestEdgeOfFace, nearestEdge) {
  if (faceHit !== null) {
    const preferred = nearestEdgeOfFace(faceHit, pixelX, pixelY, projected);
    const direct = tryRingCandidate(mesh, preferred);
    if (direct) return direct;
    for (let corner = mesh.faceOffsets[faceHit]; corner < mesh.faceOffsets[faceHit + 1]; corner += 1) {
      const candidate = tryRingCandidate(mesh, mesh.cornerEdges[corner]);
      if (candidate) return candidate;
    }
  }
  return tryRingCandidate(mesh, nearestEdge(pixelX, pixelY, projected));
}

/** 3D local line segments `[startLocal, endLocal]` across every quad of `ring` for the current `cuts` and `factor`. */
export function loopCutPreviewSegments(mesh, ring, cuts, factor) {
  const fractions = cuts === 1
    ? [factor]
    : Array.from({ length: cuts }, (_, index) => (index + 1) / (cuts + 1));
  const segments = [];
  for (const fraction of fractions) {
    for (const quad of ring.quads) {
      const entryLow = ring.edges.get(quad.entryEdge);
      const oppositeLow = ring.edges.get(quad.oppositeEdge);
      if (entryLow === undefined || oppositeLow === undefined) continue;
      const entryStart = vertexLocalPosition(mesh, entryLow);
      const entryEnd = vertexLocalPosition(mesh, edgeOtherVertex(mesh, quad.entryEdge, entryLow));
      const oppositeStart = vertexLocalPosition(mesh, oppositeLow);
      const oppositeEnd = vertexLocalPosition(mesh, edgeOtherVertex(mesh, quad.oppositeEdge, oppositeLow));
      segments.push([
        interpolatePoint(entryStart, entryEnd, fraction),
        interpolatePoint(oppositeStart, oppositeEnd, fraction),
      ]);
    }
  }
  return segments;
}

/** Slide factor in `[0.01, 0.99]` for a single loop cut along the screen projection of `seedEdge`. */
export function loopCutSlideFactor(mesh, seedEdge, lowVertex, projectLocal, start, pointer) {
  const highVertex = edgeOtherVertex(mesh, seedEdge, lowVertex);
  const lowScreen = projectLocal(vertexLocalPosition(mesh, lowVertex));
  const highScreen = projectLocal(vertexLocalPosition(mesh, highVertex));
  const axisX = highScreen.x - lowScreen.x;
  const axisY = highScreen.y - lowScreen.y;
  const axisLength = Math.hypot(axisX, axisY);
  const delta = axisLength >= MINIMUM_EDGE_PIXELS
    ? ((pointer.x - start.x) * axisX + (pointer.y - start.y) * axisY) / (axisLength * axisLength)
    : (pointer.x - start.x) / FALLBACK_PIXELS_PER_UNIT;
  return clampNumber(roundAmount(0.5 + delta), MIN_LOOP_FACTOR, MAX_LOOP_FACTOR);
}

/** Interactive Bevel (Ctrl+B) and Loop Cut (Ctrl+R) session controller bound to a mesh editor. */
export function createBevelLoopTools({
  getState,
  isBusy,
  controller,
  announce,
  getRenderer,
  getSeeThrough,
  writeEntry,
  projectCage,
  faceUnderPointer,
  faceBehindPointer,
  nearestEdge,
  nearestEdgeOfFace,
  transformPoint,
}) {
  let session = null;
  let viewRevision = 0;

  function refuse(message) {
    announce(message);
    return { ok: false, message };
  }

  function projectLocalPoint(local) {
    const state = getState();
    const world = transformPoint(state.part.matrix, local[0], local[1], local[2]);
    return controller.worldPointProjector()(world);
  }

  function buildPreviewPart(state, mesh) {
    if (!getRenderer() || !state.previewable || state.tooLarge || mesh.faceCount > PREVIEW_FACE_LIMIT) return null;
    try {
      const { geometry } = extractRender(mesh, { sharpAngle: MESH_SMOOTH_ANGLE_DEFAULT * Math.PI / 180 });
      const basePart = state.part;
      const material = getSeeThrough()
        ? { ...basePart.material, alphaMode: 'blend', opacity: Math.min(basePart.material.opacity ?? 1, SEE_THROUGH_OPACITY), doubleSided: true }
        : basePart.material;
      return Object.freeze({ ...basePart, geometry, material });
    } catch {
      return null;
    }
  }

  function clearPreview() {
    if (!session) return;
    if (session.previewPart) viewRevision += 1;
    session.previewMesh = null;
    session.previewPart = null;
  }

  function updateBevelPreview(rawWidth, segments) {
    const state = getState();
    if (!session || session.kind !== 'bevel' || !state) return;
    const width = roundAmount(Math.max(0, rawWidth));
    if (width <= 0) {
      session.width = 0;
      clearPreview();
      announce(`Bevel: move pointer for width, wheel or + / - for segments (${segments}), click or Enter to confirm, Esc or right click to cancel.`);
      return;
    }
    try {
      const result = bevelEdges(state.mesh, { edges: session.pairs }, { width, segments, clampOverlap: true });
      session.width = roundAmount(result.width);
      session.previewMesh = result.mesh;
      session.previewPart = buildPreviewPart(state, result.mesh);
      viewRevision += 1;
      announce(`Bevel: width ${session.width}, ${segments} ${segments === 1 ? 'segment' : 'segments'}.`);
    } catch {
      // Keep the last valid bevel preview when a transient pointer position is rejected.
    }
  }

  function updateLoopCutCandidate(pixelX, pixelY) {
    const state = getState();
    if (!session || session.kind !== 'loopCut' || !state) return;
    const projected = projectCage();
    const faceHit = getSeeThrough() ? faceBehindPointer(pixelX, pixelY) : faceUnderPointer(pixelX, pixelY);
    session.candidate = loopCutCandidateAt(state.mesh, projected, faceHit, pixelX, pixelY, nearestEdgeOfFace, nearestEdge);
  }

  function begin(kind, pointerX, pointerY) {
    const state = getState();
    if (kind === 'bevel') {
      if (!state) return refuse('Enter edit mode on a mesh to bevel.');
      if (isBusy()) return refuse('Let go of the move before you bevel.');
      if (state.editCount >= MAX_LOG_ENTRIES) return refuse(`This mesh already has ${MAX_LOG_ENTRIES} edits, the most one mesh holds, so it cannot take a bevel.`);
      let resolved;
      try {
        resolved = bevelSelectionEdges(state.mesh, state.mode, state.selected);
      } catch (error) {
        return refuse(error.message);
      }
      session = { kind: 'bevel', pairs: resolved.pairs, frame: resolved.frame, start: { x: pointerX, y: pointerY }, width: 0, segments: 1, previewMesh: null, previewPart: null };
      announce('Bevel: move pointer for width, wheel or + / - for segments (1), click or Enter to confirm, Esc or right click to cancel.');
      return { ok: true };
    }
    if (kind === 'loopCut') {
      if (!state) return refuse('Enter edit mode on a mesh to loop cut.');
      if (isBusy()) return refuse('Let go of the move before you loop cut.');
      if (state.editCount >= MAX_LOG_ENTRIES) return refuse(`This mesh already has ${MAX_LOG_ENTRIES} edits, the most one mesh holds, so it cannot take a loop cut.`);
      if (!meshHasQuads(state.mesh)) return refuse('Loop cut needs quad faces to walk an edge ring.');
      session = { kind: 'loopCut', phase: 'hover', cuts: 1, factor: 0.5, candidate: null, start: null, previewMesh: null, previewPart: null };
      updateLoopCutCandidate(pointerX, pointerY);
      announce('Loop cut: hover an edge for a ring, wheel or + / - for cuts (1), click to slide, Esc or right click to cancel.');
      return { ok: true };
    }
    throw new RangeError(`Unknown topology tool "${String(kind)}"; use bevel or loopCut.`);
  }

  function move(pixelX, pixelY) {
    const state = getState();
    if (!session || !state) return;
    if (session.kind === 'bevel') {
      const rawWidth = bevelToolWidth(session.frame, projectLocalPoint, session.start, { x: pixelX, y: pixelY });
      updateBevelPreview(rawWidth, session.segments);
      return;
    }
    if (session.phase === 'hover') {
      updateLoopCutCandidate(pixelX, pixelY);
      return;
    }
    if (session.cuts === 1 && session.candidate) {
      session.factor = loopCutSlideFactor(state.mesh, session.candidate.seedEdge, session.candidate.ring.lowVertex, projectLocalPoint, session.start, { x: pixelX, y: pixelY });
      announce(`Loop cut: slide ${session.factor}, click or Enter to confirm, Esc or right click to cancel.`);
    }
  }

  function stepCount(delta) {
    const state = getState();
    if (!session || !state || !Number.isFinite(delta) || delta === 0) return false;
    if (session.kind === 'bevel') {
      const next = clampInteger(session.segments + delta, MIN_BEVEL_SEGMENTS, MAX_BEVEL_SEGMENTS);
      if (next === session.segments) return false;
      session.segments = next;
      if (session.width > 0) updateBevelPreview(session.width, session.segments);
      else announce(`Bevel: move pointer for width, wheel or + / - for segments (${session.segments}), click or Enter to confirm, Esc or right click to cancel.`);
      return true;
    }
    const next = clampInteger(session.cuts + delta, MIN_LOOP_CUTS, MAX_LOOP_CUTS);
    if (next === session.cuts) return false;
    session.cuts = next;
    announce(`Loop cut: ${session.cuts} ${session.cuts === 1 ? 'cut' : 'cuts'}.`);
    return true;
  }

  function confirm() {
    const state = getState();
    if (!session || !state) return;
    const current = session;
    clearPreview();
    session = null;
    if (current.kind === 'bevel') {
      if (current.width <= 0) {
        announce('Bevel canceled: move pointer to set a width above 0.');
        return;
      }
      try {
        writeEntry({ op: 'bevel', edges: { edges: current.pairs }, width: roundAmount(current.width), segments: current.segments });
      } catch (error) {
        announce(error.message ?? String(error));
        return;
      }
      announce(`Beveled ${current.pairs.length} ${current.pairs.length === 1 ? 'edge' : 'edges'} (${current.segments} ${current.segments === 1 ? 'segment' : 'segments'})`);
      return;
    }
    if (!current.candidate) {
      announce('No loop cut ring under the pointer.');
      return;
    }
    try {
      writeEntry(planMeshLoopCut(state.mesh, current.candidate.seedEdge, { cuts: current.cuts, factor: current.factor }));
    } catch (error) {
      announce(error.message ?? String(error));
      return;
    }
    announce(`Added ${current.cuts} loop ${current.cuts === 1 ? 'cut' : 'cuts'}`);
  }

  function click(pixelX, pixelY) {
    if (!session) return true;
    if (session.kind === 'bevel') {
      confirm();
      return true;
    }
    if (session.phase === 'hover') {
      if (!session.candidate) updateLoopCutCandidate(pixelX, pixelY);
      if (!session.candidate) {
        announce('Move the pointer over a quad edge to pick a loop cut.');
        return false;
      }
      session.phase = 'slide';
      session.start = { x: pixelX, y: pixelY };
      session.factor = 0.5;
      announce(session.cuts === 1
        ? 'Loop cut locked: move pointer to slide, click or Enter to confirm, Esc or right click to cancel.'
        : `Loop cut locked (${session.cuts} cuts): click or Enter to confirm, Esc or right click to cancel.`);
      return false;
    }
    confirm();
    return true;
  }

  function cancel() {
    if (!session) return;
    clearPreview();
    session = null;
  }

  function partsToDraw(parts) {
    const state = getState();
    if (!state || !session?.previewPart) return null;
    return parts.map(part => (part === state.part ? session.previewPart : part));
  }

  function previewPaths() {
    const state = getState();
    if (!session || !state) return [];
    if (session.kind === 'bevel' && session.previewMesh) {
      const previewMesh = session.previewMesh;
      let edgePath = '';
      for (let edge = 0; edge < previewMesh.edgeCount; edge += 1) {
        const start = projectLocalPoint(vertexLocalPosition(previewMesh, previewMesh.edgeVertices[edge * 2]));
        const end = projectLocalPoint(vertexLocalPosition(previewMesh, previewMesh.edgeVertices[edge * 2 + 1]));
        if (start.visible && end.visible) {
          edgePath += `M${start.x.toFixed(1)} ${start.y.toFixed(1)}L${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
        }
      }
      return [
        { className: 'crucible-studio-cage-halo', pathData: edgePath, layer: 'under' },
        { className: 'crucible-studio-cage-edges', pathData: edgePath, layer: 'under' },
      ];
    }
    if (session.kind === 'loopCut' && session.candidate) {
      const segments = loopCutPreviewSegments(state.mesh, session.candidate.ring, session.cuts, session.factor);
      let pathData = '';
      for (const [startLocal, endLocal] of segments) {
        const start = projectLocalPoint(startLocal);
        const end = projectLocalPoint(endLocal);
        if (start.visible && end.visible) {
          pathData += `M${start.x.toFixed(1)} ${start.y.toFixed(1)}L${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
        }
      }
      if (!pathData) return [];
      return [
        { className: 'crucible-studio-cage-selected-halo crucible-studio-cage-selected-halo-edge', pathData, layer: 'over' },
        { className: 'crucible-studio-cage-selected crucible-studio-cage-selected-edge crucible-studio-cage-loop-cut', pathData, layer: 'over' },
      ];
    }
    return [];
  }

  return Object.freeze({
    get active() { return session !== null; },
    get kind() { return session?.kind ?? null; },
    get hideDefaultCage() { return session?.kind === 'bevel' && session.previewMesh !== null; },
    get viewRevision() { return viewRevision; },
    begin,
    move,
    stepCount,
    click,
    confirm,
    cancel,
    partsToDraw,
    previewPaths,
  });
}
