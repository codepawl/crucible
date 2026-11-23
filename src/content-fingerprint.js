// A 64-bit fingerprint of what a value holds (numbers, strings, arrays, plain objects, typed arrays), so a cache can be
// keyed by content instead of by object identity: a scene rebuilt from the same recipe makes new objects with the same content.

const FIRST_MULTIPLIER = 0x9e3779b1;
const SECOND_MULTIPLIER = 0x85ebca6b;
const FINISH_MULTIPLIER = 0xc2b2ae35;

function createState() {
  return { first: 0x811c9dc5, second: 0x1b873593, words: 0 };
}

function mixWord(state, word) {
  state.first = Math.imul(state.first ^ word, FIRST_MULTIPLIER);
  state.first = (state.first << 13) | (state.first >>> 19);
  state.second = Math.imul(state.second + word, SECOND_MULTIPLIER);
  state.second ^= state.second >>> 15;
  state.words++;
}

const numberScratch = new Float64Array(1);
const numberWords = new Uint32Array(numberScratch.buffer);

function mixNumber(state, number) {
  numberScratch[0] = number;
  mixWord(state, numberWords[0]);
  mixWord(state, numberWords[1]);
}

function mixString(state, text) {
  mixWord(state, text.length);
  for (let index = 0; index < text.length; index++) {
    mixWord(state, text.charCodeAt(index));
  }
}

function mixTypedArray(state, array) {
  mixString(state, array.constructor.name);
  mixWord(state, array.byteLength);
  const wholeWords = array.byteOffset % 4 === 0 && array.byteLength % 4 === 0;
  if (wholeWords) {
    const words = new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4);
    for (let index = 0; index < words.length; index++) {
      mixWord(state, words[index]);
    }
    return;
  }
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let index = 0; index < bytes.length; index++) {
    mixWord(state, bytes[index]);
  }
}

function mixValue(state, value, path) {
  if (value === null || value === undefined) {
    mixString(state, value === null ? 'null' : 'undefined');
  } else if (typeof value === 'number') {
    mixNumber(state, value);
  } else if (typeof value === 'string') {
    mixString(state, value);
  } else if (typeof value === 'boolean') {
    mixWord(state, value ? 1 : 2);
  } else if (ArrayBuffer.isView(value)) {
    mixTypedArray(state, value);
  } else if (typeof value === 'object') {
    mixObject(state, value, path);
  } else {
    // A function, a symbol or a bigint: a hash of it would not tell two different ones apart.
    throw UNREADABLE;
  }
}

function isPlainObject(object) {
  const prototype = Object.getPrototypeOf(object);
  return prototype === Object.prototype || prototype === null;
}

function mixObject(state, object, path) {
  if (path.has(object)) {
    mixString(state, 'cycle');
    return;
  }
  path.add(object);
  if (object instanceof Map) {
    mixString(state, 'Map');
    for (const [key, value] of object) {
      mixValue(state, key, path);
      mixValue(state, value, path);
    }
  } else if (Array.isArray(object)) {
    mixString(state, 'Array');
    mixWord(state, object.length);
    for (const item of object) {
      mixValue(state, item, path);
    }
  } else if (isPlainObject(object)) {
    mixString(state, 'Object');
    for (const key of Object.keys(object)) {
      mixString(state, key);
      mixValue(state, object[key], path);
    }
  } else {
    // A Set, a raw ArrayBuffer, a Date or a class instance holds state this walk cannot read.
    throw UNREADABLE;
  }
  path.delete(object);
}

const UNREADABLE = Object.freeze({ unreadable: true });

/**
 * The fingerprint of `value` as a short string; equal content gives an equal string, and key order inside an object counts.
 * Returns null when the value holds something the walk cannot read (a function, a Set, an ArrayBuffer, a class instance): the
 * caller must then not reuse anything, because two different values would otherwise share one key.
 */
export function contentFingerprint(value) {
  const state = createState();
  try {
    mixValue(state, value, new Set());
  } catch (error) {
    if (error === UNREADABLE) {
      return null;
    }
    throw error;
  }
  const first = Math.imul(state.first ^ state.words, FINISH_MULTIPLIER) >>> 0;
  const second = Math.imul(state.second ^ (state.words >>> 16), FINISH_MULTIPLIER) >>> 0;
  return `${first.toString(36)}-${second.toString(36)}-${state.words.toString(36)}`;
}

/**
 * A deep copy of `value` that shares no array or object with it, or null when it holds something that cannot be copied.
 * A cache keeps one copy and hands each user another, so a scene that edits or drops what it was given cannot change what
 * the next scene finds.
 */
export function ownedCopy(value) {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

/** The bytes a value's typed arrays hold, which is what a cache of it keeps alive. */
export function retainedBytes(value, seen = new Set()) {
  if (ArrayBuffer.isView(value)) {
    return seen.has(value.buffer) ? 0 : (seen.add(value.buffer), value.byteLength);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  const children = value instanceof Map ? [...value.values()] : Object.values(value);
  return children.reduce((total, child) => total + retainedBytes(child, seen), 0);
}
