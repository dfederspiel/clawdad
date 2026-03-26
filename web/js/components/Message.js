import { html } from 'htm/preact';
import { md } from '../markdown.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function Message({ role, content, timestamp, senderName, isError }) {
  const isAssistant = role === 'assistant';
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  const bubbleClass = isAssistant
    ? 'self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm max-w-[90%]'
    : 'self-end bg-userbg rounded-2xl rounded-br-sm max-w-[80%]';

  const errorClass = isError ? 'border-err/30' : '';

  return html`
    <div class="px-4 py-3 text-sm leading-relaxed ${bubbleClass} ${errorClass}">
      ${isAssistant
        ? html`<div class="prose" dangerouslySetInnerHTML=${{ __html: md(content) }} />`
        : html`<div>${esc(content)}</div>`}
      <div class="text-[11px] text-txt-muted mt-1.5">
        ${senderName ? `${senderName} · ${time}` : time}
      </div>
    </div>
  `;
}
