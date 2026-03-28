import { html } from 'htm/preact';
import { selectedGroup, selectedJid, clearChat, messages } from '../app.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';

export function ChatView() {
  const group = selectedGroup.value;
  const hasMessages = messages.value.length > 0;

  function handleClear() {
    if (confirm('Clear all messages in this chat?')) {
      clearChat(selectedJid.value);
    }
  }

  return html`
    <div class="flex flex-col h-full">
      <div class="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-2">
        <h2 class="text-sm font-semibold">${group?.name || ''}</h2>
        ${hasMessages && html`
          <button
            class="text-xs text-txt-muted hover:text-err transition-colors"
            onClick=${handleClear}
          >Clear chat</button>
        `}
      </div>
      <${MessageList} />
      <${ChatInput} />
    </div>
  `;
}
