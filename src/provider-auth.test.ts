import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};
let mockCredsFileContent: string | null = null;

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys?: string[]) => {
    if (!keys) return { ...mockEnv };
    return Object.fromEntries(
      keys.filter((key) => key in mockEnv).map((key) => [key, mockEnv[key]]),
    );
  }),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('fs');
  return {
    ...actual,
    readFileSync: vi.fn(((filepath: string, ...args: unknown[]) => {
      if (
        typeof filepath === 'string' &&
        filepath.includes('.credentials.json')
      ) {
        if (mockCredsFileContent === null) {
          throw new Error('ENOENT: no such file');
        }
        return mockCredsFileContent;
      }
      return actual.readFileSync(filepath, ...(args as [any]));
    }) as typeof actual.readFileSync),
  };
});

import {
  clearProviderAuthFailure,
  classifyProviderAuthFailure,
  getAnthropicAuthHealth,
  noteProviderAuthFailure,
  readClaudeCodeToken,
  resolveAnthropicCredentials,
} from './provider-auth.js';

describe('provider-auth', () => {
  afterEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockCredsFileContent = null;
    clearProviderAuthFailure('anthropic');
  });

  it('reports API-key auth as ready', () => {
    Object.assign(mockEnv, { ANTHROPIC_API_KEY: 'sk-ant-api03-xxx' });
    const health = getAnthropicAuthHealth();
    expect(health.status).toBe('ready');
    expect(health.authMode).toBe('api-key');
    expect(health.source).toBe('env');
  });

  it('reports Claude Code oauth as stale when near expiry', () => {
    mockCredsFileContent = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-stale',
        refreshToken: 'rt-xxx',
        expiresAt: Date.now() - 1,
      },
    });
    const health = getAnthropicAuthHealth();
    expect(health.status).toBe('stale');
    expect(health.authMode).toBe('oauth');
    expect(health.source).toBe('oauth-store');
    expect(health.refreshable).toBe(true);
  });

  it('reports missing auth when nothing is configured', () => {
    const health = getAnthropicAuthHealth();
    expect(health.status).toBe('missing');
    expect(health.authMode).toBe('none');
  });

  it('still resolves a stale claude token for current proxy behavior', () => {
    mockCredsFileContent = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-stale',
        refreshToken: 'rt-xxx',
        expiresAt: Date.now() - 1,
      },
    });
    expect(readClaudeCodeToken()).toBe('sk-ant-oat01-stale');
    expect(resolveAnthropicCredentials().oauthToken).toBe('sk-ant-oat01-stale');
  });

  it('classifies anthropic authentication failures', () => {
    expect(
      classifyProviderAuthFailure(
        'anthropic',
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      ),
    ).toBe('auth');
  });

  it('records auth failures in provider health', () => {
    Object.assign(mockEnv, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-fromenv' });
    noteProviderAuthFailure(
      'anthropic',
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    );

    const health = getAnthropicAuthHealth();
    expect(health.status).toBe('stale');
    expect(health.lastFailureAt).toBeTruthy();
    expect(health.notes[0]).toContain('Failed to authenticate');
  });

  it('clears recorded auth failures after recovery', () => {
    Object.assign(mockEnv, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-fromenv' });
    noteProviderAuthFailure(
      'anthropic',
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    );
    clearProviderAuthFailure('anthropic');

    const health = getAnthropicAuthHealth();
    expect(health.status).toBe('ready');
    expect(health.lastFailureAt).toBeUndefined();
  });
});
