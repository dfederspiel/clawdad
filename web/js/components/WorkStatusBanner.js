import { html } from 'htm/preact';
import { currentWorkState } from '../app.js';

const PHASE_LABELS = {
  queued: 'Queued',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting',
  delegating: 'Coordinating agents',
  task_running: 'Running task',
  completed: 'Done',
  error: 'Error',
};

const PHASE_COLORS = {
  queued: 'text-txt-muted',
  thinking: 'text-accent',
  working: 'text-accent',
  waiting: 'text-txt-muted',
  delegating: 'text-accent',
  task_running: 'text-accent',
  completed: 'text-txt-muted',
  error: 'text-err',
};

export function WorkStatusBanner() {
  const ws = currentWorkState.value;
  if (!ws || ws.phase === 'idle') return null;

  // Auto-hide completed after a brief moment — parent will clear via idle
  if (ws.phase === 'completed') return null;

  const label = PHASE_LABELS[ws.phase] || ws.phase;
  const color = PHASE_COLORS[ws.phase] || 'text-txt-muted';
  const agentLabel = ws.agent_name ? `${ws.agent_name}` : '';
  const delegationInfo = ws.phase === 'delegating' && ws.active_delegations > 0
    ? ` (${ws.active_delegations} active)`
    : '';

  const showPulse = ['thinking', 'working', 'delegating', 'task_running'].includes(ws.phase);

  return html`
    <div class="flex items-center gap-2 px-4 py-1.5 text-xs ${color} bg-bg-2 border-b border-border">
      ${showPulse && html`
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
        </span>
      `}
      <span>
        ${agentLabel && html`<span class="font-medium">${agentLabel}</span> · `}
        ${label}${delegationInfo}
        ${ws.summary && ws.summary !== `${ws.agent_name} is thinking` ? html` · <span class="text-txt-muted">${ws.summary}</span>` : ''}
      </span>
    </div>
  `;
}
