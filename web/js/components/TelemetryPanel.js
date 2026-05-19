import { html } from 'htm/preact';
import { telemetry, status, usage, activeAgents } from '../app.js';

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

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd) {
  if (!usd) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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
  const usg = usage.value;
  const liveByJid = activeAgents.value;

  if (!tel) {
    return html`<div class="px-4 py-3 text-xs text-txt-muted">Loading...</div>`;
  }

  const successPct = Math.round(tel.taskSuccessRate * 100);

  // Flatten the per-jid activeAgents map into a single in-flight list.
  // Per-jid counts (with multiplicity) tell the user where the load is —
  // raw instance_ids aren't user-meaningful so we skip rendering them.
  const liveEntries = [];
  let totalLive = 0;
  for (const [jid, agents] of Object.entries(liveByJid)) {
    if (!agents || agents.length === 0) continue;
    totalLive += agents.length;
    const counts = {};
    for (const a of agents) {
      counts[a.name] = (counts[a.name] || 0) + 1;
    }
    liveEntries.push({ jid, counts });
  }

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

      ${totalLive > 0 && html`
        <div class="col-span-2 border-t border-border pt-3 mt-1">
          <span class="text-[10px] text-txt-muted uppercase tracking-wider">
            Active Now
            <span class="text-accent normal-case ml-1">${totalLive} run${totalLive !== 1 ? 's' : ''} in ${liveEntries.length} chat${liveEntries.length !== 1 ? 's' : ''}</span>
          </span>
          <div class="mt-1 flex flex-col gap-0.5">
            ${liveEntries.slice(0, 8).map(
              (e) => html`
                <div class="flex items-center justify-between text-[11px]">
                  <span class="text-txt-2 truncate">
                    ${Object.entries(e.counts).map(([name, n]) => html`
                      <span class="font-mono">${name}${n > 1 ? html`<span class="text-txt-muted">×${n}</span>` : ''}</span>${' '}
                    `)}
                  </span>
                  <span class="text-txt-muted font-mono text-[10px] ml-2 truncate max-w-[40%]" title=${e.jid}>${e.jid}</span>
                </div>
              `,
            )}
          </div>
        </div>
      `}

      ${usg && usg.totalRuns > 0 && html`
        <div class="col-span-2 border-t border-border pt-3 mt-1">
          <span class="text-[10px] text-txt-muted uppercase tracking-wider">Token Usage (24h)</span>
          <div class="mt-2 grid grid-cols-2 gap-3">
            <${Metric}
              label="Total Cost"
              value=${formatCost(usg.totalCostUsd)}
              sub="${usg.totalRuns} run${usg.totalRuns !== 1 ? 's' : ''}"
            />
            <${Metric}
              label="Tokens"
              value=${formatTokens(usg.totalInputTokens + usg.totalOutputTokens)}
              sub="${formatTokens(usg.totalInputTokens)} in · ${formatTokens(usg.totalOutputTokens)} out"
            />
            ${usg.totalCacheReadTokens > 0 && html`
              <${Metric}
                label="Cache"
                value=${formatTokens(usg.totalCacheReadTokens)}
                sub="read from cache"
              />
            `}
            <${Metric}
              label="Avg Turns"
              value=${Math.round(usg.avgTurns)}
              sub="per run"
            />
          </div>
        </div>

        ${usg.byGroup.length > 1 && html`
          <div class="col-span-2">
            <span class="text-[10px] text-txt-muted uppercase tracking-wider">Cost by Group (24h)</span>
            <div class="mt-1 flex flex-col gap-0.5">
              ${usg.byGroup.slice(0, 5).map(
                (g) => html`
                  <div class="flex items-center justify-between text-[11px]">
                    <span class="text-txt-2 truncate">${g.group_folder}</span>
                    <span class="text-txt-muted font-mono ml-2">${formatCost(g.cost_usd)}</span>
                  </div>
                `,
              )}
            </div>
          </div>
        `}

        ${usg.byAgent && usg.byAgent.length > 0 && html`
          <div class="col-span-2">
            <span class="text-[10px] text-txt-muted uppercase tracking-wider">Cost by Agent (24h)</span>
            <div class="mt-1 flex flex-col gap-0.5">
              ${usg.byAgent.slice(0, 10).map(
                (a) => html`
                  <div class="flex items-center justify-between text-[11px]">
                    <span class="text-txt-2 truncate">
                      <span class="font-mono">${a.agent_name}</span>
                      <span class="text-txt-muted"> · ${a.group_folder}</span>
                    </span>
                    <span class="text-txt-muted font-mono ml-2 shrink-0">
                      ${formatCost(a.cost_usd)}
                      <span class="opacity-60"> · ${a.runs}× · ${formatDuration(a.avg_duration_ms)}</span>
                    </span>
                  </div>
                `,
              )}
            </div>
          </div>
        `}

        ${usg.topTools && usg.topTools.length > 0 && html`
          <div class="col-span-2">
            <span class="text-[10px] text-txt-muted uppercase tracking-wider">Top Tools (24h) <span class="normal-case">by call count</span></span>
            <div class="mt-1 flex flex-col gap-0.5">
              ${usg.topTools.slice(0, 8).map(
                (t) => html`
                  <div class="flex items-center justify-between text-[11px]">
                    <span class="text-txt-2 font-mono truncate">${t.tool}</span>
                    <span class="text-txt-muted font-mono ml-2">${t.count}x</span>
                  </div>
                `,
              )}
            </div>
          </div>
        `}
      `}

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
