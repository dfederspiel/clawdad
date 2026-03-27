import { html } from 'htm/preact';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';

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

  const blocks = isAssistant ? parseBlocks(content) : null;

  return html`
    <div class="px-4 py-3 text-sm leading-relaxed ${bubbleClass} ${errorClass}">
      ${blocks
        ? html`<div class="block-container">
            ${blocks.map((block, i) => html`<${BlockRenderer} key=${i} block=${block} />`)}
          </div>`
        : html`<div>${esc(content)}</div>`}
      <div class="text-[11px] text-txt-muted mt-1.5">
        ${senderName ? `${senderName} \u00B7 ${time}` : time}
      </div>
    </div>
  `;
}
