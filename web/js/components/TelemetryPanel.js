import { html } from 'htm/preact';
import { telemetry, status } from '../app.js';

function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatUptime(seconds) {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Metric({ label, value, sub }) {
  return html`
    <div class="flex flex-col">
      <span class="text-[10px] text-txt-muted uppercase tracking-wider">${label}</span>
      <span class="text-sm font-mono text-txt">${value}</span>
      ${sub && html`<span class="text-[10px] text-txt-muted">${sub}</span>`}
    </div>
  `;
}

export function TelemetryPanel() {
  const tel = telemetry.value;
  const st = status.value;

  if (!tel) {
    return html`<div class="px-4 py-3 text-xs text-txt-muted">Loading...</div>`;
  }

  const successPct = Math.round(tel.taskSuccessRate * 100);

  return html`
    <div class="px-4 py-3 grid grid-cols-2 gap-3">
      <${Metric} label="Messages (24h)" value=${tel.messages24h} sub="${tel.messages7d} in 7d" />
      <${Metric} label="Task Runs (7d)" value=${tel.totalTaskRuns} sub="${successPct}% success" />
      <${Metric} label="Avg Duration" value=${formatDuration(tel.taskAvgDurationMs)} />
      <${Metric} label="Uptime" value=${formatUptime(st?.uptime)} />
      <${Metric}
        label="Tasks"
        value="${tel.taskCounts.active} active"
        sub="${tel.taskCounts.paused} paused · ${tel.taskCounts.completed} done"
      />
      ${tel.messagesPerGroup.length > 0 && html`
        <div class="col-span-2">
          <span class="text-[10px] text-txt-muted uppercase tracking-wider">Top Groups (24h)</span>
          <div class="mt-1 flex flex-col gap-0.5">
            ${tel.messagesPerGroup.slice(0, 5).map(
              (g) => html`
                <div class="flex items-center justify-between text-[11px]">
                  <span class="text-txt-2 truncate">${g.chat_jid}</span>
                  <span class="text-txt-muted font-mono ml-2">${g.count}</span>
                </div>
              `,
            )}
          </div>
        </div>
      `}
    </div>
  `;
}
