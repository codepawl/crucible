import { assertEnvironmentMap, createEnvironmentMap } from './environment.js';
import { BUNDLED_ENVIRONMENT_NAMES, isEnvironmentReference } from './look-catalog.js';
import { createCatalogEnvironmentMap } from './lighting-setups.js';

// A scene that lights with one environment and shows another sky (#3396): the lighting map keeps the diffuse light, and a
// separate reflection map is what glass, water and every other specular term reflect. The renderer already prefilters the
// map's own pixels for reflection and reads the diffuse light from an `irradianceSource`, so the combined map is the reflection
// map's pixels with the lighting map as that source.
// Agent scenes load this file on demand, when a recipe names environment.reflectionHdri (agentSceneModule 'reflectionEnvironment').

const irradianceOnlyMaps = new WeakMap();
const combinedMaps = new WeakMap();

// The lighting map reduced to the pixels its diffuse light reads. One object for each pixel array, so the renderer's check
// for "the same irradiance source" holds while the lighting map only turns or dims.
function irradianceOnlyMap(lightingMap) {
  const source = lightingMap.irradianceSource ?? lightingMap;
  if (!irradianceOnlyMaps.has(source.data)) {
    irradianceOnlyMaps.set(source.data, createEnvironmentMap({ width: source.width, height: source.height, data: source.data }));
  }
  return irradianceOnlyMaps.get(source.data);
}

/**
 * The environment map that lights like `lightingMap` and reflects like `reflectionMap`.
 * Intensity, rotation, background settings and sun disc come from the lighting map, so the reflection turns and dims with the
 * scene; the reflection map's own values are not read. With `showBackground` the sky drawn is the reflection map's, since
 * the background samples the same prefiltered pixels as the reflections.
 * The same object returns for the same two maps, so the renderer prefilters once.
 */
export function withReflectionEnvironment(lightingMap, reflectionMap) {
  assertEnvironmentMap(lightingMap);
  if (reflectionMap?.kind !== 'environment-map') {
    throw new TypeError('The reflection environment must be a map made with createEnvironmentMap or loadHdri: pass the HDRI that glass and water should reflect.');
  }
  assertEnvironmentMap(reflectionMap);
  if (!combinedMaps.has(lightingMap)) combinedMaps.set(lightingMap, new WeakMap());
  const cache = combinedMaps.get(lightingMap);
  if (!cache.has(reflectionMap)) {
    const { width, height, channels, data } = reflectionMap;
    cache.set(reflectionMap, Object.freeze({ ...lightingMap, width, height, channels, data, irradianceSource: irradianceOnlyMap(lightingMap) }));
  }
  return cache.get(reflectionMap);
}

/** Validates environment.reflectionHdri: a shipped HDRI name or the 64-character ID of a .hdr file in the asset catalog. `fail(path, value, accepted)` builds the error. */
export function resolveReflectionHdri(reference, fail) {
  if (typeof reference !== 'string' || !isEnvironmentReference(reference)) {
    throw fail('environment.reflectionHdri', reference, `one of ${BUNDLED_ENVIRONMENT_NAMES.join(', ')} or the 64-character ID of a .hdr file in the asset catalog`);
  }
  return reference;
}

/** The lighting map of a normalized environment with its `reflectionHdri` as the specular light; it turns and dims with the scene. */
export function withReflectionHdri(lightingMap, environment) {
  const reflectionMap = createCatalogEnvironmentMap(environment.reflectionHdri, { intensity: environment.environmentIntensity, rotation: environment.environmentRotation, showBackground: environment.world });
  return withReflectionEnvironment(lightingMap, reflectionMap);
}
