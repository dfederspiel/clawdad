import { html } from 'htm/preact';
import { selectGroup, unread, typingGroups } from '../app.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function GroupItem({ group, isActive }) {
  const count = unread.value[group.jid] || 0;
  const isThinking = typingGroups.value[group.jid] || false;
  const base =
    'flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors text-sm';
  const active = isActive ? 'bg-bg-3 text-txt' : 'text-txt-2 hover:bg-bg-hover';

  // Dot color: green pulsing if thinking, accent if active, muted otherwise
  const dotClass = isThinking
    ? 'bg-green-400 animate-pulse'
    : isActive
      ? 'bg-accent'
      : 'bg-txt-muted';

  return html`
    <div class="${base} ${active}" onClick=${() => selectGroup(group.jid)}>
      <span class="w-2 h-2 rounded-full flex-shrink-0 ${dotClass}" />
      <span class="flex-1 truncate">${esc(group.name)}</span>
      ${group.isMain && html`
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">main</span>
      `}
      ${count > 0 && html`
        <span class="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-accent text-bg text-[11px] font-semibold px-1">
          ${count}
        </span>
      `}
    </div>
  `;
}
