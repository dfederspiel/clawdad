import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { status, tasks, telemetry } from '../app.js';
import { TaskManager } from './TaskManager.js';
import { TelemetryPanel } from './TelemetryPanel.js';

export function StatusPanel() {
  const [expanded, setExpanded] = useState(null); // 'tasks' | 'telemetry' | null
  const st = status.value;
  const taskList = tasks.value;
  const tel = telemetry.value;

  const activeContainers = st?.containers?.activeCount || 0;
  const maxContainers = st?.containers?.maxConcurrent || 0;
  const activeGroups = st?.containers?.groups?.filter((g) => g.active) || [];
  const activeTasks = taskList.filter((t) => t.status === 'active').length;
  const pausedTasks = taskList.filter((t) => t.status === 'paused').length;

  function toggle(section) {
    setExpanded(expanded === section ? null : section);
  }

  return html`
    <div class="border-t border-border">
      <!-- Containers -->
      <div class="px-4 py-2.5 border-b border-border">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium uppercase tracking-wider text-txt-muted">Containers</span>
          <span class="text-xs font-mono ${activeContainers > 0 ? 'text-accent' : 'text-txt-muted'}">
            ${activeContainers}/${maxContainers}
          </span>
        </div>
        ${activeGroups.length > 0 && html`
          <div class="mt-1.5 flex flex-col gap-1">
            ${activeGroups.map(
              (g) => html`
                <div class="flex items-center gap-1.5 text-[11px]">
                  <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                  <span class="text-txt-2 truncate">${g.groupFolder || g.jid}</span>
                  ${g.isTask && html`<span class="text-txt-muted">(task)</span>`}
                </div>
              `,
            )}
          </div>
        `}
      </div>

      <!-- Tasks toggle -->
      <button
        class="w-full px-4 py-2 flex items-center justify-between text-left hover:bg-bg-hover transition-colors border-b border-border"
        onClick=${() => toggle('tasks')}
      >
        <span class="text-[11px] font-medium uppercase tracking-wider text-txt-muted">Tasks</span>
        <span class="text-xs font-mono text-txt-2">
          ${activeTasks} active${pausedTasks > 0 ? ` · ${pausedTasks} paused` : ''}
        </span>
      </button>
      ${expanded === 'tasks' && html`<${TaskManager} />`}

      <!-- Telemetry toggle -->
      <button
        class="w-full px-4 py-2 flex items-center justify-between text-left hover:bg-bg-hover transition-colors"
        onClick=${() => toggle('telemetry')}
      >
        <span class="text-[11px] font-medium uppercase tracking-wider text-txt-muted">Metrics</span>
        ${tel && html`
          <span class="text-xs font-mono text-txt-2">${tel.messages24h} msgs/24h</span>
        `}
      </button>
      ${expanded === 'telemetry' && html`<${TelemetryPanel} />`}
    </div>
  `;
}
