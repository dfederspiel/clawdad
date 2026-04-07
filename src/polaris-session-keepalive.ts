/**
 * Polaris Session Keepalive — Multi-Environment
 *
 * Scans .env for POLARIS_{ENV}_BASE_URL / _EMAIL / _PASSWORD triplets.
 * For each discovered environment, runs a bash script every 10 minutes
 * that refreshes or re-authenticates the Keycloak session.
 *
 * Session cookies are written to groups/global/sessions/{env}.json
 * so all agent containers can read them from
 * /workspace/global/sessions/{env}.json (read-only mount).
 */
import { execFile } from 'child_process';
import * as path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const SCRIPT_TIMEOUT_MS = 30_000;
const SESSIONS_DIR = path.join(GROUPS_DIR, 'global', 'sessions');
const SCRIPT_PATH = path.join(
  process.cwd(),
  'scripts',
  'polaris-session-keepalive.sh',
);

let timer: ReturnType<typeof setInterval> | null = null;
let discoveredEnvs: string[] = [];

/**
 * Scan .env for all POLARIS_{ENV}_BASE_URL keys that also have
 * matching _EMAIL and _PASSWORD. Returns the lowercase env names.
 */
function discoverPolarisEnvironments(): string[] {
  const env = readEnvFile();
  const envs: string[] = [];

  for (const key of Object.keys(env)) {
    const match = key.match(/^POLARIS_([A-Z0-9]+)_BASE_URL$/);
    if (!match) continue;

    const envName = match[1].toLowerCase();
    const prefix = `POLARIS_${match[1]}`;

    if (env[`${prefix}_EMAIL`] && env[`${prefix}_PASSWORD`]) {
      envs.push(envName);
    } else {
      logger.debug(
        { env: envName },
        'Polaris environment has BASE_URL but missing EMAIL or PASSWORD — skipping',
      );
    }
  }

  return envs;
}

function refreshEnvironment(envName: string): void {
  const sessionFile = path.join(SESSIONS_DIR, `${envName}.json`);

  execFile(
    'bash',
    [SCRIPT_PATH, envName, sessionFile],
    {
      cwd: process.cwd(),
      timeout: SCRIPT_TIMEOUT_MS,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
    (error, stdout, stderr) => {
      if (error) {
        logger.warn(
          { env: envName, error: error.message, stderr: stderr.slice(0, 500) },
          'Polaris session keepalive failed',
        );
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        logger.info(
          { env: envName, status: result.status, action: result.action },
          'Polaris session keepalive completed',
        );
      } catch {
        logger.debug(
          { env: envName, stdout: stdout.slice(0, 200) },
          'Polaris session keepalive output',
        );
      }
    },
  );
}

function refreshAllEnvironments(): void {
  for (const envName of discoveredEnvs) {
    refreshEnvironment(envName);
  }
}

export function startPolarisSessionKeepalive(): void {
  discoveredEnvs = discoverPolarisEnvironments();

  if (discoveredEnvs.length === 0) {
    logger.debug(
      'Polaris session keepalive disabled — no POLARIS_*_BASE_URL with credentials found',
    );
    return;
  }

  // Run immediately, then on interval
  refreshAllEnvironments();
  timer = setInterval(refreshAllEnvironments, KEEPALIVE_INTERVAL_MS);
  logger.info(
    { environments: discoveredEnvs, intervalMs: KEEPALIVE_INTERVAL_MS },
    'Polaris session keepalive started',
  );
}

export function stopPolarisSessionKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
