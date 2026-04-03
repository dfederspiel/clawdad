/**
 * Credential proxy for container isolation.
 *
 * Two responsibilities:
 *
 * 1. **Anthropic reverse proxy** (default path)
 *    Containers connect here instead of directly to the Anthropic API.
 *    The proxy injects real Anthropic credentials so containers never
 *    see them.  Two auth sub-modes:
 *      - API key:  Proxy injects x-api-key on every request.
 *      - OAuth:    Container CLI exchanges its placeholder token for a
 *                  temp API key via /api/oauth/claude_cli/create_api_key.
 *                  Proxy injects real OAuth token on that exchange request;
 *                  subsequent requests carry the temp key which is valid.
 *
 * 2. **Generic forwarding proxy** (`/forward` path)
 *    Routes any outbound request through the proxy for credential
 *    injection.  The caller sets `X-Forward-To` with the real upstream
 *    URL and includes placeholder strings (`__CRED_<NAME>__`) wherever
 *    a credential value is needed.  The proxy re-reads `.env` on every
 *    request, substitutes placeholders with real values, and forwards.
 *
 * Anthropic credentials are resolved fresh on every request:
 *   1. Claude Code credential store (~/.claude/.credentials.json) — preferred,
 *      auto-refreshed by Claude Code
 *   2. .env file (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN) — fallback
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ── Credential substitution helpers ─────────────────────────────────

const PLACEHOLDER_RE = /__CRED_([A-Z0-9_]+)__/g;

const CREDENTIAL_PATTERN =
  /^(?!ANTHROPIC_|CLAUDE_CODE_).+_(TOKEN|KEY|SECRET|PASSWORD)$/;

const DEFAULT_ALLOWED_HOSTS: Record<string, string[]> = {
  GITHUB: ['github.com', '.github.com'],
  GITLAB: ['gitlab.com', '.gitlab.com'],
  ATLASSIAN: ['api.atlassian.com', '.atlassian.net'],
  LAUNCHDARKLY: ['app.launchdarkly.com'],
  FIGMA: ['api.figma.com', '.figma.com'],
};

/** Build a map from placeholder string → real value using current .env. */
export function buildCredMap(
  env?: Record<string, string>,
): Record<string, string> {
  const vars = env ?? readEnvFile();
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (CREDENTIAL_PATTERN.test(key) && value) {
      map[`__CRED_${key}__`] = value;
    }
  }
  return map;
}

/** Replace all `__CRED_<NAME>__` placeholders in a string. */
export function substituteCredentials(
  input: string,
  credMap: Record<string, string>,
): string {
  if (!PLACEHOLDER_RE.test(input)) return input;
  // Reset lastIndex after the test above
  PLACEHOLDER_RE.lastIndex = 0;
  return input.replace(PLACEHOLDER_RE, (match) => credMap[match] ?? match);
}

function extractPlaceholders(input: string): string[] {
  const matches = input.match(PLACEHOLDER_RE);
  PLACEHOLDER_RE.lastIndex = 0;
  return matches ? [...new Set(matches)] : [];
}

function extractPlaceholdersFromHeader(key: string, value: string): string[] {
  if (key === 'authorization') {
    const basicMatch = value.match(/^Basic\s+(.+)$/i);
    if (basicMatch) {
      try {
        const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf-8');
        return extractPlaceholders(decoded);
      } catch {
        return [];
      }
    }
  }
  return extractPlaceholders(value);
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith('.')) {
    const suffix = normalized.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalized;
}

function getCredentialPrefix(placeholder: string): string | null {
  const match = placeholder.match(/^__CRED_([A-Z0-9]+)(?:_|$)/);
  return match ? match[1] : null;
}

function getEnvDeclaredHostsForPrefix(
  prefix: string,
  env: Record<string, string>,
): string[] {
  const hosts = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith(`${prefix}_`)) continue;
    if (
      !(
        key.endsWith('_URL') ||
        key.endsWith('_BASE_URL') ||
        key.endsWith('_API_URL')
      )
    ) {
      continue;
    }
    try {
      const parsed = new URL(value);
      hosts.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignore non-URL values
    }
  }
  return [...hosts];
}

export function isAllowedCredentialTarget(
  placeholder: string,
  targetUrl: string,
  env?: Record<string, string>,
): boolean {
  const vars = env ?? readEnvFile();
  const realKey = placeholder.replace(/^__CRED_/, '').replace(/__$/, '');
  if (!vars[realKey]) {
    // Unknown or unset placeholders are not sensitive.
    return true;
  }

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  const prefix = getCredentialPrefix(placeholder);
  if (!prefix) return false;

  const allowed = new Set<string>(DEFAULT_ALLOWED_HOSTS[prefix] || []);
  for (const host of getEnvDeclaredHostsForPrefix(prefix, vars)) {
    allowed.add(host);
  }

  if (allowed.size === 0) {
    // No allowlist configured for this prefix — allow but warn.
    // Known services (GITHUB, GITLAB, etc.) always have an allowlist via
    // DEFAULT_ALLOWED_HOSTS. Unknown/custom prefixes without a *_URL env
    // var get through with a warning so existing integrations don't break.
    // Users can lock them down by adding <PREFIX>_BASE_URL to .env.
    logger.warn(
      { placeholder, target: targetUrl, prefix },
      'Credential forwarded without host allowlist — add a *_URL env var for this prefix to restrict targets',
    );
    return true;
  }

  return [...allowed].some((pattern) =>
    hostnameMatchesPattern(hostname, pattern),
  );
}

function validateForwardTarget(
  req: import('http').IncomingMessage,
  rawBody: Buffer,
  targetUrl: string,
  credMap: Record<string, string>,
  env?: Record<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const placeholders = new Set<string>();

  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      for (const match of extractPlaceholdersFromHeader(key, value)) {
        placeholders.add(match);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        for (const match of extractPlaceholdersFromHeader(key, item)) {
          placeholders.add(match);
        }
      }
    }
  }

  if (rawBody.length > 0 && rawBody.length <= MAX_SUB_BODY) {
    const bodyStr = rawBody.toString('utf-8');
    for (const match of extractPlaceholders(bodyStr)) {
      placeholders.add(match);
    }
  }

  for (const placeholder of placeholders) {
    if (!(placeholder in credMap)) continue;
    if (!isAllowedCredentialTarget(placeholder, targetUrl, env)) {
      return {
        ok: false,
        reason: `Credential placeholder ${placeholder} is not allowed for target host`,
      };
    }
  }

  return { ok: true };
}

// ── Max body size for substitution (10 MB) ──────────────────────────
const MAX_SUB_BODY = 10 * 1024 * 1024;

// ── Claude Code credential store ────────────────────────────────────

const CLAUDE_CREDS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

interface ClaudeCodeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Read the OAuth token from Claude Code's credential store.
 * Returns the access token if the file exists and the token hasn't expired,
 * or null otherwise.  Claude Code auto-refreshes this file, so reading it
 * gives us a fresh token without managing refresh ourselves.
 */
export function readClaudeCodeToken(): string | null {
  try {
    const raw = fs.readFileSync(CLAUDE_CREDS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const oauth: ClaudeCodeCredentials | undefined = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    // Check expiry — leave 60s buffer
    if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000) {
      logger.warn('Claude Code OAuth token is expired or expiring soon');
      // Return it anyway — Claude Code may refresh it momentarily,
      // and the caller can still try. Better than returning null.
      return oauth.accessToken;
    }

    return oauth.accessToken;
  } catch {
    // File doesn't exist or isn't readable — that's fine, fall back to .env
    return null;
  }
}

/** Resolve Anthropic credentials, checking Claude Code store first. */
interface AnthropicCredentials {
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  baseUrl: string;
}

export function resolveAnthropicCredentials(): AnthropicCredentials {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  // API key takes priority (explicit, no expiry concerns)
  if (env.ANTHROPIC_API_KEY) {
    return { authMode: 'api-key', apiKey: env.ANTHROPIC_API_KEY, baseUrl };
  }

  // Try Claude Code credential store (auto-refreshed by Claude Code CLI)
  const claudeToken = readClaudeCodeToken();
  if (claudeToken) {
    return { authMode: 'oauth', oauthToken: claudeToken, baseUrl };
  }

  // Fall back to .env OAuth tokens
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (envToken) {
    return { authMode: 'oauth', oauthToken: envToken, baseUrl };
  }

  // Nothing configured — return oauth mode with no token
  return { authMode: 'oauth', baseUrl };
}

// ── Proxy server ────────────────────────────────────────────────────

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Resolve once at startup for the log message
  const initial = resolveAnthropicCredentials();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // ── /forward — generic credential-injecting forward proxy ───
        if (req.url === '/forward' || req.url?.startsWith('/forward?')) {
          handleForward(req, res, Buffer.concat(chunks));
          return;
        }

        // ── Default path — Anthropic reverse proxy ──────────────────
        // Re-read credentials on every request so token refreshes
        // (from Claude Code or manual .env edits) are picked up
        // without restarting ClawDad.
        const creds = resolveAnthropicCredentials();
        const upstreamUrl = new URL(creds.baseUrl);
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = isHttps ? httpsRequest : httpRequest;

        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (creds.authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = creds.apiKey;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (creds.oauthToken) {
              headers['authorization'] = `Bearer ${creds.oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode: initial.authMode },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Substitute credentials in a header value, with special handling for
 * Basic auth. Curl's `-u user:pass` encodes the value as Base64 in an
 * `Authorization: Basic <b64>` header, hiding any __CRED_*__ placeholders.
 * Decode first, substitute, then re-encode so the proxy can inject creds.
 */
function substituteInHeader(
  key: string,
  value: string,
  credMap: Record<string, string>,
): string {
  if (key === 'authorization') {
    const basicMatch = value.match(/^Basic\s+(.+)$/i);
    if (basicMatch) {
      const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf-8');
      if (PLACEHOLDER_RE.test(decoded)) {
        PLACEHOLDER_RE.lastIndex = 0;
        const substituted = substituteCredentials(decoded, credMap);
        return `Basic ${Buffer.from(substituted).toString('base64')}`;
      }
    }
  }
  return substituteCredentials(value, credMap);
}

// ── /forward handler ────────────────────────────────────────────────

function handleForward(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  rawBody: Buffer,
): void {
  const targetUrl = req.headers['x-forward-to'] as string | undefined;
  if (!targetUrl) {
    res.writeHead(400);
    res.end('Missing X-Forward-To header');
    return;
  }

  // Re-read .env on every request so newly-registered credentials work
  // without restarting anything.  The file is <1 KB — cost is negligible.
  // Single read: env snapshot is threaded through validation helpers.
  const env = readEnvFile();
  const credMap = buildCredMap(env);
  const validation = validateForwardTarget(
    req,
    rawBody,
    targetUrl,
    credMap,
    env,
  );
  if (!validation.ok) {
    logger.warn(
      { target: targetUrl, reason: validation.reason },
      'Credential proxy /forward blocked request',
    );
    res.writeHead(403);
    res.end('Credential forwarding blocked for target host');
    return;
  }

  logger.debug(
    {
      target: targetUrl,
      placeholderCount: Object.keys(credMap).length,
    },
    'Credential proxy /forward request',
  );

  // Build outbound headers with placeholder substitution
  const parsed = new URL(targetUrl);
  const outIsHttps = parsed.protocol === 'https:';
  const makeRequest = outIsHttps ? httpsRequest : httpRequest;

  const outHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // Skip hop-by-hop and proxy-specific headers
    if (
      key === 'x-forward-to' ||
      key === 'host' ||
      key === 'connection' ||
      key === 'keep-alive' ||
      key === 'transfer-encoding'
    ) {
      continue;
    }
    if (typeof value === 'string') {
      outHeaders[key] = substituteInHeader(key, value, credMap);
    } else if (Array.isArray(value)) {
      outHeaders[key] = value.map((v) => substituteInHeader(key, v, credMap));
    }
  }

  outHeaders['host'] = parsed.host;

  // Substitute in body if small enough
  let body = rawBody;
  if (rawBody.length > 0 && rawBody.length <= MAX_SUB_BODY) {
    const bodyStr = rawBody.toString('utf-8');
    if (PLACEHOLDER_RE.test(bodyStr)) {
      PLACEHOLDER_RE.lastIndex = 0;
      body = Buffer.from(substituteCredentials(bodyStr, credMap), 'utf-8');
    }
  }

  outHeaders['content-length'] = String(body.length);

  const upstream = makeRequest(
    {
      hostname: parsed.hostname,
      port: parsed.port || (outIsHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: outHeaders,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error(
      { err, target: targetUrl },
      'Credential proxy /forward upstream error',
    );
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  return resolveAnthropicCredentials().authMode;
}
