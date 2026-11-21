import { mat4 } from 'gl-matrix';
import { lathe, curve, tube } from '../modeling.js';
import { sphere } from '../geometry.js';
import { smoothProfile, createPartList, finishScene, effects } from './kit.js';

/** Candidate B: a porcelain teapot. A lathed body and lid, a tapered swept spout, a swept handle, a turned tray. */
const LIFT = 0.22;

export function createScene() {
  const { parts, add } = createPartList();
  const porcelain = { tag: 'ceramic', color: [0.72, 0.8, 0.78], metallic: 0.02, roughness: 0.18 };
  const glaze = { tag: 'ceramic', color: [0.1, 0.27, 0.32], metallic: 0.04, roughness: 0.2 };
  const brass = { tag: 'metal', color: [0.5, 0.3, 0.1], metallic: 0.92, roughness: 0.28 };
  const tray = { tag: 'metal', color: [0.3, 0.37, 0.4], metallic: 0.95, roughness: 0.25 };
  const body = lathe(smoothProfile([[0, 0.5], [0.52, 0.5], [0.66, 0.54], [0.92, 0.78], [1.12, 1.15], [1.16, 1.5], [1.04, 1.9], [0.84, 2.18], [0.7, 2.28], [0.64, 2.34], [0.66, 2.4], [0.58, 2.42], [0.56, 2.34], [0.52, 2.3], [0, 2.3]], 6), { segments: 128 });
  const band = lathe(smoothProfile([[1.14, 1.3], [1.18, 1.34], [1.18, 1.46], [1.14, 1.5], [1.1, 1.46], [1.1, 1.34], [1.14, 1.3]], 3), { segments: 128 });
  const lid = lathe(smoothProfile([[0, 2.4], [0.5, 2.4], [0.55, 2.44], [0.5, 2.5], [0.36, 2.66], [0.22, 2.74], [0.1, 2.76], [0.08, 2.82], [0.14, 2.86], [0.16, 2.94], [0.1, 3.0], [0, 3.02]], 6), { segments: 96 });
  const saucer = lathe(smoothProfile([[0, 0.1], [1.9, 0.1], [2.2, 0.14], [2.5, 0.22], [2.58, 0.32], [2.52, 0.34], [2.4, 0.28], [2.1, 0.24], [1.7, 0.22], [0, 0.22]], 6), { segments: 160 });
  const pedestal = lathe(smoothProfile([[0, 0], [1.4, 0], [1.5, 0.04], [1.46, 0.1], [1.3, 0.5], [0, 0.5]], 5), { segments: 128 });
  const spout = curve([[0.7, 0.95, 0], [1.5, 1.05, 0], [1.9, 1.5, 0], [2.2, 2.05, 0], [2.52, 2.32, 0]], { radius: 0.3, taper: [1, 0.78, 0.5, 0.36, 0.3], resolution: 56, radialSegments: 24 });
  const handle = curve([[-1.08, 2.0, 0], [-1.7, 2.2, 0], [-2.1, 1.7, 0], [-1.9, 1.1, 0], [-1.12, 0.92, 0]], { radius: 0.12, taper: [0.85, 1, 1.12, 1, 0.85], resolution: 56, radialSegments: 18 });
  const brassWire = tube([[-1.1, 2.0, 0], [-1.72, 2.22, 0], [-2.16, 1.7, 0], [-1.94, 1.08, 0], [-1.1, 0.9, 0]], { radius: 0.03, segments: 64, radialSegments: 10 });
  add('Turned tray pedestal', pedestal, tray);
  add('Spun saucer tray', saucer, porcelain, [0, 0.5, 0]);
  add('Lathed teapot body', body, porcelain, [0, LIFT, 0]);
  add('Glaze band', band, glaze, [0, LIFT, 0]);
  add('Swept spout', spout, porcelain, [0, LIFT, 0]);
  add('Swept handle', handle, porcelain, [0, LIFT, 0]);
  add('Handle brass inlay', brassWire, brass, [0, LIFT, 0], [1, 1, 1.0]);
  add('Turned lid', lid, porcelain, [0, LIFT, 0]);
  add('Brass finial', sphere(40, 24), brass, [0, LIFT + 3.04, 0], [0.12, 0.1, 0.12]);
  const animated = [];
  return finishScene({
    name: 'Porcelain teapot', rootName: 'Teapot', parts, animated, portraitScale: 1.6,
    rootMotion: (matrix, time) => mat4.rotateY(matrix, matrix, Math.sin(time * 0.3) * 0.6),
    sample: (time, aspect) => ({ eye: [4.4 * (aspect < 1 ? 1.5 : 1), 3.4, 8.6 * (aspect < 1 ? 1.5 : 1)], target: [0, 1.65, 0], fov: 32, time, effects }),
  });
}
