import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';
import { createScratchDirectory } from './scratch-directory.mjs';

// Drives the installed MCP server on SwiftShader: scene_review with wedge draws a grid for a material, a sun, an effect and a lamp field
// and leaves the recipe, revision, branches and checkpoints as they were. Pass an output folder to keep the grids as PNG files.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await createScratchDirectory('crucible-wedge-proof-');
const outputFolder = process.argv[3] ? resolve(process.argv[3]) : undefined;
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const transport = new PatientStdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96'], cwd: directory, stderr: 'pipe' });
const client = new Client({ name: 'crucible-wedge-proof', version: '1' });

async function call(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

// The wedge tests read like a call: target, parameter and values sit beside the review fields and move into the wedge option here.
function asReview({ target, parameter, values, ...reviewFields }) {
  return { ...reviewFields, wedge: { target, parameter, values } };
}

async function rejected(argumentsValue, pattern) {
  const result = await client.callTool({ name: 'scene_review', arguments: asReview(argumentsValue) }, { timeout: 120000 });
  assert.equal(result.isError, true, `scene_review wedge must reject ${JSON.stringify(argumentsValue).slice(0, 100)}`);
  assert.match(result.content.find(item => item.type === 'text').text, pattern);
}

function pngSize(result) {
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function wedge(label, argumentsValue, expectedGrid) {
  const result = await call('scene_review', asReview(argumentsValue));
  const { bytes, width, height } = pngSize(result);
  assert.deepEqual([width, height], expectedGrid, `${label} grid size`);
  assert.equal(result.structuredContent.shots.length, argumentsValue.values.length, `${label} shots`);
  if (outputFolder) {
    await mkdir(outputFolder, { recursive: true });
    await writeFile(join(outputFolder, `wedge-${label}.png`), bytes);
  }
  return result;
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
  const { sessionId } = created;
  const settings = { sessionId, expectedRevision: 0 };
  await call('scene_checkpoint', { sessionId });
  await call('scene_apply', { ...settings, branch: 'keep-me', operations: [{ type: 'set-material', id: 'brass', roughness: 0.9 }] });
  const recipeBefore = (await call('scene_export_recipe', { sessionId })).structuredContent;
  const inspectBefore = (await call('scene_inspect', { sessionId })).structuredContent;
  // kernels holds build timings, which change from one inspect to the next; everything else must be equal.
  delete inspectBefore.kernels;

  await wedge('roughness', { ...settings, target: 'brass', parameter: 'roughness', values: [0.1, 0.3, 0.6, 0.9] }, [640, 688]);
  await wedge('sun-angle', { ...settings, target: 'environment', parameter: 'lightDirection',
    values: [[-1, -0.3, -0.5], [-0.5, -0.8, -0.5], [0, -1, -0.2], [0.6, -0.7, 0.3]] }, [640, 688]);
  await wedge('exposure', { ...settings, target: 'effects', parameter: 'exposure', values: [0.5, 1, 2], width: 160, height: 160 }, [320, 368]);
  await wedge('lamp', { ...settings, target: 'environment', parameter: 'pointLights', values: [
    [{ position: [1, 2, 1], intensity: 2 }], [{ position: [1, 2, 1], intensity: 8 }]] , width: 160, height: 160 }, [320, 184]);

  await rejected({ ...settings, target: 'brass', parameter: 'roughness', values: [0.5] }, /values/);
  await rejected({ ...settings, target: 'brass', parameter: 'roughness', values: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, /values/);
  await rejected({ ...settings, target: 'no-such-material', parameter: 'roughness', values: [0.2, 0.4] }, /existing material ID/);
  await rejected({ ...settings, target: 'brass', parameter: 'roughness', values: [0.2, 5] }, /values\[1\]/);
  await rejected({ ...settings, expectedRevision: 9, target: 'brass', parameter: 'roughness', values: [0.2, 0.4] }, /revision/i);

  const recipeAfter = (await call('scene_export_recipe', { sessionId })).structuredContent;
  const inspectAfter = (await call('scene_inspect', { sessionId })).structuredContent;
  delete inspectAfter.kernels;
  assert.equal(JSON.stringify(recipeAfter), JSON.stringify(recipeBefore), 'recipe is byte for byte the same after wedges');
  assert.equal(JSON.stringify(inspectAfter), JSON.stringify(inspectBefore), 'revision and nodes are the same after wedges');
  const keep = await call('scene_look', { sessionId, width: 64, height: 64 });
  assert.equal(keep.structuredContent.revision, inspectBefore.revision);
  console.log('Wedge smoke passed');
} finally {
  await client.close().catch(() => {});
}
