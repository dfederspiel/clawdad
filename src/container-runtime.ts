/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * Check whether the container runtime is reachable.
 * Returns true if running, false otherwise. Does NOT throw — the web server
 * must stay alive even when Docker is down so the onboarding UI can guide
 * the user through fixing it.
 */
export function ensureContainerRuntimeRunning(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
    return true;
  } catch (err) {
    logger.warn(
      { err },
      'Container runtime not reachable — agents will not run until Docker is started',
    );
    return false;
  }
}

/**
 * Convert a group folder name to the container name prefix used by container-runner.
 * Must mirror the safeName logic in container-runner.ts:
 *   `nanoclaw-${folder.replace(/[^a-zA-Z0-9-]/g, '-')}`
 */
function containerPrefix(folder: string): string {
  return `nanoclaw-${folder.replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

/**
 * Kill orphaned NanoClaw containers from previous runs.
 * Only stops containers whose group folder exists in THIS instance's groups/
 * directory, so multiple NanoClaw installs don't interfere with each other.
 *
 * Matching works forward (folder → container prefix) rather than reverse
 * (container name → folder) because the folder-to-safename mapping is lossy
 * (both '_' and other special chars become '-').
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const allContainers = output.trim().split('\n').filter(Boolean);

    // Build set of valid container prefixes from actual group folders
    const groupsDir = path.resolve(process.cwd(), 'groups');
    const prefixes: string[] = [];
    try {
      for (const entry of fs.readdirSync(groupsDir)) {
        if (fs.statSync(path.join(groupsDir, entry)).isDirectory()) {
          prefixes.push(containerPrefix(entry));
        }
      }
    } catch {
      /* groups dir may not exist yet */
    }

    // A container belongs to this instance if its name starts with a known
    // prefix followed by a dash and timestamp digits
    const orphans = allContainers.filter((name) =>
      prefixes.some(
        (prefix) =>
          name.startsWith(prefix + '-') &&
          /^-\d+$/.test(name.slice(prefix.length)),
      ),
    );

    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
    if (allContainers.length > orphans.length) {
      logger.debug(
        { skipped: allContainers.length - orphans.length },
        'Skipped containers belonging to other NanoClaw instances',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
