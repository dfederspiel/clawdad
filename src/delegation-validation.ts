/**
 * Platform-level validation for coordinator → specialist delegations.
 *
 * Specialists run in their own container with isolated conversation history —
 * they see only the delegation message, not the coordinator's prior turns.
 * A message like "triage this bug" without ticket ID, summary, or subsystem
 * hints wastes a ~30–60s specialist container startup on insufficient context.
 *
 * Kept as a pure function so the check is identical on both sides of the
 * IPC boundary (MCP tool inside the container, and onDelegateToAgent on the
 * host as a backstop against stale container images).
 */

export const MIN_DELEGATION_MESSAGE_LENGTH = 40;

export type DelegationValidation = { ok: true } | { ok: false; reason: string };

export function validateDelegationMessage(
  message: string,
): DelegationValidation {
  const trimmed = (message ?? '').trim();
  if (trimmed.length < MIN_DELEGATION_MESSAGE_LENGTH) {
    return {
      ok: false,
      reason: `Delegation message is too short (${trimmed.length} chars, minimum ${MIN_DELEGATION_MESSAGE_LENGTH}). The target agent runs in its own container and sees ONLY this message — they do not have access to your conversation history. Include: what you specifically need, any context (ticket IDs, paths, prior findings), and the expected output format.`,
    };
  }
  return { ok: true };
}
