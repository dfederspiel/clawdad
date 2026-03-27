import { html } from 'htm/preact';

export function StatBlock({ items }) {
  if (!items || !items.length) return null;
  return html`
    <div class="stat-block">
      ${items.map(item => html`
        <div class="stat-item pixel-border">
          ${item.icon && html`<span class="stat-icon">${item.icon}</span>`}
          <div class="stat-data">
            <span class="stat-value pixel-badge">${item.value}</span>
            <span class="stat-label">${item.label}</span>
          </div>
        </div>
      `)}
    </div>
  `;
}
