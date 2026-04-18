import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { unread, typingGroups, tasks, activeAgents } from '../app.js';
import { TaskItem } from './TaskItem.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Persist drawer state per group across refreshes
function getDrawerKey(jid) { return `clawdad-drawer-${jid}`; }
function loadDrawerState(jid) { return localStorage.getItem(getDrawerKey(jid)) === '1'; }
function saveDrawerState(jid, open) {
  if (open) localStorage.setItem(getDrawerKey(jid), '1');
  else localStorage.removeItem(getDrawerKey(jid));
}

function getTaskDrawerKey(jid) { return `clawdad-task-drawer-${jid}`; }
function loadTaskDrawerState(jid) { return localStorage.getItem(getTaskDrawerKey(jid)) === '1'; }
function saveTaskDrawerState(jid, open) {
  if (open) localStorage.setItem(getTaskDrawerKey(jid), '1');
  else localStorage.removeItem(getTaskDrawerKey(jid));
}

function AgentRow({ agent, jid }) {
  const isWorking = (activeAgents.value[jid] || []).includes(agent.displayName);
  const isCoordinator = !agent.trigger;
  const triggerLabel = agent.trigger
    ? agent.trigger.replace(/[\\^$.*+?()[\]{}|]/g, '').trim()
    : null;

  const dotClass = isWorking
    ? 'w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0'
    : 'w-1.5 h-1.5 rounded-full bg-txt-muted/40 flex-shrink-0';

  return html`
    <div class="flex items-start gap-2.5 pl-8 pr-4 py-1.5 text-xs text-txt-2 border-l-2 border-border/50 ml-4">
      <span class="${dotClass} mt-1.5" />
      <div class="min-w-0 flex-1">
        <div class="flex items-start gap-2">
          <span class="truncate flex-1">${esc(agent.displayName)}</span>
          ${isCoordinator && html`
            <span class="text-[9px] leading-none px-1.5 py-1 rounded bg-accent-dim text-accent font-medium shrink-0 mt-0.5">coord</span>
          `}
          ${triggerLabel && html`
            <span class="text-[9px] leading-none px-1.5 py-1 rounded bg-bg-3 text-txt-muted font-mono shrink-0 mt-0.5">${esc(triggerLabel)}</span>
          `}
        </div>
        ${agent.status && html`
          <div class="text-[10px] text-txt-muted truncate leading-snug mt-1">${esc(agent.status)}</div>
        `}
      </div>
    </div>
  `;
}

export function GroupItem({ group, isActive, onSelect, onSettings }) {
  const agents = group.agents || [];
  const coordinator = agents.find((a) => !a.trigger);
  const specialists = agents.filter((a) => a.trigger);
  const visibleAgents = coordinator
    ? [coordinator, ...specialists]
    : specialists;
  const isMultiAgent = visibleAgents.length > 1 || (visibleAgents.length === 1 && specialists.length > 0);
  const [expanded, setExpanded] = useState(() => isMultiAgent && loadDrawerState(group.jid));
  const [tasksExpanded, setTasksExpanded] = useState(() => loadTaskDrawerState(group.jid));

  const count = unread.value[group.jid] || 0;
  const isThinking = typingGroups.value[group.jid] || false;
  const activeList = activeAgents.value[group.jid] || [];
  const hasActiveAgents = isMultiAgent && activeList.length > 0;
  const groupTasks = tasks.value.filter(t => t.group_folder === group.folder);
  const taskCount = groupTasks.filter(t => t.status === 'active').length;

  // Auto-expand drawer when specialists activate (don't auto-collapse — that's jarring)
  useEffect(() => {
    if (hasActiveAgents && !expanded) {
      setExpanded(true);
      saveDrawerState(group.jid, true);
    }
  }, [hasActiveAgents]);
  const base =
    'flex items-start gap-2.5 px-4 py-2.5 cursor-pointer transition-colors text-sm group/item';
  const active = isActive ? 'bg-bg-3 text-txt' : 'text-txt-2 hover:bg-bg-hover';

  // Dot color: green pulsing if thinking, accent if active, muted otherwise
  const dotClass = isThinking
    ? 'bg-green-400 animate-pulse'
    : isActive
      ? 'bg-accent'
      : 'bg-txt-muted';

  function handleClick() {
    onSelect(group.jid);
  }

  function handleExpand(e) {
    e.stopPropagation();
    const next = !expanded;
    setExpanded(next);
    saveDrawerState(group.jid, next);
  }

  function handleTasksExpand(e) {
    e.stopPropagation();
    const next = !tasksExpanded;
    setTasksExpanded(next);
    saveTaskDrawerState(group.jid, next);
  }

  return html`
    <div>
      <div class="${base} ${active}" onClick=${handleClick}>
        <span class="w-2 h-2 rounded-full flex-shrink-0 ${dotClass} mt-1.5" />
        <div class="flex-1 min-w-0">
          <div class="truncate">${esc(group.name)}</div>
          ${group.subtitle && html`
            <div class="text-[10px] text-txt-muted truncate leading-snug mt-0.5">${esc(group.subtitle)}</div>
          `}
        </div>
        ${group.isSystem && html`
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-3 text-txt-muted font-medium shrink-0">system</span>
        `}
        ${group.isMain && !group.isSystem && html`
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-accent-dim text-accent font-medium shrink-0">main</span>
        `}
        ${taskCount > 0 && !count && html`
          <button
            class="text-[9px] px-1 py-0.5 rounded bg-bg-3 text-txt-muted hover:text-txt hover:bg-bg-hover font-mono shrink-0 ${tasksExpanded ? 'ring-1 ring-accent/40 text-txt' : ''}"
            title="${taskCount} active task${taskCount > 1 ? 's' : ''} — click to ${tasksExpanded ? 'collapse' : 'expand'}"
            onClick=${handleTasksExpand}
          >${taskCount}t</button>
        `}
        ${count > 0 && html`
          <span class="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-accent text-bg text-[11px] font-semibold px-1 shrink-0">
            ${count}
          </span>
        `}
        <div class="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-all shrink-0 mt-0.5">
          ${isMultiAgent && html`
            <button
              class="w-5 h-5 flex items-center justify-center rounded ${expanded ? 'bg-accent-dim text-accent ring-1 ring-accent/40' : 'text-txt-muted hover:text-txt hover:bg-bg-hover'} transition-colors"
              title="${expanded ? 'Hide' : 'Show'} agents (${visibleAgents.length})"
              onClick=${handleExpand}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.517 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.654zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.517 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.654zM18 8a2 2 0 11-4 0 2 2 0 014 0zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z"/>
              </svg>
            </button>
          `}
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
        </div>
      </div>
      ${tasksExpanded && groupTasks.length > 0 && html`
        <div class="border-l-2 border-border/50 ml-4 pb-1 bg-bg/30">
          ${groupTasks.map(t => html`<${TaskItem} key=${t.id} task=${t} />`)}
        </div>
      `}
      ${isMultiAgent && expanded && html`
        <div class="pb-1">
          ${visibleAgents.map(a => html`<${AgentRow} key=${a.id} agent=${a} jid=${group.jid} />`)}
        </div>
      `}
    </div>
  `;
}
