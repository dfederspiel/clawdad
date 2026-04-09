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

export interface RuntimeTurnInput {
  systemPrompt?: string;
  messages: RuntimeMessage[];
  attachments: RuntimeAttachment[];
  threadId?: string;
  agentId: string;
  runtime: AgentRuntimeConfig;
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
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
}
