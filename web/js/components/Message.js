import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';
import { md } from '../markdown.js';
import { selectedGroup } from '../app.js';

// Consistent color for each agent name (hash → HSL hue)
const AGENT_COLORS = {};
function agentColor(name) {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  AGENT_COLORS[name] = `hsl(${hue}, 60%, 65%)`;
  return AGENT_COLORS[name];
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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

function renderToolLabel(tool) {
  if (tool === 'media') {
    return 'image';
  }
  return tool || '>';
}

function UsageFooter({ usage, toolHistory, expanded, onToggle }) {
  if (!usage || (!usage.numTurns && !usage.durationMs)) return null;

  const parts = [];
  if (usage.durationMs) parts.push(formatDuration(usage.durationMs));
  if (usage.numTurns) parts.push(`${usage.numTurns} turn${usage.numTurns !== 1 ? 's' : ''}`);
  const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (totalTokens) parts.push(`${formatTokens(totalTokens)} tokens`);
  if (usage.costUsd) parts.push(formatCost(usage.costUsd));

  const hasHistory = toolHistory && toolHistory.length > 0;

  return html`
    <div class="mt-1">
      <div
        class="flex items-center gap-1.5 text-[10px] text-txt-muted font-mono ${hasHistory ? 'cursor-pointer hover:text-txt-2' : ''}"
        onClick=${hasHistory ? onToggle : undefined}
      >
        ${hasHistory && html`
          <span class="text-[9px] transition-transform ${expanded ? 'rotate-90' : ''}">\u25B6</span>
        `}
        ${parts.map((p, i) => html`
          ${i > 0 && html`<span class="opacity-40">\u00B7</span>`}
          <span>${p}</span>
        `)}
      </div>
      ${expanded && hasHistory && html`
        <div class="mt-1.5 pl-3 border-l-2 border-border flex flex-col gap-0.5">
          ${toolHistory.map((t) => html`
            <div class="flex items-center gap-1.5 text-[10px] text-txt-muted">
              <span class="font-mono text-[9px] text-accent shrink-0">${renderToolLabel(t.tool)}</span>
              <span class="truncate">${t.summary}</span>
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}

export function Message({ role, content, timestamp, senderName, isError, compact, usage, toolHistory }) {
  const isAssistant = role === 'assistant';
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();
  const [expanded, setExpanded] = useState(false);

  const group = selectedGroup.value;
  const isMultiAgent = group && group.agents && group.agents.length > 1;
  const showAgentBadge = isAssistant && isMultiAgent && senderName;
  const nameColor = showAgentBadge ? agentColor(senderName) : null;

  const sizeClass = compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm';

  const bubbleClass = isAssistant
    ? `self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm ${compact ? 'max-w-[95%]' : 'max-w-[90%]'}`
    : `self-end bg-userbg rounded-2xl rounded-br-sm ${compact ? 'max-w-[95%]' : 'max-w-[80%]'}`;

  const errorClass = isError ? 'border-err/30' : '';

  const blocks = parseBlocks(content);

  return html`
    <div class="${sizeClass} leading-relaxed ${bubbleClass} ${errorClass} overflow-hidden break-words"
      ${showAgentBadge ? { style: `border-left: 3px solid ${nameColor}` } : {}}>
      ${showAgentBadge && html`
        <div class="text-[11px] font-semibold mb-1" style="color: ${nameColor}">${senderName}</div>
      `}
      ${blocks
        ? html`<div class="block-container">
            ${blocks.map((block, i) => html`<${BlockRenderer} key=${i} block=${block} />`)}
          </div>`
        : html`<div class="prose" dangerouslySetInnerHTML=${{ __html: md(content) }} />`}
      <div class="text-[11px] text-txt-muted mt-1.5">
        ${senderName && !showAgentBadge ? `${senderName} \u00B7 ${time}` : time}
      </div>
      ${isAssistant && usage && html`
        <${UsageFooter}
          usage=${usage}
          toolHistory=${toolHistory}
          expanded=${expanded}
          onToggle=${() => setExpanded(!expanded)}
        />
      `}
    </div>
  `;
}
