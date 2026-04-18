import { html } from 'htm/preact';

export function StatBlock({ stats, items }) {
  const data = stats || items;
  if (!data || !data.length) return null;
  return html`
    <div class="stat-block">
      ${data.map(item => html`
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
