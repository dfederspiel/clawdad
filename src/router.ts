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
    content: m.quoted_context_text
      ? `${m.quoted_context_text}\n\n${m.content}`
      : m.content,
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
    const replyAttr = m.reply_to_message_id
      ? ` reply_to_id="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const quoted = m.quoted_context_xml
      ? `\n    <quoted_context>\n${m.quoted_context_xml}\n    </quoted_context>\n    `
      : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${quoted}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Render a quote-reply context window (anchor + surrounding messages) as
 * an XML fragment for inclusion inside a <quoted_context> element. The
 * window is shrunk symmetrically until it fits the character budget.
 * Pure formatter — does no DB I/O.
 */
export function renderQuotedContextXml(
  window: NewMessage[],
  anchorId: string,
  timezone: string,
  maxChars: number,
): string {
  let working = [...window];
  let rendered = '';
  while (working.length > 0) {
    rendered = working
      .map((m) => {
        const displayTime = formatLocalTime(m.timestamp, timezone);
        const role = m.is_bot_message ? 'assistant' : 'user';
        const isAnchor = m.id === anchorId ? ' anchor="true"' : '';
        return `      <message role="${role}" sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${isAnchor}>${escapeXml(m.content)}</message>`;
      })
      .join('\n');
    if (rendered.length <= maxChars) return rendered;
    // Drop the outermost surrounding message first (alternating ends), but
    // never drop the anchor itself.
    const anchorIdx = working.findIndex((m) => m.id === anchorId);
    const dropFromHead = anchorIdx > working.length - 1 - anchorIdx;
    if (dropFromHead && anchorIdx > 0) working = working.slice(1);
    else if (working.length - 1 > anchorIdx) working = working.slice(0, -1);
    else if (anchorIdx > 0) working = working.slice(1);
    else break;
  }
  return rendered;
}

/**
 * Plain-text variant of the quote-reply window for non-XML runtimes. Same
 * shrink-to-budget behavior; output is a bracketed preamble that reads
 * naturally when prepended to the replying message's content.
 */
export function renderQuotedContextText(
  window: NewMessage[],
  anchorId: string,
  timezone: string,
  maxChars: number,
): string {
  let working = [...window];
  let rendered = '';
  while (working.length > 0) {
    const lines = working.map((m) => {
      const displayTime = formatLocalTime(m.timestamp, timezone);
      const marker = m.id === anchorId ? '> ' : '  ';
      return `${marker}[${displayTime}] ${m.sender_name}: ${m.content}`;
    });
    rendered = `[Replying to an earlier message — surrounding context:]\n${lines.join('\n')}\n[End of quoted context]`;
    if (rendered.length <= maxChars) return rendered;
    const anchorIdx = working.findIndex((m) => m.id === anchorId);
    const dropFromHead = anchorIdx > working.length - 1 - anchorIdx;
    if (dropFromHead && anchorIdx > 0) working = working.slice(1);
    else if (working.length - 1 > anchorIdx) working = working.slice(0, -1);
    else if (anchorIdx > 0) working = working.slice(1);
    else break;
  }
  return rendered;
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
