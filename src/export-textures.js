import { encodePng } from './export-png.js';
import { requireOneOf } from './export-checks.js';
import { sourceEncodingOf } from './image-source-encoding.js';

export const DEFAULT_MAX_TEXTURE_SIZE = 2048;
const ABSOLUTE_MAX_TEXTURE_SIZE = 16384;
const WRAP_DEFAULT = 10497;
const MIN_FILTER_DEFAULT = 9987;
const MAG_FILTER_DEFAULT = 9729;
const VALID_WRAPS = [10497, 33071, 33648];
const VALID_MAG_FILTERS = [9728, 9729];
const VALID_MIN_FILTERS = [9728, 9729, 9984, 9985, 9986, 9987];


function pixelsOf(image, channel, { width, height }) {
  if (image?.compressed) throw new TypeError(`GLB ${channel} is a GPU-compressed texture, which export cannot read back. Transcode KTX2 to RGBA8 to export it.`);
  if (image.data) {
    if (image.data.length < width * height * 4) throw new RangeError(`GLB ${channel} image data must hold RGBA8 pixels for every texel.`);
    return { width, height, pixels: image.data };
  }
  // Browser images, bitmaps and canvases: read the pixels back through a canvas.
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : globalThis.document?.createElement('canvas');
  if (!canvas) throw new TypeError(`GLB ${channel} needs RGBA pixel data ({ width, height, data }) outside a browser.`);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

function imageSize(image, channel) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`GLB ${channel} needs an image with a whole width and height.`);
  }
  return { width, height };
}

/**
 * Writes each distinct image once and shares samplers and textures between channels.
 * An image decoded from a JPEG, PNG or WebP file and left unchanged keeps those bytes; any other image is embedded as a PNG.
 */
export function createTextureWriter(writer, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE) {
  if (!Number.isInteger(maxTextureSize) || maxTextureSize < 1 || maxTextureSize > ABSOLUTE_MAX_TEXTURE_SIZE) {
    throw new RangeError(`maxTextureSize must be a whole number from 1 to ${ABSOLUTE_MAX_TEXTURE_SIZE}.`);
  }
  const { document } = writer;
  document.images = [];
  document.samplers = [];
  document.textures = [];
  const imageIndices = new Map();
  const samplerIndices = new Map();
  const textureIndices = new Map();

  function imageIndex(descriptor, channel) {
    const flipRows = descriptor.flipY === true;
    const known = imageIndices.get(descriptor.image);
    if (known?.has(flipRows)) return known.get(flipRows);
    const sourceEncoding = flipRows ? undefined : sourceEncodingOf(descriptor.image) ?? sourceEncodingOf(descriptor.image?.compressed?.levels?.[0]);
    const size = imageSize(descriptor.image, channel);
    const { width, height } = size;
    if (width > maxTextureSize || height > maxTextureSize) {
      throw new RangeError(`GLB ${channel} image is ${width}x${height}, above maxTextureSize ${maxTextureSize}. Resize the image, or pass exportGlb(parts, { maxTextureSize }) up to ${ABSOLUTE_MAX_TEXTURE_SIZE} if the file size is acceptable.`);
    }
    const decoded = sourceEncoding ? undefined : pixelsOf(descriptor.image, channel, size);
    const bytes = sourceEncoding?.bytes ?? encodePng(decoded.pixels, width, height, { flipRows });
    const mimeType = sourceEncoding?.mimeType ?? 'image/png';
    document.images.push({ bufferView: writer.addBufferView(bytes), mimeType });
    const index = document.images.length - 1;
    imageIndices.set(descriptor.image, (known ?? new Map()).set(flipRows, index));
    return index;
  }

  // glTF core reads PNG and JPEG; WebP and KTX2 go through their extensions, which readers must support to show them.
  function textureDefinition(sampler, source) {
    const mimeType = document.images[source].mimeType;
    const extension = mimeType === 'image/webp' ? 'EXT_texture_webp' : mimeType === 'image/ktx2' ? 'KHR_texture_basisu' : null;
    if (!extension) return { sampler, source };
    writer.addExtension(extension, { required: true });
    return { sampler, extensions: { [extension]: { source } } };
  }

  function samplerIndex(descriptor, channel) {
    const sampler = {
      magFilter: requireOneOf('GLB', `${channel} texture magFilter`, descriptor.magFilter ?? MAG_FILTER_DEFAULT, VALID_MAG_FILTERS),
      minFilter: requireOneOf('GLB', `${channel} texture minFilter`, descriptor.minFilter ?? MIN_FILTER_DEFAULT, VALID_MIN_FILTERS),
      wrapS: requireOneOf('GLB', `${channel} texture wrapS`, descriptor.wrapS ?? WRAP_DEFAULT, VALID_WRAPS),
      wrapT: requireOneOf('GLB', `${channel} texture wrapT`, descriptor.wrapT ?? WRAP_DEFAULT, VALID_WRAPS),
    };
    const key = JSON.stringify(sampler);
    if (!samplerIndices.has(key)) {
      samplerIndices.set(key, document.samplers.length);
      document.samplers.push(sampler);
    }
    return samplerIndices.get(key);
  }

  return {
    /** Index of the glTF texture for a renderer texture descriptor `{ image, wrapS, ... }`. */
    textureIndex(descriptor, channel) {
      if (![0, 1].includes(descriptor.uvChannel ?? 0)) throw new RangeError(`GLB ${channel} uses UV channel ${descriptor.uvChannel}; only channels 0 and 1 are supported.`);
      const source = imageIndex(descriptor, channel);
      const sampler = samplerIndex(descriptor, channel);
      const key = `${source}:${sampler}`;
      if (!textureIndices.has(key)) {
        textureIndices.set(key, document.textures.length);
        document.textures.push(textureDefinition(sampler, source));
      }
      return textureIndices.get(key);
    },
  };
}
