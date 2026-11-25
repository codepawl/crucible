import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS, SHADOW_ATLAS_TILE_COUNT } from './light-limits.js';

// The local-light arrays live in std140 uniform blocks instead of the default block. WebGL counts default-block uniforms against
// MAX_FRAGMENT_UNIFORM_VECTORS, which Qualcomm Adreno GPUs set to 256, and the arrays alone take 480 rows with the IES table. A block has
// its own limit, MAX_UNIFORM_BLOCK_SIZE, which is at least 16 KiB on every WebGL 2 device.
const FLOATS_PER_ROW = 4;
const FLOATS_PER_MATRIX = 16;

// std140 rounds every array element up to a vec4, so a float array takes one row per element; a mat4 is four rows.
const ROWS_PER_ELEMENT = { vec4: 1, float: 1, mat4: 4 };

export const LIGHT_DATA_BLOCK = Object.freeze({
  name: 'LightData',
  binding: 0,
  entries: Object.freeze([
    { name: 'pointLightPositions', type: 'vec4', count: MAX_POINT_LIGHTS },
    { name: 'pointLightColors', type: 'vec4', count: MAX_POINT_LIGHTS },
    { name: 'pointLightRadii', type: 'float', count: MAX_POINT_LIGHTS },
    { name: 'pointLightShadowTiles', type: 'float', count: MAX_POINT_LIGHTS },
    { name: 'spotLightPositions', type: 'vec4', count: MAX_SPOT_LIGHTS },
    { name: 'spotLightColors', type: 'vec4', count: MAX_SPOT_LIGHTS },
    { name: 'spotLightDirections', type: 'vec4', count: MAX_SPOT_LIGHTS },
    { name: 'spotLightParameters', type: 'vec4', count: MAX_SPOT_LIGHTS },
    { name: 'areaLightPositions', type: 'vec4', count: MAX_AREA_LIGHTS },
    { name: 'areaLightColors', type: 'vec4', count: MAX_AREA_LIGHTS },
    { name: 'areaLightNormals', type: 'vec4', count: MAX_AREA_LIGHTS },
    { name: 'areaLightTangents', type: 'vec4', count: MAX_AREA_LIGHTS },
    { name: 'localShadowMatrices', type: 'mat4', count: SHADOW_ATLAS_TILE_COUNT },
    { name: 'localShadowTexelAngles', type: 'float', count: SHADOW_ATLAS_TILE_COUNT },
    // environment.fillColor: the colours of the two fill lights.
    { name: 'fillLightColors', type: 'vec4', count: 2 },
  ]),
});

/** The GLSL declaration of a block: `layout(std140) uniform Name { ... };`, with no instance name so members keep their plain names. */
export function uniformBlockDeclaration(block) {
  const members = block.entries.map(entry => `  ${entry.type} ${entry.name}[${entry.count}];`).join('\n');
  return `layout(std140) uniform ${block.name} {\n${members}\n};`;
}

function blockOffsets(block) {
  const offsets = new Map();
  let floats = 0;
  for (const entry of block.entries) {
    offsets.set(entry.name, { start: floats, ...entry });
    floats += entry.count * ROWS_PER_ELEMENT[entry.type] * FLOATS_PER_ROW;
  }
  return { offsets, floatCount: floats };
}

export function uniformBlockByteSize(block) {
  return blockOffsets(block).floatCount * Float32Array.BYTES_PER_ELEMENT;
}

/** One GPU buffer holding a block's data, bound to the block's binding point. Writes go to a CPU copy and `upload` sends it. */
export class UniformBlockBuffer {
  constructor(context, block) {
    const { offsets, floatCount } = blockOffsets(block);
    this.context = context;
    this.block = block;
    this.offsets = offsets;
    this.data = new Float32Array(floatCount);
    this.buffer = context.createBuffer();
    context.bindBuffer(context.UNIFORM_BUFFER, this.buffer);
    context.bufferData(context.UNIFORM_BUFFER, this.data.byteLength, context.DYNAMIC_DRAW);
    context.bindBuffer(context.UNIFORM_BUFFER, null);
    this.linkedProgram = null;
  }

  /** Copies `values` into the named array; a float array is spread one value to a row. A missing or shorter array leaves the rest as it was. */
  write(name, values) {
    const entry = this.offsets.get(name);
    if (!entry) throw new RangeError(`Uniform block ${this.block.name} has no array named ${name}`);
    const length = Math.min(values.length, entry.count * (entry.type === 'float' ? 1 : entry.type === 'mat4' ? FLOATS_PER_MATRIX : FLOATS_PER_ROW));
    if (entry.type !== 'float') {
      this.data.set(length === values.length ? values : values.subarray(0, length), entry.start);
      return;
    }
    for (let index = 0; index < length; index++) this.data[entry.start + index * FLOATS_PER_ROW] = values[index];
  }

  /** Sends the data and binds the buffer for `program`. The block of a program that does not use it (all members unused) is skipped. */
  upload(program) {
    const context = this.context;
    context.bindBuffer(context.UNIFORM_BUFFER, this.buffer);
    context.bufferSubData(context.UNIFORM_BUFFER, 0, this.data);
    context.bindBuffer(context.UNIFORM_BUFFER, null);
    context.bindBufferBase(context.UNIFORM_BUFFER, this.block.binding, this.buffer);
    if (program === this.linkedProgram) return;
    this.linkedProgram = program;
    const index = context.getUniformBlockIndex(program, this.block.name);
    if (index !== context.INVALID_INDEX) context.uniformBlockBinding(program, index, this.block.binding);
  }

  dispose() {
    this.context.deleteBuffer(this.buffer);
  }
}

/** The renderer's buffer for a block, made on first use and deleted by `disposeUniformBlocks`. */
export function uniformBlockOf(renderer, block) {
  renderer.uniformBlocks ??= new Map();
  if (!renderer.uniformBlocks.has(block.name)) renderer.uniformBlocks.set(block.name, new UniformBlockBuffer(renderer.context, block));
  return renderer.uniformBlocks.get(block.name);
}

export function disposeUniformBlocks(renderer) {
  for (const buffer of renderer.uniformBlocks?.values() ?? []) buffer.dispose();
  renderer.uniformBlocks?.clear();
}
