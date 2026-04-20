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
import { getCapabilityProfile } from './model-capabilities.js';
import { AgentRuntimeConfig } from './runtime-types.js';
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
      if (config.runtime) agent.runtime = config.runtime as AgentRuntimeConfig;
      if (Array.isArray(config.tools)) {
        agent.tools = config.tools.filter(
          (t: unknown): t is string => typeof t === 'string',
        );
      }
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
 *
 * Branches on the agent's capability profile: tool-capable runtimes
 * (Claude) get the full MCP-based protocol; tool-less runtimes (Ollama
 * today) get a text-only variant that describes the implicit protocol
 * the host actually uses (final text → delivered as user message).
 * Telling a tool-less agent about MCP tools is misinformation — it wastes
 * tokens and produces narration-of-tool-calls instead of real responses.
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
  const profile = getCapabilityProfile(currentAgent.runtime);

  const lines = [
    `--- Multi-agent group context ---`,
    `You are "${currentAgent.displayName}" in a multi-agent group.`,
    `Other agents in this group:`,
    agentList,
    ``,
  ];

  if (isCoordinator) {
    if (profile.receivesMcpTools) {
      // Only specialists (agents with a trigger) are valid delegation targets.
      // Enumerate every specialist with a concrete example so the model pattern-
      // matches against the full topology rather than extrapolating from one.
      const specialists = others.filter((a) => !!a.trigger);
      const delegationExamples =
        specialists.length > 0
          ? specialists
              .map(
                (a) =>
                  `  delegate_to_agent({ agent: "${a.name}", message: "Specific instructions for ${a.displayName}...", completion_policy: "final_response" })`,
              )
              .join('\n')
          : `  delegate_to_agent({ agent: "agent-name", message: "Specific instructions...", completion_policy: "final_response" })`;

      lines.push(
        `You are the coordinator. You handle general questions directly and delegate specialist work.`,
        `For meaningful ongoing work, keep sidebar presence current: use mcp__nanoclaw__set_subtitle for the team-level summary, and use mcp__nanoclaw__set_agent_status for your own row if you have one.`,
        `Set concise, high-signal statuses when work starts ("Reviewing PRs", "Waiting on Scout") and clear them when the work is done.`,
        `To delegate, use the mcp__nanoclaw__delegate_to_agent tool. Valid targets and example invocations:`,
        delegationExamples,
        `Use completion_policy: "final_response" by default. Only use "retrigger_coordinator" when you specifically need a follow-up turn to combine or interpret specialist results.`,
        `The target agent runs after your turn. Their user-visible output may be suppressed if newer context arrives before it is delivered.`,
        `Even when a specialist's user-visible output is suppressed, the system records that completion for you in the conversation so you can decide whether to reuse it, summarize it, or move on.`,
        `Avoid over-narrating future delegation steps to the user. If the conversation changes direction, treat older delegated work as possibly superseded and respond to the newest context.`,
        `Be specific in your delegation message — tell the agent exactly what to do and what context it needs.`,
        `Artifacts should be written under a dedicated subdirectory of /workspace/group/ (for example /workspace/group/artifacts/ or /workspace/group/uploads/) so all agents can access them without cluttering the group root.`,
        `If browser automation or visual review matters, prefer surfacing a screenshot with mcp__nanoclaw__publish_browser_snapshot or mcp__nanoclaw__publish_media instead of only describing the page in text.`,
        `If the user explicitly asks to see the page or asks "what do you see?", treat that as a strong cue to publish a browser snapshot.`,
        `If delegated browser work hits a blocker like a login wall, captcha, modal trap, missing control, or broken layout, publish one screenshot with a short caption before asking for guidance.`,
        ``,
        `Silent chaining: when a specialist just finished and you are simply passing the baton to the next one in a sequence, delegate without a visible message. Only respond visibly when synthesizing results, making a decision, or all specialists in the current batch have reported back. Do not narrate each handoff.`,
        ``,
        // Self-check sits at the bottom of the context block so it lands closest
        // to the user turn boundary — the highest-attention position in a
        // system-prompt-appended context. See #65.
        `Before you finalize your response: if any part of your reply describes handing work off ("I'll ask X to look at this", "Let me delegate to X"), confirm you actually invoked mcp__nanoclaw__delegate_to_agent for that handoff. Describing a delegation in prose is narration — it does not run the tool. If you meant to delegate, invoke the tool now.`,
      );
    } else {
      // Tool-less coordinator: can't actually delegate. Be honest about the
      // limitation so the model doesn't produce narration-of-delegation.
      lines.push(
        `You are the coordinator. Your runtime does not have tool-calling access, so you cannot delegate work programmatically — answer directly from your own knowledge.`,
        `If a question is clearly within another agent's specialty, say so in your response; the user can re-route by @-mentioning that agent explicitly.`,
        `Respond in plain text. Whatever you write will be delivered to the user as your message.`,
      );
    }
  } else {
    // Specialist.
    if (profile.receivesMcpTools) {
      lines.push(
        `You are a specialist. Focus on your role and respond directly.`,
        `For meaningful ongoing work, set your own sidebar status with mcp__nanoclaw__set_agent_status using a short phrase like "Reviewing flags" or "Drafting summary", then clear it when you are done.`,
        `If work falls outside your expertise, say so in your response — the coordinator will handle routing.`,
        `Your response may be superseded for user delivery if newer context arrives first. Complete the assigned work cleanly anyway; the coordinator will still see that you finished.`,
        `Do NOT try to act as other agents or delegate work yourself.`,
        `Write any artifacts under a dedicated subdirectory of /workspace/group/ (for example /workspace/group/artifacts/ or /workspace/group/uploads/) so other agents can access them without cluttering the group root.`,
        `If visual context would help the user, publish a screenshot or image rather than only describing it in text.`,
        `If the user explicitly asks to see the page or asks "what do you see?", prefer publishing a browser snapshot.`,
        `If browser work hits a blocker like a login wall, captcha, modal trap, missing control, or broken layout, publish one screenshot with a short caption before asking for help.`,
      );
    } else {
      // Tool-less specialist: the whole reply text becomes the user-visible
      // message via the host's text-path fallback. No MCP tools, no status.
      lines.push(
        `You are a specialist. Focus on your role and respond directly.`,
        `Respond in plain text — your entire reply will be delivered to the user as your message. You do not have tools or status controls, so keep the response self-contained.`,
        `If a request falls outside your expertise, say so briefly; the coordinator will handle routing.`,
        `Do not try to act as other agents or delegate work yourself.`,
      );
    }
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
