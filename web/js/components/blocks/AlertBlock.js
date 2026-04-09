import { html } from 'htm/preact';
import { md } from '../../markdown.js';

const ICONS = { success: '\u2714', warn: '\u26A0', error: '\u2718', info: '\u2139' };

export function AlertBlock({ level, style, title, body, message }) {
  const lvl = level || style || 'info';
  const content = body || message || '';
  return html`
    <div class="alert-block alert-${lvl}">
      <span class="alert-icon">${ICONS[lvl] || ICONS.info}</span>
      <div class="alert-content">
        ${title && html`<div class="alert-title">${title}</div>`}
        <div class="alert-body" dangerouslySetInnerHTML=${{ __html: md(content) }} />
      </div>
    </div>
  `;
}
