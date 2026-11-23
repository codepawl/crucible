// Runs in the page (#2144). Experiments on how the opaque colour pass spends its pixels, all done from outside src/:
//   measureOverdraw: how many fragments land on each pixel (counted with additive blending of 1/255 into a single sample RGBA8 target).
//   front-to-back sort: batches by nearest instance, and the instances inside a batch, nearest first.
//   depth prepass: a depth only pass over the opaque batches with a trivial fragment shader, then the colour pass with depth func EQUAL and depth writes off.
// Counting and the prepass replace the colour fragment shader or add a program, so nothing here changes what src/ draws by default.
const COUNT_FRAGMENT = '#version 300 es\nprecision highp float;\nout vec4 outputColour;\nvoid main() { outputColour = vec4(1.0 / 255.0, 0.0, 0.0, 1.0); }';
const DEPTH_ONLY_FRAGMENT = '#version 300 es\nprecision highp float;\nout vec4 outputColour;\nvoid main() { outputColour = vec4(0.0); }';
const INSTANCE_STRIDE = 42;
const UNIFORM_METHODS = ['uniform1f', 'uniform1i', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniformMatrix3fv', 'uniformMatrix4fv'];
const LAYER_LIMIT = 4;

function isColourFragment(source) {
  return source.includes('float shadowVisibility');
}

// Distance from the eye to the near side of each instance's bounding sphere, for every instance of a batch.
function instanceDistances(batch, eye) {
  const data = batch.instanceData;
  const [centerX, centerY, centerZ] = batch.bounds.center;
  const distances = new Float32Array(batch.instanceCount);
  for (let index = 0; index < batch.instanceCount; index++) {
    const offset = index * INSTANCE_STRIDE;
    const x = data[offset] * centerX + data[offset + 4] * centerY + data[offset + 8] * centerZ + data[offset + 12];
    const y = data[offset + 1] * centerX + data[offset + 5] * centerY + data[offset + 9] * centerZ + data[offset + 13];
    const z = data[offset + 2] * centerX + data[offset + 6] * centerY + data[offset + 10] * centerZ + data[offset + 14];
    const scale = Math.sqrt(Math.max(data[offset] ** 2 + data[offset + 1] ** 2 + data[offset + 2] ** 2, data[offset + 4] ** 2 + data[offset + 5] ** 2 + data[offset + 6] ** 2, data[offset + 8] ** 2 + data[offset + 9] ** 2 + data[offset + 10] ** 2));
    distances[index] = Math.hypot(x - eye[0], y - eye[1], z - eye[2]) - batch.bounds.radius * scale;
  }
  return distances;
}

// Front to back draw order, switched by `state.sort` ('off', 'batches', 'instances' or 'both'). Returns what to call to undo it.
export function installFrontToBackSort(renderer, state) {
  const originalBatches = [...renderer.batches];
  const originalRender = renderer.renderFrame.bind(renderer);
  const originalSelect = renderer.selectBatchInstances.bind(renderer);
  // The distances and the batch order depend only on the eye, so a still camera computes them once.
  const distancesByBatch = new Map();
  let sortedBatches = null;
  let cachedEye = '';
  let eye = [0, 0, 0];
  renderer.renderFrame = frame => {
    eye = frame.eye;
    if (String(eye) !== cachedEye) {
      cachedEye = String(eye);
      distancesByBatch.clear();
      sortedBatches = null;
    }
    const sortsBatches = state.sort === 'batches' || state.sort === 'both';
    if (sortsBatches) {
      if (!sortedBatches) {
        const nearest = new Map(originalBatches.map(batch => [batch, batch.cullable ? Math.min(...instanceDistancesOf(batch)) : -Infinity]));
        sortedBatches = [...originalBatches].sort((first, second) => nearest.get(first) - nearest.get(second));
      }
      renderer.batches = sortedBatches;
    } else {
      renderer.batches = originalBatches;
    }
    return originalRender(frame);
  };
  const instanceDistancesOf = batch => {
    if (!distancesByBatch.has(batch)) distancesByBatch.set(batch, instanceDistances(batch, eye));
    return distancesByBatch.get(batch);
  };
  renderer.selectBatchInstances = batch => {
    const selection = originalSelect(batch);
    if (!selection) return selection;
    // The override below sticks to the reused selection, so every other order removes it.
    if (!(state.sort === 'instances' || state.sort === 'both')) {
      if (Object.hasOwn(selection, 'isEverything')) delete selection.isEverything;
      return selection;
    }
    const distances = instanceDistancesOf(batch);
    for (let level = 0; level < selection.counts.length; level++) {
      const sorted = Array.from(selection.indices[level].subarray(0, selection.counts[level])).sort((first, second) => distances[first] - distances[second]);
      selection.indices[level].set(sorted);
    }
    // A batch that shows everything would draw its whole buffer in stored order, so this makes it use the sorted indices.
    Object.defineProperty(selection, 'isEverything', { value: false, configurable: true });
    return selection;
  };
  return () => {
    renderer.renderFrame = originalRender;
    renderer.selectBatchInstances = originalSelect;
    renderer.batches = originalBatches;
  };
}

// Compiles a twin of the colour program (same vertex shader, empty fragment shader) and mirrors every uniform call onto it, so the
// vertex stage sees the same values and gl_Position is bit identical (the shader declares it invariant). Call before the renderer is created.
export function installPrepassPrograms() {
  const prototype = WebGL2RenderingContext.prototype;
  const original = {};
  for (const name of ['shaderSource', 'attachShader', 'linkProgram', 'useProgram', 'getUniformLocation', ...UNIFORM_METHODS]) original[name] = prototype[name];
  const colourShaders = new WeakSet();
  const programsWithColour = new WeakSet();
  const locationNames = new WeakMap();
  const twinLocations = new Map();
  const state = { main: null, twin: null, current: null, insideBatchDraw: false, prepassFrames: 0, plainFrames: 0, prepassDraws: 0, colourDraws: 0, twinUniformCalls: 0 };
  prototype.shaderSource = function shaderSource(shader, source) {
    if (isColourFragment(source)) colourShaders.add(shader);
    return original.shaderSource.call(this, shader, source);
  };
  prototype.attachShader = function attachShader(program, shader) {
    if (colourShaders.has(shader)) programsWithColour.add(program);
    return original.attachShader.call(this, program, shader);
  };
  prototype.linkProgram = function linkProgram(program) {
    original.linkProgram.call(this, program);
    if (!programsWithColour.has(program)) return;
    twinLocations.clear();
    const shaders = this.getAttachedShaders(program);
    const vertex = shaders.find(shader => !colourShaders.has(shader));
    const fragment = this.createShader(this.FRAGMENT_SHADER);
    original.shaderSource.call(this, fragment, DEPTH_ONLY_FRAGMENT);
    this.compileShader(fragment);
    const twin = this.createProgram();
    original.attachShader.call(this, twin, vertex);
    original.attachShader.call(this, twin, fragment);
    original.linkProgram.call(this, twin);
    state.main = program;
    state.twin = twin;
  };
  prototype.useProgram = function useProgram(program) {
    state.current = program;
    return original.useProgram.call(this, program);
  };
  prototype.getUniformLocation = function getUniformLocation(program, name) {
    const location = original.getUniformLocation.call(this, program, name);
    if (location && program === state.main) locationNames.set(location, name);
    return location;
  };
  function twinLocationOf(context, location) {
    const name = locationNames.get(location);
    if (name === undefined) return null;
    if (!twinLocations.has(name)) twinLocations.set(name, original.getUniformLocation.call(context, state.twin, name));
    return twinLocations.get(name);
  }
  for (const method of UNIFORM_METHODS) {
    prototype[method] = function mirroredUniform(location, ...values) {
      if (!state.twin || !location) return original[method].call(this, location, ...values);
      if (state.current === state.twin) {
        const twinLocation = twinLocationOf(this, location);
        if (twinLocation) original[method].call(this, twinLocation, ...values);
        return undefined;
      }
      const result = original[method].call(this, location, ...values);
      if (state.current === state.main && !state.insideBatchDraw) {
        const twinLocation = twinLocationOf(this, location);
        if (twinLocation) {
          state.twinUniformCalls++;
          original.useProgram.call(this, state.twin);
          original[method].call(this, twinLocation, ...values);
          original.useProgram.call(this, state.main);
        }
      }
      return result;
    };
  }
  return {
    state,
    uninstall() {
      for (const [name, method] of Object.entries(original)) prototype[name] = method;
    },
  };
}

// Splits the opaque loop of renderFrame in two: the loop only records its draws, and drawTranslucent (the next step of the frame)
// runs them, first as a depth only pass and then as the colour pass. Batches with alpha cut-outs draw after, in the colour pass, with the normal depth test.
export function installDepthPrepass(renderer, programs, mode) {
  const context = renderer.context;
  const originalDraw = renderer.drawAlphaBatch.bind(renderer);
  const originalTranslucent = renderer.drawTranslucent.bind(renderer);
  const originalRender = renderer.renderFrame.bind(renderer);
  let recorded = [];
  let recording = false;
  renderer.renderFrame = frame => {
    recorded = [];
    recording = mode.prepass;
    return originalRender(frame);
  };
  // Uniforms a batch sets itself go to whichever program is current, so only the frame level ones need mirroring.
  const drawBatchNow = parameters => {
    programs.state.insideBatchDraw = true;
    originalDraw(...parameters);
    programs.state.insideBatchDraw = false;
  };
  renderer.drawAlphaBatch = (...parameters) => {
    if (recording) recorded.push(parameters);
    else drawBatchNow(parameters);
  };
  renderer.drawTranslucent = (...parameters) => {
    if (recording) {
      recording = false;
      runPrepass();
    }
    return originalTranslucent(...parameters);
  };
  function runPrepass() {
    const { state } = programs;
    const usable = state.main && state.current === state.main && context.getProgramParameter(state.twin, context.LINK_STATUS);
    if (!usable) {
      state.plainFrames++;
      recorded.forEach(drawBatchNow);
      return;
    }
    state.prepassFrames++;
    const depthFunction = context.getParameter(context.DEPTH_FUNC);
    const cutouts = recorded.filter(([batch]) => batch.alphaMode === 'mask');
    const opaque = recorded.filter(([batch]) => batch.alphaMode !== 'mask');
    context.useProgram(state.twin);
    context.colorMask(false, false, false, false);
    opaque.forEach(drawBatchNow);
    state.prepassDraws += opaque.length;
    context.colorMask(true, true, true, true);
    context.useProgram(state.main);
    // Experiment only: the depth pass alone, to price it (the picture is not drawn).
    if (mode.depthOnly) return;
    context.depthFunc(context.EQUAL);
    context.depthMask(false);
    opaque.forEach(drawBatchNow);
    context.depthMask(true);
    context.depthFunc(depthFunction);
    cutouts.forEach(drawBatchNow);
    state.colourDraws += opaque.length + cutouts.length;
  }
  return () => {
    renderer.renderFrame = originalRender;
    renderer.drawAlphaBatch = originalDraw;
    renderer.drawTranslucent = originalTranslucent;
  };
}

// Fragments per pixel of the opaque pass. `depthTest` false counts every rasterised fragment (depth complexity); true counts
// the fragments that pass the depth test in draw order, which is what the colour shader runs for (before the hardware's own early depth reordering).
// The count is single sample: a pixel on a triangle edge that MSAA shades counts once per covering primitive in the real frame, so this is a lower bound at edges.
// Install before the renderer is created: the colour fragment shader is replaced by one that adds 1/255.
export function installFragmentCounter() {
  const prototype = WebGL2RenderingContext.prototype;
  const original = {};
  for (const name of ['shaderSource', 'bindFramebuffer', 'clear', 'drawElementsInstanced']) original[name] = prototype[name];
  const counter = { framebuffer: null, bound: false, depthTest: true, countFramebuffer: null };
  prototype.shaderSource = function shaderSource(shader, source) {
    return original.shaderSource.call(this, shader, isColourFragment(source) ? COUNT_FRAGMENT : source);
  };
  prototype.bindFramebuffer = function bindFramebuffer(target, framebuffer) {
    if (counter.framebuffer && framebuffer === counter.framebuffer) {
      counter.bound = true;
      original.bindFramebuffer.call(this, target, counter.countFramebuffer);
      this.clearColor(0, 0, 0, 0);
      original.clear.call(this, this.COLOR_BUFFER_BIT);
      return;
    }
    counter.bound = framebuffer === counter.countFramebuffer && Boolean(framebuffer);
    original.bindFramebuffer.call(this, target, framebuffer);
  };
  prototype.clear = function clear(mask) {
    return original.clear.call(this, counter.bound ? mask & this.DEPTH_BUFFER_BIT : mask);
  };
  prototype.drawElementsInstanced = function drawElementsInstanced(...parameters) {
    if (counter.bound) {
      this.enable(this.BLEND);
      this.blendFunc(this.ONE, this.ONE);
      this.colorMask(true, true, true, true);
      if (counter.depthTest) this.enable(this.DEPTH_TEST);
      else this.disable(this.DEPTH_TEST);
    }
    return original.drawElementsInstanced.apply(this, parameters);
  };
  return {
    counter,
    uninstall() {
      for (const [name, method] of Object.entries(original)) prototype[name] = method;
    },
  };
}

function createCountTarget(context, width, height) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texStorage2D(context.TEXTURE_2D, 1, context.RGBA8, width, height);
  const depth = context.createRenderbuffer();
  context.bindRenderbuffer(context.RENDERBUFFER, depth);
  context.renderbufferStorage(context.RENDERBUFFER, context.DEPTH_COMPONENT24, width, height);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depth);
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  return framebuffer;
}

function describeCounts(pixels) {
  const histogram = new Array(LAYER_LIMIT + 1).fill(0);
  let covered = 0;
  let fragments = 0;
  let maximum = 0;
  const pixelCount = pixels.length / 4;
  for (let index = 0; index < pixelCount; index++) {
    const layers = pixels[index * 4];
    histogram[Math.min(layers, LAYER_LIMIT)]++;
    fragments += layers;
    if (layers > 0) covered++;
    if (layers > maximum) maximum = layers;
  }
  const share = count => Number((count / pixelCount).toFixed(4));
  return {
    pixels: pixelCount,
    coveredShare: share(covered),
    fragmentsPerCoveredPixel: Number((fragments / Math.max(covered, 1)).toFixed(3)),
    fragmentsPerPixel: Number((fragments / pixelCount).toFixed(3)),
    maximumLayers: maximum,
    // Share of all pixels with 0, 1, 2, 3 and 4 or more fragments.
    shareOfPixelsByLayers: histogram.map(share),
    // The same, among covered pixels only (the sky the environment background draws is not counted).
    shareOfCoveredByLayers: histogram.slice(1).map(count => Number((count / Math.max(covered, 1)).toFixed(4))),
  };
}

// Renders until the colour program has linked and the count stops changing, then reads the count target back.
export async function measureOverdraw({ createRenderer, canvas, frame, orders = ['off', 'batches', 'instances', 'both'] }) {
  const installed = installFragmentCounter();
  try {
    const renderer = createRenderer();
    const context = renderer.context;
    const sortState = { sort: 'off' };
    installFrontToBackSort(renderer, sortState);
    const renderUntilStable = async () => {
      let previous = -1;
      let stableFrames = 0;
      let latest = null;
      for (let attempt = 0; attempt < 400 && stableFrames < 3; attempt++) {
        renderer.render(frame);
        context.bindFramebuffer(context.FRAMEBUFFER, installed.counter.countFramebuffer);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        context.bindFramebuffer(context.FRAMEBUFFER, null);
        latest = describeCounts(pixels);
        const total = latest.fragmentsPerPixel;
        stableFrames = total > 0 && total === previous ? stableFrames + 1 : 0;
        previous = total;
        if (attempt % 20 === 19) await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { ...latest, stable: stableFrames >= 3 };
    };
    renderer.drawTranslucent = () => {};
    renderer.drawBlendBatches = () => {};
    renderer.resolveFrame = () => {};
    renderer.drawEnvironmentBackground = () => false;
    renderer.createShadowMap = () => {};
    renderer.render(frame);
    installed.counter.framebuffer = renderer.multisampleFramebuffer;
    installed.counter.countFramebuffer = createCountTarget(context, canvas.width, canvas.height);
    const result = { masked: renderer.batches.filter(batch => batch.alphaMode === 'mask').length, batches: renderer.batches.length, glErrors: [] };
    installed.counter.depthTest = false;
    sortState.sort = 'off';
    result.everyFragment = await renderUntilStable();
    installed.counter.depthTest = true;
    for (const order of orders) {
      sortState.sort = order;
      result[`passingDepth_${order}`] = await renderUntilStable();
    }
    for (let error = context.getError(); error !== context.NO_ERROR && result.glErrors.length < 8; error = context.getError()) result.glErrors.push(error);
    renderer.dispose();
    return { overdraw: result };
  } finally {
    installed.uninstall();
  }
}

// Whole frame GPU time of baseline, sort, prepass and prepass with sort on one renderer, steps rotated each round so a drifting card favours none.
// `timeFrames` and `createSegmentTimer` come from the harness. With `capture`, one frame per variant is returned for RMSE.
export async function measureOpaqueOrder({ createRenderer, canvas, frame, frames = 100, rounds = 3, variants = ['baseline', 'sort-batches', 'sort-both', 'prepass', 'prepass-sort-batches'], capture = true, timeFrames, createSegmentTimer, totalOf, median, rotatedOrder }) {
  const programs = installPrepassPrograms();
  try {
    const renderer = createRenderer();
    const context = renderer.context;
    const timer = createSegmentTimer(context);
    renderer.gpuTimer = null;
    const sortState = { sort: 'off' };
    const prepassMode = { prepass: false };
    installFrontToBackSort(renderer, sortState);
    installDepthPrepass(renderer, programs, prepassMode);
    const configure = label => {
      sortState.sort = label.endsWith('sort-both') ? 'both' : label.endsWith('sort-batches') ? 'batches' : 'off';
      prepassMode.prepass = label.startsWith('prepass');
      prepassMode.depthOnly = label === 'prepass-only';
    };
    configure('baseline');
    for (let warm = 0; warm < 400; warm++) renderer.render(frame);
    const roundMedians = Object.fromEntries(variants.map(label => [label, []]));
    const wallMedians = Object.fromEntries(variants.map(label => [label, []]));
    const errors = [];
    const drain = () => {
      for (let error = context.getError(); error !== context.NO_ERROR && errors.length < 8; error = context.getError()) errors.push(error);
    };
    drain();
    for (let round = 0; round < rounds; round++) {
      for (const label of rotatedOrder(variants, round)) {
        configure(label);
        const result = await timeFrames({ renderer, context, canvas, timer, frame, frames, segmented: false });
        roundMedians[label].push(median(result.gpu.slice(20).map(totalOf)));
        wallMedians[label].push(median(result.wall.slice(20)));
        drain();
      }
    }
    const capturedFrames = {};
    if (capture) {
      for (const label of variants.filter(name => name !== 'prepass-only')) {
        configure(label);
        renderer.render(frame);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        let binary = '';
        for (let offset = 0; offset < pixels.length; offset += 0x8000) binary += String.fromCharCode(...pixels.subarray(offset, offset + 0x8000));
        capturedFrames[label] = btoa(binary);
      }
    }
    drain();
    const summary = Object.fromEntries(variants.map(label => [label, {
      gpuMsLowestRound: Number(Math.min(...roundMedians[label]).toFixed(3)),
      gpuMsMedianOfRounds: Number(median(roundMedians[label]).toFixed(3)),
      gpuMsRounds: roundMedians[label].map(value => Number(value.toFixed(3))),
      wallMsMedianOfRounds: Number(median(wallMedians[label]).toFixed(3)),
    }]));
    const { twinUniformCalls, ...programState } = programs.state;
    return { opaqueOrder: summary, prepass: { prepassFrames: programState.prepassFrames, plainFrames: programState.plainFrames, prepassDraws: programState.prepassDraws, colourDraws: programState.colourDraws, twinUniformCalls }, glErrors: errors, rounds, frames, capturedFrames };
  } finally {
    programs.uninstall();
  }
}
