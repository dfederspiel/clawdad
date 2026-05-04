import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import type { DelegationRun } from './delegation/types.js';
import { resolveAgentIpcInputPath } from './group-folder.js';
import { logger } from './logger.js';
import { WorkPhase, WorkStateEvent } from './types.js';

export type MessageCheckMode = 'normal' | 'delegation_retrigger';

interface QueuedTask {
  id: string;
  groupJid: string;
  agentName?: string;
  fn: () => Promise<unknown>;
}

export interface QueuedDelegationWork {
  kind: 'delegation';
  runId: string;
  groupJid: string;
  agentName?: string;
  fn: () => Promise<unknown>;
}

export interface DelegationDrainEvent {
  groupJid: string;
  runIds: string[];
  hasPendingNormalMessage: boolean;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingMessageMode: MessageCheckMode;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  agentName: string | null;
  coordinatorAgentName: string | null; // Preserved across delegations for closeStdin/sendMessage
  noPipe: boolean; // Pool-managed: don't pipe via sendMessage
  retryCount: number;
  // Parallel delegation tracking — delegations bypass per-group serialization
  activeDelegations: number;
  activeDelegationAgents: string[];
  pendingDelegations: QueuedTask[];
  completedDelegationRunIds: string[];
  freshMessageDuringDelegation: boolean;
  // Snapshotted coordinator identity for idle timer pause/resume.
  // Set when first delegation starts, cleared when all delegations complete.
  // Survives runForGroup() cleanup so resume can find it.
  delegationCoordinatorId: string | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeWorkCount = 0;
  private idlePoolCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, mode: MessageCheckMode) => Promise<boolean>)
    | null = null;
  private onWorkStateFn: ((event: WorkStateEvent) => void) | null = null;
  private onDelegationStateFn:
    | ((
        groupJid: string,
        groupFolder: string,
        coordinatorAgent: string,
        active: boolean,
      ) => void)
    | null = null;
  private onDelegationsDrainedFn:
    | ((event: DelegationDrainEvent) => void)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingMessageMode: 'normal',
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        agentName: null,
        coordinatorAgentName: null,
        noPipe: false,
        retryCount: 0,
        activeDelegations: 0,
        activeDelegationAgents: [],
        pendingDelegations: [],
        completedDelegationRunIds: [],
        freshMessageDuringDelegation: false,
        delegationCoordinatorId: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, mode: MessageCheckMode) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  private mergeMessageMode(
    current: MessageCheckMode,
    next: MessageCheckMode,
  ): MessageCheckMode {
    // Fresh inbound messages should always supersede a stale delegation
    // re-trigger, but a re-trigger should not downgrade fresh work.
    return current === 'normal' || next === 'normal'
      ? 'normal'
      : 'delegation_retrigger';
  }

  setOnWorkState(fn: (event: WorkStateEvent) => void): void {
    this.onWorkStateFn = fn;
  }

  /** Called when delegations start or finish, to pause/resume coordinator idle timer. */
  setOnDelegationState(
    fn: (
      groupJid: string,
      groupFolder: string,
      coordinatorAgent: string,
      active: boolean,
    ) => void,
  ): void {
    this.onDelegationStateFn = fn;
  }

  /**
   * Called when the scheduler has no active or pending delegation work for a group.
   * Delegation lifecycle policy lives with the subscriber, not the queue.
   */
  setOnDelegationsDrained(fn: (event: DelegationDrainEvent) => void): void {
    this.onDelegationsDrainedFn = fn;
  }

  /** Called by ContainerPool when idle pool count changes. */
  setIdlePoolCount(count: number): void {
    this.idlePoolCount = count;
  }

  private emitWorkState(
    groupJid: string,
    phase: WorkPhase,
    extra?: Partial<WorkStateEvent>,
  ): void {
    if (!this.onWorkStateFn) return;
    const state = this.groups.get(groupJid);
    this.onWorkStateFn({
      jid: groupJid,
      phase,
      active_delegations: state?.activeDelegations ?? 0,
      pending_delegations: state?.pendingDelegations.length ?? 0,
      pending_messages: state?.pendingMessages ?? false,
      idle_waiting: state?.idleWaiting ?? false,
      updated_at: new Date().toISOString(),
      ...extra,
    });
  }

  /**
   * Remove all queue state for a deleted group.
   * Must be called after stopping any active container.
   */
  deleteGroup(groupJid: string): void {
    this.groups.delete(groupJid);
    this.waitingGroups = this.waitingGroups.filter((j) => j !== groupJid);
  }

  enqueueMessageCheck(
    groupJid: string,
    mode: MessageCheckMode = 'normal',
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Group is busy if coordinator is active OR delegations are running
    if (state.active || state.activeDelegations > 0) {
      state.pendingMessages = true;
      state.pendingMessageMode = this.mergeMessageMode(
        state.pendingMessageMode,
        mode,
      );
      if (state.activeDelegations > 0 && mode === 'normal') {
        state.freshMessageDuringDelegation = true;
      }
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      this.emitWorkState(groupJid, 'queued', {
        summary: 'Message queued behind active work',
      });
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (
      this.activeWorkCount + this.idlePoolCount >=
      MAX_CONCURRENT_CONTAINERS
    ) {
      state.pendingMessages = true;
      state.pendingMessageMode = this.mergeMessageMode(
        state.pendingMessageMode,
        mode,
      );
      if (state.activeDelegations > 0 && mode === 'normal') {
        state.freshMessageDuringDelegation = true;
      }
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.emitWorkState(groupJid, 'queued', {
        summary: 'Waiting for container slot',
      });
      logger.debug(
        { groupJid, activeCount: this.activeWorkCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages', mode).catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (
      this.activeWorkCount + this.idlePoolCount >=
      MAX_CONCURRENT_CONTAINERS
    ) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeWorkCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    agentName?: string,
    isDelegation?: boolean,
  ): void {
    const state = this.getGroup(groupJid);
    if (!isDelegation) {
      // Coordinator registration — track separately so closeStdin always targets it
      state.process = proc;
      state.containerName = containerName;
      if (groupFolder) state.groupFolder = groupFolder;
      if (agentName) {
        state.agentName = agentName;
        state.coordinatorAgentName = agentName;
      }
    } else {
      // Delegation registration — don't overwrite coordinator's agent name
      if (groupFolder) state.groupFolder = groupFolder;
    }
  }

  setNoPipe(groupJid: string, noPipe: boolean): void {
    this.getGroup(groupJid).noPipe = noPipe;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0 || state.pendingMessages) {
      this.closeStdin(groupJid);
    } else {
      this.emitWorkState(groupJid, 'waiting', {
        summary: 'Waiting for follow-up',
      });
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    // Pool-managed: don't pipe. Messages re-enter through enqueueMessageCheck
    // → processGroupMessages → pool.acquire on the next queue turn.
    if (state.noPipe) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    // Always target the coordinator — it's the one idle-waiting for IPC input
    const agentName =
      state.coordinatorAgentName || state.agentName || 'default';
    const inputDir = resolveAgentIpcInputPath(state.groupFolder, agentName);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    // Always target the coordinator — it's the one idle-waiting for IPC input
    const agentName =
      state.coordinatorAgentName || state.agentName || 'default';
    const inputDir = resolveAgentIpcInputPath(state.groupFolder, agentName);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Check if a group has active or pending delegations.
   */
  hasDelegations(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state) return false;
    return state.activeDelegations > 0 || state.pendingDelegations.length > 0;
  }

  /**
   * Enqueue a delegation task. Delegations bypass per-group serialization
   * (they can run alongside the coordinator and other delegations) but
   * still count against the global MAX_CONCURRENT_CONTAINERS limit.
   */
  enqueueDelegation(
    groupJid: string,
    taskId: string,
    fn: () => Promise<unknown>,
    agentName?: string,
    _skipRetrigger?: boolean,
  ): void {
    this.enqueueWork({
      kind: 'delegation',
      runId: taskId,
      groupJid,
      agentName,
      fn,
    });
  }

  enqueueWork(work: QueuedDelegationWork): void {
    if (this.shuttingDown) return;
    if (work.kind !== 'delegation') return;

    const state = this.getGroup(work.groupJid);

    // Eagerly snapshot coordinator identity while it's still available.
    // runForGroup() clears these fields when the coordinator query finishes,
    // but queued delegations may not start until after that cleanup.
    if (
      !state.delegationCoordinatorId &&
      state.groupFolder &&
      state.coordinatorAgentName
    ) {
      state.delegationCoordinatorId = `${state.groupFolder}/${state.coordinatorAgentName}`;
    }

    // Dedup
    if (state.pendingDelegations.some((t) => t.id === work.runId)) {
      logger.debug(
        { groupJid: work.groupJid, runId: work.runId },
        'Delegation already queued, skipping',
      );
      return;
    }

    if (
      this.activeWorkCount + this.idlePoolCount >=
      MAX_CONCURRENT_CONTAINERS
    ) {
      state.pendingDelegations.push({
        id: work.runId,
        groupJid: work.groupJid,
        agentName: work.agentName,
        fn: work.fn,
      });
      logger.debug(
        {
          groupJid: work.groupJid,
          runId: work.runId,
          activeCount: this.activeWorkCount,
        },
        'At concurrency limit, delegation queued',
      );
      return;
    }

    this.runDelegation(work.groupJid, {
      id: work.runId,
      groupJid: work.groupJid,
      agentName: work.agentName,
      fn: work.fn,
    }).catch((err) =>
      logger.error(
        { groupJid: work.groupJid, runId: work.runId, err },
        'Unhandled error in runDelegation',
      ),
    );
  }

  scheduleDelegation(
    run: DelegationRun,
    fn: () => Promise<unknown>,
    agentDisplayName?: string,
  ): void {
    this.enqueueWork({
      kind: 'delegation',
      runId: run.id,
      groupJid: run.groupJid,
      agentName: agentDisplayName,
      fn,
    });
  }

  private async runDelegation(
    groupJid: string,
    task: QueuedTask,
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const wasIdle = state.activeDelegations === 0;
    state.activeDelegations++;
    if (task.agentName) {
      state.activeDelegationAgents.push(task.agentName);
    }
    this.activeWorkCount++;

    // Pause coordinator idle timer when first delegation starts.
    // Use the snapshot (set at enqueue time) since mutable fields may
    // already be cleared by runForGroup().
    if (wasIdle && this.onDelegationStateFn && state.delegationCoordinatorId) {
      const [folder, ...rest] = state.delegationCoordinatorId.split('/');
      const coord = rest.join('/');
      this.onDelegationStateFn(groupJid, folder, coord, true);
    }

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        agentName: task.agentName,
        activeDelegations: state.activeDelegations,
        activeCount: this.activeWorkCount,
      },
      'Running delegation',
    );
    this.emitWorkState(groupJid, 'delegating', {
      summary: `Running delegation (${state.activeDelegations} active)`,
    });

    try {
      await task.fn();
    } catch (err) {
      logger.error(
        { groupJid, taskId: task.id, err },
        'Error running delegation',
      );
    } finally {
      state.activeDelegations--;
      if (task.agentName) {
        const idx = state.activeDelegationAgents.indexOf(task.agentName);
        if (idx !== -1) state.activeDelegationAgents.splice(idx, 1);
      }
      this.activeWorkCount--;

      state.completedDelegationRunIds.push(task.id);

      if (state.activeDelegations > 0) {
        this.emitWorkState(groupJid, 'delegating', {
          summary: `${state.activeDelegations} delegation(s) still active`,
        });
      }

      if (
        state.activeDelegations === 0 &&
        state.pendingDelegations.length === 0
      ) {
        // Resume coordinator idle timer using the snapshotted identity
        // (mutable fields may have been cleared by runForGroup())
        if (this.onDelegationStateFn && state.delegationCoordinatorId) {
          const [folder, ...rest] = state.delegationCoordinatorId.split('/');
          const coord = rest.join('/');
          this.onDelegationStateFn(groupJid, folder, coord, false);
          state.delegationCoordinatorId = null;
        }

        const runIds = state.completedDelegationRunIds;
        const hasPendingNormalMessage = state.freshMessageDuringDelegation;
        state.completedDelegationRunIds = [];
        state.freshMessageDuringDelegation = false;

        logger.info(
          { groupJid, runIds, hasPendingNormalMessage },
          'All delegation work drained',
        );
        this.emitWorkState(groupJid, 'completed', {
          summary: 'Delegation work complete',
        });

        if (runIds.length > 0) {
          this.onDelegationsDrainedFn?.({
            groupJid,
            runIds,
            hasPendingNormalMessage,
          });
        }
        this.drainGroup(groupJid);
      } else {
        // More delegations pending — drain them
        this.drainDelegations(groupJid);
      }
      this.drainWaiting();
    }
  }

  /**
   * Launch pending delegations up to the global concurrency limit.
   */
  private drainDelegations(groupJid: string): void {
    const state = this.getGroup(groupJid);
    while (
      state.pendingDelegations.length > 0 &&
      this.activeWorkCount + this.idlePoolCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const task = state.pendingDelegations.shift()!;
      this.runDelegation(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runDelegation (drain)',
        ),
      );
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
    mode: MessageCheckMode,
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.pendingMessageMode = 'normal';
    this.activeWorkCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeWorkCount },
      'Starting container for group',
    );
    this.emitWorkState(groupJid, 'working', { summary: 'Processing messages' });

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, mode);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state, mode);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.emitWorkState(groupJid, 'error', {
        summary: 'Error processing messages',
      });
      this.scheduleRetry(groupJid, state, mode);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.agentName = null;
      state.coordinatorAgentName = null;
      state.noPipe = false;
      this.activeWorkCount--;
      this.emitWorkState(groupJid, 'idle');
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeWorkCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeWorkCount },
      'Running queued task',
    );
    this.emitWorkState(groupJid, 'task_running', {
      is_task: true,
      task_id: task.id,
      summary: 'Running scheduled task',
    });

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.agentName = null;
      state.coordinatorAgentName = null;
      state.noPipe = false;
      this.activeWorkCount--;
      this.emitWorkState(groupJid, 'idle');
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(
    groupJid: string,
    state: GroupState,
    mode: MessageCheckMode,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid, mode);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      const mode = state.pendingMessageMode;
      this.runForGroup(groupJid, 'drain', mode).catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Drain any pending delegations
    this.drainDelegations(groupJid);

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeWorkCount + this.idlePoolCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        const mode = state.pendingMessageMode;
        this.runForGroup(nextJid, 'drain', mode).catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  getSnapshot(): {
    activeCount: number;
    idlePoolCount: number;
    maxConcurrent: number;
    groups: Array<{
      jid: string;
      active: boolean;
      idleWaiting: boolean;
      isTask: boolean;
      taskId: string | null;
      pendingMessages: boolean;
      pendingTaskCount: number;
      activeDelegations: number;
      activeDelegationAgents: string[];
      pendingDelegationCount: number;
      containerName: string | null;
      groupFolder: string | null;
      agentName: string | null;
    }>;
    waitingCount: number;
  } {
    const groups: ReturnType<GroupQueue['getSnapshot']>['groups'] = [];
    for (const [jid, state] of this.groups) {
      if (
        state.active ||
        state.pendingMessages ||
        state.pendingTasks.length > 0 ||
        state.activeDelegations > 0 ||
        state.pendingDelegations.length > 0
      ) {
        groups.push({
          jid,
          active: state.active,
          idleWaiting: state.idleWaiting,
          isTask: state.isTaskContainer,
          taskId: state.runningTaskId,
          pendingMessages: state.pendingMessages,
          pendingTaskCount: state.pendingTasks.length,
          activeDelegations: state.activeDelegations,
          activeDelegationAgents: state.activeDelegationAgents,
          pendingDelegationCount: state.pendingDelegations.length,
          containerName: state.containerName,
          groupFolder: state.groupFolder,
          agentName: state.agentName,
        });
      }
    }
    return {
      activeCount: this.activeWorkCount,
      idlePoolCount: this.idlePoolCount,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
      groups,
      waitingCount: this.waitingGroups.length,
    };
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      {
        activeCount: this.activeWorkCount,
        detachedContainers: activeContainers,
      },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
