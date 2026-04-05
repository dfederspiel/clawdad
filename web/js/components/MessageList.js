import { html } from 'htm/preact';
import { useRef, useEffect } from 'preact/hooks';
import {
  messages,
  typing,
  threadMeta,
  openThreads,
  threadTyping,
  toggleThread,
  handleThreadReply,
  pendingInput,
  currentWorkState,
  agentProgress,
  selectedJid,
} from '../app.js';
import { Message } from './Message.js';
import { ThreadView } from './ThreadView.js';
import { TypingIndicator } from './TypingIndicator.js';

export function MessageList() {
  const containerRef = useRef(null);
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

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [msgs.length, isTyping, showActivity]);

  function onClickMention(e) {
    const mention = e.target.closest('.mention');
    if (mention) {
      const trigger = mention.dataset.trigger;
      if (trigger) pendingInput.value = trigger;
    }
  }

  return html`
    <div ref=${containerRef} class="flex-1 overflow-y-auto p-3 md:p-5 flex flex-col gap-3" onClick=${onClickMention}>
      ${msgs.length === 0 && !showActivity
        ? html`
            <div class="flex-1 flex items-center justify-center">
              <p class="text-txt-muted text-sm">No messages yet. Start the conversation below.</p>
            </div>
          `
        : msgs.filter((m) => m.senderName !== 'System').map(
            (m, i) => {
              const thread = m.id ? threads[m.id] : null;
              return html`
                <div key=${i} data-role=${m.role}>
                  <${Message}
                    role=${m.role}
                    content=${m.content}
                    timestamp=${m.timestamp}
                    senderName=${m.senderName}
                    isError=${m.isError}
                    usage=${m.usage}
                    toolHistory=${m.toolHistory}
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
            },
          )}
      ${showActivity && html`<${TypingIndicator} />`}
    </div>
  `;
}
