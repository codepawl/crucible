// The water volume test scene (#3280), shared by scripts/measure-water-volumes.mjs and the evidence stills. It runs in the browser page.
// Seen from above: a basin whose water level is 0, a second basin of raised ground whose water level is 2.5, and two patches of dry
// ground that lie below one or both water levels but outside both footprints.
import { CrucibleRenderer } from '../src/renderer.js';
import { box } from '../src/geometry.js';
import '../src/world-material-shader.js';

const SUN_DIRECTION = [-0.6, 1, 0];
const unitBox = box(0, 1);
const GROUND = { tag: 'surface', color: [0.35, 0.3, 0.22], metallic: 0, roughness: 0.9, emission: 0 };
const WATER = { tag: 'water', color: [0.02, 0.05, 0.08], metallic: 0, roughness: 0.1, emission: 0, opacity: 0.001, alphaMode: 'blend' };

function placed(name, center, size, material, castShadow) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: unitBox, matrix, material, ...(castShadow === undefined ? {} : { castShadow }) };
}

/** Where the picture is read: the bed of each basin and each dry patch (world x, y of the top face, z). */
export const SAMPLE_POINTS = {
  lowBasinBed: [-2, -2, 0],
  highBasinBed: [-2, 1.5, 10],
  dryBelowBothLevels: [12, -1, 0],
  dryBelowHighLevelOnly: [12, 1, 10],
};

/** The parts of the scene. `withWater` false leaves out both water sheets (the reference for "no water"). */
export function volumeParts(withWater = true) {
  const parts = [
    placed('low-basin-bed', [-2, -2.5, 0], [8, 1, 8], GROUND),
    placed('high-basin-bed', [-2, 1, 10], [8, 1, 8], GROUND),
    placed('dry-low', [12, -1.5, 0], [8, 1, 8], GROUND),
    placed('dry-high', [12, 0.5, 10], [8, 1, 8], GROUND),
  ];
  if (withWater) {
    parts.push(placed('low-water', [-2, -0.05, 0], [8, 0.1, 8], WATER, false));
    parts.push(placed('high-water', [-2, 2.45, 10], [8, 0.1, 8], WATER, false));
  }
  return parts;
}

const OVERHEAD = { eye: [4, 34, 5], target: [4, 0, 5], up: [0, 0, -1], fov: 40 };

function readBytes(renderer, canvas, worldPoint) {
  const matrix = renderer.viewProjection;
  const clip = [0, 1, 2, 3].map(row => matrix[row] * worldPoint[0] + matrix[4 + row] * worldPoint[1] + matrix[8 + row] * worldPoint[2] + matrix[12 + row]);
  const pixelX = Math.round((clip[0] / clip[3] * 0.5 + 0.5) * canvas.width);
  const pixelY = Math.round((clip[1] / clip[3] * 0.5 + 0.5) * canvas.height);
  const context = renderer.context;
  const bytes = new Uint8Array(4);
  context.readPixels(pixelX, pixelY, 1, 1, context.RGBA, context.UNSIGNED_BYTE, bytes);
  return [bytes[0], bytes[1], bytes[2]];
}

/** Draws the scene overhead into `canvas`; returns the 8-bit colour at each sample point and the picture as a PNG data URL. */
export function drawVolumeScene(canvas, withWater) {
  const renderer = new CrucibleRenderer(canvas, volumeParts(withWater), { hdr: false, depth: false, world: false, ground: false, pixelRatio: 1, samples: 1, environment: { lightDirection: SUN_DIRECTION, keyColor: [3, 3, 3] } });
  renderer.render({ ...OVERHEAD, time: 0, environment: { lightDirection: SUN_DIRECTION } });
  const samples = Object.fromEntries(Object.entries(SAMPLE_POINTS).map(([name, point]) => [name, readBytes(renderer, canvas, point)]));
  const picture = canvas.toDataURL('image/png');
  renderer.dispose?.();
  return { samples, picture, camera: OVERHEAD, sun: SUN_DIRECTION };
}
