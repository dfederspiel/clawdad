import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { Message } from './Message.js';
import { TypingIndicator } from './TypingIndicator.js';

export function ThreadView({ threadId, agentName, messages, replyCount: metaReplyCount, isExpanded, isTyping, onToggle, onReply }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Use loaded messages count when expanded, threadMeta reply_count when collapsed
  const replyCount = isExpanded ? (messages?.length || 0) : (metaReplyCount || 0);

  // Auto-scroll thread on new messages
  useEffect(() => {
    if (isExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isExpanded, replyCount, isTyping]);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    const val = text;
    setText('');
    await onReply(threadId, val);
    setSending(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Collapsed indicator
  if (!isExpanded) {
    // Show status: typing → "thinking...", 0 replies → "initializing...", else reply count
    let statusText;
    if (isTyping) {
      statusText = html`<span class="animate-pulse">thinking\u2026</span>`;
    } else if (replyCount === 0) {
      statusText = html`<span class="animate-pulse text-txt-muted">initializing agent\u2026</span>`;
    } else {
      statusText = html`<span>${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>`;
    }

    return html`
      <button
        class="ml-6 mt-1 flex items-center gap-2 text-xs text-accent hover:text-accent/80 transition-colors cursor-pointer"
        onClick=${() => onToggle(threadId)}
      >
        <span class="opacity-60">|</span>
        ${statusText}
        ${agentName && html`<span class="text-txt-muted">\u00B7 ${agentName}</span>`}
        <span class="text-txt-muted">\u25BC</span>
      </button>
    `;
  }

  // Expanded thread
  return html`
    <div class="ml-6 mt-1 border-l-2 border-accent/40 pl-3">
      <button
        class="flex items-center gap-2 text-xs text-accent hover:text-accent/80 transition-colors cursor-pointer mb-2"
        onClick=${() => onToggle(threadId)}
      >
        <span>${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
        ${agentName && html`<span class="text-txt-muted">\u00B7 ${agentName}</span>`}
        <span class="text-txt-muted">\u25B2</span>
      </button>

      <div ref=${scrollRef} class="flex flex-col gap-2 max-h-80 overflow-y-auto">
        ${messages.map((m, i) => html`
          <${Message}
            key=${i}
            role=${m.role}
            content=${m.content}
            timestamp=${m.timestamp}
            senderName=${m.senderName}
            compact=${true}
          />
        `)}
        ${isTyping && html`<${TypingIndicator} />`}
      </div>

      <div class="flex gap-2 mt-2 items-end">
        <textarea
          ref=${inputRef}
          class="flex-1 bg-bg-3 border border-border rounded-lg px-2 py-1.5 text-xs text-txt resize-none focus:outline-none focus:border-accent placeholder-txt-muted font-sans"
          placeholder="Reply in thread..."
          rows="1"
          value=${text}
          onInput=${(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
          }}
          onKeyDown=${onKeyDown}
        />
        <button
          class="px-3 py-1.5 bg-accent text-bg font-semibold rounded-lg text-xs hover:brightness-110 disabled:opacity-40 transition-all"
          onClick=${handleSend}
          disabled=${!text.trim() || sending}
        >
          \u21B5
        </button>
      </div>
    </div>
  `;
}
