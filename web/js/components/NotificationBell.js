import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import {
  notifications,
  notifLastReadAt,
  unreadNotifCount,
  navigateToMessage,
  markAllNotificationsRead,
} from '../app.js';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRelative(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const count = unreadNotifCount.value;
  const entries = notifications.value;
  const lastRead = notifLastReadAt.value;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  function handleEntryClick(entry) {
    setOpen(false);
    navigateToMessage(entry.jid, entry.id);
  }

  return html`
    <div ref=${wrapperRef} class="relative">
      <button
        class="relative w-8 h-8 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors"
        title="Notifications"
        onClick=${() => setOpen((v) => !v)}
      >
        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z"/>
        </svg>
        ${count > 0 && html`
          <span class="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-accent text-bg text-[10px] font-semibold px-1">
            ${count > 99 ? '99+' : count}
          </span>
        `}
      </button>

      ${open && html`
        <div class="absolute right-0 top-full mt-1 z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-bg-2 shadow-xl overflow-hidden">
          <div class="flex items-center justify-between px-3 py-2 border-b border-border">
            <span class="text-xs font-semibold text-txt">Notifications</span>
            ${count > 0 && html`
              <button
                class="text-[11px] text-txt-muted hover:text-txt transition-colors"
                onClick=${() => markAllNotificationsRead()}
              >Mark all read</button>
            `}
          </div>
          ${entries.length === 0
            ? html`
              <div class="px-3 py-6 text-center text-xs text-txt-muted">
                No activity yet.
              </div>
            `
            : html`
              <div class="max-h-[min(70vh,28rem)] overflow-y-auto">
                ${entries.map((n) => {
                  const isUnread = !lastRead[n.jid] || n.timestamp > lastRead[n.jid];
                  return html`
                    <button
                      key=${n.id}
                      class="w-full text-left px-3 py-2 border-b border-border/60 last:border-b-0 hover:bg-bg-hover transition-colors flex gap-2"
                      onClick=${() => handleEntryClick(n)}
                    >
                      <span
                        class="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${isUnread ? 'bg-accent' : 'bg-transparent'}"
                        aria-hidden="true"
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 text-xs">
                          <span class="font-semibold text-txt truncate">${esc(n.senderName || 'Agent')}</span>
                          <span class="text-txt-muted truncate">${esc(n.groupName)}</span>
                          <span class="text-txt-muted ml-auto shrink-0">${formatRelative(n.timestamp)}</span>
                        </div>
                        <div class="text-[11px] text-txt-2 line-clamp-2 mt-0.5 break-words">${esc(n.preview)}</div>
                      </div>
                    </button>
                  `;
                })}
              </div>
            `}
        </div>
      `}
    </div>
  `;
}
