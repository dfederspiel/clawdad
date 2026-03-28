import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
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
