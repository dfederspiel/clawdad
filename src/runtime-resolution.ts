import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { getCapabilityProfile } from './model-capabilities.js';
import { AgentRuntimeConfig, RuntimeTurnConstraints } from './runtime-types.js';
import { Agent, ContainerConfig, RegisteredGroup } from './types.js';

const SPECIALIST_AUTO_BLOCKED_TOOL = 'mcp__nanoclaw__delegate_to_agent';

/**
 * Minimal tool set for specialists on non-SDK runtimes (Ollama today).
 * Small models hallucinate when given many simultaneous tools; narrowing
 * to these two gives an unambiguous signal about what they can do.
 *
 * Keep in sync with #74's Phase 1 rationale. Claude specialists are not
 * narrowed today — their SDK handles 18+ tools reliably and existing
 * workflows depend on the wider set.
 */
const NON_SDK_SPECIALIST_ALLOWED_TOOLS = [
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__set_agent_status',
];

export type PartialRuntimeConfig = Partial<AgentRuntimeConfig>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeRuntimeConfigs(
  ...configs: Array<PartialRuntimeConfig | undefined>
): AgentRuntimeConfig {
  const merged: PartialRuntimeConfig = {};

  for (const config of configs) {
    if (!config) continue;
    if (config.provider) merged.provider = config.provider;
    if (config.model) merged.model = config.model;
    if (config.baseUrl) merged.baseUrl = config.baseUrl;
    if (typeof config.temperature === 'number') {
      merged.temperature = config.temperature;
    }
    if (typeof config.maxTokens === 'number') {
      merged.maxTokens = config.maxTokens;
    }
  }

  return {
    provider: merged.provider || 'anthropic',
    model: merged.model,
    baseUrl: merged.baseUrl,
    temperature: merged.temperature,
    maxTokens: merged.maxTokens,
  };
}

export function envRuntimeFallback(
  env: NodeJS.ProcessEnv = process.env,
): PartialRuntimeConfig | undefined {
  if (env.CLAUDE_MODEL && env.CLAUDE_MODEL.trim()) {
    return {
      provider: 'anthropic',
      model: env.CLAUDE_MODEL.trim(),
    };
  }
  return undefined;
}

export function readGlobalDefaultRuntime(): PartialRuntimeConfig | undefined {
  const configPath = path.join(GROUPS_DIR, 'global', 'user-config.json');
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!isObject(config)) return undefined;

    if (isObject(config.defaultRuntime)) {
      return config.defaultRuntime as PartialRuntimeConfig;
    }

    if (
      typeof config.anthropicModel === 'string' &&
      config.anthropicModel.trim()
    ) {
      return {
        provider: 'anthropic',
        model: config.anthropicModel.trim(),
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function readGroupDefaultRuntime(
  groupFolder: string,
): PartialRuntimeConfig | undefined {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(groupFolder);
  } catch {
    return undefined;
  }

  const configPath = path.join(groupDir, 'group-config.json');
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!isObject(config) || !isObject(config.defaultRuntime)) return undefined;
    return config.defaultRuntime as PartialRuntimeConfig;
  } catch {
    return undefined;
  }
}

export function resolveEffectiveRuntime(
  agent: Agent | undefined,
  groupFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeConfig {
  return mergeRuntimeConfigs(
    readGlobalDefaultRuntime(),
    readGroupDefaultRuntime(groupFolder),
    envRuntimeFallback(env),
    agent?.runtime,
  );
}

/**
 * Resolve per-turn constraints by merging group and agent containerConfig.
 *
 * maxTurns: agent value wins if set; otherwise group value; otherwise undefined.
 * disallowedTools: union of group + agent lists, deduped.
 * Specialists (agents with a trigger) cannot delegate, so
 * mcp__nanoclaw__delegate_to_agent is always added for them regardless of
 * config. This is belt-and-suspenders — the MCP tool isn't registered for
 * specialists either — but it makes the safety rail explicit at the SDK layer.
 *
 * Returns undefined when neither cap nor blocklist applies, so the container
 * input stays minimal.
 */
export function resolveTurnConstraints(
  agent: Agent | undefined,
  group: RegisteredGroup,
): RuntimeTurnConstraints | undefined {
  const groupConfig: ContainerConfig | undefined = group.containerConfig;
  const agentConfig: ContainerConfig | undefined = agent?.containerConfig;

  const maxTurns = agentConfig?.maxTurns ?? groupConfig?.maxTurns;

  const disallowed = new Set<string>();
  for (const tool of groupConfig?.disallowedTools ?? []) disallowed.add(tool);
  for (const tool of agentConfig?.disallowedTools ?? []) disallowed.add(tool);

  // Specialist = agent with a trigger (non-coordinator). Auto-block delegation.
  const isSpecialist = Boolean(agent?.trigger);
  if (isSpecialist) {
    disallowed.add(SPECIALIST_AUTO_BLOCKED_TOOL);
  }

  // Allowlist precedence: explicit `agent.tools` (Phase 2 of #74) > role
  // default (Phase 1) > runtime's built-in default (no constraint).
  //
  // Role-scoped narrowing for non-SDK runtimes (Ollama today): small
  // tool-capable models get confused when handed 18 MCP tools at once —
  // seen live with qwen3.5:4b hallucinating a tool name in #73. Narrowing
  // specialists to just send_message + set_agent_status gives an
  // unambiguous signal. Claude specialists are unchanged at the role
  // layer because the SDK handles wide tool sets reliably and existing
  // workflows depend on them — but they can still be narrowed explicitly
  // via `agent.tools`.
  let allowedTools: string[] | undefined;
  if (agent?.tools !== undefined) {
    // Explicit override — honour exactly, including empty array ("no tools").
    allowedTools = [...agent.tools];
  } else if (isSpecialist && agent) {
    const profile = getCapabilityProfile(agent.runtime);
    const isNonSdkRuntime = agent.runtime?.provider === 'ollama';
    if (isNonSdkRuntime && profile.receivesMcpTools) {
      allowedTools = [...NON_SDK_SPECIALIST_ALLOWED_TOOLS];
    }
  }

  if (
    maxTurns === undefined &&
    disallowed.size === 0 &&
    allowedTools === undefined
  ) {
    return undefined;
  }

  return {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(disallowed.size > 0 ? { disallowedTools: [...disallowed] } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };
}
