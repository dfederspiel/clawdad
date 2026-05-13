import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import {
  abortCurrentRun,
  selectedJid,
  typing,
  typingStartTime,
  typingAgentName,
  agentProgress,
  currentWorkState,
} from '../app.js';
import { ConfirmDialog } from './ConfirmDialog.js';

// #143 — Lucide square icon for the stop button. A solid square reads as
// "halt" without needing a label at this size.
const StopIcon = html`<svg viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

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
  const [aborting, setAborting] = useState(false);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const jid = selectedJid.value;
  const isTyping = typing.value;
  const startTime = typingStartTime.value[jid];
  const progress = agentProgress.value[jid];
  const agentName = typingAgentName.value[jid];
  const work = currentWorkState.value;
  const phase = isTyping ? 'thinking' : work?.phase;

  async function onStop() {
    if (aborting) return;
    setAborting(true);
    await abortCurrentRun('stop');
    // The work_state 'aborted' SSE event clears the indicator; reset
    // local pending state after a tick so a re-render flushes.
    setTimeout(() => setAborting(false), 500);
  }

  async function onKillConfirm() {
    setKillConfirmOpen(false);
    setAborting(true);
    await abortCurrentRun('kill');
    setTimeout(() => setAborting(false), 500);
  }

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
        ${showDots && html`
          <button
            class="ml-2 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-txt-muted hover:text-err hover:border-err transition-colors ${aborting ? 'opacity-50' : ''}"
            onClick=${onStop}
            disabled=${aborting}
            title="Stop \u2014 agent finishes current tool call and exits cleanly (Esc)"
          >
            ${StopIcon}
            <span>${aborting ? 'stopping\u2026' : 'stop'}</span>
          </button>
          <button
            class="text-[10px] px-1.5 py-0.5 rounded border border-border text-txt-muted hover:text-err hover:border-err transition-colors"
            onClick=${() => setKillConfirmOpen(true)}
            title="Kill \u2014 hard-stops the container. Session may be left in a partial state."
          >
            kill
          </button>
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
      <${ConfirmDialog}
        open=${killConfirmOpen}
        title="Hard-kill the agent?"
        message="This stops the container immediately. Any in-flight tool call is lost and the session may end up in a partial state. Use Stop for a graceful exit."
        confirmLabel="Kill"
        destructive=${true}
        onConfirm=${onKillConfirm}
        onCancel=${() => setKillConfirmOpen(false)}
      />
    </div>
  `;
}
