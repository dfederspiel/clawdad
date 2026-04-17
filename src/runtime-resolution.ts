import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { AgentRuntimeConfig, RuntimeTurnConstraints } from './runtime-types.js';
import { Agent, ContainerConfig, RegisteredGroup } from './types.js';

const SPECIALIST_AUTO_BLOCKED_TOOL = 'mcp__nanoclaw__delegate_to_agent';

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
  if (agent?.trigger) {
    disallowed.add(SPECIALIST_AUTO_BLOCKED_TOOL);
  }

  if (maxTurns === undefined && disallowed.size === 0) return undefined;

  return {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(disallowed.size > 0 ? { disallowedTools: [...disallowed] } : {}),
  };
}
