import { getQuotedContextWindow } from './db.js';
import { renderQuotedContextText, renderQuotedContextXml } from './router.js';
import { NewMessage } from './types.js';

// #140 quote-reply tuning. ±2 default window, hard-capped at ±5 each side
// AND a 4000-char total budget on the rendered block. Both caps land in
// renderQuotedContext{Xml,Text} via the maxChars argument.
const QUOTE_WINDOW_BEFORE = 2;
const QUOTE_WINDOW_AFTER = 2;
const QUOTE_MAX_CHARS = 4000;

/**
 * For each message carrying a reply_to_message_id, resolve the quoted
 * window from the database and attach pre-rendered XML and text variants
 * in place. No-op when no replying messages are present.
 *
 * Both representations share the same shrink-to-budget logic so the
 * structured-message path (Ollama) and XML prompt path see equivalent
 * context.
 */
export function attachQuotedContext(
  messages: NewMessage[],
  chatJid: string,
  timezone: string,
): void {
  for (const m of messages) {
    if (!m.reply_to_message_id) continue;
    const window = getQuotedContextWindow(
      chatJid,
      m.reply_to_message_id,
      QUOTE_WINDOW_BEFORE,
      QUOTE_WINDOW_AFTER,
    );
    if (window.length === 0) continue;
    m.quoted_context_xml = renderQuotedContextXml(
      window,
      m.reply_to_message_id,
      timezone,
      QUOTE_MAX_CHARS,
    );
    m.quoted_context_text = renderQuotedContextText(
      window,
      m.reply_to_message_id,
      timezone,
      QUOTE_MAX_CHARS,
    );
  }
}
