/**
 * Polaris Session Keepalive — Multi-Environment
 *
 * Scans .env for POLARIS_{ENV}_BASE_URL / _EMAIL / _PASSWORD triplets.
 * For each discovered environment:
 *   1. On startup, authenticates via Playwright headless browser
 *   2. Extracts the Kong `session` + `OrgId` cookies
 *   3. Writes session JSON to groups/global/sessions/{env}.json
 *   4. Every interval, pings the session via curl to keep it alive
 *   5. If the session expires, re-authenticates via Playwright
 *
 * Agent containers read sessions from /workspace/global/sessions/{env}.json
 * (read-only mount) and use them for Polaris API calls.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { GROUPS_DIR } from './config.js';
import { readEnvFile, writeEnvVar } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (session is short-lived)
const SCRIPT_TIMEOUT_MS = 60_000; // browser auth can be slow
const SESSIONS_DIR = path.join(GROUPS_DIR, 'global', 'sessions');
const PLAYWRIGHT_STATE_FILE = path.join(SESSIONS_DIR, 'playwright-state.json');
const AUTH_SCRIPT = path.join(
  process.cwd(),
  'scripts',
  'polaris-browser-auth.ts',
);

let timer: ReturnType<typeof setInterval> | null = null;
let discoveredEnvs: string[] = [];

interface SessionData {
  env: string;
  base_url: string;
  domain: string;
  session_cookie: string;
  org_id: string;
  organization_id: string;
  updated_at: string;
  status: string;
  api_token?: string;
}

/**
 * Scan .env for all POLARIS_{ENV}_BASE_URL keys that also have
 * matching _EMAIL and _PASSWORD. Returns the lowercase env names.
 */
function discoverPolarisEnvironments(): string[] {
  const env = readEnvFile();
  const envs: string[] = [];

  for (const key of Object.keys(env)) {
    const match = key.match(/^POLARIS_([A-Z0-9]+(?:_[A-Z0-9]+)*)_BASE_URL$/);
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

/**
 * Read an existing session file. Returns null if missing or invalid.
 */
function readSession(envName: string): SessionData | null {
  const sessionFile = path.join(SESSIONS_DIR, `${envName}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    if (data.session_cookie && data.base_url) return data as SessionData;
  } catch {
    // File doesn't exist or is invalid
  }
  return null;
}

/**
 * Ping the Polaris userinfo endpoint to check if the session is still valid.
 * If valid, updates the timestamp in the session file.
 */
async function pingSession(envName: string): Promise<boolean> {
  const session = readSession(envName);
  if (!session) return false;

  // Assessor/admin sessions use org_id "master" (not a UUID) and need
  // the admin userinfo endpoint without an organization-id header.
  const isAdminSession = !/^[0-9a-f-]{36}$/.test(session.org_id);
  const cookieStr = isAdminSession
    ? `session=${session.session_cookie}`
    : `session=${session.session_cookie}; OrgId=${session.org_id}`;
  const userinfoUrl = isAdminSession
    ? `${session.base_url}/api/auth/openid-connect/admin/userinfo`
    : `${session.base_url}/api/auth/openid-connect/userinfo`;

  const curlArgs = [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-b',
    cookieStr,
    '-H',
    'Accept: application/json',
    '--max-time',
    '10',
    userinfoUrl,
  ];
  // Only add organization-id header for tenant-scoped sessions
  if (!isAdminSession) {
    curlArgs.splice(8, 0, '-H', `organization-id: ${session.organization_id}`);
  }

  try {
    const { stdout } = await execFileAsync('curl', curlArgs, {
      timeout: 15_000,
    });

    if (stdout.trim() === '200') {
      // Session still valid — update timestamp
      session.updated_at = new Date().toISOString();
      session.status = 'active';
      fs.writeFileSync(
        path.join(SESSIONS_DIR, `${envName}.json`),
        JSON.stringify(session, null, 2),
      );
      return true;
    }
  } catch (err) {
    logger.debug({ env: envName, error: err }, 'Session ping failed');
  }
  return false;
}

/**
 * Authenticate via Playwright headless browser.
 * Runs the browser auth script as a child process.
 */
async function browserAuth(envName: string): Promise<boolean> {
  const sessionFile = path.join(SESSIONS_DIR, `${envName}.json`);

  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', AUTH_SCRIPT, envName, sessionFile],
      {
        cwd: process.cwd(),
        timeout: SCRIPT_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          // Playwright needs these
          DISPLAY: process.env.DISPLAY,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        },
      },
    );

    if (stderr) {
      logger.debug(
        { env: envName, stderr: stderr.slice(0, 500) },
        'Browser auth stderr',
      );
    }

    try {
      const result = JSON.parse(stdout.trim());
      if (result.status === 'ok') {
        // Cache API token in .env if generated
        const session = readSession(envName);
        if (session?.api_token) {
          const envKey = `POLARIS_${envName.toUpperCase()}_API_TOKEN`;
          writeEnvVar(envKey, session.api_token);
          logger.info(
            { env: envName, envKey },
            'Polaris API token cached in .env',
          );
        }
        logger.info(
          {
            env: envName,
            action: result.action,
            hasApiToken: result.has_api_token,
          },
          'Polaris browser auth succeeded',
        );
        return true;
      }
      logger.warn(
        { env: envName, result },
        'Polaris browser auth returned non-ok status',
      );
    } catch {
      logger.debug(
        { env: envName, stdout: stdout.slice(0, 200) },
        'Browser auth output',
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ env: envName, error: msg }, 'Polaris browser auth failed');
  }
  return false;
}

/**
 * Refresh a single environment: try ping first, fall back to browser auth.
 */
async function refreshEnvironment(envName: string): Promise<void> {
  // Ensure API token from session file is cached in .env
  // (covers tokens generated by manual browser auth runs)
  const existing = readSession(envName);
  if (existing?.api_token) {
    const envKey = `POLARIS_${envName.toUpperCase()}_API_TOKEN`;
    const env = readEnvFile();
    if (!env[envKey]) {
      writeEnvVar(envKey, existing.api_token);
      logger.info(
        { env: envName, envKey },
        'Polaris API token cached in .env from session file',
      );
    }
  }

  // Try to keep existing session alive
  const alive = await pingSession(envName);
  if (alive) {
    logger.info({ env: envName }, 'Polaris session refreshed via ping');
    return;
  }

  // Session expired or doesn't exist — re-authenticate
  logger.info(
    { env: envName },
    'Polaris session expired, re-authenticating via browser',
  );
  const ok = await browserAuth(envName);
  if (!ok) {
    logger.warn({ env: envName }, 'Polaris re-authentication failed');
  }
}

/**
 * Merge per-environment browser state files into a single Playwright storage
 * state file. Each {env}-browser-state.json is produced by the browser auth
 * script and contains the full context.storageState() output — cookies AND
 * localStorage (including Keycloak tokens the SPA needs).
 *
 * Cookies are domain-scoped so multiple environments coexist safely.
 * localStorage entries are origin-scoped (one per base URL).
 */
function writePlaywrightStorageState(): void {
  const allCookies: unknown[] = [];
  const allOrigins: unknown[] = [];
  const seenOrigins = new Set<string>();

  const stateFiles = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('-browser-state.json'));

  for (const file of stateFiles) {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'),
      );
      if (Array.isArray(state.cookies)) {
        allCookies.push(...state.cookies);
      }
      if (Array.isArray(state.origins)) {
        for (const origin of state.origins) {
          if (origin.origin && !seenOrigins.has(origin.origin)) {
            seenOrigins.add(origin.origin);
            allOrigins.push(origin);
          }
        }
      }
    } catch {
      logger.debug({ file }, 'Skipping invalid browser state file');
    }
  }

  // Fall back to constructing cookies from session JSONs if no browser
  // state files exist yet (first run before browser auth completes).
  if (stateFiles.length === 0) {
    const sessionFiles = fs
      .readdirSync(SESSIONS_DIR)
      .filter(
        (f) =>
          f.endsWith('.json') &&
          f !== 'playwright-state.json' &&
          !f.endsWith('-browser-state.json'),
      );
    for (const file of sessionFiles) {
      const session = readSession(file.replace('.json', ''));
      if (!session || session.status !== 'active') continue;
      allCookies.push(
        {
          name: 'session',
          value: session.session_cookie,
          domain: session.domain,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'OrgId',
          value: session.org_id,
          domain: session.domain,
          path: '/',
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
      );
    }
  }

  fs.writeFileSync(
    PLAYWRIGHT_STATE_FILE,
    JSON.stringify({ cookies: allCookies, origins: allOrigins }, null, 2),
  );
  logger.debug(
    {
      stateFiles: stateFiles.length,
      cookies: allCookies.length,
      origins: allOrigins.length,
    },
    'Playwright storage state updated',
  );
}

async function refreshAllEnvironments(): Promise<void> {
  for (const envName of discoveredEnvs) {
    await refreshEnvironment(envName);
  }
  writePlaywrightStorageState();
}

export function startPolarisSessionKeepalive(): void {
  discoveredEnvs = discoverPolarisEnvironments();

  if (discoveredEnvs.length === 0) {
    logger.debug(
      'Polaris session keepalive disabled — no POLARIS_*_BASE_URL with credentials found',
    );
    return;
  }

  // Ensure sessions directory exists
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // Run immediately, then on interval
  refreshAllEnvironments();
  timer = setInterval(() => refreshAllEnvironments(), KEEPALIVE_INTERVAL_MS);
  logger.info(
    { environments: discoveredEnvs, intervalMs: KEEPALIVE_INTERVAL_MS },
    'Polaris session keepalive started (Playwright browser auth)',
  );
}

export function stopPolarisSessionKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
