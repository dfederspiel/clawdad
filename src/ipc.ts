import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import type { AchievementDef } from './achievements.js';
import { unlockAchievement } from './achievements.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onAchievement?: (achievement: AchievementDef, group: string) => void;
  onGroupRegistered?: (jid: string) => void;
  storeChatMetadata?: (
    jid: string,
    timestamp: string,
    name: string,
    channel: string,
    isGroup: boolean,
  ) => void;
  onCredentialRequested?: (request: {
    service: string;
    hostPattern?: string;
    description?: string;
    email?: string;
    groupFolder: string;
  }) => void;
  onPlaySound?: (
    jid: string,
    tone?: string,
    custom?: unknown,
    label?: string,
  ) => void;
  onSetSubtitle?: (jid: string, subtitle: string) => void;
  onSetAgentStatus?: (jid: string, agentName: string, status: string) => void;
  onDelegateToAgent?: (request: {
    sourceGroup: string;
    chatJid: string;
    targetAgent: string;
    message: string;
    sourceAgent: string;
    sourceBatchId?: string;
    completionPolicy?: 'final_response' | 'retrigger_coordinator';
  }) => void;
  onPublishMedia?: (request: {
    sourceGroup: string;
    chatJid: string;
    containerPath: string;
    caption?: string;
    alt?: string;
    threadId?: string;
    sender?: string;
    source?: 'agent_browser' | 'agent_output' | 'user_upload';
  }) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid.
                // Main can send anywhere. Others can send to themselves
                // or escalate to the main group.
                const targetGroup = registeredGroups[data.chatJid];
                const targetIsMain = targetGroup?.isMain === true;
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup) ||
                  targetIsMain
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'publish_media' &&
                data.chatJid &&
                data.containerPath
              ) {
                deps.onPublishMedia?.({
                  sourceGroup,
                  chatJid: data.chatJid,
                  containerPath: data.containerPath,
                  caption: data.caption || undefined,
                  alt: data.alt || undefined,
                  threadId: data.threadId || undefined,
                  sender: data.sender || undefined,
                  source: data.source || 'agent_browser',
                });
                logger.info(
                  {
                    chatJid: data.chatJid,
                    sourceGroup,
                    path: data.containerPath,
                  },
                  'IPC media publish requested',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process agent delegations from this group's IPC directory
      const delegationsDir = path.join(ipcBaseDir, sourceGroup, 'delegations');
      try {
        if (fs.existsSync(delegationsDir)) {
          const delegationFiles = fs
            .readdirSync(delegationsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of delegationFiles) {
            const filePath = path.join(delegationsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              if (
                data.type === 'delegate' &&
                data.targetAgent &&
                data.message
              ) {
                if (deps.onDelegateToAgent) {
                  deps.onDelegateToAgent({
                    sourceGroup,
                    chatJid: data.chatJid || '',
                    targetAgent: data.targetAgent,
                    message: data.message,
                    sourceAgent: data.sourceAgent || 'unknown',
                    sourceBatchId: data.sourceBatchId || '',
                    completionPolicy: data.completionPolicy || 'final_response',
                  });
                  logger.info(
                    {
                      sourceGroup,
                      sourceAgent: data.sourceAgent,
                      sourceAgentId: data.sourceAgentId,
                      sourceBatchId: data.sourceBatchId,
                      sourceSessionId: data.sourceSessionId,
                      targetAgent: data.targetAgent,
                    },
                    'Agent delegation requested',
                  );
                }
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC delegation',
              );
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC delegations directory',
        );
      }

      // Process achievement unlocks from this group's IPC directory
      const achievementsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'achievements',
      );
      try {
        if (fs.existsSync(achievementsDir)) {
          const achFiles = fs
            .readdirSync(achievementsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of achFiles) {
            const filePath = path.join(achievementsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              if (data.type === 'achievement' && data.achievementId) {
                const def = unlockAchievement(data.achievementId, sourceGroup);
                if (def) {
                  deps.onAchievement?.(def, sourceGroup);
                }
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC achievement',
              );
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* already gone */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC achievements directory',
        );
      }

      // Process credential registrations from this group's IPC directory
      const credentialsDir = path.join(ipcBaseDir, sourceGroup, 'credentials');
      try {
        if (fs.existsSync(credentialsDir)) {
          const credFiles = fs
            .readdirSync(credentialsDir)
            .filter((f) => f.endsWith('.json') && !f.startsWith('result-'));
          for (const file of credFiles) {
            const filePath = path.join(credentialsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath); // Remove immediately — contains secret
              await processCredentialIpc(
                data,
                sourceGroup,
                credentialsDir,
                deps,
              );
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC credential',
              );
              // Don't move to errors dir — may contain secrets. Just delete.
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* already gone */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC credentials directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    title?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For register_team
    coordinator?: {
      name?: string;
      displayName?: string;
      instructions?: string;
    };
    specialists?: Array<{
      name: string;
      displayName?: string;
      trigger: string;
      instructions?: string;
    }>;
    // For request_credential
    service?: string;
    hostPattern?: string;
    description?: string;
    email?: string;
    // For play_sound
    tone?: string;
    custom?: unknown;
    label?: string;
    // For set_subtitle
    subtitle?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          title: data.title || undefined,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
        // Create chat metadata so messages can be stored (foreign key)
        const channel = data.jid.startsWith('web:') ? 'web' : 'unknown';
        deps.storeChatMetadata?.(
          data.jid,
          new Date().toISOString(),
          data.name,
          channel,
          true,
        );
        deps.onGroupRegistered?.(data.jid);
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'register_team': {
      // Only main group can create teams
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_team attempt blocked',
        );
        break;
      }
      if (
        !data.name ||
        !data.folder ||
        !data.coordinator ||
        !Array.isArray(data.specialists) ||
        data.specialists.length === 0
      ) {
        logger.warn(
          { data },
          'Invalid register_team request - missing required fields',
        );
        break;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.folder)) {
        logger.warn(
          { folder: data.folder },
          'Invalid register_team request - unsafe folder name',
        );
        break;
      }
      const teamFolder = `web_${data.folder}`;
      const teamJid = `web:${data.folder}`;
      if (registeredGroups[teamJid]) {
        logger.warn({ jid: teamJid }, 'register_team: group already exists');
        break;
      }

      // Validate specialist names are unique
      const agentNames = new Set<string>();
      const coordName = data.coordinator.name || 'coordinator';
      agentNames.add(coordName);
      let hasDuplicate = false;
      for (const spec of data.specialists) {
        const specName = spec.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (agentNames.has(specName)) {
          logger.warn({ specName }, 'register_team: duplicate agent name');
          hasDuplicate = true;
          break;
        }
        agentNames.add(specName);
      }
      if (hasDuplicate) break;

      const teamGroupDir = path.resolve(process.cwd(), 'groups', teamFolder);

      // Group-level CLAUDE.md
      fs.mkdirSync(teamGroupDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamGroupDir, 'CLAUDE.md'),
        `# ${data.name}\n\nMulti-agent team. See agents/ for individual agent instructions.\n`,
      );

      // Coordinator agent
      const coordDir = path.join(teamGroupDir, 'agents', coordName);
      fs.mkdirSync(coordDir, { recursive: true });
      fs.writeFileSync(
        path.join(coordDir, 'CLAUDE.md'),
        data.coordinator.instructions ||
          `# ${data.coordinator.displayName || 'Coordinator'}\n\nYou are the coordinator for the ${data.name} team.\n`,
      );
      fs.writeFileSync(
        path.join(coordDir, 'agent.json'),
        JSON.stringify(
          {
            displayName: data.coordinator.displayName || 'Coordinator',
          },
          null,
          2,
        ) + '\n',
      );

      // Specialist agents
      for (const spec of data.specialists) {
        const specName = spec.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const specDir = path.join(teamGroupDir, 'agents', specName);
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(
          path.join(specDir, 'CLAUDE.md'),
          spec.instructions ||
            `# ${spec.displayName || spec.name}\n\nYou are a specialist on the ${data.name} team.\n`,
        );
        fs.writeFileSync(
          path.join(specDir, 'agent.json'),
          JSON.stringify(
            {
              displayName: spec.displayName || spec.name,
              trigger: spec.trigger,
            },
            null,
            2,
          ) + '\n',
        );
      }

      // Register the group
      deps.registerGroup(teamJid, {
        name: data.name,
        folder: teamFolder,
        trigger: `@${data.name}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
      const teamChannel = 'web';
      deps.storeChatMetadata?.(
        teamJid,
        new Date().toISOString(),
        data.name,
        teamChannel,
        true,
      );
      deps.onGroupRegistered?.(teamJid);
      logger.info(
        { teamJid, teamFolder, agents: Array.from(agentNames) },
        'Multi-agent team registered via IPC',
      );
      break;
    }

    case 'request_credential':
      // Broadcast to web UI to show the credential popup
      if (data.service) {
        deps.onCredentialRequested?.({
          service: data.service as string,
          hostPattern: data.hostPattern as string | undefined,
          description: data.description as string | undefined,
          email: data.email as string | undefined,
          groupFolder: sourceGroup,
        });
      }
      break;

    case 'play_sound':
      deps.onPlaySound?.(
        data.chatJid as string,
        data.tone as string | undefined,
        data.custom,
        data.label as string | undefined,
      );
      break;

    case 'set_subtitle':
      deps.onSetSubtitle?.(
        data.chatJid as string,
        (data.subtitle as string) || '',
      );
      break;

    case 'set_agent_status':
      if (data.chatJid && 'agentName' in data && data.agentName) {
        deps.onSetAgentStatus?.(
          data.chatJid as string,
          data.agentName as string,
          ('status' in data ? (data.status as string) : '') || '',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

interface CredentialIpcData {
  service: string;
  value: string;
  name?: string;
}

/**
 * Default env var names for known services.
 * Agent can override by providing a custom name.
 */
const SERVICE_ENV_NAMES: Record<string, string> = {
  github: 'GITHUB_TOKEN',
  gitlab: 'GITLAB_TOKEN',
  atlassian: 'ATLASSIAN_API_TOKEN',
  blackduck: 'BLACKDUCK_API_TOKEN',
  launchdarkly: 'LAUNCHDARKLY_API_KEY',
  harness: 'HARNESS_API_KEY',
};

/**
 * Register a credential by writing it to .env.
 * Simple: name → value, no host patterns, no header format knowledge.
 */
async function processCredentialIpc(
  data: CredentialIpcData,
  sourceGroup: string,
  credentialsDir: string,
  deps: IpcDeps,
): Promise<void> {
  const { service, value, name } = data;

  if (!value) {
    logger.warn({ sourceGroup }, 'Credential IPC missing value');
    writeCredentialResult(credentialsDir, service, false, 'Missing value');
    return;
  }

  // Determine env var name: explicit name > service default > SERVICE_TOKEN
  const envName =
    name ||
    SERVICE_ENV_NAMES[service] ||
    `${(service || 'CREDENTIAL').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;

  try {
    const { writeEnvVar } = await import('./env.js');
    writeEnvVar(envName, value);
    logger.info({ envName, sourceGroup }, 'Credential saved to .env');
    writeCredentialResult(
      credentialsDir,
      service || envName,
      true,
      `Saved as ${envName} — available immediately via the credential proxy`,
      envName,
    );
    notifyGroupCredentialResult(
      deps,
      sourceGroup,
      service || envName,
      true,
      undefined,
      envName,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Never include the secret value in error messages
    const safeError = msg.replace(value, '[REDACTED]');
    logger.error(
      { envName, sourceGroup, err: safeError },
      'Failed to save credential',
    );
    writeCredentialResult(
      credentialsDir,
      service || envName,
      false,
      `Failed: ${safeError}`,
    );
    notifyGroupCredentialResult(
      deps,
      sourceGroup,
      service || envName,
      false,
      safeError,
    );
  }
}

function writeCredentialResult(
  credentialsDir: string,
  service: string,
  success: boolean,
  message: string,
  envName?: string,
): void {
  try {
    const resultPath = path.join(credentialsDir, `result-${service}.json`);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        success,
        message,
        envName: envName || undefined,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    // Best-effort — container polls for this file
  }
}

/**
 * Send a chat message to the group that requested a credential,
 * so the agent knows the credential was registered (or failed)
 * without having to poll.
 */
function notifyGroupCredentialResult(
  deps: IpcDeps,
  sourceGroup: string,
  service: string,
  success: boolean,
  errorMessage?: string,
  envName?: string,
): void {
  // Find the JID for this group folder
  const groups = deps.registeredGroups();
  const jid = Object.keys(groups).find((k) => groups[k].folder === sourceGroup);
  if (!jid) return;

  const text = success
    ? `[credential_registered] The "${service}" credential has been registered successfully (env: ${envName || service}). ` +
      `Use \`api.sh ${service} GET <url>\` for HTTP calls or \`cred-exec.sh ${service} ${envName || service} -- <command>\` for CLI tools. ` +
      `Do NOT use raw curl — the credential proxy injects the real value at request time.`
    : `[credential_failed] The "${service}" credential registration failed: ${errorMessage}`;

  deps.sendMessage(jid, text).catch((err) => {
    logger.debug(
      { err, service, sourceGroup },
      'Failed to send credential notification',
    );
  });
}
