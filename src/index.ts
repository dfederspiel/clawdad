import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TRIGGER_IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
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
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
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
  setGroupSubtitle,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
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
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

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

const channels: Channel[] = [];
const queue = new GroupQueue();

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

  logger.info(
    { groupCount: Object.keys(registeredGroups).length, configApplied },
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

  logger.info(
    { jid, name: group.name, folder: group.folder },
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
  delete sessions[group.folder];
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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
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

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
    false, // includeBotMessages
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
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
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

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
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

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(chatJid);
      },
      group.requiresTrigger ? TRIGGER_IDLE_TIMEOUT : IDLE_TIMEOUT,
    );
  };
  const responseJid = originJid || chatJid;
  const responseChannel = originJid
    ? findChannel(channels, originJid) || channel
    : channel;

  await responseChannel.setTyping?.(responseJid, true, threadId);
  let hadError = false;
  // Track output per query within streaming containers. Reset on each
  // query completion so silent completions are detected even when a
  // prior query in the same container session produced output.
  let outputSentForCurrentQuery = false;
  let outputSentToUser = false;
  let silentCompletion = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name, responseJid, threadId: threadId || null },
          `Agent output: ${raw.length} chars → ${threadId ? 'thread' : 'main'}`,
        );
        if (text) {
          await responseChannel.sendMessage(responseJid, text, threadId);
          outputSentToUser = true;
          outputSentForCurrentQuery = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (!result.status) {
        // Intermediate result — agent is still running. Re-assert typing so
        // the frontend indicator comes back after clearing on message receipt.
        await responseChannel.setTyping?.(responseJid, true, threadId);
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);

        // Detect silent completion: agent returned success with null result
        // and no output was sent for THIS query. The agent-runner handles
        // retries internally (pushes a follow-up prompt into the SDK stream),
        // so this should be rare — only happens if the retry also fails.
        if (!outputSentForCurrentQuery && !result.result) {
          silentCompletion = true;
          logger.warn(
            { group: group.name },
            'Agent returned null result after agent-runner retry — silent completion',
          );
        }
        // Clear typing on every completion. The agent-runner retry happens
        // inside the container (no host round-trip), so the SDK will
        // re-assert typing via progress events if it continues.
        await responseChannel.setTyping?.(responseJid, false, threadId);
        // Reset per-query tracking for the next query in this container
        outputSentForCurrentQuery = false;
      }

      if (result.status === 'error') {
        await responseChannel.setTyping?.(responseJid, false, threadId);
        hadError = true;
      }
    },
    (event) => {
      broadcastProgress(responseJid, event);
    },
  );

  await responseChannel.setTyping?.(responseJid, false, threadId);
  // Clean up origin tracking after processing — but only if it hasn't been
  // re-set by a new thread reply arriving during this processing cycle.
  if (originJid && pendingOrigins[chatJid] === pendingOrigin) {
    delete pendingOrigins[chatJid];
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
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
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

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

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
            session_id: sessions[group.folder],
            timestamp: new Date().toISOString(),
            input_tokens: u.inputTokens,
            output_tokens: u.outputTokens,
            cache_read_tokens: u.cacheReadTokens,
            cache_write_tokens: u.cacheWriteTokens,
            cost_usd: u.costUsd,
            duration_ms: u.durationMs,
            num_turns: u.numTurns,
            is_error: output.status === 'error',
          });
          attachUsageToLastBotMessage(chatJid, JSON.stringify(u));
          broadcastUsage(chatJid, u);
          logger.info(
            {
              group: group.name,
              cost: u.costUsd,
              turns: u.numTurns,
              tokens: u.inputTokens + u.outputTokens,
            },
            'Agent run usage stored',
          );
        }
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        achievements: getAchievementsForContainer(),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onProgress,
    );

    if (output.status === 'error') {
      // If the error is a missing session, clear the stale session so the next
      // attempt starts fresh instead of retrying the same broken session forever.
      if (output.error?.includes('No conversation found with session ID')) {
        logger.warn(
          { group: group.name },
          'Clearing stale session after "not found" error',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    return 'success';
  } catch (err) {
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
          if (pendingOrigins[chatJid]) continue;

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

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
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

          if (queue.sendMessage(chatJid, formatted)) {
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
            // No active container — enqueue for a new one
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
    getStatus: () => ({
      containers: queue.getSnapshot(),
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
      if (!stripped) return;
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
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Always strip <internal> tags — agents use these for reasoning
      const stripped = stripInternalTags(rawText);
      if (!stripped) return Promise.resolve();
      // Web channel renders blocks client-side — formatOutbound would corrupt
      // :::blocks JSON by transforming markdown inside the fences.
      const text =
        channel.name === 'web'
          ? stripped
          : formatOutbound(stripped, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
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
    onSetSubtitle: (jid, subtitle) => {
      // Update DB and broadcast
      const group = registeredGroups[jid];
      if (group) {
        group.subtitle = subtitle || undefined;
        setGroupSubtitle(jid, subtitle);
        for (const ch of channels) {
          if (ch.name === 'web' && 'broadcastGroupsChanged' in ch) {
            (ch as any).broadcastGroupsChanged();
            break;
          }
        }
        logger.info({ jid, subtitle }, 'Group subtitle updated via MCP');
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
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
