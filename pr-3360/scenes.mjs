// Scenes of #3340: one tilted glass cube, two overlapping glass cubes, a cube inside a larger cube, over a checker floor.
const quaternion = (axis, degrees) => { const h = degrees * Math.PI / 360; return [axis[0] * Math.sin(h), axis[1] * Math.sin(h), axis[2] * Math.sin(h), Math.cos(h)]; };
const multiply = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const tilt = (yaw, pitch) => multiply(quaternion([0, 1, 0], yaw), quaternion([1, 0, 0], pitch));
export const camera = { eye: [0, 1.7, 8.5], target: [0, 0.8, 0], fov: 30 };
export const size = { width: 640, height: 640 };
export const scenes = {
  single: { cubes: [{ id: 'cube', translation: [0, 0.75, 0], scale: 1.2, rotation: tilt(35, 20) }] },
  overlap: { cubes: [
    { id: 'near', translation: [-0.3, 0.95, 0], scale: 1.6, rotation: tilt(18, 10) },
    { id: 'far', translation: [0.3, 0.8, 0.05], scale: 0.9, rotation: tilt(-14, 8) }] },
  nested: { cubes: [
    { id: 'outer', translation: [0, 0.95, 0], scale: 1.8, rotation: tilt(18, 10) },
    { id: 'inner', translation: [0.1, 0.95, 0.1], scale: 0.7, rotation: tilt(5, 25), inside: true }] },
};
// Footprint = the cubes that are not inside another one.
export const footprintCubes = name => scenes[name].cubes.filter(cube => !cube.inside);
export function buildRecipe(name) {
  const materials = [{ id: 'light', color: [0.88, 0.88, 0.86], roughness: 0.9 }, { id: 'dark', color: [0.12, 0.2, 0.55], roughness: 0.9 }];
  const nodes = [{ id: 'floor', geometry: 'box', material: 'light', translation: [0, -0.1, 0], scale: [14, 0.2, 10] }];
  const tile = 0.5;
  for (let row = -10; row < 10; row++) for (let column = -14; column < 14; column++) {
    if ((row + column) % 2 === 0) continue;
    nodes.push({ id: `tile${row + 10}-${column + 14}`, geometry: 'box', material: 'dark', translation: [(column + 0.5) * tile, 0.001, (row + 0.5) * tile], scale: [tile, 0.004, tile] });
  }
  for (const cube of scenes[name].cubes) {
    materials.push({ id: `glass-${cube.id}`, color: [1, 1, 1], roughness: 0.02, metallic: 0, transmission: 1, ior: 1.5, thickness: cube.scale, attenuationColor: [1, 1, 1], attenuationDistance: 100 });
    nodes.push({ id: cube.id, geometry: 'box', material: `glass-${cube.id}`, translation: cube.translation, scale: [cube.scale, cube.scale, cube.scale], rotation: cube.rotation });
  }
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials, nodes, camera, environment: { world: true, hdri: 'studio-softbox', environmentIntensity: 0.6 } };
}
