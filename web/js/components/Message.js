import { html } from 'htm/preact';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function UsageFooter({ usage }) {
  if (!usage || (!usage.numTurns && !usage.durationMs)) return null;

  const parts = [];
  if (usage.durationMs) parts.push(formatDuration(usage.durationMs));
  if (usage.numTurns) parts.push(`${usage.numTurns} turn${usage.numTurns !== 1 ? 's' : ''}`);
  const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (totalTokens) parts.push(`${formatTokens(totalTokens)} tokens`);
  if (usage.costUsd) parts.push(formatCost(usage.costUsd));

  return html`
    <div class="flex items-center gap-1.5 mt-1 text-[10px] text-txt-muted font-mono">
      ${parts.map((p, i) => html`
        ${i > 0 && html`<span class="opacity-40">·</span>`}
        <span>${p}</span>
      `)}
    </div>
  `;
}

export function Message({ role, content, timestamp, senderName, isError, compact, usage }) {
  const isAssistant = role === 'assistant';
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  const sizeClass = compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm';

  const bubbleClass = isAssistant
    ? `self-start bg-asstbg border border-border rounded-2xl rounded-bl-sm ${compact ? 'max-w-[95%]' : 'max-w-[90%]'}`
    : `self-end bg-userbg rounded-2xl rounded-br-sm ${compact ? 'max-w-[95%]' : 'max-w-[80%]'}`;

  const errorClass = isError ? 'border-err/30' : '';

  const blocks = isAssistant ? parseBlocks(content) : null;

  return html`
    <div class="${sizeClass} leading-relaxed ${bubbleClass} ${errorClass}">
      ${blocks
        ? html`<div class="block-container">
            ${blocks.map((block, i) => html`<${BlockRenderer} key=${i} block=${block} />`)}
          </div>`
        : html`<div>${esc(content)}</div>`}
      <div class="text-[11px] text-txt-muted mt-1.5">
        ${senderName ? `${senderName} \u00B7 ${time}` : time}
      </div>
      ${isAssistant && usage && html`<${UsageFooter} usage=${usage} />`}
    </div>
  `;
}
