import { html } from 'htm/preact';
import { md } from '../../markdown.js';

const STATUS_COLORS = { success: '#4ade80', warn: '#facc15', error: '#f87171', info: '#60a5fa' };

export function CardBlock({ title, icon, body, content, footer, rows, status }) {
  const text = body || content || '';
  const hasRows = Array.isArray(rows) && rows.length > 0;
  return html`
    <div class="card-block pixel-border">
      <div class="card-header">
        ${icon && html`<span class="card-icon">${icon}</span>`}
        <span class="card-title">${title || 'Card'}</span>
        ${status && STATUS_COLORS[status] && html`<span class="card-status" style="background: ${STATUS_COLORS[status]}" />`}
      </div>
      ${text && html`<div class="card-body prose" dangerouslySetInnerHTML=${{ __html: md(text) }} />`}
      ${hasRows && html`
        <div class="card-rows">
          ${rows.map(r => html`
            <div class="card-row">
              <span class="card-row-label">${r.label}</span>
              <span class="card-row-value">${r.value}</span>
            </div>
          `)}
        </div>
      `}
      ${footer && html`<div class="card-footer">${footer}</div>`}
    </div>
  `;
}
