import { MAX_MESSAGES_PER_PROMPT } from '../config.js';
import {
  DelegationCompletionPolicy,
  DelegationHistoryScope,
  DelegationVisibility,
} from './types.js';

export function normalizeCompletionPolicy(
  policy?: DelegationCompletionPolicy,
): DelegationCompletionPolicy {
  return policy || 'retrigger_coordinator';
}

export function normalizeVisibility(
  visibility?: DelegationVisibility,
): DelegationVisibility {
  return visibility || 'portal';
}

export function shouldRetriggerCoordinator(
  policy: DelegationCompletionPolicy,
): boolean {
  return policy === 'retrigger_coordinator';
}

// Resolve a history scope to a concrete message count for getMessagesSince.
// Unset → 'full' so any caller that doesn't opt in keeps legacy behavior.
export function resolveDelegationHistoryLimit(
  scope?: DelegationHistoryScope,
): number {
  switch (scope) {
    case 'none':
      return 0;
    case 'recent':
      return 3;
    case 'full':
    default:
      return MAX_MESSAGES_PER_PROMPT;
  }
}
