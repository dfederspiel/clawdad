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

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  detectAuthMode,
  readClaudeCodeToken,
  resolveAnthropicCredentials,
} from './provider-auth.js';

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
        // ── /credential — list available services or fetch a specific one
        if (req.method === 'GET' && req.url === '/credential') {
          handleCredentialList(res);
          return;
        }
        const credMatch = req.url?.match(/^\/credential\/([a-zA-Z0-9_-]+)$/);
        if (credMatch && req.method === 'GET') {
          handleCredentialLookup(credMatch[1], res);
          return;
        }

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

// ── /credential/:service handler ────────────────────────────────────

/**
 * Return the raw credential value for a named service.
 * Looks up env vars matching the service prefix (e.g., "github" → GITHUB_TOKEN).
 * Used by `cred-exec` inside containers to inject credentials into CLI tools.
 */
/** List available credential services (by prefix) from .env. */
function listAvailableServices(
  env: Record<string, string>,
): { service: string; envVar: string }[] {
  const results: { service: string; envVar: string }[] = [];
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_PATTERN.test(key) && env[key]) {
      // Derive service name: GITHUB_TOKEN → github, ATLASSIAN_API_TOKEN → atlassian
      const match = key.match(/^(.+?)(?:_API)?_(TOKEN|KEY|SECRET|PASSWORD)$/);
      if (match) {
        results.push({
          service: match[1].toLowerCase(),
          envVar: key,
        });
      }
    }
  }
  // Deduplicate by service name (keep first match, which is the one our lookup would find)
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.service)) return false;
    seen.add(r.service);
    return true;
  });
}

function handleCredentialLookup(
  service: string,
  res: import('http').ServerResponse,
): void {
  const env = readEnvFile();
  const prefix = service.toUpperCase();

  // Find the best matching credential: try _TOKEN, _KEY, _SECRET, _PASSWORD, _API_TOKEN, _API_KEY
  const suffixes = [
    '_TOKEN',
    '_API_TOKEN',
    '_API_KEY',
    '_KEY',
    '_SECRET',
    '_PASSWORD',
  ];
  let value: string | undefined;
  let matchedKey: string | undefined;

  for (const suffix of suffixes) {
    const key = `${prefix}${suffix}`;
    if (env[key]) {
      value = env[key];
      matchedKey = key;
      break;
    }
  }

  if (!value || !matchedKey) {
    const available = listAvailableServices(env);
    const availableList = available
      .map((a) => `  - "${a.service}" (${a.envVar})`)
      .join('\n');
    const tried = suffixes.map((s) => `${prefix}${s}`).join(', ');

    logger.debug(
      { service, prefix, availableCount: available.length },
      'Credential lookup: no matching credential found',
    );
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(
      [
        `No credential found for service "${service}".`,
        '',
        `Looked for env vars: ${tried}`,
        '',
        available.length > 0
          ? `Available services:\n${availableList}`
          : 'No credentials are configured. Use mcp__nanoclaw__request_credential to register one.',
        '',
        'To fix:',
        `  1. Use one of the available service names listed above`,
        `  2. Or register a new credential with mcp__nanoclaw__request_credential`,
        '',
        'Usage: cred-exec.sh <service> <ENV_VAR> -- <command>',
        'For HTTP API calls, prefer: api.sh <service> <METHOD> <URL> [CURL_ARGS]',
      ].join('\n'),
    );
    return;
  }

  logger.debug(
    { service, key: matchedKey },
    'Credential lookup: returning value',
  );
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(value);
}

/** GET /credential — list all available services (no values exposed). */
function handleCredentialList(res: import('http').ServerResponse): void {
  const env = readEnvFile();
  const available = listAvailableServices(env);

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(
    [
      'Available credential services:',
      ...available.map((a) => `  - "${a.service}" (${a.envVar})`),
      '',
      'Usage: cred-exec.sh <service> <ENV_VAR> -- <command>',
      'For HTTP API calls: api.sh <service> <METHOD> <URL> [CURL_ARGS]',
    ].join('\n'),
  );
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
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    logger.warn({ targetUrl }, 'Credential proxy /forward: invalid URL');
    res.writeHead(400);
    res.end(`Invalid X-Forward-To URL: ${targetUrl}`);
    return;
  }
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
export { detectAuthMode, readClaudeCodeToken, resolveAnthropicCredentials };
