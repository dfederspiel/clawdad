import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('returns true when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    const result = ensureContainerRuntimeRunning();

    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('returns false when runtime is not available', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });

    const result = ensureContainerRuntimeRunning();

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('does nothing when no containers are running', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });
});
