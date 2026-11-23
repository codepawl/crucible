
// The studio's sample model: a laboratory student microscope, fourteen separate parts, CC BY 4.0 (credit in THIRD-PARTY-NOTICES.md).
// public/sample-model.glb keeps its parts as separate glTF nodes, so each one can lift off in the exploded view.
// `assembleSampleModel` gives every part its layer, section and explode offset.

const SAMPLE_SCALE = 8;

// Offsets are world-space translations in model units after SAMPLE_SCALE (the microscope stands 3.7 tall and rests on y = 0, its front toward +z).
// The exploded view keeps the base on the floor and lifts the arm just clear of it. The head cap and the eyepiece tube stack above the arm,
// the focus knobs stand either side of it with the rack post behind, the condenser and the stage come forward in two layers, and the stage
// clips, the nosepiece and the three objectives fan out to the right, the objectives in a row under the nosepiece. No two parts share a box.
const SAMPLE_PARTS = Object.freeze({
  base: { label: 'Base', layer: 'exterior', section: 'Stand', offset: [0, 0, 0] },
  arm: { label: 'Arm and head', layer: 'exterior', section: 'Stand', offset: [0, 0.6, 0] },
  condenser: { label: 'Condenser', layer: 'interior', section: 'Illumination', offset: [0, 0, 1.6] },
  rack_post: { label: 'Rack post', layer: 'exterior', section: 'Focus', offset: [0, 0.3, -1] },
  focus_knob_left: { label: 'Focus knob left', layer: 'exterior', section: 'Focus', offset: [-0.6, 0.1, 0] },
  focus_knob_right: { label: 'Focus knob right', layer: 'exterior', section: 'Focus', offset: [0.6, 0.1, 0] },
  stage: { label: 'Stage', layer: 'exterior', section: 'Stage', offset: [0, 0.75, 1.55] },
  stage_clips: { label: 'Stage clips', layer: 'exterior', section: 'Stage', offset: [1.2, 0.75, 1.55] },
  nosepiece: { label: 'Nosepiece', layer: 'interior', section: 'Optics', offset: [1.6, 1.2, 0.7] },
  objective_left: { label: 'Objective left', layer: 'interior', section: 'Optics', offset: [1.335, 0.6, 0.4] },
  objective_centre: { label: 'Objective centre', layer: 'interior', section: 'Optics', offset: [1.6, 0.6, 0.4] },
  objective_right: { label: 'Objective right', layer: 'interior', section: 'Optics', offset: [1.85, 0.6, 0.4] },
  head_cap: { label: 'Head cap', layer: 'exterior', section: 'Head', offset: [0, 1.1, 0] },
  eyepiece_tube: { label: 'Eyepiece tube', layer: 'exterior', section: 'Head', offset: [0, 1.5, 0] },
});

export const SAMPLE_PART_NAMES = Object.freeze(Object.values(SAMPLE_PARTS).map(entry => entry.label));

function scaledMatrix(matrix) {
  const scaled = new Float32Array(matrix);
  for (let index = 0; index < 15; index++) scaled[index] *= SAMPLE_SCALE;
  return scaled;
}

/**
 * Turns the parts parsed from public/sample-model.glb into explodable studio parts: a readable name, the matrix scaled
 * to studio size, and `assembly: { layer, section, offset }`. Throws for a part the table does not know.
 */
export function assembleSampleModel(parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw new TypeError('assembleSampleModel expects the parts array that loadGltf or parseGltf returns for sample-model.glb.');
  return parts.map(part => {
    const key = String(part.name);
    const entry = Object.hasOwn(SAMPLE_PARTS, key) ? SAMPLE_PARTS[key] : null;
    if (!entry) throw new Error(`Sample model part "${part.name}" has no assembly entry. Pass the parts of public/sample-model.glb, or add the part to SAMPLE_PARTS in src/model.js.`);
    return { ...part, name: entry.label, matrix: scaledMatrix(part.matrix), assembly: { layer: entry.layer, section: entry.section, offset: [...entry.offset] } };
  });
}

/** Loads sample-model.glb from a URL, File or Blob and returns its explodable parts. */
export async function loadSampleModel(source, options = {}) {
  if (source === undefined) throw new TypeError("loadSampleModel needs the model's URL, File or Blob, for example loadSampleModel('/sample-model.glb').");
  const { loadGltf } = await import('./gltf.js');
  const asset = await loadGltf(source, options);
  return assembleSampleModel(asset.parts);
}
