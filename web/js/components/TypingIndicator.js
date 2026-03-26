import { html } from 'htm/preact';

export function TypingIndicator() {
  return html`
    <div class="self-start flex items-center gap-2 bg-asstbg border border-border rounded-2xl rounded-bl-sm px-4 py-3">
      <span class="text-xs text-txt-muted mr-1">Thinking</span>
      <span class="typing-dot" />
      <span class="typing-dot" />
      <span class="typing-dot" />
    </div>
  `;
}
