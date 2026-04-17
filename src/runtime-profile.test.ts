import { describe, expect, it } from 'vitest';

import {
  compareRuntimeProfiles,
  profileMeetsRequirements,
  resolveRuntimeProfile,
} from './runtime-profile.js';

describe('runtime-profile', () => {
  it('treats embedding models as incompatible for chat-oriented agent requirements', () => {
    const profile = resolveRuntimeProfile({
      provider: 'ollama',
      model: 'nomic-embed-text',
    });

    expect(profile.modelClass).toBe('embedding');
    expect(profile.features.textGeneration).toBe('unavailable');
    expect(profile.features.embeddings).toBe('available');
    expect(
      profileMeetsRequirements(profile, {
        textGeneration: true,
        toolUse: true,
      }),
    ).toBe(false);
  });

  it('recognizes vision-oriented models as image-capable enough for guarded use', () => {
    const profile = resolveRuntimeProfile({
      provider: 'ollama',
      model: 'qwen2.5-vl',
    });

    expect(profile.modelClass).toBe('vision-chat');
    expect(profile.features.imageInput).toBe('available');
  });

  it('flags incompatible replacement when moving from chat to embedding-only model', () => {
    const current = resolveRuntimeProfile({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const next = resolveRuntimeProfile({
      provider: 'ollama',
      model: 'bge-small-en',
    });

    const report = compareRuntimeProfiles(current, next, {
      textGeneration: true,
      toolUse: true,
      imageInput: true,
    });

    expect(report.compatible).toBe(false);
    expect(report.blockedByModelClass).toContain('embedding-only');
    expect(report.downgradedFeatures).toContain('textGeneration');
    expect(report.downgradedFeatures).toContain('imageInput');
  });

  it('treats higher-capability replacement as compatible when required features are preserved', () => {
    const current = resolveRuntimeProfile({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });
    const next = resolveRuntimeProfile({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });

    const report = compareRuntimeProfiles(current, next, {
      textGeneration: true,
      toolUse: true,
    });

    expect(report.compatible).toBe(true);
    expect(report.downgradedFeatures).toHaveLength(0);
  });
});
