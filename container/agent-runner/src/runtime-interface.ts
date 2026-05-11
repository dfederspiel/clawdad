export type RuntimeProvider =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'github-copilot'
  | 'azure-openai'
  | 'openrouter'
  | 'litellm';

export interface AgentRuntimeConfig {
  provider: RuntimeProvider;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeAttachment {
  id: string;
  artifactId: string;
  kind: 'image';
  mimeType: string;
  localPath: string;
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  source: 'user_upload' | 'agent_browser' | 'agent_output';
}

export type RuntimeInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string };

export interface RuntimeMessage {
  role: 'user' | 'assistant';
  content: RuntimeInputPart[];
}

export interface RuntimeTurnConstraints {
  maxTurns?: number;
  disallowedTools?: string[];
  /** Positive allowlist — when set, only these tools are exposed. */
  allowedTools?: string[];
}

export interface RuntimeTurnInput {
  systemPrompt?: string;
  messages: RuntimeMessage[];
  attachments: RuntimeAttachment[];
  threadId?: string;
  agentId: string;
  runtime: AgentRuntimeConfig;
  constraints?: RuntimeTurnConstraints;
}

export interface RuntimeUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
}

export type RuntimeEvent =
  | {
      type: 'progress';
      tool?: string;
      summary: string;
      timestamp: string;
    }
  | {
      type: 'text';
      text: string;
      timestamp: string;
    }
  | {
      type: 'result';
      status: 'success' | 'error';
      result: string | null;
      error?: string;
      usage?: RuntimeUsageData;
      textsAlreadyStreamed?: number;
      newSessionId?: string;
      resumeAt?: string;
    };

/**
 * Adapter contract inside the container. Capability metadata lives on the
 * host (`src/model-capabilities.ts` `CapabilityProfile`) — the host decides
 * what to allow per (provider, model) and passes constraints through
 * `RuntimeTurnInput`. Adapters don't need their own parallel capability
 * type; they just consume the contract.
 */
export interface RuntimeSession {
  provider: RuntimeProvider;
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
}
