import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';
import { withoutDerivedSkyColors, withSnapshotSkyColors } from '../scripts/snapshot-sky-colors.mjs';

// #2820: a render job builds the scene again from its snapshot, and the snapshot of a gradient sky holds skyTop,
// skyBottom and fogColor as radiance, above 1 for a bright stop, where the 0 to 1 check of a hand-written colour rejects them.
const BRIGHT_SKY = { type: 'gradient', stops: [{ at: 0, color: '#d8f3f7' }, { at: 1, color: '#2a6fd0' }] };

function brightSnapshotRecipe(environment = {}) {
  const normalized = normalizeAgentLook({ environment: { sky: BRIGHT_SKY, ...environment } }).environment;
  assert.ok(normalized.skyBottom.some(channel => channel > 1), 'the stop must be brighter than 1 for this test to mean anything');
  return { format: 'crucible.scene', schemaVersion: 1, environment: normalized };
}

test('a snapshot of a bright gradient sky builds again and derives the same sky colours', () => {
  const recipe = brightSnapshotRecipe();
  assert.throws(() => normalizeAgentLook({ environment: recipe.environment }), /environment\.skyBottom\[1\].*0 to 1/);
  const rebuilt = normalizeAgentLook({ environment: withoutDerivedSkyColors(recipe).environment }).environment;
  assert.deepEqual(rebuilt.skyBottom, recipe.environment.skyBottom);
  assert.deepEqual(rebuilt.skyTop, recipe.environment.skyTop);
  assert.deepEqual(rebuilt.fogColor, recipe.environment.fogColor);
});

test('a fogColor set beside the gradient sky survives the snapshot', () => {
  const recipe = brightSnapshotRecipe({ fogColor: [0.2, 0.3, 0.4] });
  const rebuilt = normalizeAgentLook({ environment: withoutDerivedSkyColors(recipe).environment }).environment;
  assert.deepEqual(rebuilt.fogColor, [0.2, 0.3, 0.4]);
});

test('recipes without a gradient sky pass through untouched', () => {
  const plain = { format: 'crucible.scene', schemaVersion: 1, environment: { skyTop: [0.1, 0.2, 0.3] } };
  assert.equal(withoutDerivedSkyColors(plain), plain);
  const holder = { recipe: plain, clips: [] };
  assert.equal(withSnapshotSkyColors(holder).recipe, plain);
  assert.equal(withSnapshotSkyColors(undefined), undefined);
});
