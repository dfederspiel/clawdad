import { describe, expect, it } from 'vitest';

import { MAX_MESSAGES_PER_PROMPT } from '../config.js';
import {
  normalizeCompletionPolicy,
  resolveDelegationHistoryLimit,
  shouldRetriggerCoordinator,
} from './delegation-policy.js';

describe('resolveDelegationHistoryLimit', () => {
  it('returns 0 for none', () => {
    expect(resolveDelegationHistoryLimit('none')).toBe(0);
  });

  it('returns a small window for recent', () => {
    expect(resolveDelegationHistoryLimit('recent')).toBe(3);
  });

  it('returns MAX_MESSAGES_PER_PROMPT for full', () => {
    expect(resolveDelegationHistoryLimit('full')).toBe(MAX_MESSAGES_PER_PROMPT);
  });

  it('defaults to full when unset', () => {
    expect(resolveDelegationHistoryLimit(undefined)).toBe(
      MAX_MESSAGES_PER_PROMPT,
    );
  });
});

describe('normalizeCompletionPolicy', () => {
  it('defaults to retrigger_coordinator when unset', () => {
    expect(normalizeCompletionPolicy(undefined)).toBe('retrigger_coordinator');
  });

  it('passes through explicit policies', () => {
    expect(normalizeCompletionPolicy('final_response')).toBe('final_response');
    expect(normalizeCompletionPolicy('silent')).toBe('silent');
  });
});

describe('shouldRetriggerCoordinator', () => {
  it('is true only for retrigger_coordinator', () => {
    expect(shouldRetriggerCoordinator('retrigger_coordinator')).toBe(true);
    expect(shouldRetriggerCoordinator('final_response')).toBe(false);
    expect(shouldRetriggerCoordinator('silent')).toBe(false);
  });
});
