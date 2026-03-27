import { html } from 'htm/preact';

export function ProgressBlock({ label, value, max, color }) {
  const pct = Math.min(100, Math.round((value / (max || 1)) * 100));
  const clr = color || 'gold';
  return html`
    <div class="progress-block">
      <div class="progress-header">
        <span class="progress-label pixel-badge">${label || 'Progress'}</span>
        <span class="progress-value">${value}/${max}</span>
      </div>
      <div class="progress-track pixel-border">
        <div class="progress-fill progress-${clr}" style="width: ${pct}%" />
      </div>
    </div>
  `;
}
