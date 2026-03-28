import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

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

// Get actual group folder names so tests use containers that match real folders
const groupFolders = fs
  .readdirSync('groups', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** Build a container name from a group folder name (mirrors container-runner safeName logic). */
function containerName(folder: string, ts = '111'): string {
  return `nanoclaw-${folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${ts}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
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
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('returns false when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    const result = ensureContainerRuntimeRunning();

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Container runtime not reachable — agents will not run until Docker is started',
    );
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  // Use real group folder names so existsSync returns true and containers are treated as orphans
  const folder1 = groupFolders[0] || 'main';
  const folder2 = groupFolders[1] || 'global';
  const cn1 = containerName(folder1, '111');
  const cn2 = containerName(folder2, '222');

  it('stops orphaned nanoclaw containers', () => {
    mockExecSync.mockReturnValueOnce(`${cn1}\n${cn2}\n`);
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 ${cn1}`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 ${cn2}`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: [cn1, cn2] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce(`${cn1}\n${cn2}\n`);
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: [cn1, cn2] },
      'Stopped orphaned containers',
    );
  });

  it('skips containers whose group folder does not exist', () => {
    // One real folder, one fake folder
    const realCn = containerName(folder1, '1');
    const fakeCn = 'nanoclaw-nonexistent-folder-xyz-2';
    mockExecSync.mockReturnValueOnce(`${realCn}\n${fakeCn}\n`);
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 1 stop (only real folder)
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 1, names: [realCn] },
      'Stopped orphaned containers',
    );
  });
});
