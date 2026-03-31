import { html } from 'htm/preact';
import { unread, typingGroups, tasks } from '../app.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function GroupItem({ group, isActive, onSelect, onDelete, onSettings }) {
  const count = unread.value[group.jid] || 0;
  const isThinking = typingGroups.value[group.jid] || false;
  const taskCount = tasks.value.filter(t => t.group_folder === group.folder && t.status === 'active').length;
  const base =
    'flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors text-sm group/item';
  const active = isActive ? 'bg-bg-3 text-txt' : 'text-txt-2 hover:bg-bg-hover';

  // Dot color: green pulsing if thinking, accent if active, muted otherwise
  const dotClass = isThinking
    ? 'bg-green-400 animate-pulse'
    : isActive
      ? 'bg-accent'
      : 'bg-txt-muted';

  const canDelete = !group.isSystem && !group.isMain;

  return html`
    <div class="${base} ${active}" onClick=${() => onSelect(group.jid)}>
      <span class="w-2 h-2 rounded-full flex-shrink-0 ${dotClass}" />
      <div class="flex-1 min-w-0">
        <div class="truncate">${esc(group.name)}</div>
        ${group.subtitle && html`
          <div class="text-[10px] text-txt-muted truncate leading-tight">${esc(group.subtitle)}</div>
        `}
      </div>
      ${group.isSystem && html`
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-3 text-txt-muted font-medium shrink-0">system</span>
      `}
      ${group.isMain && !group.isSystem && html`
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-accent-dim text-accent font-medium shrink-0">main</span>
      `}
      ${taskCount > 0 && !count && html`
        <span class="text-[9px] px-1 py-0.5 rounded bg-bg-3 text-txt-muted font-mono shrink-0" title="${taskCount} active task${taskCount > 1 ? 's' : ''}">${taskCount}t</span>
      `}
      ${count > 0 && html`
        <span class="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-accent text-bg text-[11px] font-semibold px-1 shrink-0">
          ${count}
        </span>
      `}
      <div class="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-all shrink-0">
        ${onSettings && html`
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-txt-muted hover:text-txt hover:bg-bg-hover text-xs"
            title="Group settings"
            onClick=${(e) => { e.stopPropagation(); onSettings(group); }}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
            </svg>
          </button>
        `}
        ${canDelete && html`
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-txt-muted hover:text-red-400 hover:bg-red-400/10 text-xs leading-none"
            title="Delete group"
            onClick=${(e) => { e.stopPropagation(); onDelete(group); }}
          >\u00D7</button>
        `}
      </div>
    </div>
  `;
}
