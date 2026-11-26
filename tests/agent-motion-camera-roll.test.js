import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeDiagnostics } from '../src/agent-diagnostics.js';

test('recipeDiagnostics warns on static camera.roll outside +/-pi even without motion or loaded motion module (#3444)', () => {
  const base = { geometries: [], materials: [], nodes: [] };
  const within = recipeDiagnostics({ ...base, camera: { roll: Math.PI } });
  assert.equal(within.some(entry => entry.kind === 'camera-roll-range'), false);

  const over = recipeDiagnostics({ ...base, camera: { roll: 10 } });
  const warning = over.find(entry => entry.kind === 'camera-roll-range');
  assert.equal(warning?.severity, 'warning');
  assert.equal(warning?.target, 'camera.roll');
  assert.match(warning?.message ?? '', /radians.*degrees/i);
});
