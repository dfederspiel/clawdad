/**
 * Warm Container Pool for coordinator reuse.
 *
 * Keeps coordinator containers alive between queries so subsequent
 * messages get cache hits instead of cache writes. The pool owns
 * idle containers exclusively — the queue does not track them.
 *
 * Ownership model:
 *   Queue owns running work (activeWorkCount)
 *   Pool owns idle warm coordinators (idlePoolCount)
 *   A container is never in both.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { ContainerHandle } from './container-runner.js';
import { logger } from './logger.js';

interface PoolEntry {
  handle: ContainerHandle;
  agentId: string;
  groupJid: string;
  state: 'idle' | 'reclaiming';
  idleSince: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface PoolSnapshot {
  idleCount: number;
  entries: Array<{
    agentId: string;
    groupJid: string;
    state: string;
    idleSince: number | null;
    queryCount: number;
    containerName: string;
  }>;
}

export class ContainerPool {
  private entries = new Map<string, PoolEntry>();
  private _idleCount = 0;
  private onCountChangeFn: ((idleCount: number) => void) | null = null;

  constructor(
    private idleTimeoutMs: number,
    private enabled: boolean,
  ) {}

  get idleCount(): number {
    return this._idleCount;
  }

  setOnCountChange(fn: (idleCount: number) => void): void {
    this.onCountChangeFn = fn;
  }

  private notifyCountChange(): void {
    if (this.onCountChangeFn) this.onCountChangeFn(this._idleCount);
  }

  /**
   * Try to acquire a warm container for the given agent.
   * Returns handle if idle, null otherwise. Atomically removes from pool.
   */
  acquire(agentId: string): ContainerHandle | null {
    if (!this.enabled) return null;
    const entry = this.entries.get(agentId);
    if (!entry || entry.state !== 'idle' || entry.handle.exited) {
      // Clean up dead entries
      if (entry?.handle.exited) {
        this.removeEntry(agentId);
      }
      return null;
    }

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const handle = entry.handle;
    this.entries.delete(agentId);
    this._idleCount--;
    this.notifyCountChange();

    logger.info(
      {
        agentId,
        containerName: handle.containerName,
        queryCount: handle.queryCount,
        idleDuration: Date.now() - (entry.idleSince || 0),
      },
      'Pool: acquired warm container',
    );

    return handle;
  }

  /**
   * Release a container into the pool after a query completes.
   * Pool takes exclusive ownership. Starts idle timer and crash monitor.
   */
  release(agentId: string, handle: ContainerHandle, groupJid: string): void {
    if (!this.enabled || handle.exited) {
      // Pool disabled or container already dead — write _close to clean up
      if (!handle.exited) {
        this.writeCloseSentinel(handle.groupFolder);
      }
      return;
    }

    // Evict any existing entry for this agent (shouldn't happen, but defensive)
    if (this.entries.has(agentId)) {
      logger.warn({ agentId }, 'Pool: evicting existing entry before release');
      this.reclaimSync(agentId);
    }

    const entry: PoolEntry = {
      handle,
      agentId,
      groupJid,
      state: 'idle',
      idleSince: Date.now(),
      idleTimer: null,
    };

    // Start idle timeout
    entry.idleTimer = setTimeout(() => {
      logger.info(
        { agentId, containerName: handle.containerName },
        'Pool: idle timeout, reclaiming container',
      );
      this.reclaim(agentId);
    }, this.idleTimeoutMs);

    // Monitor for unexpected exit while idle
    handle.exitPromise.then(({ code }) => {
      const current = this.entries.get(agentId);
      if (current && current.handle === handle && current.state === 'idle') {
        logger.warn(
          { agentId, code, containerName: handle.containerName },
          'Pool: container exited unexpectedly while idle',
        );
        this.handleUnexpectedExit(agentId);
      }
    });

    this.entries.set(agentId, entry);
    this._idleCount++;
    this.notifyCountChange();

    logger.info(
      {
        agentId,
        containerName: handle.containerName,
        queryCount: handle.queryCount,
        poolSize: this._idleCount,
      },
      'Pool: released container to pool',
    );
  }

  /**
   * Reclaim a container: write _close, wait for exit, clean up.
   */
  async reclaim(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    if (entry.state === 'reclaiming') return; // already in progress

    entry.state = 'reclaiming';
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    if (!entry.handle.exited) {
      this.writeCloseSentinel(entry.handle.groupFolder);
      await entry.handle.exitPromise;
    }

    this.removeEntry(agentId);
    logger.info(
      { agentId, containerName: entry.handle.containerName },
      'Pool: container reclaimed',
    );
  }

  /**
   * Synchronous reclaim: write _close but don't wait for exit.
   * Used internally when we need to evict before releasing.
   */
  private reclaimSync(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (!entry.handle.exited) {
      this.writeCloseSentinel(entry.handle.groupFolder);
    }
    this.removeEntry(agentId);
  }

  /**
   * Evict the oldest idle container. Returns true if evicted.
   * Called when concurrency budget needs a slot.
   */
  evictOldest(): boolean {
    let oldest: PoolEntry | null = null;
    let oldestId: string | null = null;

    for (const [id, entry] of this.entries) {
      if (entry.state !== 'idle') continue;
      if (!oldest || (entry.idleSince || 0) < (oldest.idleSince || 0)) {
        oldest = entry;
        oldestId = id;
      }
    }

    if (!oldestId) return false;

    logger.info(
      {
        agentId: oldestId,
        containerName: oldest!.handle.containerName,
        idleDuration: Date.now() - (oldest!.idleSince || 0),
      },
      'Pool: evicting oldest idle container for concurrency',
    );

    this.reclaimSync(oldestId);
    return true;
  }

  /**
   * Handle unexpected container exit while in pool.
   * First-class invariant: ANY unexpected exit cleans up pool state.
   */
  private handleUnexpectedExit(agentId: string): void {
    this.removeEntry(agentId);
  }

  private removeEntry(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.entries.delete(agentId);
    // Decrement idle count: both 'idle' and 'reclaiming' entries were
    // counted when they were released into the pool.
    this._idleCount--;
    this.notifyCountChange();
  }

  private writeCloseSentinel(groupFolder: string): void {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      /* ignore */
    }
  }

  getSnapshot(): PoolSnapshot {
    const entries: PoolSnapshot['entries'] = [];
    for (const [agentId, entry] of this.entries) {
      entries.push({
        agentId,
        groupJid: entry.groupJid,
        state: entry.state,
        idleSince: entry.idleSince,
        queryCount: entry.handle.queryCount,
        containerName: entry.handle.containerName,
      });
    }
    return { idleCount: this._idleCount, entries };
  }

  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [agentId] of this.entries) {
      promises.push(this.reclaim(agentId));
    }
    await Promise.all(promises);
    logger.info('Pool: all containers reclaimed on shutdown');
  }
}
