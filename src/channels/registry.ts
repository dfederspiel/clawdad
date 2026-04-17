import {
  Channel,
  Agent,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Get agents for a group JID */
  getGroupAgents?: (jid: string) => Array<{
    id: string;
    name: string;
    displayName: string;
    trigger?: string;
    status?: string;
    runtime?: {
      provider: string;
      model?: string;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
    };
  }>;
  refreshGroupAgents?: (jid: string) => Array<{
    id: string;
    name: string;
    displayName: string;
    trigger?: string;
    status?: string;
    runtime?: {
      provider: string;
      model?: string;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
    };
  }>;
  onAgentRuntimeChanged?: (groupFolder: string, agentName: string) => void;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onDeleteGroup?: (jid: string, group: RegisteredGroup) => void;
  /** Optional status provider for web UI telemetry/task management */
  getStatus?: () => unknown;
  /** Look up thread→agent mapping */
  getThreadInfo?: (
    threadId: string,
  ) => { agentJid: string; originJid: string } | undefined;
  /** Notify orchestrator of a thread reply so it enqueues the agent */
  onThreadReply?: (threadId: string, agentJid: string) => void;
  /** Broadcast thread creation to connected clients */
  onThreadCreated?: (
    originJid: string,
    threadId: string,
    agentName: string,
  ) => void;
  /** Reset session for a group (clears SDK session, evicts warm pool) */
  onResetSession?: (groupFolder: string) => Promise<void>;
  /** Get fully discovered agents for a group with runtime metadata */
  getDiscoveredAgents?: (jid: string) => Agent[];
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
