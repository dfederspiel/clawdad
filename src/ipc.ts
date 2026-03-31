import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import type { AchievementDef } from './achievements.js';
import { unlockAchievement } from './achievements.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const execAsync = promisify(exec);

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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
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
    // For request_credential
    service?: string;
    hostPattern?: string;
    description?: string;
    email?: string;
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Supported credential services and their OneCLI secret configurations.
 * Each entry maps a service name to the OneCLI flags needed to register it.
 */
const CREDENTIAL_SERVICES: Record<
  string,
  {
    type: 'generic';
    headerName: string;
    valueFormat: string;
    defaultHostPattern: string;
  }
> = {
  atlassian: {
    type: 'generic',
    headerName: 'Authorization',
    valueFormat: 'Basic {value}',
    defaultHostPattern: '*.atlassian.net',
  },
  gitlab: {
    type: 'generic',
    headerName: 'PRIVATE-TOKEN',
    valueFormat: '{value}',
    defaultHostPattern: 'gitlab.com',
  },
  github: {
    type: 'generic',
    headerName: 'Authorization',
    valueFormat: 'token {value}',
    defaultHostPattern: '*.github.com',
  },
  launchdarkly: {
    type: 'generic',
    headerName: 'Authorization',
    valueFormat: '{value}',
    defaultHostPattern: 'app.launchdarkly.com',
  },
};

interface CredentialIpcData {
  service: string;
  value: string;
  email?: string; // For Atlassian basic auth
  hostPattern?: string;
  name?: string;
}

/**
 * Register a credential via the OneCLI HTTP API.
 * Works on all platforms (including Windows where the onecli CLI isn't available).
 * Falls back to CLI if the API is unreachable.
 */
async function registerCredentialViaApi(
  secretName: string,
  serviceConfig: { type: string; headerName: string },
  secretValue: string,
  hostPattern: string,
  valueFormat: string,
): Promise<{ success: boolean; duplicate: boolean; error: string }> {
  const { ONECLI_URL } = await import('./config.js');
  const apiUrl = `${ONECLI_URL}/api/secrets`;

  try {
    const body = JSON.stringify({
      name: secretName,
      type: serviceConfig.type,
      value: secretValue,
      hostPattern,
      headerName: serviceConfig.headerName,
      valueFormat,
    });

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { success: true, duplicate: false, error: '' };
    }

    const text = await response.text().catch(() => '');
    if (
      response.status === 409 ||
      text.includes('already exists') ||
      text.includes('conflict')
    ) {
      return { success: false, duplicate: true, error: '' };
    }

    return {
      success: false,
      duplicate: false,
      error: `OneCLI API returned ${response.status}: ${text}`,
    };
  } catch (err) {
    // API unreachable — try CLI fallback
    try {
      const args = [
        'secrets',
        'create',
        '--name',
        secretName,
        '--type',
        serviceConfig.type,
        '--value',
        secretValue,
        '--host-pattern',
        hostPattern,
        '--header-name',
        serviceConfig.headerName,
        '--value-format',
        valueFormat,
      ];

      await execAsync(
        `onecli ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
        { timeout: 15_000 },
      );
      return { success: true, duplicate: false, error: '' };
    } catch (cliErr) {
      const msg = cliErr instanceof Error ? cliErr.message : String(cliErr);
      if (
        msg.includes('409') ||
        msg.includes('already exists') ||
        msg.includes('conflict')
      ) {
        return { success: false, duplicate: true, error: '' };
      }
      return { success: false, duplicate: false, error: msg };
    }
  }
}

async function processCredentialIpc(
  data: CredentialIpcData,
  sourceGroup: string,
  credentialsDir: string,
  deps: IpcDeps,
): Promise<void> {
  const { service, value, email, hostPattern, name } = data;

  if (!service || !value) {
    logger.warn({ sourceGroup }, 'Credential IPC missing service or value');
    writeCredentialResult(
      credentialsDir,
      service,
      false,
      'Missing service or value',
    );
    return;
  }

  const serviceConfig = CREDENTIAL_SERVICES[service];
  if (!serviceConfig) {
    logger.warn({ service, sourceGroup }, 'Unknown credential service');
    writeCredentialResult(
      credentialsDir,
      service,
      false,
      `Unknown service: ${service}`,
    );
    return;
  }

  const host = hostPattern || serviceConfig.defaultHostPattern;
  const secretName = name || `${service}-${sourceGroup}`;

  // For Atlassian, the value needs to be base64(email:token) for basic auth
  let secretValue = value;
  let valueFormat = serviceConfig.valueFormat;
  if (service === 'atlassian' && email) {
    secretValue = Buffer.from(`${email}:${value}`).toString('base64');
  } else if (service === 'atlassian' && !email) {
    // If no email provided, assume value is already the full token/key
    valueFormat = 'Basic {value}';
  }

  // Try HTTP API first (works on all platforms including Windows),
  // fall back to CLI if the API isn't available.
  const registered = await registerCredentialViaApi(
    secretName,
    serviceConfig,
    secretValue,
    host,
    valueFormat,
  );

  if (registered.success) {
    logger.info(
      { service, sourceGroup, host, secretName },
      'Credential registered via IPC',
    );
    writeCredentialResult(
      credentialsDir,
      service,
      true,
      'Credential registered successfully',
    );
    notifyGroupCredentialResult(deps, sourceGroup, service, true);
  } else if (registered.duplicate) {
    logger.info({ service, sourceGroup }, 'Credential already exists in vault');
    writeCredentialResult(
      credentialsDir,
      service,
      true,
      'Credential already registered',
    );
    notifyGroupCredentialResult(deps, sourceGroup, service, true);
  } else {
    // Sanitize error — never include the secret value
    const safeError = registered.error.replace(secretValue, '[REDACTED]');
    logger.error(
      { service, sourceGroup, err: safeError },
      'Failed to register credential',
    );
    writeCredentialResult(
      credentialsDir,
      service,
      false,
      `Registration failed: ${safeError}`,
    );
    notifyGroupCredentialResult(deps, sourceGroup, service, false, safeError);
  }
}

function writeCredentialResult(
  credentialsDir: string,
  service: string,
  success: boolean,
  message: string,
): void {
  try {
    const resultPath = path.join(credentialsDir, `result-${service}.json`);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ success, message, timestamp: new Date().toISOString() }),
    );
  } catch {
    // Best-effort — container may check for this but it's not critical
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
): void {
  // Find the JID for this group folder
  const groups = deps.registeredGroups();
  const jid = Object.keys(groups).find((k) => groups[k].folder === sourceGroup);
  if (!jid) return;

  const text = success
    ? `[credential_registered] The "${service}" credential has been registered successfully. You can now make API calls to this service.`
    : `[credential_failed] The "${service}" credential registration failed: ${errorMessage}`;

  deps.sendMessage(jid, text).catch((err) => {
    logger.debug(
      { err, service, sourceGroup },
      'Failed to send credential notification',
    );
  });
}
