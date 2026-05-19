import { describe, expect, it } from 'vitest';

import { MAX_MESSAGES_PER_PROMPT } from '../config.js';
import {
  normalizeCompletionPolicy,
  resolveDelegationHistoryLimit,
  resolveDelegationHistoryScope,
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

describe('resolveDelegationHistoryScope', () => {
  it('honors an explicit scope regardless of policy', () => {
    expect(resolveDelegationHistoryScope('none', 'retrigger_coordinator')).toBe(
      'none',
    );
    expect(resolveDelegationHistoryScope('full', 'final_response')).toBe(
      'full',
    );
    expect(resolveDelegationHistoryScope('recent', 'silent')).toBe('recent');
    expect(resolveDelegationHistoryScope('none', undefined)).toBe('none');
  });

  it('defaults final_response to none', () => {
    expect(resolveDelegationHistoryScope(undefined, 'final_response')).toBe(
      'none',
    );
  });

  it('defaults retrigger_coordinator to recent', () => {
    expect(
      resolveDelegationHistoryScope(undefined, 'retrigger_coordinator'),
    ).toBe('recent');
  });

  it('defaults silent to recent (safe fallback)', () => {
    expect(resolveDelegationHistoryScope(undefined, 'silent')).toBe('recent');
  });

  it('defaults undefined policy to recent', () => {
    expect(resolveDelegationHistoryScope(undefined, undefined)).toBe('recent');
  });
});
