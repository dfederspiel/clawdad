import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import {
  selectedJid,
  typing,
  typingStartTime,
  typingAgentName,
  agentProgress,
  currentWorkState,
} from '../app.js';

const PHASE_LABELS = {
  queued: 'queued',
  thinking: 'thinking',
  working: 'working',
  waiting: 'waiting',
  delegating: 'coordinating',
  task_running: 'running a task',
  error: 'errored',
};

function renderProgressBadge(tool, isLatest) {
  if (tool === 'media') {
    return html`<span class="text-[10px] mt-px shrink-0 ${isLatest ? 'text-accent' : 'text-txt-muted'}">image</span>`;
  }
  if (!tool) {
    return html`<span class="text-[10px] mt-px shrink-0">\u25CB</span>`;
  }
  return html`<span class="font-mono text-[10px] ${isLatest ? 'text-accent' : ''} shrink-0">${tool}</span>`;
}

export function TypingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  const jid = selectedJid.value;
  const isTyping = typing.value;
  const startTime = typingStartTime.value[jid];
  const progress = agentProgress.value[jid];
  const agentName = typingAgentName.value[jid];
  const work = currentWorkState.value;
  const phase = isTyping ? 'thinking' : work?.phase;

  useEffect(() => {
    if (!startTime) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = elapsed >= 5
    ? (minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`)
    : '';

  // Show recent tool activity (filter out text events — those are message
  // content delivered via chat, not tool calls)
  const history = (progress?.history || []).filter((t) => t.tool !== 'text');
  const recentTools = history.slice(-3);
  const label = phase ? (PHASE_LABELS[phase] || phase) : 'thinking';
  const showDots = isTyping || ['working', 'delegating', 'task_running'].includes(phase || '');
  const headline = agentName
    ? html`<span class="font-medium text-txt-2">${agentName}</span> is ${label}`
    : label.charAt(0).toUpperCase() + label.slice(1);

  return html`
    <div class="self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%]">
      <div class="flex items-center gap-2">
        <span class="text-xs text-txt-muted mr-1">${headline}${timeStr ? html`<span class="font-mono ml-1.5 text-txt-2">${timeStr}</span>` : ''}</span>
        ${showDots && html`
          <span class="typing-dot" />
          <span class="typing-dot" />
          <span class="typing-dot" />
        `}
      </div>
      ${progress && html`
        <div class="mt-2 flex flex-col gap-1">
          ${recentTools.map((t, i) => {
            const isLatest = i === recentTools.length - 1;
            const isText = t.tool === 'text';
            const isMedia = t.tool === 'media';
            return html`
              <div class="flex items-start gap-1.5 text-[11px] ${isLatest ? 'text-txt-2' : 'text-txt-muted opacity-50'}">
                ${isText
                  ? html`<span class="text-[10px] mt-px shrink-0">\u25B8</span>`
                  : renderProgressBadge(t.tool, isLatest)
                }
                <span class="${isText || isMedia ? '' : 'truncate'}">${t.summary}</span>
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
