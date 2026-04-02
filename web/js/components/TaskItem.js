import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { pauseTask, resumeTask, cancelTask, getTaskLogs } from '../app.js';
import { ConfirmDialog } from './ConfirmDialog.js';

function relativeTime(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function untilTime(iso) {
  if (!iso) return '-';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 60000) return 'soon';
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`;
  return `in ${Math.floor(diff / 86400000)}d`;
}

function describeCron(expr) {
  // Simple human-readable cron descriptions for common patterns
  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min.startsWith('*/')) return `Every ${min.slice(2)}m`;
  if (hour.startsWith('*/')) return `Every ${hour.slice(2)}h`;
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*') return `Daily ${hour}:${min.padStart(2, '0')}`;
  if (dow !== '*' && dom === '*') return `Weekly`;
  return expr;
}

// SVG icons as tiny components
const PauseIcon = () => html`<svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
const PlayIcon = () => html`<svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>`;
const TrashIcon = () => html`<svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
const ChevronIcon = ({ open }) => html`<svg class="w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>`;

export function TaskItem({ task, compact }) {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState(null);
  const [acting, setActing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isPaused = task.status === 'paused';
  const isCompleted = task.status === 'completed';
  const title = task.title || task.prompt.split('\n')[0].slice(0, 50);

  async function toggleExpand() {
    if (!expanded && !logs) {
      const data = await getTaskLogs(task.id);
      setLogs(data.logs);
    }
    setExpanded(!expanded);
  }

  async function onPauseResume(e) {
    e.stopPropagation();
    setActing(true);
    try {
      if (isPaused) await resumeTask(task.id);
      else await pauseTask(task.id);
    } finally {
      setActing(false);
    }
  }

  function onDeleteClick(e) {
    e.stopPropagation();
    setDeleteOpen(true);
  }

  async function onDeleteConfirm() {
    setActing(true);
    try {
      await cancelTask(task.id);
    } finally {
      setActing(false);
      setDeleteOpen(false);
    }
  }

  const dotColor = isPaused
    ? 'bg-yellow-400'
    : isCompleted
      ? 'bg-txt-muted'
      : 'bg-green-400';

  const scheduleLabel = task.schedule_type === 'cron'
    ? describeCron(task.schedule_value)
    : task.schedule_type === 'once'
      ? 'One-time'
      : `Every ${Math.round(parseInt(task.schedule_value) / 60000)}m`;

  return html`
    <div class="group/task">
      <div
        class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-bg-hover/50 transition-colors"
        onClick=${toggleExpand}
      >
        <${ChevronIcon} open=${expanded} />
        <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}" />
        <span class="text-[11px] text-txt truncate flex-1 min-w-0">${title}</span>
        <span class="text-[10px] text-txt-muted font-mono shrink-0">${scheduleLabel}</span>
        <div class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/task:opacity-100 transition-opacity">
          ${!isCompleted && html`
            <button
              class="p-0.5 rounded ${isPaused ? 'text-green-400 hover:bg-green-400/10' : 'text-yellow-400 hover:bg-yellow-400/10'} transition-colors"
              onClick=${onPauseResume}
              disabled=${acting}
              title=${isPaused ? 'Resume' : 'Pause'}
            >
              ${isPaused ? html`<${PlayIcon} />` : html`<${PauseIcon} />`}
            </button>
          `}
          <button
            class="p-0.5 rounded text-txt-muted hover:text-err hover:bg-err/10 transition-colors"
            onClick=${onDeleteClick}
            disabled=${acting}
            title="Delete"
          >
            <${TrashIcon} />
          </button>
        </div>
      </div>

      ${expanded && html`
        <div class="px-3 pb-2 ml-5 text-[10px]">
          <!-- Schedule & timing -->
          <div class="flex items-center gap-3 text-txt-muted mb-1.5">
            ${task.schedule_type === 'cron' && html`<span class="font-mono">${task.schedule_value}</span>`}
            <span>last: ${relativeTime(task.last_run)}</span>
            ${task.next_run && html`<span>next: ${untilTime(task.next_run)}</span>`}
          </div>

          <!-- Full prompt -->
          <div class="text-txt-2 bg-bg rounded-lg px-2.5 py-2 mb-1.5 whitespace-pre-wrap max-h-[120px] overflow-y-auto leading-relaxed">
            ${task.prompt}
          </div>

          <!-- Run history -->
          ${logs && logs.length > 0 && html`
            <div class="border-t border-border pt-1.5 mt-1.5">
              <div class="text-txt-muted mb-1">Recent runs</div>
              ${logs.slice(0, 5).map(
                (log) => html`
                  <div class="flex items-center gap-2 py-0.5">
                    <span class="w-1 h-1 rounded-full ${log.status === 'success' ? 'bg-green-400' : 'bg-err'}" />
                    <span class="text-txt-muted">${relativeTime(log.run_at)}</span>
                    <span class="text-txt-muted font-mono">${log.duration_ms < 1000 ? log.duration_ms + 'ms' : (log.duration_ms / 1000).toFixed(1) + 's'}</span>
                    ${log.error && html`<span class="text-err truncate">${log.error.slice(0, 40)}</span>`}
                  </div>
                `,
              )}
            </div>
          `}
          ${logs && logs.length === 0 && html`
            <div class="text-txt-muted">No runs yet</div>
          `}
        </div>
      `}
    </div>
    <${ConfirmDialog}
      open=${deleteOpen}
      title="Delete task?"
      message="This removes the task and all its run history. This cannot be undone."
      confirmLabel="Delete"
      destructive=${true}
      loading=${acting}
      onConfirm=${onDeleteConfirm}
      onCancel=${() => setDeleteOpen(false)}
    />
  `;
}
