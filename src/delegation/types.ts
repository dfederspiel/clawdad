export type DelegationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'superseded';

export type DelegationVisibility = 'portal' | 'main_chat' | 'coordinator_only';

export type DelegationCompletionPolicy =
  | 'final_response'
  | 'retrigger_coordinator'
  | 'silent';

// How much prior group chat history to prepend to a delegated specialist's
// prompt. The coordinator (or orchestrator path) has already condensed the
// user's intent into the delegation message — re-including the full window
// second-guesses that condensation and inflates parallel cost (#137).
//   none   — delegation message only
//   recent — a few messages of context
//   full   — MAX_MESSAGES_PER_PROMPT (legacy behavior)
export type DelegationHistoryScope = 'none' | 'recent' | 'full';

export interface DelegationRun {
  id: string;
  parentRunId?: string;
  groupJid: string;
  groupFolder: string;
  coordinatorAgentId: string;
  targetAgentId: string;
  message: string;
  status: DelegationStatus;
  visibility: DelegationVisibility;
  completionPolicy: DelegationCompletionPolicy;
  batchId: string;
  threadId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface DelegationRequest {
  parentRunId?: string;
  groupJid: string;
  groupFolder: string;
  coordinatorAgentId: string;
  targetAgentId: string;
  message: string;
  visibility?: DelegationVisibility;
  completionPolicy?: DelegationCompletionPolicy;
  batchId?: string;
  threadId?: string;
  // Defaults to 'full' when unset (backward compatible). Orchestrator
  // delegation paths set this deliberately; Phase 2 exposes it on the
  // delegate_to_agent MCP tool so coordinators can opt in per call.
  historyScope?: DelegationHistoryScope;
}

export interface DelegationExecutionResult {
  status: 'success' | 'error';
  result?: string;
  error?: string;
}
