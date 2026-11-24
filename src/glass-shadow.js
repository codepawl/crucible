import { materialLayerValue } from './material-layers.js';

// The share of sun light a transmissive part lets through at each face the shadow pass draws, besides its transmission and colour
// (#3226). A part such as a glass ball is drawn with both faces, so its two faces multiply into the shadow, as the path tracer's
// shadow ray does (src/path-tracer.js, crossGlassFace). Each face costs the light the surface reflects (Fresnel at normal
// incidence, from `ior`) and half of the Beer-Lambert absorption over `thickness`, so a closed shell takes the whole of it.
// A part without transmission returns white, so blended parts and every opaque scene keep their pixels.

/** Reflectance of a dielectric face seen head on. */
export function normalIncidenceReflectance(ior) {
  return ((ior - 1) / (ior + 1)) ** 2;
}

/** Light kept per channel after the absorption of `attenuationColor` over `pathLength` metres (glTF KHR_materials_volume). */
export function volumeAbsorption(attenuationColor, attenuationDistance, pathLength) {
  if (!Number.isFinite(attenuationDistance) || pathLength <= 0) return [1, 1, 1];
  return attenuationColor.map(channel => Math.max(channel, 0) ** (pathLength / attenuationDistance));
}

/** Per channel multiplier a transmissive material applies at one drawn face: Fresnel pass times half the absorption through its thickness. */
export function glassFaceTransmittance(material) {
  if (!(material.transmission > 0)) return [1, 1, 1];
  const passed = 1 - normalIncidenceReflectance(materialLayerValue(material, 'ior'));
  const absorbed = volumeAbsorption(materialLayerValue(material, 'attenuationColor'), materialLayerValue(material, 'attenuationDistance'), materialLayerValue(material, 'thickness') / 2);
  return absorbed.map(channel => passed * channel);
}
