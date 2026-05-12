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

// #141 — status badge colors track the per-block-type state contract:
// idle/pending/done/failed are the canonical lifecycle states for an
// action block. Anything else falls through to a neutral chip.
const STATUS_CLASS = {
  idle: 'bg-bg-3 text-txt-muted',
  pending: 'bg-yellow-500/20 text-yellow-300',
  done: 'bg-green-500/20 text-green-300',
  failed: 'bg-err/20 text-err',
};

export function ActionBlock({ buttons, status, result, clicked_button_id }) {
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

  const statusClass = status && (STATUS_CLASS[status] || 'bg-bg-3 text-txt-muted');

  return html`
    <div class="action-block">
      ${buttons.map(btn => {
        const isClicked = clicked_button_id && btn.id === clicked_button_id;
        return html`
          <button
            class="action-btn action-btn-${btn.style || 'default'} pixel-border ${isClicked ? 'ring-2 ring-accent/60' : ''}"
            onClick=${() => onClick(btn)}
          >
            ${btn.label}
          </button>
        `;
      })}
      ${status && html`
        <span class="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded ${statusClass}">
          ${status}
        </span>
      `}
      ${result && html`
        <div class="text-xs text-txt-2 mt-1 w-full">${result}</div>
      `}
    </div>
  `;
}
