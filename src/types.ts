import { AgentRuntimeConfig } from './runtime-types.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  sshAgent?: boolean; // Mount host SSH_AUTH_SOCK into container (default: false)
  maxTurns?: number; // Hard cap on SDK turns per run
  disallowedTools?: string[]; // Tools refused for this agent (exact names or MCP patterns)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  isSystem?: boolean; // True for system/utility groups (e.g. General) — don't suppress onboarding
  description?: string; // Human-readable description shown in @-mention autocomplete
  triggerScope?: 'own' | 'web-all'; // 'web-all' = scan ALL web messages for trigger matches
  subtitle?: string; // Agent-settable status line shown under group name in sidebar
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  usage?: string;
  run_id?: number | null;
}

export interface MediaArtifact {
  id: string;
  chat_jid: string;
  thread_id?: string;
  created_at: string;
  source: 'agent_browser' | 'agent_output' | 'user_upload';
  media_type: 'image' | 'pdf';
  mime_type: string;
  path: string;
  width?: number;
  height?: number;
  agent_name?: string;
  run_id?: string;
  batch_id?: string;
  caption?: string;
  alt?: string;
}

export interface ThreadInfo {
  thread_id: string;
  agent_jid: string;
  origin_jid: string;
  agent_name?: string;
  created_at: string;
  reply_count?: number;
  kind?: 'trigger' | 'portal';
}

export interface Agent {
  id: string; // '{group_folder}/{agent_name}'
  groupFolder: string;
  name: string;
  displayName: string;
  trigger?: string; // Agent-specific trigger pattern (overrides group trigger)
  status?: string; // Agent-settable status line shown under the agent row
  containerConfig?: ContainerConfig; // Agent-specific overrides
  runtime?: AgentRuntimeConfig; // Provider/model execution boundary
  // Positive tool allowlist that overrides both the role-based default
  // (Phase 1 of #74) and the runtime's built-in default. Supports SDK
  // wildcards on Claude (e.g. `mcp__nanoclaw__*`); Ollama matches exact
  // names only. An empty array means "no tools" — an explicit opt-out.
  tools?: string[];
  // Positive skill allowlist over container/skills/*. Entries are skill
  // directory names (e.g. "rich-output", "status"). Undefined preserves
  // backward-compat behavior of receiving every global skill. An empty
  // array means "no skills". Phase 3 of #74 / #42.
  skills?: string[];
}

export type WorkPhase =
  | 'queued'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'delegating'
  | 'task_running'
  | 'completed'
  | 'pool_idle'
  | 'pool_acquired'
  | 'pool_released'
  | 'pool_reclaimed'
  | 'pool_cold_start'
  | 'error'
  | 'idle';

export interface WorkStateEvent {
  jid: string;
  phase: WorkPhase;
  agent_name?: string;
  agent_id?: string;
  summary?: string;
  thread_id?: string;
  is_task?: boolean;
  task_id?: string;
  active_delegations?: number;
  pending_delegations?: number;
  pending_messages?: boolean;
  idle_waiting?: boolean;
  updated_at: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  title?: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, threadId?: string): Promise<string>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(
    jid: string,
    isTyping: boolean,
    threadId?: string,
    agentName?: string,
  ): Promise<void>;
  // Optional: update a previously sent message in-place.
  updateMessage?(
    jid: string,
    messageId: string,
    text: string,
    threadId?: string,
  ): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
