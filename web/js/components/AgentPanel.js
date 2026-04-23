import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { agentPanel, selectedGroup } from '../app.js';
import * as api from '../api.js';

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatCost(usd) {
  if (!usd) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function Entry({ entry }) {
  if (entry.type === 'text') {
    const isUser = entry.role === 'user';
    return html`
      <div class="flex flex-col gap-1 py-2 px-3 rounded-md ${isUser ? 'bg-userbg' : 'bg-asstbg'}">
        <div class="text-[10px] text-txt-muted font-mono">
          ${isUser ? 'user' : 'assistant'} · ${formatTime(entry.timestamp)}
        </div>
        <div class="text-xs text-txt-2 whitespace-pre-wrap break-words">${entry.content}</div>
      </div>
    `;
  }
  if (entry.type === 'tool_use') {
    return html`
      <div class="flex items-start gap-2 py-1.5 px-2 border-l-2 border-accent/50">
        <span class="font-mono text-[10px] text-accent shrink-0 mt-0.5">${entry.tool}</span>
        <span class="text-xs text-txt-2 truncate">${entry.summary || ''}</span>
      </div>
    `;
  }
  if (entry.type === 'tool_result') {
    if (!entry.content) return null;
    return html`
      <div class="pl-4 text-[11px] text-txt-muted font-mono whitespace-pre-wrap break-words line-clamp-3">
        ${entry.content}
      </div>
    `;
  }
  return null;
}

export function AgentPanel() {
  const state = agentPanel.value;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!state) {
      setData(null);
      setError(null);
      return;
    }
    const { runId, groupFolder } = state;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTranscript(groupFolder, runId)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load transcript');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [state?.runId, state?.groupFolder]);

  if (!state) return null;

  const run = data?.run;
  const timeline = data?.timeline || [];

  function close() {
    agentPanel.value = null;
  }

  return html`
    <div
      class="fixed inset-0 z-40 bg-black/40"
      onClick=${close}
    />
    <aside
      class="fixed top-0 right-0 h-full w-full md:w-[440px] lg:w-[520px] z-50 bg-bg-2 border-l border-border shadow-xl flex flex-col"
    >
      <header class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div class="flex flex-col gap-0.5 min-w-0">
          <h3 class="text-sm font-semibold truncate">Agent conversation</h3>
          ${run && html`
            <div class="text-[11px] text-txt-muted font-mono truncate">
              ${formatTime(run.timestamp)}
              ${run.duration_ms ? ` · ${formatDuration(run.duration_ms)}` : ''}
              ${run.num_turns ? ` · ${run.num_turns} turn${run.num_turns !== 1 ? 's' : ''}` : ''}
              ${run.cost_usd ? ` · ${formatCost(run.cost_usd)}` : ''}
            </div>
          `}
        </div>
        <button
          class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors shrink-0 ml-2"
          title="Close"
          onClick=${close}
        >
          <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </button>
      </header>
      <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
        ${loading && html`<div class="text-xs text-txt-muted p-4 text-center">Loading transcript...</div>`}
        ${error && html`
          <div class="text-xs text-err p-4 text-center">
            ${error}
            ${state.runId == null && html`
              <div class="text-txt-muted mt-2">No run ID recorded for this message. Older messages may not have this data.</div>
            `}
          </div>
        `}
        ${!loading && !error && timeline.length === 0 && html`
          <div class="text-xs text-txt-muted p-4 text-center">No transcript entries in this run window.</div>
        `}
        ${timeline.map((entry, i) => html`<${Entry} key=${i} entry=${entry} />`)}
      </div>
    </aside>
  `;
}

export function openAgentPanel(runId, groupFolder) {
  agentPanel.value = { runId, groupFolder };
}
