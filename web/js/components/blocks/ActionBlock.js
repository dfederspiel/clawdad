import { html } from 'htm/preact';
import { handleSend } from '../../app.js';

export function ActionBlock({ buttons }) {
  if (!buttons || !buttons.length) return null;

  const onClick = (btn) => {
    handleSend(`[action: ${btn.id}]`);
  };

  return html`
    <div class="action-block">
      ${buttons.map(btn => html`
        <button
          class="action-btn action-btn-${btn.style || 'default'} pixel-border"
          onClick=${() => onClick(btn)}
        >
          ${btn.label}
        </button>
      `)}
    </div>
  `;
}
