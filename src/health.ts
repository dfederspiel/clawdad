/**
 * Health check module for first-boot onboarding.
 * Returns structured prerequisite status so the web UI can guide users
 * through setup before they try to use agents.
 *
 * Supports two credential paths:
 *   1. Native credential proxy — keys in .env (fast, no external deps)
 *   2. OneCLI Agent Vault — keys in vault, checked via HTTP API
 * Both are checked; either passing is sufficient.
 */
import { execSync } from 'child_process';
import http from 'http';

import { CONTAINER_IMAGE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const ONECLI_DEFAULT_URL = 'http://127.0.0.1:10254';

export interface HealthStatus {
  docker: {
    status: 'running' | 'not_running' | 'not_found';
    version?: string;
  };
  credential_proxy: {
    status: 'configured' | 'missing';
  };
  anthropic: {
    status: 'configured' | 'missing';
  };
  container_image: {
    status: 'built' | 'not_found';
    image: string;
  };
  overall: 'ready' | 'needs_setup';
}

function checkDocker(): HealthStatus['docker'] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} info --format '{{.ServerVersion}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 10000,
      },
    );
    return { status: 'running', version: output.trim() };
  } catch {
    // Docker exists but isn't running vs not installed at all
    try {
      execSync(`which ${CONTAINER_RUNTIME_BIN}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
      return { status: 'not_running' };
    } catch {
      return { status: 'not_found' };
    }
  }
}

// --- Credential checking helpers ---

/** Check .env for Anthropic credentials (native credential proxy path). */
function hasEnvCredentials(): boolean {
  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return (
    !!envVars.ANTHROPIC_API_KEY ||
    !!envVars.CLAUDE_CODE_OAUTH_TOKEN ||
    !!envVars.ANTHROPIC_AUTH_TOKEN
  );
}

/**
 * Check if any secret in the OneCLI vault matches the Anthropic host.
 * Supports custom ANTHROPIC_BASE_URL endpoints.
 */
function matchesAnthropicHost(
  secrets: Array<{ hostPattern?: string }>,
): boolean {
  const envVars = readEnvFile(['ANTHROPIC_BASE_URL']);
  const baseUrl = process.env.ANTHROPIC_BASE_URL || envVars.ANTHROPIC_BASE_URL;
  const anthropicHost = baseUrl
    ? new URL(baseUrl).hostname
    : 'api.anthropic.com';
  return (
    Array.isArray(secrets) &&
    secrets.some(
      (s) =>
        s.hostPattern &&
        (s.hostPattern.includes('anthropic.com') ||
          s.hostPattern.includes(anthropicHost)),
    )
  );
}

/** Try the onecli CLI binary (fast, no network). Returns null if CLI unavailable. */
function checkOneCLIViaCli(): boolean | null {
  try {
    const output = execSync('onecli secrets list', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const secrets = JSON.parse(output);
    return matchesAnthropicHost(secrets);
  } catch {
    return null; // CLI not available
  }
}

/** Query the OneCLI HTTP API for secrets. */
function checkOneCLIViaApi(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/api/secrets', ONECLI_DEFAULT_URL);
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const secrets = JSON.parse(data);
          resolve(matchesAnthropicHost(secrets));
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Returns true if the OneCLI gateway is responding. */
export function checkGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/api/health', ONECLI_DEFAULT_URL);
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// --- Health checks ---

/**
 * Check if credentials are available via either path:
 *   1. .env (native credential proxy)
 *   2. OneCLI vault (CLI first, then HTTP API fallback)
 */
async function checkCredentialProxy(): Promise<
  HealthStatus['credential_proxy']
> {
  if (hasEnvCredentials()) return { status: 'configured' };

  // Try OneCLI: CLI binary first, then HTTP API
  const cliResult = checkOneCLIViaCli();
  if (cliResult === true) return { status: 'configured' };
  if (cliResult === null) {
    // CLI unavailable — try HTTP API
    const apiResult = await checkOneCLIViaApi();
    if (apiResult) return { status: 'configured' };
  }

  return { status: 'missing' };
}

/**
 * Check if Anthropic credentials are configured via either path.
 * Same cascade as checkCredentialProxy but reported separately for the UI.
 */
async function checkAnthropic(): Promise<HealthStatus['anthropic']> {
  const proxy = await checkCredentialProxy();
  return { status: proxy.status };
}

function checkContainerImage(): HealthStatus['container_image'] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} images ${CONTAINER_IMAGE} --format '{{.ID}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    );
    return {
      status: output.trim() ? 'built' : 'not_found',
      image: CONTAINER_IMAGE,
    };
  } catch {
    return { status: 'not_found', image: CONTAINER_IMAGE };
  }
}

export async function getHealthStatus(): Promise<HealthStatus> {
  // Run checks concurrently where possible
  const [docker, credentialProxy] = await Promise.all([
    Promise.resolve(checkDocker()),
    checkCredentialProxy(),
  ]);
  const anthropic: HealthStatus['anthropic'] = {
    status: credentialProxy.status,
  };
  const containerImage = checkContainerImage();

  const allGood =
    docker.status === 'running' &&
    credentialProxy.status === 'configured' &&
    anthropic.status === 'configured' &&
    containerImage.status === 'built';

  const result: HealthStatus = {
    docker,
    credential_proxy: credentialProxy,
    anthropic,
    container_image: containerImage,
    overall: allGood ? 'ready' : 'needs_setup',
  };

  logger.debug({ health: result }, 'Health check completed');
  return result;
}
