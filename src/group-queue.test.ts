import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(
      async (_groupJid: string, _mode: string) => true,
    );
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string, _mode: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Delegation-aware idle timer ---

  it('emits delegation state with snapshotted coordinator identity', async () => {
    const delegationEvents: Array<{
      groupFolder: string;
      coord: string;
      active: boolean;
    }> = [];
    let resolveCoordinator: () => void;
    let resolveDelegation: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveCoordinator = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setOnDelegationState((_groupJid, groupFolder, coord, active) => {
      delegationEvents.push({ groupFolder, coord, active });
    });

    // Start coordinator
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register coordinator identity (simulates what index.ts does)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      'coordinator',
    );

    // Enqueue a delegation while coordinator is still running
    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'group1@g.us',
      runId: 'del-1',
      agentName: 'analyst',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDelegation = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    // Delegation started → pause should have fired with snapshotted identity
    expect(delegationEvents).toHaveLength(1);
    expect(delegationEvents[0]).toEqual({
      groupFolder: 'test-group',
      coord: 'coordinator',
      active: true,
    });

    // Coordinator finishes — clears groupFolder/coordinatorAgentName
    resolveCoordinator!();
    await vi.advanceTimersByTimeAsync(10);

    // Delegation still running — no resume yet
    expect(delegationEvents).toHaveLength(1);

    // Delegation finishes — resume should fire using the SNAPSHOT, not the cleared fields
    resolveDelegation!();
    await vi.advanceTimersByTimeAsync(10);

    expect(delegationEvents).toHaveLength(2);
    expect(delegationEvents[1]).toEqual({
      groupFolder: 'test-group',
      coord: 'coordinator',
      active: false,
    });
  });

  it('uses enqueue-time snapshot when delegation starts after coordinator cleanup', async () => {
    // This is the exact edge case: delegation queued at concurrency limit,
    // coordinator finishes (clearing mutable fields), drainGroup starts the
    // queued delegation — pause/resume must use the snapshot, not the cleared fields.
    const delegationEvents: Array<{
      groupFolder: string;
      coord: string;
      active: boolean;
    }> = [];
    let resolveCoordA: () => void;
    let resolveCoordB: () => void;
    let resolveDelegation: () => void;

    let callCount = 0;
    const processMessages = vi.fn(async (groupJid: string, _mode: string) => {
      callCount++;
      if (groupJid === 'groupA@g.us' && callCount <= 1) {
        await new Promise<void>((resolve) => {
          resolveCoordA = resolve;
        });
      } else if (groupJid === 'groupB@g.us') {
        await new Promise<void>((resolve) => {
          resolveCoordB = resolve;
        });
      }
      // Re-triggered coordinator calls (from delegation completion) return immediately
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setOnDelegationState((_jid, groupFolder, coord, active) => {
      delegationEvents.push({ groupFolder, coord, active });
    });

    // Slot 1: group A coordinator
    queue.enqueueMessageCheck('groupA@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'groupA@g.us',
      {} as any,
      'c-a',
      'team-folder',
      'coordinator',
    );

    // Slot 2: group B coordinator (holds the slot)
    queue.enqueueMessageCheck('groupB@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue delegation for group A — concurrency full (2/2), so it queues.
    // Snapshot is taken HERE at enqueue time.
    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'groupA@g.us',
      runId: 'del-1',
      agentName: 'analyst',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDelegation = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    // Delegation is queued, no events yet
    expect(delegationEvents).toHaveLength(0);

    // Group A coordinator finishes. The finally block:
    //   1. Clears groupFolder, coordinatorAgentName (the mutable fields)
    //   2. Decrements activeWorkCount (now 1)
    //   3. Calls drainGroup → drainDelegations → starts the queued delegation
    resolveCoordA!();
    await vi.advanceTimersByTimeAsync(10);

    // The delegation should now be running. Pause must have fired using the
    // snapshot taken at enqueue time, NOT the cleared mutable fields.
    expect(delegationEvents).toHaveLength(1);
    expect(delegationEvents[0]).toEqual({
      groupFolder: 'team-folder',
      coord: 'coordinator',
      active: true,
    });

    // Complete the delegation — resume fires from same snapshot
    resolveDelegation!();
    await vi.advanceTimersByTimeAsync(10);

    expect(delegationEvents).toHaveLength(2);
    expect(delegationEvents[1]).toEqual({
      groupFolder: 'team-folder',
      coord: 'coordinator',
      active: false,
    });

    // Clean up group B
    resolveCoordB!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('snapshot survives even if a second delegation batch starts after fields cleared', async () => {
    const delegationEvents: Array<{
      groupFolder: string;
      coord: string;
      active: boolean;
    }> = [];
    let resolveCoordinator: () => void;
    let resolveDel1: () => void;
    let resolveDel2: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveCoordinator = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setOnDelegationState((_jid, groupFolder, coord, active) => {
      delegationEvents.push({ groupFolder, coord, active });
    });

    // Start coordinator
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'c-1',
      'team-folder',
      'coordinator',
    );

    // First delegation — snapshot taken at enqueue
    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'group1@g.us',
      runId: 'del-1',
      agentName: 'analyst',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDel1 = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    // pause fired
    expect(delegationEvents).toHaveLength(1);
    expect(delegationEvents[0].active).toBe(true);

    // Coordinator finishes — clears mutable fields
    resolveCoordinator!();
    await vi.advanceTimersByTimeAsync(10);

    // First delegation finishes → resume fires from snapshot
    resolveDel1!();
    await vi.advanceTimersByTimeAsync(10);

    expect(delegationEvents).toHaveLength(2);
    expect(delegationEvents[1]).toEqual({
      groupFolder: 'team-folder',
      coord: 'coordinator',
      active: false,
    });

    // Now start a new coordinator run (re-populates fields)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'c-2',
      'team-folder',
      'coordinator',
    );

    // Second delegation — new snapshot
    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'group1@g.us',
      runId: 'del-2',
      agentName: 'reviewer',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDel2 = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(delegationEvents).toHaveLength(3);
    expect(delegationEvents[2]).toEqual({
      groupFolder: 'team-folder',
      coord: 'coordinator',
      active: true,
    });

    resolveDel2!();
    await vi.advanceTimersByTimeAsync(10);

    expect(delegationEvents).toHaveLength(4);
    expect(delegationEvents[3]).toEqual({
      groupFolder: 'team-folder',
      coord: 'coordinator',
      active: false,
    });
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async (_groupJid: string, _mode: string) => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('lets subscribers re-trigger after delegation work drains', async () => {
    const modes: string[] = [];
    const drainedRunIds: string[][] = [];
    let resolveCoordinator: () => void;
    let resolveDelegation: () => void;

    const processMessages = vi.fn(async (_groupJid: string, mode: string) => {
      modes.push(mode);
      if (modes.length === 1) {
        await new Promise<void>((resolve) => {
          resolveCoordinator = resolve;
        });
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setOnDelegationsDrained((event) => {
      drainedRunIds.push(event.runIds);
      queue.enqueueMessageCheck(event.groupJid, 'delegation_retrigger');
    });
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'team-folder',
      'coordinator',
    );

    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'group1@g.us',
      runId: 'del-1',
      agentName: 'analyst',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDelegation = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    resolveCoordinator!();
    await vi.advanceTimersByTimeAsync(10);
    resolveDelegation!();
    await vi.advanceTimersByTimeAsync(10);

    expect(modes).toEqual(['normal', 'delegation_retrigger']);
    expect(drainedRunIds).toEqual([['del-1']]);
  });

  it('reports fresh message work when delegation work drains', async () => {
    const modes: string[] = [];
    const drainEvents: Array<{ runIds: string[]; fresh: boolean }> = [];
    let resolveCoordinator: () => void;
    let resolveDelegation: () => void;

    const processMessages = vi.fn(async (_groupJid: string, mode: string) => {
      modes.push(mode);
      if (modes.length === 1) {
        await new Promise<void>((resolve) => {
          resolveCoordinator = resolve;
        });
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setOnDelegationsDrained((event) => {
      drainEvents.push({
        runIds: event.runIds,
        fresh: event.hasPendingNormalMessage,
      });
      if (!event.hasPendingNormalMessage) {
        queue.enqueueMessageCheck(event.groupJid, 'delegation_retrigger');
      }
    });
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'team-folder',
      'coordinator',
    );

    queue.enqueueWork({
      kind: 'delegation',
      groupJid: 'group1@g.us',
      runId: 'del-1',
      agentName: 'analyst',
      fn: async () => {
        await new Promise<void>((resolve) => {
          resolveDelegation = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    // New inbound user work arrives while the delegation is still active.
    queue.enqueueMessageCheck('group1@g.us', 'normal');

    resolveCoordinator!();
    await vi.advanceTimersByTimeAsync(10);
    resolveDelegation!();
    await vi.advanceTimersByTimeAsync(10);

    expect(modes).toEqual(['normal', 'normal']);
    expect(drainEvents).toEqual([{ runIds: ['del-1'], fresh: true }]);
  });
});
