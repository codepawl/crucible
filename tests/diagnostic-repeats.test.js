import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAllAgentSceneModules } from '../src/agent-scene-modules.js';
import { createRepeatTracker, partFingerprint } from '../src/diagnostic-repeats.js';

await loadAllAgentSceneModules();

function node(id, translation, scale) {
  return { id, geometry: 'box', material: 'paint', translation, scale };
}

function sceneWithCoplanarPair() {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [node('wall', [0, 0, 0], [10, 4, 0.2]), node('sign', [0, 0, 0], [1, 0.5, 0.2]), node('crate', [30, 0, 0], [1, 1, 1])],
    environment: { resolveCoplanar: false },
  });
}

function overlapsOf(report) {
  return (report.diagnostics ?? []).filter(entry => entry.kind === 'coplanar-overlap');
}

function countLineOf(report) {
  return (report.diagnostics ?? []).find(entry => entry.kind === 'coplanar-overlap-unchanged');
}

test('an edit answer repeats a coplanar overlap only when one of its parts changed', () => {
  const scene = sceneWithCoplanarPair();
  assert.equal(overlapsOf(scene.editDiagnostics()).length, 1, 'the first answer reports the pair');

  scene.apply([{ type: 'set-node', id: 'crate', translation: [31, 0, 0] }], { expectedRevision: 0 });
  const unrelated = scene.editDiagnostics();
  assert.equal(overlapsOf(unrelated).length, 0, 'an unrelated batch does not repeat it');
  assert.equal(countLineOf(unrelated).count, 1);
  assert.match(countLineOf(unrelated).message, /^1 coplanar overlap reported earlier is unchanged/);

  scene.apply([{ type: 'set-node', id: 'sign', translation: [0.1, 0, 0] }], { expectedRevision: 1 });
  const moved = scene.editDiagnostics();
  assert.equal(overlapsOf(moved).length, 1, 'moving one part of the pair reports it again');
  assert.equal(countLineOf(moved), undefined);
});

test('scene_inspect still lists the overlap after an answer suppressed it', () => {
  const scene = sceneWithCoplanarPair();
  scene.editDiagnostics();
  assert.equal(overlapsOf(scene.inspect()).length, 1);
  assert.equal(overlapsOf(scene.inspect()).length, 1, 'inspect does not consume the report');
});

test('a finding that went away is reported again when it comes back', () => {
  const scene = sceneWithCoplanarPair();
  scene.editDiagnostics();
  scene.apply([{ type: 'set-node', id: 'sign', translation: [0, 0, 1] }], { expectedRevision: 0 });
  assert.equal(overlapsOf(scene.editDiagnostics()).length, 0);
  scene.apply([{ type: 'set-node', id: 'sign', translation: [0, 0, 0] }], { expectedRevision: 1 });
  assert.equal(overlapsOf(scene.editDiagnostics()).length, 1);
});

test('the tracker keeps at most its limit and leaves other findings alone', () => {
  const tracker = createRepeatTracker(2);
  const findings = ['a', 'b', 'c'].map(name => ({ kind: 'coplanar-overlap', nodes: [name], message: name }));
  tracker.filter(findings, () => '');
  const second = tracker.filter([...findings, { kind: 'bake-stale', message: 'x' }], () => '');
  assert.deepEqual(second.shown.map(entry => entry.message), ['c', 'x']);
  assert.equal(second.unchanged, 2);
  assert.equal(partFingerprint(undefined), '');
});
