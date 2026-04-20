import { describe, expect, it } from 'vitest';

import {
  MIN_DELEGATION_MESSAGE_LENGTH,
  validateDelegationMessage,
} from './delegation-validation.js';

describe('validateDelegationMessage', () => {
  it('rejects an empty message', () => {
    const result = validateDelegationMessage('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/too short/i);
      expect(result.reason).toContain(String(MIN_DELEGATION_MESSAGE_LENGTH));
    }
  });

  it('rejects a whitespace-only message', () => {
    const result = validateDelegationMessage('   \n\t  ');
    expect(result.ok).toBe(false);
  });

  it('rejects a terse message under the minimum', () => {
    const result = validateDelegationMessage('triage this');
    expect(result.ok).toBe(false);
  });

  it('rejects right at the boundary (minimum - 1)', () => {
    const msg = 'x'.repeat(MIN_DELEGATION_MESSAGE_LENGTH - 1);
    expect(validateDelegationMessage(msg).ok).toBe(false);
  });

  it('accepts right at the boundary (minimum)', () => {
    const msg = 'x'.repeat(MIN_DELEGATION_MESSAGE_LENGTH);
    expect(validateDelegationMessage(msg).ok).toBe(true);
  });

  it('accepts a contextful delegation', () => {
    const result = validateDelegationMessage(
      'Review PR #123 at acme/repo and summarize the main risks in bullet form.',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when the trimmed length is under the minimum (leading/trailing whitespace does not count)', () => {
    const shortCore = 'x'.repeat(MIN_DELEGATION_MESSAGE_LENGTH - 5);
    const padded = `    ${shortCore}    `;
    expect(validateDelegationMessage(padded).ok).toBe(false);
  });

  it('handles undefined-ish input without throwing', () => {
    const result = validateDelegationMessage(undefined as unknown as string);
    expect(result.ok).toBe(false);
  });
});
