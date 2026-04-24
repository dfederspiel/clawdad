import { html } from 'htm/preact';
import { useRef, useLayoutEffect, useCallback, useState } from 'preact/hooks';
import {
  messages,
  typing,
  threadMeta,
  openThreads,
  threadTyping,
  toggleThread,
  handleThreadReply,
  currentWorkState,
  agentProgress,
  selectedJid,
  flashMessageId,
  portalThreads,
} from '../app.js';
import { Message } from './Message.js';
import { ThreadView } from './ThreadView.js';
import { TypingIndicator } from './TypingIndicator.js';
import { PortalPill } from './PortalPill.js';

const SCROLL_THRESHOLD = 80;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
}

export function MessageList() {
  const containerRef = useRef(null);
  const stickToBottom = useRef(true);
  const [unread, setUnread] = useState(0);
  const msgs = messages.value;
  const isTyping = typing.value;
  const jid = selectedJid.value;
  const work = currentWorkState.value;
  const progress = jid ? agentProgress.value[jid] : null;
  const showActivity =
    isTyping ||
    (!!work &&
      !['idle', 'completed'].includes(work.phase) &&
      !!progress?.history?.length);
  const threads = threadMeta.value;
  const expanded = openThreads.value;
  const tTyping = threadTyping.value;

  const onScroll = useCallback(() => {
    if (!containerRef.current) return;
    const atBottom = isNearBottom(containerRef.current);
    stickToBottom.current = atBottom;
    if (atBottom) setUnread(0);
  }, []);

  // Reset to bottom when switching chats
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setUnread(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [jid]);

  // Auto-scroll on any layout change (new message, typing indicator, activity).
  // Uses useLayoutEffect so the scroll happens synchronously before paint —
  // avoiding the visible "pop" of seeing the new message before the scroll catches up.
  // Only the message-count change can produce unread; typing/activity flips never do.
  const prevMsgCount = useRef(msgs.length);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const newMsgArrived = msgs.length > prevMsgCount.current;
    prevMsgCount.current = msgs.length;
    if (stickToBottom.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    } else if (newMsgArrived) {
      setUnread((n) => n + 1);
    }
  }, [msgs.length, isTyping, showActivity]);

  function scrollToBottom() {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    stickToBottom.current = true;
    setUnread(0);
  }

  // Interleave portal pills with regular messages by timestamp. Pills are
  // rendered as pseudo-entries; each one is scoped to the current chat.
  const portals = portalThreads.value;
  const portalEntries = Object.entries(portals)
    .filter(([, p]) => p.jid === jid)
    .map(([threadId, p]) => ({
      kind: 'portal',
      threadId,
      timestamp: p.createdAt || new Date(p.openedAt).toISOString(),
    }));
  const visibleMsgs = msgs
    .filter((m) => m.senderName !== 'System')
    .map((m) => ({ kind: 'message', msg: m, timestamp: m.timestamp }));
  const timeline = [...visibleMsgs, ...portalEntries].sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return ta - tb;
  });

  return html`
    <div class="flex-1 relative flex flex-col min-h-0">
    <div ref=${containerRef} onScroll=${onScroll} class="flex-1 overflow-y-auto p-3 md:p-5 flex flex-col gap-3">
      ${timeline.length === 0 && !showActivity
        ? html`
            <div class="flex-1 flex items-center justify-center">
              <p class="text-txt-muted text-sm">No messages yet. Start the conversation below.</p>
            </div>
          `
        : timeline.map((entry, i) => {
            if (entry.kind === 'portal') {
              return html`<${PortalPill} key=${`portal-${entry.threadId}`} threadId=${entry.threadId} />`;
            }
            const m = entry.msg;
            const thread = m.id ? threads[m.id] : null;
            const flashing = m.id && flashMessageId.value === m.id;
            return html`
              <div
                key=${m.id || i}
                data-role=${m.role}
                id=${m.id ? `msg-${m.id}` : undefined}
                class=${flashing ? 'notif-flash' : ''}
              >
                <${Message}
                  role=${m.role}
                  content=${m.content}
                  timestamp=${m.timestamp}
                  senderName=${m.senderName}
                  isError=${m.isError}
                  usage=${m.usage}
                  toolHistory=${m.toolHistory}
                  runId=${m.runId}
                />
                ${thread && html`
                  <${ThreadView}
                    threadId=${m.id}
                    agentName=${thread.agent_name}
                    messages=${expanded[m.id] || []}
                    replyCount=${thread.reply_count || 0}
                    isExpanded=${!!expanded[m.id]}
                    isTyping=${!!tTyping[m.id]}
                    onToggle=${toggleThread}
                    onReply=${handleThreadReply}
                  />
                `}
              </div>
            `;
          })}
      ${showActivity && html`<${TypingIndicator} />`}
    </div>
    ${unread > 0 && html`
      <button
        onClick=${scrollToBottom}
        class="absolute left-1/2 -translate-x-1/2 bottom-3 px-3 py-1.5 text-xs font-semibold rounded-full shadow-lg transition-all hover:brightness-110 cursor-pointer"
        style="background: var(--accent); color: var(--bg);"
      >
        \u2193 ${unread} new ${unread === 1 ? 'message' : 'messages'}
      </button>
    `}
    </div>
  `;
}
