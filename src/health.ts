/**
 * Health check module for first-boot onboarding.
 * Returns structured prerequisite status so the web UI can guide users
 * through setup before they try to use agents.
 */
import { execSync } from 'child_process';
import http from 'http';

import { CONTAINER_IMAGE, ONECLI_URL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface HealthStatus {
  docker: {
    status: 'running' | 'not_running' | 'not_found';
    version?: string;
  };
  onecli: {
    status: 'running' | 'not_found';
    url: string;
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

/** Returns true if the OneCLI gateway is responding on its health endpoint. */
export function checkGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/api/health', ONECLI_URL);
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

function checkOneCLI(): Promise<HealthStatus['onecli']> {
  return checkGateway().then((healthy) => ({
    status: healthy ? 'running' : 'not_found',
    url: ONECLI_URL,
  }));
}

function checkAnthropic(): HealthStatus['anthropic'] {
  try {
    const output = execSync('onecli secrets list', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const secrets = JSON.parse(output);
    // Look for a secret with hostPattern matching anthropic.
    // Read ANTHROPIC_BASE_URL from .env since launchd/systemd won't have it in process.env.
    const envVars = readEnvFile(['ANTHROPIC_BASE_URL']);
    const baseUrl =
      process.env.ANTHROPIC_BASE_URL || envVars.ANTHROPIC_BASE_URL;
    const anthropicHost = baseUrl
      ? new URL(baseUrl).hostname
      : 'api.anthropic.com';
    const found =
      Array.isArray(secrets) &&
      secrets.some(
        (s: { hostPattern?: string }) =>
          s.hostPattern &&
          (s.hostPattern.includes('anthropic.com') ||
            s.hostPattern.includes(anthropicHost)),
      );
    return { status: found ? 'configured' : 'missing' };
  } catch {
    return { status: 'missing' };
  }
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
  const [docker, onecli] = await Promise.all([
    Promise.resolve(checkDocker()),
    checkOneCLI(),
  ]);
  const anthropic = checkAnthropic();
  const containerImage = checkContainerImage();

  const allGood =
    docker.status === 'running' &&
    onecli.status === 'running' &&
    anthropic.status === 'configured' &&
    containerImage.status === 'built';

  const result: HealthStatus = {
    docker,
    onecli,
    anthropic,
    container_image: containerImage,
    overall: allGood ? 'ready' : 'needs_setup',
  };

  logger.debug({ health: result }, 'Health check completed');
  return result;
}
