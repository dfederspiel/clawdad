/**
 * Shared agent state — tracks which agent is actively responding per chat JID.
 * Used by channels to set the correct sender name on bot messages.
 */

const activeAgentNames = new Map<string, string>();

export function setActiveAgentName(chatJid: string, name: string): void {
  activeAgentNames.set(chatJid, name);
}

export function clearActiveAgentName(chatJid: string): void {
  activeAgentNames.delete(chatJid);
}

export function getActiveAgentName(chatJid: string): string | undefined {
  return activeAgentNames.get(chatJid);
}
