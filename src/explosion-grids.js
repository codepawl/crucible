import { bakeGasSim, GAS_SIM_TEMPERATURE_UNIT } from './gas-sim.js';
import { encodeVolumeGrid, isVolumeGridRegistered, registerVolumeGrid } from './volume-grid.js';

// The gas-sim grids behind add-explosion (#1050). One blast is baked once at a fixed size and resolution, and the volume's own box scales it, so
// a grid depends only on the fuel and the seed. Its file names say so (`explosion-dry-7_0000.67vg`): a recipe that names them can be rebuilt
// in a fresh scene, a render job or another process, because the MCP server bakes the same bytes again from the name (readVolumeGridFile).

export const EXPLOSION_GRID_RESOLUTION = 32;
export const EXPLOSION_GRID_FRAMES = 72;
export const EXPLOSION_GRID_FPS = 24;
/** Side of the baked box in metres: the volume's `size` is this times the blast's scale. */
export const EXPLOSION_GRID_BOX = 8;
/** The `size` in metres of an add-explosion that plays the bake at its own speed and scale. */
export const EXPLOSION_REFERENCE_SIZE = 2.5;
export const EXPLOSION_EMPTY_GRID = 'explosion-empty.67vg';
/** The empty frame of a blast that carries velocity: every frame of a sequence has the same channels, so it needs its own. */
export const EXPLOSION_EMPTY_VELOCITY_GRID = 'explosion-empty-velocity.67vg';
/** Whether add-explosion blurs the fireball along its velocity when the operation does not say (see motionBlur in agent-explosion.js). */
export const EXPLOSION_MOTION_BLUR_DEFAULT = true;
export { GAS_SIM_TEMPERATURE_UNIT };

/**
 * Bump this whenever the output of gas-sim.js changes: the on-disk bake cache (explosion-bake-cache.js) is keyed by it, so a stale file would
 * otherwise be served for the new solver. tests/explosion-bake-cache.test.js fails when the solver's output and this number disagree.
 */
export const EXPLOSION_BAKE_VERSION = 1;

const MAX_CACHED_BAKES = 4;
const BAKE_SECONDS_LIMIT = 90;
// A bake with velocity (for the motion blur of the fireball) says so in its name: `explosion-dry-7-velocity_0000.67vg`.
const NAME_PATTERN = /^explosion-(dry|oily)-(\d{1,10})(-velocity)?_(\d{4})\.67vg$/;
/** Noise upres strength baked into explosion smoke density so 32-cubed grids break into finer puffs across Glaze, Cook, and Cycles (#1735). */
export const EXPLOSION_GRID_DETAIL = 0.75;

// Oily fuel burns sootier: more smoke at the core and more smoke from every burned unit of fuel.
const FUEL_OPTIONS = Object.freeze({
  dry: Object.freeze({ turbulence: 1, vorticity: 40, detail: EXPLOSION_GRID_DETAIL }),
  oily: Object.freeze({ burstSmoke: 1.6, smokeYield: 1.1, turbulence: 1, vorticity: 40, detail: EXPLOSION_GRID_DETAIL }),
});

const bakes = new Map();
let bakeStore = null;

/** Installs a store with `load(descriptor)` and `save(descriptor, frames)` that keeps bakes across processes (the MCP server installs a disk cache); null removes it. */
export function setExplosionBakeStore(store) {
  bakeStore = store;
}
const emptyFrames = new Map();

function gridSize() {
  return [EXPLOSION_GRID_BOX, EXPLOSION_GRID_BOX, EXPLOSION_GRID_BOX];
}

function bakeLabel(fuel, seed, velocity) {
  return `explosion-${fuel}-${seed}${velocity ? '-velocity' : ''}`;
}

/** The names of the frames of one bake, in playing order; with `velocity` the bake carries the velocity channels. */
export function explosionGridNames(fuel, seed, velocity = false) {
  return Array.from({ length: EXPLOSION_GRID_FRAMES }, (_, index) => `${bakeLabel(fuel, seed, velocity)}_${String(index).padStart(4, '0')}.67vg`);
}

function simulateFrames(fuel, seed, velocity) {
  const baked = bakeGasSim({
    resolution: EXPLOSION_GRID_RESOLUTION,
    cellSize: EXPLOSION_GRID_BOX / EXPLOSION_GRID_RESOLUTION,
    frames: EXPLOSION_GRID_FRAMES,
    fps: EXPLOSION_GRID_FPS,
    seed,
    maxSeconds: BAKE_SECONDS_LIMIT,
    velocity,
    ...FUEL_OPTIONS[fuel],
  });
  return baked.frames.map(frame => encodeVolumeGrid({ resolution: baked.resolution, channels: frame, size: gridSize() }));
}

function bakeFrames(fuel, seed, velocity) {
  const key = bakeLabel(fuel, seed, velocity);
  const cached = bakes.get(key);
  if (cached) return cached;
  const descriptor = {
    version: EXPLOSION_BAKE_VERSION,
    fuel,
    seed,
    velocity,
    frames: EXPLOSION_GRID_FRAMES,
    parameters: [EXPLOSION_GRID_RESOLUTION, EXPLOSION_GRID_BOX, EXPLOSION_GRID_FRAMES, EXPLOSION_GRID_FPS, FUEL_OPTIONS[fuel]],
  };
  let frames = bakeStore?.load(descriptor) ?? null;
  if (!frames) {
    frames = simulateFrames(fuel, seed, velocity);
    bakeStore?.save(descriptor, frames);
  }
  bakes.set(key, frames);
  if (bakes.size > MAX_CACHED_BAKES) bakes.delete(bakes.keys().next().value);
  return frames;
}

function emptyFrame(velocity) {
  if (!emptyFrames.has(velocity)) {
    const axis = EXPLOSION_GRID_RESOLUTION;
    const cells = axis * axis * axis;
    const channels = { density: new Float32Array(cells), temperature: new Float32Array(cells), flame: new Float32Array(cells) };
    if (velocity) Object.assign(channels, { velocityX: new Float32Array(cells), velocityY: new Float32Array(cells), velocityZ: new Float32Array(cells) });
    emptyFrames.set(velocity, encodeVolumeGrid({ resolution: [axis, axis, axis], channels, size: gridSize() }));
  }
  return emptyFrames.get(velocity);
}

/** The name of the empty frame that goes with a bake: the one with velocity channels when the bake has them. */
export function explosionEmptyGridName(velocity) {
  return velocity ? EXPLOSION_EMPTY_VELOCITY_GRID : EXPLOSION_EMPTY_GRID;
}

/**
 * The grid file names an add-explosion operation will name, for a caller that must send the files before the operation runs (the MCP server
 * sends them to the preview page), or null when the operation's fuel or seed is not valid: the operation itself then fails with its own error.
 */
export function explosionGridNamesFor(operation) {
  const fuel = operation.fuel ?? 'dry';
  const seed = operation.seed ?? 1;
  if (!Object.hasOwn(FUEL_OPTIONS, fuel) || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) return null;
  const velocity = (operation.motionBlur ?? EXPLOSION_MOTION_BLUR_DEFAULT) === true;
  return [...explosionGridNames(fuel, seed, velocity), explosionEmptyGridName(velocity)];
}

/**
 * The length in bytes of an explosion grid file by name, or null when the name is not one add-explosion writes. Nothing is baked: every frame of
 * a bake has the channels of the empty frame at the same resolution, so the empty frame's length is the length of each of them (#1903).
 */
export function explosionGridByteLength(name) {
  if (name === EXPLOSION_EMPTY_GRID) return emptyFrame(false).length;
  if (name === EXPLOSION_EMPTY_VELOCITY_GRID) return emptyFrame(true).length;
  const match = typeof name === 'string' ? NAME_PATTERN.exec(name) : null;
  if (!match || Number(match[2]) > 4294967295 || Number(match[4]) >= EXPLOSION_GRID_FRAMES) return null;
  return emptyFrame(Boolean(match[3])).length;
}

/** The bytes of an explosion grid file by name, baked on first use, or null when the name is not one add-explosion writes. */
export function explosionGridBytes(name) {
  if (name === EXPLOSION_EMPTY_GRID) return emptyFrame(false);
  if (name === EXPLOSION_EMPTY_VELOCITY_GRID) return emptyFrame(true);
  const match = typeof name === 'string' ? NAME_PATTERN.exec(name) : null;
  if (!match) return null;
  const seed = Number(match[2]);
  const index = Number(match[4]);
  if (seed > 4294967295 || index >= EXPLOSION_GRID_FRAMES) return null;
  return bakeFrames(match[1], seed, Boolean(match[3]))[index];
}

/**
 * Bakes the blast of `fuel` and `seed` and registers its frames and the empty frame, so a grid volume that lists them draws in this process.
 * Returns the frame names. Same fuel and seed give the same bytes.
 */
export function registerExplosionGrids(fuel, seed, velocity = false) {
  if (!Object.hasOwn(FUEL_OPTIONS, fuel)) {
    throw new RangeError(`registerExplosionGrids: fuel is ${JSON.stringify(fuel)}; use one of ${Object.keys(FUEL_OPTIONS).join(', ')}`);
  }
  const names = explosionGridNames(fuel, seed, velocity);
  const emptyName = explosionEmptyGridName(velocity);
  // The MCP server sends these grids with the call (explosionGridNamesFor), so the preview page has them already and bakes nothing.
  if (isVolumeGridRegistered(names[0]) && isVolumeGridRegistered(names.at(-1)) && isVolumeGridRegistered(emptyName)) return names;
  const frames = bakeFrames(fuel, seed, velocity);
  names.forEach((name, index) => registerVolumeGrid(name, frames[index]));
  registerVolumeGrid(emptyName, emptyFrame(velocity));
  return names;
}
