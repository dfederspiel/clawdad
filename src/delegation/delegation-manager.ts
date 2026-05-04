import { randomUUID } from 'crypto';

import { logger } from '../logger.js';
import type {
  DelegationDrainEvent,
  MessageCheckMode,
  QueuedDelegationWork,
} from '../group-queue.js';
import { DelegationEventBus } from './delegation-events.js';
import {
  normalizeCompletionPolicy,
  normalizeVisibility,
} from './delegation-policy.js';
import { DelegationStore } from './delegation-store.js';
import {
  DelegationExecutionResult,
  DelegationRequest,
  DelegationRun,
} from './types.js';

export interface DelegationScheduler {
  enqueueWork(work: QueuedDelegationWork): void;
  enqueueMessageCheck(groupJid: string, mode: MessageCheckMode): void;
}

export class DelegationManager {
  private readonly pendingCoordinatorResults = new Map<string, Set<string>>();

  constructor(
    private readonly store: DelegationStore,
    private readonly events: DelegationEventBus,
    private readonly scheduler: DelegationScheduler,
  ) {}

  delegate(
    request: DelegationRequest,
    fn: () => Promise<DelegationExecutionResult>,
    agentDisplayName?: string,
  ): DelegationRun {
    const now = new Date().toISOString();
    const run: DelegationRun = {
      id: `delegation-${randomUUID()}`,
      parentRunId: request.parentRunId,
      groupJid: request.groupJid,
      groupFolder: request.groupFolder,
      coordinatorAgentId: request.coordinatorAgentId,
      targetAgentId: request.targetAgentId,
      message: request.message,
      status: 'queued',
      visibility: normalizeVisibility(request.visibility),
      completionPolicy: normalizeCompletionPolicy(request.completionPolicy),
      batchId: request.batchId || `delegation-${randomUUID()}`,
      threadId: request.threadId,
      createdAt: now,
    };

    this.store.create(run);
    this.events.emit({ type: 'delegation.created', run });
    this.scheduler.enqueueWork({
      kind: 'delegation',
      runId: run.id,
      groupJid: run.groupJid,
      agentName: agentDisplayName,
      fn: async () => this.execute(run.id, fn),
    });
    return run;
  }

  handleDelegationsDrained(event: DelegationDrainEvent): void {
    const runs = event.runIds
      .map((runId) => this.store.get(runId))
      .filter((run): run is DelegationRun => Boolean(run));
    const coordinatorRuns = runs.filter(
      (run) => run.completionPolicy === 'retrigger_coordinator',
    );

    if (coordinatorRuns.length === 0) {
      logger.info(
        { groupJid: event.groupJid, runIds: event.runIds },
        'Delegation drain complete with no coordinator retrigger policy',
      );
      return;
    }

    if (event.hasPendingNormalMessage) {
      logger.info(
        { groupJid: event.groupJid, runIds: coordinatorRuns.map((r) => r.id) },
        'Delegation coordinator retrigger superseded by newer user work',
      );
      for (const run of coordinatorRuns) {
        const superseded = this.store.update(run.id, { status: 'superseded' });
        if (superseded) {
          this.events.emit({ type: 'delegation.superseded', run: superseded });
        }
      }
      return;
    }

    logger.info(
      { groupJid: event.groupJid, runIds: coordinatorRuns.map((r) => r.id) },
      'Delegation manager re-triggering coordinator',
    );
    this.addPendingCoordinatorResults(
      event.groupJid,
      coordinatorRuns.map((run) => run.id),
    );
    this.scheduler.enqueueMessageCheck(event.groupJid, 'delegation_retrigger');
  }

  getCoordinatorResults(groupJid: string): DelegationRun[] {
    const runIds = this.pendingCoordinatorResults.get(groupJid);
    if (!runIds || runIds.size === 0) return [];
    return [...runIds]
      .map((runId) => this.store.get(runId))
      .filter((run): run is DelegationRun => Boolean(run));
  }

  clearCoordinatorResults(groupJid: string): void {
    this.pendingCoordinatorResults.delete(groupJid);
  }

  private addPendingCoordinatorResults(
    groupJid: string,
    runIds: string[],
  ): void {
    let pending = this.pendingCoordinatorResults.get(groupJid);
    if (!pending) {
      pending = new Set();
      this.pendingCoordinatorResults.set(groupJid, pending);
    }
    for (const runId of runIds) {
      pending.add(runId);
    }
  }

  private async execute(
    runId: string,
    fn: () => Promise<DelegationExecutionResult>,
  ): Promise<DelegationExecutionResult> {
    const started = this.store.update(runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    if (started) {
      this.events.emit({ type: 'delegation.started', run: started });
    }

    try {
      const result = await fn();
      const completedAt = new Date().toISOString();
      if (result.status === 'success') {
        const completed = this.store.update(runId, {
          status: 'completed',
          completedAt,
          result: result.result,
        });
        if (completed) {
          this.events.emit({
            type: 'delegation.completed',
            run: completed,
            result: result.result,
          });
        }
      } else {
        const failed = this.store.update(runId, {
          status: 'failed',
          completedAt,
          error: result.error || 'Delegation failed',
        });
        if (failed) {
          this.events.emit({
            type: 'delegation.failed',
            run: failed,
            error: result.error || 'Delegation failed',
          });
        }
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed = this.store.update(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error,
      });
      if (failed) {
        this.events.emit({ type: 'delegation.failed', run: failed, error });
      }
      logger.error({ runId, err }, 'Delegation manager execution failed');
      return { status: 'error', error };
    }
  }
}
