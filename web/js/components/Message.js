import { html } from 'htm/preact';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function Message({ role, content, timestamp, senderName, isError, compact }) {
  const isAssistant = role === 'assistant';
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  const sizeClass = compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm';

  const bubbleClass = isAssistant
    ? `self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm ${compact ? 'max-w-[95%]' : 'max-w-[90%]'}`
    : `self-end bg-userbg rounded-2xl rounded-br-sm ${compact ? 'max-w-[95%]' : 'max-w-[80%]'}`;

  const errorClass = isError ? 'border-err/30' : '';

  const blocks = isAssistant ? parseBlocks(content) : null;

  return html`
    <div class="${sizeClass} leading-relaxed ${bubbleClass} ${errorClass}">
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
