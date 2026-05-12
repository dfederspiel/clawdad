import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { selectedGroup, selectedJid, clearChat, messages, pins } from '../app.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { WorkStatusBanner } from './WorkStatusBanner.js';
import { ContextPressureBanner } from './ContextPressureBanner.js';
import { NotificationBell } from './NotificationBell.js';
import { openPinsInDrawer } from './AgentPanel.js';

// #142 follow-up — Lucide "pin" icon for the reopen pill.
const PinIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;

export function ChatView({ onOpenSidebar }) {
  const group = selectedGroup.value;
  const hasMessages = messages.value.length > 0;
  const [clearOpen, setClearOpen] = useState(false);
  const pinCount = Object.values(pins.value).filter(
    (p) => p.jid === selectedJid.value,
  ).length;

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
          ${pinCount > 0 && html`
            <button
              class="flex items-center gap-1 text-xs px-2 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
              onClick=${openPinsInDrawer}
              title="Open pinned surfaces (${pinCount})"
            >
              ${PinIcon}
              <span>${pinCount}</span>
            </button>
          `}
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
