import { imageLimitProblem } from './image-header.js';
import { TEXTURE_SEQUENCE_LIMITS } from './texture-sequence-limits.js';

/**
 * Decodes the bytes of a catalog image (PNG, JPEG or WebP) in a browser into `{ width, height, data }`, the pixels the material
 * graph `image` nodes and map sequences read. Decoding applies no colour conversion or premultiplication, so the same file gives
 * the same pixels in a preview, in a render job and in an exported game. The header size is checked first, because
 * createImageBitmap would decode every pixel of an oversized frame before its size is known.
 */
export async function decodeCatalogImage(id, bytes) {
  const headerProblem = imageLimitProblem(bytes, `Sequence frame ${id.slice(0, 12)}`, TEXTURE_SEQUENCE_LIMITS);
  if (headerProblem) throw new RangeError(headerProblem);
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width > TEXTURE_SEQUENCE_LIMITS.maxSide || bitmap.height > TEXTURE_SEQUENCE_LIMITS.maxSide) {
      throw new RangeError(`Sequence frame ${id.slice(0, 12)} is ${bitmap.width}x${bitmap.height}; frames are at most ${TEXTURE_SEQUENCE_LIMITS.maxSide} pixels on a side.`);
    }
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}
