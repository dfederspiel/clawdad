/**
 * Agent Discovery
 *
 * Scans group folders for agent subdirectories.
 * If a group has no agents/ dir, synthesizes an implicit "default" agent.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { Agent, ContainerConfig, RegisteredGroup } from './types.js';

export const DEFAULT_AGENT_NAME = 'default';

/**
 * Discover agents for a group. Returns at least one agent (the implicit default).
 */
export function discoverAgents(group: RegisteredGroup): Agent[] {
  const groupDir = resolveGroupFolderPath(group.folder);
  const agentsDir = path.join(groupDir, 'agents');

  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    // No agents/ dir — implicit single agent using group's CLAUDE.md
    return [makeImplicitAgent(group)];
  }

  const agents: Agent[] = [];
  for (const entry of fs.readdirSync(agentsDir)) {
    const agentDir = path.join(agentsDir, entry);
    if (!fs.statSync(agentDir).isDirectory()) continue;

    // Must have a CLAUDE.md to be a valid agent
    const claudeMd = path.join(agentDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      logger.warn(
        { group: group.folder, agent: entry },
        'Agent directory missing CLAUDE.md, skipping',
      );
      continue;
    }

    const agent = loadAgentFromDir(group.folder, entry, agentDir);
    agents.push(agent);
  }

  if (agents.length === 0) {
    // agents/ dir exists but is empty or all invalid — fall back to implicit
    logger.warn(
      { group: group.folder },
      'agents/ dir exists but no valid agents found, using implicit default',
    );
    return [makeImplicitAgent(group)];
  }

  // Backward compatibility: if a legacy single-agent group gains its first
  // explicit specialist, keep the original group-level agent as the default
  // responder unless an explicit triggerless coordinator/default already exists.
  const hasExplicitDefault = agents.some(
    (agent) => agent.name === DEFAULT_AGENT_NAME,
  );
  const hasTriggerlessCoordinator = agents.some((agent) => !agent.trigger);
  if (!hasExplicitDefault && !hasTriggerlessCoordinator) {
    agents.unshift(makeImplicitAgent(group));
  }

  logger.info(
    {
      group: group.folder,
      agents: agents.map((a) => a.name),
    },
    'Discovered agents',
  );

  return agents;
}

function makeImplicitAgent(group: RegisteredGroup): Agent {
  return {
    id: `${group.folder}/${DEFAULT_AGENT_NAME}`,
    groupFolder: group.folder,
    name: DEFAULT_AGENT_NAME,
    displayName: group.name,
    // Implicit agent inherits group trigger — no agent-specific trigger
  };
}

function loadAgentFromDir(
  groupFolder: string,
  agentName: string,
  agentDir: string,
): Agent {
  const agent: Agent = {
    id: `${groupFolder}/${agentName}`,
    groupFolder,
    name: agentName,
    displayName: agentName,
  };

  // Load agent.json for overrides
  const configPath = path.join(agentDir, 'agent.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.displayName) agent.displayName = config.displayName;
      if (config.trigger) agent.trigger = config.trigger;
      if (config.status) agent.status = String(config.status);
      if (config.containerConfig)
        agent.containerConfig = config.containerConfig as ContainerConfig;
    } catch (err) {
      logger.warn(
        { group: groupFolder, agent: agentName, err },
        'Failed to parse agent.json',
      );
    }
  }

  return agent;
}

/**
 * Resolve the CLAUDE.md path for an agent.
 * - Explicit agents: groups/{folder}/agents/{name}/CLAUDE.md
 * - Implicit default: groups/{folder}/CLAUDE.md
 */
export function resolveAgentClaudeMdPath(agent: Agent): string {
  const groupDir = resolveGroupFolderPath(agent.groupFolder);

  if (agent.name === DEFAULT_AGENT_NAME) {
    const explicitPath = path.join(
      groupDir,
      'agents',
      DEFAULT_AGENT_NAME,
      'CLAUDE.md',
    );
    if (fs.existsSync(explicitPath)) return explicitPath;
    // Fall back to group-level CLAUDE.md for implicit default
    return path.join(groupDir, 'CLAUDE.md');
  }

  return path.join(groupDir, 'agents', agent.name, 'CLAUDE.md');
}

/**
 * Build a multi-agent context block that gets injected into prompts.
 * Tells the agent who it is, who else is in the group, and how handoffs work.
 */
export function buildMultiAgentContext(
  currentAgent: Agent,
  allAgents: Agent[],
): string {
  if (allAgents.length <= 1) return '';

  const others = allAgents.filter((a) => a.id !== currentAgent.id);
  const agentList = others
    .map((a) => `- ${a.trigger || a.name} (${a.displayName})`)
    .join('\n');

  const isCoordinator = !currentAgent.trigger;

  const lines = [
    `--- Multi-agent group context ---`,
    `You are "${currentAgent.displayName}" in a multi-agent group.`,
    `Other agents in this group:`,
    agentList,
    ``,
  ];

  if (isCoordinator) {
    lines.push(
      `You are the coordinator. You handle general questions directly and delegate specialist work.`,
      `For meaningful ongoing work, keep sidebar presence current: use mcp__nanoclaw__set_subtitle for the team-level summary, and use mcp__nanoclaw__set_agent_status for your own row if you have one.`,
      `Set concise, high-signal statuses when work starts ("Reviewing PRs", "Waiting on Scout") and clear them when the work is done.`,
      `To delegate, use the mcp__nanoclaw__delegate_to_agent tool:`,
      `  delegate_to_agent({ agent: "${others[0]?.name || 'agent'}", message: "Specific instructions..." })`,
      `The target agent runs after your turn and responds in the chat.`,
      `Be specific in your delegation message — tell the agent exactly what to do and what context it needs.`,
      `Artifacts should be written to /workspace/group/ so all agents can access them.`,
    );
  } else {
    lines.push(
      `You are a specialist. Focus on your role and respond directly.`,
      `For meaningful ongoing work, set your own sidebar status with mcp__nanoclaw__set_agent_status using a short phrase like "Reviewing flags" or "Drafting summary", then clear it when you are done.`,
      `If work falls outside your expertise, say so in your response — the coordinator will handle routing.`,
      `Do NOT try to act as other agents or delegate work yourself.`,
      `Write any artifacts to /workspace/group/ so other agents can access them.`,
    );
  }

  lines.push(`--- End multi-agent context ---`, ``);
  return lines.join('\n');
}

/**
 * Resolve the agent's directory path (for mounting).
 * - Explicit agents: groups/{folder}/agents/{name}/
 * - Implicit default: groups/{folder}/ (same as group dir)
 */
export function resolveAgentDir(agent: Agent): string | null {
  const groupDir = resolveGroupFolderPath(agent.groupFolder);

  if (agent.name === DEFAULT_AGENT_NAME) {
    const explicitDir = path.join(groupDir, 'agents', DEFAULT_AGENT_NAME);
    if (fs.existsSync(explicitDir)) return explicitDir;
    return null; // Implicit default — no separate agent dir
  }

  const agentDir = path.join(groupDir, 'agents', agent.name);
  return fs.existsSync(agentDir) ? agentDir : null;
}
