export type RuntimeProvider =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'github-copilot'
  | 'azure-openai'
  | 'openrouter'
  | 'litellm';

export type RuntimeSupportLevel =
  | 'native'
  | 'adapter-managed'
  | 'model-dependent'
  | 'proxy-dependent'
  | 'sdk-dependent'
  | 'unsupported';

export type RuntimeFeatureStatus = 'available' | 'conditional' | 'unavailable';

export type RuntimeModelClass =
  | 'chat'
  | 'vision-chat'
  | 'embedding'
  | 'tool-specialized'
  | 'unknown';

export interface AgentRuntimeConfig {
  provider: RuntimeProvider;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface InputAttachment {
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
  // Hard cap on SDK turns before the runtime stops the agent.
  maxTurns?: number;
  // Tools the runtime must refuse to expose for this turn.
  // Exact names (e.g. "WebSearch") or MCP patterns (e.g. "mcp__nanoclaw__delegate_to_agent").
  disallowedTools?: string[];
  // When set, only these tools are exposed — a positive allowlist that
  // overrides the runtime's default tool set. Used for role-scoped
  // narrowing (e.g. Ollama specialists get just
  // mcp__nanoclaw__send_message + set_agent_status so small models
  // don't hallucinate picking from 18 simultaneous options). Leave
  // unset to use the runtime's default wide allowlist.
  allowedTools?: string[];
}

export interface RuntimeTurnInput {
  systemPrompt?: string;
  messages: RuntimeMessage[];
  attachments: InputAttachment[];
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

export interface RuntimeCapabilityProfile {
  provider: RuntimeProvider;
  textInput: RuntimeSupportLevel;
  imageInput: RuntimeSupportLevel;
  localImageFileInput: RuntimeSupportLevel;
  remoteImageUrlInput: RuntimeSupportLevel;
  base64ImageInput: RuntimeSupportLevel;
  toolUse: RuntimeSupportLevel;
  streamingText: RuntimeSupportLevel;
  sessionResume: RuntimeSupportLevel;
  notes?: string[];
}

export interface RuntimeSession {
  provider: RuntimeProvider;
  capabilities: RuntimeCapabilityProfile;
}

export interface RuntimeFeatureSet {
  textGeneration: RuntimeFeatureStatus;
  imageInput: RuntimeFeatureStatus;
  localImageFileInput: RuntimeFeatureStatus;
  remoteImageUrlInput: RuntimeFeatureStatus;
  base64ImageInput: RuntimeFeatureStatus;
  toolUse: RuntimeFeatureStatus;
  streamingText: RuntimeFeatureStatus;
  sessionResume: RuntimeFeatureStatus;
  embeddings: RuntimeFeatureStatus;
}

export interface ResolvedRuntimeProfile {
  runtime: AgentRuntimeConfig;
  provider: RuntimeProvider;
  model?: string;
  modelClass: RuntimeModelClass;
  capabilities: RuntimeCapabilityProfile;
  features: RuntimeFeatureSet;
  notes: string[];
}

export interface RequiredRuntimeFeatures {
  textGeneration?: boolean;
  imageInput?: boolean;
  toolUse?: boolean;
  streamingText?: boolean;
  sessionResume?: boolean;
  embeddings?: boolean;
}

export interface RuntimeCompatibilityReport {
  compatible: boolean;
  downgradedFeatures: Array<keyof RequiredRuntimeFeatures>;
  upgradedFeatures: Array<keyof RequiredRuntimeFeatures>;
  blockedByModelClass?: string;
  notes: string[];
}

export type ProviderAuthStatus =
  | 'ready'
  | 'stale'
  | 'missing'
  | 'misconfigured'
  | 'unsupported';

export type ProviderAuthSource =
  | 'env'
  | 'oauth-store'
  | 'local-runtime'
  | 'none';

export interface ProviderAuthHealth {
  provider: RuntimeProvider;
  status: ProviderAuthStatus;
  authMode?: 'api-key' | 'oauth' | 'none';
  source: ProviderAuthSource;
  refreshable: boolean;
  expiresAt?: number;
  lastFailureAt?: string;
  notes: string[];
}
