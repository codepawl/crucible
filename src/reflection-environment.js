// A scene that lights with one environment and shows another sky (#3396): the lighting map keeps the diffuse light, and a
// separate reflection map is what glass, water and every other specular term reflect. The renderer already prefilters the
// map's own pixels for reflection and reads the diffuse light from an `irradianceSource`, so the combined map is the reflection
// map's pixels with the lighting map as that source.
// Agent scenes load this file on demand, when a recipe names environment.reflectionHdri (agentSceneModule 'reflectionEnvironment').
// It imports nothing: a shared import would move that code into a chunk of its own and grow the entry bundle (#3396).

const irradianceOnlyMaps = new WeakMap();
const combinedMaps = new WeakMap();

// The lighting map reduced to the pixels its diffuse light reads. One object for each pixel array, so the renderer's check
// for "the same irradiance source" holds while the lighting map only turns or dims.
function irradianceOnlyMap(lightingMap) {
  const source = lightingMap.irradianceSource ?? lightingMap;
  if (!irradianceOnlyMaps.has(source.data)) {
    irradianceOnlyMaps.set(source.data, Object.freeze({ ...source, intensity: 1, rotation: 0, showBackground: false, backgroundBlur: 0, sunDisc: null, irradianceSource: undefined }));
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
  if (lightingMap?.kind !== 'environment-map') {
    throw new TypeError('The lighting map must be an environment map made with createEnvironmentMap or loadHdri.');
  }
  if (reflectionMap?.kind !== 'environment-map') {
    throw new TypeError('The reflection environment must be a map made with createEnvironmentMap or loadHdri: pass the HDRI that glass and water should reflect.');
  }
  if (!combinedMaps.has(lightingMap)) combinedMaps.set(lightingMap, new WeakMap());
  const cache = combinedMaps.get(lightingMap);
  if (!cache.has(reflectionMap)) {
    const { width, height, channels, data } = reflectionMap;
    cache.set(reflectionMap, Object.freeze({ ...lightingMap, width, height, channels, data, irradianceSource: irradianceOnlyMap(lightingMap) }));
  }
  return cache.get(reflectionMap);
}

/**
 * Validates environment.reflectionHdri: a shipped HDRI name or the 64-character ID of a .hdr file in the asset catalog.
 * `accepted` is { isReference, names } from look-catalog.js; `fail(path, value, accepted)` builds the error.
 */
export function resolveReflectionHdri(reference, skybox, fail, { isReference, names }) {
  if (typeof reference !== 'string' || !isReference(reference)) {
    throw fail('environment.reflectionHdri', reference, `one of ${names.join(', ')} or the 64-character ID of a .hdr file in the asset catalog`);
  }
  if (skybox) {
    throw fail('environment.reflectionHdri', 'set beside skybox', 'a skybox alone (it is already the sky that is reflected): remove "reflectionHdri", or remove "skybox"');
  }
  return reference;
}
