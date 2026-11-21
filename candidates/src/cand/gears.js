import { mat4 } from 'gl-matrix';
import { extrude } from '../modeling.js';
import { box, cylinder, torus } from '../geometry.js';
import { createPartList, finishScene, effects } from './kit.js';

const PITCH = 0.1;
const TURN = Math.PI * 2;

function circle(radius, count, centre = [0, 0]) {
  return Array.from({ length: count }, (_, index) => [centre[0] + Math.cos(index / count * TURN) * radius, centre[1] + Math.sin(index / count * TURN) * radius]);
}

/** A spur gear contour: trapezoid teeth with a root fillet, one tooth centred on angle 0. */
function gearContour(teeth) {
  const pitchRadius = teeth * PITCH / 2;
  const addendum = PITCH * 0.42;
  const dedendum = PITCH * 0.5;
  const step = TURN / teeth;
  const points = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const centre = tooth * step;
    for (const [offset, radius] of [[-0.46, pitchRadius - dedendum], [-0.3, pitchRadius - dedendum * 0.8], [-0.17, pitchRadius + addendum], [0.17, pitchRadius + addendum], [0.3, pitchRadius - dedendum * 0.8], [0.46, pitchRadius - dedendum]]) {
      points.push([Math.cos(centre + offset * step) * radius, Math.sin(centre + offset * step) * radius]);
    }
  }
  return points;
}

function gearGeometry(teeth, depth) {
  const pitchRadius = teeth * PITCH / 2;
  const lightening = Math.max(3, Math.round(teeth / 5));
  const holeRadius = pitchRadius * 0.2;
  const holes = [circle(0.13, 32)];
  if (teeth >= 16) {
    for (let index = 0; index < lightening; index++) {
      const angle = (index + 0.5) / lightening * TURN;
      holes.push(circle(holeRadius, 28, [Math.cos(angle) * pitchRadius * 0.58, Math.sin(angle) * pitchRadius * 0.58]));
    }
  }
  return extrude(gearContour(teeth), { holes, depth, bevel: 0.012, bevelSegments: 2 });
}

/** Phase that puts a gap of `driven` where a tooth of `driver` points at it. Angles are of the line from driver to driven. */
function meshPhase(driver, driven, direction) {
  const driverStep = TURN / driver.teeth;
  const drivenStep = TURN / driven.teeth;
  const fraction = (((direction - driver.phase) / driverStep) % 1 + 1) % 1;
  return direction + Math.PI - (fraction + 0.5) * drivenStep;
}

/** Candidate C: a brass gear train. Extruded toothed contours with lightening holes, meshed so the teeth interlock while turning. */
export function createScene() {
  const { parts, add } = createPartList();
  const brass = { tag: 'metal', color: [0.5, 0.3, 0.1], metallic: 0.92, roughness: 0.3 };
  const steel = { tag: 'metal', color: [0.33, 0.43, 0.45], metallic: 0.95, roughness: 0.22 };
  const copper = { tag: 'metal', color: [0.55, 0.22, 0.12], metallic: 0.9, roughness: 0.32 };
  const dark = { tag: 'metal', color: [0.03, 0.045, 0.05], metallic: 0.7, roughness: 0.4 };
  const centreB = [0, 1.5];
  const gears = [
    { name: 'Drive gear', teeth: 24, material: brass, centre: [-2.0, 1.5], layer: 0 },
    { name: 'Idler gear', teeth: 16, material: steel, centre: centreB, layer: 0 },
    { name: 'Compound gear', teeth: 32, material: copper, centre: [0, 0], layer: 0 },
    { name: 'Pinion', teeth: 12, material: steel, centre: [0, 0], layer: 1 },
    { name: 'Output gear', teeth: 30, material: brass, centre: [0, 0], layer: 1 },
  ];
  const compoundDirection = 35 / 180 * Math.PI;
  const compoundDistance = (16 + 32) * PITCH / 2;
  gears[2].centre = [centreB[0] + Math.cos(compoundDirection) * compoundDistance, centreB[1] + Math.sin(compoundDirection) * compoundDistance];
  gears[3].centre = gears[2].centre;
  const outputDirection = -28 / 180 * Math.PI;
  const outputDistance = (12 + 30) * PITCH / 2;
  gears[4].centre = [gears[3].centre[0] + Math.cos(outputDirection) * outputDistance, gears[3].centre[1] + Math.sin(outputDirection) * outputDistance];
  gears[0].phase = 0;
  gears[1].phase = meshPhase(gears[0], gears[1], 0);
  gears[2].phase = meshPhase(gears[1], gears[2], compoundDirection);
  gears[3].phase = gears[2].phase;
  gears[4].phase = meshPhase(gears[3], gears[4], outputDirection);
  const ratios = [1, -gears[0].teeth / gears[1].teeth, gears[0].teeth / gears[2].teeth, gears[0].teeth / gears[2].teeth, -gears[0].teeth / gears[4].teeth * gears[3].teeth / gears[2].teeth * -1];
  ratios[4] = -ratios[3] * gears[3].teeth / gears[4].teeth;
  const layerDepth = 0.28;
  const layerZ = [0.1, 0.1 + layerDepth + 0.04];
  const animated = [];
  for (const [index, gear] of gears.entries()) {
    const part = add(gear.name, gearGeometry(gear.teeth, layerDepth), gear.material, [gear.centre[0], gear.centre[1], layerZ[gear.layer]]);
    mat4.rotateZ(part.matrix, part.matrix, gear.phase);
    animated.push({ part, base: mat4.clone(part.matrix), apply: (matrix, time) => mat4.rotateZ(matrix, matrix, time * 0.35 * ratios[index]) });
    add(`${gear.name} axle`, cylinder(32, 0.1, 3), dark, [gear.centre[0], gear.centre[1], 0.3], [0.12, 0.9, 0.12], [90, 0, 0]);
    add(`${gear.name} cap`, cylinder(32, 0.2, 4), brass, [gear.centre[0], gear.centre[1], layerZ[gear.layer] + layerDepth + (gear.layer ? 0.1 : 0.06)], [0.2, 0.1, 0.2], [90, 0, 0]);
  }
  const bearing = torus(0.03, 48, 10);
  for (const gear of gears.slice(0, 3)) add(`${gear.name} bearing`, bearing, steel, [gear.centre[0], gear.centre[1], 0.0], [0.22, 0.22, 0.22]);
  add('Back plate', box(0.02, 4), dark, [1.0, 2.6, -0.12], [10.0, 5.2, 0.1]);
  for (const [x, y] of [[-3.7, 4.9], [5.7, 4.9], [-3.7, 0.3], [5.7, 0.3]]) add(`Plate screw ${x}/${y}`, cylinder(24, 0.2, 3), steel, [x, y, -0.02], [0.14, 0.1, 0.14], [90, 0, 0]);
  return finishScene({
    name: 'Brass gear train', rootName: 'Gear train', parts, animated, portraitScale: 1.9,
    sample: (time, aspect) => ({ eye: [3.4 * (aspect < 1 ? 1.5 : 1), 3.3, 13.4 * (aspect < 1 ? 1.5 : 1)], target: [1.0, 2.5, 0.2], fov: 32, time, effects }),
  });
}
