import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { AgentRuntimeConfig } from './runtime-types.js';
import { Agent } from './types.js';

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
