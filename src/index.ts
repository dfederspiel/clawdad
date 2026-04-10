import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  DEFAULT_AGENT_NAME,
  buildMultiAgentContext,
  discoverAgents,
} from './agent-discovery.js';
import { setActiveAgentName, clearActiveAgentName } from './agent-state.js';
import { getTriggeredAgentsForMessages } from './agent-routing.js';
import {
  beginDeliveryLease,
  DeliveryLease,
  markLeaseDelivered,
  noteVisibleMessage,
  resetChatSupersessionState,
  shouldDeliverForLease,
} from './message-supersession.js';
import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POOL_IDLE_TIMEOUT,
  SPECIALIST_IDLE_TIMEOUT,
  TRIGGER_IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
  CONTEXT_PRESSURE_THRESHOLD,
  WARM_POOL_ENABLED,
  WARM_SPECIALISTS_ENABLED,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { checkContainerSmoke } from './health.js';
import './channels/index.js';
import {
  ChannelOpts,
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  ProgressEvent,
  UsageData,
  runContainerAgent,
  spawnContainer,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { ContainerPool } from './container-pool.js';
import {
  cleanupOrphans,
  DockerUnavailableError,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
  stopContainer,
} from './container-runtime.js';
import {
  createThread,
  deleteGroupData,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAllThreads,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getThread,
  getThreadMessages,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeAgentRun,
  attachUsageToLastBotMessage,
  getSessionPressure,
  setGroupSubtitle,
  storeMediaArtifact,
  storeMessage,
} from './db.js';
import { GroupQueue, MessageCheckMode } from './group-queue.js';
import {
  resolveAgentIpcInputPath,
  resolveGroupFolderPath,
} from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import {
  loadPackAchievements,
  getAchievementsForContainer,
} from './achievements.js';
import {
  evaluateAutomationRules,
  AutomationTraceEntry,
} from './automation-rules.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startPolarisSessionKeepalive } from './polaris-session-keepalive.js';
import { Agent, Channel, NewMessage, RegisteredGroup } from './types.js';
import type { MediaArtifact } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// Agents per group: groupJid → Agent[]
const groupAgents: Record<string, Agent[]> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/** Find the main group's JID for escalation messaging. */
function getMainChatJid(): string | undefined {
  return Object.keys(registeredGroups).find(
    (jid) => registeredGroups[jid].isMain,
  );
}

// Maps triggered agent JID → origin info for cross-chat response routing
const pendingOrigins: Record<string, { originJid: string; threadId?: string }> =
  {};

/** Broadcast usage metrics to web UI clients */
function broadcastUsage(chatJid: string, usage: UsageData): void {
  for (const ch of channels) {
    if (ch.name === 'web' && 'broadcastUsageUpdate' in ch) {
      (ch as any).broadcastUsageUpdate(chatJid, usage);
      break;
    }
  }
}

function getMimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Broadcast work-state lifecycle transitions to web UI clients */
function broadcastWorkState(event: import('./types.js').WorkStateEvent): void {
  for (const ch of channels) {
    if (ch.name === 'web' && 'broadcastWorkState' in ch) {
      (ch as any).broadcastWorkState(event);
      break;
    }
  }
}

/**
 * Check session cost pressure after each agent run and broadcast if over threshold.
 * Provider-agnostic: uses only cost/token data from agent_runs, not SDK internals.
 */
function checkContextPressure(groupFolder: string, chatJid: string): void {
  if (CONTEXT_PRESSURE_THRESHOLD <= 0) return; // disabled

  const pressure = getSessionPressure(groupFolder);
  if (pressure.turnCount < 3) return; // not enough data

  if (pressure.avgCostPerTurn >= CONTEXT_PRESSURE_THRESHOLD) {
    logger.info(
      {
        groupFolder,
        avgCostPerTurn: pressure.avgCostPerTurn.toFixed(4),
        turnCount: pressure.turnCount,
        cumulativeCost: pressure.cumulativeCost.toFixed(2),
        threshold: CONTEXT_PRESSURE_THRESHOLD,
      },
      'Context pressure threshold exceeded',
    );
    for (const ch of channels) {
      if (ch.name === 'web' && 'broadcast' in ch) {
        (ch as any).broadcast('context_pressure', {
          jid: chatJid,
          groupFolder,
          avgCostPerTurn: pressure.avgCostPerTurn,
          turnCount: pressure.turnCount,
          cumulativeCost: pressure.cumulativeCost,
          avgCacheWriteTokens: pressure.avgCacheWriteTokens,
          threshold: CONTEXT_PRESSURE_THRESHOLD,
        });
        break;
      }
    }
  }
}

/** Broadcast agent progress (tool activity) to web UI clients */
function broadcastProgress(chatJid: string, event: ProgressEvent): void {
  for (const ch of channels) {
    if (ch.name === 'web' && 'broadcastAgentProgress' in ch) {
      (ch as any).broadcastAgentProgress(chatJid, event);
      break;
    }
  }
}

// Maps thread_id → agent JID for thread reply routing (rebuilt from DB on startup)
const activeThreads = new Map<
  string,
  { agentJid: string; originJid: string }
>();
// Callback set by the web channel to broadcast thread creation events
let broadcastThreadCreated:
  | ((originJid: string, threadId: string, agentName: string) => void)
  | null = null;

async function deliverAgentMessage(
  channel: Channel,
  jid: string,
  text: string,
  lease: DeliveryLease,
  threadId?: string,
): Promise<boolean> {
  if (!shouldDeliverForLease(lease)) {
    logger.info(
      {
        jid,
        batchId: lease.batchId,
        startEpoch: lease.startEpoch,
      },
      'Suppressing stale agent message at delivery time',
    );
    return false;
  }

  await channel.sendMessage(jid, text, threadId);
  markLeaseDelivered(lease);
  return true;
}

const channels: Channel[] = [];
const queue = new GroupQueue();
const pool = new ContainerPool(POOL_IDLE_TIMEOUT, WARM_POOL_ENABLED);
pool.setOnCountChange((idleCount) => queue.setIdlePoolCount(idleCount));
queue.setOnDelegationState(
  (groupJid, groupFolder, coordinatorAgent, active) => {
    const agentId = `${groupFolder}/${coordinatorAgent}`;
    if (active) {
      pool.pauseIdleTimer(agentId);
    } else {
      pool.resumeIdleTimer(agentId);
    }
  },
);

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Apply group-config.json from disk for all loaded groups so that
  // disk-based config (triggerScope, containerConfig, etc.) stays authoritative.
  let configApplied = 0;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (applyDiskGroupConfig(group)) {
      setRegisteredGroup(jid, group);
      configApplied++;
    }
  }

  // Discover agents for each registered group
  let totalAgents = 0;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    try {
      const agents = discoverAgents(group);
      groupAgents[jid] = agents;
      totalAgents += agents.length;
    } catch (err) {
      logger.warn(
        { jid, err },
        'Failed to discover agents, using implicit default',
      );
      groupAgents[jid] = [
        {
          id: `${group.folder}/${DEFAULT_AGENT_NAME}`,
          groupFolder: group.folder,
          name: DEFAULT_AGENT_NAME,
          displayName: group.name,
        },
      ];
    }
  }

  // Migrate legacy session keys: group_folder → group_folder/default
  // Existing sessions are keyed by group folder; new ones use agentId.
  for (const [key, sessionId] of Object.entries(sessions)) {
    if (!key.includes('/')) {
      const agentId = `${key}/${DEFAULT_AGENT_NAME}`;
      if (!sessions[agentId]) {
        sessions[agentId] = sessionId;
        setSession(agentId, sessionId);
        logger.info({ from: key, to: agentId }, 'Migrated session key');
      }

      // Migrate session files on disk: data/sessions/{folder}/.claude/ → data/sessions/{folder}/default/.claude/
      const oldSessionDir = path.join(DATA_DIR, 'sessions', key, '.claude');
      const newSessionDir = path.join(
        DATA_DIR,
        'sessions',
        key,
        DEFAULT_AGENT_NAME,
        '.claude',
      );
      if (
        fs.existsSync(oldSessionDir) &&
        fs.existsSync(path.join(oldSessionDir, 'projects')) &&
        !fs.existsSync(path.join(newSessionDir, 'projects'))
      ) {
        try {
          fs.cpSync(oldSessionDir, newSessionDir, { recursive: true });
          logger.info(
            { from: oldSessionDir, to: newSessionDir },
            'Migrated session files to per-agent dir',
          );
        } catch (err) {
          logger.warn({ key, err }, 'Failed to migrate session files');
        }
      }
    }
  }

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentCount: totalAgents,
      configApplied,
    },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/**
 * Apply group-config.json from the group folder onto a RegisteredGroup.
 * Disk config is authoritative — it always overwrites DB values for the
 * fields it declares, so edits on disk take effect after a restart.
 */
function applyDiskGroupConfig(group: RegisteredGroup): boolean {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch {
    return false;
  }
  const configPath = path.join(groupDir, 'group-config.json');
  if (!fs.existsSync(configPath)) return false;
  try {
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (disk.containerConfig) group.containerConfig = disk.containerConfig;
    if (disk.triggerScope) group.triggerScope = disk.triggerScope;
    if (disk.requiresTrigger != null)
      group.requiresTrigger = disk.requiresTrigger;
    if (disk.description) group.description = disk.description;
    return true;
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      'Failed to parse group-config.json',
    );
    return false;
  }
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  applyDiskGroupConfig(group);

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Discover agents for the newly registered group
  try {
    groupAgents[jid] = discoverAgents(group);
  } catch {
    groupAgents[jid] = [
      {
        id: `${group.folder}/${DEFAULT_AGENT_NAME}`,
        groupFolder: group.folder,
        name: DEFAULT_AGENT_NAME,
        displayName: group.name,
      },
    ];
  }

  logger.info(
    {
      jid,
      name: group.name,
      folder: group.folder,
      agents: groupAgents[jid].map((a) => a.name),
    },
    'Group registered',
  );
}

function unregisterGroup(jid: string, group: RegisteredGroup): void {
  // Stop any running container for this group
  const snapshot = queue.getSnapshot();
  const active = snapshot.groups?.find((g) => g.jid === jid && g.containerName);
  if (active?.containerName) {
    try {
      stopContainer(active.containerName);
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to stop container during group delete');
    }
  }

  // Clean up in-memory state
  queue.deleteGroup(jid);
  delete registeredGroups[jid];
  // Clean up per-agent sessions
  const agents = groupAgents[jid] || [];
  for (const agent of agents) {
    delete sessions[agent.id];
  }
  delete sessions[group.folder]; // legacy key
  delete groupAgents[jid];
  delete lastAgentTimestamp[jid];

  // Clean up database
  deleteGroupData(jid, group.folder);

  // Clean up filesystem
  const groupDir = path.join(GROUPS_DIR, group.folder);
  const sessionDir = path.join(DATA_DIR, 'sessions', group.folder);
  const ipcDir = path.join(DATA_DIR, 'ipc', group.folder);
  for (const dir of [groupDir, sessionDir, ipcDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group deleted');
}

function refreshGroupAgents(jid: string): Agent[] {
  const group = registeredGroups[jid];
  if (!group) return [];

  try {
    groupAgents[jid] = discoverAgents(group);
  } catch (err) {
    logger.warn(
      { jid, err },
      'Failed to refresh agents, using implicit default',
    );
    groupAgents[jid] = [
      {
        id: `${group.folder}/${DEFAULT_AGENT_NAME}`,
        groupFolder: group.folder,
        name: DEFAULT_AGENT_NAME,
        displayName: group.name,
      },
    ];
  }

  logger.info(
    {
      jid,
      agents: groupAgents[jid].map((a) => a.name),
    },
    'Group agents refreshed',
  );

  return groupAgents[jid];
}

function broadcastWebGroupsChanged(): void {
  for (const ch of channels) {
    if (ch.name === 'web' && 'broadcastGroupsChanged' in ch) {
      (ch as any).broadcastGroupsChanged();
      break;
    }
  }
}

function persistExplicitAgentStatus(
  jid: string,
  agentName: string,
  status: string,
): boolean {
  const group = registeredGroups[jid];
  if (!group) return false;

  const agent = (groupAgents[jid] || []).find((a) => a.name === agentName);
  if (!agent) return false;

  const agentDir = path.join(
    resolveGroupFolderPath(group.folder),
    'agents',
    agentName,
  );
  if (!fs.existsSync(agentDir)) {
    return false;
  }

  const configPath = path.join(agentDir, 'agent.json');
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      logger.warn(
        { jid, agentName, err },
        'Failed to parse agent.json while updating agent status',
      );
    }
  }

  const trimmed = status.trim();
  if (trimmed) config.status = trimmed;
  else delete config.status;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  refreshGroupAgents(jid);
  broadcastWebGroupsChanged();
  return true;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
/**
 * Determines whether a group requires a trigger pattern match before processing.
 * Multi-agent groups always bypass — the coordinator handles untriggered messages.
 * Exported for testing.
 */
export function needsTriggerForGroup(
  isMainGroup: boolean,
  isMultiAgent: boolean,
  requiresTrigger: boolean | undefined,
): boolean {
  if (isMainGroup) return false;
  if (isMultiAgent) return false;
  return requiresTrigger !== false;
}

export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

// ── Automation rule executor (Phase 2) ────────────────────────────
// Takes evaluated traces and executes their actions using existing
// delegation infrastructure. Returns true if any delegation was enqueued
// (caller should short-circuit normal routing).

async function executeAutomationActions(
  traces: AutomationTraceEntry[],
  chatJid: string,
  group: RegisteredGroup,
  agents: Agent[],
  channel: Channel,
  prompt: string,
): Promise<boolean> {
  let delegated = false;

  for (const trace of traces) {
    for (const action of trace.actions) {
      switch (action.type) {
        case 'delegate_to_agent': {
          const agent = agents.find((a) => a.name === action.targetAgent);
          if (!agent) {
            logger.warn(
              { ruleId: trace.ruleId, agent: action.targetAgent },
              '[automation] target agent not found, skipping action',
            );
            break;
          }

          if (!action.silent) {
            logger.info(
              { ruleId: trace.ruleId, agent: agent.name },
              `[automation] auto-routing to ${agent.displayName}`,
            );
          }

          const savedConfig = group.containerConfig;
          const AUTOMATION_TIMEOUT = 120_000;
          const taskId = `automation-${agent.name}-${Date.now()}`;
          const batchId = `automation-${trace.ruleId}-${randomUUID()}`;
          const autoCoordinatorContainer =
            queue.getCoordinatorContainerName(chatJid);
          queue.enqueueDelegation(
            chatJid,
            taskId,
            async () => {
              const lease = beginDeliveryLease(chatJid, batchId);
              let deliveredToUser = false;
              group.containerConfig = {
                ...savedConfig,
                timeout: Math.min(
                  savedConfig?.timeout || Infinity,
                  AUTOMATION_TIMEOUT,
                ),
              };
              const multiAgentCtx = buildMultiAgentContext(agent, agents);
              const recentMessages = getMessagesSince(
                chatJid,
                '',
                ASSISTANT_NAME,
                MAX_MESSAGES_PER_PROMPT,
                true,
              );
              const conversationCtx = formatMessages(recentMessages, TIMEZONE);
              const routingNote = action.messageTemplate
                ? `\n\n--- Auto-routed by rule "${trace.ruleId}" ---\n${action.messageTemplate}\n`
                : `\n\n--- Auto-routed by rule "${trace.ruleId}" ---\n`;
              const delegationPrompt =
                multiAgentCtx + conversationCtx + routingNote;

              setActiveAgentName(chatJid, agent.displayName);
              await channel.setTyping?.(chatJid, true);

              const status = await runAgent(
                group,
                delegationPrompt,
                chatJid,
                async (result) => {
                  if (result.result) {
                    if (
                      result.textsAlreadyStreamed &&
                      result.textsAlreadyStreamed > 0
                    ) {
                      // Text already delivered via onText → sendMessage
                    } else {
                      const raw =
                        typeof result.result === 'string'
                          ? result.result
                          : JSON.stringify(result.result);
                      const text = raw
                        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                        .trim();
                      if (text) {
                        setActiveAgentName(chatJid, agent.displayName);
                        if (
                          await deliverAgentMessage(
                            channel,
                            chatJid,
                            text,
                            lease,
                          )
                        ) {
                          deliveredToUser = true;
                        }
                      }
                    }
                  }
                  if (
                    result.status === 'success' ||
                    result.status === 'error'
                  ) {
                    await channel.setTyping?.(
                      chatJid,
                      false,
                      undefined,
                      agent.displayName,
                    );
                  }
                },
                (event) => broadcastProgress(chatJid, event),
                async (rawText) => {
                  // TEXT markers deliver the actual message content as a chat
                  // message — no extra progress broadcast (would duplicate into
                  // the typing indicator's tool history).
                  const text = rawText
                    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                    .trim();
                  if (!text) return;
                  setActiveAgentName(chatJid, agent.displayName);
                  if (
                    await deliverAgentMessage(channel, chatJid, text, lease)
                  ) {
                    deliveredToUser = true;
                  }
                },
                agent,
                true, // isDelegation
                async (text) => {
                  setActiveAgentName(chatJid, agent.displayName);
                  if (
                    await deliverAgentMessage(channel, chatJid, text, lease)
                  ) {
                    deliveredToUser = true;
                  }
                },
                batchId,
                autoCoordinatorContainer || undefined,
              );

              group.containerConfig = savedConfig;
              clearActiveAgentName(chatJid);
              await channel.setTyping?.(
                chatJid,
                false,
                undefined,
                agent.displayName,
              );
              if (persistExplicitAgentStatus(chatJid, agent.name, '')) {
                logger.info(
                  { jid: chatJid, agentName: agent.name },
                  'Cleared agent status after automation delegation',
                );
              }

              // Evaluate automation rules on result (enables chaining)
              if (status === 'success') {
                const chainTraces = evaluateAutomationRules(
                  group.folder,
                  {
                    type: 'agent_result',
                    groupJid: chatJid,
                    groupFolder: group.folder,
                    agentName: agent.name,
                  },
                  agents.map((a) => a.name),
                );
                if (chainTraces.length > 0) {
                  await executeAutomationActions(
                    chainTraces,
                    chatJid,
                    group,
                    agents,
                    channel,
                    prompt,
                  );
                }
              }

              logger.info(
                { ruleId: trace.ruleId, agent: agent.name, status },
                '[automation] delegation complete',
              );
            },
            agent.displayName,
            true, // skipRetrigger — automation handles routing, coordinator not needed
          );
          delegated = true;
          break;
        }

        case 'fan_out': {
          const targetNames = action.targetAgent?.split(', ') || [];
          for (const targetName of targetNames) {
            const fanTrace: AutomationTraceEntry = {
              ...trace,
              actions: [
                {
                  type: 'delegate_to_agent',
                  targetAgent: targetName,
                  silent: action.silent,
                },
              ],
            };
            await executeAutomationActions(
              [fanTrace],
              chatJid,
              group,
              agents,
              channel,
              prompt,
            );
          }
          delegated = true;
          break;
        }

        case 'post_system_note': {
          if (action.text) {
            storeMessage({
              id: `automation-note-${trace.ruleId}-${Date.now()}`,
              chat_jid: chatJid,
              sender: 'system',
              sender_name: 'System',
              content: action.text,
              timestamp: new Date().toISOString(),
              is_from_me: false,
              is_bot_message: false,
            });
          }
          break;
        }

        case 'set_subtitle': {
          if (action.text) {
            group.subtitle = action.text;
            setGroupSubtitle(chatJid, action.text);
            broadcastWebGroupsChanged();
          }
          break;
        }
      }
    }

    // Mark as fired
    trace.outcome = 'fired';
    logger.info(
      { ruleId: trace.ruleId, groupFolder: trace.groupFolder },
      '[automation] rule fired',
    );
  }

  return delegated;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  mode: MessageCheckMode = 'normal',
): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Cross-chat triggers: route responses to the originating chat
  const pendingOrigin = pendingOrigins[chatJid];
  const isThreadReply = !!pendingOrigin?.threadId;

  // Multi-agent coordinators need to see bot messages (specialist responses)
  // so they can synthesize results after delegations complete.
  const groupAgentList = groupAgents[chatJid] || [];
  const isMultiAgent = groupAgentList.length > 1;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
    isMultiAgent, // includeBotMessages — coordinators must see specialist output
    !isThreadReply, // excludeThreaded — but include thread replies when processing a thread agent
  );

  if (missedMessages.length === 0) {
    if (isThreadReply) {
      logger.warn(
        {
          chatJid,
          threadId: pendingOrigin?.threadId,
          cursor: getOrRecoverCursor(chatJid),
        },
        'Thread reply: no messages found after cursor (messages may have been consumed by message loop)',
      );
    }
    return true;
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text).then(() => {}),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) => {
        const defaultAgent = (groupAgents[chatJid] || [])[0];
        return runAgent(
          group,
          prompt,
          chatJid,
          onOutput,
          undefined,
          undefined, // onText — session commands don't stream intermediate text
          defaultAgent,
        );
      },
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main single-agent groups, check if trigger is required and present.
  if (needsTriggerForGroup(isMainGroup, isMultiAgent, group.requiresTrigger)) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }
  // Evaluate automation rules on inbound messages — Phase 2 executes matched actions
  const agentsForAutomation = groupAgents[chatJid] || [];
  const agentNamesForAutomation = agentsForAutomation.map((a) => a.name);
  for (const msg of missedMessages) {
    const traces = evaluateAutomationRules(
      group.folder,
      {
        type: 'message',
        groupJid: chatJid,
        groupFolder: group.folder,
        messageContent: msg.content,
        senderType: msg.is_bot_message ? 'assistant' : 'user',
      },
      agentNamesForAutomation,
    );
    if (traces.length > 0) {
      const delegated = await executeAutomationActions(
        traces,
        chatJid,
        group,
        agentsForAutomation,
        channel,
        formatMessages(missedMessages, TIMEZONE),
      );
      if (delegated) {
        // Automation handled routing — skip normal agent trigger path.
        // Advance cursor so these messages aren't reprocessed.
        lastAgentTimestamp[chatJid] =
          missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        return true;
      }
    }
  }

  const originJid = pendingOrigin?.originJid;
  const threadId = pendingOrigin?.threadId;

  if (threadId) {
    logger.info(
      { chatJid, originJid, threadId, messageCount: missedMessages.length },
      'Processing thread messages — response will route to thread',
    );
  }

  // For triggered agents, prepend conversation context from the origin chat
  // so the agent understands what's being discussed.
  let prompt: string;
  if (originJid && group.triggerScope === 'web-all') {
    const originContext = getMessagesSince(
      originJid,
      '',
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
      true, // include bot messages for full context
    );
    // Remove the last few messages that are duplicated as trigger copies
    const triggerIds = new Set(
      missedMessages.map((m) => m.id.replace(/_trigger_.*$/, '')),
    );
    const contextOnly = originContext.filter((m) => !triggerIds.has(m.id));
    if (contextOnly.length > 0) {
      prompt =
        '--- Conversation context from the chat where you were triggered ---\n' +
        formatMessages(contextOnly, TIMEZONE) +
        '\n--- Your trigger message ---\n' +
        formatMessages(missedMessages, TIMEZONE);
    } else {
      prompt = formatMessages(missedMessages, TIMEZONE);
    }
    logger.info(
      {
        group: group.name,
        originJid,
        contextMessages: contextOnly.length,
        triggerMessages: missedMessages.length,
      },
      'Triggered agent with origin context',
    );
  } else {
    prompt = formatMessages(missedMessages, TIMEZONE);
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  // Determine which agents should respond to these messages
  const agents = groupAgents[chatJid] || [];
  const triggeredAgents = getTriggeredAgentsForMessages(
    agents,
    missedMessages,
    {
      coordinatorOnly: isMultiAgent && mode === 'delegation_retrigger',
    },
  );

  if (triggeredAgents.length === 0) {
    // No explicit trigger matched — fall back to the group agent (the one
    // without a trigger). This is the coordinator/default responder, equivalent
    // to today's single-agent group behavior. If no triggerless agent exists,
    // fall back to the first agent.
    const groupAgent = agents.find((a) => !a.trigger) || agents[0];
    if (groupAgent) {
      triggeredAgents.push(groupAgent);
      logger.info(
        { group: group.name, fallback: groupAgent.name },
        'No agent trigger matched, routing to group agent',
      );
    } else {
      logger.debug({ group: group.name }, 'No agents triggered');
      return true;
    }
  }

  const responseJid = originJid || chatJid;
  const responseChannel = originJid
    ? findChannel(channels, originJid) || channel
    : channel;

  // When multiple specialist agents are @-mentioned, run them in parallel
  // via the delegation queue. The coordinator (if any) is excluded from
  // parallel fan-out — only explicitly triggered specialists run concurrently.
  if (triggeredAgents.length > 1 && isMultiAgent) {
    const specialists = triggeredAgents.filter((a) => a.trigger);
    const coordinator = triggeredAgents.find((a) => !a.trigger);

    if (specialists.length > 1) {
      const MENTION_TIMEOUT = 120_000; // 2 minutes, same as coordinator delegations
      const batchId = `fanout-${randomUUID()}`;
      const fanoutCoordinatorContainer =
        queue.getCoordinatorContainerName(chatJid);

      logger.info(
        {
          group: group.name,
          agents: specialists.map((a) => a.name),
          hasCoordinator: !!coordinator,
        },
        'Multi-agent: running @-mentioned specialists in parallel',
      );

      for (const agent of specialists) {
        const savedConfig = group.containerConfig;
        const taskId = `mention-${agent.name}-${Date.now()}`;
        queue.enqueueDelegation(
          chatJid,
          taskId,
          async () => {
            const lease = beginDeliveryLease(responseJid, batchId);
            let deliveredToUser = false;
            group.containerConfig = {
              ...savedConfig,
              timeout: Math.min(
                savedConfig?.timeout || Infinity,
                MENTION_TIMEOUT,
              ),
            };
            const multiAgentCtx = buildMultiAgentContext(agent, agents);
            const agentPrompt = multiAgentCtx ? multiAgentCtx + prompt : prompt;

            setActiveAgentName(responseJid, agent.displayName);
            await responseChannel.setTyping?.(responseJid, true, threadId);
            // Intermediate TEXT blocks are shown as status in the typing indicator

            const status = await runAgent(
              group,
              agentPrompt,
              chatJid,
              async (result) => {
                if (result.result) {
                  if (
                    result.textsAlreadyStreamed &&
                    result.textsAlreadyStreamed > 0
                  ) {
                    // Text already delivered via intermediate markers
                  } else {
                    const raw =
                      typeof result.result === 'string'
                        ? result.result
                        : JSON.stringify(result.result);
                    const text = raw
                      .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                      .trim();
                    if (text) {
                      setActiveAgentName(responseJid, agent.displayName);
                      if (
                        await deliverAgentMessage(
                          responseChannel,
                          responseJid,
                          text,
                          lease,
                          threadId,
                        )
                      ) {
                        deliveredToUser = true;
                      }
                    }
                  }
                }
                if (result.status === 'success' || result.status === 'error') {
                  await responseChannel.setTyping?.(
                    responseJid,
                    false,
                    threadId,
                    agent.displayName,
                  );
                }
              },
              (event) => broadcastProgress(responseJid, event),
              async (rawText) => {
                // Deliver intermediate text as a chat message; the typing
                // indicator's tool history is reserved for actual tool calls.
                const text = rawText
                  .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                  .trim();
                if (!text) return;
                setActiveAgentName(responseJid, agent.displayName);
                if (
                  await deliverAgentMessage(
                    responseChannel,
                    responseJid,
                    text,
                    lease,
                    threadId,
                  )
                ) {
                  deliveredToUser = true;
                }
              },
              agent,
              true, // isDelegation
              async (text) => {
                setActiveAgentName(responseJid, agent.displayName);
                if (
                  await deliverAgentMessage(
                    responseChannel,
                    responseJid,
                    text,
                    lease,
                    threadId,
                  )
                ) {
                  deliveredToUser = true;
                }
              },
              batchId,
              fanoutCoordinatorContainer || undefined,
            );

            group.containerConfig = savedConfig;
            clearActiveAgentName(responseJid);
            await responseChannel.setTyping?.(
              responseJid,
              false,
              threadId,
              agent.displayName,
            );

            // Evaluate and execute automation rules on agent result
            if (status === 'success') {
              const resultTraces = evaluateAutomationRules(
                group.folder,
                {
                  type: 'agent_result',
                  groupJid: chatJid,
                  groupFolder: group.folder,
                  agentName: agent.name,
                },
                agents.map((a) => a.name),
              );
              if (resultTraces.length > 0) {
                await executeAutomationActions(
                  resultTraces,
                  chatJid,
                  group,
                  agents,
                  channel,
                  prompt,
                );
              }
            }

            const resultNote =
              status === 'error'
                ? `[${agent.displayName} was unable to respond.]`
                : deliveredToUser
                  ? `[${agent.displayName} has responded above.]`
                  : `[${agent.displayName} completed but output was superseded by newer context.]`;
            storeMessage({
              id: `mention-result-${agent.name}-${Date.now()}`,
              chat_jid: chatJid,
              sender: 'system',
              sender_name: 'System',
              content: resultNote,
              timestamp: new Date().toISOString(),
              is_from_me: false,
              is_bot_message: false,
            });
          },
          agent.displayName,
        );
      }

      // All specialists are enqueued. Return immediately — when all delegations
      // complete, the queue automatically re-triggers processGroupMessages.
      // If a coordinator exists, it will run THEN (seeing specialist output).
      // If no coordinator, specialists' responses stand on their own.
      return true;
    }
  }

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      agents: triggeredAgents.map((a) => a.name),
    },
    'Processing messages',
  );

  let anyError = false;
  let anyOutputSent = false;

  // Run triggered agent(s) — typically one (coordinator or single specialist).
  // Multiple specialists are handled above via parallel delegation.
  for (const agent of triggeredAgents) {
    const batchId = `run-${randomUUID()}`;
    const lease = beginDeliveryLease(responseJid, batchId);
    // Build agent-specific prompt with multi-agent context
    const multiAgentCtx = buildMultiAgentContext(agent, agents);
    const agentPrompt = multiAgentCtx ? multiAgentCtx + prompt : prompt;

    // Set active agent name so the channel uses it as sender_name on bot messages.
    // Only set for multi-agent groups — single-agent groups don't need "X is thinking".
    if (isMultiAgent) {
      setActiveAgentName(responseJid, agent.displayName);
    }

    // Track idle timer for closing stdin when agent is idle
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => {
          logger.debug(
            { agent: agent.id },
            'Idle timeout, closing container stdin',
          );
          queue.closeStdin(chatJid);
        },
        group.requiresTrigger ? TRIGGER_IDLE_TIMEOUT : IDLE_TIMEOUT,
      );
    };

    await responseChannel.setTyping?.(responseJid, true, threadId);
    broadcastWorkState({
      jid: responseJid,
      phase: 'thinking',
      agent_name: agent.displayName,
      agent_id: agent.id,
      thread_id: threadId,
      summary: `${agent.displayName} is thinking`,
      updated_at: new Date().toISOString(),
    });
    let hadError = false;
    let outputSentForCurrentQuery = false;
    let outputSentToUser = false;
    let automationFiredForAgent = false;
    const output = await runAgent(
      group,
      agentPrompt,
      chatJid,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { agent: agent.id, responseJid, threadId: threadId || null },
            `Agent output: ${raw.length} chars → ${threadId ? 'thread' : 'main'}`,
          );
          if (raw.length > 0 && text.length === 0) {
            logger.warn(
              { agent: agent.id, responseJid, rawLen: raw.length },
              'Agent output entirely stripped by <internal> tag removal — user sees nothing',
            );
          } else if (raw.length - text.length > 500) {
            logger.info(
              {
                agent: agent.id,
                responseJid,
                rawLen: raw.length,
                strippedLen: text.length,
              },
              `<internal> tags stripped ${raw.length - text.length} chars from agent output`,
            );
          }
          if (text) {
            if (isMultiAgent)
              setActiveAgentName(responseJid, agent.displayName);
            if (
              await deliverAgentMessage(
                responseChannel,
                responseJid,
                text,
                lease,
                threadId,
              )
            ) {
              outputSentToUser = true;
              outputSentForCurrentQuery = true;
            }
          }
          resetIdleTimer();
        }

        if (!result.status) {
          await responseChannel.setTyping?.(responseJid, true, threadId);
        }

        if (result.status === 'success') {
          // Evaluate and execute automation rules on first success.
          // Must fire here (not after runAgent returns) because non-delegation
          // containers stay open in the piping loop — runAgent won't resolve
          // until the container eventually exits.
          if (!automationFiredForAgent) {
            automationFiredForAgent = true;
            const resultTraces = evaluateAutomationRules(
              group.folder,
              {
                type: 'agent_result',
                groupJid: chatJid,
                groupFolder: group.folder,
                agentName: agent.name,
              },
              agents.map((a) => a.name),
            );
            if (resultTraces.length > 0) {
              await executeAutomationActions(
                resultTraces,
                chatJid,
                group,
                agents,
                responseChannel,
                prompt,
              );
            }
          }

          queue.notifyIdle(chatJid);
          if (
            !outputSentForCurrentQuery &&
            !result.result &&
            !(result.textsAlreadyStreamed && result.textsAlreadyStreamed > 0)
          ) {
            logger.warn(
              { agent: agent.id },
              'Agent returned null result after retry — silent completion',
            );
          }
          await responseChannel.setTyping?.(
            responseJid,
            false,
            threadId,
            agent.displayName,
          );
          if (result.result) {
            outputSentForCurrentQuery = false;
          }
        }

        if (result.status === 'error') {
          await responseChannel.setTyping?.(
            responseJid,
            false,
            threadId,
            agent.displayName,
          );
          hadError = true;
        }
      },
      (event) => {
        broadcastProgress(responseJid, event);
      },
      async (rawText) => {
        // Intermediate text — show as status in typing indicator, not a chat message.
        // The final result will be sent as the real message.
        const text = rawText
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (!text) return;
        if (isMultiAgent) setActiveAgentName(responseJid, agent.displayName);
        // Truncate for status display — full content comes in the final result
        const summary = text.length > 120 ? text.slice(0, 117) + '...' : text;
        broadcastProgress(responseJid, {
          tool: 'text',
          summary,
          timestamp: new Date().toISOString(),
        });
        resetIdleTimer();
      },
      agent,
      undefined, // isDelegation
      async (text) => {
        if (isMultiAgent) setActiveAgentName(responseJid, agent.displayName);
        if (
          await deliverAgentMessage(
            responseChannel,
            responseJid,
            text,
            lease,
            threadId,
          )
        ) {
          outputSentToUser = true;
          outputSentForCurrentQuery = true;
        }
      },
      batchId,
    );

    await responseChannel.setTyping?.(
      responseJid,
      false,
      threadId,
      agent.displayName,
    );
    broadcastWorkState({
      jid: responseJid,
      phase: hadError ? 'error' : 'completed',
      agent_name: agent.displayName,
      agent_id: agent.id,
      summary: hadError
        ? `${agent.displayName} encountered an error`
        : `${agent.displayName} finished`,
      updated_at: new Date().toISOString(),
    });
    if (idleTimer) clearTimeout(idleTimer);
    if (persistExplicitAgentStatus(chatJid, agent.name, '')) {
      logger.info(
        { jid: chatJid, agentName: agent.name },
        'Cleared agent status after run completed',
      );
    }
    clearActiveAgentName(responseJid);

    if (outputSentToUser) anyOutputSent = true;
    if (output === 'error' || hadError) anyError = true;
  }

  // Clean up origin tracking after all agents have processed
  if (originJid && pendingOrigins[chatJid] === pendingOrigin) {
    delete pendingOrigins[chatJid];
  }

  if (anyError) {
    if (anyOutputSent) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (event: ProgressEvent) => void,
  onText?: (text: string) => Promise<void>,
  agent?: Agent,
  isDelegation?: boolean,
  sendMessage?: (text: string) => Promise<void>,
  runBatchId?: string,
  networkContainer?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const agentId = agent?.id || `${group.folder}/${DEFAULT_AGENT_NAME}`;
  const agentName = agent?.name || DEFAULT_AGENT_NAME;
  // Legacy session fallback: only use the group-level session for the default
  // agent. Named agents (added after the group was created) get their own
  // session directory and must not inherit the old single-agent session ID —
  // the SDK would try to resume it from the wrong .claude/ mount and crash
  // with "No conversation found".
  const sessionId =
    sessions[agentId] ||
    (agentName === DEFAULT_AGENT_NAME ? sessions[group.folder] : undefined);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Container lifecycle telemetry
  const isCoordinator = agent ? !agent.trigger : true;
  let containerReuse: 'cold_start' | 'warm_reuse' = 'cold_start';
  logger.info(
    {
      agent: agentId,
      chatJid,
      containerReuse: 'pending',
      hasSession: !!sessionId,
      isCoordinator,
      isDelegation,
    },
    'Container lifecycle decision',
  );

  // Accumulate tool history from progress events for persistence
  const toolHistory: Array<{
    tool: string;
    summary: string;
    timestamp: string;
  }> = [];
  const wrappedOnProgress = onProgress
    ? (event: ProgressEvent) => {
        if (event.tool) {
          toolHistory.push({
            tool: event.tool,
            summary: event.summary,
            timestamp: event.timestamp,
          });
        }
        onProgress(event);
      }
    : undefined;

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        // Only save session from successful outputs — error outputs carry the
        // broken session ID and would re-poison the cache after the error
        // handler clears it (race: outputChain settles after error resolve).
        if (output.newSessionId && output.status !== 'error') {
          sessions[agentId] = output.newSessionId;
          setSession(agentId, output.newSessionId);
        }
        // Send the message first, then store/broadcast usage.
        // Order matters: the message SSE must arrive before usage_update
        // so the frontend can attach usage to the correct message.
        await onOutput(output);

        // Store usage for each agent response (containers are long-lived,
        // so onOutput fires once per user message, not once per container)
        if (output.usage && output.usage.numTurns > 0) {
          const u = output.usage;
          storeAgentRun({
            chat_jid: chatJid,
            group_folder: group.folder,
            session_id: sessions[agentId],
            timestamp: new Date().toISOString(),
            input_tokens: u.inputTokens,
            output_tokens: u.outputTokens,
            cache_read_tokens: u.cacheReadTokens,
            cache_write_tokens: u.cacheWriteTokens,
            cost_usd: u.costUsd,
            duration_ms: u.durationMs,
            num_turns: u.numTurns,
            is_error: output.status === 'error',
            tool_history:
              toolHistory.length > 0 ? JSON.stringify(toolHistory) : null,
            container_reuse: containerReuse,
          });
          attachUsageToLastBotMessage(
            chatJid,
            JSON.stringify({
              ...u,
              toolHistory: toolHistory.length > 0 ? toolHistory : undefined,
            }),
          );
          broadcastUsage(chatJid, u);
          const cacheHitRatio =
            u.cacheReadTokens /
            Math.max(1, u.cacheReadTokens + u.cacheWriteTokens);
          logger.info(
            {
              agent: agentId,
              cost: u.costUsd,
              turns: u.numTurns,
              tokens: u.inputTokens + u.outputTokens,
              cacheHitRatio: Math.round(cacheHitRatio * 100),
              containerReuse,
            },
            'Agent run usage stored',
          );
          checkContextPressure(group.folder, chatJid);
        }
      }
    : undefined;

  // poolManaged: container stays alive for follow-up queries (warm pool).
  // Coordinators always pool when enabled. Specialists pool when both
  // WARM_POOL_ENABLED and WARM_SPECIALISTS_ENABLED are set.
  const shouldPool =
    WARM_POOL_ENABLED && (isCoordinator || WARM_SPECIALISTS_ENABLED);

  // ── Pool output handler ─────────────────────────────────────────
  // Pool-managed containers use a dedicated output handler that does
  // message routing and usage tracking but NOT lifecycle signals
  // (notifyIdle, resetIdleTimer). The pool owns container lifetime —
  // the message-loop piping path must never touch pooled containers.
  //
  // Invariant: pooled containers are never resumed via sendMessage().
  // Every new message re-enters through normal scheduling and may then
  // acquire a warm handle from the pool.
  // poolOnOutput: standalone output handler for pool-managed queries.
  // Does NOT call the caller's onOutput — that callback bundles piping-
  // loop concerns (notifyIdle, resetIdleTimer, automation rules).
  // Instead, we handle message delivery and usage tracking directly.
  const poolOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId && output.status !== 'error') {
      sessions[agentId] = output.newSessionId;
      setSession(agentId, output.newSessionId);
    }

    // Deliver final result as a chat message via sendMessage callback.
    // onText is for intermediate TEXT markers (ephemeral typing indicator).
    if (output.result) {
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        logger.info(
          { agent: agentId, chatJid },
          `Agent output: ${raw.length} chars (pool path)`,
        );
        if (sendMessage) {
          await sendMessage(text);
        } else if (onText) {
          // Fallback for callers that don't provide sendMessage
          await onText(text);
        }
      }
    }

    if (output.usage && output.usage.numTurns > 0) {
      const u = output.usage;
      storeAgentRun({
        chat_jid: chatJid,
        group_folder: group.folder,
        session_id: sessions[agentId],
        timestamp: new Date().toISOString(),
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cache_read_tokens: u.cacheReadTokens,
        cache_write_tokens: u.cacheWriteTokens,
        cost_usd: u.costUsd,
        duration_ms: u.durationMs,
        num_turns: u.numTurns,
        is_error: output.status === 'error',
        tool_history:
          toolHistory.length > 0 ? JSON.stringify(toolHistory) : null,
        container_reuse: containerReuse,
      });
      attachUsageToLastBotMessage(
        chatJid,
        JSON.stringify({
          ...u,
          toolHistory: toolHistory.length > 0 ? toolHistory : undefined,
        }),
      );
      broadcastUsage(chatJid, u);
      const cacheHitRatio =
        u.cacheReadTokens / Math.max(1, u.cacheReadTokens + u.cacheWriteTokens);
      logger.info(
        {
          agent: agentId,
          cost: u.costUsd,
          turns: u.numTurns,
          tokens: u.inputTokens + u.outputTokens,
          cacheHitRatio: Math.round(cacheHitRatio * 100),
          containerReuse,
        },
        'Agent run usage stored',
      );
      checkContextPressure(group.folder, chatJid);
    }
  };

  try {
    // ── Pool path ──────────────────────────────────────────────────
    // Pool-managed containers bypass the piping/message-loop entirely.
    // queryOnce is the only execution step. runAgent returns immediately
    // after releasing/reclaiming the handle. The queue never keeps pooled
    // handles in "active process" state beyond the query.
    if (shouldPool) {
      // Suppress message-loop piping while pool query runs.
      // Without this, sendMessage succeeds (state.active is true during
      // runForGroup), the message loop pipes follow-up messages into the
      // container's IPC dir, and they get consumed with no listener.
      queue.setNoPipe(chatJid, true);

      const warmHandle = pool.acquire(agentId);

      if (warmHandle) {
        // ── Warm reuse: query existing container ───────────────────
        containerReuse = 'warm_reuse';
        broadcastWorkState({
          jid: chatJid,
          phase: 'pool_acquired',
          agent_name: agent?.displayName,
          summary: 'Reusing warm container',
          updated_at: new Date().toISOString(),
        });

        const effectiveAgentName = agent?.name || DEFAULT_AGENT_NAME;
        const inputDir = resolveAgentIpcInputPath(
          group.folder,
          effectiveAgentName,
        );
        fs.mkdirSync(inputDir, { recursive: true });
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
        const tempPath = path.join(inputDir, `${filename}.tmp`);
        fs.writeFileSync(
          tempPath,
          JSON.stringify({ type: 'message', text: prompt }),
        );
        fs.renameSync(tempPath, path.join(inputDir, filename));

        const configTimeout =
          group.containerConfig?.timeout || CONTAINER_TIMEOUT;
        const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

        const result = await warmHandle.queryOnce(
          poolOnOutput,
          wrappedOnProgress,
          onText,
          timeoutMs,
        );

        if (result.status !== 'error') {
          const idleMs = isCoordinator ? undefined : SPECIALIST_IDLE_TIMEOUT;
          pool.release(
            agentId,
            warmHandle,
            chatJid,
            effectiveAgentName,
            idleMs,
          );
          broadcastWorkState({
            jid: chatJid,
            phase: 'pool_released',
            agent_name: agent?.displayName,
            summary: `Released to pool (${isCoordinator ? 'coordinator' : 'specialist'})`,
            updated_at: new Date().toISOString(),
          });
        } else {
          broadcastWorkState({
            jid: chatJid,
            phase: 'pool_reclaimed',
            agent_name: agent?.displayName,
            summary: 'Reclaimed due to error',
            updated_at: new Date().toISOString(),
          });
          await pool.reclaim(agentId);
          if (
            result.error &&
            /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
              result.error,
            )
          ) {
            delete sessions[agentId];
            deleteSession(agentId);
          }
        }

        if (result.newSessionId) {
          sessions[agentId] = result.newSessionId;
          setSession(agentId, result.newSessionId);
        }

        return result.status === 'error' ? 'error' : 'success';
      }

      // ── Cold start with pool release ───────────────────────────
      containerReuse = 'cold_start';
      broadcastWorkState({
        jid: chatJid,
        phase: 'pool_cold_start',
        agent_name: agent?.displayName,
        summary: 'Spawning new container (will pool after)',
        updated_at: new Date().toISOString(),
      });

      const containerInput = {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: agent?.displayName || ASSISTANT_NAME,
        agentId,
        agentName: agent?.name || DEFAULT_AGENT_NAME,
        runBatchId,
        canDelegate: agent ? !agent.trigger : false,
        isDelegation: isDelegation || false,
        networkContainer,
        poolManaged: true,
        mainChatJid: isMain ? undefined : getMainChatJid(),
        achievements: getAchievementsForContainer(),
      };

      const handle = await spawnContainer(group, containerInput);
      queue.registerProcess(
        chatJid,
        handle.process,
        handle.containerName,
        group.folder,
        agent?.name || DEFAULT_AGENT_NAME,
      );

      const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
      const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

      const result = await handle.queryOnce(
        poolOnOutput,
        wrappedOnProgress,
        onText,
        timeoutMs,
      );

      if (result.status !== 'error') {
        const coldAgentName = agent?.name || DEFAULT_AGENT_NAME;
        const idleMs = isCoordinator ? undefined : SPECIALIST_IDLE_TIMEOUT;
        pool.release(agentId, handle, chatJid, coldAgentName, idleMs);
        broadcastWorkState({
          jid: chatJid,
          phase: 'pool_released',
          agent_name: agent?.displayName,
          summary: `Released to pool (${isCoordinator ? 'coordinator' : 'specialist'})`,
          updated_at: new Date().toISOString(),
        });
        if (result.newSessionId) {
          sessions[agentId] = result.newSessionId;
          setSession(agentId, result.newSessionId);
        }
        return 'success';
      }

      // Error: wait for exit, handle session cleanup
      await handle.exitPromise;
      if (
        result.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          result.error,
        )
      ) {
        delete sessions[agentId];
        deleteSession(agentId);
      }
      logger.error(
        { agent: agentId, error: result.error },
        'Container agent error',
      );
      return 'error';
    }

    // ── Non-pool path: delegations, tasks, or pool disabled ─────
    const containerInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      assistantName: agent?.displayName || ASSISTANT_NAME,
      agentId,
      agentName: agent?.name || DEFAULT_AGENT_NAME,
      runBatchId,
      canDelegate: agent ? !agent.trigger : false,
      isDelegation: isDelegation || false,
      networkContainer,
      poolManaged: false,
      mainChatJid: isMain ? undefined : getMainChatJid(),
      achievements: getAchievementsForContainer(),
    };

    //
    // Uses runContainerAgent which waits for container exit.
    const output = await runContainerAgent(
      group,
      containerInput,
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          agent?.name || DEFAULT_AGENT_NAME,
          isDelegation,
        ),
      wrappedOnOutput,
      wrappedOnProgress,
      onText,
    );

    if (output.status === 'error') {
      if (
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        )
      ) {
        logger.warn(
          { agent: agentId },
          'Clearing stale session after "not found" error',
        );
        delete sessions[agentId];
        deleteSession(agentId);
        // Also clear the legacy group-folder key — session resolution falls
        // back to sessions[group.folder] for default agents, so the stale ID
        // would be picked up again on retry if only the agent key is cleared.
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
      logger.error(
        { agent: agentId, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    if (output.newSessionId) {
      sessions[agentId] = output.newSessionId;
      setSession(agentId, output.newSessionId);
    }

    return 'success';
  } catch (err) {
    // Let DockerUnavailableError propagate to GroupQueue so it can skip retries
    if (err instanceof DockerUnavailableError) throw err;
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        // Build a set of web-all trigger patterns so origin chats can skip
        // messages that will be handled by a triggered agent instead.
        const webAllTriggers: { pattern: RegExp; agentJid: string }[] = [];
        for (const [agentJid, agent] of Object.entries(registeredGroups)) {
          if (
            agent.triggerScope === 'web-all' &&
            agent.requiresTrigger &&
            agentJid.startsWith('web:')
          ) {
            webAllTriggers.push({
              pattern: getTriggerPattern(agent.trigger),
              agentJid,
            });
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          // Skip groups with pending thread routing — processGroupMessages
          // handles these via the queue with proper thread context.
          if (pendingOrigins[chatJid]) {
            logger.debug(
              { chatJid, origin: pendingOrigins[chatJid] },
              'Skipping — pending thread routing',
            );
            continue;
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // If every user message in this chat matches a web-all trigger,
          // skip processing — the triggered agent will handle it.
          if (
            chatJid.startsWith('web:') &&
            group.triggerScope !== 'web-all' &&
            webAllTriggers.length > 0
          ) {
            const userMsgs = groupMessages.filter(
              (m) => !m.is_bot_message && !m.is_from_me,
            );
            const allHandledByTrigger =
              userMsgs.length > 0 &&
              userMsgs.every((m) =>
                webAllTriggers.some((t) => t.pattern.test(m.content.trim())),
              );
            if (allHandledByTrigger) {
              logger.debug(
                { chatJid },
                'Skipping — all messages handled by cross-chat trigger',
              );
              continue;
            }
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const agents = groupAgents[chatJid] || [];
          const isMultiAgent = agents.length > 1;
          const needsTrigger = needsTriggerForGroup(
            isMainGroup,
            isMultiAgent,
            group.requiresTrigger,
          );

          // For non-main single-agent groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Multi-agent groups: never pipe — route through processGroupMessages.
          let shouldPipe = true;

          if (isMultiAgent) {
            // Multi-agent groups never pipe — all messages must route through
            // processGroupMessages for proper agent routing, delegation context,
            // and includeBotMessages handling. Piping would advance the cursor
            // past specialist responses before the coordinator can see them.
            shouldPipe = false;
          }

          if (shouldPipe && queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container, or multi-agent routing needed — enqueue
            queue.enqueueMessageCheck(chatJid);
          }
        }

        // Cross-chat trigger scan: check web-all triggered agents
        // against messages from other web chats
        for (const [chatJid, groupMessages] of messagesByGroup) {
          if (!chatJid.startsWith('web:')) continue;
          const userMessages = groupMessages.filter(
            (m) => !m.is_bot_message && !m.is_from_me,
          );
          if (userMessages.length === 0) continue;

          for (const [agentJid, agent] of Object.entries(registeredGroups)) {
            if (agent.triggerScope !== 'web-all') continue;
            if (!agent.requiresTrigger) continue;
            if (agentJid === chatJid) continue;

            const pattern = getTriggerPattern(agent.trigger);
            const triggered = userMessages.some((m) =>
              pattern.test(m.content.trim()),
            );
            if (!triggered) continue;

            // Copy the triggering messages to the agent's JID so it has context
            for (const msg of userMessages) {
              storeMessage({
                ...msg,
                id: `${msg.id}_trigger_${agent.folder}`,
                chat_jid: agentJid,
              });
            }
            // Create a thread anchored to the first triggering message
            const triggerThreadId = userMessages[0].id;
            createThread(triggerThreadId, agentJid, chatJid, agent.name);
            activeThreads.set(triggerThreadId, {
              agentJid,
              originJid: chatJid,
            });
            pendingOrigins[agentJid] = {
              originJid: chatJid,
              threadId: triggerThreadId,
            };
            queue.enqueueMessageCheck(agentJid);
            // Broadcast to connected web clients so the thread UI appears immediately
            broadcastThreadCreated?.(chatJid, triggerThreadId, agent.name);
            logger.info(
              { trigger: agent.trigger, agentJid, originJid: chatJid },
              'Cross-chat trigger detected',
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): boolean {
  const ready = ensureContainerRuntimeRunning();
  if (ready) cleanupOrphans();
  return ready;
}

async function main(): Promise<void> {
  const containerReady = ensureContainerSystemRunning();
  if (!containerReady) {
    logger.warn(
      'Starting without container runtime — agents will not run until Docker is available',
    );
  }
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Load pack-defined achievements (merged with built-ins)
  const clawdoodlesDir = path.resolve(process.cwd(), 'clawdoodles');
  let activePack = 'starter';
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(clawdoodlesDir, 'manifest.json'), 'utf-8'),
    );
    activePack = manifest.activePack || 'starter';
  } catch {
    /* use default */
  }
  const packJsonPath = path.join(
    clawdoodlesDir,
    'packs',
    activePack,
    'pack.json',
  );
  if (fs.existsSync(packJsonPath)) {
    loadPackAchievements(packJsonPath);
  }

  // Rebuild active threads map from DB
  for (const t of getAllThreads()) {
    activeThreads.set(t.thread_id, {
      agentJid: t.agent_jid,
      originJid: t.origin_jid,
    });
  }
  if (activeThreads.size > 0) {
    logger.info(
      { count: activeThreads.size },
      'Restored active threads from DB',
    );
  }

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Verify containers can actually run (catches UID issues, bad tokens, etc.)
  if (containerReady) {
    const smoke = checkContainerSmoke();
    if (smoke.status === 'passed') {
      logger.info(
        { version: smoke.claudeVersion },
        'Container smoke test passed',
      );
    } else {
      logger.error(
        { error: smoke.error },
        'Container smoke test FAILED — agents may not work',
      );
    }
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await pool.shutdown();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts: ChannelOpts = {
    onRegisterGroup: (jid: string, group: RegisteredGroup) => {
      registerGroup(jid, group);
    },
    onDeleteGroup: (jid: string, group: RegisteredGroup) => {
      unregisterGroup(jid, group);
    },
    onResetSession: async (groupFolder: string) => {
      logger.info({ groupFolder }, 'Resetting session');

      // 1. Evict warm pool containers for this group
      const agentIds = Object.keys(sessions).filter((id) =>
        id.startsWith(groupFolder + '/'),
      );
      for (const agentId of agentIds) {
        await pool.reclaim(agentId);
      }

      // 2. Clear session IDs from memory and DB
      for (const agentId of agentIds) {
        delete sessions[agentId];
      }
      deleteSession(groupFolder);

      // 3. Delete session files on disk
      const sessionsDir = path.join(DATA_DIR, 'sessions', groupFolder);
      if (fs.existsSync(sessionsDir)) {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
        logger.info({ sessionsDir }, 'Deleted session files');
      }

      // 4. Reset delivery-time supersession state for chats bound to this group
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === groupFolder) {
          resetChatSupersessionState(jid);
        }
      }

      logger.info(
        { groupFolder, evictedAgents: agentIds },
        'Session reset complete',
      );
    },
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      if (!msg.is_bot_message && registeredGroups[chatJid]) {
        noteVisibleMessage(chatJid, null);
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    getGroupAgents: (jid: string) =>
      (groupAgents[jid] || []).map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        trigger: a.trigger,
        status: a.status,
      })),
    refreshGroupAgents: (jid: string) =>
      refreshGroupAgents(jid).map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        trigger: a.trigger,
        status: a.status,
      })),
    getStatus: () => ({
      containers: queue.getSnapshot(),
      pool: pool.getSnapshot(),
      uptime: process.uptime(),
    }),
    getThreadInfo: (threadId: string) => activeThreads.get(threadId),
    onThreadReply: (threadId: string, agentJid: string) => {
      pendingOrigins[agentJid] = {
        originJid: activeThreads.get(threadId)!.originJid,
        threadId,
      };
      queue.enqueueMessageCheck(agentJid);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }

  // Wire up thread creation broadcast (set by web channel constructor)
  if (channelOpts.onThreadCreated) {
    broadcastThreadCreated = channelOpts.onThreadCreated;
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      // Always strip <internal> tags — agents use these for reasoning
      const stripped = stripInternalTags(rawText);
      if (!stripped) {
        if (rawText.trim().length > 0) {
          logger.warn(
            { jid, rawLen: rawText.length },
            'Scheduler output entirely stripped by <internal> tag removal — message dropped',
          );
        }
        return;
      }
      // Web channel renders blocks client-side — formatOutbound would corrupt
      // :::blocks JSON by transforming markdown inside the fences.
      const text =
        channel.name === 'web'
          ? stripped
          : formatOutbound(stripped, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
    setTyping: async (jid, isTyping) => {
      const channel = findChannel(channels, jid);
      await channel?.setTyping?.(jid, isTyping);
    },
    onProgress: (jid, event) => broadcastProgress(jid, event),
    getMainChatJid,
  });
  startPolarisSessionKeepalive();
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Always strip <internal> tags — agents use these for reasoning
      const stripped = stripInternalTags(rawText);
      if (!stripped) {
        if (rawText.trim().length > 0) {
          logger.warn(
            { jid, rawLen: rawText.length },
            'IPC send_message entirely stripped by <internal> tag removal — message dropped',
          );
        }
        return Promise.resolve();
      }
      // Web channel renders blocks client-side — formatOutbound would corrupt
      // :::blocks JSON by transforming markdown inside the fences.
      const text =
        channel.name === 'web'
          ? stripped
          : formatOutbound(stripped, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text).then(() => {});
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    onAchievement: (achievement, group) => {
      // Broadcast to web UI via any web channel
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcastAchievement' in ch) {
          (ch as any).broadcastAchievement(achievement, group);
          break;
        }
      }
    },
    storeChatMetadata: (jid, timestamp, name, channel, isGroup) => {
      storeChatMetadata(jid, timestamp, name, channel, isGroup);
    },
    onCredentialRequested: (request) => {
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcastCredentialRequest' in ch) {
          (ch as any).broadcastCredentialRequest(request);
          break;
        }
      }
    },
    onGroupRegistered: (jid) => {
      // Broadcast to web UI so sidebar updates immediately
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcastGroupsChanged' in ch) {
          (ch as any).broadcastGroupsChanged();
          break;
        }
      }
    },
    onPlaySound: (jid, tone, custom, label) => {
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcast' in ch) {
          (ch as any).broadcast('play_sound', { jid, tone, custom, label });
          break;
        }
      }
    },
    onPublishMedia: (request) => {
      const channel = findChannel(channels, request.chatJid);
      if (!channel) {
        logger.warn(
          { jid: request.chatJid },
          'Media publish: no channel found',
        );
        return;
      }

      if (channel.name !== 'web' || !('publishMediaMessage' in channel)) {
        void channel.sendMessage(
          request.chatJid,
          request.caption
            ? `${request.caption}\n\n[Media publishing is currently supported in the web UI only.]`
            : '[Media publishing is currently supported in the web UI only.]',
          request.threadId,
        );
        return;
      }

      if (!request.containerPath.startsWith('/workspace/group/')) {
        logger.warn(
          { path: request.containerPath, group: request.sourceGroup },
          'Media publish rejected: unsupported container path',
        );
        return;
      }

      const groupDir = resolveGroupFolderPath(request.sourceGroup);
      const relativePath = request.containerPath.slice(
        '/workspace/group/'.length,
      );
      const hostPath = path.resolve(groupDir, relativePath);
      if (!isPathInside(groupDir, hostPath) || !fs.existsSync(hostPath)) {
        logger.warn(
          { hostPath, groupDir },
          'Media publish rejected: host file missing or outside group dir',
        );
        return;
      }

      const ext = path.extname(hostPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        logger.warn(
          { hostPath, ext },
          'Media publish rejected: unsupported media type in phase 1',
        );
        return;
      }
      const safeChatDir = request.chatJid.replace(/[^a-zA-Z0-9:_-]/g, '_');
      const mediaDir = path.join(DATA_DIR, 'media', safeChatDir);
      fs.mkdirSync(mediaDir, { recursive: true });
      const artifactId = randomUUID();
      const destPath = path.join(mediaDir, `${artifactId}${ext}`);
      fs.copyFileSync(hostPath, destPath);

      const artifact: MediaArtifact = {
        id: artifactId,
        chat_jid: request.chatJid,
        thread_id: request.threadId,
        created_at: new Date().toISOString(),
        source: request.source || 'agent_browser',
        media_type: 'image',
        mime_type: getMimeTypeForPath(destPath),
        path: destPath,
        agent_name: request.sender,
        caption: request.caption,
        alt: request.alt,
      };
      storeMediaArtifact(artifact);
      (channel as any).publishMediaMessage(
        request.chatJid,
        artifact,
        request.sender,
      );
      broadcastProgress(request.chatJid, {
        tool: 'media',
        summary: request.threadId
          ? 'Published image in thread'
          : 'Published image to chat',
        timestamp: new Date().toISOString(),
      });
    },
    onDelegateToAgent: (request) => {
      const {
        sourceGroup,
        chatJid: delegationChatJid,
        targetAgent,
        message,
        sourceAgent,
        sourceBatchId,
        completionPolicy,
      } = request;

      // Find the group JID from the source folder
      const groupJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid].folder === sourceGroup,
      );
      if (!groupJid) {
        logger.warn(
          { sourceGroup, targetAgent },
          'Delegation: group not found',
        );
        return;
      }
      const group = registeredGroups[groupJid];
      const agents = groupAgents[groupJid] || [];
      const agent = agents.find((a) => a.name === targetAgent);
      if (!agent) {
        logger.warn(
          { sourceGroup, targetAgent, available: agents.map((a) => a.name) },
          'Delegation: target agent not found',
        );
        return;
      }

      const chatJid = delegationChatJid || groupJid;
      const channel = findChannel(channels, chatJid);
      if (!channel) {
        logger.warn({ chatJid }, 'Delegation: no channel for JID');
        return;
      }

      logger.info(
        {
          group: group.name,
          source: sourceAgent,
          target: targetAgent,
          messageLen: message.length,
        },
        'Processing agent delegation',
      );

      // Run the delegation in parallel — delegations bypass per-group
      // serialization and can run alongside the coordinator and other
      // delegations. The queue re-triggers the coordinator automatically
      // when all delegations for a group complete.
      const savedConfig = group.containerConfig;
      const DELEGATION_TIMEOUT = 120_000; // 2 minutes
      const taskId = `delegation-${agent.name}-${Date.now()}`;
      // Share coordinator's network namespace so delegation containers can
      // reach services (e.g. Storybook) running on the coordinator's localhost.
      const coordinatorContainer = queue.getCoordinatorContainerName(chatJid);
      queue.enqueueDelegation(
        chatJid,
        taskId,
        async () => {
          const batchId = sourceBatchId || `delegation-${randomUUID()}`;
          const lease = beginDeliveryLease(chatJid, batchId);
          let deliveredToUser = false;
          group.containerConfig = {
            ...savedConfig,
            timeout: Math.min(
              savedConfig?.timeout || Infinity,
              DELEGATION_TIMEOUT,
            ),
          };
          // Build prompt at execution time (not enqueue time) so conversation
          // context includes any messages that arrived while queued.
          const multiAgentCtx = buildMultiAgentContext(agent, agents);
          const recentMessages = getMessagesSince(
            chatJid,
            '',
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
            true, // include bot messages for full context
          );
          const conversationCtx = formatMessages(recentMessages, TIMEZONE);
          const delegationPrompt =
            multiAgentCtx +
            conversationCtx +
            `\n\n--- Delegation from ${sourceAgent} ---\n${message}\n--- End delegation ---\n`;

          setActiveAgentName(chatJid, agent.displayName);
          await channel.setTyping?.(chatJid, true);
          // Intermediate TEXT blocks are shown as status in the typing indicator

          const status = await runAgent(
            group,
            delegationPrompt,
            chatJid,
            async (result) => {
              if (result.result) {
                if (
                  result.textsAlreadyStreamed &&
                  result.textsAlreadyStreamed > 0
                ) {
                  // Text already delivered via intermediate markers
                } else {
                  const raw =
                    typeof result.result === 'string'
                      ? result.result
                      : JSON.stringify(result.result);
                  const text = raw
                    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                    .trim();
                  if (text) {
                    // Set agent name right before sending — parallel delegations
                    // share the same chatJid so we must claim the name each time
                    setActiveAgentName(chatJid, agent.displayName);
                    if (
                      await deliverAgentMessage(channel, chatJid, text, lease)
                    ) {
                      deliveredToUser = true;
                    }
                  }
                }
              }
              // Delegation containers exit on their own (isDelegation skips
              // the idle loop in agent-runner) — no notifyIdle needed.
              if (result.status === 'success') {
                await channel.setTyping?.(
                  chatJid,
                  false,
                  undefined,
                  agent.displayName,
                );
              }
              if (result.status === 'error') {
                await channel.setTyping?.(
                  chatJid,
                  false,
                  undefined,
                  agent.displayName,
                );
              }
            },
            (event) => broadcastProgress(chatJid, event),
            async (rawText) => {
              const text = rawText
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();
              if (!text) return;
              setActiveAgentName(chatJid, agent.displayName);
              if (await deliverAgentMessage(channel, chatJid, text, lease)) {
                deliveredToUser = true;
              }
            },
            agent,
            true, // isDelegation — use shorter timeout
            async (text) => {
              setActiveAgentName(chatJid, agent.displayName);
              if (await deliverAgentMessage(channel, chatJid, text, lease)) {
                deliveredToUser = true;
              }
            },
            batchId,
            coordinatorContainer || undefined,
          );

          group.containerConfig = savedConfig; // restore original config
          clearActiveAgentName(chatJid);
          await channel.setTyping?.(
            chatJid,
            false,
            undefined,
            agent.displayName,
          );
          if (persistExplicitAgentStatus(chatJid, agent.name, '')) {
            logger.info(
              { jid: chatJid, agentName: agent.name },
              'Cleared agent status after delegation completed',
            );
          }

          // Evaluate and execute automation rules on delegation result
          if (status === 'success') {
            const resultTraces = evaluateAutomationRules(
              group.folder,
              {
                type: 'agent_result',
                groupJid: chatJid,
                groupFolder: group.folder,
                agentName: agent.name,
              },
              agents.map((a) => a.name),
            );
            if (resultTraces.length > 0) {
              await executeAutomationActions(
                resultTraces,
                chatJid,
                group,
                agents,
                channel,
                '',
              );
            }
          }

          // Store a system message so the coordinator sees the result attribution.
          // The queue re-triggers the coordinator when all delegations complete.
          const resultNote =
            status === 'error'
              ? `[${agent.displayName} was unable to complete the delegated task.]`
              : deliveredToUser
                ? `[${agent.displayName} has responded above.]`
                : `[${agent.displayName} completed but output was superseded by newer context.]`;
          storeMessage({
            id: `delegation-result-${Date.now()}`,
            chat_jid: chatJid,
            sender: 'system',
            sender_name: 'System',
            content: resultNote,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          });
          logger.info(
            { group: group.name, target: targetAgent, status },
            'Delegation complete',
          );
        },
        agent.displayName,
        completionPolicy !== 'retrigger_coordinator',
      );
    },
    onSetSubtitle: (jid, subtitle) => {
      // Update DB and broadcast
      const group = registeredGroups[jid];
      if (group) {
        group.subtitle = subtitle || undefined;
        setGroupSubtitle(jid, subtitle);
        broadcastWebGroupsChanged();
        logger.info({ jid, subtitle }, 'Group subtitle updated via MCP');
      }
    },
    onSetAgentStatus: (jid, agentName, status) => {
      const updated = persistExplicitAgentStatus(jid, agentName, status);
      if (!updated) {
        logger.warn(
          { jid, agentName },
          'Agent status update for unknown agent',
        );
        return;
      }
      logger.info(
        { jid, agentName, status: status.trim() },
        'Agent status updated via MCP',
      );
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnWorkState(broadcastWorkState);
  recoverPendingMessages();

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
