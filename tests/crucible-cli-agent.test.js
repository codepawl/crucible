import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_TOKENS,
  MODEL_ALIASES,
  parseAgentArguments,
  resolveModelId,
  runAgentCommand,
} from '../bin/crucible-agent.mjs';
import {
  CORE_TOOL_NAMES,
  createCrucibleMcpClient,
} from '../bin/crucible-mcp-client.mjs';

async function createTempDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

async function writeMockMcpServer(directory) {
  const scriptPath = join(directory, 'mock-mcp-server.mjs');
  const scriptSource = `
import { readFileSync } from 'node:fs';
let buffer = '';
let currentRecipe = null;
let revision = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

const ALL_TOOLS = [
  'scene_capabilities', 'scene_create', 'scene_apply', 'scene_inspect', 'scene_look',
  'mesh_inspect', 'mesh_edit', 'scene_checkpoint', 'scene_restore', 'scene_review',
  'scene_export_recipe', 'scene_dispose', 'scene_asset_catalog', 'scene_create_asset', 'scene_ask_user',
  'scene_render_submit', 'extra_unlisted_tool'
].map(name => ({
  name,
  description: 'Mock ' + name,
  inputSchema: { type: 'object', properties: {} },
}));

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\\n');
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf('\\n');
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } } });
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools: ALL_TOOLS } });
    } else if (request.method === 'tools/call') {
      const toolName = request.params?.name;
      const toolArguments = request.params?.arguments ?? {};
      if (toolName === 'scene_create') {
        currentRecipe = structuredClone(toolArguments.recipe ?? { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
        revision = 0;
        const payload = {
          sessionId: 'session-mock-1',
          revision,
          inspection: {
            counts: {
              parts: (currentRecipe.nodes ?? []).length,
              geometries: (currentRecipe.geometries ?? []).length,
              materials: (currentRecipe.materials ?? []).length,
            },
            nodes: currentRecipe.nodes ?? [],
          },
        };
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
      } else if (toolName === 'scene_apply') {
        revision += 1;
        for (const operation of toolArguments.operations ?? []) {
          if (operation.type === 'add-node') {
            currentRecipe.nodes = [...(currentRecipe.nodes ?? []), operation.node];
          }
        }
        const payload = { sessionId: 'session-mock-1', revision, committed: true };
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
      } else if (toolName === 'scene_look') {
        const payload = { width: 64, height: 64, revision };
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [
              { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' },
              { type: 'text', text: JSON.stringify(payload) },
            ],
            structuredContent: payload,
          },
        });
      } else if (toolName === 'scene_export_recipe') {
        const payload = { sessionId: 'session-mock-1', revision, recipe: currentRecipe };
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
      } else if (toolName === 'scene_inspect') {
        const payload = { sessionId: 'session-mock-1', revision, callCount: toolArguments.tag ?? 'ok' };
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
      } else {
        const payload = { ok: true, toolName };
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
      }
    }
  }
});
`;
  await writeFile(scriptPath, scriptSource, 'utf8');
  return scriptPath;
}

async function startMockAgentProxy(handler, { usageCredits = 242 } = {}) {
  const capturedRequests = [];
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/v1/messages') {
      const bodyText = await readRequestBody(request);
      const parsedBody = JSON.parse(bodyText);
      capturedRequests.push({
        headers: request.headers,
        body: parsedBody,
      });
      const reply = await handler(capturedRequests.length - 1, parsedBody, request.headers);
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
      return;
    }
    if (requestUrl.pathname === '/v1/usage') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ creditsRemaining: usageCredits }));
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    capturedRequests,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

test('parseAgentArguments resolves model aliases, defaults, and rejects invalid flags', () => {
  assert.equal(resolveModelId(), MODEL_ALIASES.haiku);
  assert.equal(resolveModelId('sonnet'), 'claude-sonnet-5-5');
  assert.equal(resolveModelId('opus'), 'claude-opus-5-5');
  assert.equal(resolveModelId('claude-custom-model'), 'claude-custom-model');

  const parsed = parseAgentArguments(['Build a lamp', '--model', 'sonnet', '--max-turns', '12', '--backend', 'cpu', '--json', '--quiet']);
  assert.equal(parsed.prompt, 'Build a lamp');
  assert.equal(parsed.modelId, 'claude-sonnet-5-5');
  assert.equal(parsed.maxTurns, 12);
  assert.equal(parsed.backend, 'cpu');
  assert.equal(parsed.json, true);
  assert.equal(parsed.quiet, true);
  assert.match(parsed.outPath, /scene\.json$/);

  const sceneDefault = parseAgentArguments(['Edit scene', '--scene', 'desk.json']);
  assert.match(sceneDefault.outPath, /desk\.json$/);

  assert.throws(() => parseAgentArguments([]), /Pass a prompt string/);
  assert.throws(() => parseAgentArguments(['prompt', '--max-turns', '0']), /from 1 to 60/);
  assert.throws(() => parseAgentArguments(['prompt', '--max-turns', '61']), /from 1 to 60/);
  assert.throws(() => parseAgentArguments(['prompt', '--backend', 'vulkan']), /cpu or gpu/);
  assert.throws(() => parseAgentArguments(['prompt', '--unknown']), /unknown option/);
});

test('crucible-mcp-client filters tools strictly to CORE_TOOL_NAMES and closes child cleanly', async () => {
  const temporaryDirectory = await createTempDirectory('crucible-mcp-client-');
  try {
    const mockMcpPath = await writeMockMcpServer(temporaryDirectory);
    const client = await createCrucibleMcpClient({
      serverCommand: process.execPath,
      serverArgs: [mockMcpPath],
    });
    try {
      assert.deepEqual(client.tools.map(tool => tool.name), [...CORE_TOOL_NAMES]);
      assert.equal(client.tools.some(tool => tool.name === 'scene_render_submit'), false);
      assert.equal(client.tools.some(tool => tool.name === 'extra_unlisted_tool'), false);
    } finally {
      await client.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('crucible agent sends no system field, handles image tool results, and atomically writes --out after mutations', async () => {
  const temporaryDirectory = await createTempDirectory('crucible-agent-loop-');
  const mockMcpPath = await writeMockMcpServer(temporaryDirectory);
  const outPath = join(temporaryDirectory, 'out-scene.json');

  const proxy = await startMockAgentProxy((callIndex, body) => {
    assert.equal('system' in body, false, 'request body must NEVER include a system field');
    assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });

    if (callIndex === 0) {
      return {
        body: {
          id: 'msg_1',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'scene_create',
              input: {
                recipe: {
                  format: 'crucible.scene',
                  schemaVersion: 1,
                  geometries: [{ id: 'cube', type: 'box' }],
                  materials: [{ id: 'clay', color: [0.8, 0.4, 0.3] }],
                  nodes: [{ id: 'mug', geometry: 'cube', material: 'clay' }],
                },
              },
            },
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'scene_look',
              input: {},
            },
          ],
        },
      };
    }

    if (callIndex === 1) {
      const toolResults = body.messages.at(-1).content;
      assert.equal(toolResults.length, 2);
      const imageBlock = toolResults[1].content.find(block => block.type === 'image');
      assert.ok(imageBlock, 'image MCP block must be forwarded in tool_result');
      assert.equal(imageBlock.source.type, 'base64');
      assert.equal(imageBlock.source.media_type, 'image/png');
      return {
        body: {
          id: 'msg_2',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call_3',
              name: 'scene_apply',
              input: {
                expectedRevision: 0,
                operations: [{ type: 'add-node', node: { id: 'handle', geometry: 'cube', material: 'clay' } }],
              },
            },
          ],
        },
      };
    }

    return {
      body: {
        id: 'msg_3',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Created the mug scene with a handle.' }],
      },
    };
  });

  try {
    const environment = {
      CRUCIBLE_AGENT_TOKEN: 'test-bearer-token',
      CRUCIBLE_AGENT_PROXY: proxy.proxyUrl,
    };
    const stdoutLines = [];
    const stderrLines = [];
    const exitCode = await runAgentCommand(
      ['Make a ceramic mug', '--out', outPath, '--json'],
      {
        environment,
        log: line => stdoutLines.push(line),
        error: line => stderrLines.push(line),
        mcpClientOptions: {
          serverCommand: process.execPath,
          serverArgs: [mockMcpPath],
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(proxy.capturedRequests.length, 3);
    assert.equal(proxy.capturedRequests[0].headers.authorization, 'Bearer test-bearer-token');
    assert.match(proxy.capturedRequests[0].headers['x-crucible-run-id'], /^[0-9a-f-]{36}$/i);

    const summary = JSON.parse(stdoutLines[0]);
    assert.equal(summary.ok, true);
    assert.equal(summary.recipeUpdated, true);
    assert.equal(summary.turns, 3);
    assert.equal(summary.creditsRemaining, 242);
    assert.equal(summary.text, 'Created the mug scene with a handle.');

    const writtenRecipe = JSON.parse(await readFile(outPath, 'utf8'));
    assert.deepEqual(writtenRecipe.nodes.map(node => node.id), ['mug', 'handle']);
    const remainingFiles = await readdir(temporaryDirectory);
    assert.equal(remainingFiles.some(fileName => fileName.endsWith('.tmp')), false);
  } finally {
    await proxy.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('crucible agent opens --scene with opening digest and blocks 3 identical tool calls in a row', async () => {
  const temporaryDirectory = await createTempDirectory('crucible-agent-repeat-');
  const mockMcpPath = await writeMockMcpServer(temporaryDirectory);
  const scenePath = join(temporaryDirectory, 'existing.json');
  await writeFile(scenePath, JSON.stringify({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'wood', color: [0.5, 0.3, 0.1] }],
    nodes: [{ id: 'table', geometry: 'box', material: 'wood' }],
  }), 'utf8');

  const proxy = await startMockAgentProxy((callIndex, body) => {
    if (callIndex === 0) {
      assert.match(body.messages[0].content, /Opened scene from/);
      assert.match(body.messages[0].content, /Node IDs: table/);
      return {
        body: {
          id: 'msg_repeat',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'repeat_1', name: 'scene_inspect', input: { a: 1, b: 2 } },
            { type: 'tool_use', id: 'repeat_2', name: 'scene_inspect', input: { b: 2, a: 1 } },
            { type: 'tool_use', id: 'repeat_3', name: 'scene_inspect', input: { a: 1, b: 2 } },
          ],
        },
      };
    }
    const results = body.messages.at(-1).content;
    assert.equal(results[0].is_error, false);
    assert.equal(results[1].is_error, false);
    assert.equal(results[2].is_error, true);
    assert.match(results[2].content[0].text, /3 times in a row/);
    return {
      body: {
        id: 'msg_done',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Stopped repeating.' }],
      },
    };
  });

  try {
    const exitCode = await runAgentCommand(
      ['Inspect table', '--scene', scenePath, '--quiet'],
      {
        environment: { CRUCIBLE_AGENT_TOKEN: 'ci-token', CRUCIBLE_AGENT_PROXY: proxy.proxyUrl },
        log: () => {},
        error: () => {},
        mcpClientOptions: { serverCommand: process.execPath, serverArgs: [mockMcpPath] },
      },
    );
    assert.equal(exitCode, 0);
  } finally {
    await proxy.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('crucible agent prints actionable signed-out and HTTP 402 messages and honors CRUCIBLE_NO_PROMO', async () => {
  const temporaryDirectory = await createTempDirectory('crucible-agent-errors-');
  const mockMcpPath = await writeMockMcpServer(temporaryDirectory);

  const signedOutErrors = [];
  const signedOutCode = await runAgentCommand(['Make a box'], {
    environment: { CRUCIBLE_CONFIG_DIR: temporaryDirectory },
    log: () => {},
    error: line => signedOutErrors.push(line),
    mcpClientOptions: { serverCommand: process.execPath, serverArgs: [mockMcpPath] },
  });
  assert.equal(signedOutCode, 1);
  assert.match(signedOutErrors[0], /crucible auth login/);
  assert.match(signedOutErrors[0], /250 free credits, no card needed/);
  assert.match(signedOutErrors[0], /https:\/\/accounts\.codepawl\.com/);
  assert.match(signedOutErrors[0], /crucible-mcp/);

  const noPromoErrors = [];
  await runAgentCommand(['Make a box'], {
    environment: { CRUCIBLE_CONFIG_DIR: temporaryDirectory, CRUCIBLE_NO_PROMO: '1' },
    log: () => {},
    error: line => noPromoErrors.push(line),
    mcpClientOptions: { serverCommand: process.execPath, serverArgs: [mockMcpPath] },
  });
  assert.doesNotMatch(noPromoErrors[0], /250 free credits/);

  const proxy402 = await startMockAgentProxy(() => ({
    status: 402,
    body: { error: { message: 'Out of credits' } },
  }));
  try {
    const creditsErrors = [];
    const creditsCode = await runAgentCommand(['Make a box', '--quiet'], {
      environment: { CRUCIBLE_AGENT_TOKEN: 'ci-token', CRUCIBLE_AGENT_PROXY: proxy402.proxyUrl },
      log: () => {},
      error: line => creditsErrors.push(line),
      mcpClientOptions: { serverCommand: process.execPath, serverArgs: [mockMcpPath] },
    });
    assert.equal(creditsCode, 1);
    assert.match(creditsErrors[0], /HTTP 402/);
    assert.match(creditsErrors[0], /https:\/\/accounts\.codepawl\.com\/account/);
    assert.match(creditsErrors[0], /crucible-mcp/);
  } finally {
    await proxy402.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
