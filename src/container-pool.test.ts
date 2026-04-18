import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContainerHandle } from './container-runner.js';
import { ContainerPool } from './container-pool.js';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-pool-data',
}));

// Mock group-folder — resolveAgentIpcInputPath returns a predictable path
vi.mock('./group-folder.js', () => ({
  resolveAgentIpcInputPath: (folder: string, agentName: string) =>
    `/tmp/test-pool-data/ipc/${folder}/${agentName}/input`,
}));

// Mock fs — track writeFileSync calls for _close sentinel detection
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    },
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

type MockHandle = ContainerHandle & {
  _exitResolve: (v: { code: number | null }) => void;
};

function createMockHandle(
  overrides: Partial<ContainerHandle> = {},
): MockHandle {
  let exitResolve!: (value: { code: number | null }) => void;
  const exitPromise = new Promise<{ code: number | null }>((r) => {
    exitResolve = r;
  });

  return {
    process: {} as any,
    containerName: `test-container-${Math.random().toString(36).slice(2)}`,
    groupFolder: 'web_test',
    parser: {} as any,
    sessionId: 'session-123',
    spawnedAt: Date.now(),
    lastQueryAt: Date.now(),
    exited: false,
    exitPromise,
    queryCount: 1,
    queryOnce: vi.fn(),
    _exitResolve: exitResolve,
    ...overrides,
  } as MockHandle;
}

// Track all handles so afterEach can resolve them
const activeHandles: MockHandle[] = [];

describe('ContainerPool', () => {
  let pool: ContainerPool;

  beforeEach(() => {
    pool = new ContainerPool(5000, true);
  });

  afterEach(async () => {
    // Resolve all unresolved exit promises so shutdown doesn't hang
    for (const h of activeHandles) {
      if (!h.exited) {
        h._exitResolve({ code: 0 });
        h.exited = true;
      }
    }
    activeHandles.length = 0;
    await pool.shutdown();
  });

  it('acquire returns null when pool is empty', () => {
    expect(pool.acquire('web_test/default')).toBeNull();
  });

  it('release + acquire returns the same handle', () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');
    expect(pool.idleCount).toBe(1);

    const acquired = pool.acquire('web_test/default');
    expect(acquired).toBe(handle);
    expect(pool.idleCount).toBe(0);
  });

  it('acquire for wrong agentId returns null', () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    expect(pool.acquire('web_other/default')).toBeNull();
    expect(pool.idleCount).toBe(1);
  });

  it('double acquire returns null (container already acquired)', () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    pool.acquire('web_test/default');
    expect(pool.acquire('web_test/default')).toBeNull();
  });

  it('acquire returns null for exited container', () => {
    const handle = createMockHandle({ exited: true });
    pool.release('web_test/default', handle, 'web:test', 'default');
    // Should not be added since exited
    expect(pool.idleCount).toBe(0);
  });

  it('acquire evicts stale container when CLAUDE.md fingerprint changed', () => {
    const handle = createMockHandle({ claudeMdFingerprint: 'hash-old' });
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');
    expect(pool.idleCount).toBe(1);

    // Simulate host-side CLAUDE.md edit → fingerprint changes
    expect(pool.acquire('web_test/default', 'hash-new')).toBeNull();
    expect(pool.idleCount).toBe(0);
    // Stale container was signaled to close
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_close'),
      '',
    );
  });

  it('acquire returns handle when fingerprint matches', () => {
    const handle = createMockHandle({ claudeMdFingerprint: 'hash-a' });
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    expect(pool.acquire('web_test/default', 'hash-a')).toBe(handle);
  });

  it('acquire without expectedFingerprint skips the check (back-compat)', () => {
    const handle = createMockHandle({ claudeMdFingerprint: 'hash-a' });
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    // Caller passes no expectation → always returns the handle
    expect(pool.acquire('web_test/default')).toBe(handle);
  });

  it('acquire without stored fingerprint skips the check', () => {
    // Handles spawned before the fingerprint feature don't have one.
    // Rather than mass-evict, the pool should keep serving them.
    const handle = createMockHandle(); // no claudeMdFingerprint
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    expect(pool.acquire('web_test/default', 'hash-new')).toBe(handle);
  });

  it('release with pool disabled writes _close immediately', () => {
    const disabledPool = new ContainerPool(5000, false);
    const handle = createMockHandle();
    activeHandles.push(handle);
    mockWriteFileSync.mockClear();

    disabledPool.release('web_test/default', handle, 'web:test', 'default');

    expect(disabledPool.idleCount).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('evictOldest evicts the oldest idle container', () => {
    const handle1 = createMockHandle({ containerName: 'container-1' });
    const handle2 = createMockHandle({ containerName: 'container-2' });
    activeHandles.push(handle1, handle2);

    pool.release('agent/a', handle1, 'web:a', 'a');
    // Slight delay to ensure different idleSince
    pool.release('agent/b', handle2, 'web:b', 'b');

    expect(pool.idleCount).toBe(2);
    const evicted = pool.evictOldest();
    expect(evicted).toBe(true);
    expect(pool.idleCount).toBe(1);

    // The remaining one should be handle2 (newer)
    expect(pool.acquire('agent/b')).toBe(handle2);
    expect(pool.acquire('agent/a')).toBeNull();
  });

  it('evictOldest returns false when pool is empty', () => {
    expect(pool.evictOldest()).toBe(false);
  });

  it('unexpected exit cleans up pool state', async () => {
    const handle = createMockHandle();
    activeHandles.push(handle);

    pool.release('web_test/default', handle, 'web:test', 'default');
    expect(pool.idleCount).toBe(1);

    // Simulate unexpected exit
    handle._exitResolve({ code: 137 });
    // Let the promise callback run
    await new Promise((r) => setTimeout(r, 10));

    expect(pool.idleCount).toBe(0);
    expect(pool.acquire('web_test/default')).toBeNull();
  });

  it('reclaim writes _close and waits for exit', async () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    mockWriteFileSync.mockClear();

    pool.release('web_test/default', handle, 'web:test', 'default');
    expect(pool.idleCount).toBe(1);

    const reclaimPromise = pool.reclaim('web_test/default');
    handle._exitResolve({ code: 0 });
    await reclaimPromise;

    expect(pool.idleCount).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('idle timeout fires reclaim', async () => {
    vi.useFakeTimers();
    const shortPool = new ContainerPool(100, true);
    const handle = createMockHandle();
    activeHandles.push(handle);

    shortPool.release('web_test/default', handle, 'web:test');
    expect(shortPool.idleCount).toBe(1);

    // Advance past idle timeout
    vi.advanceTimersByTime(150);

    // The reclaim was triggered but needs exit to complete
    handle._exitResolve({ code: 0 });
    // Let microtasks settle
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(shortPool.idleCount).toBe(0);
  });

  it('getSnapshot returns current pool state', () => {
    const handle = createMockHandle({ containerName: 'snap-container' });
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');

    const snapshot = pool.getSnapshot();
    expect(snapshot.idleCount).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].agentId).toBe('web_test/default');
    expect(snapshot.entries[0].containerName).toBe('snap-container');
    expect(snapshot.entries[0].state).toBe('idle');
  });

  it('notifies count changes', () => {
    const countChangeFn = vi.fn();
    pool.setOnCountChange(countChangeFn);

    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test', 'default');
    expect(countChangeFn).toHaveBeenCalledWith(1);

    pool.acquire('web_test/default');
    expect(countChangeFn).toHaveBeenCalledWith(0);
  });

  it('specialist pool: release and acquire with specialist agentId', () => {
    const handle = createMockHandle({ groupFolder: 'web_team' });
    activeHandles.push(handle);
    pool.release('web_team/analyst', handle, 'web:team', 'analyst');
    expect(pool.idleCount).toBe(1);

    const acquired = pool.acquire('web_team/analyst');
    expect(acquired).toBe(handle);
    expect(pool.idleCount).toBe(0);
  });

  it('specialist pool: two specialists in same group do not cross-acquire', () => {
    const handle1 = createMockHandle({ groupFolder: 'web_team' });
    const handle2 = createMockHandle({ groupFolder: 'web_team' });
    activeHandles.push(handle1, handle2);

    pool.release('web_team/analyst', handle1, 'web:team', 'analyst');
    pool.release('web_team/reviewer', handle2, 'web:team', 'reviewer');
    expect(pool.idleCount).toBe(2);

    // Each agent acquires only its own container
    expect(pool.acquire('web_team/analyst')).toBe(handle1);
    expect(pool.acquire('web_team/reviewer')).toBe(handle2);
    expect(pool.acquire('web_team/analyst')).toBeNull();
  });

  it('specialist pool: per-role idle timeout', async () => {
    vi.useFakeTimers();
    const handle = createMockHandle({ groupFolder: 'web_team' });
    activeHandles.push(handle);

    // Release with 50ms specialist timeout
    pool.release('web_team/analyst', handle, 'web:team', 'analyst', 50);
    expect(pool.idleCount).toBe(1);

    // Advance past specialist timeout
    vi.advanceTimersByTime(60);
    handle._exitResolve({ code: 0 });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(pool.idleCount).toBe(0);
  });

  it('specialist pool: _close sentinel targets agent-specific path', () => {
    const disabledPool = new ContainerPool(5000, false);
    const handle = createMockHandle({ groupFolder: 'web_team' });
    activeHandles.push(handle);
    mockWriteFileSync.mockClear();

    disabledPool.release('web_team/analyst', handle, 'web:team', 'analyst');

    // Should write to agent-specific path
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-pool-data/ipc/web_team/analyst/input/_close',
      '',
    );
  });

  it('shutdown reclaims all containers', async () => {
    const handle1 = createMockHandle();
    const handle2 = createMockHandle();
    activeHandles.push(handle1, handle2);

    pool.release('agent/a', handle1, 'web:a', 'a');
    pool.release('agent/b', handle2, 'web:b', 'b');
    expect(pool.idleCount).toBe(2);

    const shutdownPromise = pool.shutdown();
    handle1._exitResolve({ code: 0 });
    handle2._exitResolve({ code: 0 });
    await shutdownPromise;

    expect(pool.idleCount).toBe(0);
  });
});
