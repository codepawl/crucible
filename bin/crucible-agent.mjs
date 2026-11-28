// Headless AI agent CLI (`crucible agent`) driving `crucible-mcp` via the Crucible agent proxy.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  ACCOUNTS_WEB_URL,
  AuthExpiredError,
  extractCreditsRemaining,
  fetchUsage,
  getValidAccessToken,
  isPromoSuppressed,
} from './crucible-auth.mjs';
import {
  CORE_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  createCrucibleMcpClient,
  parseToolResultPayload,
} from './crucible-mcp-client.mjs';

export const DEFAULT_MODEL_ALIAS = 'haiku';
export const DEFAULT_MAX_TURNS = 30;
export const MAX_ALLOWED_TURNS = 60;
export const DEFAULT_MAX_TOKENS = 16000;

export const MODEL_ALIASES = Object.freeze({
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
});

export const AGENT_USAGE = `Usage: crucible agent "<prompt>" [--scene <in.json>] [--out <out.json>] [--model <name>] [--max-turns <1..60>] [--backend cpu|gpu] [--jobs <dir>] [--json] [--quiet]`;

const AGENT_VALUE_FLAGS = new Set(['--scene', '--out', '--model', '--max-turns', '--backend', '--jobs']);
const AGENT_SWITCH_FLAGS = new Set(['--json', '--quiet']);

export function resolveModelId(modelName = DEFAULT_MODEL_ALIAS) {
  if (typeof modelName !== 'string' || !modelName.trim()) {
    throw new TypeError('--model: pass a model alias (haiku, sonnet, opus) or a model ID.');
  }
  const trimmed = modelName.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

export function parseAgentArguments(argumentList) {
  const options = {
    prompt: null,
    scene: null,
    out: null,
    model: DEFAULT_MODEL_ALIAS,
    maxTurns: DEFAULT_MAX_TURNS,
    backend: 'gpu',
    jobs: null,
    json: false,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      return options;
    }
    if (AGENT_SWITCH_FLAGS.has(argument)) {
      options[argument.slice(2)] = true;
      continue;
    }
    if (AGENT_VALUE_FLAGS.has(argument)) {
      const value = argumentList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError(`${argument}: pass a value after ${argument}.`);
      }
      index += 1;
      if (argument === '--max-turns') {
        const parsedTurns = Number(value);
        if (!Number.isInteger(parsedTurns) || parsedTurns < 1 || parsedTurns > MAX_ALLOWED_TURNS) {
          throw new RangeError(`--max-turns must be a whole number from 1 to ${MAX_ALLOWED_TURNS}, got "${value}".`);
        }
        options.maxTurns = parsedTurns;
      } else if (argument === '--backend') {
        if (value !== 'cpu' && value !== 'gpu') {
          throw new TypeError(`--backend must be cpu or gpu, got "${value}".`);
        }
        options.backend = value;
      } else {
        options[argument.slice(2)] = value;
      }
      continue;
    }
    if (argument.startsWith('--')) {
      throw new TypeError(`${argument}: unknown option for crucible agent.`);
    }
    if (options.prompt === null) {
      options.prompt = argument;
    } else {
      throw new TypeError(`Unexpected argument "${argument}": pass one prompt string in quotes.`);
    }
  }
  if (!options.prompt || !options.prompt.trim()) {
    throw new TypeError('Pass a prompt string, such as: crucible agent "Create a studio-lit ceramic mug".');
  }
  options.modelId = resolveModelId(options.model);
  options.outPath = resolve(options.out ?? options.scene ?? 'scene.json');
  return options;
}

export function signedOutAgentMessage(noPromo) {
  if (noPromo) {
    return `You are not signed in to Crucible. Run \`crucible auth login\` (${ACCOUNTS_WEB_URL}) to sign in, or connect your own agent with \`crucible-mcp\`.`;
  }
  return `You are not signed in to Crucible. Run \`crucible auth login\` (${ACCOUNTS_WEB_URL}) to get 250 free credits, no card needed. You can also connect your own agent free with \`crucible-mcp\`.`;
}

export function outOfCreditsMessage(noPromo) {
  if (noPromo) {
    return `Your Crucible account is out of credits (HTTP 402). Manage your account at ${ACCOUNTS_WEB_URL}/account, or connect your own agent with \`crucible-mcp\`.`;
  }
  return `Your Crucible account is out of credits (HTTP 402). Add credits at ${ACCOUNTS_WEB_URL}/account, or connect your own agent free with \`crucible-mcp\`.`;
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJsonStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function mapMcpContentToToolResultBlocks(mcpResult) {
  const rawBlocks = Array.isArray(mcpResult?.content) ? mcpResult.content : [];
  const mapped = [];
  for (const block of rawBlocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      mapped.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string') {
      mapped.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/png',
          data: block.data,
        },
      });
    }
  }
  if (mapped.length === 0) {
    mapped.push({ type: 'text', text: mcpResult?.isError ? 'Tool call failed with no output.' : 'OK' });
  }
  return mapped;
}

function extractAssistantText(contentBlocks) {
  const list = Array.isArray(contentBlocks) ? contentBlocks : [];
  return list
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

async function readProxyErrorDetail(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message ?? payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function callMessagesProxy({
  proxyUrl,
  token,
  runId,
  body,
  fetchImplementation,
  noPromo,
}) {
  const requestBody = {
    model: body.model,
    max_tokens: body.max_tokens,
    tools: body.tools,
    messages: body.messages,
    cache_control: { type: 'ephemeral' },
  };
  const response = await fetchImplementation(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-crucible-run-id': runId,
    },
    body: JSON.stringify(requestBody),
  });
  if (response.status === 401) {
    return { status: 401, response };
  }
  if (response.status === 402) {
    throw new Error(outOfCreditsMessage(noPromo));
  }
  if (!response.ok) {
    const detail = await readProxyErrorDetail(response);
    throw new Error(`Crucible agent proxy error (${response.status}): ${detail}`);
  }
  return { status: response.status, payload: await response.json() };
}

export async function runAgentSession(options, {
  environment = process.env,
  storeOptions = {},
  fetchImplementation = fetch,
  createMcpClient = createCrucibleMcpClient,
  mcpClientOptions = {},
  progress = console.error,
  now = Date.now,
} = {}) {
  const noPromo = isPromoSuppressed(environment);
  const mergedStoreOptions = { environment, ...storeOptions };

  let auth;
  try {
    auth = await getValidAccessToken({ environment, storeOptions: mergedStoreOptions, fetchImplementation, now });
  } catch (error) {
    if (error instanceof AuthExpiredError) {
      throw new Error(signedOutAgentMessage(noPromo));
    }
    throw error;
  }
  if (!auth) {
    throw new Error(signedOutAgentMessage(noPromo));
  }

  const report = message => {
    if (!options.quiet && !options.json) {
      progress(message);
    }
  };

  const runId = randomUUID();
  const mcpClient = await createMcpClient({
    backend: options.backend,
    jobsDir: options.jobs ?? undefined,
    environment,
    ...mcpClientOptions,
  });

  let activeSessionId = null;
  let recipeUpdated = false;
  let turns = 0;
  let toolCalls = 0;
  let lastCallSignature = null;
  let consecutiveIdenticalCount = 0;

  try {
    let openingText = options.prompt;
    if (options.scene) {
      const opened = await mcpClient.openScene(options.scene);
      activeSessionId = opened.sessionId;
      openingText = `${opened.digest}\n\nUser request: ${options.prompt}`;
    }

    const messages = [{ role: 'user', content: openingText }];
    let finalText = '';

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      turns = turn + 1;
      const body = {
        model: options.modelId,
        max_tokens: DEFAULT_MAX_TOKENS,
        tools: mcpClient.tools,
        messages,
      };
      let proxyResult = await callMessagesProxy({
        proxyUrl: auth.proxyUrl,
        token: auth.token,
        runId,
        body,
        fetchImplementation,
        noPromo,
      });

      if (proxyResult.status === 401 && auth.source !== 'env') {
        try {
          const refreshed = await getValidAccessToken({
            forceRefresh: true,
            environment,
            storeOptions: mergedStoreOptions,
            fetchImplementation,
            now,
          });
          if (!refreshed) {
            throw new Error(signedOutAgentMessage(noPromo));
          }
          auth = refreshed;
          proxyResult = await callMessagesProxy({
            proxyUrl: auth.proxyUrl,
            token: auth.token,
            runId,
            body,
            fetchImplementation,
            noPromo,
          });
        } catch (error) {
          if (error instanceof AuthExpiredError) {
            throw new Error(signedOutAgentMessage(noPromo));
          }
          throw error;
        }
      }

      if (proxyResult.status === 401) {
        throw new Error(signedOutAgentMessage(noPromo));
      }

      const assistantPayload = proxyResult.payload;
      const assistantContent = Array.isArray(assistantPayload?.content) ? assistantPayload.content : [];
      messages.push({ role: 'assistant', content: assistantContent });

      const toolUseBlocks = assistantContent.filter(block => block?.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        finalText = extractAssistantText(assistantContent);
        break;
      }

      const toolResultBlocks = [];
      for (const toolUse of toolUseBlocks) {
        toolCalls += 1;
        const toolName = toolUse.name;
        const toolInput = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
        const signature = `${toolName}:${stableJsonStringify(toolInput)}`;
        if (signature === lastCallSignature) {
          consecutiveIdenticalCount += 1;
        } else {
          lastCallSignature = signature;
          consecutiveIdenticalCount = 1;
        }

        if (consecutiveIdenticalCount >= 3) {
          report(`Blocked repeated call to ${toolName} (3 identical calls in a row).`);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: [
              {
                type: 'text',
                text: `Error: ${toolName} was called 3 times in a row with identical arguments. Change your arguments or choose a different step.`,
              },
            ],
          });
          continue;
        }

        if (!CORE_TOOL_NAMES.includes(toolName)) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: [{ type: 'text', text: `Error: Tool "${toolName}" is not enabled in this session.` }],
          });
          continue;
        }

        report(`[turn ${turns}] ${toolName}`);
        const mcpResult = await mcpClient.callTool(toolName, toolInput);
        if (!mcpResult?.isError) {
          const parsedPayload = parseToolResultPayload(mcpResult);
          if ((toolName === 'scene_create' || toolName === 'scene_create_asset') && typeof parsedPayload?.sessionId === 'string') {
            activeSessionId = parsedPayload.sessionId;
          }
          if (toolName === 'scene_dispose') {
            activeSessionId = null;
          }
          if (MUTATING_TOOL_NAMES.has(toolName)) {
            await mcpClient.exportAndWriteRecipe(options.outPath, { sessionId: activeSessionId });
            recipeUpdated = true;
          }
        }

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: Boolean(mcpResult?.isError),
          content: mapMcpContentToToolResultBlocks(mcpResult),
        });
      }

      messages.push({ role: 'user', content: toolResultBlocks });

      if (turn === options.maxTurns - 1) {
        throw new Error(`Stopped after reaching --max-turns (${options.maxTurns}). Pass a higher --max-turns up to ${MAX_ALLOWED_TURNS} to continue.`);
      }
    }

    let creditsRemaining = null;
    try {
      const usage = await fetchUsage({ proxyUrl: auth.proxyUrl, token: auth.token, fetchImplementation });
      if (usage.ok) {
        creditsRemaining = extractCreditsRemaining(usage.data);
      }
    } catch {
      // Optional usage summary must never fail a completed run.
    }

    return {
      ok: true,
      runId,
      model: options.modelId,
      turns,
      toolCalls,
      text: finalText,
      outPath: options.outPath,
      recipeUpdated,
      creditsRemaining,
    };
  } finally {
    await mcpClient.close();
  }
}

export async function runAgentCommand(argumentList, {
  log = console.log,
  error = console.error,
  environment = process.env,
  storeOptions = {},
  fetchImplementation = fetch,
  createMcpClient = createCrucibleMcpClient,
  mcpClientOptions = {},
  now = Date.now,
} = {}) {
  let options;
  try {
    options = parseAgentArguments(argumentList);
  } catch (parseError) {
    error(`crucible agent: ${parseError.message}\n${AGENT_USAGE}`);
    return 1;
  }
  if (options.help) {
    log(AGENT_USAGE);
    return 0;
  }

  try {
    const result = await runAgentSession(options, {
      environment,
      storeOptions,
      fetchImplementation,
      createMcpClient,
      mcpClientOptions,
      progress: error,
      now,
    });
    if (options.json) {
      log(JSON.stringify(result));
      return 0;
    }
    if (result.text) {
      log(result.text);
    }
    if (!options.quiet) {
      if (result.recipeUpdated) {
        error(`Saved scene recipe to ${result.outPath}`);
      }
      if (result.creditsRemaining !== null) {
        error(`Remaining credits: ${result.creditsRemaining} (${ACCOUNTS_WEB_URL}/account)`);
      }
    }
    return 0;
  } catch (failure) {
    if (options.json) {
      log(JSON.stringify({ ok: false, error: failure.message }));
    } else {
      error(`crucible agent: ${failure.message}`);
    }
    return 1;
  }
}
