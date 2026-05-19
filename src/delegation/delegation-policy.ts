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

// Pick a sensible default history_scope when the coordinator didn't
// specify one, based on what the specialist's reply will be used for
// (#137 Phase 3):
//   final_response       — specialist's output IS the final answer; no
//                          follow-up turn, no need to ground in history.
//                          Default to 'none' to cut prompt cost.
//   retrigger_coordinator— coordinator gets a follow-up turn to
//                          synthesize; light context helps the specialist
//                          stay coherent with what was said. Default to
//                          'recent'.
//   silent / undefined   — fall back to 'recent' (matches Phase 1's
//                          orchestrator-path default; safe everywhere).
// An explicit scope from the caller always wins.
export function resolveDelegationHistoryScope(
  scope: DelegationHistoryScope | undefined,
  policy: DelegationCompletionPolicy | undefined,
): DelegationHistoryScope {
  if (scope) return scope;
  if (policy === 'final_response') return 'none';
  return 'recent';
}
