import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./provider-auth.js', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('./provider-auth.js');

  function resolveFromMockEnv() {
    const baseUrl = mockEnv.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    if (mockEnv.ANTHROPIC_API_KEY) {
      return {
        authMode: 'api-key' as const,
        apiKey: mockEnv.ANTHROPIC_API_KEY,
        baseUrl,
      };
    }
    const envToken =
      mockEnv.CLAUDE_CODE_OAUTH_TOKEN || mockEnv.ANTHROPIC_AUTH_TOKEN;
    if (envToken) {
      return {
        authMode: 'oauth' as const,
        oauthToken: envToken,
        baseUrl,
      };
    }
    return {
      authMode: 'oauth' as const,
      baseUrl,
    };
  }

  return {
    ...actual,
    readClaudeCodeToken: vi.fn(() => null),
    resolveAnthropicCredentials: vi.fn(() => resolveFromMockEnv()),
    detectAuthMode: vi.fn(() => resolveFromMockEnv().authMode),
  };
});

import {
  startCredentialProxy,
  buildCredMap,
  substituteCredentials,
  isAllowedCredentialTarget,
} from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  // ── /forward endpoint tests ──────────────────────────────────────

  it('/forward substitutes credential placeholders in headers', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      GITHUB_TOKEN: 'ghp_real_github_token',
      GITHUB_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {
        'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/user`,
        authorization: 'token __CRED_GITHUB_TOKEN__',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe(
      'token ghp_real_github_token',
    );
    // x-forward-to must not be forwarded upstream
    expect(lastUpstreamHeaders['x-forward-to']).toBeUndefined();
  });

  it('/forward substitutes placeholders in request body', async () => {
    let lastUpstreamBody = '';
    // Replace the upstream handler to capture body
    upstreamServer.removeAllListeners('request');
    upstreamServer.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
        lastUpstreamHeaders = { ...req.headers };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      MY_SECRET: 'super_secret_value',
      MY_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/forward',
        headers: {
          'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/data`,
          'content-type': 'application/json',
        },
      },
      JSON.stringify({ token: '__CRED_MY_SECRET__' }),
    );

    expect(JSON.parse(lastUpstreamBody).token).toBe('super_secret_value');
  });

  it('/forward returns 400 when X-Forward-To is missing', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('Missing X-Forward-To header');
  });

  it('/forward passes through unknown placeholders unchanged', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      // Note: UNKNOWN_TOKEN is NOT in .env
    });

    await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {
        'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/test`,
        authorization: 'Bearer __CRED_UNKNOWN_TOKEN__',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer __CRED_UNKNOWN_TOKEN__',
    );
  });

  it('/forward re-reads .env on each request', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      GITHUB_TOKEN: 'old_token',
      GITHUB_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    // First request with old token
    await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {
        'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/user`,
        authorization: 'token __CRED_GITHUB_TOKEN__',
      },
    });
    expect(lastUpstreamHeaders['authorization']).toBe('token old_token');

    // Simulate .env change (mock returns new value)
    mockEnv.GITHUB_TOKEN = 'new_token';

    // Second request picks up the new value without restart
    await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {
        'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/user`,
        authorization: 'token __CRED_GITHUB_TOKEN__',
      },
    });
    expect(lastUpstreamHeaders['authorization']).toBe('token new_token');
  });

  it('/forward blocks credential substitution to unauthorized hosts', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      GITHUB_TOKEN: 'ghp_real_github_token',
    });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/forward',
      headers: {
        'x-forward-to': `http://127.0.0.1:${upstreamPort}/api/user`,
        authorization: 'token __CRED_GITHUB_TOKEN__',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('Credential forwarding blocked for target host');
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});

describe('buildCredMap', () => {
  it('builds map from credential-pattern env vars', () => {
    const map = buildCredMap({
      GITHUB_TOKEN: 'ghp_abc',
      GITLAB_TOKEN: 'glpat_xyz',
      SOME_CONFIG: 'not-a-credential',
    });
    expect(map).toEqual({
      __CRED_GITHUB_TOKEN__: 'ghp_abc',
      __CRED_GITLAB_TOKEN__: 'glpat_xyz',
    });
  });

  it('excludes ANTHROPIC_ and CLAUDE_CODE_ prefixes', () => {
    const map = buildCredMap({
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-xxx',
      GITHUB_TOKEN: 'ghp_abc',
    });
    expect(map).toEqual({ __CRED_GITHUB_TOKEN__: 'ghp_abc' });
  });

  it('excludes empty values', () => {
    const map = buildCredMap({ GITHUB_TOKEN: '' });
    expect(map).toEqual({});
  });
});

describe('substituteCredentials', () => {
  it('replaces known placeholders', () => {
    const result = substituteCredentials('token __CRED_GITHUB_TOKEN__', {
      __CRED_GITHUB_TOKEN__: 'ghp_real',
    });
    expect(result).toBe('token ghp_real');
  });

  it('leaves unknown placeholders unchanged', () => {
    const result = substituteCredentials('token __CRED_UNKNOWN_TOKEN__', {
      __CRED_GITHUB_TOKEN__: 'ghp_real',
    });
    expect(result).toBe('token __CRED_UNKNOWN_TOKEN__');
  });

  it('replaces multiple placeholders in one string', () => {
    const result = substituteCredentials('__CRED_A_KEY__:__CRED_B_SECRET__', {
      __CRED_A_KEY__: 'aaa',
      __CRED_B_SECRET__: 'bbb',
    });
    expect(result).toBe('aaa:bbb');
  });

  it('returns input unchanged when no placeholders present', () => {
    const result = substituteCredentials('no placeholders here', {
      __CRED_GITHUB_TOKEN__: 'ghp_real',
    });
    expect(result).toBe('no placeholders here');
  });
});

describe('isAllowedCredentialTarget', () => {
  it('allows GitHub credentials for github.com hosts', () => {
    expect(
      isAllowedCredentialTarget(
        '__CRED_GITHUB_TOKEN__',
        'https://api.github.com/user',
        { GITHUB_TOKEN: 'ghp_real' },
      ),
    ).toBe(true);
  });

  it('rejects GitHub credentials for arbitrary hosts', () => {
    expect(
      isAllowedCredentialTarget(
        '__CRED_GITHUB_TOKEN__',
        'https://evil.example.com/steal',
        { GITHUB_TOKEN: 'ghp_real' },
      ),
    ).toBe(false);
  });

  it('allows unknown prefixes without an allowlist (warn-but-allow)', () => {
    expect(
      isAllowedCredentialTarget(
        '__CRED_CUSTOM_TOKEN__',
        'https://custom.example.com/api',
        { CUSTOM_TOKEN: 'tok_real' },
      ),
    ).toBe(true);
  });

  it('allows configured custom hosts for a service prefix', () => {
    expect(
      isAllowedCredentialTarget(
        '__CRED_GITLAB_TOKEN__',
        'https://gitlab.internal.example.com/api/v4/projects',
        {
          GITLAB_TOKEN: 'glpat_real',
          GITLAB_URL: 'https://gitlab.internal.example.com',
        },
      ),
    ).toBe(true);
  });
});
