import { html } from 'htm/preact';
import { selectedGroup } from '../app.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';

export function ChatView() {
  const group = selectedGroup.value;

  return html`
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-3 px-5 py-3 border-b border-border bg-bg-2">
        <h2 class="text-sm font-semibold">${group?.name || ''}</h2>
      </div>
      <${MessageList} />
      <${ChatInput} />
    </div>
  `;
}
