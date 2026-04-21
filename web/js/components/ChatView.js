import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { selectedGroup, selectedJid, clearChat, messages } from '../app.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { WorkStatusBanner } from './WorkStatusBanner.js';
import { ContextPressureBanner } from './ContextPressureBanner.js';
import { NotificationBell } from './NotificationBell.js';

export function ChatView({ onOpenSidebar }) {
  const group = selectedGroup.value;
  const hasMessages = messages.value.length > 0;
  const [clearOpen, setClearOpen] = useState(false);

  function handleClearConfirm() {
    clearChat(selectedJid.value);
    setClearOpen(false);
  }

  return html`
    <div class="flex flex-col h-full">
      <div class="flex items-center justify-between gap-3 px-3 md:px-5 py-3 border-b border-border bg-bg-2">
        <div class="flex items-center gap-3">
          <button
            class="w-8 h-8 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors md:hidden"
            title="Open sidebar"
            onClick=${onOpenSidebar}
          >
            <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/>
            </svg>
          </button>
          <h2 class="text-sm font-semibold">${group?.name || ''}</h2>
        </div>
        <div class="flex items-center gap-2">
          ${hasMessages && html`
            <button
              class="text-xs text-txt-muted hover:text-err transition-colors"
              onClick=${() => setClearOpen(true)}
            >Clear chat</button>
          `}
          <${NotificationBell} />
        </div>
      </div>
      <${WorkStatusBanner} />
      <${ContextPressureBanner} />
      <${MessageList} />
      <${ChatInput} />
    </div>

    <${ConfirmDialog}
      open=${clearOpen}
      title="Clear chat?"
      message="This removes all messages in this conversation. This cannot be undone."
      confirmLabel="Clear"
      destructive=${true}
      onConfirm=${handleClearConfirm}
      onCancel=${() => setClearOpen(false)}
    />
  `;
}
