import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { messages, selectedGroup, setReplyTo } from '../app.js';
import { openAgentPanel } from './AgentPanel.js';
import { MessageBody } from './MessageBody.js';

// #140 — find a message by id in the current chat so the reply header can
// render the quoted preview and the click-to-scroll anchor is real.
function lookupMessage(id) {
  if (!id) return null;
  return messages.value.find((m) => m.id === id) || null;
}

function scrollToMessage(id) {
  if (!id) return;
  const el = document.getElementById(`msg-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('notif-flash');
  setTimeout(() => el.classList.remove('notif-flash'), 1500);
}

function ReplyToHeader({ replyToMessageId }) {
  const target = lookupMessage(replyToMessageId);
  if (!target) {
    return html`
      <div class="text-[11px] text-txt-muted mb-1 italic opacity-60">
        ↳ replying to an earlier message
      </div>
    `;
  }
  const snippet = (target.content || '').slice(0, 100);
  return html`
    <div
      class="text-[11px] text-txt-muted mb-1.5 px-2 py-1 border-l-2 border-accent/60 bg-bg-3/40 rounded-r cursor-pointer hover:bg-bg-3/80 transition-colors truncate"
      title="Jump to original message"
      onClick=${(e) => { e.stopPropagation(); scrollToMessage(replyToMessageId); }}
    >
      <span class="opacity-70">↳ ${target.senderName || 'unknown'}:</span>
      <span class="ml-1 opacity-90">${snippet}</span>
    </div>
  `;
}

// Time-only is ambiguous in long threads spanning multiple days. Lead with the
// day name + date so consecutive messages are unambiguous; collapse to
// "Today" / "Yesterday" for the common case.
export function formatMessageTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;
  if (isYesterday) return `Yesterday · ${time}`;
  const datePart = d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return `${datePart} · ${time}`;
}

// Consistent color for each agent name (hash → HSL hue)
const AGENT_COLORS = {};
function agentColor(name) {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  AGENT_COLORS[name] = `hsl(${hue}, 60%, 65%)`;
  return AGENT_COLORS[name];
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatCost(usd) {
  if (!usd) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function renderToolLabel(tool) {
  if (tool === 'media') {
    return 'image';
  }
  return tool || '>';
}

function UsageFooter({ usage, toolHistory, expanded, onToggle, runId, groupFolder }) {
  if (!usage || (!usage.numTurns && !usage.durationMs)) return null;

  const parts = [];
  if (usage.durationMs) parts.push(formatDuration(usage.durationMs));
  if (usage.numTurns) parts.push(`${usage.numTurns} turn${usage.numTurns !== 1 ? 's' : ''}`);
  const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (totalTokens) parts.push(`${formatTokens(totalTokens)} tokens`);
  if (usage.costUsd) parts.push(formatCost(usage.costUsd));

  const hasHistory = toolHistory && toolHistory.length > 0;
  const canViewConversation = runId != null && groupFolder;

  return html`
    <div class="mt-1">
      <div class="flex items-center gap-2 flex-wrap">
        <div
          class="flex items-center gap-1.5 text-[10px] text-txt-muted font-mono ${hasHistory ? 'cursor-pointer hover:text-txt-2' : ''}"
          onClick=${hasHistory ? onToggle : undefined}
        >
          ${hasHistory && html`
            <span class="text-[9px] transition-transform ${expanded ? 'rotate-90' : ''}">\u25B6</span>
          `}
          ${parts.map((p, i) => html`
            ${i > 0 && html`<span class="opacity-40">\u00B7</span>`}
            <span>${p}</span>
          `)}
        </div>
        ${canViewConversation && html`
          <button
            class="text-[10px] text-txt-muted hover:text-accent transition-colors font-mono cursor-pointer"
            onClick=${(e) => { e.stopPropagation(); openAgentPanel(runId, groupFolder); }}
            title="Open the agent's full tool call chain in a side panel"
          >
            view conversation \u2192
          </button>
        `}
      </div>
      ${expanded && hasHistory && html`
        <div class="mt-1.5 pl-3 border-l-2 border-border flex flex-col gap-0.5">
          ${toolHistory.map((t) => html`
            <div class="flex items-center gap-1.5 text-[10px] text-txt-muted">
              <span class="font-mono text-[9px] text-accent shrink-0">${renderToolLabel(t.tool)}</span>
              <span class="truncate">${t.summary}</span>
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}

export function Message({ id, role, content, timestamp, senderName, isError, compact, usage, toolHistory, runId, replyToMessageId, blockState }) {
  const isAssistant = role === 'assistant';
  const time = formatMessageTimestamp(timestamp);
  const timeTitle = timestamp
    ? new Date(timestamp).toLocaleString()
    : new Date().toLocaleString();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const group = selectedGroup.value;
  const isMultiAgent = group && group.agents && group.agents.length > 1;
  const showAgentBadge = isAssistant && isMultiAgent && senderName;
  const nameColor = showAgentBadge ? agentColor(senderName) : null;

  const sizeClass = compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm';

  const bubbleClass = isAssistant
    ? `self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm ${compact ? 'max-w-[95%]' : 'max-w-[90%]'}`
    : `self-end bg-userbg rounded-2xl rounded-br-sm ${compact ? 'max-w-[95%]' : 'max-w-[80%]'}`;

  const errorClass = isError ? 'border-err/30' : '';

  // Reply only makes sense for agent output — replying to your own message
  // would re-submit text the agent already saw. A future "resend" affordance
  // could fill the same slot on user messages, but that's a separate feature.
  const canReply = isAssistant && !!id && !isError;
  const onReplyClick = (e) => {
    e.stopPropagation();
    setReplyTo({ id, content, timestamp, senderName });
  };

  return html`
    <div
      class="${sizeClass} leading-relaxed ${bubbleClass} ${errorClass} overflow-hidden break-words relative group"
      onMouseEnter=${() => setHovered(true)}
      onMouseLeave=${() => setHovered(false)}
      ${showAgentBadge ? { style: `border-left: 3px solid ${nameColor}` } : {}}
    >
      ${showAgentBadge && html`
        <div class="text-[11px] font-semibold mb-1" style="color: ${nameColor}">${senderName}</div>
      `}
      ${replyToMessageId && html`<${ReplyToHeader} replyToMessageId=${replyToMessageId} />`}
      <${MessageBody} content=${content} messageId=${id} messageTimestamp=${timestamp} blockState=${blockState} />
      <div class="text-[11px] text-txt-muted mt-1.5" title=${timeTitle}>
        ${senderName && !showAgentBadge ? `${senderName} \u00B7 ${time}` : time}
      </div>
      ${isAssistant && usage && html`
        <${UsageFooter}
          usage=${usage}
          toolHistory=${toolHistory}
          expanded=${expanded}
          onToggle=${() => setExpanded(!expanded)}
          runId=${runId}
          groupFolder=${group?.folder}
        />
      `}
      ${canReply && hovered && html`
        <button
          class="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-bg-3/90 border border-border text-txt-muted hover:text-accent hover:border-accent transition-colors"
          onClick=${onReplyClick}
          title="Reply to this message"
        >
          \u21B3 reply
        </button>
      `}
    </div>
  `;
}
