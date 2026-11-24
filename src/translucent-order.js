// Back to front order of every alpha-blended instance in one frame (#3236).
//
// Blended parts write no depth, so the last one drawn wins where panes overlap. Sorting each batch on its own is not
// enough: two panes of different colours sit in different batches, and a batch drawn whole cannot sit between the
// instances of another. This orders all instances of all given batches together by the view depth of the centre of
// their bounds, then cuts the order into runs of consecutive instances from one batch.
//
// The scratch arrays live in the object and only grow, so a steady scene allocates nothing per frame.

const MATRIX_TRANSLATION = 12;

export class TranslucentOrder {
  constructor(instanceStride) {
    this.instanceStride = instanceStride;
    this.capacity = 0;
    this.depths = new Float32Array(0);
    this.order = new Uint32Array(0);
    this.owners = new Uint32Array(0);
    this.instances = new Uint32Array(0);
    this.gathered = new Float32Array(0);
    this.runBatches = new Uint32Array(0);
    this.runStarts = new Uint32Array(0);
    this.runCounts = new Uint32Array(0);
    this.runTotal = 0;
    // Farthest first: the most negative view-space z comes first; equal depth keeps the order it was given in.
    this.compare = (first, second) => this.depths[first] - this.depths[second] || first - second;
  }

  reserve(instanceTotal) {
    if (instanceTotal <= this.capacity) return;
    this.capacity = Math.max(instanceTotal, this.capacity * 2);
    this.depths = new Float32Array(this.capacity);
    this.order = new Uint32Array(this.capacity);
    this.owners = new Uint32Array(this.capacity);
    this.instances = new Uint32Array(this.capacity);
    this.gathered = new Float32Array(this.capacity * this.instanceStride);
    this.runBatches = new Uint32Array(this.capacity);
    this.runStarts = new Uint32Array(this.capacity);
    this.runCounts = new Uint32Array(this.capacity);
  }

  /**
   * Sets `range[0]` and `range[1]` to the nearest and farthest view depth (z, farthest most negative) of the sort centres of
   * a batch's instances. Batches whose ranges do not overlap draw in range order with no interleaving between them.
   */
  depthRange(batch, view, range) {
    const stride = this.instanceStride;
    const { instanceData, instanceCount, sortCenter: center } = batch;
    let farthest = Infinity;
    let nearest = -Infinity;
    for (let instance = 0; instance < instanceCount; instance++) {
      const base = instance * stride;
      const depth = view[2] * (instanceData[base] * center[0] + instanceData[base + 4] * center[1] + instanceData[base + 8] * center[2] + instanceData[base + 12])
        + view[6] * (instanceData[base + 1] * center[0] + instanceData[base + 5] * center[1] + instanceData[base + 9] * center[2] + instanceData[base + 13])
        + view[10] * (instanceData[base + 2] * center[0] + instanceData[base + 6] * center[1] + instanceData[base + 10] * center[2] + instanceData[base + 14])
        + view[14];
      if (depth < farthest) farthest = depth;
      if (depth > nearest) nearest = depth;
    }
    range[0] = farthest;
    range[1] = nearest;
    return range;
  }

  /** Mean view depth of the first `count` instances after the last sort. */
  meanDepth(count) {
    let total = 0;
    for (let slot = 0; slot < count; slot++) total += this.depths[slot];
    return count === 0 ? 0 : total / count;
  }

  /**
   * Orders the instances of `batches` (each `{ instanceData, instanceCount, sortCenter: [x, y, z] }`, `sortCenter` the local
   * centre of the bounds) for a camera with column-major `view`. Afterwards run `i` is `runCounts[i]` instances of
   * `batches[runBatches[i]]`, whose data sits in `gathered` from instance `runStarts[i]`, in drawing order.
   * Returns the number of runs.
   */
  sort(batches, view) {
    const stride = this.instanceStride;
    let total = 0;
    for (const batch of batches) total += batch.instanceCount;
    this.reserve(total);
    const depthX = view[2];
    const depthY = view[6];
    const depthZ = view[10];
    const depthOffset = view[14];
    let slot = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const { instanceData, instanceCount, sortCenter: center } = batches[batchIndex];
      for (let instance = 0; instance < instanceCount; instance++) {
        const base = instance * stride;
        const worldX = instanceData[base] * center[0] + instanceData[base + 4] * center[1] + instanceData[base + 8] * center[2] + instanceData[base + MATRIX_TRANSLATION];
        const worldY = instanceData[base + 1] * center[0] + instanceData[base + 5] * center[1] + instanceData[base + 9] * center[2] + instanceData[base + MATRIX_TRANSLATION + 1];
        const worldZ = instanceData[base + 2] * center[0] + instanceData[base + 6] * center[1] + instanceData[base + 10] * center[2] + instanceData[base + MATRIX_TRANSLATION + 2];
        this.depths[slot] = depthX * worldX + depthY * worldY + depthZ * worldZ + depthOffset;
        this.owners[slot] = batchIndex;
        this.instances[slot] = instance;
        this.order[slot] = slot;
        slot++;
      }
    }
    const sorted = this.order.subarray(0, total).sort(this.compare);
    let runs = 0;
    for (let rank = 0; rank < total; rank++) {
      const source = sorted[rank];
      const owner = this.owners[source];
      const instance = this.instances[source];
      if (runs === 0 || this.runBatches[runs - 1] !== owner) {
        this.runBatches[runs] = owner;
        this.runStarts[runs] = rank;
        this.runCounts[runs] = 0;
        runs++;
      }
      this.runCounts[runs - 1]++;
      const data = batches[owner].instanceData;
      const from = instance * stride;
      const to = rank * stride;
      for (let component = 0; component < stride; component++) this.gathered[to + component] = data[from + component];
    }
    this.runTotal = runs;
    return runs;
  }
}
