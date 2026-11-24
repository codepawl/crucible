export const STUDIO_TOOLS = Object.freeze(['select', 'translate', 'rotate', 'scale']);
export const STUDIO_TABS = Object.freeze(['node', 'material', 'look', 'camera']);
// The shapes of the add menu, in the groups it shows them in and in the order of Blender's Add menu: the basic meshes, then
// text. Every id is one lowercase word, because node ids and button labels are made from it. The lights follow in the menu.
export const STUDIO_PRIMITIVE_GROUPS = Object.freeze([
  Object.freeze({ label: 'Mesh', primitives: Object.freeze(['plane', 'box', 'disc', 'sphere', 'icoSphere', 'cylinder', 'cone', 'torus']) }),
  Object.freeze({ label: 'Text', primitives: Object.freeze(['text']) }),
]);
export const STUDIO_PRIMITIVES = Object.freeze(STUDIO_PRIMITIVE_GROUPS.flatMap(group => group.primitives));
export const STUDIO_VIEW_PRESETS = Object.freeze(['front', 'back', 'right', 'left', 'top', 'isometric']);
export const STUDIO_LENS_PRESETS = Object.freeze([24, 35, 50, 85]);

export const STUDIO_MATERIAL_PRESETS = Object.freeze({
  clay: Object.freeze({ label: 'Clay', color: [0.68, 0.44, 0.34], roughness: 0.78, metallic: 0, clearcoat: 0, opacity: 1, emission: 0 }),
  'brushed-metal': Object.freeze({ label: 'Metal', color: [0.64, 0.67, 0.7], roughness: 0.28, metallic: 0.94, clearcoat: 0, opacity: 1, emission: 0 }),
  gold: Object.freeze({ label: 'Gold', color: [0.82, 0.56, 0.14], roughness: 0.22, metallic: 0.96, clearcoat: 0, opacity: 1, emission: 0 }),
  ceramic: Object.freeze({ label: 'Ceramic', color: [0.86, 0.85, 0.82], roughness: 0.18, metallic: 0.02, clearcoat: 0.7, clearcoatRoughness: 0.08, opacity: 1, emission: 0 }),
  'glass-coat': Object.freeze({ label: 'Tint coat', color: [0.16, 0.42, 0.62], roughness: 0.14, metallic: 0.12, clearcoat: 1, clearcoatRoughness: 0.04, opacity: 0.62, emission: 0 }),
  'neon-teal': Object.freeze({ label: 'Neon', color: [0.06, 0.62, 0.56], roughness: 0.3, metallic: 0.08, clearcoat: 0, opacity: 1, emission: 2.2, emissiveColor: [0.1, 0.85, 0.74] }),
  'matte-slate': Object.freeze({ label: 'Slate', color: [0.1, 0.12, 0.15], roughness: 0.86, metallic: 0.04, clearcoat: 0, opacity: 1, emission: 0 }),
});

export function primitiveGeometrySpec(primitiveType) {
  switch (primitiveType) {
    case 'box':
      return {
        labelPrefix: 'Box',
        geometry: { type: 'box', bevel: 0.04 },
        translation: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
    case 'sphere':
      return {
        labelPrefix: 'Sphere',
        geometry: { type: 'sphere', segments: 36, rings: 24 },
        translation: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [0.5, 0.5, 0.5],
      };
    case 'cylinder':
      return {
        labelPrefix: 'Cylinder',
        geometry: { type: 'cylinder', segments: 48, bevel: 0.025 },
        translation: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [0.5, 1, 0.5],
      };
    case 'cone':
      return {
        labelPrefix: 'Cone',
        geometry: { type: 'cone', radiusTop: 0, radiusBottom: 1, segments: 48 },
        translation: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [0.55, 1, 0.55],
      };
    case 'torus':
      return {
        labelPrefix: 'Torus',
        geometry: { type: 'torus', tubeRadius: 0.24, segments: 56, sides: 24 },
        translation: [0, 0.72, 0],
        rotation: [0, 0, 0, 1],
        scale: [0.7, 0.7, 0.7],
      };
    case 'plane':
      return {
        labelPrefix: 'Plane',
        geometry: { type: 'plane', segments: 8 },
        translation: [0, 0.02, 0],
        rotation: [-0.7071, 0, 0, 0.7071],
        scale: [4, 4, 1],
      };
    case 'icoSphere':
      return {
        labelPrefix: 'Icosphere',
        geometry: { type: 'icoSphere', subdivisions: 2 },
        translation: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [0.5, 0.5, 0.5],
      };
    case 'disc':
      return {
        labelPrefix: 'Circle',
        geometry: { type: 'circle', segments: 64 },
        translation: [0, 0.02, 0],
        rotation: [-0.7071, 0, 0, 0.7071],
        scale: [0.5, 0.5, 1],
      };
    case 'text':
      return {
        labelPrefix: 'Text',
        geometry: { type: 'text', text: 'Text', size: 0.6, depth: 0.12 },
        translation: [0, 0.05, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
    default:
      throw new RangeError(`Unknown primitive "${String(primitiveType)}". Use one of ${STUDIO_PRIMITIVES.join(', ')}.`);
  }
}

export const STUDIO_TEMPLATES = Object.freeze({
  blockout: Object.freeze({ label: 'Blockout', description: 'Three grey primitives on the grid, ready to shape' }),
  showcase: Object.freeze({ label: 'Gyro showcase', description: 'Turntable rig with key motion and 3 camera bookmarks' }),
  pedestal: Object.freeze({ label: 'Product studio', description: 'Soft ceramic hero sculpture on studio pedestal' }),
  courtyard: Object.freeze({ label: 'Block courtyard', description: 'Architectural daylight composition ready to block out' }),
  empty: Object.freeze({ label: 'Clean stage', description: 'Single ground plane and calibrated key light' }),
});

export function buildTemplateRecipe(templateName = 'blockout') {
  if (!Object.hasOwn(STUDIO_TEMPLATES, templateName)) {
    throw new RangeError(`Unknown Studio template "${String(templateName)}". Use one of ${Object.keys(STUDIO_TEMPLATES).join(', ')}.`);
  }
  if (templateName === 'blockout') {
    return {
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [
        { id: 'block', type: 'box', bevel: 0.03 },
        { id: 'ball', type: 'sphere', segments: 48, rings: 24 },
        { id: 'spike', type: 'cone', radiusTop: 0, radiusBottom: 0.5, segments: 48 },
      ],
      materials: [
        { id: 'clay', tag: 'surface', color: [0.62, 0.62, 0.64], roughness: 0.7, metallic: 0 },
      ],
      nodes: [
        { id: 'cube', label: 'Cube', geometry: 'block', material: 'clay', translation: [0, 0.5, 0] },
        { id: 'sphere', label: 'Sphere', geometry: 'ball', material: 'clay', translation: [-1.6, 0.5, 0.4], scale: [0.5, 0.5, 0.5] },
        { id: 'cone', label: 'Cone', geometry: 'spike', material: 'clay', translation: [1.5, 0.5, -0.6] },
      ],
      camera: { eye: [4.2, 2.9, 4.9], target: [0, 0.5, 0], up: [0, 1, 0], fov: 42, near: 0.1, far: 120 },
      environment: { setup: 'studio', lightDirection: [-3.2, 5.2, 3.8], keyIntensity: 1.65, viewTransform: 'agx' },
      effects: { exposure: 0.96 },
    };
  }
  if (templateName === 'pedestal') {
    return {
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [
        { id: 'floor', type: 'box', bevel: 0 },
        { id: 'plinth', type: 'cylinder', segments: 64, bevel: 0.03 },
        { id: 'sculpture', type: 'icoSphere', subdivisions: 3 },
        { id: 'halo', type: 'torus', tubeRadius: 0.1, segments: 64, sides: 24 },
      ],
      materials: [
        { id: 'floor-mat', tag: 'surface', color: [0.09, 0.1, 0.12], roughness: 0.9, metallic: 0.02 },
        { id: 'stone', tag: 'surface', color: [0.52, 0.5, 0.47], roughness: 0.52, metallic: 0.02 },
        { id: 'ceramic', tag: 'surface', color: [0.86, 0.84, 0.8], roughness: 0.18, metallic: 0.02, clearcoat: 0.65, clearcoatRoughness: 0.08 },
        { id: 'brass', tag: 'surface', color: [0.82, 0.56, 0.14], roughness: 0.2, metallic: 0.94 },
      ],
      nodes: [
        { id: 'stage-floor', label: 'Stage floor', geometry: 'floor', material: 'floor-mat', translation: [0, -0.1, 0], scale: [14, 0.2, 14] },
        { id: 'pedestal', label: 'Pedestal', geometry: 'plinth', material: 'stone', translation: [0, 0.35, 0], scale: [1.1, 0.7, 1.1] },
        { id: 'hero-sculpt', label: 'Ceramic form', geometry: 'sculpture', material: 'ceramic', translation: [0, 1.35, 0], scale: [0.65, 0.65, 0.65] },
        { id: 'brass-halo', label: 'Brass halo', geometry: 'halo', material: 'brass', translation: [0, 1.35, 0], rotation: [0.35, 0.25, 0, 0.9], scale: [0.92, 0.92, 0.92] },
      ],
      camera: { eye: [3.8, 2.5, 4.2], target: [0, 1.15, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 120 },
      environment: { setup: 'studio', lightDirection: [-2.8, 4.8, 3.4], keyIntensity: 1.8, viewTransform: 'agx' },
      effects: { exposure: 1.0, bloom: { strength: 0.08, threshold: 1.1, radius: 0.8 } },
    };
  }
  if (templateName === 'courtyard') {
    return {
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [
        { id: 'ground-box', type: 'box', bevel: 0 },
        { id: 'arch-box', type: 'box', bevel: 0.03 },
        { id: 'dome', type: 'sphere', segments: 36, rings: 20 },
      ],
      materials: [
        { id: 'travertine', tag: 'surface', color: [0.62, 0.56, 0.46], roughness: 0.72, metallic: 0 },
        { id: 'plaster', tag: 'surface', color: [0.76, 0.7, 0.6], roughness: 0.82, metallic: 0 },
        { id: 'terracotta', tag: 'surface', color: [0.64, 0.24, 0.14], roughness: 0.64, metallic: 0 },
        { id: 'copper', tag: 'surface', color: [0.22, 0.46, 0.4], roughness: 0.34, metallic: 0.72 },
      ],
      nodes: [
        { id: 'courtyard-floor', label: 'Courtyard floor', geometry: 'ground-box', material: 'travertine', translation: [0, -0.1, 0], scale: [14, 0.2, 14] },
        { id: 'tower-base', label: 'Main block', geometry: 'arch-box', material: 'plaster', translation: [-0.8, 1.1, -0.4], scale: [1.8, 2.2, 1.8] },
        { id: 'side-wing', label: 'Terracotta wing', geometry: 'arch-box', material: 'terracotta', translation: [1.3, 0.65, 0.5], scale: [1.4, 1.3, 1.4] },
        { id: 'copper-dome', label: 'Copper dome', geometry: 'dome', material: 'copper', translation: [-0.8, 2.2, -0.4], scale: [0.72, 0.72, 0.72] },
      ],
      camera: { eye: [6.4, 4.2, 6.8], target: [0.1, 1.0, 0], up: [0, 1, 0], fov: 42, near: 0.1, far: 160 },
      environment: { setup: 'daylight', lightDirection: [-4.5, 5.8, 3.2], keyIntensity: 2.0, viewTransform: 'agx' },
      effects: { exposure: 0.95, bloom: { strength: 0.06, threshold: 1.2, radius: 0.8 } },
    };
  }
  if (templateName === 'empty') {
    return {
      format: 'crucible.scene',
      schemaVersion: 1,
      geometries: [
        { id: 'floor', type: 'box', bevel: 0 },
        { id: 'starter-box', type: 'box', bevel: 0.04 },
      ],
      materials: [
        { id: 'floor-mat', tag: 'surface', color: [0.11, 0.13, 0.15], roughness: 0.88, metallic: 0.04 },
        { id: 'clay', tag: 'surface', color: [0.68, 0.44, 0.34], roughness: 0.6, metallic: 0.02 },
      ],
      nodes: [
        { id: 'stage-floor', label: 'Stage floor', geometry: 'floor', material: 'floor-mat', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
        { id: 'cube', label: 'Cube', geometry: 'starter-box', material: 'clay', translation: [0, 0.5, 0] },
      ],
      camera: { eye: [3.8, 2.5, 4.2], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 120 },
      environment: { setup: 'studio', lightDirection: [-3, 5, 3.5], keyIntensity: 1.7, viewTransform: 'agx' },
      effects: { exposure: 0.98, bloom: { strength: 0.06, threshold: 1.1, radius: 0.8 } },
    };
  }
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'plinth', type: 'cone', radiusTop: 1.2, radiusBottom: 1.35, segments: 48 },
      { id: 'ring', type: 'torus', tubeRadius: 0.14, segments: 64, sides: 28 },
      { id: 'core', type: 'sphere', segments: 48, rings: 24 },
      { id: 'beacon', type: 'box', bevel: 0.05 },
    ],
    materials: [
      { id: 'slate', tag: 'surface', color: [0.07, 0.08, 0.1], roughness: 0.85, metallic: 0.05 },
      { id: 'stone', tag: 'surface', color: [0.26, 0.27, 0.29], roughness: 0.48, metallic: 0.02 },
      { id: 'brass', tag: 'surface', color: [0.72, 0.42, 0.07], roughness: 0.24, metallic: 0.92 },
      { id: 'teal-glow', tag: 'surface', color: [0.04, 0.48, 0.42], roughness: 0.28, metallic: 0.1, emission: 1.35, emissiveColor: [0.08, 0.72, 0.62] },
      { id: 'coral', tag: 'surface', color: [0.64, 0.08, 0.06], roughness: 0.34, metallic: 0.08 },
    ],
    nodes: [
      { id: 'stage-floor', label: 'Stage floor', geometry: 'floor', material: 'slate', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      { id: 'plinth-base', label: 'Plinth', geometry: 'plinth', material: 'stone', translation: [0, 0.275, 0], scale: [1, 0.55, 1] },
      { id: 'gyro-ring', label: 'Gyro ring', geometry: 'ring', material: 'brass', translation: [0, 1.45, 0], rotation: [0.28, 0.34, 0, 0.9], scale: [0.95, 0.95, 0.95] },
      { id: 'energy-core', label: 'Energy core', geometry: 'core', material: 'teal-glow', translation: [0, 1.45, 0], scale: [0.48, 0.48, 0.48] },
      { id: 'side-beacon', label: 'Side beacon', geometry: 'beacon', material: 'coral', translation: [1.9, 0.45, -0.8], scale: [0.42, 0.9, 0.42] },
    ],
    camera: { eye: [4.2, 2.9, 4.9], target: [0, 1.15, 0], up: [0, 1, 0], fov: 42, near: 0.1, far: 120 },
    environment: { setup: 'studio', lightDirection: [-3.2, 5.2, 3.8], keyIntensity: 1.65, viewTransform: 'agx' },
    effects: { exposure: 0.96, bloom: { strength: 0.12, threshold: 1.05, radius: 0.9 } },
    motion: {
      duration: 4,
      loop: true,
      tracks: [
        {
          kind: 'node',
          id: 'gyro-ring',
          property: 'rotation',
          keyframes: [
            { time: 0, value: [0.28, 0.34, 0, 0.9] },
            { time: 2, value: [-0.28, 0.72, 0.2, 0.6] },
            { time: 4, value: [0.28, 0.34, 0, 0.9] },
          ],
        },
      ],
    },
    timeline: {
      shots: [
        { name: 'Hero', duration: 2, motionStart: 0, camera: { eye: [4.2, 2.9, 4.9], target: [0, 1.15, 0], up: [0, 1, 0], fov: 42 } },
        { name: 'Detail', duration: 2, motionStart: 0, camera: { eye: [1.9, 1.85, 2.35], target: [0, 1.45, 0], up: [0, 1, 0], fov: 36 } },
        { name: 'Top', duration: 2, motionStart: 0, camera: { eye: [0.05, 6.8, 0.25], target: [0, 0.6, 0], up: [0, 1, 0], fov: 45 } },
      ],
    },
  };
}
