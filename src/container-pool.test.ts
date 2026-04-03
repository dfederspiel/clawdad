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
    pool.release('web_test/default', handle, 'web:test');
    expect(pool.idleCount).toBe(1);

    const acquired = pool.acquire('web_test/default');
    expect(acquired).toBe(handle);
    expect(pool.idleCount).toBe(0);
  });

  it('acquire for wrong agentId returns null', () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test');

    expect(pool.acquire('web_other/default')).toBeNull();
    expect(pool.idleCount).toBe(1);
  });

  it('double acquire returns null (container already acquired)', () => {
    const handle = createMockHandle();
    activeHandles.push(handle);
    pool.release('web_test/default', handle, 'web:test');

    pool.acquire('web_test/default');
    expect(pool.acquire('web_test/default')).toBeNull();
  });

  it('acquire returns null for exited container', () => {
    const handle = createMockHandle({ exited: true });
    pool.release('web_test/default', handle, 'web:test');
    // Should not be added since exited
    expect(pool.idleCount).toBe(0);
  });

  it('release with pool disabled writes _close immediately', () => {
    const disabledPool = new ContainerPool(5000, false);
    const handle = createMockHandle();
    activeHandles.push(handle);
    mockWriteFileSync.mockClear();

    disabledPool.release('web_test/default', handle, 'web:test');

    expect(disabledPool.idleCount).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('evictOldest evicts the oldest idle container', () => {
    const handle1 = createMockHandle({ containerName: 'container-1' });
    const handle2 = createMockHandle({ containerName: 'container-2' });
    activeHandles.push(handle1, handle2);

    pool.release('agent/a', handle1, 'web:a');
    // Slight delay to ensure different idleSince
    pool.release('agent/b', handle2, 'web:b');

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

    pool.release('web_test/default', handle, 'web:test');
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

    pool.release('web_test/default', handle, 'web:test');
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
    pool.release('web_test/default', handle, 'web:test');

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
    pool.release('web_test/default', handle, 'web:test');
    expect(countChangeFn).toHaveBeenCalledWith(1);

    pool.acquire('web_test/default');
    expect(countChangeFn).toHaveBeenCalledWith(0);
  });

  it('shutdown reclaims all containers', async () => {
    const handle1 = createMockHandle();
    const handle2 = createMockHandle();
    activeHandles.push(handle1, handle2);

    pool.release('agent/a', handle1, 'web:a');
    pool.release('agent/b', handle2, 'web:b');
    expect(pool.idleCount).toBe(2);

    const shutdownPromise = pool.shutdown();
    handle1._exitResolve({ code: 0 });
    handle2._exitResolve({ code: 0 });
    await shutdownPromise;

    expect(pool.idleCount).toBe(0);
  });
});
