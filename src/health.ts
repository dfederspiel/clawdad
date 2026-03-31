/**
 * Health check module for first-boot onboarding.
 * Returns structured prerequisite status so the web UI can guide users
 * through setup before they try to use agents.
 */
import { execSync } from 'child_process';

import { CONTAINER_IMAGE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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

export async function getHealthStatus(): Promise<HealthStatus> {
  const docker = checkDocker();
  const credentialProxy = checkCredentials();
  const anthropic: HealthStatus['anthropic'] = {
    status: credentialProxy.status,
  };
  const containerImage = checkContainerImage();

  const allGood =
    docker.status === 'running' &&
    credentialProxy.status === 'configured' &&
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
