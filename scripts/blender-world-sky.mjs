// Carries a Blender demo scene's world across to its scene.json (#2761). scripts/blender-demo-to-glb.py bakes an analytic sky
// (Nishita) to sky.hdr next to the GLB and writes world.json with the scene's view transform and exposure. The HDRI keeps the
// sun at the strength the sky model gives it, and Crucible's HDRI sun split turns that into the shadowed key light, so no
// sun strength is converted by hand. Exposure: Blender's exposure is in stops on the scene-linear light before the view
// transform, Crucible's `exposure` multiplies the linear light before its tone map, so one is two to the power of the other.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VIEW_TRANSFORMS = ['Standard', 'Filmic', 'AgX', 'Khronos PBR Neutral', 'ACES', 'False Color', 'Raw'];

/** Crucible exposure for a Blender view transform and its exposure in stops. */
export function exposureFromStops(viewTransform, exposureStops) {
  if (typeof exposureStops !== 'number' || !Number.isFinite(exposureStops)) {
    throw new TypeError(`world.json exposureStops must be a finite number of stops, got ${JSON.stringify(exposureStops)}.`);
  }
  if (!VIEW_TRANSFORMS.includes(viewTransform)) {
    throw new RangeError(`world.json viewTransform "${viewTransform}" is not one Blender offers: ${VIEW_TRANSFORMS.join(', ')}.`);
  }
  return 2 ** exposureStops;
}

const MIN_SUN_ANGULAR_RADIUS = 0.0005;
const MAX_SUN_ANGULAR_RADIUS = 0.2;

/** The parsed world.json of a scene folder, or null when the export found no analytic sky. */
export function readBlenderWorld(folder) {
  const worldFile = join(folder, 'world.json');
  if (!existsSync(worldFile) || !existsSync(join(folder, 'sky.hdr'))) return null;
  return JSON.parse(readFileSync(worldFile, 'utf8'));
}

/** The half-angle of the sky's sun in radians (its size is a diameter), or undefined when the world has no usable sun disc size. */
export function sunAngularRadiusFromWorld(world) {
  if (!world || world.sky?.sunDisc === false) return undefined;
  const diameter = world.sky?.sunSizeRadians;
  if (typeof diameter !== 'number' || !Number.isFinite(diameter) || diameter <= 0) return undefined;
  const radius = diameter / 2;
  return radius >= MIN_SUN_ANGULAR_RADIUS && radius <= MAX_SUN_ANGULAR_RADIUS ? radius : undefined;
}

/**
 * The scene description with the world's exposure on the scene and on the frame. A scene with no world (null) comes back
 * as it is, still lit by whatever hdri it names; with a world, the hdri is the baked sky at intensity 1.
 */
export function applyBlenderWorld(description, world) {
  if (!world) return description;
  const exposure = exposureFromStops(world.viewTransform, world.exposureStops);
  const sunAngularRadius = sunAngularRadiusFromWorld(world);
  const renderer = description.renderer ?? {};
  return {
    ...description,
    ...(sunAngularRadius !== undefined ? { renderer: { ...renderer, environment: { sunAngularRadius, ...renderer.environment } } } : {}),
    hdri: 'sky.hdr',
    hdriOptions: { ...description.hdriOptions, intensity: 1 },
    exposure,
    frame: { ...description.frame, exposure },
  };
}
