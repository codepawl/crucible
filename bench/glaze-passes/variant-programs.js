// Runs in the page (#2144). Emulates one colour program per material feature set without touching src/.
// At every draw of the main colour program it reads the feature uniforms the renderer just set (hasNormalMap, hasBaseMap, ...),
// compiles (once per set) a copy of the fragment shader whose `#define USES_X (uniform > n)` lines read `true` for a feature
// the draw uses and `false` for one it does not, copies the uniform values over, draws with that program and switches back.
// So the picture is the uber program's picture, and only the branches on uniforms have become compile time constants.
const FLOAT_TYPE = 0x1406;
const FLOAT_VECTOR_TYPES = new Map([[0x8b50, 2], [0x8b51, 3], [0x8b52, 4]]);
const INTEGER_TYPES = new Set([0x1404, 0x8b5e, 0x8b5f, 0x8b60, 0x8b62, 0x8dc1, 0x8dc2, 0x8dc5, 0x8dca, 0x8b56]);
const MATRIX_4_TYPE = 0x8b5c;
const MATRIX_3_TYPE = 0x8b5b;
const GATE_EXPRESSION = /^\((\w+)(?:\.(\w+))? > ([\d.]+)\)$/;

function readGate(context, main, locationOf, expression) {
  const match = GATE_EXPRESSION.exec(expression);
  if (!match) return null;
  const [, uniformName, component, threshold] = match;
  const location = locationOf(uniformName);
  if (location === null) return null;
  const value = context.getUniform(main, location);
  const number = component ? value[{ x: 0, y: 1, z: 2, w: 3 }[component]] : value;
  return number > Number(threshold);
}

function copyUniforms(context, from, to) {
  const count = context.getProgramParameter(from, context.ACTIVE_UNIFORMS);
  for (let index = 0; index < count; index++) {
    const info = context.getActiveUniform(from, index);
    const baseName = info.name.replace(/\[0\]$/, '');
    for (let element = 0; element < info.size; element++) {
      const name = info.size > 1 || info.name.endsWith('[0]') ? `${baseName}[${element}]` : baseName;
      const source = context.getUniformLocation(from, name);
      const target = context.getUniformLocation(to, name);
      if (source === null || target === null) continue;
      const value = context.getUniform(from, source);
      if (info.type === FLOAT_TYPE) context.uniform1f(target, value);
      else if (FLOAT_VECTOR_TYPES.has(info.type)) context[`uniform${FLOAT_VECTOR_TYPES.get(info.type)}fv`](target, value);
      else if (INTEGER_TYPES.has(info.type)) context.uniform1i(target, value);
      else if (info.type === MATRIX_4_TYPE) context.uniformMatrix4fv(target, false, value);
      else if (info.type === MATRIX_3_TYPE) context.uniformMatrix3fv(target, false, value);
      else throw new Error(`Variant emulation does not copy uniform ${info.name} of GL type ${info.type}.`);
    }
  }
}

export function installVariantEmulation({ keepUniformGates = false } = {}) {
  const prototype = WebGL2RenderingContext.prototype;
  const original = {};
  for (const name of ['shaderSource', 'attachShader', 'linkProgram', 'useProgram', 'drawElementsInstanced']) original[name] = prototype[name];
  const colourSources = new Map();
  const programsWithColourShader = new Set();
  let main = null;
  let mainRecord = null;
  let currentProgram = null;
  let switching = false;
  const variants = new Map();
  const statistics = { drawsOnMain: 0, drawsOnVariants: 0, variantsCompiled: 0, compileMs: 0, gatesUnreadable: 0 };

  prototype.shaderSource = function shaderSource(shader, source) {
    if (source.includes('float shadowVisibility')) colourSources.set(shader, source);
    return original.shaderSource.call(this, shader, source);
  };
  prototype.attachShader = function attachShader(program, shader) {
    if (colourSources.has(shader)) programsWithColourShader.add(program);
    return original.attachShader.call(this, program, shader);
  };
  prototype.linkProgram = function linkProgram(program) {
    original.linkProgram.call(this, program);
    if (switching || !programsWithColourShader.has(program) || main) return;
    const shaders = this.getAttachedShaders(program);
    const fragment = shaders.find(shader => colourSources.has(shader));
    main = program;
    mainRecord = { context: this, vertex: shaders.find(shader => shader !== fragment), source: colourSources.get(fragment), locations: new Map() };
  };
  prototype.useProgram = function useProgram(program) {
    if (!switching) currentProgram = program;
    return original.useProgram.call(this, program);
  };

  function locationOf(name) {
    if (!mainRecord.locations.has(name)) mainRecord.locations.set(name, mainRecord.context.getUniformLocation(main, name));
    return mainRecord.locations.get(name);
  }

  function variantFor(context) {
    const gatedLines = mainRecord.source.split('\n').filter(line => /^#define (USES_|BOX_MAPPED)/.test(line) && GATE_EXPRESSION.test(line.replace(/^#define \w+ /, '')));
    const decisions = gatedLines.map(line => {
      const [, macro, expression] = /^#define (\w+) (.*)$/.exec(line);
      const gate = readGate(context, main, locationOf, expression);
      if (gate === null) statistics.gatesUnreadable += 1;
      return { line, macro, gate };
    });
    const key = decisions.map(({ macro, gate }) => `${macro}=${gate}`).join(',');
    if (!variants.has(key)) variants.set(key, compileVariant(context, decisions, key));
    return variants.get(key);
  }

  function compileVariant(context, decisions, key) {
    const started = performance.now();
    let source = mainRecord.source;
    for (const { line, macro, gate } of decisions) {
      if (gate !== null && !keepUniformGates) source = source.replace(line, `#define ${macro} ${gate}`);
    }
    const fragment = context.createShader(context.FRAGMENT_SHADER);
    original.shaderSource.call(context, fragment, source);
    context.compileShader(fragment);
    if (!context.getShaderParameter(fragment, context.COMPILE_STATUS)) throw new Error('Variant compile failed: ' + context.getShaderInfoLog(fragment));
    const program = context.createProgram();
    switching = true;
    original.attachShader.call(context, program, mainRecord.vertex);
    original.attachShader.call(context, program, fragment);
    original.linkProgram.call(context, program);
    switching = false;
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error('Variant link failed: ' + context.getProgramInfoLog(program));
    statistics.variantsCompiled += 1;
    statistics.compileMs += performance.now() - started;
    return { program, key, activeUniforms: context.getProgramParameter(program, context.ACTIVE_UNIFORMS), sourceLines: source.split('\n').length, draws: 0 };
  }

  prototype.drawElementsInstanced = function drawElementsInstanced(...parameters) {
    if (!main || currentProgram !== main || switching) {
      return original.drawElementsInstanced.apply(this, parameters);
    }
    statistics.drawsOnMain += 1;
    const variant = variantFor(this);
    switching = true;
    original.useProgram.call(this, variant.program);
    copyUniforms(this, main, variant.program);
    original.drawElementsInstanced.apply(this, parameters);
    original.useProgram.call(this, main);
    switching = false;
    variant.draws += 1;
    statistics.drawsOnVariants += 1;
    return undefined;
  };

  return {
    describe: () => ({ ...statistics, compileMs: Number(statistics.compileMs.toFixed(0)), variants: [...variants.values()].map(({ key, activeUniforms, sourceLines, draws }) => ({ key, activeUniforms, sourceLines, draws })) }),
    uninstall() {
      for (const [name, method] of Object.entries(original)) prototype[name] = method;
    },
  };
}
