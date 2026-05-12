import { getMessageById, getPinsForChat } from './db.js';

// Per-pin snippet length cap. Just enough so the agent can recognize
// which surface a pin refers to without ballooning the prompt.
const PIN_SNIPPET_MAX_CHARS = 280;

/**
 * #142 — Render the "Pinned surfaces" prompt block for a chat. Returns
 * an empty string when no pins exist so callers can unconditionally
 * concatenate the result. Each line carries the message_id, optional
 * block_id, optional title, and a short snippet of the source content
 * so the agent can match the pin to context it has already seen.
 *
 * Soft contract: the agent is told that pinned surfaces should prefer
 * update_block over emitting a duplicate message, but nothing enforces
 * it. The fallback (a fresh redundant message) matches today's behavior.
 */
export function renderPinnedSurfaces(chatJid: string): string {
  const pins = getPinsForChat(chatJid);
  if (pins.length === 0) return '';
  const lines: string[] = [];
  for (const pin of pins) {
    const msg = getMessageById(pin.pin_message_id, chatJid);
    const snippet = msg
      ? (msg.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, PIN_SNIPPET_MAX_CHARS)
      : '(source message no longer exists)';
    const target = pin.pin_block_id
      ? `block "${pin.pin_block_id}" on message ${pin.pin_message_id}`
      : `message ${pin.pin_message_id}`;
    const titlePart = pin.title ? ` — "${pin.title}"` : '';
    lines.push(`- ${target}${titlePart}: ${snippet}`);
  }
  return [
    '## Pinned surfaces',
    'The user has pinned the following surfaces in a side panel. They stay visible throughout the conversation. When you have new information relevant to a pinned surface, prefer calling update_block (on a block) over emitting a duplicate message.',
    '',
    ...lines,
  ].join('\n');
}
