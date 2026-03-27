import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { pauseTask, resumeTask, cancelTask, getTaskLogs } from '../app.js';

function truncate(s, max = 60) {
  return s && s.length > max ? s.slice(0, max) + '...' : s || '';
}

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

export function TaskItem({ task }) {
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState(null);
  const [acting, setActing] = useState(false);

  const isPaused = task.status === 'paused';
  const isCompleted = task.status === 'completed';

  async function toggleLogs() {
    if (!showLogs && !logs) {
      const data = await getTaskLogs(task.id);
      setLogs(data.logs);
    }
    setShowLogs(!showLogs);
  }

  async function onPauseResume() {
    setActing(true);
    try {
      if (isPaused) await resumeTask(task.id);
      else await pauseTask(task.id);
    } finally {
      setActing(false);
    }
  }

  async function onCancel() {
    if (!confirm('Delete this task and all its logs?')) return;
    setActing(true);
    try {
      await cancelTask(task.id);
    } finally {
      setActing(false);
    }
  }

  const statusColor = isPaused
    ? 'text-yellow-400'
    : isCompleted
      ? 'text-txt-muted'
      : 'text-green-400';

  return html`
    <div class="px-4 py-2 hover:bg-bg-hover/50 transition-colors">
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColor} ${!isPaused && !isCompleted ? 'bg-green-400' : isPaused ? 'bg-yellow-400' : 'bg-txt-muted'}" />
        <div class="text-xs text-txt truncate flex-1 min-w-0 cursor-pointer" onClick=${toggleLogs} title=${task.prompt}>
          ${truncate(task.prompt)}
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          ${!isCompleted && html`
            <button
              class="text-[10px] px-1.5 py-0.5 rounded ${isPaused ? 'text-green-400 hover:bg-green-400/10' : 'text-yellow-400 hover:bg-yellow-400/10'} transition-colors"
              onClick=${onPauseResume}
              disabled=${acting}
              title=${isPaused ? 'Resume' : 'Pause'}
            >
              ${isPaused ? 'resume' : 'pause'}
            </button>
          `}
          <button
            class="text-[10px] px-1.5 py-0.5 rounded text-err hover:bg-err/10 transition-colors"
            onClick=${onCancel}
            disabled=${acting}
            title="Delete"
          >
            delete
          </button>
        </div>
      </div>
      <div class="mt-1 text-[10px] text-txt-muted space-y-0.5">
        <div class="font-mono">${task.schedule_type}${task.schedule_type === 'cron' ? `: ${task.schedule_value}` : ''}</div>
        <div class="flex items-center gap-2">
          <span>last: ${relativeTime(task.last_run)}</span>
          ${task.next_run && html`
            <span>·</span>
            <span>next: ${untilTime(task.next_run)}</span>
          `}
        </div>
      </div>

      ${showLogs && logs && html`
        <div class="mt-2 ml-3.5 border-l border-border/50 pl-2.5">
          ${logs.length === 0
            ? html`<div class="text-[10px] text-txt-muted">No runs yet.</div>`
            : logs.slice(0, 5).map(
                (log) => html`
                  <div class="flex items-center gap-2 text-[10px] py-0.5">
                    <span class="${log.status === 'success' ? 'text-green-400' : 'text-err'}">
                      ${log.status}
                    </span>
                    <span class="text-txt-muted">${relativeTime(log.run_at)}</span>
                    <span class="text-txt-muted font-mono">${log.duration_ms}ms</span>
                    ${log.error && html`<span class="text-err truncate">${truncate(log.error, 40)}</span>`}
                  </div>
                `,
              )}
        </div>
      `}
    </div>
  `;
}
