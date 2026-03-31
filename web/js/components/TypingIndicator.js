import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { selectedJid, typingStartTime } from '../app.js';

export function TypingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  const jid = selectedJid.value;
  const startTime = typingStartTime.value[jid];

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

  return html`
    <div class="self-start flex items-center gap-2 bg-asstbg border border-border rounded-2xl rounded-bl-sm px-4 py-3">
      <span class="text-xs text-txt-muted mr-1">Thinking${timeStr ? html`<span class="font-mono ml-1.5 text-txt-2">${timeStr}</span>` : ''}</span>
      <span class="typing-dot" />
      <span class="typing-dot" />
      <span class="typing-dot" />
    </div>
  `;
}
