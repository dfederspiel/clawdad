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

// #141 — Lucide-style inline SVGs (stroke-based, 24x24). Inlining the
// paths keeps the bundle dependency-free; the project doesn't currently
// pull in a Lucide package and a single block isn't worth the weight.
// Paths sourced from lucide.dev (ISC-licensed). The animate-spin class
// on Loader gives the pending state a live cue.
const ICON = {
  done: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  failed: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  pending: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  idle: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`,
};

// Per-state visual treatment. Keep colors aligned with other surfaces
// (green for success, red for failure, yellow for in-flight, muted idle).
const STATUS_STYLE = {
  idle: 'bg-bg-3 text-txt-muted',
  pending: 'bg-yellow-500/20 text-yellow-300',
  done: 'bg-green-500/20 text-green-300',
  failed: 'bg-err/20 text-err',
};

export function ActionBlock({ buttons, status, result, clicked_button_id }) {
  if (!buttons || !buttons.length) return null;

  const onClick = (btn) => {
    // url wins over every other mode. Reject non-http(s) schemes so an
    // agent can't smuggle javascript:/data:/file: URIs into a trusted chat.
    if (typeof btn.url === 'string' && /^https?:\/\//i.test(btn.url)) {
      window.open(btn.url, '_blank', 'noopener,noreferrer');
      return;
    }
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

  const statusKey = status && STATUS_STYLE[status] ? status : null;
  const statusStyle = statusKey ? STATUS_STYLE[statusKey] : 'bg-bg-3 text-txt-muted';
  const statusIcon = statusKey ? ICON[statusKey] : null;

  return html`
    <div class="action-block">
      <div class="flex items-center flex-wrap gap-2">
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
          <span class="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wide px-1.5 py-1 rounded ${statusStyle}">
            ${statusIcon}
            <span>${status}</span>
          </span>
        `}
      </div>
      ${result && html`
        <div class="text-xs text-txt-2 mt-2">${result}</div>
      `}
    </div>
  `;
}
