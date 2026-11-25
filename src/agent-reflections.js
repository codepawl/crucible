import { NO_REFLECTIVE_PART, traceObjectProbes } from './probe-trace.js';
import { placeProbes } from './reflection-probes.js';

// Object reflections: every smooth metal part of a recipe gets a probe of its own, traced from the scene around it, so
// a chrome sphere shows the floor and its neighbours and not only the sky. A scene with no such part never loads this
// module, and one that has it pays one small trace when the parts, lights or materials change.

/**
 * Places an object probe on each reflective part. `sourceParts` hold world matrices at rest and are what the probes see;
 * `drawnParts` are the same parts after any bake, and the result keeps their order.
 * Returns the parts as given when the scene has nothing to reflect (no reflective part, one part, or too many reflective
 * parts), with a report that says why.
 */
export function placeObjectReflections(sourceParts, drawnParts, environment, environmentMap) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    spotLights: environment.spotLights,
    areaLights: environment.areaLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    lightDirection: environment.lightDirection,
  };
  const trace = traceObjectProbes(sourceParts, lighting, { environment, environmentMap, rotation: environmentMap?.rotation ?? 0 });
  if (trace.traced.length === 0) {
    return { parts: drawnParts, report: { placed: 0, skipped: trace.skipped } };
  }
  const placed = placeProbes(drawnParts, trace, { rotation: environmentMap?.rotation ?? 0 });
  return { parts: placed.parts, report: { placed: placed.report.placed.length, partsWithProbe: placed.report.partsWithProbe, seconds: trace.seconds } };
}

/**
 * The recipe stage: places the probes, and traces again only when the parts, lights, setup or materials change.
 * `cache` is what the last call returned (or null); the result of the new call is its `result`, null when no part got a probe.
 */
export function stageObjectReflections(cache, recipe, sourceParts, drawnParts, graph, environmentMap) {
  const { environment } = recipe;
  const worldMatrices = new Float32Array(sourceParts.length * 16);
  sourceParts.forEach((part, index) => worldMatrices.set(graph.getNode(part.name).worldMatrix, index * 16));
  const key = JSON.stringify([environment.pointLights, environment.spotLights, environment.areaLights, environment.keyColor, environment.keyIntensity, environment.lightDirection,
    environment.skyTop, environment.skyBottom, environment.setup, environment.hdri, environment.reflectionHdri, environment.keyFromHdri, environment.environmentIntensity, environment.environmentRotation, environment.sky, recipe.materials]);
  if (cache?.key === key && cache.sourceParts === sourceParts && cache.drawnParts === drawnParts && sameFloats(cache.worldMatrices, worldMatrices)) {
    return cache;
  }
  const placed = placeObjectReflections(sourceParts, drawnParts, environment, environmentMap);
  const skipped = placed.report.placed > 0 || placed.report.skipped === NO_REFLECTIVE_PART ? null : placed.report.skipped ?? null;
  return { key, worldMatrices, sourceParts, drawnParts, result: placed.report.placed > 0 ? placed : null, skipped };
}

/** The scene_inspect and scene_apply diagnostic for smooth metal that keeps only the sky reflection because the automatic probes were skipped. */
export function reflectionSkippedDiagnostic(reason) {
  return {
    kind: 'reflection-skipped', severity: 'warning', target: 'environment.objectReflections',
    message: `Smooth metal parts reflect only the sky: the automatic object reflection probes were skipped (${reason}).`,
    fix: 'Use fewer triangles or fewer reflective parts so the probes can trace, or set environment.objectReflections to false (scene_apply set-environment) to turn them off and drop this warning.',
  };
}

function sameFloats(first, second) {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}
