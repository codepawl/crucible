// A set of triangle pairs, stored in two typed arrays. The flush search asks "was this pair measured already?" for millions of
// pairs; a JS Set of numbers above 2^31 boxes every key and rehashes through the heap, which cost seconds on a scene of two
// million triangles (issue #2842). Open addressing over Uint32Array keeps the same answers with no allocation per pair.

const EMPTY_SLOT = 0xffffffff;
const INITIAL_CAPACITY = 1 << 12;
// Half full at most, so a probe ends within a slot or two.
const MAXIMUM_LOAD_NUMERATOR = 1;
const MAXIMUM_LOAD_DENOMINATOR = 2;

function firstSlotOf(first, second, mask) {
  let mixed = Math.imul(first, 0x9e3779b1) ^ Math.imul(second, 0x85ebca6b);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x2c1b3c6d);
  mixed ^= mixed >>> 13;
  return mixed & mask;
}

/** Pairs of triangle ids (each at most 2^32 - 2), with `add` and `has` answering the way a Set of pairs would. */
export function createTrianglePairSet() {
  let capacity = INITIAL_CAPACITY;
  let firsts = new Uint32Array(capacity).fill(EMPTY_SLOT);
  let seconds = new Uint32Array(capacity);
  let size = 0;

  function insert(first, second) {
    const mask = capacity - 1;
    let slot = firstSlotOf(first, second, mask);
    while (firsts[slot] !== EMPTY_SLOT) {
      if (firsts[slot] === first && seconds[slot] === second) return false;
      slot = (slot + 1) & mask;
    }
    firsts[slot] = first;
    seconds[slot] = second;
    size++;
    return true;
  }

  function grow() {
    const oldFirsts = firsts;
    const oldSeconds = seconds;
    capacity *= 2;
    firsts = new Uint32Array(capacity).fill(EMPTY_SLOT);
    seconds = new Uint32Array(capacity);
    size = 0;
    for (let slot = 0; slot < oldFirsts.length; slot++) {
      if (oldFirsts[slot] !== EMPTY_SLOT) insert(oldFirsts[slot], oldSeconds[slot]);
    }
  }

  return {
    get size() {
      return size;
    },
    has(first, second) {
      const mask = capacity - 1;
      let slot = firstSlotOf(first, second, mask);
      while (firsts[slot] !== EMPTY_SLOT) {
        if (firsts[slot] === first && seconds[slot] === second) return true;
        slot = (slot + 1) & mask;
      }
      return false;
    },
    /** Adds the pair; false when it was already in. */
    add(first, second) {
      if ((size + 1) * MAXIMUM_LOAD_DENOMINATOR > capacity * MAXIMUM_LOAD_NUMERATOR) grow();
      return insert(first, second);
    },
  };
}
