import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpRoot: string;

vi.mock('./config.js', async () => {
  // Redirect GROUPS_DIR and DATA_DIR into a tmp directory per-process.
  // Populated from the `tmpRoot` variable above once beforeEach runs.
  return {
    get GROUPS_DIR() {
      return path.join(tmpRoot, 'groups');
    },
    get DATA_DIR() {
      return path.join(tmpRoot, 'data');
    },
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3457,
    IDLE_TIMEOUT: 1800000,
    OLLAMA_ADMIN_TOOLS: false,
    TIMEZONE: 'America/Los_Angeles',
  };
});

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: () => [],
  stopContainer: vi.fn(),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: () => [],
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: () => ({ mode: 'api-key' }),
}));

import { computeClaudeMdFingerprint } from './container-runner.js';

describe('computeClaudeMdFingerprint', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'web_demo'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'global'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'global-web'), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns same hash for identical inputs', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'web_demo', 'CLAUDE.md'),
      'hello',
    );
    const a = computeClaudeMdFingerprint('web_demo', false, 'web:demo');
    const b = computeClaudeMdFingerprint('web_demo', false, 'web:demo');
    expect(a).toBe(b);
  });

  it('changes when group CLAUDE.md content changes', () => {
    const p = path.join(tmpRoot, 'groups', 'web_demo', 'CLAUDE.md');
    fs.writeFileSync(p, 'original');
    const before = computeClaudeMdFingerprint('web_demo', false, 'web:demo');

    fs.writeFileSync(p, 'edited');
    const after = computeClaudeMdFingerprint('web_demo', false, 'web:demo');

    expect(after).not.toBe(before);
  });

  it('changes when agent CLAUDE.md content changes', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'web_demo', 'CLAUDE.md'),
      'group',
    );
    const agentDir = path.join(
      tmpRoot,
      'groups',
      'web_demo',
      'agents',
      'analyst',
    );
    fs.mkdirSync(agentDir, { recursive: true });
    const agentMd = path.join(agentDir, 'CLAUDE.md');

    fs.writeFileSync(agentMd, 'v1');
    const before = computeClaudeMdFingerprint(
      'web_demo',
      false,
      'web:demo',
      'analyst',
    );

    fs.writeFileSync(agentMd, 'v2');
    const after = computeClaudeMdFingerprint(
      'web_demo',
      false,
      'web:demo',
      'analyst',
    );

    expect(after).not.toBe(before);
  });

  it('detects global CLAUDE.md edits for non-main groups', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'web_demo', 'CLAUDE.md'),
      'group',
    );
    const globalMd = path.join(tmpRoot, 'groups', 'global', 'CLAUDE.md');

    fs.writeFileSync(globalMd, 'old');
    const before = computeClaudeMdFingerprint('web_demo', false, 'web:demo');

    fs.writeFileSync(globalMd, 'new');
    const after = computeClaudeMdFingerprint('web_demo', false, 'web:demo');

    expect(after).not.toBe(before);
  });

  it('ignores global CLAUDE.md changes for main groups', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'web_demo', 'CLAUDE.md'),
      'group',
    );
    const globalMd = path.join(tmpRoot, 'groups', 'global', 'CLAUDE.md');

    fs.writeFileSync(globalMd, 'old');
    const before = computeClaudeMdFingerprint('web_demo', true, 'web:demo');

    fs.writeFileSync(globalMd, 'new');
    const after = computeClaudeMdFingerprint('web_demo', true, 'web:demo');

    expect(after).toBe(before);
  });

  it('handles missing CLAUDE.md files without throwing', () => {
    // No files created — all paths resolve to missing
    const hash = computeClaudeMdFingerprint('web_demo', false, 'web:demo');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
