// Zero-dependency stdio JSON-RPC 2.0 MCP client for `crucible agent`.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const MAX_STDERR_BYTES = 8192;

export const CORE_TOOL_NAMES = Object.freeze([
  'scene_capabilities',
  'scene_create',
  'scene_apply',
  'scene_inspect',
  'scene_look',
  'mesh_inspect',
  'mesh_edit',
  'scene_checkpoint',
  'scene_restore',
  'scene_review',
  'scene_export_recipe',
  'scene_dispose',
  'scene_asset_catalog',
  'scene_create_asset',
  'scene_ask_user',
]);

const CORE_TOOL_SET = new Set(CORE_TOOL_NAMES);

export const MUTATING_TOOL_NAMES = new Set([
  'scene_create',
  'scene_create_asset',
  'scene_apply',
  'scene_restore',
  'mesh_edit',
  'mesh_stack',
]);

export async function writeJsonAtomically(filePath, value) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(resolvedPath)}.${process.pid}-${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, serialized, 'utf8');
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return resolvedPath;
}

export function parseToolResultPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of contentBlocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        // Non-JSON text blocks are ignored here.
      }
    }
  }
  return null;
}

export function extractToolErrorText(result) {
  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  const textParts = contentBlocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean);
  return textParts.join('\n') || 'MCP tool call failed.';
}

export function toAnthropicToolDefinitions(mcpTools) {
  const list = Array.isArray(mcpTools) ? mcpTools : [];
  const byName = new Map();
  for (const tool of list) {
    if (tool && typeof tool.name === 'string' && CORE_TOOL_SET.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }
  const definitions = [];
  for (const name of CORE_TOOL_NAMES) {
    const tool = byName.get(name);
    if (!tool) {
      continue;
    }
    definitions.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    });
  }
  return definitions;
}

export function buildOpeningSceneDigest({ scenePath, createResult, recipe }) {
  const payload = parseToolResultPayload(createResult) ?? {};
  const inspection = payload.inspection ?? {};
  const counts = inspection.counts ?? {};
  const partsCount = counts.parts ?? (Array.isArray(recipe?.nodes) ? recipe.nodes.length : 0);
  const geometriesCount = counts.geometries ?? (Array.isArray(recipe?.geometries) ? recipe.geometries.length : 0);
  const materialsCount = counts.materials ?? (Array.isArray(recipe?.materials) ? recipe.materials.length : 0);
  const nodeList = Array.isArray(inspection.nodes)
    ? inspection.nodes
    : Array.isArray(recipe?.nodes)
      ? recipe.nodes
      : [];
  const nodeIds = nodeList
    .map(node => node?.id)
    .filter(id => typeof id === 'string');
  const shownIds = nodeIds.slice(0, 25);
  const overflowCount = nodeIds.length - shownIds.length;
  const lines = [
    `Opened scene from ${scenePath} (sessionId: ${payload.sessionId ?? 'active'}, revision: ${payload.revision ?? 0}).`,
    `Counts: ${partsCount} part(s), ${geometriesCount} geometry definition(s), ${materialsCount} material(s).`,
  ];
  if (shownIds.length > 0) {
    const suffix = overflowCount > 0 ? ` (+${overflowCount} more)` : '';
    lines.push(`Node IDs: ${shownIds.join(', ')}${suffix}.`);
  }
  return lines.join('\n');
}

export async function createCrucibleMcpClient({
  backend,
  jobsDir,
  serverCommand = process.execPath,
  serverArgs,
  cwd = process.cwd(),
  environment = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  spawnImplementation = spawn,
} = {}) {
  const defaultArgs = [
    join(packageRoot, 'bin', 'crucible-mcp.mjs'),
    ...(backend ? ['--backend', backend] : []),
    ...(jobsDir ? ['--jobs', resolve(jobsDir)] : []),
    '--tools',
    CORE_TOOL_NAMES.join(','),
  ];
  const child = spawnImplementation(serverCommand, serverArgs ?? defaultArgs, {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextRequestId = 1;
  let stdoutBuffer = '';
  let stderrTail = '';
  let closed = false;
  const pendingRequests = new Map();

  const rejectAllPending = reason => {
    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pendingRequests.clear();
  };

  const exitPromise = new Promise(resolveExit => {
    child.once('close', (code, signal) => {
      closed = true;
      const suffix = stderrTail.trim() ? `\n${stderrTail.trim()}` : '';
      rejectAllPending(new Error(`MCP server exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}).${suffix}`));
      resolveExit({ code, signal });
    });
    child.once('error', error => {
      closed = true;
      rejectAllPending(error);
      resolveExit({ error });
    });
  });

  child.stderr?.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
  });

  child.stdout?.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pendingRequests.has(message.id)) {
        const entry = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          const errorMessage = message.error.message || JSON.stringify(message.error);
          const rpcError = new Error(`MCP error (${message.error.code ?? 'unknown'}): ${errorMessage}`);
          rpcError.code = message.error.code;
          entry.reject(rpcError);
        } else {
          entry.resolve(message.result);
        }
      }
    }
  });

  const sendMessage = payload => {
    if (closed || !child.stdin || child.stdin.destroyed) {
      throw new Error('MCP server connection is closed.');
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method, params) => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        rejectRequest(new Error(`MCP request "${method}" timed out after ${requestTimeoutMs} ms.`));
      }, requestTimeoutMs);
      timer.unref?.();
      pendingRequests.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        sendMessage({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        rejectRequest(error);
      }
    });
  };

  const notify = (method, params) => {
    sendMessage({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  };

  const close = async () => {
    if (closed) {
      await exitPromise;
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // Ignore stdin close errors during teardown.
    }
    let timeoutHandle;
    const waitResult = await Promise.race([
      exitPromise.then(() => 'exited'),
      new Promise(resolveWait => {
        timeoutHandle = setTimeout(() => resolveWait('timeout'), shutdownTimeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    clearTimeout(timeoutHandle);
    if (waitResult === 'timeout' && !closed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill failures if process already exited.
      }
      let forceTimeoutHandle;
      await Promise.race([
        exitPromise,
        new Promise(resolveForce => {
          forceTimeoutHandle = setTimeout(() => {
            if (!closed) {
              try {
                child.kill('SIGKILL');
              } catch {
                // Ignore kill failures.
              }
            }
            resolveForce();
          }, 1000);
          forceTimeoutHandle.unref?.();
        }),
      ]);
      clearTimeout(forceTimeoutHandle);
    }
  };

  let tools = [];
  let rawTools = [];

  try {
    await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'crucible-cli-agent', version: '1.0.0' },
    });
    notify('notifications/initialized');
    const listResponse = await request('tools/list', {});
    rawTools = Array.isArray(listResponse?.tools)
      ? listResponse.tools.filter(tool => tool && CORE_TOOL_SET.has(tool.name))
      : [];
    tools = toAnthropicToolDefinitions(rawTools);
  } catch (error) {
    await close();
    throw error;
  }

  const callTool = (name, toolArguments = {}) => request('tools/call', { name, arguments: toolArguments });

  const openScene = async scenePath => {
    const resolvedScenePath = resolve(scenePath);
    let rawSceneText;
    try {
      rawSceneText = await readFile(resolvedScenePath, 'utf8');
    } catch (error) {
      throw new Error(`Could not read --scene file ${resolvedScenePath}: ${error.message}`);
    }
    let recipe;
    try {
      recipe = JSON.parse(rawSceneText);
    } catch (error) {
      throw new Error(`--scene file ${resolvedScenePath} is not valid JSON: ${error.message}`);
    }
    const createResult = await callTool('scene_create', { recipe });
    if (createResult?.isError) {
      throw new Error(`Could not load --scene ${resolvedScenePath}: ${extractToolErrorText(createResult)}`);
    }
    const payload = parseToolResultPayload(createResult);
    return {
      createResult,
      sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null,
      digest: buildOpeningSceneDigest({ scenePath, createResult, recipe }),
    };
  };

  const exportAndWriteRecipe = async (outPath, { sessionId } = {}) => {
    const exportArguments = sessionId ? { sessionId } : {};
    const exportResult = await callTool('scene_export_recipe', exportArguments);
    if (exportResult?.isError) {
      throw new Error(`Failed to export updated recipe: ${extractToolErrorText(exportResult)}`);
    }
    const payload = parseToolResultPayload(exportResult);
    const recipe = payload?.recipe ?? payload;
    if (!recipe || typeof recipe !== 'object') {
      throw new Error('scene_export_recipe did not return a valid recipe object.');
    }
    const writtenPath = await writeJsonAtomically(outPath, recipe);
    return { outPath: writtenPath, recipe, revision: payload?.revision ?? null };
  };

  return {
    tools,
    rawTools,
    callTool,
    openScene,
    exportAndWriteRecipe,
    close,
  };
}
