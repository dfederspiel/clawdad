import { Agent, NewMessage } from './types.js';
import { buildAgentTriggerPattern } from './config.js';

function isAgentOrSystemAuthoredMessage(
  message: NewMessage,
  agents: Agent[],
): boolean {
  if (message.sender_name === 'System') return true;
  if (message.is_bot_message) return true;
  return agents.some((agent) => agent.displayName === message.sender_name);
}

export function getTriggeredAgentsForMessages(
  agents: Agent[],
  messages: NewMessage[],
  options?: { coordinatorOnly?: boolean },
): Agent[] {
  if (agents.length === 0) return [];

  if (options?.coordinatorOnly) {
    const coordinator = agents.find((agent) => !agent.trigger) || agents[0];
    return coordinator ? [coordinator] : [];
  }

  const triggerableMessages = messages.filter(
    (message) => !isAgentOrSystemAuthoredMessage(message, agents),
  );

  return agents.filter((agent) => {
    if (!agent.trigger) return true;
    const agentTrigger = buildAgentTriggerPattern(agent.trigger);
    return triggerableMessages.some((m) => agentTrigger.test(m.content.trim()));
  });
}
