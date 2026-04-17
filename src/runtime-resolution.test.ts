import { describe, expect, it } from 'vitest';

import {
  envRuntimeFallback,
  mergeRuntimeConfigs,
} from './runtime-resolution.js';

describe('runtime-resolution', () => {
  it('merges runtime configs with later entries taking precedence', () => {
    const resolved = mergeRuntimeConfigs(
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      { model: 'claude-opus-4-1' },
      { temperature: 0.2 },
    );

    expect(resolved).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
      baseUrl: undefined,
      temperature: 0.2,
      maxTokens: undefined,
    });
  });

  it('defaults to anthropic when only a model is provided', () => {
    const resolved = mergeRuntimeConfigs({ model: 'claude-sonnet-4' });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-sonnet-4');
  });

  it('derives a global anthropic fallback from CLAUDE_MODEL', () => {
    expect(
      envRuntimeFallback({
        CLAUDE_MODEL: 'claude-opus-4-1',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    });
  });
});
