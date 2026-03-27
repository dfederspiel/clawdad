import { html } from 'htm/preact';
import { useRef, useEffect } from 'preact/hooks';
import { messages, typing } from '../app.js';
import { Message } from './Message.js';
import { TypingIndicator } from './TypingIndicator.js';

export function MessageList() {
  const containerRef = useRef(null);
  const msgs = messages.value;
  const isTyping = typing.value;

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [msgs.length, isTyping]);

  return html`
    <div ref=${containerRef} class="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
      ${msgs.length === 0 && !isTyping
        ? html`
            <div class="flex-1 flex items-center justify-center">
              <p class="text-txt-muted text-sm">No messages yet. Start the conversation below.</p>
            </div>
          `
        : msgs.map(
            (m, i) => html`
              <${Message}
                key=${i}
                role=${m.role}
                content=${m.content}
                timestamp=${m.timestamp}
                senderName=${m.senderName}
                isError=${m.isError}
              />
            `,
          )}
      ${isTyping && html`<${TypingIndicator} />`}
    </div>
  `;
}
