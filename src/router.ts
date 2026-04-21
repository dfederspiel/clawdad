import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { parseTextStyles, ChannelType } from './text-styles.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Structured form of a conversation message — passed to runtime adapters
 * alongside the legacy XML prompt (#46). Gives non-Claude runtimes a
 * direct (role, content) feed instead of reverse-engineering XML.
 *
 * Role is authoritative from `NewMessage.is_bot_message`, not heuristic
 * name matching. Sender and timestamp are carried for display/debug use
 * but aren't required by any current runtime.
 */
export interface StructuredMessage {
  role: 'user' | 'assistant';
  content: string;
  sender: string;
  timestamp: string;
}

export function toStructuredMessages(
  messages: NewMessage[],
): StructuredMessage[] {
  return messages.map((m) => ({
    role: m.is_bot_message ? 'assistant' : 'user',
    content: m.content,
    sender: m.sender_name,
    timestamp: m.timestamp,
  }));
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return channel ? parseTextStyles(text, channel) : text;
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  await channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
