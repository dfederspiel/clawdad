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
}

export interface DelegationExecutionResult {
  status: 'success' | 'error';
  result?: string;
  error?: string;
}
