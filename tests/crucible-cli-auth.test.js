import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearAuthSession,
  readAuthSession,
  resolveAuthStorePath,
  resolveConfigDirectory,
  writeAuthSession,
} from '../bin/crucible-auth-store.mjs';
import {
  ACCOUNTS_ISSUER,
  ACCOUNTS_WEB_URL,
  AGENT_PROXY_URL,
  AuthExpiredError,
  OAUTH_CLIENT_ID,
  getValidAccessToken,
  loginWithOAuth,
  runAuthCommand,
} from '../bin/crucible-auth.mjs';
import { usageText } from '../bin/crucible.mjs';
import { mcpHelpText } from '../bin/crucible-mcp-flags.mjs';

const crucibleCliPath = fileURLToPath(new URL('../bin/crucible.mjs', import.meta.url));
const mcpCliPath = fileURLToPath(new URL('../bin/crucible-mcp.mjs', import.meta.url));

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

async function startMockOAuthServer({
  issSupported = true,
  callbackIssuerOverride = undefined,
  callbackStateOverride = undefined,
  omitCallbackIssuer = false,
  refreshInvalidGrant = false,
  usageCredits = 250,
} = {}) {
  const tokenRequests = [];
  const usageRequests = [];
  let serverUrl = '';

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', serverUrl || 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/auth/.well-known/oauth-authorization-server') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        issuer: `${serverUrl}/api/auth`,
        authorization_endpoint: `${serverUrl}/api/auth/oauth2/authorize`,
        token_endpoint: `${serverUrl}/api/auth/oauth2/token`,
        authorization_response_iss_parameter_supported: issSupported,
      }));
      return;
    }
    if (requestUrl.pathname === '/api/auth/oauth2/token') {
      const bodyText = await readRequestBody(request);
      const parameters = new URLSearchParams(bodyText);
      const record = Object.fromEntries(parameters.entries());
      tokenRequests.push(record);
      if (record.grant_type === 'refresh_token' && refreshInvalidGrant) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }));
        return;
      }
      if (record.grant_type === 'authorization_code') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          access_token: 'access-token-initial',
          refresh_token: 'refresh-token-1',
          expires_in: 3600,
          token_type: 'Bearer',
        }));
        return;
      }
      if (record.grant_type === 'refresh_token') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          access_token: 'access-token-refreshed',
          refresh_token: 'refresh-token-rotated',
          expires_in: 3600,
          token_type: 'Bearer',
        }));
        return;
      }
    }
    if (requestUrl.pathname === '/v1/usage') {
      usageRequests.push(request.headers.authorization ?? null);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ creditsRemaining: usageCredits }));
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${address.port}`;

  return {
    issuer: `${serverUrl}/api/auth`,
    proxyUrl: serverUrl,
    tokenRequests,
    usageRequests,
    async simulateBrowserCallback(authorizeUrlString) {
      const parsed = new URL(authorizeUrlString);
      const redirectUri = new URL(parsed.searchParams.get('redirect_uri'));
      const stateValue = callbackStateOverride ?? parsed.searchParams.get('state');
      redirectUri.searchParams.set('code', 'auth-code-123');
      if (stateValue !== null) {
        redirectUri.searchParams.set('state', stateValue);
      }
      if (!omitCallbackIssuer) {
        redirectUri.searchParams.set('iss', callbackIssuerOverride ?? `${serverUrl}/api/auth`);
      }
      const callbackResponse = await fetch(redirectUri.toString());
      return { authorizeUrl: parsed, callbackStatus: callbackResponse.status };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

test('auth store resolves platform config directories and stores sessions atomically', async () => {
  assert.equal(
    resolveConfigDirectory({ environment: { CRUCIBLE_CONFIG_DIR: '/tmp/custom-crucible' }, platform: 'linux', homeDirectory: '/home/user' }),
    resolve('/tmp/custom-crucible'),
  );
  assert.equal(
    resolveConfigDirectory({ environment: { APPDATA: 'C:\\ConfigRoot\\Roaming' }, platform: 'win32', homeDirectory: 'C:\\Homes\\demo' }),
    join('C:\\ConfigRoot\\Roaming', 'crucible'),
  );
  assert.equal(
    resolveConfigDirectory({ environment: { XDG_CONFIG_HOME: '/home/demo/.xdg' }, platform: 'linux', homeDirectory: '/home/demo' }),
    join('/home/demo/.xdg', 'crucible'),
  );
  assert.equal(
    resolveConfigDirectory({ environment: {}, platform: 'darwin', homeDirectory: '/Users/demo' }),
    join('/Users/demo', '.config', 'crucible'),
  );

  const temporaryDirectory = await createTempDirectory('crucible-auth-store-');
  try {
    const environment = { CRUCIBLE_CONFIG_DIR: temporaryDirectory };
    const storePath = resolveAuthStorePath({ environment });
    assert.equal(await readAuthSession({ environment }), null);

    await writeAuthSession({ accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 12345 }, { environment });
    const loaded = await readAuthSession({ environment });
    assert.equal(loaded.accessToken, 'secret-access');
    assert.equal(loaded.refreshToken, 'secret-refresh');
    const filesInDirectory = await readdir(temporaryDirectory);
    assert.deepEqual(filesInDirectory, ['auth.json']);

    if (process.platform !== 'win32') {
      const directoryStats = await stat(temporaryDirectory);
      const fileStats = await stat(storePath);
      assert.equal(directoryStats.mode & 0o777, 0o700);
      assert.equal(fileStats.mode & 0o777, 0o600);
    }

    await writeFile(storePath, '{corrupted', 'utf8');
    await assert.rejects(() => readAuthSession({ environment }), /not valid JSON/);

    await clearAuthSession({ environment });
    assert.equal(existsSync(storePath), false);
    assert.equal(await readAuthSession({ environment }), null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('public OAuth constants match Crucible accounts and agent proxy', () => {
  assert.equal(ACCOUNTS_ISSUER, 'https://accounts.codepawl.com/api/auth');
  assert.equal(AGENT_PROXY_URL, 'https://agent.codepawl.com');
  assert.equal(ACCOUNTS_WEB_URL, 'https://accounts.codepawl.com');
  assert.equal(OAUTH_CLIENT_ID, 'crucible-studio');
});

test('loopback OAuth 2.1 + PKCE login validates state and iss, sends resource, and saves session', async () => {
  const mockServer = await startMockOAuthServer();
  const temporaryDirectory = await createTempDirectory('crucible-auth-login-');
  try {
    const environment = {
      CRUCIBLE_CONFIG_DIR: temporaryDirectory,
      CRUCIBLE_ACCOUNTS_ISSUER: mockServer.issuer,
      CRUCIBLE_AGENT_PROXY: mockServer.proxyUrl,
    };
    const openedUrls = [];
    const stderrLines = [];
    let capturedAuthorizeUrl;

    const loginResult = await loginWithOAuth({
      noBrowser: false,
      environment,
      error: line => stderrLines.push(line),
      openBrowser: async url => {
        openedUrls.push(url);
        const simulation = await mockServer.simulateBrowserCallback(url);
        capturedAuthorizeUrl = simulation.authorizeUrl;
        assert.equal(simulation.callbackStatus, 200);
      },
    });

    assert.equal(loginResult.issuer, mockServer.issuer);
    assert.equal(loginResult.proxyUrl, mockServer.proxyUrl);
    assert.equal(openedUrls.length, 1);
    assert.ok(stderrLines.some(line => line.includes(openedUrls[0])));
    assert.equal(capturedAuthorizeUrl.searchParams.get('client_id'), OAUTH_CLIENT_ID);
    assert.equal(capturedAuthorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(capturedAuthorizeUrl.searchParams.get('resource'), mockServer.proxyUrl);

    assert.equal(mockServer.tokenRequests.length, 1);
    const tokenRequest = mockServer.tokenRequests[0];
    assert.equal(tokenRequest.grant_type, 'authorization_code');
    assert.equal(tokenRequest.resource, mockServer.proxyUrl);
    assert.match(tokenRequest.code_verifier, /^[A-Za-z0-9_-]{43,}$/);
    const sentChallenge = capturedAuthorizeUrl.searchParams.get('code_challenge');
    assert.match(sentChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(sentChallenge, tokenRequest.code_verifier);

    const stored = await readAuthSession({ environment });
    assert.equal(stored.accessToken, 'access-token-initial');
    assert.equal(stored.refreshToken, 'refresh-token-1');
  } finally {
    await mockServer.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('OAuth login rejects callback with bad state, wrong iss, or missing required iss and respects --no-browser', async () => {
  for (const scenario of [
    { name: 'bad state', options: { callbackStateOverride: 'wrong-state' }, pattern: /state did not match/ },
    { name: 'wrong iss', options: { callbackIssuerOverride: 'https://evil.example/api/auth' }, pattern: /issuer .* did not match/ },
    { name: 'missing iss', options: { omitCallbackIssuer: true, issSupported: true }, pattern: /omitted the required iss/ },
  ]) {
    const mockServer = await startMockOAuthServer(scenario.options);
    const temporaryDirectory = await createTempDirectory('crucible-auth-reject-');
    try {
      const environment = {
        CRUCIBLE_CONFIG_DIR: temporaryDirectory,
        CRUCIBLE_ACCOUNTS_ISSUER: mockServer.issuer,
        CRUCIBLE_AGENT_PROXY: mockServer.proxyUrl,
      };
      let browserOpened = false;
      await assert.rejects(
        () => loginWithOAuth({
          noBrowser: true,
          environment,
          openBrowser: async () => {
            browserOpened = true;
          },
          error: line => {
            const match = /https?:\/\/\S+/.exec(line);
            if (match) {
              void mockServer.simulateBrowserCallback(match[0]);
            }
          },
        }),
        scenario.pattern,
        scenario.name,
      );
      assert.equal(browserOpened, false, `${scenario.name}: --no-browser must skip launching browser`);
      assert.equal(await readAuthSession({ environment }), null, `${scenario.name}: store must remain empty`);
    } finally {
      await mockServer.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('getValidAccessToken refreshes within 60s margin, rotates refresh token, clears store on invalid_grant, and honors CRUCIBLE_AGENT_TOKEN', async () => {
  const mockServer = await startMockOAuthServer();
  const temporaryDirectory = await createTempDirectory('crucible-auth-refresh-');
  try {
    const environment = {
      CRUCIBLE_CONFIG_DIR: temporaryDirectory,
      CRUCIBLE_ACCOUNTS_ISSUER: mockServer.issuer,
      CRUCIBLE_AGENT_PROXY: mockServer.proxyUrl,
    };

    const envToken = await getValidAccessToken({
      environment: { ...environment, CRUCIBLE_AGENT_TOKEN: 'ci-env-token' },
    });
    assert.equal(envToken.token, 'ci-env-token');
    assert.equal(envToken.source, 'env');

    let currentMs = 1_000_000;
    await writeAuthSession({
      issuer: mockServer.issuer,
      proxyUrl: mockServer.proxyUrl,
      clientId: OAUTH_CLIENT_ID,
      accessToken: 'fresh-access',
      refreshToken: 'refresh-1',
      expiresAt: currentMs + 120_000,
    }, { environment });

    const cached = await getValidAccessToken({ environment, now: () => currentMs });
    assert.equal(cached.token, 'fresh-access');
    assert.equal(cached.source, 'store');
    assert.equal(mockServer.tokenRequests.length, 0);

    // Move inside the 60s refresh margin.
    currentMs += 70_000;
    const refreshed = await getValidAccessToken({ environment, now: () => currentMs });
    assert.equal(refreshed.token, 'access-token-refreshed');
    assert.equal(refreshed.source, 'refresh');
    assert.equal(mockServer.tokenRequests.length, 1);
    assert.equal(mockServer.tokenRequests[0].grant_type, 'refresh_token');
    assert.equal(mockServer.tokenRequests[0].resource, mockServer.proxyUrl);

    const savedAfterRefresh = await readAuthSession({ environment });
    assert.equal(savedAfterRefresh.refreshToken, 'refresh-token-rotated');
  } finally {
    await mockServer.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const invalidGrantServer = await startMockOAuthServer({ refreshInvalidGrant: true });
  const invalidDirectory = await createTempDirectory('crucible-auth-invalid-grant-');
  try {
    const environment = {
      CRUCIBLE_CONFIG_DIR: invalidDirectory,
      CRUCIBLE_ACCOUNTS_ISSUER: invalidGrantServer.issuer,
      CRUCIBLE_AGENT_PROXY: invalidGrantServer.proxyUrl,
    };
    await writeAuthSession({
      issuer: invalidGrantServer.issuer,
      proxyUrl: invalidGrantServer.proxyUrl,
      clientId: OAUTH_CLIENT_ID,
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
      expiresAt: 1000,
    }, { environment });

    await assert.rejects(
      () => getValidAccessToken({ environment, now: () => 10_000 }),
      error => error instanceof AuthExpiredError,
    );
    assert.equal(await readAuthSession({ environment }), null);
  } finally {
    await invalidGrantServer.close();
    await rm(invalidDirectory, { recursive: true, force: true });
  }
});

test('crucible auth status and logout report credits, promo tips, CRUCIBLE_NO_PROMO, and clear store', async () => {
  const mockServer = await startMockOAuthServer({ usageCredits: 187 });
  const temporaryDirectory = await createTempDirectory('crucible-auth-cli-');
  try {
    const environment = {
      CRUCIBLE_CONFIG_DIR: temporaryDirectory,
      CRUCIBLE_ACCOUNTS_ISSUER: mockServer.issuer,
      CRUCIBLE_AGENT_PROXY: mockServer.proxyUrl,
    };

    const signedOutLogs = [];
    assert.equal(await runAuthCommand(['status'], { environment, log: line => signedOutLogs.push(line) }), 0);
    assert.ok(signedOutLogs[0].includes('250 free credits'));
    assert.ok(signedOutLogs[0].includes('no card needed'));
    assert.ok(signedOutLogs[0].includes('crucible auth login'));
    assert.ok(signedOutLogs[0].includes('https://accounts.codepawl.com'));
    assert.ok(signedOutLogs[0].includes('crucible-mcp'));

    const noPromoLogs = [];
    assert.equal(await runAuthCommand(['status'], {
      environment: { ...environment, CRUCIBLE_NO_PROMO: '1' },
      log: line => noPromoLogs.push(line),
    }), 0);
    assert.equal(noPromoLogs[0].includes('250 free credits'), false);
    assert.ok(noPromoLogs[0].includes('crucible auth login'));

    await writeAuthSession({
      issuer: mockServer.issuer,
      proxyUrl: mockServer.proxyUrl,
      clientId: OAUTH_CLIENT_ID,
      accessToken: 'valid-token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 600_000,
    }, { environment });

    const signedInLogs = [];
    assert.equal(await runAuthCommand(['status'], { environment, log: line => signedInLogs.push(line) }), 0);
    assert.match(signedInLogs[0], /187/);
    assert.ok(signedInLogs[0].includes('https://accounts.codepawl.com/account'));
    assert.equal(signedInLogs.join('\n').includes('valid-token-abc'), false);

    const jsonLogs = [];
    assert.equal(await runAuthCommand(['status', '--json'], { environment, log: line => jsonLogs.push(line) }), 0);
    const parsedJson = JSON.parse(jsonLogs[0]);
    assert.equal(parsedJson.signedIn, true);
    assert.equal(parsedJson.creditsRemaining, 187);
    assert.equal(JSON.stringify(parsedJson).includes('valid-token-abc'), false);

    const logoutLogs = [];
    assert.equal(await runAuthCommand(['logout'], { environment, log: line => logoutLogs.push(line) }), 0);
    assert.equal(await readAuthSession({ environment }), null);
  } finally {
    await mockServer.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('crucible --help and crucible-mcp --help include built-in AI tips and respect CRUCIBLE_NO_PROMO', () => {
  const helpResult = spawnSync(process.execPath, [crucibleCliPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpResult.status, 0);
  assert.match(helpResult.stdout, /crucible agent/);
  assert.match(helpResult.stdout, /crucible auth login/);
  assert.match(helpResult.stdout, /250 free credits/);
  assert.match(helpResult.stdout, /crucible-mcp/);

  assert.doesNotMatch(usageText({ noPromo: true }), /250 free credits/);

  const mcpHelpResult = spawnSync(process.execPath, [mcpCliPath, '--help'], { encoding: 'utf8' });
  assert.equal(mcpHelpResult.status, 0);
  assert.match(mcpHelpResult.stdout, /Built-in headless AI/);
  assert.match(mcpHelpResult.stdout, /250 free credits, no card needed/);
  assert.match(mcpHelpResult.stdout, /crucible agent "<prompt>"/);
  assert.doesNotMatch(mcpHelpText('0.0.0', { noPromo: true }), /250 free credits/);
});
