// RFC 8252 loopback OAuth 2.1 + PKCE client and `crucible auth` CLI.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { clearAuthSession, readAuthSession, writeAuthSession } from './crucible-auth-store.mjs';

export const ACCOUNTS_ISSUER = 'https://accounts.codepawl.com/api/auth';
export const AGENT_PROXY_URL = 'https://agent.codepawl.com';
export const ACCOUNTS_WEB_URL = 'https://accounts.codepawl.com';
export const OAUTH_CLIENT_ID = 'crucible-studio';
export const REFRESH_MARGIN_MS = 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5 * 1000;

export const AUTH_USAGE = `Usage: crucible auth login [--no-browser]
       crucible auth status [--json]
       crucible auth logout`;

export class AuthExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export function isPromoSuppressed(environment = process.env) {
  return environment?.CRUCIBLE_NO_PROMO === '1';
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function normalizeEndpointUrl(rawValue, label) {
  let parsed;
  try {
    parsed = new URL(String(rawValue).trim());
  } catch {
    throw new TypeError(`${label} must be a valid URL, got "${rawValue}".`);
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    throw new TypeError(`${label} must use https:// (or http:// on loopback), got "${rawValue}".`);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${normalizedPath}`;
}

export function resolveAuthEndpoints({ environment = process.env } = {}) {
  const issuerOverride = typeof environment.CRUCIBLE_ACCOUNTS_ISSUER === 'string' ? environment.CRUCIBLE_ACCOUNTS_ISSUER.trim() : '';
  const proxyOverride = typeof environment.CRUCIBLE_AGENT_PROXY === 'string' ? environment.CRUCIBLE_AGENT_PROXY.trim() : '';
  return {
    issuer: normalizeEndpointUrl(issuerOverride || ACCOUNTS_ISSUER, 'CRUCIBLE_ACCOUNTS_ISSUER'),
    proxyUrl: normalizeEndpointUrl(proxyOverride || AGENT_PROXY_URL, 'CRUCIBLE_AGENT_PROXY'),
    accountsWebUrl: ACCOUNTS_WEB_URL,
  };
}

export function createPkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

function constantTimeStringEqual(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') {
    return false;
  }
  const firstBytes = Buffer.from(first, 'utf8');
  const secondBytes = Buffer.from(second, 'utf8');
  if (firstBytes.length !== secondBytes.length) {
    return false;
  }
  return timingSafeEqual(firstBytes, secondBytes);
}

export async function discoverOAuthEndpoints(issuer, { fetchImplementation = fetch } = {}) {
  const fallback = {
    issuer,
    authorizationEndpoint: `${issuer}/oauth2/authorize`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    issRequired: false,
  };
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  for (const metadataUrl of candidates) {
    try {
      const response = await fetchImplementation(metadataUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        continue;
      }
      const metadata = await response.json();
      if (typeof metadata?.authorization_endpoint === 'string' && typeof metadata?.token_endpoint === 'string') {
        if (typeof metadata.issuer === 'string' && metadata.issuer.replace(/\/+$/, '') !== issuer) {
          throw new Error(`OAuth metadata issuer "${metadata.issuer}" does not match expected "${issuer}".`);
        }
        return {
          issuer,
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          issRequired: metadata.authorization_response_iss_parameter_supported === true,
        };
      }
    } catch (error) {
      if (error.message?.includes('does not match expected')) {
        throw error;
      }
    }
  }
  return fallback;
}

export function openBrowserUrl(targetUrl, { platform = process.platform, spawnImplementation = spawn } = {}) {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    return Promise.reject(new Error('Refusing to open a non-HTTPS URL in the browser.'));
  }
  const serialized = parsed.toString();
  if (/[\s"<>|&^]/.test(serialized.replace(/&/g, ''))) {
    return Promise.reject(new Error('Authorize URL contains unexpected characters.'));
  }
  const command = platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', `"${serialized}"`], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }]
    : platform === 'darwin'
      ? ['open', [serialized], { stdio: 'ignore', detached: true }]
      : ['xdg-open', [serialized], { stdio: 'ignore', detached: true }];
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(command[0], command[1], command[2]);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function callbackHtml(title, bodyText) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(bodyText)}</p>
</body>
</html>`;
}

async function readErrorPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function exchangeToken(tokenEndpoint, parameters, { fetchImplementation = fetch } = {}) {
  const response = await fetchImplementation(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(parameters).toString(),
  });
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    const errorCode = payload?.error;
    const description = payload?.error_description;
    const detail = [errorCode, description].filter(Boolean).join(': ') || `HTTP ${response.status}`;
    const error = new Error(`Token request failed (${detail}).`);
    error.oauthError = errorCode ?? null;
    error.status = response.status;
    throw error;
  }
  const tokenPayload = await response.json();
  if (typeof tokenPayload?.access_token !== 'string' || !tokenPayload.access_token) {
    throw new Error('Token response did not contain an access_token.');
  }
  return tokenPayload;
}

function buildStoredSession(tokenPayload, { issuer, proxyUrl, previousRefreshToken = null, now = Date.now } = {}) {
  const expiresInSeconds = Number(tokenPayload.expires_in);
  const currentMs = now();
  const expiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? currentMs + expiresInSeconds * 1000
    : currentMs + 3600 * 1000;
  return {
    issuer,
    proxyUrl,
    clientId: OAUTH_CLIENT_ID,
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token ?? previousRefreshToken ?? null,
    tokenType: tokenPayload.token_type ?? 'Bearer',
    scope: tokenPayload.scope ?? null,
    expiresAt,
    updatedAt: new Date(currentMs).toISOString(),
  };
}

export async function loginWithOAuth({
  noBrowser = false,
  environment = process.env,
  storeOptions = {},
  fetchImplementation = fetch,
  openBrowser = openBrowserUrl,
  error = console.error,
  timeoutMs = LOGIN_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const { issuer, proxyUrl } = resolveAuthEndpoints({ environment });
  const endpoints = await discoverOAuthEndpoints(issuer, { fetchImplementation });
  const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkcePair();
  const state = randomBytes(24).toString('base64url');

  let settled = false;
  let timeoutHandle;
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/auth/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (settled) {
      response.writeHead(409, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in already handled', 'Return to your terminal.'));
      return;
    }
    const parameters = requestUrl.searchParams;
    const oauthError = parameters.get('error');
    if (oauthError) {
      const description = parameters.get('error_description');
      const message = description ? `${oauthError}: ${description}` : oauthError;
      settled = true;
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in failed', message));
      rejectCallback(new Error(`Sign-in failed (${message}).`));
      return;
    }
    const callbackState = parameters.get('state');
    if (!constantTimeStringEqual(callbackState, state)) {
      settled = true;
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in rejected', 'The callback state did not match. Run crucible auth login again.'));
      rejectCallback(new Error('OAuth callback state did not match.'));
      return;
    }
    const hasIssuerParam = parameters.has('iss');
    const callbackIssuer = hasIssuerParam ? parameters.get('iss').replace(/\/+$/, '') : null;
    if (hasIssuerParam && callbackIssuer !== issuer) {
      settled = true;
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in rejected', 'The callback issuer did not match Crucible accounts.'));
      rejectCallback(new Error(`OAuth callback issuer "${callbackIssuer}" did not match "${issuer}".`));
      return;
    }
    if (!hasIssuerParam && endpoints.issRequired) {
      settled = true;
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in rejected', 'The callback did not include the issuer parameter.'));
      rejectCallback(new Error('OAuth callback omitted the required iss parameter.'));
      return;
    }
    const code = parameters.get('code');
    if (!code) {
      settled = true;
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackHtml('Sign-in failed', 'No authorization code was returned.'));
      rejectCallback(new Error('OAuth callback omitted the authorization code.'));
      return;
    }
    settled = true;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(callbackHtml('Signed in to Crucible', 'You can close this tab and return to your terminal.'));
    resolveCallback({ code });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorizeUrl = new URL(endpoints.authorizationEndpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('resource', proxyUrl);
    authorizeUrl.searchParams.set('scope', 'openid profile email offline_access');

    error(`Open this URL in your browser to sign in:\n${authorizeUrl.toString()}`);
    if (!noBrowser) {
      try {
        await openBrowser(authorizeUrl.toString());
      } catch (browserError) {
        error(`Could not open browser automatically (${browserError.message}). Open the URL above manually.`);
      }
    }

    timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectCallback(new Error('Timed out waiting for sign-in callback. Run "crucible auth login" again.'));
      }
    }, timeoutMs);
    timeoutHandle.unref?.();

    const { code } = await callbackPromise;
    const tokenPayload = await exchangeToken(endpoints.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
      resource: proxyUrl,
    }, { fetchImplementation });
    const session = buildStoredSession(tokenPayload, { issuer, proxyUrl, now });
    await writeAuthSession(session, { environment, ...storeOptions });
    return { issuer, proxyUrl, expiresAt: session.expiresAt };
  } finally {
    clearTimeout(timeoutHandle);
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

export async function getValidAccessToken({
  forceRefresh = false,
  environment = process.env,
  storeOptions = {},
  fetchImplementation = fetch,
  now = Date.now,
} = {}) {
  const envToken = typeof environment.CRUCIBLE_AGENT_TOKEN === 'string' ? environment.CRUCIBLE_AGENT_TOKEN.trim() : '';
  const { issuer, proxyUrl } = resolveAuthEndpoints({ environment });
  if (envToken) {
    return { token: envToken, source: 'env', proxyUrl };
  }
  const mergedStoreOptions = { environment, ...storeOptions };
  const session = await readAuthSession(mergedStoreOptions);
  if (!session || typeof session.accessToken !== 'string' || !session.accessToken) {
    return null;
  }
  const isFresh = typeof session.expiresAt === 'number' && now() + REFRESH_MARGIN_MS < session.expiresAt;
  if (!forceRefresh && isFresh) {
    return { token: session.accessToken, source: 'store', proxyUrl, session };
  }
  if (typeof session.refreshToken !== 'string' || !session.refreshToken) {
    await clearAuthSession(mergedStoreOptions);
    return null;
  }
  const sessionIssuer = session.issuer || issuer;
  const endpoints = await discoverOAuthEndpoints(sessionIssuer, { fetchImplementation });
  try {
    const tokenPayload = await exchangeToken(endpoints.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: session.clientId || OAUTH_CLIENT_ID,
      resource: proxyUrl,
    }, { fetchImplementation });
    const updatedSession = buildStoredSession(tokenPayload, {
      issuer: sessionIssuer,
      proxyUrl,
      previousRefreshToken: session.refreshToken,
      now,
    });
    await writeAuthSession(updatedSession, mergedStoreOptions);
    return { token: updatedSession.accessToken, source: 'refresh', proxyUrl, session: updatedSession };
  } catch (error) {
    if (error.oauthError === 'invalid_grant') {
      await clearAuthSession(mergedStoreOptions);
      throw new AuthExpiredError('Your Crucible session expired. Run `crucible auth login` to sign in again.');
    }
    throw error;
  }
}

export async function fetchUsage({ proxyUrl, token, fetchImplementation = fetch }) {
  const response = await fetchImplementation(`${proxyUrl}/v1/usage`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    return { ok: false, status: response.status, error: payload?.error ?? payload?.message ?? `HTTP ${response.status}` };
  }
  const data = await response.json();
  return { ok: true, status: response.status, data };
}

export function extractCreditsRemaining(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return null;
  }
  for (const key of ['creditsRemaining', 'remainingCredits', 'credits_remaining', 'remaining', 'credits', 'balance']) {
    if (typeof usageData[key] === 'number' && Number.isFinite(usageData[key])) {
      return usageData[key];
    }
  }
  return null;
}

function signedOutMessage(noPromo) {
  if (noPromo) {
    return `Not signed in. Run \`crucible auth login\` (${ACCOUNTS_WEB_URL}) to sign in, or connect your own agent with \`crucible-mcp\`.`;
  }
  return `Not signed in. Sign in free for 250 free credits (no card needed) with \`crucible auth login\` (${ACCOUNTS_WEB_URL}), or connect your own agent free with \`crucible-mcp\`.`;
}

function parseAuthCommandArguments(argumentList) {
  const [subcommand, ...rest] = argumentList;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return { help: !subcommand ? 'missing' : true };
  }
  const options = { subcommand, noBrowser: false, json: false };
  for (const argument of rest) {
    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }
    if (subcommand === 'login' && argument === '--no-browser') {
      options.noBrowser = true;
    } else if (subcommand === 'status' && argument === '--json') {
      options.json = true;
    } else {
      throw new TypeError(`${argument}: unknown option for "crucible auth ${subcommand}".`);
    }
  }
  if (!['login', 'status', 'logout'].includes(subcommand)) {
    throw new TypeError(`${subcommand}: unknown auth command. Use login, status, or logout.`);
  }
  return options;
}

export async function runAuthCommand(argumentList, {
  log = console.log,
  error = console.error,
  environment = process.env,
  storeOptions = {},
  fetchImplementation = fetch,
  openBrowser = openBrowserUrl,
  now = Date.now,
} = {}) {
  let parsed;
  try {
    parsed = parseAuthCommandArguments(argumentList);
  } catch (parseError) {
    error(`crucible auth: ${parseError.message}\n${AUTH_USAGE}`);
    return 1;
  }
  if (parsed.help === 'missing') {
    error(AUTH_USAGE);
    return 1;
  }
  if (parsed.help === true) {
    log(AUTH_USAGE);
    return 0;
  }

  const noPromo = isPromoSuppressed(environment);
  const mergedStoreOptions = { environment, ...storeOptions };

  try {
    if (parsed.subcommand === 'login') {
      await loginWithOAuth({
        noBrowser: parsed.noBrowser,
        environment,
        storeOptions: mergedStoreOptions,
        fetchImplementation,
        openBrowser,
        error,
        now,
      });
      log(`Signed in to Crucible. Manage your account at ${ACCOUNTS_WEB_URL}/account.`);
      return 0;
    }

    if (parsed.subcommand === 'logout') {
      await clearAuthSession(mergedStoreOptions);
      log('Signed out of Crucible.');
      return 0;
    }

    let tokenResult = null;
    let expiredMessage = null;
    try {
      tokenResult = await getValidAccessToken({ environment, storeOptions: mergedStoreOptions, fetchImplementation, now });
    } catch (tokenError) {
      if (tokenError instanceof AuthExpiredError) {
        expiredMessage = tokenError.message;
      } else {
        throw tokenError;
      }
    }

    if (!tokenResult) {
      if (parsed.json) {
        log(JSON.stringify({
          signedIn: false,
          expired: Boolean(expiredMessage),
          accountsUrl: ACCOUNTS_WEB_URL,
          loginCommand: 'crucible auth login',
          mcpCommand: 'crucible-mcp',
          ...(noPromo ? {} : { freeCredits: 250 }),
        }));
      } else {
        log(expiredMessage ? `${expiredMessage}\n${signedOutMessage(noPromo)}` : signedOutMessage(noPromo));
      }
      return 0;
    }

    let usage = await fetchUsage({ proxyUrl: tokenResult.proxyUrl, token: tokenResult.token, fetchImplementation });
    if (!usage.ok && usage.status === 401 && tokenResult.source !== 'env') {
      try {
        const refreshed = await getValidAccessToken({
          forceRefresh: true,
          environment,
          storeOptions: mergedStoreOptions,
          fetchImplementation,
          now,
        });
        if (refreshed) {
          tokenResult = refreshed;
          usage = await fetchUsage({ proxyUrl: tokenResult.proxyUrl, token: tokenResult.token, fetchImplementation });
        }
      } catch (refreshError) {
        if (refreshError instanceof AuthExpiredError) {
          if (parsed.json) {
            log(JSON.stringify({ signedIn: false, expired: true, accountsUrl: ACCOUNTS_WEB_URL, loginCommand: 'crucible auth login', mcpCommand: 'crucible-mcp' }));
          } else {
            log(`${refreshError.message}\n${signedOutMessage(noPromo)}`);
          }
          return 0;
        }
        throw refreshError;
      }
    }

    if (!usage.ok && usage.status === 401) {
      if (parsed.json) {
        log(JSON.stringify({ signedIn: false, unauthorized: true, accountsUrl: ACCOUNTS_WEB_URL, loginCommand: 'crucible auth login', mcpCommand: 'crucible-mcp' }));
      } else {
        log(signedOutMessage(noPromo));
      }
      return 0;
    }

    const creditsRemaining = usage.ok ? extractCreditsRemaining(usage.data) : null;
    if (parsed.json) {
      log(JSON.stringify({
        signedIn: true,
        source: tokenResult.source,
        proxyUrl: tokenResult.proxyUrl,
        accountUrl: `${ACCOUNTS_WEB_URL}/account`,
        creditsRemaining,
        usage: usage.ok ? usage.data : null,
        ...(usage.ok ? {} : { usageError: usage.error }),
      }));
      return 0;
    }
    const creditLine = creditsRemaining !== null
      ? `Remaining credits: ${creditsRemaining}.`
      : usage.ok
        ? 'Signed in (credit balance unavailable).'
        : `Could not read credits (${usage.error}).`;
    log(`Signed in to Crucible. ${creditLine} Account: ${ACCOUNTS_WEB_URL}/account`);
    return 0;
  } catch (failure) {
    error(`crucible auth: ${failure.message}`);
    return 1;
  }
}
