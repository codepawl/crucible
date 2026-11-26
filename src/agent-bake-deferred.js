import { contentFingerprint } from './content-fingerprint.js';
import { createFlushSearchRunner } from './flush-search-runner.js';
import { environmentLinksLights } from './agent-look.js';
import { bakeInputs, placeOutputs, reusedOrTraced, bakeChangedPartsSteps, traceGridOutputs, lightmapOutputsFrom, withStagedMaterials, withLocalVolumeReport } from './agent-bake.js';

// An edit of a built scene that shows before its light bake is done (#3052). Loads on demand with the bake module, and only an
// edited scene runs it, so the core scene bundle does not carry it.

/**
 * Everything a bake reads, taken now: the snapshots copy each part's material, so the bake can run later (#3052), in slices,
 * after the staged materials have gone back (see withStagedMaterials). Pass the result to `deferredBakeSteps`.
 */
export function prepareDeferredBake(parts, worldMatrices, environment, settings, generatedGeometryGenerators) {
  return { parts, settings, ...bakeInputs(parts, worldMatrices, environment, settings, generatedGeometryGenerators) };
}

/**
 * The bake of `prepareDeferredBake` as steps, for the runner of a scene whose edit shows before its bake is done. `settleSteps(parts)`
 * is the scene's own work on the baked parts (its floor sky trace), run in slices before the bake lands. Returns
 * `{ baked }`, the same as `bakeAgentParts`, or `{ refusal }` when a size or time limit stopped it, because nobody waits to
 * read an error: the scene stays as it is, drawn without the bake.
 */
export function* deferredBakeSteps({ parts, snapshots, lighting, settings }, settleSteps) {
  try {
    const outputs = yield* reusedOrTraced(snapshots, lighting, settings, () => traceOutputsInSlices(snapshots, lighting, settings));
    yield;
    const baked = placeOutputs(parts, outputs, settings);
    yield;
    yield* settleSteps(baked.parts);
    return { baked };
  } catch (error) {
    if (error instanceof RangeError || /passed maxSeconds/.test(error.message)) {
      return { refusal: error.message };
    }
    throw error;
  }
}

// The parts an edit shows while its bake runs, when the last light is kept: a part the edit left as it was keeps the part the
// scene drew before (its baked light, floor sky and reflections). A part whose mesh changed, or whose material changed, is
// drawn without light, because the old light has the old shape or the old colour in it.
function partsKeepingLastLight(sourceRestParts, previous, unlitNames) {
  // The parts of a node with material slots share its name, so they are told apart by slot.
  const keyOf = part => (part.materialSlot === undefined ? part.name : `${part.name}#slot-${part.materialSlot}`);
  const previousSource = new Map(previous.sourceRestParts.map(part => [keyOf(part), part]));
  const previousDrawn = new Map(previous.restParts.map(part => [keyOf(part), part]));
  return Object.freeze(sourceRestParts.map(part => (previousSource.get(keyOf(part)) === part && !unlitNames.has(part.name) ? previousDrawn.get(keyOf(part)) ?? part : part)));
}

function nodesOfChangedMaterials(recipe, stagedMaterialSnapshots) {
  const changed = new Set();
  for (const { id, holder, snapshot } of stagedMaterialSnapshots) {
    const before = contentFingerprint(holder.snapshot);
    if (before === null || before !== contentFingerprint(snapshot)) {
      changed.add(id);
    }
  }
  return new Set(recipe.nodes.filter(node => changed.has(node.material)).map(node => node.id));
}

/**
 * The bake of an edit that does not wait for it (#3052). `settling` is the scene's own record: `settling.pending` is the plan
 * of the bake that is running. `stageSettling` answers like a bake that has not finished: the parts to show now and a plan. A
 * second edit that changes nothing the bake reads keeps the running plan.
 */
export function stageSettling(settling, mode, { key, recipe, sourceRestParts, worldMatrices, generatedGeometryGenerators, stagedMaterialSnapshots, lightBake, state }) {
  const keeps = settling.pending?.key === key && settling.pending.sourceRestParts === sourceRestParts;
  const prepare = () => withStagedMaterials(stagedMaterialSnapshots, () => prepareDeferredBake(sourceRestParts, worldMatrices, recipe.environment, recipe.bake, generatedGeometryGenerators));
  const plan = keeps ? settling.pending : { key, sourceRestParts, prepared: prepare(), runner: null };
  const keepsLastLight = mode === 'previous' && !environmentLinksLights(recipe.environment);
  const parts = keepsLastLight ? partsKeepingLastLight(sourceRestParts, state, nodesOfChangedMaterials(recipe, stagedMaterialSnapshots)) : sourceRestParts;
  return { pending: true, plan, parts, report: { ...lightBake?.report, pending: true }, reused: false };
}

/**
 * Runs the plan of the edit that committed, in slices of a few milliseconds on the same thread, and drops the plan of an edit
 * that came before. `onSettled(plan, outcome)` is the scene's turn to swap the baked parts in.
 */
export function adoptSettling(settling, plan, onSettled, settleSteps) {
  if (plan === settling.pending) {
    return;
  }
  settling.pending?.runner.cancel();
  settling.pending = null;
  if (!plan) {
    return;
  }
  settling.pending = plan;
  plan.runner = createFlushSearchRunner({
    steps: deferredBakeSteps(plan.prepared, settleSteps),
    onDone: outcome => {
      settling.pending = null;
      onSettled(plan, outcome);
    },
    onFailure: () => {
      settling.pending = null;
    },
  });
}

/** What the scene keeps once a plan's bake is done: the bake (null when a limit stopped it), why it was skipped and its report. */
export function settledBake(plan, { baked, refusal }, recipe) {
  const lightBake = baked ? { key: plan.key, currentKey: plan.key, sourceRestParts: plan.sourceRestParts, parts: baked.parts, report: baked.report } : null;
  const report = baked ? withLocalVolumeReport({ ...baked.report, reused: false }, recipe.environment.localVolumes) : null;
  return { lightBake, bakeSkipped: refusal ?? null, bakeReport: report };
}

// Only the lightmap trace has checkpoints inside it; the grid and the probes run as one step each.
function* traceOutputsInSlices(snapshots, lighting, settings) {
  yield;
  if (settings.irradianceGrid) {
    return traceGridOutputs(snapshots, lighting, settings);
  }
  const kernelResult = yield* bakeChangedPartsSteps(snapshots, lighting, settings);
  yield;
  return lightmapOutputsFrom(kernelResult, snapshots, lighting, settings);
}
