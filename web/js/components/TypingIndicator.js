import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { selectedJid, typingStartTime, typingAgentName, agentProgress } from '../app.js';

export function TypingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  const jid = selectedJid.value;
  const startTime = typingStartTime.value[jid];
  const progress = agentProgress.value[jid];
  const agentName = typingAgentName.value[jid];

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

  // Show recent tool activity
  const history = progress?.history || [];
  const recentTools = history.slice(-3);

  return html`
    <div class="self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%]">
      <div class="flex items-center gap-2">
        <span class="text-xs text-txt-muted mr-1">${agentName ? html`<span class="font-medium text-txt-2">${agentName}</span> is thinking` : 'Thinking'}${timeStr ? html`<span class="font-mono ml-1.5 text-txt-2">${timeStr}</span>` : ''}</span>
        <span class="typing-dot" />
        <span class="typing-dot" />
        <span class="typing-dot" />
      </div>
      ${progress && html`
        <div class="mt-2 flex flex-col gap-1">
          ${recentTools.map((t, i) => {
            const isLatest = i === recentTools.length - 1;
            return html`
              <div class="flex items-center gap-1.5 text-[11px] ${isLatest ? 'text-txt-2' : 'text-txt-muted opacity-50'}">
                <span class="font-mono text-[10px] ${isLatest ? 'text-accent' : ''}">${t.tool || '>'}</span>
                <span class="truncate">${t.summary}</span>
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
