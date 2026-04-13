import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { AgentRuntimeConfig, RuntimeProvider } from './runtime-types.js';

export type ProviderAuthStatus =
  | 'ready'
  | 'stale'
  | 'missing'
  | 'misconfigured'
  | 'unsupported';

export type ProviderAuthSource =
  | 'env'
  | 'oauth-store'
  | 'local-runtime'
  | 'none';

export interface ProviderAuthMaterial {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  expiresAt?: number;
  source: ProviderAuthSource;
}

export interface ProviderAuthHealth {
  provider: RuntimeProvider;
  status: ProviderAuthStatus;
  authMode?: 'api-key' | 'oauth' | 'none';
  source: ProviderAuthSource;
  refreshable: boolean;
  expiresAt?: number;
  notes: string[];
}

interface ClaudeCodeCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

const CLAUDE_CREDS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

function readClaudeCodeCredentials(): ClaudeCodeCredentials | null {
  try {
    const raw = fs.readFileSync(CLAUDE_CREDS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { claudeAiOauth?: ClaudeCodeCredentials };
    return data.claudeAiOauth || null;
  } catch {
    return null;
  }
}

export function readClaudeCodeToken(): string | null {
  const oauth = readClaudeCodeCredentials();
  if (!oauth?.accessToken) return null;

  if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000) {
    logger.warn('Claude Code OAuth token is expired or expiring soon');
  }

  return oauth.accessToken;
}

export interface AnthropicCredentials {
  authMode: 'api-key' | 'oauth';
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

  if (env.ANTHROPIC_API_KEY) {
    return { authMode: 'api-key', apiKey: env.ANTHROPIC_API_KEY, baseUrl };
  }

  const claudeToken = readClaudeCodeToken();
  if (claudeToken) {
    return { authMode: 'oauth', oauthToken: claudeToken, baseUrl };
  }

  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (envToken) {
    return { authMode: 'oauth', oauthToken: envToken, baseUrl };
  }

  return { authMode: 'oauth', baseUrl };
}

export function getAnthropicAuthHealth(
  _runtime?: AgentRuntimeConfig,
): ProviderAuthHealth {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);

  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      status: 'ready',
      authMode: 'api-key',
      source: 'env',
      refreshable: false,
      notes: ['Using a static Anthropic API key from .env.'],
    };
  }

  const oauth = readClaudeCodeCredentials();
  if (oauth?.accessToken) {
    const stale =
      typeof oauth.expiresAt === 'number' &&
      Date.now() > oauth.expiresAt - 60_000;

    return {
      provider: 'anthropic',
      status: stale ? 'stale' : 'ready',
      authMode: 'oauth',
      source: 'oauth-store',
      refreshable: !!oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      notes: stale
        ? [
            'Claude Code OAuth access token is expired or expiring soon.',
            'ClawDad re-reads this token, but does not yet perform its own refresh exchange.',
          ]
        : [
            'Using Claude Code OAuth credentials from the local credential store.',
          ],
    };
  }

  const envOauth = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (envOauth) {
    return {
      provider: 'anthropic',
      status: 'ready',
      authMode: 'oauth',
      source: 'env',
      refreshable: false,
      notes: [
        'Using an OAuth bearer token from .env.',
        'Expiry cannot be validated automatically for this token source.',
      ],
    };
  }

  return {
    provider: 'anthropic',
    status: 'missing',
    authMode: 'none',
    source: 'none',
    refreshable: false,
    notes: ['No Anthropic API key or OAuth token is configured.'],
  };
}

export function getProviderAuthHealth(
  provider: RuntimeProvider,
  runtime?: AgentRuntimeConfig,
): ProviderAuthHealth {
  switch (provider) {
    case 'anthropic':
      return getAnthropicAuthHealth(runtime);
    case 'ollama':
      return {
        provider,
        status: 'ready',
        authMode: 'none',
        source: 'local-runtime',
        refreshable: false,
        notes: ['Ollama typically runs locally without provider credentials.'],
      };
    default:
      return {
        provider,
        status: 'missing',
        authMode: 'none',
        source: 'none',
        refreshable: false,
        notes: ['Provider auth health is not implemented yet.'],
      };
  }
}

export function detectAuthMode(): 'api-key' | 'oauth' {
  return resolveAnthropicCredentials().authMode;
}
