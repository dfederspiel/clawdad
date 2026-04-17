/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  OLLAMA_ADMIN_TOOLS,
  TIMEZONE,
} from './config.js';
import {
  resolveAgentIpcInputPath,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { readEnvFile } from './env.js';
import { RegisteredGroup } from './types.js';
import { AgentRuntimeConfig, RuntimeTurnConstraints } from './runtime-types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';
const TEXT_START_MARKER = '---NANOCLAW_TEXT_START---';
const TEXT_END_MARKER = '---NANOCLAW_TEXT_END---';

export interface ProgressEvent {
  tool?: string;
  summary: string;
  timestamp: string;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentId?: string; // '{group_folder}/{agent_name}' — used for session isolation
  agentName?: string; // agent name within the group
  runBatchId?: string; // shared delivery batch for supersession-aware routing
  canDelegate?: boolean; // true for coordinator agents (no trigger)
  isDelegation?: boolean; // delegation semantics (output routing, completion signaling)
  poolManaged?: boolean; // true = stay alive for follow-up queries (warm pool)
  mainChatJid?: string; // JID of the main group (for escalation messaging)
  script?: string;
  runtime?: AgentRuntimeConfig; // future provider/runtime boundary
  constraints?: RuntimeTurnConstraints; // per-turn safety rails (maxTurns, disallowedTools)
  systemContext?: string; // multi-agent context injected into systemPrompt.append (survives compaction)
  achievements?: { id: string; name: string; description: string }[];
}

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: UsageData;
  textsAlreadyStreamed?: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
  agentName?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Empty marker so `test -d /workspace/project` works as a main-channel
    // detection heuristic without exposing any host files (especially .env).
    const markerDir = path.join(DATA_DIR, 'marker-project');
    fs.mkdirSync(markerDir, { recursive: true });
    mounts.push({
      hostPath: markerDir,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Channel-specific global instructions (web UI only)
    // Mounts blocks, sounds, and other web-only guidance
    if (chatJid.startsWith('web:')) {
      const globalWebDir = path.join(GROUPS_DIR, 'global-web');
      if (fs.existsSync(globalWebDir)) {
        mounts.push({
          hostPath: globalWebDir,
          containerPath: '/workspace/global-web',
          readonly: true,
        });
      }
    }
  }

  // Per-agent Claude sessions directory (isolated from other agents)
  // Each agent gets their own .claude/ to prevent cross-agent session access
  const sessionSubdir = agentName
    ? path.join(group.folder, agentName)
    : group.folder;
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    sessionSubdir,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Ensure .claude.json exists — Claude Code exits with code 1 if missing
  const claudeJsonFile = path.join(groupSessionsDir, '.claude.json');
  if (!fs.existsSync(claudeJsonFile)) {
    fs.writeFileSync(
      claudeJsonFile,
      JSON.stringify({ firstStartTime: new Date().toISOString() }, null, 2) +
        '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'delegations'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container input namespace: each agent gets its own input/ directory
  // so multiple warm containers in one group don't race on IPC polling.
  // We pre-create the directory and write a marker, then pass the agent name
  // via IPC_AGENT_NAME env var so the agent-runner reads from the correct
  // subdirectory within the parent /workspace/ipc mount.
  //
  // NOTE: We intentionally do NOT overlay-mount this as a child bind mount.
  // Docker Desktop for Mac (VirtioFS) has a known issue where nested bind
  // mounts create a stale filesystem view — host writes become invisible
  // to the container, breaking _close sentinels and IPC message delivery.
  const effectiveAgentName = agentName || 'default';
  const agentInputDir = resolveAgentIpcInputPath(
    group.folder,
    effectiveAgentName,
  );
  fs.mkdirSync(agentInputDir, { recursive: true });
  // Write marker so agent-runner can assert it's reading the right namespace
  const markerPath = path.join(agentInputDir, '.agent-name');
  fs.writeFileSync(markerPath, effectiveAgentName);

  // Mount agent-specific directory (for multi-agent groups with explicit agents/)
  // The agent's CLAUDE.md lives here, mounted at /workspace/agent
  if (agentName && agentName !== 'default') {
    const agentDir = path.join(groupDir, 'agents', agentName);
    if (fs.existsSync(agentDir)) {
      mounts.push({
        hostPath: agentDir,
        containerPath: '/workspace/agent',
        readonly: false,
      });
    }
  }

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    sessionSubdir,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const srcStat = fs.existsSync(srcIndex) ? fs.statSync(srcIndex) : null;
    const cachedStat = fs.existsSync(cachedIndex)
      ? fs.statSync(cachedIndex)
      : null;
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !cachedStat ||
      !srcStat ||
      srcStat.mtimeMs > cachedStat.mtimeMs ||
      srcStat.size !== cachedStat.size;
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount credential proxy scripts (api.sh, auth-args.sh, etc.)
  const containerScriptsDir = path.join(projectRoot, 'container', 'scripts');
  if (fs.existsSync(containerScriptsDir)) {
    mounts.push({
      hostPath: containerScriptsDir,
      containerPath: '/workspace/scripts',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  group?: RegisteredGroup,
  agentName?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Forward Ollama admin tools flag if enabled
  if (OLLAMA_ADMIN_TOOLS) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // --- Credential injection ---
  //
  // Anthropic: route through our local HTTP proxy which injects the real
  // API key or OAuth token. The SDK sends a placeholder value.
  //
  // Anthropic credentials: routed through the credential proxy.
  // Containers get a placeholder and ANTHROPIC_BASE_URL pointing at the proxy.
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Forward .env vars into containers in two categories:
  // 1. Credentials (_TOKEN, _KEY, _SECRET, _PASSWORD) → placeholder values
  //    that the credential proxy substitutes at request time via /forward.
  // 2. Config vars (_URL, _EMAIL, _ACCOUNT_ID, etc.) → passed directly.
  // Excluded: Anthropic/Claude vars (handled by proxy), web UI config,
  // and host-only settings that are irrelevant inside containers.
  const allEnv = readEnvFile();
  const excludePattern =
    /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_MODEL$|WEB_UI_|LOG_LEVEL$|PORT$|OLLAMA_HOST$)/;
  const credentialPattern = /.+_(TOKEN|KEY|SECRET|PASSWORD)$/;
  for (const [key, value] of Object.entries(allEnv)) {
    if (excludePattern.test(key) || !value) continue;
    if (credentialPattern.test(key)) {
      args.push('-e', `${key}=__CRED_${key}__`);
    } else {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Tell the container where the credential proxy lives for /forward calls
  args.push(
    '-e',
    `CRED_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Ensure Ollama host is available (for both MCP tool and runtime adapter)
  const ollamaHost =
    allEnv.OLLAMA_HOST || `http://${CONTAINER_HOST_GATEWAY}:11434`;
  args.push('-e', `OLLAMA_HOST=${ollamaHost}`);

  // SSH agent forwarding — mount host socket so containers can use SSH
  // without the private key ever entering the container.
  if (group?.containerConfig?.sshAgent && process.env.SSH_AUTH_SOCK) {
    const sock = process.env.SSH_AUTH_SOCK;
    args.push('-v', `${sock}:/ssh-agent`, '-e', 'SSH_AUTH_SOCK=/ssh-agent');
  }

  // Pass model override for LiteLLM proxy routing
  const claudeModel = process.env.CLAUDE_MODEL || allEnv.CLAUDE_MODEL;
  if (claudeModel) {
    args.push('-e', `CLAUDE_MODEL=${claudeModel}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Claude Code refuses --dangerously-skip-permissions as root, so we must
  // always specify a non-root user.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0) {
    args.push('--user', `${hostUid}:${hostGid}`);
  } else {
    // Root host or Windows (getuid unavailable) — run as the container's
    // node user (uid 1000) to avoid the root restriction.
    args.push('--user', '1000:1000');
  }
  // Always set HOME=/home/node — .claude/ settings are mounted there.
  args.push('-e', 'HOME=/home/node');

  // Tell the agent-runner which subdirectory to use for IPC input.
  // The parent mount at /workspace/ipc exposes the full IPC tree;
  // the agent-runner uses this to find its agent-specific input dir.
  args.push('-e', `IPC_AGENT_NAME=${agentName || 'default'}`);

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

// ── StdoutParser: reusable stdout marker parser ─────────────────────

export class StdoutParser extends EventEmitter {
  private parseBuffer = '';

  feed(chunk: string): void {
    this.parseBuffer += chunk;

    // Parse progress markers first (lightweight)
    let progStart: number;
    while (
      (progStart = this.parseBuffer.indexOf(PROGRESS_START_MARKER)) !== -1
    ) {
      const progEnd = this.parseBuffer.indexOf(PROGRESS_END_MARKER, progStart);
      if (progEnd === -1) break;
      const progJson = this.parseBuffer
        .slice(progStart + PROGRESS_START_MARKER.length, progEnd)
        .trim();
      this.parseBuffer = this.parseBuffer.slice(
        progEnd + PROGRESS_END_MARKER.length,
      );
      try {
        this.emit('progress', JSON.parse(progJson) as ProgressEvent);
      } catch {
        /* ignore malformed progress */
      }
    }

    // Parse text markers (intermediate agent text blocks)
    let textStart: number;
    while ((textStart = this.parseBuffer.indexOf(TEXT_START_MARKER)) !== -1) {
      const textEnd = this.parseBuffer.indexOf(TEXT_END_MARKER, textStart);
      if (textEnd === -1) break;
      const textJson = this.parseBuffer
        .slice(textStart + TEXT_START_MARKER.length, textEnd)
        .trim();
      this.parseBuffer = this.parseBuffer.slice(
        textEnd + TEXT_END_MARKER.length,
      );
      try {
        const parsed = JSON.parse(textJson);
        if (parsed.text) {
          this.emit('text', parsed.text as string);
        }
      } catch {
        /* ignore malformed text */
      }
    }

    // Parse output markers
    let startIdx: number;
    while ((startIdx = this.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const endIdx = this.parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) break;
      const jsonStr = this.parseBuffer
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();
      this.parseBuffer = this.parseBuffer.slice(
        endIdx + OUTPUT_END_MARKER.length,
      );
      try {
        this.emit('output', JSON.parse(jsonStr) as ContainerOutput);
      } catch (err) {
        logger.warn({ error: err }, 'Failed to parse streamed output chunk');
      }
    }
  }

  notifyExit(code: number | null): void {
    this.emit('exit', { code });
  }
}

// ── ContainerHandle: long-lived container reference ──────────────────

export interface ContainerHandle {
  readonly process: ChildProcess;
  readonly containerName: string;
  readonly groupFolder: string;
  readonly parser: StdoutParser;
  sessionId: string | undefined;
  readonly spawnedAt: number;
  lastQueryAt: number;
  exited: boolean;
  readonly exitPromise: Promise<{ code: number | null }>;
  queryCount: number;

  /**
   * Run one query cycle: wait for the next output marker that represents
   * a complete agent response (status='success' or status='error').
   *
   * Contract: the agent-runner emits exactly one OUTPUT marker per query
   * cycle. queryOnce resolves on the first output marker received after
   * invocation. All listeners are cleaned up on resolution — no leaks.
   */
  queryOnce(
    onOutput?: (output: ContainerOutput) => Promise<void>,
    onProgress?: (event: ProgressEvent) => void,
    onText?: (text: string) => Promise<void>,
    timeoutMs?: number,
  ): Promise<ContainerOutput>;
}

function createQueryOnce(
  handle: ContainerHandle,
): ContainerHandle['queryOnce'] {
  return (onOutput, onProgress, onText, timeoutMs) => {
    return new Promise<ContainerOutput>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let textChain = Promise.resolve();

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        handle.parser.off('output', onOutputEvent);
        handle.parser.off('progress', onProgressEvent);
        handle.parser.off('text', onTextEvent);
        handle.parser.off('exit', onExitEvent);
      };

      const resetTimeout = () => {
        if (!timeoutMs) return;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanup();
          try {
            stopContainer(handle.containerName);
          } catch {
            handle.process.kill('SIGKILL');
          }
          resolve({
            status: 'error',
            result: null,
            error: `Query timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      };

      const onOutputEvent = async (output: ContainerOutput) => {
        if (resolved) return;

        // Skip session-update markers: the agent-runner emits a second
        // {status:'success', result:null} after entering waitForIpcMessage.
        // These are bookkeeping, not real query responses. Without this
        // check, a stale marker from the previous query cycle can resolve
        // the next queryOnce immediately with no actual content.
        if (
          output.status === 'success' &&
          output.result === null &&
          !output.usage
        ) {
          if (output.newSessionId) handle.sessionId = output.newSessionId;
          return; // Skip — wait for the real response
        }

        resolved = true;
        cleanup();
        if (output.newSessionId) handle.sessionId = output.newSessionId;
        handle.lastQueryAt = Date.now();
        handle.queryCount++;
        if (onOutput) await onOutput(output);
        resolve(output);
      };

      const onProgressEvent = (event: ProgressEvent) => {
        if (resolved) return;
        resetTimeout();
        if (onProgress) onProgress(event);
      };

      const onTextEvent = (text: string) => {
        if (resolved) return;
        resetTimeout();
        if (onText) {
          textChain = textChain.then(() => onText(text));
        }
      };

      const onExitEvent = ({ code }: { code: number | null }) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        handle.exited = true;
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code} during query`,
        });
      };

      handle.parser.on('output', onOutputEvent);
      handle.parser.on('progress', onProgressEvent);
      handle.parser.on('text', onTextEvent);
      handle.parser.on('exit', onExitEvent);

      if (timeoutMs) resetTimeout();
    });
  };
}

// ── spawnContainer: spawn and return handle immediately ──────────────

export async function spawnContainer(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerHandle> {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    input.chatJid,
    input.agentName,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentSuffix =
    input.agentName && input.agentName !== 'default'
      ? `-${input.agentName.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
  const containerPrefix = `nanoclaw-${safeName}${agentSuffix}-`;

  // Stop any stale containers for this group before spawning
  try {
    const existing = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=${containerPrefix} --format "{{.Names}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    const now = Date.now();
    for (const name of existing) {
      // Skip recently-spawned containers to avoid killing in-flight queries.
      // Container names embed Date.now() as a suffix.
      const tsMatch = name.match(/-(\d{13,})$/);
      const spawnedAt = tsMatch ? parseInt(tsMatch[1], 10) : 0;
      if (spawnedAt && now - spawnedAt < 60_000) {
        logger.info(
          { group: group.name, recent: name, ageMs: now - spawnedAt },
          'Skipping recent container (< 60s old)',
        );
        continue;
      }
      logger.info(
        { group: group.name, stale: name },
        'Stopping stale container before spawn',
      );
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
  } catch {
    /* docker ps may fail if runtime not ready */
  }

  const containerName = `${containerPrefix}${Date.now()}`;
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    group,
    input.agentName,
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

  container.stdin.write(JSON.stringify(input));
  container.stdin.end();

  const parser = new StdoutParser();
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  container.stdout.on('data', (data) => {
    const chunk = data.toString();
    if (!stdoutTruncated) {
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn(
          { group: group.name, size: stdout.length },
          'Container stdout truncated due to size limit',
        );
      } else {
        stdout += chunk;
      }
    }
    parser.feed(chunk);
  });

  container.stderr.on('data', (data) => {
    const chunk = data.toString();
    const lines = chunk.trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      if (line.includes('[OLLAMA]')) {
        logger.info({ container: group.folder }, line);
      } else {
        logger.debug({ container: group.folder }, line);
      }
    }
    if (stderrTruncated) return;
    const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
    if (chunk.length > remaining) {
      stderr += chunk.slice(0, remaining);
      stderrTruncated = true;
      logger.warn(
        { group: group.name, size: stderr.length },
        'Container stderr truncated due to size limit',
      );
    } else {
      stderr += chunk;
    }
  });

  const exitPromise = new Promise<{ code: number | null }>((resolve) => {
    container.on('close', (code) => {
      // Write container log
      const duration = Date.now() - Date.now(); // placeholder — callers track real start time
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const isError = code !== 0;

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      if (isVerbose || isError) {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (isError) {
        logger.error(
          { group: group.name, code, stderr, stdout, logFile },
          'Container exited with error',
        );
      }

      parser.notifyExit(code);
      resolve({ code });
    });

    container.on('error', (err) => {
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      parser.notifyExit(null);
      resolve({ code: null });
    });
  });

  const handle: ContainerHandle = {
    process: container,
    containerName,
    groupFolder: group.folder,
    parser,
    sessionId: input.sessionId,
    spawnedAt: Date.now(),
    lastQueryAt: 0,
    exited: false,
    exitPromise,
    queryCount: 0,
    queryOnce: null as unknown as ContainerHandle['queryOnce'],
  };

  // Mark exited when exitPromise resolves
  exitPromise.then(() => {
    handle.exited = true;
  });

  // Attach queryOnce implementation
  handle.queryOnce = createQueryOnce(handle);

  return handle;
}

// ── runContainerAgent: compatibility wrapper ─────────────────────────
// Preserves the exact behavior of the original one-shot lifecycle:
// spawn → query → wait for exit → resolve

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (event: ProgressEvent) => void,
  onText?: (text: string) => Promise<void>,
): Promise<ContainerOutput> {
  const handle = await spawnContainer(group, input);
  onProcess(handle.process, handle.containerName);

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs =
    input.isScheduledTask || input.isDelegation
      ? configTimeout
      : Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

  // First query (already in-flight via stdin)
  const firstResult = await handle.queryOnce(
    onOutput,
    onProgress,
    onText,
    timeoutMs,
  );

  // Delegation or error: wait for container to exit, return result
  if (input.isDelegation || firstResult.status === 'error') {
    await handle.exitPromise;
    return firstResult;
  }

  // Non-delegation success: container enters IPC loop.
  // Keep listening for subsequent outputs until container exits.
  // queryOnce's one-shot listeners are already removed, so this is safe.
  return new Promise<ContainerOutput>((resolve) => {
    const onSubsequentOutput = async (output: ContainerOutput) => {
      if (output.newSessionId) handle.sessionId = output.newSessionId;
      if (onOutput) await onOutput(output);
    };
    const onSubsequentText = async (text: string) => {
      if (onText) await onText(text);
    };
    handle.parser.on('output', onSubsequentOutput);
    handle.parser.on('text', onSubsequentText);
    handle.exitPromise.then(() => {
      handle.parser.off('output', onSubsequentOutput);
      handle.parser.off('text', onSubsequentText);
      resolve({
        status: 'success',
        result: null,
        newSessionId: handle.sessionId,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
