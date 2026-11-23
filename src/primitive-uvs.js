import { TEXTURE_MAP_FIELDS } from './texture-set-fields.js';

// UV channel 0 for the box, cylinder and cone builders of geometry.js, which return none. A recipe gets them only when a
// material with an image map sits on one of these geometries, so an untextured box carries no UV buffer. A box face shows the
// whole image; the wall of a cylinder or cone wraps it once and each cap shows it as a disc.

// The builders' defaults in geometry.js (and `geometryEstimate` in agent-scene.js). The vertex count check below throws if one drifts.
const BOX_DEFAULTS = Object.freeze({ bevel: 0.08, subdivisions: 6 });
const CYLINDER_DEFAULTS = Object.freeze({ segments: 80, bevelSegments: 6 });
const CONE_DEFAULTS = Object.freeze({ radiusTop: 0, radiusBottom: 1, segments: 64 });
const BOX_FACES = 6;
const SHARP_BOX_FACE_VERTICES = 4;
const CAP_CENTER_VERTICES = 1;

const PRIMITIVE_UV_TYPES = ['box', 'cylinder', 'cone'];

function expectCount(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Cannot compute UVs for this ${label}: it has ${actual} vertices where its definition gives ${expected}. geometry.js and primitive-uvs.js disagree about the layout.`);
  }
}

function boxFaceVertexCount(definition) {
  const bevel = definition.bevel ?? BOX_DEFAULTS.bevel;
  if (bevel === 0) return SHARP_BOX_FACE_VERTICES;
  const subdivisions = definition.subdivisions ?? BOX_DEFAULTS.subdivisions;
  return (2 * subdivisions + 2) ** 2;
}

function boxUvs(definition, positions) {
  const faceVertices = boxFaceVertexCount(definition);
  expectCount(positions.length / 3, BOX_FACES * faceVertices, 'box');
  const uvs = new Float32Array(positions.length / 3 * 2);
  for (let face = 0; face < BOX_FACES; face++) {
    const axis = Math.floor(face / 2);
    const sign = face % 2 === 0 ? -1 : 1;
    const first = face * faceVertices;
    const planeAxes = [0, 1, 2].filter(candidate => candidate !== axis);
    let extent = 0;
    for (let vertex = first; vertex < first + faceVertices; vertex++) {
      for (const planeAxis of planeAxes) extent = Math.max(extent, Math.abs(positions[vertex * 3 + planeAxis]));
    }
    const scale = 1 / (2 * extent);
    for (let vertex = first; vertex < first + faceVertices; vertex++) {
      const x = positions[vertex * 3] * scale;
      const y = positions[vertex * 3 + 1] * scale;
      const z = positions[vertex * 3 + 2] * scale;
      const [u, v] = axis === 0 ? [0.5 - sign * z, 0.5 - y] : axis === 1 ? [0.5 + x, 0.5 + sign * z] : [0.5 + sign * x, 0.5 - y];
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
    }
  }
  return uvs;
}

// The wall is a grid of `segments + 1` columns whose seam column is repeated; column 0 sits at angle 0 and angles grow with the column.
function writeWallUvs(uvs, positions, wallVertices, segments) {
  const columns = segments + 1;
  for (let vertex = 0; vertex < wallVertices; vertex++) {
    const column = vertex % columns;
    uvs[vertex * 2] = 1 - column / segments;
    uvs[vertex * 2 + 1] = 0.5 - positions[vertex * 3 + 1];
  }
}

// A cap is a centre vertex followed by `segments + 1` ring vertices; the ring vertex at angle 0 gives the cap radius.
function writeCapUvs(uvs, positions, centerVertex, segments) {
  const sign = Math.sign(positions[centerVertex * 3 + 1]);
  const radius = Math.hypot(positions[(centerVertex + 1) * 3], positions[(centerVertex + 1) * 3 + 2]);
  uvs[centerVertex * 2] = 0.5;
  uvs[centerVertex * 2 + 1] = 0.5;
  for (let ring = 1; ring <= segments + 1; ring++) {
    const vertex = centerVertex + ring;
    uvs[vertex * 2] = 0.5 + positions[vertex * 3] / (2 * radius);
    uvs[vertex * 2 + 1] = 0.5 + sign * positions[vertex * 3 + 2] / (2 * radius);
  }
}

function cylinderUvs(definition, positions) {
  const segments = definition.segments ?? CYLINDER_DEFAULTS.segments;
  const bevelSegments = definition.bevelSegments ?? CYLINDER_DEFAULTS.bevelSegments;
  const wallVertices = (segments + 1) * (2 * bevelSegments + 2);
  const capVertices = CAP_CENTER_VERTICES + segments + 1;
  expectCount(positions.length / 3, wallVertices + 2 * capVertices, 'cylinder');
  const uvs = new Float32Array(positions.length / 3 * 2);
  writeWallUvs(uvs, positions, wallVertices, segments);
  writeCapUvs(uvs, positions, wallVertices, segments);
  writeCapUvs(uvs, positions, wallVertices + capVertices, segments);
  return uvs;
}

function coneUvs(definition, positions) {
  const radiusTop = definition.radiusTop ?? CONE_DEFAULTS.radiusTop;
  const radiusBottom = definition.radiusBottom ?? CONE_DEFAULTS.radiusBottom;
  const segments = definition.segments ?? CONE_DEFAULTS.segments;
  const wallVertices = (segments + 1) * 2;
  const capVertices = CAP_CENTER_VERTICES + segments + 1;
  const caps = [radiusTop, radiusBottom].filter(radius => radius !== 0).length;
  expectCount(positions.length / 3, wallVertices + caps * capVertices, 'cone');
  const uvs = new Float32Array(positions.length / 3 * 2);
  writeWallUvs(uvs, positions, wallVertices, segments);
  for (let cap = 0; cap < caps; cap++) writeCapUvs(uvs, positions, wallVertices + cap * capVertices, segments);
  return uvs;
}

/** UV channel 0 (a Float32Array of two values per vertex) for a built `box`, `cylinder` or `cone`, from its definition and geometry. */
export function primitiveUvs(definition, geometry) {
  switch (definition.type) {
    case 'box': return boxUvs(definition, geometry.positions);
    case 'cylinder': return cylinderUvs(definition, geometry.positions);
    case 'cone': return coneUvs(definition, geometry.positions);
    default: throw new Error(`primitiveUvs handles box, cylinder and cone, not ${definition.type}.`);
  }
}

function materialNeedsUvs(material) {
  if (material.boxMapScale) return false;
  return material.map !== undefined || TEXTURE_MAP_FIELDS.some(field => material[field] !== undefined);
}

/**
 * For each box, cylinder and cone geometry of a normalized recipe that a node with an image map material uses: its id, and
 * the function that returns a copy of the built geometry with its UVs.
 */
export function primitiveUvWriters(recipe) {
  const materialsById = new Map(recipe.materials.map(material => [material.id, material]));
  const texturedGeometryIds = new Set();
  for (const node of recipe.nodes) {
    const material = node.geometry === undefined ? undefined : materialsById.get(node.material);
    if (material && materialNeedsUvs(material)) texturedGeometryIds.add(node.geometry);
  }
  const writers = new Map();
  for (const definition of recipe.geometries) {
    if (PRIMITIVE_UV_TYPES.includes(definition.type) && texturedGeometryIds.has(definition.id)) {
      writers.set(definition.id, geometry => withPrimitiveUvs(definition, geometry));
    }
  }
  return writers;
}

/** A copy of a built box, cylinder or cone geometry with its UVs. */
export function withPrimitiveUvs(definition, geometry) {
  return { ...geometry, uvs: primitiveUvs(definition, geometry) };
}
