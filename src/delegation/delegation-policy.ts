import { DelegationCompletionPolicy, DelegationVisibility } from './types.js';

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
