// Sea recipe for the #2823 stride clip: the ocean edit on a plane sheet with the water tag, spray emitter, oceanTime track.
export function seaRecipe({ subdivideLevels, camera, duration = 4.5 }) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'plane', segments: 64 }, edits: [
        { op: 'transform_selection', select: { all: true }, scale: [140, 140, 1], rotation: { axis: [1, 0, 0], angle: -Math.PI / 2 } },
        { op: 'subdivide', levels: subdivideLevels },
      ], stack: [{ op: 'ocean', windSpeed: 8, choppiness: 1.2, size: 40, seed: 11, resolution: 6, spray: true }] },
      { id: 'drop', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'water', color: [0.02, 0.14, 0.24], tag: 'water' }, { id: 'foam', color: [0.95, 0.97, 1], roughness: 0.6 }],
    nodes: [{ id: 'sea', geometry: 'sea', material: 'water' }, ...[1, 2].map(index => ({ id: `droplet${index}`, geometry: 'drop', material: 'foam' }))],
    particles: { gravity: [0, -9.81, 0], systems: [1, 2].map(index => ({
      node: `droplet${index}`, seed: 9 * index, count: 2000, rate: 450, lifetime: [0.6, 1.4], size: [0.5, 1], scale: 'shrink', speed: [0.3, 1.5], spread: 50, drag: 0.4,
      emitter: { shape: 'mesh', mesh: 'sea', from: 'vertices', group: 'spray', groupThreshold: 0.25, velocityFrom: 'spray', velocityScale: 1.2 },
    })) },
    ...(camera ? { camera } : {}),
    motion: { duration, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: duration, value: duration }] }] },
  };
}
