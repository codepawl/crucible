import { backendFor } from './glaze-backend.js';
import { SPLAT_UNITS } from './shader-registry.js';

// The renderer's splat ground code, kept apart from renderer.js so a scene without splat layers does not carry it.
// splat-shader.js registers these functions; each takes the renderer as its first argument.

function createTextureArray(renderer, format, size, layerCount, pixels) {
  return backendFor(renderer).createTextureArray({
    width: size,
    height: size,
    layers: layerCount,
    format,
    mipmaps: true,
    wrap: 'repeat',
    linear: true,
    data: pixels,
    unpackRaw: true,
    anisotropy: renderer.maxAnisotropy ?? 16,
  });
}

export function initializeSplatPlaceholders(renderer) {
  const backend = backendFor(renderer);
  renderer.splatPlaceholder = backend.createTextureArray({
    width: 1,
    height: 1,
    layers: 1,
    format: 'rgba8',
    linear: true,
    data: new Uint8Array([128, 128, 128, 255]),
  });
  backend.useProgram(renderer.program);
  for (const name of ['splatColor', 'splatNormal', 'splatPacked']) {
    backend.uniform1i(renderer.uniforms[name], SPLAT_UNITS[name]);
    backend.bindTextureUnit(SPLAT_UNITS[name], renderer.splatPlaceholder, true);
  }
  backend.uniform1i(renderer.uniforms.splatMask, SPLAT_UNITS.splatMask);
  backend.bindTextureUnit(SPLAT_UNITS.splatMask, renderer.whiteTexture);
  backend.uniform1f(renderer.uniforms.splatEnabled, 0);
}

export function createSplatResources(renderer, material, support) {
  if (renderer.splatResources.has(material.layers)) return renderer.splatResources.get(material.layers);
  const backend = backendFor(renderer);
  const size = support.resolveSize(material, backend.maxTextureSize());
  const layerCount = material.layers.length;
  const pixels = support.buildPixels(material.layers, size);
  const resources = {
    size,
    layerCount,
    color: createTextureArray(renderer, 'srgb8Alpha8', size, layerCount, pixels.color),
    normal: createTextureArray(renderer, 'rgba8', size, layerCount, pixels.normal),
    packed: createTextureArray(renderer, 'rgba8', size, layerCount, pixels.packed),
    mask: material.splat?.maskMap ? renderer.createTexture(material.splat.maskMap) : renderer.whiteTexture,
    parameters: support.packParameters(material),
  };
  renderer.splatResources.set(material.layers, resources);
  return resources;
}

export function bindSplat(renderer, splat) {
  const backend = backendFor(renderer);
  const uniforms = renderer.uniforms;
  backend.uniform1f(uniforms.splatEnabled, splat ? 1 : 0);
  if (!splat) return;
  const bindings = [
    [SPLAT_UNITS.splatColor, true, splat.color],
    [SPLAT_UNITS.splatNormal, true, splat.normal],
    [SPLAT_UNITS.splatPacked, true, splat.packed],
    [SPLAT_UNITS.splatMask, false, splat.mask],
  ];
  for (const [unit, array, texture] of bindings) {
    backend.bindTextureUnit(unit, texture, array);
  }
  const parameters = splat.parameters;
  backend.uniform4fv(uniforms['splatLayer[0]'], parameters.layer);
  backend.uniform4fv(uniforms['splatTint[0]'], parameters.tint);
  backend.uniform4fv(uniforms['splatSlope[0]'], parameters.slope);
  backend.uniform4fv(uniforms['splatHeightRange[0]'], parameters.height);
  backend.uniform1fv(uniforms['splatMaskChannel[0]'], parameters.mask);
  backend.uniform1fv(uniforms['splatMaskInvert[0]'], parameters.maskInvert);
  backend.uniform4fv(uniforms.splatBlend, parameters.blend);
  backend.uniform4fv(uniforms.splatOptions, parameters.options);
  backend.uniform4fv(uniforms.splatMaskBounds, parameters.maskBounds);
  backend.uniform4fv(uniforms.splatVariation, parameters.variation);
}

export function disposeSplatResources(renderer) {
  const backend = backendFor(renderer);
  for (const resources of renderer.splatResources.values()) {
    for (const texture of [resources.color, resources.normal, resources.packed]) backend.deleteTexture(texture);
  }
  renderer.splatResources.clear();
  if (renderer.splatPlaceholder) backend.deleteTexture(renderer.splatPlaceholder);
}
