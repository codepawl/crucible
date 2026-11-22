import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Runs the real MCP server on SwiftShader: scene_review wedge draws roughness, sun, effect and lamp grids and leaves the exported recipe,
// the inspected nodes and revision, the branches and the checkpoints byte for byte as they were. It needs the prepared preview
// bundle (npm run build && node scripts/build-mcp.mjs), so it skips without it.
const preview = fileURLToPath(new URL('../build/mcp/preview.js', import.meta.url));
const smoke = fileURLToPath(new URL('../scripts/smoke-agent-wedge.mjs', import.meta.url));

test('live MCP scene_review wedge leaves the scene unchanged and enforces its limits', {
  skip: existsSync(preview) ? false : 'needs build/mcp (npm run build && node scripts/build-mcp.mjs)',
  timeout: 240000,
}, () => {
  const result = spawnSync(process.execPath, [smoke], { encoding: 'utf8', windowsHide: true, timeout: 230000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Wedge smoke passed/);
});
