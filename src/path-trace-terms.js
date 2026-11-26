import { createEnvironmentMap } from './environment.js';
import { agentEnvironmentMap } from './agent-look.js';

// The environment a path trace reads from a recipe's environment fields (issue #1833). The tracer lights with the environment
// map, so the rasterizer's ambient term has to arrive as map strength:
//   ambientIntensity multiplies the map, like the rasterizer, which scales its environment light by it. In Cycles this is the
//     World Background strength.
// What stays out, and why (the render report names the ones a recipe sets, see describeIgnoredFeatures):
//   fillIntensity: two fixed, unshadowed directional lights with hand-picked colours; nothing in a Cycles scene matches them.
//   daylight, skyTop, skyBottom: measured to change nothing in the rasterizer while an environment map lights the scene, which
//     every recipe has, so the trace already agrees.
//   world: true: the rasterizer's outdoor haze shading; the tracer draws the map behind the picture. world: false draws the flat background there instead (#2016).

const scaledMaps = new WeakMap();

/** The map at `ambientIntensity` times its own strength; the same object returns while the map and the factor hold. */
function mapScaledByAmbient(map, ambientIntensity) {
  let byFactor = scaledMaps.get(map);
  if (!byFactor) {
    byFactor = new Map();
    scaledMaps.set(map, byFactor);
  }
  if (!byFactor.has(ambientIntensity)) {
    byFactor.set(ambientIntensity, createEnvironmentMap({ ...map, intensity: map.intensity * ambientIntensity }));
  }
  return byFactor.get(ambientIntensity);
}

/**
 * The recipe environment with the map a path trace lights with. A camera ray keeps seeing the sky at the map's own strength
 * (`cameraIntensity`, read by the native kernel) so that turning the ambient light down does not blacken the view.
 */
export function pathTraceEnvironment(environment) {
  const map = agentEnvironmentMap(environment, { withReflection: false });
  const ambientIntensity = environment.ambientIntensity ?? 1;
  if (ambientIntensity === 1) return { ...environment, map };
  return {
    ...environment,
    map: mapScaledByAmbient(map, ambientIntensity),
    cameraIntensity: environment.cameraIntensity ?? map.intensity,
  };
}
