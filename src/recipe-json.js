import { rejectThreeObject } from './field-error.js';

/** Rejects inputs whose serialized JSON exceeds `maximum` bytes. */
export function assertWithinRecipeBytes(bytes, maximum) {
  if (bytes > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes. Reduce the input.');
  }
}

/**
 * Copies only finite, acyclic, plain JSON data up to `maximum` bytes. Rejects accessors before reading them,
 * bounds traversal before serialization, and flags three.js objects with the Crucible way instead.
 */
export function copiedJson(input, maximum) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  // Recipes repeat the same keys and ids thousands of times, so each distinct string is measured once.
  const stringBytes = new Map();
  function jsonStringBytes(text) {
    let size = stringBytes.get(text);
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(text)).length;
      stringBytes.set(text, size);
    }
    return size;
  }
  function charge(count) {
    bytes += count;
    assertWithinRecipeBytes(bytes, maximum);
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > maximum) {
        throw new RangeError('JSON exceeds maxRecipeBytes.');
      }
      charge(jsonStringBytes(value));
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Recipe must contain finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && value.length > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      rejectThreeObject(value, 'Recipe');
      throw new TypeError('Recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    let entryCount = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('JSON arrays must be dense without extra fields.');
      }
      // Commas are counted exactly (one between entries) so this running size equals the serialized size
      // that normalizeRecipe checks after a field edit; both paths then accept and refuse the same recipes.
      const separatorBytes = entryCount === 0 ? 0 : 1;
      entryCount += 1;
      charge(array ? separatorBytes : jsonStringBytes(key) + 1 + separatorBytes);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('JSON arrays must be dense without trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes.');
  }
  return result;
}
