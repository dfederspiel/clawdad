/**
 * Health check module for first-boot onboarding.
 * Returns structured prerequisite status so the web UI can guide users
 * through setup before they try to use agents.
 */
import { execSync } from 'child_process';
import http from 'http';

import { CONTAINER_IMAGE, ONECLI_URL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
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
    const output = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.ServerVersion}}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10000,
    });
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

function checkOneCLI(): Promise<HealthStatus['onecli']> {
  return new Promise((resolve) => {
    const url = new URL('/api/health', ONECLI_URL);
    const req = http.get(url, { timeout: 3000 }, (res) => {
      // Any response means the gateway is up
      res.resume();
      resolve({ status: 'running', url: ONECLI_URL });
    });
    req.on('error', () => {
      resolve({ status: 'not_found', url: ONECLI_URL });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'not_found', url: ONECLI_URL });
    });
  });
}

function checkAnthropic(): HealthStatus['anthropic'] {
  try {
    const output = execSync('onecli secrets list --json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const secrets = JSON.parse(output);
    // Look for a secret with hostPattern matching anthropic
    const anthropicHost =
      process.env.ANTHROPIC_BASE_URL
        ? new URL(process.env.ANTHROPIC_BASE_URL).hostname
        : 'api.anthropic.com';
    const found = Array.isArray(secrets) && secrets.some(
      (s: { hostPattern?: string }) =>
        s.hostPattern && (
          s.hostPattern.includes('anthropic.com') ||
          s.hostPattern.includes(anthropicHost)
        ),
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
