import { describe, expect, it, vi } from 'vitest';

import { DelegationEventBus } from './delegation-events.js';
import { DelegationManager } from './delegation-manager.js';
import type { DelegationEvent } from './delegation-events.js';
import type { DelegationRun } from './types.js';

function makeRun(
  patch: Partial<DelegationRun> & Pick<DelegationRun, 'id'>,
): DelegationRun {
  const { id, ...rest } = patch;
  return {
    id,
    groupJid: 'group@g.us',
    groupFolder: 'team-folder',
    coordinatorAgentId: 'team-folder/coordinator',
    targetAgentId: 'team-folder/scout',
    message: 'Inspect this',
    status: 'completed',
    visibility: 'portal',
    completionPolicy: 'retrigger_coordinator',
    batchId: 'batch-1',
    createdAt: '2026-05-04T00:00:00.000Z',
    ...rest,
  };
}

function makeStore(initialRuns: DelegationRun[]) {
  const runs = new Map(initialRuns.map((run) => [run.id, run]));
  return {
    create: vi.fn((run: DelegationRun) => {
      runs.set(run.id, run);
    }),
    get: vi.fn((id: string) => runs.get(id)),
    listForGroup: vi.fn(),
    update: vi.fn((id: string, patch: Partial<DelegationRun>) => {
      const current = runs.get(id);
      if (!current) return undefined;
      const updated = { ...current, ...patch };
      runs.set(id, updated);
      return updated;
    }),
  };
}

describe('DelegationManager drain policy', () => {
  it('schedules created runs through generic queue work', async () => {
    const store = makeStore([]);
    const events = new DelegationEventBus();
    const scheduler = {
      enqueueWork: vi.fn(),
      enqueueMessageCheck: vi.fn(),
    };
    const manager = new DelegationManager(store, events, scheduler);

    const run = manager.delegate(
      {
        groupJid: 'group@g.us',
        groupFolder: 'team-folder',
        coordinatorAgentId: 'team-folder/coordinator',
        targetAgentId: 'team-folder/scout',
        message: 'Inspect this',
        completionPolicy: 'final_response',
      },
      async () => ({ status: 'success', result: 'done' }),
      'Scout',
    );

    expect(scheduler.enqueueWork).toHaveBeenCalledWith({
      kind: 'delegation',
      runId: run.id,
      groupJid: 'group@g.us',
      agentName: 'Scout',
      fn: expect.any(Function),
    });

    const scheduled = scheduler.enqueueWork.mock.calls[0][0];
    await scheduled.fn();
    expect(store.update).toHaveBeenCalledWith(run.id, {
      status: 'completed',
      completedAt: expect.any(String),
      result: 'done',
    });
  });

  it('re-triggers the coordinator when drained runs request it', () => {
    const store = makeStore([makeRun({ id: 'del-1' })]);
    const events = new DelegationEventBus();
    const scheduler = {
      enqueueWork: vi.fn(),
      enqueueMessageCheck: vi.fn(),
    };
    const manager = new DelegationManager(store, events, scheduler);

    manager.handleDelegationsDrained({
      groupJid: 'group@g.us',
      runIds: ['del-1'],
      hasPendingNormalMessage: false,
    });

    expect(scheduler.enqueueMessageCheck).toHaveBeenCalledWith(
      'group@g.us',
      'delegation_retrigger',
    );
    expect(manager.getCoordinatorResults('group@g.us')).toEqual([
      expect.objectContaining({ id: 'del-1' }),
    ]);
    manager.clearCoordinatorResults('group@g.us');
    expect(manager.getCoordinatorResults('group@g.us')).toEqual([]);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('does not re-trigger final-response delegations', () => {
    const store = makeStore([
      makeRun({ id: 'del-1', completionPolicy: 'final_response' }),
    ]);
    const events = new DelegationEventBus();
    const scheduler = {
      enqueueWork: vi.fn(),
      enqueueMessageCheck: vi.fn(),
    };
    const manager = new DelegationManager(store, events, scheduler);

    manager.handleDelegationsDrained({
      groupJid: 'group@g.us',
      runIds: ['del-1'],
      hasPendingNormalMessage: false,
    });

    expect(scheduler.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('supersedes stale coordinator retriggers when fresh user work is queued', () => {
    const store = makeStore([makeRun({ id: 'del-1' })]);
    const events = new DelegationEventBus();
    const emitted: DelegationEvent[] = [];
    events.subscribe((event) => emitted.push(event));
    const scheduler = {
      enqueueWork: vi.fn(),
      enqueueMessageCheck: vi.fn(),
    };
    const manager = new DelegationManager(store, events, scheduler);

    manager.handleDelegationsDrained({
      groupJid: 'group@g.us',
      runIds: ['del-1'],
      hasPendingNormalMessage: true,
    });

    expect(scheduler.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('del-1', {
      status: 'superseded',
    });
    expect(emitted).toEqual([
      {
        type: 'delegation.superseded',
        run: expect.objectContaining({ id: 'del-1', status: 'superseded' }),
      },
    ]);
  });
});
