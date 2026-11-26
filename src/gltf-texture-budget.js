/**
 * Formats the load warnings when `maxTexturePixels` scales down glTF images.
 * When scaled images are used by materials, names the total pixel overrun and every affected material/map slot
 * so demo scenes never lose texture detail silently.
 */
export function textureBudgetWarnings(document, textureScaling, maxTexturePixels, { materialTextureReferences, textureSourceIndex }) {
  const { scaledTextures, targetByImageIndex, totalPixelsBefore, totalPixelsAfter } = textureScaling;
  const preview = scaledTextures.slice(0, 3).map(({ name, from, to }) => `${name} ${from.join('x')} to ${to.join('x')}`);
  const more = scaledTextures.length - preview.length;
  const rest = more ? ` and ${more} more (see asset.scaledTextures)` : '';
  const warnings = [`Scaled ${scaledTextures.length} texture image(s) to fit maxTexturePixels: ${preview.join(', ')}${rest}.`];
  const scaledByImage = new Map([...targetByImageIndex.keys()].map((imageIndex, position) => [imageIndex, scaledTextures[position]]));
  const materialWarnings = [];
  for (const [materialIndex, material] of (document.materials ?? []).entries()) {
    const materialName = material?.name ?? `material ${materialIndex}`;
    for (const [slot, reference] of materialTextureReferences(material ?? {})) {
      const texture = document.textures?.[reference.index];
      const entry = texture && scaledByImage.get(textureSourceIndex(texture));
      if (!entry) continue;
      materialWarnings.push(`Scaled "${materialName}" ${slot} (${entry.name}) ${entry.from.join('x')} to ${entry.to.join('x')} to fit maxTexturePixels.`);
    }
  }
  if (materialWarnings.length) {
    warnings.push(`Texture budget exceeded: ${totalPixelsBefore} px total vs maxTexturePixels ${maxTexturePixels} (scaled to ${totalPixelsAfter} px); pass { maxTexturePixels: ${totalPixelsBefore} } to keep full resolution.`);
    warnings.push(...materialWarnings);
  }
  return warnings;
}
