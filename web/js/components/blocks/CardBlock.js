import { html } from 'htm/preact';
import { md } from '../../markdown.js';

export function CardBlock({ title, icon, body, content, footer }) {
  return html`
    <div class="card-block pixel-border">
      <div class="card-header">
        ${icon && html`<span class="card-icon">${icon}</span>`}
        <span class="card-title">${title || 'Card'}</span>
      </div>
      <div class="card-body prose" dangerouslySetInnerHTML=${{ __html: md(body || content || '') }} />
      ${footer && html`<div class="card-footer">${footer}</div>`}
    </div>
  `;
}
