import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { getAchievementsForContainer } from './achievements.js';
import { buildMultiAgentContext, discoverAgents } from './agent-discovery.js';
import { setActiveAgentName } from './agent-state.js';
import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  ProgressEvent,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { evaluateAutomationRules } from './automation-rules.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  resolveEffectiveRuntime,
  resolveTurnConstraints,
} from './runtime-resolution.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface TaskFailureEvent {
  taskId: string;
  taskTitle: string;
  groupFolder: string;
  groupName: string;
  chatJid: string;
  error: string;
  runAt: string;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    agentName: string,
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    fromTaskId?: string,
  ) => Promise<void>;
  setTyping?: (jid: string, isTyping: boolean) => Promise<void>;
  onProgress?: (jid: string, event: ProgressEvent) => void;
  getMainChatJid?: () => string | undefined;
  onTasksChanged?: () => void;
  onTaskFailed?: (event: TaskFailureEvent) => void;
  onTaskRunSucceeded?: (event: { taskId: string; chatJid: string }) => void;
}

export async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  queueJid: string,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Resolve agents so scheduled tasks get the same agent-aware container
  // input as interactive runs (canDelegate, systemContext, runtime, etc.).
  const agents = discoverAgents(group);
  const coordinator = agents.find((a) => !a.trigger) || agents[0];
  const isMultiAgent = agents.length > 1;
  const multiAgentCtx = isMultiAgent
    ? buildMultiAgentContext(coordinator, agents)
    : undefined;

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(queueJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    // Mirror the regular message-loop path: in multi-agent groups, declare
    // the coordinator as the active agent before starting work so the typing
    // SSE event carries an agent_name (drives the per-agent dot in the
    // sidebar drawer + "X is thinking" label) and any bot messages emitted
    // during the run are attributed correctly.
    if (isMultiAgent && coordinator) {
      setActiveAgentName(task.chat_jid, coordinator.displayName);
    }
    await deps.setTyping?.(task.chat_jid, true);

    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: coordinator.displayName || ASSISTANT_NAME,
        agentId: coordinator.id,
        agentName: coordinator.name,
        runtime: resolveEffectiveRuntime(coordinator, task.group_folder),
        constraints: resolveTurnConstraints(coordinator, group),
        canDelegate: !coordinator.trigger,
        systemContext: multiAgentCtx,
        mainChatJid: isMain ? undefined : deps.getMainChatJid?.(),
        script: task.script || undefined,
        achievements: getAchievementsForContainer(),
      },
      (proc, containerName) =>
        deps.onProcess(
          queueJid,
          proc,
          containerName,
          task.group_folder,
          coordinator.name,
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting).
          // Pass task.id so the stored row is tagged for the prompt-context
          // floor on later interactive turns (#28).
          await deps.sendMessage(task.chat_jid, streamedOutput.result, task.id);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(queueJid);
          await deps.setTyping?.(task.chat_jid, false);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          await deps.setTyping?.(task.chat_jid, false);
          error = streamedOutput.error || 'Unknown error';
        }
        if (!streamedOutput.status) {
          // Intermediate result — re-assert typing so the indicator comes back
          await deps.setTyping?.(task.chat_jid, true);
        }
      },
      (event) => deps.onProgress?.(task.chat_jid, event),
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );

    // Evaluate automation rules on task completion (traces logged; execution
    // of task_completed actions deferred to Phase 3 when scheduler has channel access)
    if (!error) {
      evaluateAutomationRules(task.group_folder, {
        type: 'task_completed',
        groupJid: task.chat_jid,
        groupFolder: task.group_folder,
        taskId: task.id,
      });
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    await deps.setTyping?.(task.chat_jid, false);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  const runAt = new Date().toISOString();

  logTaskRun({
    task_id: task.id,
    run_at: runAt,
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);

  if (error) {
    deps.onTaskFailed?.({
      taskId: task.id,
      taskTitle: task.title || task.prompt.split('\n')[0].slice(0, 80),
      groupFolder: task.group_folder,
      groupName: group?.name || task.group_folder,
      chatJid: task.chat_jid,
      error,
      runAt,
    });
  } else {
    deps.onTaskRunSucceeded?.({
      taskId: task.id,
      chatJid: task.chat_jid,
    });
  }

  // next_run has advanced — refresh snapshots + broadcast so the web UI
  // re-sorts the sidebar when sorted by upcoming schedule.
  deps.onTasksChanged?.();
}

/**
 * Manually trigger a task to run as soon as the group queue is free.
 * Mirrors the scheduler-loop dispatch logic so the same code path executes.
 */
export function runTaskNow(taskId: string, deps: SchedulerDependencies): void {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const groups = deps.registeredGroups();
  const queueJid =
    Object.keys(groups).find(
      (jid) => groups[jid].folder === task.group_folder,
    ) ?? task.chat_jid;
  deps.queue.enqueueTask(queueJid, task.id, () =>
    runTask(task, deps, queueJid),
  );
}

let schedulerRunning = false;

export const SLEEP_DRIFT_MULTIPLIER = 3;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  let lastTickTime = Date.now();

  const loop = async () => {
    const now = Date.now();
    const elapsed = now - lastTickTime;
    lastTickTime = now;

    if (elapsed > SCHEDULER_POLL_INTERVAL * SLEEP_DRIFT_MULTIPLIER) {
      logger.warn(
        { elapsedMs: elapsed, expectedMs: SCHEDULER_POLL_INTERVAL },
        'Sleep/wake detected — skipping this scheduler tick to let network recover',
      );
      setTimeout(loop, SCHEDULER_POLL_INTERVAL);
      return;
    }

    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Resolve the target group's JID from group_folder for queue occupancy.
        // chat_jid may differ (e.g. set to the caller's JID for result delivery),
        // so we must not use it to determine which queue slot the task occupies.
        const groups = deps.registeredGroups();
        const queueJid =
          Object.keys(groups).find(
            (jid) => groups[jid].folder === currentTask.group_folder,
          ) ?? currentTask.chat_jid;

        deps.queue.enqueueTask(queueJid, currentTask.id, () =>
          runTask(currentTask, deps, queueJid),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
