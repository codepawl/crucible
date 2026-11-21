import { mat4 } from 'gl-matrix';
import { lathe, extrude } from '../modeling.js';
import { box, sphere } from '../geometry.js';
import { smoothProfile, createPartList, finishScene, effects } from './kit.js';

const FOOT = [[0, 0], [0.5, 0], [0.54, 0.03], [0.54, 0.09], [0.48, 0.14], [0.4, 0.17], [0.3, 0.22]];
const PROFILES = {
  pawn: [...FOOT, [0.2, 0.34], [0.16, 0.5], [0.17, 0.56], [0.26, 0.6], [0.27, 0.64], [0.17, 0.68], [0.2, 0.8], [0.26, 0.92], [0.26, 1.02], [0.2, 1.12], [0.1, 1.16], [0, 1.17]],
  bishop: [...FOOT, [0.22, 0.38], [0.16, 0.7], [0.15, 0.95], [0.27, 1.02], [0.28, 1.08], [0.18, 1.12], [0.2, 1.28], [0.3, 1.5], [0.29, 1.66], [0.2, 1.84], [0.08, 1.92], [0.1, 1.96], [0.06, 2.0], [0, 2.0]],
  queen: [...FOOT, [0.26, 0.45], [0.19, 0.85], [0.18, 1.1], [0.3, 1.18], [0.32, 1.25], [0.2, 1.3], [0.22, 1.5], [0.34, 1.78], [0.4, 2.02], [0.34, 2.08], [0.22, 2.1], [0.14, 2.16], [0.1, 2.24], [0.14, 2.3], [0.06, 2.36], [0, 2.36]],
  king: [...FOOT, [0.27, 0.45], [0.2, 0.9], [0.19, 1.15], [0.32, 1.24], [0.34, 1.3], [0.22, 1.35], [0.24, 1.55], [0.34, 1.85], [0.38, 2.05], [0.3, 2.14], [0.18, 2.18], [0.2, 2.22], [0.1, 2.26], [0, 2.26]],
  rook: [...FOOT, [0.34, 0.3], [0.28, 0.5], [0.24, 0.8], [0.26, 1.1], [0.34, 1.16], [0.36, 1.2], [0.36, 1.32], [0.3, 1.32], [0.3, 1.38], [0, 1.38]],
};
const TOP_HEIGHT = { king: 2.26, queen: 2.36, bishop: 2.0, rook: 1.38, pawn: 1.17 };
const BOARD_TOP = 0.12;

/** One battlement block: an annular sector contour, extruded upward by the part rotation. */
function merlonGeometry(startAngle) {
  const points = [];
  for (let step = 0; step <= 10; step++) {
    const angle = startAngle + step / 10 * 1.0;
    points.push([Math.cos(angle) * 0.375, Math.sin(angle) * 0.375]);
  }
  for (let step = 10; step >= 0; step--) {
    const angle = startAngle + step / 10 * 1.0;
    points.push([Math.cos(angle) * 0.29, Math.sin(angle) * 0.29]);
  }
  return extrude(points, { depth: 0.15, bevel: 0.012, bevelSegments: 2 });
}

function crossGeometry() {
  const arm = 0.04;
  const length = 0.19;
  const outline = [[-arm, -length], [arm, -length], [arm, -arm * 1.6], [length * 0.8, -arm * 1.6], [length * 0.8, arm * 1.2], [arm, arm * 1.2], [arm, length], [-arm, length], [-arm, arm * 1.2], [-length * 0.8, arm * 1.2], [-length * 0.8, -arm * 1.6], [-arm, -arm * 1.6]];
  return extrude(outline, { depth: 0.07, bevel: 0.012, bevelSegments: 2 });
}

/** Candidate A: a turned chess set. Five lathe profiles, extruded battlements and a cross, a bevelled board. */
export function createScene() {
  const { parts, add } = createPartList();
  const ivory = { tag: 'ceramic', color: [0.78, 0.72, 0.6], metallic: 0.02, roughness: 0.32 };
  const ebony = { tag: 'ceramic', color: [0.07, 0.045, 0.035], metallic: 0.05, roughness: 0.22 };
  const brass = { tag: 'metal', color: [0.5, 0.3, 0.1], metallic: 0.92, roughness: 0.3 };
  const oakLight = { tag: 'wood', color: [0.55, 0.36, 0.19], metallic: 0, roughness: 0.5 };
  const oakDark = { tag: 'wood', color: [0.17, 0.09, 0.05], metallic: 0, roughness: 0.5 };
  const lathed = Object.fromEntries(Object.entries(PROFILES).map(([name, profile]) => [name, lathe(smoothProfile(profile, 5), { segments: 96 })]));
  const collar = lathe(smoothProfile([[0.2, 0], [0.26, 0.02], [0.28, 0.05], [0.26, 0.08], [0.2, 0.09], [0.2, 0]], 4), { segments: 96 });
  const tile = box(0.012, 3);
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      add(`Board square ${row}-${column}`, tile, (row + column) % 2 ? oakDark : oakLight, [(column - 2.5) * 1.1, 0.06, (row - 2.5) * 0.68 - 0.1], [1.1, 0.12, 0.68]);
    }
  }
  add('Board frame', box(0.02, 3), brass, [0, 0.015, -0.1], [7.1, 0.03, 4.6]);
  const placements = [['king', ivory, -2.2, 0.2, 'Ivory king'], ['queen', ebony, 2.2, 0.2, 'Ebony queen'], ['bishop', ivory, -1.1, -0.9, 'Ivory bishop'], ['rook', ebony, 1.1, -0.9, 'Ebony rook'], ['pawn', ivory, 0, 0.8, 'Ivory pawn'], ['pawn', ebony, -3.3, -0.9, 'Ebony pawn']];
  for (const [piece, material, x, z, name] of placements) {
    const part = add(name, lathed[piece], material, [x, BOARD_TOP, z]);
    if (piece === 'king') {
      add('King cross', crossGeometry(), brass, [x, BOARD_TOP + TOP_HEIGHT.king + 0.02, z], [1, 1, 1], [-90, 0, 0]);
    }
    if (piece === 'queen') add('Queen orb', sphere(32, 20), brass, [x, BOARD_TOP + 2.42, z], [0.08, 0.08, 0.08]);
    if (piece === 'queen') add('Queen collar', collar, brass, [x, BOARD_TOP + 2.02, z], [1.15, 1, 1.15]);
    if (piece === 'bishop') add('Bishop collar', collar, brass, [x, BOARD_TOP + 1.0, z], [0.75, 1, 0.75]);
    if (piece === 'rook') {
      for (let index = 0; index < 4; index++) add(`Rook merlon ${index}`, merlonGeometry(index * Math.PI / 2 + 0.3), material, [x, BOARD_TOP + 1.38, z], [1, 1, 1], [-90, 0, 0]);
    }
  }
  return finishScene({
    name: 'Turned chess set', rootName: 'Chess set', parts, portraitScale: 1.55,
    rootMotion: (matrix, time) => mat4.rotateY(matrix, matrix, time * 0.2),
    sample: (time, aspect) => ({ eye: [4.2 * (aspect < 1 ? 1.5 : 1), 4.4, 7.9 * (aspect < 1 ? 1.5 : 1)], target: [0, 1.05, -0.1], fov: 32, time, effects }),
  });
}
