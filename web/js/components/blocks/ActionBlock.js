import { html } from 'htm/preact';
import { handleSend, selectedJid } from '../../app.js';

async function invokePortalAction(btn, jid) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid,
      target_agent: btn.target_agent,
      label: btn.label,
      action_message:
        btn.action_message ||
        btn.prompt ||
        `[action: ${btn.id}] ${btn.label}`,
      sender: 'Web User',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Portal action failed:', err);
  }
}

export function ActionBlock({ buttons }) {
  if (!buttons || !buttons.length) return null;

  const onClick = (btn) => {
    // target: "thread" routes the click into a portal via /api/action.
    // Requires target_agent — which specialist should run the work.
    if (btn.target === 'thread' && btn.target_agent) {
      const jid = selectedJid.value;
      if (jid) invokePortalAction(btn, jid);
      return;
    }
    // Default: inject the action text into the chat as a user message.
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
