/**
 * Health check module for first-boot onboarding.
 * Returns structured prerequisite status so the web UI can guide users
 * through setup before they try to use agents.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_IMAGE, CREDENTIAL_PROXY_PORT } from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { detectAuthMode, getAnthropicAuthHealth } from './provider-auth.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { ProviderAuthHealth } from './runtime-types.js';

export interface SmokeTestResult {
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
  claudeVersion?: string;
}

export interface OllamaHealth {
  status: 'running' | 'unreachable' | 'not_configured';
  modelCount?: number;
  host?: string;
}

export interface HealthStatus {
  docker: {
    status: 'running' | 'not_running' | 'not_found';
    version?: string;
  };
  credential_proxy: {
    status: 'configured' | 'missing';
  };
  anthropic: ProviderAuthHealth;
  container_image: {
    status: 'built' | 'not_found';
    image: string;
  };
  container_smoke?: SmokeTestResult;
  ollama?: OllamaHealth;
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

/** Check .env for Anthropic credentials. */
function checkCredentials(): HealthStatus['credential_proxy'] {
  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const configured =
    !!envVars.ANTHROPIC_API_KEY ||
    !!envVars.CLAUDE_CODE_OAUTH_TOKEN ||
    !!envVars.ANTHROPIC_AUTH_TOKEN;
  return { status: configured ? 'configured' : 'missing' };
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

/**
 * Spawn a throwaway container that runs `claude --version` to verify:
 * - Container image works
 * - UID/permissions are correct (Claude Code refuses root)
 * - Credential proxy is reachable
 *
 * Call after the credential proxy is started.
 */
export function checkContainerSmoke(): SmokeTestResult {
  const args: string[] = ['run', '--rm', '--entrypoint', 'npx'];

  // Match the UID logic from container-runner to catch permission issues
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0) {
    args.push('--user', `${hostUid}:${hostGid}`);
  } else {
    args.push('--user', '1000:1000');
  }

  // Credential env vars (same as container-runner)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    '-e',
    'HOME=/home/node',
  );
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Host gateway for container→host networking
  args.push(...hostGatewayArgs());

  args.push(CONTAINER_IMAGE, 'claude', '--version');

  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ${args.map((a) => `'${a}'`).join(' ')}`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30000,
      },
    );
    const version = output.trim().split('\n').pop()?.trim();
    return { status: 'passed', claudeVersion: version };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract meaningful part from Docker/Claude Code errors
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    return { status: 'failed', error: stderr || msg };
  }
}

async function checkOllama(): Promise<OllamaHealth | undefined> {
  const env = readEnvFile();
  const host = env.OLLAMA_HOST || 'http://localhost:11434';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${host}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { status: 'unreachable', host };
    }
    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    return {
      status: 'running',
      modelCount: data.models?.length || 0,
      host,
    };
  } catch {
    return { status: 'unreachable', host };
  }
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const docker = checkDocker();
  const credentialProxy = checkCredentials();
  const anthropic = getAnthropicAuthHealth();
  const containerImage = checkContainerImage();
  const ollama = await checkOllama();

  const allGood =
    docker.status === 'running' &&
    credentialProxy.status === 'configured' &&
    anthropic.status === 'ready' &&
    containerImage.status === 'built';

  const result: HealthStatus = {
    docker,
    credential_proxy: credentialProxy,
    anthropic,
    container_image: containerImage,
    overall: allGood ? 'ready' : 'needs_setup',
  };

  // Ollama is optional — include if reachable
  if (ollama) {
    result.ollama = ollama;
  }

  logger.debug({ health: result }, 'Health check completed');
  return result;
}
