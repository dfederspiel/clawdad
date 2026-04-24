import { html } from 'htm/preact';
import { agentPanel, portalThreads, selectedGroup, selectedJid } from '../app.js';
import { setDrawerStateFor } from '../portal-persistence.js';

export function openPortalInDrawer(threadId) {
  const group = selectedGroup.value;
  if (!group) return;
  const portal = portalThreads.value[threadId];
  const next = portal?.live
    ? {
        mode: 'portals',
        groupFolder: group.folder,
        focusedThreadId: threadId,
      }
    : {
        mode: 'portal-single',
        groupFolder: group.folder,
        threadId,
      };
  agentPanel.value = next;
  setDrawerStateFor(selectedJid.value, next);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

// Pull a scannable one-liner from the final assistant reply.
function previewLine(text) {
  if (!text) return '';
  // First non-empty line, stripped of markdown headers/bullets.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  return line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').slice(0, 120);
}

export function PortalPill({ threadId }) {
  const portal = portalThreads.value[threadId];
  if (!portal) return null;

  const count = portal.messages.length || portal.replyCount || 0;
  const isRunning = !!portal.running;

  // Preview: prefer the live last-message if we have one, else server summary
  const lastLive = portal.messages?.[portal.messages.length - 1]?.content;
  const preview = previewLine(lastLive || portal.lastMessagePreview || '');

  // Duration: live portals compute against "now"; done portals use durationMs from server
  let duration = '';
  if (isRunning && portal.openedAt) {
    duration = formatDuration(Date.now() - portal.openedAt);
  } else if (portal.durationMs) {
    duration = formatDuration(portal.durationMs);
  }

  const icon = isRunning ? '\u2197' : '\u2713';
  const iconColor = isRunning ? 'text-accent' : 'text-green-400';

  return html`
    <button
      class="self-start flex flex-col gap-1 px-3 py-2 rounded-xl bg-bg-3 border border-border text-left hover:border-accent transition-colors cursor-pointer max-w-[85%] w-fit group"
      onClick=${() => openPortalInDrawer(threadId)}
      title=${isRunning ? 'Open live portal' : 'Reopen portal'}
    >
      <div class="flex items-center gap-2 text-[11px]">
        <span class="${iconColor} text-sm leading-none">${icon}</span>
        <span class="font-semibold text-txt">${portal.agentName || 'Agent'}</span>
        ${portal.title && html`
          <span class="text-txt-2 font-normal truncate">\u2014 ${portal.title}</span>
        `}
        <span class="text-txt-muted shrink-0">
          ${isRunning ? 'running' : `${count} msg${count !== 1 ? 's' : ''}`}
          ${duration ? ` \u00B7 ${duration}` : ''}
        </span>
      </div>
      ${preview && html`
        <div class="text-[11px] text-txt-2 line-clamp-2 break-words font-normal leading-snug">
          ${preview}
        </div>
      `}
    </button>
  `;
}
