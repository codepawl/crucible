// Counts the draw calls and triangles a WebGL2 context receives. CrucibleRenderer.stats and the scene_inspect profile share it.

const DRAW_FUNCTIONS = Object.freeze(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']);

function trianglesOfDraw(context, mode, vertexCount) {
  if (mode === context.TRIANGLES) return vertexCount / 3;
  if (mode === context.TRIANGLE_STRIP || mode === context.TRIANGLE_FAN) return Math.max(0, vertexCount - 2);
  return 0;
}

/**
 * Counts the draw calls and triangles the context receives until `release` runs. The wrappers sit on the context object
 * itself, so no other context is touched, and `release` removes them.
 */
export function countDraws(context) {
  const counters = { drawCalls: 0, triangles: 0 };
  const wrapped = [];
  const record = (mode, vertexCount, instances = 1) => {
    counters.drawCalls += 1;
    counters.triangles += trianglesOfDraw(context, mode, vertexCount) * instances;
  };
  const argumentsOf = {
    drawElements: ([mode, count]) => record(mode, count),
    drawArrays: ([mode, , count]) => record(mode, count),
    drawElementsInstanced: ([mode, count, , , instances]) => record(mode, count, instances),
    drawArraysInstanced: ([mode, , count, instances]) => record(mode, count, instances),
  };
  for (const name of DRAW_FUNCTIONS) {
    const original = context[name];
    if (typeof original !== 'function') continue;
    const hadOwn = Object.hasOwn(context, name);
    context[name] = function countedDraw(...drawArguments) {
      argumentsOf[name](drawArguments);
      return original.apply(this, drawArguments);
    };
    wrapped.push({ name, original, hadOwn });
  }
  return {
    counters,
    release() {
      for (const { name, original, hadOwn } of wrapped) {
        if (hadOwn) context[name] = original;
        else delete context[name];
      }
    },
  };
}
